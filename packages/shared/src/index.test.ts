import { describe, expect, it } from "vitest";
import { CandidateReviewEvidenceSchema, ChangeRiskSchema, newId, ok } from "./index.js";

describe("shared", () => {
  it("validates change risk", () => {
    expect(ChangeRiskSchema.parse("breaking")).toBe("breaking");
  });

  it("generates ids", () => {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("ok helper", () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
  });

  it("accepts only complete successful candidate review evidence", () => {
    const evidence = {
      schemaVersion: 1,
      summary: "The exact candidate passed every configured check.",
      verification: {
        summary: "The target and regression checks passed.",
        commands: [{
          command: "npm test",
          ok: true,
          exitCode: 0,
          outputSha256: `sha256:${"a".repeat(64)}`,
        }],
      },
      edits: [{
        path: "src/client.ts",
        rationale: "This edit updates the bounded API call.",
        category: "api_repair",
        risk: "medium",
        confidence: 1,
        assessmentSource: "planner",
        verification: {
          summary: "The target and regression checks passed.",
          commandOutputSha256: [`sha256:${"a".repeat(64)}`],
        },
      }],
    };
    expect(CandidateReviewEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(CandidateReviewEvidenceSchema.safeParse({
      ...evidence,
      verification: {
        ...evidence.verification,
        commands: [{ ...evidence.verification.commands[0], ok: false }],
      },
    }).success).toBe(false);
  });
});
