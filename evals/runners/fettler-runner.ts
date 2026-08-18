/**
 * Phase 4 — Fettler runner.
 *
 * Invokes Fettler through the same analysis core the production pipeline uses at
 * its impact stages: `normalizeChange` (@mendpoint/change-intel) to turn the
 * OpenAPI v1/v2 diff into impactable surfaces, then `analyzeImpact`
 * (@mendpoint/code-impact) to discover, expand, and confirm impacted sites.
 * This is exactly the path `scripts/impact-grade.ts` exercises — the real
 * candidate-discovery / call-graph / confirmation components, not a stub.
 *
 * What this path does NOT exercise (recorded honestly as unmeasured, never
 * bypassed to flatter the product): migration generation, the agentic repair
 * loop, sandboxed verification, and GitHub delivery — those require a seeded DB,
 * a sandbox, and GitHub credentials. The impact finding is the primary Fettler
 * value-proposition signal and is fully deterministic here (useLlm: false).
 *
 * LLM is OFF, so model/provider/tokens/cost are genuinely null (no model was
 * called). We never capture chain-of-thought.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeChange } from "@mendpoint/change-intel";
import {
  analyzeImpact,
  sdkContextFromSurfaces,
  type LlmConfirmObserver,
} from "@mendpoint/code-impact";
import { buildIndexIncremental } from "@mendpoint/codebase-index";
import type { ImpactReport } from "@mendpoint/shared";
import type { ScenarioConfig } from "../scenarios/index.js";
import type { GroundTruth } from "../ground-truth/schema.js";
import { gradeFettler } from "../graders/fettler-graders.js";
import { stageRepo } from "./stage.js";
import type { RunRecord } from "./types.js";

const toPosix = (p: string): string => p.replace(/\\/g, "/");

/**
 * Live-lane options. Presence switches the runner to the LIVE lane
 * (`useLlm:true`, exercising the impact-confirm model path) and routes each
 * successful model call to `onLlmCall` so the caller can attribute provenance.
 * Absent → the DETERMINISTIC lane (`useLlm:false`), unchanged from before. The
 * two lanes are identical apart from this switch — same staging, same index,
 * same surfaces, same grader.
 */
export interface FettlerLaneOptions {
  onLlmCall: LlmConfirmObserver;
}

export async function runFettler(
  cfg: ScenarioConfig,
  gt: GroundTruth,
  ctx: { gitCommit: string; productVersion: string },
  lane?: FettlerLaneOptions,
): Promise<RunRecord> {
  const live = lane !== undefined;
  let started = Date.now();
  const base: Omit<RunRecord, "latency_ms"> = {
    run_id: randomUUID(),
    timestamp: new Date().toISOString(),
    git_commit: ctx.gitCommit,
    product: "fettler",
    product_version: ctx.productVersion,
    scenario_id: cfg.scenario_id,
    scenario_version: "1",
    invocation_path: live
      ? "change-intel.normalizeChange -> code-impact.analyzeImpact (useLlm:true, LLM confirm live, minConfidence:medium)"
      : "change-intel.normalizeChange -> code-impact.analyzeImpact (useLlm:false, minConfidence:medium)",
    model: null,
    model_provider: null,
    routing_decisions: [],
    tokens: null,
    estimated_cost_usd: null,
    activity: { filesExamined: 0 },
    findings: [],
    confidence: null,
    produced_edit: false,
    grader_results: [],
    failures: [],
    passed: false,
    unmeasured_dimensions: live
      ? [
          "migration_patch_correctness (generation path not exercised)",
          "verification_honesty (sandbox/verification path not exercised)",
          "pr_delivery (GitHub delivery not exercised)",
        ]
      : [
          "migration_patch_correctness (generation path not exercised)",
          "verification_honesty (sandbox/verification path not exercised)",
          "pr_delivery (GitHub delivery not exercised)",
          "token_cost / model_routing (LLM off; no model called)",
        ],
  };

  // Stage the repo into scratch WITHOUT its grading key so the product can never
  // read its own answer key (matters the moment an LLM-enabled path is used).
  // Latency is measured around the product call only, not the copy.
  const stage = stageRepo(cfg.repoPath);
  started = Date.now();
  try {
    const oldSpecPath = join(stage.stagedPath, cfg.oldSpec ?? "spec/openapi-v1.json");
    const newSpecPath = join(stage.stagedPath, cfg.newSpec ?? "spec/openapi-v2.json");
    const oldSpec = JSON.parse(readFileSync(oldSpecPath, "utf8"));
    const newSpec = JSON.parse(readFileSync(newSpecPath, "utf8"));

    const { surfaces } = normalizeChange(oldSpec, newSpec, { providerSlug: cfg.slug });
    // Build the index explicitly so we can record how many files the scanner
    // actually examined (the real size independent variable — spec §21.3), then
    // hand that same index to analyzeImpact so nothing is scanned twice and the
    // production path is exercised unchanged. `index.files` is the set of source
    // files the walker indexed after pruning dependency/VCS trees.
    const index = buildIndexIncremental(stage.stagedPath, null, {
      sdkContext: sdkContextFromSurfaces(surfaces),
    });
    const filesScanned = index.files.length;
    const report: ImpactReport = await analyzeImpact(stage.stagedPath, surfaces, {
      useLlm: live,
      minConfidence: "medium",
      index,
      ...(live ? { onLlmCall: lane!.onLlmCall } : {}),
    });

    const flagged = [...new Set(report.sites.map((s) => toPosix(s.filePath)))].sort();
    const lowConfidence = [
      ...new Set(report.lowConfidenceNotifications.map((s) => toPosix(s.filePath))),
    ].sort();

    const grade = gradeFettler(flagged, gt);

    return {
      ...base,
      latency_ms: Date.now() - started,
      activity: {
        filesExamined: filesScanned,
        candidateCount: report.candidateCount,
        confirmedCount: report.confirmedCount,
        lowConfidenceCount: lowConfidence.length,
        notes: [
          `files_scanned=${filesScanned}`,
          `surfaces=${surfaces.length}`,
          `candidates=${report.candidateCount}`,
          `confident_sites=${flagged.length}`,
          lowConfidence.length ? `low_confidence=${lowConfidence.join(", ")}` : "low_confidence=none",
        ],
      },
      findings: flagged,
      confidence: report.overallConfidence,
      produced_edit: false,
      grader_results: grade.grader_results,
      failures: grade.failures,
      passed: grade.passed,
    };
  } catch (err) {
    // A crash is itself a graded outcome (robustness), not a broken script.
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      latency_ms: Date.now() - started,
      error: message,
      grader_results: [
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
    };
  }
}
