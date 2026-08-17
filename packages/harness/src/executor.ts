/**
 * Planner/executor harness — JSON plan storage, structured errors, resume.
 */
import { join } from "node:path";
import {
  nextPendingStep,
  planProgress,
  updateStep,
  type AgentPlan,
  type PlanStep,
} from "@mendpoint/orchestrator";
import { createSandbox, type SandboxHandle } from "@mendpoint/platform";
import type { GraphTenantScope } from "@mendpoint/graph-learn";
import { newId } from "@mendpoint/shared";
import {
  appendTrace,
  initRun,
  loadPlan,
  runDir,
  runExists,
  savePlan,
  writeScore,
  type RunPaths,
  type RunScore,
} from "./trajectory.js";
import { appendDogfoodLedger } from "./dogfood.js";
import {
  estimateCost,
  estimateTokensFromRun,
} from "@mendpoint/platform";

export type ExecuteOptions = {
  /** Base directory for runs/ (default cwd) */
  baseDir?: string;
  runId?: string;
  /** Resume existing run id */
  resumeRunId?: string;
  plan: AgentPlan;
  /** Inject a failure on first matching action for recovery tests */
  injectFailureAction?: string;
  maxSteps?: number;
  /** Pre-created isolated backend for shell-capable plans. */
  sandbox?: SandboxHandle;
  /**
   * Tenant scope for graph-backed tools. Graph tools fail closed (return no
   * data) when this is absent, so a plan can never read the global graph.
   */
  scope?: GraphTenantScope;
};

export type ExecuteResult = {
  runId: string;
  plan: AgentPlan;
  paths: RunPaths;
  score: RunScore;
  ok: boolean;
};

import { runSpecialistTool, type ToolResult } from "./tools.js";

function runTool(
  step: PlanStep,
  sbx: SandboxHandle,
  injectFail?: string,
  scope?: GraphTenantScope,
): ToolResult {
  if (injectFail && step.action === injectFail) {
    return {
      ok: false,
      output: "",
      error: `structured_tool_error: injected failure on action=${step.action}`,
    };
  }
  const result = runSpecialistTool(step, sbx, scope);
  if (!result.ok) return result;
  if (!step.successCriteria.length) {
    return {
      ok: false,
      output: result.output,
      error: "success criteria missing",
    };
  }
  const evidence = result.output.trim();
  for (const criterion of step.successCriteria) {
    const contains = criterion.match(/^(?:stdout|output|evidence)\s+contains\s+(.+)$/i);
    const ok = /^output\s+is\s+non-empty$/i.test(criterion)
      ? evidence.length > 0
      : contains
        ? evidence.toLowerCase().includes(contains[1]!.trim().toLowerCase())
        : evidence.toLowerCase().includes(criterion.trim().toLowerCase());
    if (!ok) {
      return {
        ok: false,
        output: result.output,
        error: `success criterion not met: ${criterion}`,
      };
    }
  }
  return result;
}

/**
 * Execute plan steps until complete or failure exhausted.
 * On structured failure: mark step failed, optionally continue with workaround branch.
 */
