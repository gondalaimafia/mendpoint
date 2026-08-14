import { describe, expect, it } from "vitest";
import type { AgentPlannerInput } from "@mendpoint/agent";
import {
  createWardenSourceEvalPlanner,
  runWardenSourceEval,
  WARDEN_WORKER_SOURCE_EVAL_SCENARIO,
} from "./warden-source-eval.js";

describe("Warden source grounded simulated eval", () => {
  it("passes three isolated trials with independent target and regression judges", async () => {
    const report = await runWardenSourceEval(3);

    expect(report).toMatchObject({
      lane: "simulated_scripted",
      liveModelCapability: false,
      repetitions: 3,
      passed: true,
    });
    expect(report.trials).toHaveLength(3);
    for (const trial of report.trials) {
      expect(trial.passed).toBe(true);
      expect(trial.plannerCalls).toBeGreaterThan(0);
      expect(trial.observedFiles).toContain("vendor/provider-change.json");
      expect(trial.observedFiles).toContain("src/payments/gateway-client.mjs");
      expect(trial.changedPaths).toEqual(["src/payments/gateway-client.mjs"]);
      expect(trial.grades.filter((grade) => !grade.passed)).toEqual([]);
    }
  }, 60_000);

  it("fails closed when the scripted planner receives no typed source evidence", async () => {
    const planner = createWardenSourceEvalPlanner({ calls: 0, inputs: [] });
    const input: AgentPlannerInput = {
      schemaVersion: 1,
      goal: "Repair the provider regression",
      verifyCommand: "node check.mjs",
      diagnosedModes: [],
      recentSteps: [],
    };

    await expect(planner(input, { signal: new AbortController().signal })).rejects.toThrow(
      "scripted_planner_source_evidence_required",
    );
  });

  it("passes through the queued worker and persists replayable source evidence", async () => {
    const result = await WARDEN_WORKER_SOURCE_EVAL_SCENARIO.run(1);

    expect(result.grades.filter((grade) => !grade.passed)).toEqual([]);
    expect(result.grades.map((grade) => grade.id)).toEqual(expect.arrayContaining([
      "lane.queued_worker",
      "worker.run_candidate_ready",
      "worker.immutable_source",
      "worker.source_binding",
      "context.replayable_digests",
      "model.policy_bound",
      "planner.durable_mission_lineage",
      "artifacts.tenant_scoped",
    ]));
    expect(result.observation.details).toMatchObject({
      lane: "simulated_scripted",
      liveModelCapability: false,
      queuedWorker: true,
    });
  }, 60_000);
});
