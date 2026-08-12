import { createHash } from "node:crypto";
import type { TransformerAdaptiveAttemptAccounting } from "./pilot-execution.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const MAX_COMPLETION_PAYLOAD_BYTES = 64 * 1024;
const ACCOUNTING_KEYS = Object.freeze([
  "plannerCalls",
  "modelCalls",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "actualCostUsd",
  "wallTimeMs",
]);

export type TransformerAttemptCompletionIntent = Readonly<{
  schemaVersion: 1;
  tenantId: string;
  campaignId: string;
  unitId: string;
  episodeId: string;
  candidateSealDigest: string;
  attemptNumber: number;
  leaseGeneration: number;
  leaseTokenDigest: string;
  sourceRevision: string;
  sourceDigest: string;
  candidateRevision: string;
  candidateDigest: string;
  authorizationDigest: string;
  verificationPassed: true;
  actualCostUsd: number;
  accounting: TransformerAdaptiveAttemptAccounting;
  observedAt: string;
  evidenceRefs: readonly string[];
}>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`
  ).join(",")}}`;
}

function exactKeys(value: object, expected: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) {
    throw new Error(code);
  }
}

function natural(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function validateAccounting(value: TransformerAdaptiveAttemptAccounting): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("transformer_attempt_completion_accounting_invalid");
  }
  exactKeys(value, ACCOUNTING_KEYS, "transformer_attempt_completion_accounting_invalid");
  if (
    !natural(value.plannerCalls) || !natural(value.modelCalls) ||
    !natural(value.inputTokens) || !natural(value.outputTokens) ||
    !natural(value.totalTokens) || value.totalTokens !== value.inputTokens + value.outputTokens ||
    !Number.isFinite(value.actualCostUsd) || value.actualCostUsd < 0 ||
    !natural(value.wallTimeMs) || value.modelCalls > value.plannerCalls ||
    (value.modelCalls === 0 && (
      value.inputTokens !== 0 || value.outputTokens !== 0 || value.totalTokens !== 0
    )) ||
    (value.modelCalls > 0 && (
      value.inputTokens <= 0 || value.outputTokens <= 0 || value.totalTokens <= 0 ||
      value.actualCostUsd <= 0
    ))
  ) {
    throw new Error("transformer_attempt_completion_accounting_invalid");
  }
}

function validateIntent(value: TransformerAttemptCompletionIntent): TransformerAttemptCompletionIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("transformer_attempt_completion_invalid");
  }
  exactKeys(value, [
    "schemaVersion", "tenantId", "campaignId", "unitId", "episodeId",
    "candidateSealDigest", "attemptNumber", "leaseGeneration", "leaseTokenDigest",
    "sourceRevision", "sourceDigest", "candidateRevision", "candidateDigest",
    "authorizationDigest", "verificationPassed", "actualCostUsd", "accounting", "observedAt",
    "evidenceRefs",
  ], "transformer_attempt_completion_invalid");
  const observedAt = Date.parse(value.observedAt);
  if (
    value.schemaVersion !== 1 ||
    typeof value.tenantId !== "string" || typeof value.campaignId !== "string" ||
    typeof value.unitId !== "string" || typeof value.episodeId !== "string" ||
    !ID.test(value.tenantId) || !ID.test(value.campaignId) || !ID.test(value.unitId) ||
    !ID.test(value.episodeId) ||
    !DIGEST.test(value.candidateSealDigest) || !DIGEST.test(value.leaseTokenDigest) ||
    !DIGEST.test(value.sourceDigest) || !DIGEST.test(value.candidateDigest) ||
    !DIGEST.test(value.authorizationDigest) ||
    !REVISION.test(value.sourceRevision) || !REVISION.test(value.candidateRevision) ||
    !positive(value.attemptNumber) || !positive(value.leaseGeneration) ||
    value.verificationPassed !== true ||
    !Number.isFinite(value.actualCostUsd) || value.actualCostUsd < 0 ||
    !Number.isFinite(observedAt) || new Date(observedAt).toISOString() !== value.observedAt
  ) {
    throw new Error("transformer_attempt_completion_invalid");
  }
  validateAccounting(value.accounting);
  const evidenceKeys = Array.isArray(value.evidenceRefs) ? Object.keys(value.evidenceRefs) : [];
  if (
    !Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0 ||
    evidenceKeys.length !== value.evidenceRefs.length ||
    evidenceKeys.some((entry, index) => entry !== String(index)) ||
    value.evidenceRefs.some((entry) => typeof entry !== "string" || !entry.trim()) ||
    new Set(value.evidenceRefs).size !== value.evidenceRefs.length
  ) {
    throw new Error("transformer_attempt_completion_evidence_invalid");
  }
  return Object.freeze({
    ...value,
    accounting: Object.freeze({ ...value.accounting }),
    evidenceRefs: Object.freeze([...value.evidenceRefs].sort()),
  });
}

export function createTransformerAttemptCompletionDigest(
  value: TransformerAttemptCompletionIntent,
): string {
  return `sha256:${createHash("sha256").update(
    createTransformerAttemptCompletionPayload(value),
  ).digest("hex")}`;
}

export function createTransformerAttemptAuthorizationDigest(
  gateConfig: string | undefined,
): string {
  if (gateConfig !== undefined && typeof gateConfig !== "string") {
    throw new Error("transformer_attempt_completion_authorization_invalid");
  }
  return `sha256:${createHash("sha256").update(canonical({
    gateConfig: gateConfig ?? null,
  }), "utf8").digest("hex")}`;
}

export function createTransformerAttemptCompletionPayload(
  value: TransformerAttemptCompletionIntent,
): Uint8Array {
  const normalized = validateIntent(value);
  return Buffer.from(canonical(normalized), "utf8");
}

export function openTransformerAttemptCompletionPayload(
  payload: Uint8Array,
): TransformerAttemptCompletionIntent {
  try {
    if (!(payload instanceof Uint8Array) || payload.byteLength === 0 ||
      payload.byteLength > MAX_COMPLETION_PAYLOAD_BYTES) {
      throw new Error("transformer_attempt_completion_invalid");
    }
    const source = Buffer.from(payload);
    const normalized = validateIntent(
      JSON.parse(source.toString("utf8")) as TransformerAttemptCompletionIntent,
    );
    const expected = Buffer.from(canonical(normalized), "utf8");
    if (!source.equals(expected)) {
      throw new Error("transformer_attempt_completion_invalid");
    }
    return normalized;
  } catch {
    throw new Error("transformer_attempt_completion_invalid");
  }
}
