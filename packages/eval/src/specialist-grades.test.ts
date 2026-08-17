import { describe, expect, it } from "vitest";
import {
  everyGradePassed,
  gradeDiagnosisOnly,
  gradeFailed,
  gradeInvariant,
  gradePassed,
  gradeRetryPenalty,
} from "./specialist-grades.js";
import { SPECIALIST_AGENT_EVAL_SCENARIOS } from "./specialist-scenarios.js";

describe("diagnosis-only grade", () => {
  const attribution = {
    cohortCorrelation: "region eu-west fails 25% while others fail 0%",
    componentStatus: "status reports operational while the charge component is degraded",
    independentReproduction: "reproduced from an independent network path",
  };

  it("passes only with an empty diff and complete attribution", () => {
    const grades = gradeDiagnosisOnly({ changedPaths: [], attribution });
    expect(everyGradePassed(grades)).toBe(true);
  });

  it("fails closed on any source mutation", () => {
    const grades = gradeDiagnosisOnly({
      changedPaths: ["src/payments/serialize.ts"],
      attribution,
    });
    expect(gradeFailed(grades, "diagnosis.no_source_mutation")).toBe(true);
    const grade = grades.find((candidate) => candidate.id === "diagnosis.no_source_mutation");
    expect(grade?.observed).toContain("src/payments/serialize.ts");
  });

  it("names the missing evidence element", () => {
    const grades = gradeDiagnosisOnly({
      changedPaths: [],
      attribution: { cohortCorrelation: attribution.cohortCorrelation },
    });
    const grade = grades.find((candidate) => candidate.id === "diagnosis.attribution_evidence");
    expect(grade?.passed).toBe(false);
    expect(grade?.observed).toContain("componentStatus");
    expect(grade?.observed).toContain("independentReproduction");
  });
});

describe("invariant grade", () => {
  it("passes only when the functional outcome and every invariant hold", () => {
    const grades = gradeInvariant({
      functionalOutcomeMet: true,
      invariants: [{ id: "charges_created_once", held: true, detail: "1 charge created" }],
    });
    expect(everyGradePassed(grades)).toBe(true);
  });

  it("fails a broken invariant while the functional check passes", () => {
    const grades = gradeInvariant({
      functionalOutcomeMet: true,
      invariants: [{ id: "charges_created_once", held: false, detail: "2 charges created" }],
    });
    expect(gradePassed(grades, "invariant.functional_outcome")).toBe(true);
    expect(gradeFailed(grades, "invariant.charges_created_once")).toBe(true);
  });
});

describe("retry-penalty grade", () => {
  it("fails an added retry construct for a harmful family", () => {
    const grades = gradeRetryPenalty({
      family: "non_idempotent_timeout",
      retryHarmful: true,
      operationCallCount: 2,
      maxOperationCalls: 1,
      diffText: "retry the charge with backoff",
    });
    expect(gradeFailed(grades, "retry.operation_call_count")).toBe(true);
    expect(gradeFailed(grades, "retry.no_added_retry")).toBe(true);
  });

  it("passes a single call with no retry construct", () => {
    const grades = gradeRetryPenalty({
      family: "non_idempotent_timeout",
      retryHarmful: true,
      operationCallCount: 1,
      maxOperationCalls: 1,
      diffText: "query the charge outcome before deciding",
    });
    expect(everyGradePassed(grades)).toBe(true);
  });

  it("does not penalize retry for a permitted family", () => {
    const grades = gradeRetryPenalty({
      family: "rate_limit_429",
      retryHarmful: false,
      operationCallCount: 4,
      maxOperationCalls: 1,
      diffText: "retry with Retry-After backoff and jitter",
    });
    expect(everyGradePassed(grades)).toBe(true);
  });
});

describe("specialist reference scenarios", () => {
  it("passes the correct behavior and rejects every naive trap", async () => {
    for (const scenario of SPECIALIST_AGENT_EVAL_SCENARIOS) {
      const result = await scenario.run(1);
      const failing = result.grades.filter((grade) => !grade.passed);
      expect(failing, `${scenario.id} failing grades: ${JSON.stringify(failing)}`).toEqual([]);
      const trapGrades = result.grades.filter((grade) => grade.id.startsWith("trap."));
      expect(trapGrades.length, `${scenario.id} has trap grades`).toBeGreaterThan(0);
      expect(trapGrades.every((grade) => grade.passed)).toBe(true);
    }
  });

  it("is deterministic across repeated runs", async () => {
    for (const scenario of SPECIALIST_AGENT_EVAL_SCENARIOS) {
      const first = await scenario.run(1);
      const second = await scenario.run(2);
      expect(first.observation.semanticDigest).toBe(second.observation.semanticDigest);
    }
  });
});
