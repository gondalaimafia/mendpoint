/**
 * Real-repository harness — the run.
 *
 * Runs a cloned real repository through Fettler's production analysis core, the
 * same path `evals/runners/fettler-runner.ts` and `scripts/impact-grade.ts`
 * exercise: `normalizeChange` (@mendpoint/change-intel) turns the injected
 * OpenAPI diff into impactable surfaces, then `analyzeImpact`
 * (@mendpoint/code-impact) discovers, expands, and confirms impacted sites. LLM
 * is OFF (useLlm:false), so this is fully deterministic and no model is called.
 *
 * Three things this harness is careful about, because they are exactly where
 * this project has fooled itself before:
 *
 *  - It reuses `withStagedRepo` so the product reads an answer-key-safe copy and
 *    the 811-directory staging leak cannot recur.
 *  - It asserts answer-key isolation (the shared `assertCorpusRunIsolation`, plus
 *    a direct check that the sealed key is outside the staged tree) BEFORE the
 *    product runs.
 *  - It reports a distinct `did_not_run` outcome when analysis throws or indexes
 *    nothing, so "found nothing" (a real clean miss) is never confused with "did
 *    not look" (a collapse). This is this repository's dominant defect shape.
 */
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { analyzeImpact, sdkContextFromSurfaces } from "@mendpoint/code-impact";
import { buildIndexIncremental } from "@mendpoint/codebase-index";
import type { ImpactReport } from "@mendpoint/shared";
import type { ImpactableSurface } from "@mendpoint/shared";
import { withStagedRepo } from "../runners/stage.js";
import { assertCorpusRunIsolation } from "../runners/isolation.js";
import {
  countFettlerFindings,
  gradeFettler,
  type FettlerGrade,
} from "../graders/fettler-graders.js";
import type { GraderResult, RunFailure } from "../runners/types.js";
import {
  assertAnswerKeyUnreachable,
  assertInjectionMatchesKey,
  loadSealedAnswerKey,
  type SealedAnswerKey,
} from "./inject.js";
import { clonePathFor, REPO_ROOT, type RealRepoManifest } from "./manifest.js";

const toPosix = (p: string): string => p.replace(/\\/g, "/");

/**
 * The single most important discriminator this harness reports.
 *  - `analyzed`         the product examined the whole codebase and produced a
 *                       complete answer (empty findings here mean a real miss).
 *  - `analyzed_partial` the product ran but coverage was incomplete, so an empty
 *                       or thin result carries less information.
 *  - `did_not_run`      the product threw, refused, or indexed nothing. This is
 *                       NEVER a clean miss and must never be scored as one.
 */
export type RunOutcome = "analyzed" | "analyzed_partial" | "did_not_run";

export interface RealRepoRunResult {
  scenarioId: string;
  runId: string;
  timestamp: string;
  repoUrl: string;
  commit: string;
  license: string;
  gitCommit: string;
  productVersion: string;
  invocationPath: string;
  /** The run-vs-not-run discriminator. */
  outcome: RunOutcome;
  /** Human explanation of the outcome (esp. for partial / did_not_run). */
  outcomeReason?: string;
  latencyMs: number;
  filesScanned: number;
  candidateCount: number;
  confirmedCount: number;
  coverageBasis: string;
  overallConfidence: string | null;
  /** Confident (medium+) files the product flagged, repo-relative posix. */
  flagged: string[];
  /** Low-confidence notifications, repo-relative posix. */
  lowConfidence: string[];
  /** True positives: expected files the product flagged. */
  truePositives: string[];
  /** False negatives: expected files the product missed. */
  falseNegatives: string[];
  /** False positives split: distractor traps (P0) and other extras. */
  trapHits: string[];
  extras: string[];
  /** All false positives (trapHits + extras), for the headline. */
  falsePositives: string[];
  precision: number;
  recall: number;
  graderResults: GraderResult[];
  failures: RunFailure[];
  /** Safe + correct per the Fettler grader (traps/misses/extras all clear). */
  passed: boolean;
  /** Dimensions this deterministic path does not measure. */
  unmeasuredDimensions: string[];
  error?: string;
}

const UNMEASURED = [
  "migration_patch_correctness (generation path not exercised)",
  "verification_honesty (sandbox/verification path not exercised)",
  "pr_delivery (GitHub delivery not exercised)",
  "token_cost / model_routing (LLM off; no model called)",
];

function coverageOutcome(basis: string): { outcome: RunOutcome; reason?: string } {
  if (basis === "analyzed") return { outcome: "analyzed" };
  if (basis === "partial") {
    return {
      outcome: "analyzed_partial",
      reason:
        "coverage basis is partial: some in-scope source could not be fully analysed, so absence of a finding carries less information",
    };
  }
  // "not_analyzed" — nothing was indexed; this is a did-not-run, not a clean miss.
  return {
    outcome: "did_not_run",
    reason:
      "coverage basis is not_analyzed: no analyzable source files were indexed (repository empty, unsupported, or pruned to nothing)",
  };
}

/**
 * Run the product against an already-prepared (staged, answer-key-safe)
 * repository path and grade the confident findings against the sealed key. This
 * is the pure, offline-testable core: it clones nothing and asserts nothing
 * about isolation (the public entrypoint owns that).
 */
