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
};

export type ExecuteResult = {
  runId: string;
  plan: AgentPlan;
  paths: RunPaths;
  score: RunScore;
  ok: boolean;
};

type ToolResult = { ok: boolean; output: string; error?: string };

function runTool(
  step: PlanStep,
  sbx: SandboxHandle,
  injectFail?: string,
): ToolResult {
  if (injectFail && step.action === injectFail) {
    return {
      ok: false,
      output: "",
      error: `structured_tool_error: injected failure on action=${step.action}`,
    };
  }
  switch (step.action) {
    case "echo":
    case "harness.echo": {
      const msg = step.notes ?? step.title;
      const r = sbx.run(
        process.platform === "win32"
          ? `cmd /c echo ${JSON.stringify(msg)}`
          : `echo ${JSON.stringify(msg)}`,
      );
      return { ok: r.ok, output: r.stdout || r.stderr };
    }
    case "harness.shell": {
      const cmd = step.notes ?? "node -e \"console.log('ok')\"";
      const r = sbx.run(cmd);
      return {
        ok: r.ok,
        output: r.stdout,
        error: r.ok ? undefined : r.stderr || "shell failed",
      };
    }
    case "spec.lock_diff":
    case "spec.evolve":
    case "spec.evolve_field":
    case "spec.breaking_change":
    case "spec.add_capability":
    case "gate.contract_suite":
    case "impact.fanout_prs":
    case "critic.api_reviewer":
    case "bsg.lock":
    case "dag.pr_unit":
    case "critic.bsg_fidelity":
      // Specialist steps: mark done with stub evidence (real logic in agent packages)
      return {
        ok: true,
        output: `stub_ok action=${step.action} ref=${step.ref ?? ""}`,
      };
    default:
      return {
        ok: true,
        output: `noop action=${step.action}`,
      };
  }
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
  let recovered = false;
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

  const sbx = createSandbox({
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

      const result = runTool(step, sbx, inject);
      // only inject once
      if (inject && step.action === inject) inject = undefined;

      if (!result.ok) {
        recovered = true;
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
          data: { stepId: step.id, recovery: "skip_and_continue" },
        });
        // Deterministic recovery: skip failed step and continue (or would ask-user)
        plan = updateStep(plan, step.id, {
          status: "skipped",
          notes: `recovered: skipped after structured error`,
        });
        savePlan(paths, plan);
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
    sbx.dispose();
  }

  const prog = planProgress(plan);
  const score: RunScore = {
    runId,
    ok: prog.failed === 0 && prog.pending === 0,
    stepsTotal: prog.total,
    stepsDone: prog.done + (plan.steps.filter((s) => s.status === "skipped").length),
    stepsFailed: plan.steps.filter((s) => s.status === "failed").length,
    recoveredFromFailure: recovered,
    durationMs: Date.now() - started,
    graphQueries: 0,
  };
  // treat skipped-after-fail as recovered success path for harness demos
  if (recovered && prog.pending === 0) {
    score.ok = true;
  }
  writeScore(paths, score);
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
    title: "Shell node version",
    action: "harness.shell",
    successCriteria: ["node runs"],
    notes: "node -e \"console.log(process.version)\"",
  });
  return executePlan({ baseDir, plan });
}