export async function executePlan(opts: ExecuteOptions): Promise<ExecuteResult> {
  const baseDir = opts.baseDir ?? process.cwd();
  const started = Date.now();
  let plan = opts.plan;
  let runId = opts.runId ?? newId();
  let paths: RunPaths;
  let inject = opts.injectFailureAction;

  if (opts.resumeRunId && runExists(baseDir, opts.resumeRunId)) {
    runId = opts.resumeRunId;
    paths = runDir(baseDir, runId);
    plan = loadPlan(paths);
    appendTrace(paths, {
      ts: new Date().toISOString(),
      type: "resume",
      message: `resumed run ${runId}`,
    });
  } else {
    paths = initRun(baseDir, runId, plan);
  }

  const ownsSandbox = !opts.sandbox;
  const sbx =
    opts.sandbox ??
    createSandbox({
      prefix: "harness-",
      cacheKey: `harness-${runId}`,
      files: { "README.sbx": "mendpoint harness sandbox\n" },
    });

  let stepsRun = 0;
  const maxSteps = opts.maxSteps ?? 50;

  try {
    while (stepsRun < maxSteps) {
      const step = nextPendingStep(plan);
      if (!step) break;

      plan = updateStep(plan, step.id, { status: "running" });
      savePlan(paths, plan);
      appendTrace(paths, {
        ts: new Date().toISOString(),
        type: "step_start",
        message: step.title,
        data: { action: step.action, id: step.id },
      });

      const result = runTool(step, sbx, inject, opts.scope);
      // only inject once
      if (inject && step.action === inject) inject = undefined;

      if (!result.ok) {
        plan = updateStep(plan, step.id, {
          status: "failed",
          evidence: result.error,
          notes: `failed: ${result.error}`,
        });
        savePlan(paths, plan);
        appendTrace(paths, {
          ts: new Date().toISOString(),
          type: "error",
          message: result.error ?? "step failed",
          data: {
            stepId: step.id,
            outcome: "failed",
            continuation: "remaining_steps",
          },
        });
        stepsRun++;
        continue;
      }

      plan = updateStep(plan, step.id, {
        status: "done",
        evidence: result.output.slice(0, 500),
      });
      savePlan(paths, plan);
      appendTrace(paths, {
        ts: new Date().toISOString(),
        type: "step_end",
        message: "ok",
        data: { stepId: step.id, output: result.output.slice(0, 200) },
      });
      stepsRun++;
    }
  } finally {
    if (ownsSandbox) sbx.dispose();
  }

  const prog = planProgress(plan);
  const durationMs = Date.now() - started;
  const tokensEst = estimateTokensFromRun({
    steps: prog.total,
    traceBytes: 0,
    promptChars: (plan.goal?.length ?? 0) + (plan.title?.length ?? 0),
  });
  const sandboxMinutes = durationMs / 60_000;
  const graphQueries = 0;
  const cost = estimateCost({ tokensEst, sandboxMinutes, graphQueries, durationMs });
  const score: RunScore = {
    runId,
    ok: prog.failed === 0 && prog.pending === 0,
    stepsTotal: prog.total,
    stepsDone: prog.done,
    stepsFailed: plan.steps.filter((s) => s.status === "failed").length,
    recoveredFromFailure: false,
    durationMs,
    graphQueries,
    tokensEst,
    sandboxMinutes,
    costUsd: cost.totalUsd,
    planId: plan.id,
  };
  writeScore(paths, score);
  try {
    appendDogfoodLedger(baseDir, {
      runId,
      ok: score.ok,
      durationMs: score.durationMs,
      stepsTotal: score.stepsTotal,
      stepsFailed: score.stepsFailed,
      recoveredFromFailure: score.recoveredFromFailure,
      graphQueries: score.graphQueries,
      source: "harness",
    });
  } catch {
    /* ledger is best-effort */
  }
  appendTrace(paths, {
    ts: new Date().toISOString(),
    type: "info",
    message: "run complete",
    data: score,
  });

  return { runId, plan, paths, score, ok: score.ok };
}

/** Day-15 hello world: 2-step plan, echo, persist, resume-ready */
export async function helloWorldRun(baseDir = process.cwd()) {
  const { emptyPlan, addStep } = await import("@mendpoint/orchestrator");
  let plan = emptyPlan({
    kind: "generic",
    title: "Harness hello world",
    goal: "Prove planner/executor/persist/sandbox",
    agent: "shared",
  });
  plan = addStep(plan, {
    title: "Echo hello",
    action: "harness.echo",
    successCriteria: ["stdout contains hello"],
    notes: "hello from mendpoint harness",
  });
  plan = addStep(plan, {
    title: "Echo sandbox readiness",
    action: "harness.echo",
    successCriteria: ["stdout contains sandbox ready"],
    notes: "sandbox ready",
  });
  return executePlan({ baseDir, plan });
}