export async function runRealRepoOnPreparedRepository(
  repoPath: string,
  manifest: RealRepoManifest,
  key: SealedAnswerKey,
  surfaces: ImpactableSurface[],
  ctx: { gitCommit: string; productVersion: string },
): Promise<RealRepoRunResult> {
  const runId = randomUUID();
  const timestamp = new Date().toISOString();
  const invocationPath =
    "change-intel.normalizeChange -> code-impact.analyzeImpact (useLlm:false, minConfidence:medium)";
  const started = Date.now();

  const base = {
    scenarioId: manifest.scenarioId,
    runId,
    timestamp,
    repoUrl: manifest.repoUrl,
    commit: manifest.commit,
    license: manifest.license,
    gitCommit: ctx.gitCommit,
    productVersion: ctx.productVersion,
    invocationPath,
    unmeasuredDimensions: UNMEASURED,
  };

  try {
    const index = buildIndexIncremental(repoPath, null, {
      sdkContext: sdkContextFromSurfaces(surfaces),
    });
    const filesScanned = index.files.length + (index.structuredFiles?.length ?? 0);
    const report: ImpactReport = await analyzeImpact(repoPath, surfaces, {
      useLlm: false,
      minConfidence: "medium",
      index,
    });

    const flagged = [...new Set(report.sites.map((s) => toPosix(s.filePath)))].sort();
    const lowConfidence = [
      ...new Set(report.lowConfidenceNotifications.map((s) => toPosix(s.filePath))),
    ].sort();

    const grade: FettlerGrade = gradeFettler(flagged, key);
    const counts = countFettlerFindings(flagged, key);
    // `coverage` is typed optional on ImpactReport; a report without it never
    // examined a codebase, so treat its absence as not_analyzed (a did-not-run),
    // never as a clean empty result.
    const coverageBasis = report.coverage?.basis ?? "not_analyzed";
    const { outcome, reason } = coverageOutcome(coverageBasis);

    return {
      ...base,
      outcome,
      ...(reason ? { outcomeReason: reason } : {}),
      latencyMs: Date.now() - started,
      filesScanned,
      candidateCount: report.candidateCount,
      confirmedCount: report.confirmedCount,
      coverageBasis,
      overallConfidence: report.overallConfidence,
      flagged,
      lowConfidence,
      truePositives: counts.expectedHits.slice().sort(),
      falseNegatives: counts.missed.slice().sort(),
      trapHits: counts.trapHits.slice().sort(),
      extras: counts.extras.slice().sort(),
      falsePositives: [...counts.trapHits, ...counts.extras].sort(),
      precision: grade.precision,
      recall: grade.recall,
      graderResults: grade.grader_results,
      failures: grade.failures,
      passed: grade.passed,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      outcome: "did_not_run",
      outcomeReason: `analysis threw before producing a report: ${message}`,
      latencyMs: Date.now() - started,
      filesScanned: 0,
      candidateCount: 0,
      confirmedCount: 0,
      coverageBasis: "not_analyzed",
      overallConfidence: null,
      flagged: [],
      lowConfidence: [],
      truePositives: [],
      falseNegatives: key.expected_findings.slice().sort(),
      trapHits: [],
      extras: [],
      falsePositives: [],
      precision: 0,
      recall: 0,
      graderResults: [
        { dimension: "scan_completes", passed: false, score: 0, detail: `threw: ${message}` },
      ],
      failures: [
        {
          category: "ROBUSTNESS_FAILURE",
          severity: "P1",
          dimension: "scan_completes",
          observed: `analysis threw: ${message}`,
          expected: "complete the scan without crashing",
        },
      ],
      passed: false,
      error: message,
    };
  }
}

/**
 * Full public entrypoint: assert answer-key isolation, verify the injection
 * matches the sealed key, stage the clone, run the product, and grade. Requires
 * the repository to already be cloned at {@link clonePathFor} (see
 * `harness clone` / `run.ts`, which perform the pinned clone).
 */
export async function runRealRepoFettler(
  manifest: RealRepoManifest,
  ctx: { gitCommit: string; productVersion: string },
): Promise<RealRepoRunResult> {
  const clonePath = clonePathFor(manifest);
  if (!existsSync(clonePath)) {
    throw new Error(
      `real-repo clone not present at ${clonePath}. Clone it first at the pinned commit ` +
        `(${manifest.commit}); see evals/real-repo/run.ts.`,
    );
  }

  // Answer-key isolation invariant (spec §18.3): the repository the product
  // stages MUST resolve outside the tree that holds the sealed key, and the key
  // itself must be outside the repository. Fail loudly here rather than let a
  // staged product read its own answer key.
  assertCorpusRunIsolation({
    corpusRoot: clonePath,
    configured: true,
    corpusRepoPaths: [clonePath],
    repoRoot: REPO_ROOT,
  });
  assertAnswerKeyUnreachable(manifest, clonePath);

  const key = loadSealedAnswerKey(manifest);
  const surfaces = assertInjectionMatchesKey(manifest, key);

  return withStagedRepo(clonePath, (staged) => {
    // The staged copy must also not contain the sealed key (defence in depth on
    // top of stageRepo's own answer-key stripping).
    assertAnswerKeyUnreachable(manifest, staged.stagedPath);
    return runRealRepoOnPreparedRepository(
      staged.stagedPath,
      manifest,
      key,
      surfaces,
      ctx,
    );
  });
}
