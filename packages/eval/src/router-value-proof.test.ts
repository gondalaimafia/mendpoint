import { describe, expect, it } from "vitest";
import {
  evaluateRouterValueProof,
  type RouterValueProofContract,
} from "./router-value-proof.js";

function contract(): RouterValueProofContract {
  return {
    version: "2026-08-02.v1",
    cohort: {
      id: "router-held-out-v1",
      revision: "a".repeat(40),
      digest: `sha256:${"b".repeat(64)}`,
      heldOut: true,
    },
    policy: {
      latencyP95Ms: 2_000,
      requirePerTaskAcceptanceNonRegression: true,
      requirePerTaskSecurityNonRegression: true,
      requireLowerAcceptedOutputCost: true,
    },
    observations: [
      { taskId: "task-a", arm: "baseline", accepted: true, securityFindings: 0, costUsd: 1, latencyMs: 1_000, evidenceRefs: ["eval:base-a"] },
      { taskId: "task-a", arm: "candidate", accepted: true, securityFindings: 0, costUsd: 0.5, latencyMs: 900, evidenceRefs: ["eval:candidate-a"] },
      { taskId: "task-b", arm: "baseline", accepted: false, securityFindings: 0, costUsd: 0.4, latencyMs: 1_500, evidenceRefs: ["eval:base-b"] },
      { taskId: "task-b", arm: "candidate", accepted: true, securityFindings: 0, costUsd: 0.3, latencyMs: 1_200, evidenceRefs: ["eval:candidate-b"] },
    ],
  };
}

describe("router value proof", () => {
  it("requires per task acceptance and security nonregression plus lower accepted output cost", () => {
    const report = evaluateRouterValueProof(contract());
    expect(report).toMatchObject({
      ok: true,
      taskCount: 2,
      cohortRevision: "a".repeat(40),
      cohortDigest: `sha256:${"b".repeat(64)}`,
      acceptance: { baseline: 0.5, candidate: 1 },
      securityRegressionTaskIds: [],
      acceptanceRegressionTaskIds: [],
      acceptedOutputCostUsd: { baseline: 1, candidate: 0.4 },
      acceptedOutputCostRegressionTaskIds: [],
      candidateLatencyP95Ms: 1_200,
      latencyObjectiveExceededTaskIds: [],
    });
    expect(report.evidenceRefs).toEqual([
      "eval:base-a",
      "eval:base-b",
      "eval:candidate-a",
      "eval:candidate-b",
    ]);
  });

  it("fails when a candidate loses acceptance, adds a security finding, costs more, or misses latency", () => {
    const acceptance = contract();
    acceptance.observations.find((item) => item.taskId === "task-a" && item.arm === "candidate")!.accepted = false;
    expect(evaluateRouterValueProof(acceptance).ok).toBe(false);

    const security = contract();
    security.observations.find((item) => item.taskId === "task-a" && item.arm === "candidate")!.securityFindings = 1;
    expect(evaluateRouterValueProof(security).securityRegressionTaskIds).toEqual(["task-a"]);

    const cost = contract();
    cost.observations.find((item) => item.taskId === "task-a" && item.arm === "candidate")!.costUsd = 2;
    expect(evaluateRouterValueProof(cost)).toMatchObject({
      ok: false,
      acceptedOutputCostRegressionTaskIds: ["task-a"],
    });

    const latency = contract();
    latency.observations.find((item) => item.taskId === "task-b" && item.arm === "candidate")!.latencyMs = 2_001;
    expect(evaluateRouterValueProof(latency)).toMatchObject({
      ok: false,
      latencyObjectiveExceededTaskIds: ["task-b"],
    });
  });

  it("fails closed with task attribution when accepted-output cost aggregation overflows", () => {
    const value = contract();
    for (const observation of value.observations) {
      observation.accepted = true;
      observation.costUsd = 1e308;
    }
    value.observations.push(
      { ...value.observations[0]!, taskId: "task-c", evidenceRefs: ["eval:base-c"] },
      { ...value.observations[1]!, taskId: "task-c", evidenceRefs: ["eval:candidate-c"] },
    );

    expect(evaluateRouterValueProof(value)).toMatchObject({
      ok: false,
      acceptedOutputCostUsd: { baseline: null, candidate: null },
      acceptedOutputCostRegressionTaskIds: ["task-a", "task-b", "task-c"],
    });
  });

  it("rejects training cohorts, missing arms, duplicate arms, and uncited observations", () => {
    const training = contract();
    training.cohort.heldOut = false;
    expect(() => evaluateRouterValueProof(training)).toThrow("router_value_cohort_not_held_out");

    const stringTraining = contract() as unknown as { cohort: { heldOut: string } };
    stringTraining.cohort.heldOut = "false";
    expect(() => evaluateRouterValueProof(stringTraining as never)).toThrow(
      "router_value_cohort_not_held_out",
    );

    const stringAccepted = contract() as unknown as {
      observations: Array<{ accepted: string }>;
    };
    stringAccepted.observations[0]!.accepted = "false";
    expect(() => evaluateRouterValueProof(stringAccepted as never)).toThrow(
      "router_value_acceptance_invalid",
    );

    const missing = contract();
    missing.observations.pop();
    expect(() => evaluateRouterValueProof(missing)).toThrow("router_value_task_arms_incomplete");

    const duplicate = contract();
    duplicate.observations.push({ ...duplicate.observations[0]! });
    expect(() => evaluateRouterValueProof(duplicate)).toThrow("router_value_observation_duplicate");

    const uncited = contract();
    uncited.observations[0]!.evidenceRefs = [];
    expect(() => evaluateRouterValueProof(uncited)).toThrow("router_value_evidence_required");
  });
});
