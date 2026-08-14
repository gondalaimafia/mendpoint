import { describe, expect, it } from "vitest";
import {
  assessFeedFreshness,
  CandidateReviewEvidenceSchema,
  ChangeRiskSchema,
  newId,
  ok,
} from "./index.js";

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

  it("bounds feed success freshness and in-progress polls by the schedule stale window", () => {
    const nowMs = Date.parse("2026-08-07T12:00:00.000Z");
    const base = { staleAfterMs: 60_000, nowMs };

    expect(assessFeedFreshness({
      ...base,
      lastSuccessAt: "2026-08-07T11:59:59.000Z",
    })).toMatchObject({ ok: true, reason: "fresh" });
    expect(assessFeedFreshness({
      ...base,
      lastSuccessAt: "2026-08-07T11:58:59.999Z",
    })).toMatchObject({ ok: false, reason: "success_stale" });
    expect(assessFeedFreshness({
      ...base,
      lastSuccessAt: "2026-08-07T12:01:00.001Z",
    })).toMatchObject({ ok: false, reason: "success_in_future" });
    expect(assessFeedFreshness({
      ...base,
      lastSuccessAt: "2026-08-07T11:59:59.000Z",
      pollStartedAt: "2026-08-07T11:58:59.999Z",
    })).toMatchObject({ ok: false, reason: "poll_overdue" });
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

  it("requires complete source-bound edit authority in version two review evidence", () => {
    const evidence = {
      schemaVersion: 2,
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
        hypothesis: "The observed legacy endpoint causes the failing request.",
        targetSymbol: "createCharge",
        sourceEvidence: [{ path: "src/client.ts", digest: `sha256:${"b".repeat(64)}` }],
        precondition: "The exact observed endpoint is still present.",
        expectedObservation: "The endpoint changes exactly once.",
        postcondition: "The approved request and regression checks pass.",
        rollback: "Restore the exact observed source bytes.",
        stopCondition: "Stop if the source evidence digest changes.",
        risk: "medium",
        confidence: 0.97,
        assessmentSource: "planner",
        verification: {
          summary: "The target and regression checks passed.",
          commandOutputSha256: [`sha256:${"a".repeat(64)}`],
        },
      }],
    };
    expect(CandidateReviewEvidenceSchema.parse(evidence)).toEqual(evidence);
    const missingRollback = structuredClone(evidence) as Record<string, unknown>;
    delete ((missingRollback.edits as Array<Record<string, unknown>>)[0]!).rollback;
    expect(CandidateReviewEvidenceSchema.safeParse(missingRollback).success).toBe(false);
  });
});
