import { describe, expect, it } from "vitest";
import { FETTLER_DELEGATION_DELIVERY_EVAL_SCENARIO } from "./fettler-delegation-eval.js";

describe("Fettler apply, verify, and draft delivery evaluation", () => {
  it("takes one bounded repository task through the production worker and exact draft boundary", async () => {
    const result = await FETTLER_DELEGATION_DELIVERY_EVAL_SCENARIO.run(1);

    expect(result.grades.filter((grade) => !grade.passed)).toEqual([]);
    expect(result.grades.map((grade) => grade.id)).toEqual(expect.arrayContaining([
      "worker.candidate_ready",
      "trajectory.persisted",
      "verification.fail_to_pass",
      "verification.pass_to_pass",
      "repository.immutable_source",
      "repository.exact_allowed_diff",
      "approval.exact_seal",
      "delivery.production_worker",
      "delivery.draft_only",
      "delivery.exact_files",
      "delivery.evidence_linked",
      "delivery.idempotent_replay",
      "delivery.base_drift_blocked",
      "delivery.divergence_blocked",
    ]));
    expect(result.observation.details).toMatchObject({
      lane: "simulated_scripted",
      liveModelCapability: false,
      liveScmCapability: false,
      authenticatedHumanApproval: false,
      productionWorkerExecution: true,
      productionWorkerDelivery: true,
      exactDraftBoundary: true,
      pullRequestCount: 1,
    });
  }, 60_000);
});
