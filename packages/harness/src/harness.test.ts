import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addStep, emptyPlan } from "@mendpoint/orchestrator";
import { executePlan, helloWorldRun, loadPlan, runDir } from "./index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("harness", () => {
  it("hello world persists plan trace score", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-"));
    dirs.push(base);
    const r = await helloWorldRun(base);
    expect(r.ok).toBe(true);
    const plan = JSON.parse(readFileSync(r.paths.planPath, "utf8"));
    expect(plan.steps.length).toBe(2);
    const trace = readFileSync(r.paths.tracePath, "utf8");
    expect(trace).toContain("step_start");
    const score = JSON.parse(readFileSync(r.paths.scorePath, "utf8"));
    expect(score.runId).toBe(r.runId);
  });

  it("recovers from injected failure and can resume", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-rec-"));
    dirs.push(base);
    let plan = emptyPlan({
      kind: "generic",
      title: "recovery",
      goal: "fail then skip",
      agent: "shared",
    });
    plan = addStep(plan, {
      title: "Will fail",
      action: "harness.echo",
      successCriteria: ["x"],
      notes: "boom",
    });
    plan = addStep(plan, {
      title: "Still runs",
      action: "harness.echo",
      successCriteria: ["y"],
      notes: "after",
    });
    const r1 = await executePlan({
      baseDir: base,
      plan,
      injectFailureAction: "harness.echo",
    });
    expect(r1.score.recoveredFromFailure).toBe(true);

    // resume: all steps should already be terminal
    const r2 = await executePlan({
      baseDir: base,
      plan: loadPlan(runDir(base, r1.runId)),
      resumeRunId: r1.runId,
    });
    expect(r2.runId).toBe(r1.runId);
  });
});
