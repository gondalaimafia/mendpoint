import type { VerifierFailureCode, VerifierTelemetry } from "./types.js";
import { canonicalJson, deepFreeze, exactDigest, exactIso, fail, identifier, rejectPrivateReasoning, sha256 } from "./utils.js";

const FAILURE_CODES = new Set<VerifierFailureCode>([
  "verifier_false_positive", "verifier_false_negative", "verifier_misrank", "verifier_uncalibrated",
  "criteria_failure", "evidence_missing", "correlated_failure", "api_failure", "logprob_failure",
  "cache_failure", "cost_excessive", "latency_excessive",
]);

export function verifyVerifierTelemetry(input: VerifierTelemetry): VerifierTelemetry {
  rejectPrivateReasoning(input);
  const telemetry = structuredClone(input);
  if (telemetry.schemaVersion !== "2026-08-17.telemetry.v1" || telemetry.softSignalOnly !== true) fail("verifier_telemetry_schema_invalid");
  identifier(telemetry.telemetryId, "verifier_telemetry_id_invalid");
  identifier(telemetry.verificationAttemptId, "verifier_attempt_id_invalid");
  identifier(telemetry.tenantId, "verifier_tenant_id_invalid");
  identifier(telemetry.missionId, "verifier_mission_id_invalid");
  identifier(telemetry.taskId, "verifier_task_id_invalid");
  exactDigest(telemetry.evidencePackDigest, "verifier_evidence_digest_invalid");
  exactIso(telemetry.observedAt, "verifier_observed_at_invalid");
  exactDigest(telemetry.telemetryDigest, "verifier_telemetry_digest_invalid");
  if (telemetry.failureCode !== null && !FAILURE_CODES.has(telemetry.failureCode)) fail("verifier_telemetry_failure_invalid");
  if (!["off", "offline", "shadow", "advisory", "selective", "automated"].includes(telemetry.rolloutMode)) fail("verifier_telemetry_rollout_invalid");
  if (["off", "offline", "shadow", "advisory"].includes(telemetry.rolloutMode) && telemetry.behaviorChanged) fail("verifier_telemetry_behavior_invalid");
  if (telemetry.behaviorChanged && telemetry.effectiveCandidateId === telemetry.incumbentCandidateId) fail("verifier_telemetry_behavior_invalid");
  if (!telemetry.behaviorChanged && telemetry.effectiveCandidateId !== telemetry.incumbentCandidateId) fail("verifier_telemetry_behavior_invalid");
  const eligible = new Set(telemetry.eligibleCandidateIds);
  if (eligible.size !== telemetry.eligibleCandidateIds.length) fail("verifier_telemetry_candidates_invalid");
  if (telemetry.suggestedCandidateId !== null && !eligible.has(telemetry.suggestedCandidateId)) fail("verifier_telemetry_suggestion_invalid");
  for (const [candidateId, score] of Object.entries(telemetry.candidateScores)) {
    if (!eligible.has(candidateId) || !Number.isFinite(score) || score < 0 || score > 1) fail("verifier_telemetry_score_invalid");
  }
  if (!Number.isFinite(telemetry.recognizedProbabilityMassFloor) || telemetry.recognizedProbabilityMassFloor < 0 || telemetry.recognizedProbabilityMassFloor > 1) {
    fail("verifier_telemetry_recognized_mass_floor_invalid");
  }
  // The recognized mass is a sum of per-token probabilities that reward
  // decoding only guarantees to be finite and non-negative (degenerate or mock
  // logprob distributions can push it above 1), so it is not bounded above
  // here. The floor it is compared against is what is constrained to [0, 1].
  if (telemetry.recognizedProbabilityMass !== null &&
    (!Number.isFinite(telemetry.recognizedProbabilityMass) || telemetry.recognizedProbabilityMass < 0)) {
    fail("verifier_telemetry_recognized_mass_invalid");
  }
  if (typeof telemetry.recognizedProbabilityMassBelowFloor !== "boolean") fail("verifier_telemetry_recognized_mass_flag_invalid");
  if (telemetry.scoreEvidenceDigests.some((digest) => !/^sha256:[a-f0-9]{64}$/.test(digest))) fail("verifier_telemetry_score_evidence_invalid");
  const { telemetryDigest, ...base } = telemetry;
  if (sha256(canonicalJson(base)) !== telemetryDigest) fail("verifier_telemetry_digest_mismatch");
  return deepFreeze(telemetry);
}
