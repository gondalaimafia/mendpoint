import { describe, expect, it } from "vitest";
import type { CandidateReviewEvidence } from "@mendpoint/shared";
import { deriveWardenVerificationAuthority } from "./warden-learning-producer.js";

type AssessmentSource = "planner" | "verifier" | "unavailable";

function review(
  assessmentSource: AssessmentSource,
  commands: ReadonlyArray<{ ok: boolean; exitCode: number }> = [{ ok: true, exitCode: 0 }],
): CandidateReviewEvidence {
  return {
    schemaVersion: 1,
    summary: "The exact candidate passed every configured check.",
    verification: {
      summary: "The target and regression checks passed.",
      commands: commands.map((command, index) => ({
        command: `check-${index}`,
        ok: command.ok as true,
        exitCode: command.exitCode as 0,
        outputSha256: `sha256:${"e".repeat(64)}`,
      })),
    },
    edits: [{
      path: "src/client.ts",
      rationale: "This source change repairs the bounded SDK call.",
      category: "api_repair",
      risk: "medium",
      confidence: 1,
      assessmentSource,
      verification: {
        summary: "The target and regression checks passed.",
        commandOutputSha256: [`sha256:${"e".repeat(64)}`],
      },
    }],
  } as CandidateReviewEvidence;
}

describe("Warden verification authority is derived from what actually ran", () => {
  it("marks a planner self-assessed edit as soft even when deterministic commands passed", () => {
    // A model that graded its own edit is a soft signal; the passing commands do
    // not launder it into a deterministic label.
    expect(deriveWardenVerificationAuthority(review("planner"))).toEqual({
      signalClass: "soft",
      producedBy: "model_verifier",
      producerModelId: null,
    });
  });

  it("marks an independently verified edit as hard when deterministic commands passed", () => {
    expect(deriveWardenVerificationAuthority(review("verifier"))).toEqual({
      signalClass: "hard",
      producedBy: "sandbox_command",
      producerModelId: null,
    });
  });

  it("fails closed to soft for an unavailable assessment", () => {
    expect(deriveWardenVerificationAuthority(review("unavailable")).signalClass).toBe("soft");
  });

  it("fails closed to soft when no command actually passed", () => {
    // Independently assessed, but the deterministic command did not pass: no hard
    // verdict exists.
    expect(deriveWardenVerificationAuthority(review("verifier", [{ ok: false, exitCode: 1 }])).signalClass)
      .toBe("soft");
  });
});
