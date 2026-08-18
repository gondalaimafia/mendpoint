import { describe, expect, it } from "vitest";
import {
  createGovernedLearningEvent,
  extractGovernedLesson,
} from "./learning-event.js";

const CREATED_AT = "2026-08-14T20:00:00.000Z";

function eventInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    eventId: "learning-event-1",
    product: "fettler" as const,
    missionId: "mission-1",
    repositoryId: "repository-1",
    taskType: "api_remediation",
    capability: "remediation_generation",
    specialization: {
      provider: "stripe",
      framework: "hono",
      language: "typescript",
      runtime: "node-20",
      migrationFamily: "response-field-replacement",
      riskClass: "medium",
      splitGroupId: "repository-1:response-field-replacement",
    },
    execution: {
      modelId: "model-1",
      adapterId: null,
      routerDecisionId: "router-decision-1",
      fallback: false,
    },
    references: {
      graphContextArtifactId: "graph-1",
      inputArtifactId: "input-1",
      proposedActionArtifactId: "candidate-1",
    },
    prediction: {
      summary: "The removed response field should use the replacement field.",
      evidenceRefs: ["evidence-prediction-1"],
    },
    observedOutcome: {
      status: "corrected" as const,
      summary: "The reviewer corrected the replacement field and verification passed.",
      attribution: "model_behavior" as const,
      evidenceRefs: ["evidence-outcome-1"],
    },
    verification: {
      verdict: "passed" as const,
      evidenceRefs: ["evidence-verification-1"],
      authority: {
        signalClass: "hard" as const,
        producedBy: "test_runner" as const,
        producerModelId: null,
      },
    },
    reviewerDecision: {
      decision: "modified" as const,
      evidenceRefs: ["review-1"],
    },
    correction: {
      artifactId: "correction-1",
      substantive: true,
    },
    confidence: 0.82,
    economics: {
      inputTokens: 1200,
      outputTokens: 240,
      latencyMs: 1500,
      costUsd: 0.012,
    },
    governance: {
      tenantId: "tenant-1",
      residencyRegion: "us-central",
      consentId: "consent-1",
      sourceClass: "production_verified" as const,
      provenanceQualifiers: ["human_corrected", "deterministically_verified"] as const,
      mayLeaveTenantBoundary: false,
    },
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe("governed learning events", () => {
  it("creates a deterministic immutable event and extracts a model lesson", () => {
    const first = createGovernedLearningEvent(eventInput());
    const second = createGovernedLearningEvent(eventInput({
      prediction: {
        evidenceRefs: ["evidence-prediction-1"],
        summary: "The removed response field should use the replacement field.",
      },
    }));

    expect(second.digest).toBe(first.digest);
    expect(Object.isFrozen(first.event)).toBe(true);
    expect(Object.isFrozen(first.event.observedOutcome)).toBe(true);
    expect(first.event.specialization.splitGroupId).toBe("repository-1:response-field-replacement");

    const lesson = extractGovernedLesson(first);
    expect(lesson).toMatchObject({
      eventId: "learning-event-1",
      eventDigest: first.digest,
      evidenceStrength: "high",
      destinations: [{ destination: "model_weight", rationale: "model_behavior_corrected" }],
      eligibleForModelTraining: true,
    });
  });

  it("routes infrastructure failures away from model weights", () => {
    const parser = createGovernedLearningEvent(eventInput({
      observedOutcome: {
        status: "failed",
        summary: "The parser omitted the import edge.",
        attribution: "parser",
        evidenceRefs: ["evidence-parser-1"],
      },
      correction: null,
    }));
    const router = createGovernedLearningEvent(eventInput({
      observedOutcome: {
        status: "failed",
        summary: "The selected execution path failed while the fallback passed.",
        attribution: "router",
        evidenceRefs: ["evidence-router-1"],
      },
      correction: null,
    }));

    expect(extractGovernedLesson(parser).destinations).toEqual([
      { destination: "parser", rationale: "parser_failure" },
    ]);
    expect(extractGovernedLesson(router).destinations).toEqual([
      { destination: "router_policy", rationale: "router_selection_failure" },
    ]);
    expect(extractGovernedLesson(parser).eligibleForModelTraining).toBe(false);
  });

  it("preserves synthetic provenance and refuses unverified training lessons", () => {
    const synthetic = createGovernedLearningEvent(eventInput({
      governance: {
        tenantId: "tenant-1",
        residencyRegion: "us-central",
        consentId: "consent-1",
        sourceClass: "synthetic_ground_truth",
        provenanceQualifiers: ["deterministically_verified"],
        mayLeaveTenantBoundary: false,
      },
      verification: { verdict: "inconclusive", evidenceRefs: ["grader-1"] },
    }));

    expect(synthetic.event.governance.sourceClass).toBe("synthetic_ground_truth");
    expect(extractGovernedLesson(synthetic)).toMatchObject({
      evidenceStrength: "insufficient",
      destinations: [{ destination: "no_action", rationale: "verification_not_authoritative" }],
      eligibleForModelTraining: false,
    });
  });

  it("caps a soft model-verifier verdict below the strongest tier regardless of qualifiers", () => {
    const soft = createGovernedLearningEvent(eventInput({
      verification: {
        verdict: "passed",
        evidenceRefs: ["evidence-verification-1"],
        authority: { signalClass: "soft", producedBy: "model_verifier", producerModelId: "muse-spark-1.2" },
      },
    }));

    const lesson = extractGovernedLesson(soft);
    // Every high-granting qualifier is present, but a soft verdict can never reach
    // "high" or become weight-training eligible.
    expect(lesson.evidenceStrength).toBe("medium");
    expect(lesson.eligibleForModelTraining).toBe(false);
  });

  it("treats an event with no recorded authority as soft, never hard (dual-read)", () => {
    // A pre-change event: `verification` carries only verdict and evidenceRefs.
    const legacyInput = eventInput();
    const withoutAuthority = {
      ...legacyInput,
      verification: { verdict: "passed" as const, evidenceRefs: ["evidence-verification-1"] },
    };

    const event = createGovernedLearningEvent(withoutAuthority);
    // It loads without throwing and the field stays absent (digest-stable).
    expect(event.event.verification.authority).toBeUndefined();

    const lesson = extractGovernedLesson(event);
    expect(lesson.evidenceStrength).toBe("medium");
    expect(lesson.eligibleForModelTraining).toBe(false);
  });

  it("round-trips a stored pre-change event and rejects malformed authority", () => {
    // The digest of a pre-change (no-authority) event is unchanged by this change:
    // the normalizer never injects the field, so extraction validates cleanly.
    const legacy = createGovernedLearningEvent({
      ...eventInput(),
      verification: { verdict: "passed" as const, evidenceRefs: ["evidence-verification-1"] },
    });
    expect(() => extractGovernedLesson(legacy)).not.toThrow();

    // A present-but-malformed authority is rejected, not coerced to a default.
    expect(() => createGovernedLearningEvent(eventInput({
      verification: {
        verdict: "passed",
        evidenceRefs: ["evidence-verification-1"],
        authority: { signalClass: "hard", producedBy: "test_runner" },
      },
    }))).toThrow("learning_event_verification_authority_field_missing");
    expect(() => createGovernedLearningEvent(eventInput({
      verification: {
        verdict: "passed",
        evidenceRefs: ["evidence-verification-1"],
        authority: { signalClass: "authoritative", producedBy: "test_runner", producerModelId: null },
      },
    }))).toThrow("learning_event_verification_signal_class_invalid");
  });

  it("keeps a genuinely hard verdict at the strongest tier and eligible", () => {
    const hard = createGovernedLearningEvent(eventInput());
    const lesson = extractGovernedLesson(hard);
    expect(hard.event.verification.authority).toEqual({
      signalClass: "hard",
      producedBy: "test_runner",
      producerModelId: null,
    });
    expect(lesson.evidenceStrength).toBe("high");
    expect(lesson.eligibleForModelTraining).toBe(true);
  });

  it("rejects private reasoning fields and noncanonical timestamps", () => {
    expect(() => createGovernedLearningEvent(eventInput({
      prediction: {
        summary: "Observable answer",
        evidenceRefs: ["evidence-1"],
        chainOfThought: "private reasoning",
      },
    }))).toThrow("learning_event_private_reasoning_forbidden");
    expect(() => createGovernedLearningEvent(eventInput({
      createdAt: "August 14, 2026 20:00:00Z",
    }))).toThrow("learning_event_created_at_invalid");
    expect(() => createGovernedLearningEvent(eventInput({
      specialization: {
        provider: "stripe",
        framework: "hono",
        language: "typescript",
        runtime: "node-20",
        migrationFamily: "response-field-replacement",
        riskClass: "medium",
        splitGroupId: "",
      },
    }))).toThrow("learning_event_split_group_invalid");
  });
});
