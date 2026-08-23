/**
 * Fettler graph-projection runner (spec §11.21 / §18.6.1 — the representation
 * variable). This is the graph counterpart of `fettler-runner.ts`: instead of
 * `analyzeImpact` over raw retrieval, it routes the SAME scenario through
 * `analyzeImpactWithSoftwareGraph` (@mendpoint/code-impact), which builds an
 * immutable software-graph version from the repository index and answers the
 * Fettler endpoint-impact question by graph traversal.
 *
 * HONESTY. The graph only resolves a caller chain where the endpoint/SDK mapping
 * is present; on a scenario with no such coverage the traversal returns an absent
 * target, and this runner reports the arm NOT MEASURED with a reason rather than
 * fabricating an empty (all-miss) result. Where the graph DOES resolve, findings
 * are graded by the same `gradeFettler` grader as the raw arm, so `det` vs `B0`
 * is an apples-to-apples deterministic comparison of raw retrieval vs graph
 * projection. The model is OFF, so model/tokens/cost are genuinely null.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeChange } from "@mendpoint/change-intel";
import { analyzeImpactWithSoftwareGraph } from "@mendpoint/code-impact";
import { openGraphLearnMemory, type FettlerEndpointImpactResult } from "@mendpoint/graph-learn";
import type { ScenarioConfig } from "../scenarios/index.js";
import type { GroundTruth } from "../ground-truth/schema.js";
import { gradeFettler } from "../graders/fettler-graders.js";
import { withStagedRepo } from "./stage.js";
import type { RunRecord } from "./types.js";

const toPosix = (p: string): string => p.replace(/\\/g, "/");

/**
 * Pure: the repo-relative posix files the graph traversal implicates. A
 * repository-scoped graph entity's `canonicalKey` is `${filePath}::kind::name`
 * (e.g. `src/checkout.ts::function::createCharge`), so the file is the segment
 * before the first `::`. Provider-scoped entities (endpoints, SDK methods) carry
 * no repository file and are excluded. Deduplicated and sorted for a stable,
 * grader-comparable finding set.
 */
export function flaggedFilesFromGraphImpact(graphImpact: FettlerEndpointImpactResult): string[] {
  const files = new Set<string>();
  for (const entity of graphImpact.entities) {
    if (entity.scope !== "repository") continue;
    const separator = entity.canonicalKey.indexOf("::");
    if (separator <= 0) continue;
    files.add(toPosix(entity.canonicalKey.slice(0, separator)));
  }
  return [...files].sort();
}

/**
 * Pure: whether the graph produced a gradeable result. Measured only when the
 * changed endpoint resolved to an entity (exact/alias) AND coverage is not
 * `target_absent`; otherwise the graph had no coverage for this scenario and the
 * arm is honestly not-measured (never a fabricated zero graded against truth).
 */
export function graphImpactMeasured(graphImpact: FettlerEndpointImpactResult): { measured: boolean; reason: string } {
  if (graphImpact.coverage.basis === "target_absent") {
    return { measured: false, reason: "Change Graph has no coverage for this scenario (endpoint target absent)" };
  }
  if (graphImpact.target.status === "unresolved") {
    return { measured: false, reason: "Change Graph could not resolve the changed endpoint in this repository" };
  }
  return { measured: true, reason: "" };
}

export interface GraphProjectionRun {
  record: RunRecord;
  measured: boolean;
  reason: string;
}

export async function runFettlerWithGraphProjection(
  cfg: ScenarioConfig,
  gt: GroundTruth,
  ctx: { gitCommit: string; productVersion: string },
): Promise<GraphProjectionRun> {
  return withStagedRepo(cfg.repoPath, (staged) =>
    runOnPreparedRepository({ ...cfg, repoPath: staged.stagedPath }, gt, ctx),
  );
}

async function runOnPreparedRepository(
  cfg: ScenarioConfig,
  gt: GroundTruth,
  ctx: { gitCommit: string; productVersion: string },
): Promise<GraphProjectionRun> {
  const started = Date.now();
  const base: Omit<RunRecord, "latency_ms" | "findings"> = {
    run_id: randomUUID(),
    timestamp: new Date().toISOString(),
    git_commit: ctx.gitCommit,
    product: "fettler",
    product_version: ctx.productVersion,
    scenario_id: cfg.scenario_id,
    scenario_version: "1",
    invocation_path:
      "change-intel.normalizeChange -> code-impact.analyzeImpactWithSoftwareGraph (graph projection, useLlm:false, minConfidence:medium)",
    model: null,
    model_provider: null,
    routing_decisions: [],
    tokens: null,
    estimated_cost_usd: null,
    activity: { filesExamined: 0 },
    findingGraphPaths: [],
    confidence: null,
    produced_edit: false,
    grader_results: [],
    failures: [],
    passed: false,
    unmeasured_dimensions: [
      "migration_patch_correctness (generation path not exercised)",
      "verification_honesty (sandbox/verification path not exercised)",
      "pr_delivery (GitHub delivery not exercised)",
      "token_cost / model_routing (LLM off; no model called)",
    ],
  };

  const notMeasured = (reason: string, extra?: Partial<RunRecord>): GraphProjectionRun => ({
    record: { ...base, latency_ms: Date.now() - started, findings: [], ...extra },
    measured: false,
    reason,
  });

  const graphDb = openGraphLearnMemory();
  try {
    const oldSpec = JSON.parse(readFileSync(join(cfg.repoPath, cfg.oldSpec ?? "spec/openapi-v1.json"), "utf8"));
    const newSpec = JSON.parse(readFileSync(join(cfg.repoPath, cfg.newSpec ?? "spec/openapi-v2.json"), "utf8"));
    const { surfaces } = normalizeChange(oldSpec, newSpec, { providerSlug: cfg.slug });

    let graphImpact: FettlerEndpointImpactResult;
    try {
      const out = await analyzeImpactWithSoftwareGraph(cfg.repoPath, surfaces, {
        graphDb,
        tenantId: "eval-tenant",
        repositoryId: cfg.scenario_id,
        providerId: cfg.slug ?? "provider",
        providerSnapshotId: `${cfg.slug ?? "provider"}-snapshot`,
        providerRevision: "v2",
        providerSdkPackage: cfg.slug ?? "provider",
        providerSdkVersion: "0.0.0",
        observedAt: new Date().toISOString(),
        maxCallerHops: 4,
        maxContextBytes: 20_000,
        impact: { minConfidence: "medium" },
      });
      graphImpact = out.graphImpact;
    } catch (error) {
      // The graph projection could not be built for this scenario (e.g. no
      // endpoint surface). Honest not-measured, never a broken script.
      return notMeasured(
        `Change Graph projection unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const coverage = graphImpactMeasured(graphImpact);
    const notes = [`graph_impact=${graphImpact.impact}`, `coverage=${graphImpact.coverage.basis}`];
    if (!coverage.measured) {
      return notMeasured(coverage.reason, { activity: { filesExamined: 0, notes } });
    }
    const findings = flaggedFilesFromGraphImpact(graphImpact);
    const grade = gradeFettler(findings, gt);
    return {
      record: {
        ...base,
        latency_ms: Date.now() - started,
        findings,
        activity: { filesExamined: 0, confirmedCount: findings.length, notes },
        grader_results: grade.grader_results,
        failures: grade.failures,
        passed: grade.passed,
      },
      measured: true,
      reason: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return notMeasured(`scenario error: ${message}`, { error: message });
  } finally {
    graphDb.raw.close();
  }
}
