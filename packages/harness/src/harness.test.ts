import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addStep, emptyPlan } from "@mendpoint/orchestrator";
import {
  executePlan,
  helloWorldRun,
  loadPlan,
  runDir,
  collectDogfood,
  seedDogfoodScores,
  formatDogfoodReport,
  writeDogfoodReport,
  listTrajectories,
  viewTrajectory,
  DOGFOOD_TARGET_RUNS,
  savePlanHitl,
  listPlans,
  getPlan,
} from "./index.js";

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

  it("preserves an injected failure across execution and resume", async () => {
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
    expect(r1.score.recoveredFromFailure).toBe(false);
    expect(r1.ok).toBe(false);
    expect(r1.score.ok).toBe(false);
    expect(r1.score.stepsDone).toBe(1);
    expect(r1.score.stepsFailed).toBe(1);
    expect(r1.plan.steps.map((step) => step.status)).toEqual(["failed", "done"]);
    expect(readFileSync(r1.paths.tracePath, "utf8")).toContain(
      '"continuation":"remaining_steps"',
    );

    // resume: all steps should already be terminal
    const r2 = await executePlan({
      baseDir: base,
      plan: loadPlan(runDir(base, r1.runId)),
      resumeRunId: r1.runId,
    });
    expect(r2.runId).toBe(r1.runId);
    expect(r2.ok).toBe(false);
    expect(r2.score.stepsFailed).toBe(1);
    expect(r2.plan.steps[0]?.status).toBe("failed");
  });

  it("appends dogfood ledger and aggregates 30-run report", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-dog-"));
    dirs.push(base);
    await helloWorldRun(base);
    const seeded = seedDogfoodScores(base, DOGFOOD_TARGET_RUNS, {
      okRate: 0.6,
      prefix: "seed",
    });
    expect(seeded).toHaveLength(DOGFOOD_TARGET_RUNS);
    const report = collectDogfood(base);
    expect(report.totalRuns).toBeGreaterThanOrEqual(DOGFOOD_TARGET_RUNS);
    expect(report.meetsVolume).toBe(true);
    expect(report.meetsOkRate).toBe(true);
    expect(report.day90Ready).toBe(true);
    const path = writeDogfoodReport(base, report);
    expect(readFileSync(path, "utf8")).toContain("day90Ready");
    expect(formatDogfoodReport(report)).toMatch(/Dogfood/);
  });

  it("views trajectories", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-view-"));
    dirs.push(base);
    const r = await helloWorldRun(base);
    const list = listTrajectories(base);
    expect(list.some((x) => x.runId === r.runId)).toBe(true);
    const text = viewTrajectory(base, r.runId);
    expect(text).toContain("score.json");
    expect(text).toContain("trace");
  });

  it("HITL plan edit + cost fields on score", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-hitl-"));
    dirs.push(base);
    const r = await helloWorldRun(base);
    expect(r.score.costUsd).toBeGreaterThanOrEqual(0);
    expect(r.score.tokensEst).toBeGreaterThan(0);
    const plans = listPlans(base);
    expect(plans.some((p) => p.runId === r.runId)).toBe(true);
    const updated = savePlanHitl(base, r.runId, {
      title: "Edited by human",
      goal: "HITL goal",
    });
    expect(updated.title).toBe("Edited by human");
    expect(getPlan(base, r.runId).goal).toBe("HITL goal");
  });

  it("filters run directories without a readable plan", () => {
    const base = mkdtempSync(join(tmpdir(), "harness-plans-"));
    dirs.push(base);
    mkdirSync(join(base, "runs", "missing"), { recursive: true });
    mkdirSync(join(base, "runs", "invalid"), { recursive: true });
    writeFileSync(join(base, "runs", "invalid", "plan.json"), "{", "utf8");

    expect(listPlans(base)).toEqual([]);
  });

  it("runs real specialist tools not stub_ok", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-real-"));
    dirs.push(base);
    let plan = emptyPlan({
      kind: "generic",
      title: "real tools",
      goal: "no stubs",
      agent: "warden",
    });
    plan = addStep(plan, {
      title: "API review",
      action: "critic.api_reviewer",
      successCriteria: ["score"],
    });
    plan = addStep(plan, {
      title: "BSG lock",
      action: "bsg.lock",
      successCriteria: ["bsg"],
    });
    plan = addStep(plan, {
      title: "DAG unit",
      action: "dag.pr_unit",
      successCriteria: ["plan"],
      notes: JSON.stringify({
        name: "demo",
        sourceSystem: "vb6",
        targetStack: "node",
        dag: [
          { id: "first", title: "First", repoKey: "core" },
          {
            id: "second",
            title: "Second",
            repoKey: "api",
            dependsOn: ["first"],
          },
        ],
      }),
    });
    plan = addStep(plan, {
      title: "Fidelity",
      action: "critic.bsg_fidelity",
      successCriteria: ["equal"],
      notes: JSON.stringify({ expected: "ok", actual: "ok" }),
    });
    const r = await executePlan({ baseDir: base, plan });
    expect(r.ok).toBe(true);
    const evidence = r.plan.steps.map((s) => s.evidence ?? "").join("\n");
    expect(evidence).not.toContain("stub_ok");
    expect(evidence).toMatch(/score|bsgId|campaignId|equal/);
  });
});
