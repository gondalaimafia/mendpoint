/**
 * Deterministic Policy Envelope enforcement for a Mission task (spec §6.7:
 * "A prompt reminder is not an authorization control"; §28.1.0: policy is
 * inherited AND enforced). This is the reusable authorization decision every task
 * dispatch seam calls before it runs a tool/model/edit: it loads the exact envelope
 * the Mission pinned (`getMissionPolicyEnvelope`), validates it (`parsePolicyEnvelope`),
 * and evaluates the concrete task against it (`evaluatePolicyEnvelope`).
 *
 * The result is a THREE-STATE decision so callers never conflate "allowed" with
 * "unenforced":
 *  - `{ status: "enforced", decision }` — an envelope was inherited and evaluated;
 *    `decision.allowed` is authoritative and `decision.violations` explain a deny.
 *  - `{ status: "no_envelope" }` — the Mission pinned no envelope (a legacy mission
 *    predating set-once binding at creation). The caller decides its own posture;
 *    this function does NOT silently allow.
 *  - `{ status: "envelope_invalid" }` — a pinned envelope row failed validation.
 *    Fail closed: a corrupt policy MUST NOT be treated as "allowed".
 *
 * Every decision that belongs to a real Mission is also appended as an immutable
 * evaluation fact (`recordMissionPolicyEvaluation`) so the envelope version used
 * for the decision is retained as evidence (ME-PEV-001).
 */
import {
  getMission,
  getMissionPolicyEnvelope,
  policyTaskDigest,
  recordMissionPolicyEvaluation,
  type AppDb,
} from "@mendpoint/db";
import {
  evaluatePolicyEnvelope,
  parsePolicyEnvelope,
  type PolicyTaskRequest,
} from "@mendpoint/policy";

// `@mendpoint/policy` exports two unrelated `PolicyDecision` types (the §8.18
// envelope decision and the warden PR-risk decision), so the re-exported name is
// ambiguous. Derive the envelope decision type from the evaluator directly.
export type EnvelopePolicyDecision = ReturnType<typeof evaluatePolicyEnvelope>;

export type MissionPolicyEnforcement =
  | Readonly<{ status: "enforced"; decision: EnvelopePolicyDecision; version: number }>
  | Readonly<{ status: "no_envelope" }>
  | Readonly<{ status: "envelope_invalid" }>;

/**
 * Evaluate a task against the Mission's inherited Policy Envelope. See the module
 * doc for the three-state contract. Performs one tenant-scoped read; the
 * evaluation itself is pure. Persistence is append-only and idempotent on the
 * content digest so a replay of the same decision does not duplicate the fact.
 */
export function evaluateMissionTaskPolicy(db: AppDb, input: {
  tenantId: string;
  missionId: string;
  task: PolicyTaskRequest;
  observedAt?: string;
}): MissionPolicyEnforcement {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const taskDigest = policyTaskDigest(input.task);
  const stored = getMissionPolicyEnvelope(db, input.tenantId, input.missionId);
  if (!stored) {
    const result = { status: "no_envelope" } as const;
    if (getMission(db, input.tenantId, input.missionId)) {
      recordMissionPolicyEvaluation(db, {
        tenantId: input.tenantId,
        missionId: input.missionId,
        envelopeVersion: null,
        status: "no_envelope",
        allowed: null,
        reviewRequired: null,
        violations: [],
        taskDigest,
        createdAt: observedAt,
      });
    }
    return result;
  }
  try {
    const envelope = parsePolicyEnvelope(JSON.parse(stored.envelopeJson));
    const decision = evaluatePolicyEnvelope(envelope, input.task);
    recordMissionPolicyEvaluation(db, {
      tenantId: input.tenantId,
      missionId: input.missionId,
      envelopeVersion: stored.version,
      status: "enforced",
      allowed: decision.allowed,
      reviewRequired: decision.reviewRequired,
      violations: decision.violations,
      taskDigest,
      createdAt: observedAt,
    });
    return { status: "enforced", decision, version: stored.version };
  } catch {
    recordMissionPolicyEvaluation(db, {
      tenantId: input.tenantId,
      missionId: input.missionId,
      envelopeVersion: stored.version,
      status: "envelope_invalid",
      allowed: null,
      reviewRequired: null,
      violations: [],
      taskDigest,
      createdAt: observedAt,
    });
    return { status: "envelope_invalid" };
  }
}

/**
 * Convenience guard for a dispatch seam that must fail closed: returns the
 * violation list when a task MUST be denied (an explicit deny, an invalid
 * envelope), or `null` when the task may proceed. A Mission with no envelope
 * returns `null` here (proceed) — callers that require an envelope should inspect
 * the three-state result directly instead.
 */
export function missionPolicyDenialReasons(enforcement: MissionPolicyEnforcement): readonly string[] | null {
  if (enforcement.status === "envelope_invalid") return ["policy_envelope_invalid"];
  if (enforcement.status === "enforced" && !enforcement.decision.allowed) {
    return enforcement.decision.violations.map((violation) => `${violation.code}:${violation.detail}`);
  }
  return null;
}
