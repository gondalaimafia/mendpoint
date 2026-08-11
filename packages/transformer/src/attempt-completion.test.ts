import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createTransformerAttemptCompletionPayload,
  createTransformerAttemptCompletionDigest,
  openTransformerAttemptCompletionPayload,
  type TransformerAttemptCompletionIntent,
} from "./attempt-completion.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const revision = (character: string) => character.repeat(40);

function intent(): TransformerAttemptCompletionIntent {
  return {
    schemaVersion: 1,
    tenantId: "tenant-a",
    campaignId: "campaign-a",
    unitId: "unit-a",
    episodeId: `transformer-episode-${"e".repeat(32)}`,
    candidateSealDigest: digest("f"),
    attemptNumber: 2,
    leaseGeneration: 3,
    leaseTokenDigest: digest("a"),
    sourceRevision: revision("b"),
    sourceDigest: digest("b"),
    candidateRevision: revision("c"),
    candidateDigest: digest("c"),
    authorizationDigest: digest("d"),
    verificationPassed: true,
    actualCostUsd: 0.25,
    accounting: {
      plannerCalls: 1,
      modelCalls: 1,
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      actualCostUsd: 0.25,
      wallTimeMs: 60_000,
    },
    observedAt: "2026-08-11T18:30:00.000Z",
    evidenceRefs: ["evidence://attempt/approval", "evidence://attempt/terminal"],
  };
}

describe("Transformer attempt completion intent", () => {
  it("binds every terminal coordinator field to one stable digest", () => {
    const value = intent();
    const expected = createTransformerAttemptCompletionDigest(value);
    expect(expected).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(createTransformerAttemptCompletionDigest(structuredClone(value))).toBe(expected);

    const changes: TransformerAttemptCompletionIntent[] = [
      { ...value, tenantId: "tenant-b" },
      { ...value, campaignId: "campaign-b" },
      { ...value, unitId: "unit-b" },
      { ...value, episodeId: `transformer-episode-${"d".repeat(32)}` },
      { ...value, candidateSealDigest: digest("e") },
      { ...value, attemptNumber: 3 },
      { ...value, leaseGeneration: 4 },
      { ...value, leaseTokenDigest: digest("d") },
      { ...value, sourceRevision: revision("d") },
      { ...value, sourceDigest: digest("d") },
      { ...value, candidateRevision: revision("e") },
      { ...value, candidateDigest: digest("e") },
      { ...value, authorizationDigest: digest("e") },
      { ...value, actualCostUsd: 0.5 },
      { ...value, accounting: { ...value.accounting, wallTimeMs: 60_001 } },
      { ...value, observedAt: "2026-08-11T18:30:01.000Z" },
      { ...value, evidenceRefs: ["evidence://attempt/other"] },
    ];
    expect(new Set(changes.map(createTransformerAttemptCompletionDigest))).toHaveLength(changes.length);
    expect(changes.every((change) => createTransformerAttemptCompletionDigest(change) !== expected))
      .toBe(true);
  });

  it("rejects incomplete accounting and mutable evidence identity", () => {
    const value = intent();
    expect(() => createTransformerAttemptCompletionDigest({
      ...value,
      accounting: { ...value.accounting, totalTokens: 124 },
    })).toThrow("transformer_attempt_completion_accounting_invalid");
    expect(() => createTransformerAttemptCompletionDigest({
      ...value,
      evidenceRefs: ["evidence://attempt/terminal", "evidence://attempt/terminal"],
    })).toThrow("transformer_attempt_completion_evidence_invalid");
    expect(() => createTransformerAttemptCompletionDigest({
      ...value,
      accounting: { ...value.accounting, modelCalls: 2 },
    })).toThrow("transformer_attempt_completion_accounting_invalid");
    expect(() => createTransformerAttemptCompletionDigest({
      ...value,
      accounting: {
        ...value.accounting,
        modelCalls: 0,
        inputTokens: 1,
        outputTokens: 0,
        totalTokens: 1,
        actualCostUsd: 0,
      },
    })).toThrow("transformer_attempt_completion_accounting_invalid");
    const sparse = new Array<string>(2);
    sparse[1] = "evidence://attempt/terminal";
    expect(() => createTransformerAttemptCompletionDigest({
      ...value,
      evidenceRefs: sparse,
    })).toThrow("transformer_attempt_completion_evidence_invalid");
  });

  it("canonicalizes evidence order exactly like coordinator persistence", () => {
    const value = intent();
    expect(createTransformerAttemptCompletionDigest({
      ...value,
      evidenceRefs: [...value.evidenceRefs].reverse(),
    })).toBe(createTransformerAttemptCompletionDigest(value));
  });

  it("rejects identifiers that only become valid after string coercion", () => {
    const value = intent();
    expect(() => createTransformerAttemptCompletionDigest({
      ...value,
      tenantId: 123,
    } as unknown as TransformerAttemptCompletionIntent)).toThrow(
      "transformer_attempt_completion_invalid",
    );
    expect(() => createTransformerAttemptCompletionDigest({
      ...value,
      episodeId: undefined,
    } as unknown as TransformerAttemptCompletionIntent)).toThrow(
      "transformer_attempt_completion_invalid",
    );
  });

  it("persists the complete canonical intent for successor-node replay", () => {
    const value = intent();
    const payload = createTransformerAttemptCompletionPayload({
      ...value,
      evidenceRefs: [...value.evidenceRefs].reverse(),
    });
    expect(openTransformerAttemptCompletionPayload(payload)).toEqual({
      ...value,
      accounting: { ...value.accounting },
      evidenceRefs: [...value.evidenceRefs].sort(),
    });
    expect(createTransformerAttemptCompletionDigest(value)).toBe(
      `sha256:${createHash("sha256").update(payload).digest("hex")}`,
    );
    const tampered = Buffer.from(payload);
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 1;
    expect(() => openTransformerAttemptCompletionPayload(tampered)).toThrow(
      "transformer_attempt_completion_invalid",
    );
  });
});
