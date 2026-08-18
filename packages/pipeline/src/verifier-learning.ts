import { createHash } from "node:crypto";
import { verifyVerifierTelemetry, type VerifierTelemetry } from "@mendpoint/verifier";

export type VerifierOutcomeAuthority = "deterministic" | "human";
export type VerifierOutcomeLabel = Readonly<{
  authority: VerifierOutcomeAuthority;
  winnerCandidateId: string;
  evidenceRefs: readonly string[];
  observedAt: string;
}>;
export type VerifierSoftLearningSignal = Readonly<{
  schemaVersion: "2026-08-17.verifier-learning.v1";
  signalId: string;
  tenantId: string;
  missionId: string;
  taskId: string;
  product: "fettler" | "regauge";
  telemetryId: string;
  telemetryDigest: string;
  verifierModel: string | null;
  verifierBackendRevision: string | null;
  suggestedCandidateId: string | null;
  candidateScores: Readonly<Record<string, number>>;
  outcome: VerifierOutcomeLabel | null;
  preference: Readonly<{ chosenCandidateId: string; rejectedCandidateIds: readonly string[]; verifierAgreed: boolean }> | null;
  preferenceEligibleForGovernedAdmission: boolean;
  modelTrainingEligible: false;
  softSignalOnly: true;
  signalDigest: string;
}>;

export function createVerifierSoftLearningSignal(input: Readonly<{
  telemetry: VerifierTelemetry;
  outcome: VerifierOutcomeLabel | null;
}>): VerifierSoftLearningSignal {
  const telemetry = verifyVerifierTelemetry(input.telemetry);
  const candidateIds = [...telemetry.eligibleCandidateIds].sort(compareText);
  let outcome: VerifierOutcomeLabel | null = null;
  let preference: VerifierSoftLearningSignal["preference"] = null;
  if (input.outcome) {
    if (input.outcome.authority !== "deterministic" && input.outcome.authority !== "human") fail("verifier_learning_authority_invalid");
    if (!candidateIds.includes(input.outcome.winnerCandidateId)) fail("verifier_learning_winner_invalid");
    const evidenceRefs = normalizedRefs(input.outcome.evidenceRefs);
    if (!evidenceRefs.length) fail("verifier_learning_evidence_required");
    const observedAt = exactIso(input.outcome.observedAt);
    outcome = Object.freeze({ authority: input.outcome.authority, winnerCandidateId: input.outcome.winnerCandidateId, evidenceRefs, observedAt });
    preference = Object.freeze({
      chosenCandidateId: outcome.winnerCandidateId,
      rejectedCandidateIds: Object.freeze(candidateIds.filter((id) => id !== outcome!.winnerCandidateId)),
      verifierAgreed: telemetry.suggestedCandidateId === outcome.winnerCandidateId,
    });
  }
  const base = {
    schemaVersion: "2026-08-17.verifier-learning.v1" as const,
    signalId: `verifier_learning_${sha256(`${telemetry.telemetryDigest}\0${outcome ? canonicalJson(outcome) : "unlabeled"}`)}`,
    tenantId: telemetry.tenantId,
    missionId: telemetry.missionId,
    taskId: telemetry.taskId,
    product: telemetry.product,
    telemetryId: telemetry.telemetryId,
    telemetryDigest: telemetry.telemetryDigest,
    verifierModel: telemetry.backend?.model ?? null,
    verifierBackendRevision: telemetry.backend?.backendRevision ?? null,
    suggestedCandidateId: telemetry.suggestedCandidateId,
    candidateScores: telemetry.candidateScores,
    outcome,
    preference,
    preferenceEligibleForGovernedAdmission: outcome !== null,
    modelTrainingEligible: false as const,
    softSignalOnly: true as const,
  };
  return deepFreeze({ ...base, signalDigest: `sha256:${sha256(canonicalJson(base))}` });
}

function exactIso(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail("verifier_learning_observed_at_invalid");
  return value;
}
function normalizedRefs(input: readonly string[]): readonly string[] {
  if (!Array.isArray(input) || input.length > 128 || input.some((value) => typeof value !== "string" || value.trim() !== value || !value || value.length > 512)) fail("verifier_learning_evidence_invalid");
  if (new Set(input).size !== input.length) fail("verifier_learning_evidence_invalid");
  return Object.freeze([...input].sort(compareText));
}
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
function fail(code: string): never { throw new Error(code); }
