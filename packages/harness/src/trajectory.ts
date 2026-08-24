/**
 * Eval harness: every run writes runs/<id>/{plan.json, trace.jsonl, score.json}
 */
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentPlan } from "@mendpoint/orchestrator";

export type TraceEvent = {
  ts: string;
  type: "plan" | "step_start" | "step_end" | "tool" | "error" | "info" | "resume";
  message: string;
  data?: unknown;
};

export type RunScore = {
  runId: string;
  ok: boolean;
  stepsTotal: number;
  stepsDone: number;
  stepsFailed: number;
  recoveredFromFailure: boolean;
  durationMs: number;
  /** Cost accounting */
  tokensEst?: number;
  sandboxMinutes?: number;
  graphQueries?: number;
  costUsd?: number;
  planId?: string;
  tenantId?: string;
  /**
   * Set ONLY by seedDogfoodScores. A real harness run never writes this. It is
   * the structural marker that lets a program (not a human eyeballing run ids)
   * refuse to count a fabricated score toward a real dogfood figure.
   */
  synthetic?: boolean;
};

export type RunPaths = {
  root: string;
  planPath: string;
  tracePath: string;
  scorePath: string;
};

export type HarnessTenantScope = Readonly<{ tenantId: string }>;

function tenantNamespace(tenantId: string): string {
  if (tenantId.trim() === "") throw new Error("Tenant scope required");
  const lengthPrefixed = `${Buffer.byteLength(tenantId, "utf8")}:${tenantId}`;
  return createHash("sha256").update(lengthPrefixed, "utf8").digest("hex");
}

/**
 * Resolve the run collection root. Omitting scope is the explicit legacy CLI
 * layout; a supplied scope is isolated under an opaque tenant namespace so an
 * arbitrary tenant id can never become a path segment.
 */
export function runsDir(baseDir: string, scope?: HarnessTenantScope): string {
  if (!scope) return resolve(baseDir, "runs");
  return resolve(baseDir, "tenant-runs", tenantNamespace(scope.tenantId), "runs");
}

function validRunId(runId: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId) &&
    runId !== "." &&
    runId !== ".."
  );
}

export function runDir(
  baseDir: string,
  runId: string,
  scope?: HarnessTenantScope,
): RunPaths {
  if (!validRunId(runId)) throw new Error("Invalid run id");
  const runsRoot = runsDir(baseDir, scope);
  const root = resolve(runsRoot, runId);
  const rel = relative(runsRoot, root);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Run path is outside the runs directory");
  }
  return {
    root,
    planPath: join(root, "plan.json"),
    tracePath: join(root, "trace.jsonl"),
    scorePath: join(root, "score.json"),
  };
}

export function initRun(
  baseDir: string,
  runId: string,
  plan: AgentPlan,
  scope?: HarnessTenantScope,
): RunPaths {
  const paths = runDir(baseDir, runId, scope);
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.planPath, JSON.stringify(plan, null, 2), "utf8");
  writeFileSync(paths.tracePath, "", "utf8");
  appendTrace(paths, {
    ts: new Date().toISOString(),
    type: "plan",
    message: "plan persisted",
    data: { planId: plan.id, steps: plan.steps.length },
  });
  return paths;
}

export function appendTrace(paths: RunPaths, event: TraceEvent): void {
  appendFileSync(paths.tracePath, JSON.stringify(event) + "\n", "utf8");
}

export function writeScore(paths: RunPaths, score: RunScore): void {
  writeFileSync(paths.scorePath, JSON.stringify(score, null, 2), "utf8");
}

export function loadPlan(paths: RunPaths): AgentPlan {
  return JSON.parse(readFileSync(paths.planPath, "utf8")) as AgentPlan;
}

export function savePlan(paths: RunPaths, plan: AgentPlan): void {
  writeFileSync(paths.planPath, JSON.stringify(plan, null, 2), "utf8");
}

export function runExists(
  baseDir: string,
  runId: string,
  scope?: HarnessTenantScope,
): boolean {
  return existsSync(runDir(baseDir, runId, scope).planPath);
}
