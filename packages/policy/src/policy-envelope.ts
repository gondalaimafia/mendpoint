/**
 * Policy Envelope — the versioned, deterministically-enforced task-boundary
 * object every Mission task inherits (spec §6.7 and §8.18).
 *
 * This is COMPLEMENTARY to `warden-policy.ts`, not a duplicate of it: that module
 * resolves layered PR-edit *risk* policy with approval/waiver state, while this
 * module models the §8.18 Policy Envelope — the repository/tool/model/residency/
 * review/deployment/training boundaries a task must satisfy — and enforces it as
 * a pure, deterministic decision. Enforcement here is a code path, not a prompt
 * reminder (spec §6.7: "A prompt reminder is not an authorization control.").
 *
 * Allowlist semantics are explicit and documented so enforcement is predictable:
 * `repositoryScope`, `branchScope`, `allowedTools`, and `allowedModelClasses` are
 * ALLOWLISTS where an EMPTY list means "unrestricted on that dimension" (the
 * envelope author opts into a restriction by listing values), and a NON-EMPTY
 * list permits only its members. `forbiddenZones` is always a DENYLIST (empty =
 * nothing forbidden). The boolean and ceiling controls fail closed: a task that
 * requests external processing, deployment, training capture, an over-ceiling
 * risk, or a mismatched residency is denied unless the envelope permits it.
 */

export const POLICY_RISK_CLASSES = ["low", "medium", "high", "critical"] as const;
export type PolicyRiskClass = (typeof POLICY_RISK_CLASSES)[number];

const RISK_RANK: Readonly<Record<PolicyRiskClass, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
});

/** The §8.18 Policy Envelope. Immutable by (tenantId, version) once persisted. */
export interface PolicyEnvelope {
  readonly policyEnvelopeId: string;
  readonly tenantId: string;
  readonly version: number;
  /** Allowlist of repository ids; empty = unrestricted. */
  readonly repositoryScope: readonly string[];
  /** Allowlist of branch/environment names; empty = unrestricted. */
  readonly branchScope: readonly string[];
  /** Denylist of path prefixes that MUST NOT be edited; empty = none. */
  readonly forbiddenZones: readonly string[];
  /** Allowlist of tool ids; empty = unrestricted. */
  readonly allowedTools: readonly string[];
  /** Allowlist of model classes (e.g. deterministic, owned, rented_general); empty = unrestricted. */
  readonly allowedModelClasses: readonly string[];
  readonly externalProcessingAllowed: boolean;
  readonly residency: string;
  readonly riskCeiling: PolicyRiskClass;
  readonly reviewRequired: boolean;
  readonly deploymentAllowed: boolean;
  readonly trainingDataAllowed: boolean;
  /** Retention ceiling in days, or null for "policy/config governed elsewhere". */
  readonly retentionDays: number | null;
  readonly createdAt: string;
}

/** What a task wants to do; checked against the inherited envelope. */
export interface PolicyTaskRequest {
  readonly repositoryId: string;
  readonly branch: string;
  readonly targetPaths: readonly string[];
  readonly tool: string;
  readonly modelClass: string;
  readonly externalProcessing: boolean;
  readonly risk: PolicyRiskClass;
  readonly isDeployment: boolean;
  readonly wantsTrainingCapture: boolean;
  readonly residency: string;
}

export type PolicyViolationCode =
  | "repository_out_of_scope"
  | "branch_out_of_scope"
  | "forbidden_zone_edit"
  | "tool_not_allowed"
  | "model_class_not_allowed"
  | "external_processing_forbidden"
  | "risk_ceiling_exceeded"
  | "deployment_forbidden"
  | "training_capture_forbidden"
  | "residency_mismatch";

export interface PolicyViolation {
  readonly code: PolicyViolationCode;
  /** The offending value (path, tool id, branch, ...) when there is a single one. */
  readonly detail: string;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly violations: readonly PolicyViolation[];
  /** Echoed from the envelope so a caller can enforce human review downstream. */
  readonly reviewRequired: boolean;
}

function normalizePathSegment(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/g, "").replace(/^\/+/, "");
}

/** True when `path` is the zone itself or lives under it, on a path-segment boundary. */
export function pathUnderZone(path: string, zone: string): boolean {
  const p = normalizePathSegment(path);
  const z = normalizePathSegment(zone);
  if (z.length === 0) return false;
  return p === z || p.startsWith(`${z}/`);
}

/**
 * Deterministically evaluate a task against an inherited Policy Envelope.
 * Pure: identical inputs always produce identical, order-stable output. All
 * violations are collected (not short-circuited) so a reviewer sees every reason
 * a task was denied.
 */
export function evaluatePolicyEnvelope(
  envelope: PolicyEnvelope,
  task: PolicyTaskRequest,
): PolicyDecision {
  const violations: PolicyViolation[] = [];

  if (envelope.repositoryScope.length > 0 && !envelope.repositoryScope.includes(task.repositoryId)) {
    violations.push({ code: "repository_out_of_scope", detail: task.repositoryId });
  }
  if (envelope.branchScope.length > 0 && !envelope.branchScope.includes(task.branch)) {
    violations.push({ code: "branch_out_of_scope", detail: task.branch });
  }
  for (const path of [...task.targetPaths].sort()) {
    const zone = envelope.forbiddenZones.find((candidate) => pathUnderZone(path, candidate));
    if (zone !== undefined) {
      violations.push({ code: "forbidden_zone_edit", detail: path });
    }
  }
  if (envelope.allowedTools.length > 0 && !envelope.allowedTools.includes(task.tool)) {
    violations.push({ code: "tool_not_allowed", detail: task.tool });
  }
  if (envelope.allowedModelClasses.length > 0 && !envelope.allowedModelClasses.includes(task.modelClass)) {
    violations.push({ code: "model_class_not_allowed", detail: task.modelClass });
  }
  if (task.externalProcessing && !envelope.externalProcessingAllowed) {
    violations.push({ code: "external_processing_forbidden", detail: "external_processing" });
  }
  if (RISK_RANK[task.risk] > RISK_RANK[envelope.riskCeiling]) {
    violations.push({ code: "risk_ceiling_exceeded", detail: task.risk });
  }
  if (task.isDeployment && !envelope.deploymentAllowed) {
    violations.push({ code: "deployment_forbidden", detail: "deployment" });
  }
  if (task.wantsTrainingCapture && !envelope.trainingDataAllowed) {
    violations.push({ code: "training_capture_forbidden", detail: "training_capture" });
  }
  if (task.residency !== envelope.residency) {
    violations.push({ code: "residency_mismatch", detail: task.residency });
  }

  return Object.freeze({
    allowed: violations.length === 0,
    violations: Object.freeze(violations),
    reviewRequired: envelope.reviewRequired,
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validate and freeze an untrusted value (e.g. a JSON row read from storage) as a
 * PolicyEnvelope. Fails closed with a stable error rather than returning a
 * partially-typed object, so a corrupt or attacker-shaped row can never be
 * enforced as if it were a real envelope.
 */
export function parsePolicyEnvelope(value: unknown): PolicyEnvelope {
  if (typeof value !== "object" || value === null) throw new Error("policy_envelope_invalid");
  const raw = value as Record<string, unknown>;
  const str = (key: string): string => {
    const v = raw[key];
    if (typeof v !== "string" || v.trim().length === 0) throw new Error(`policy_envelope_${key}_invalid`);
    return v;
  };
  const list = (key: string): readonly string[] => {
    const v = raw[key];
    if (!isStringArray(v)) throw new Error(`policy_envelope_${key}_invalid`);
    return Object.freeze([...v]);
  };
  const bool = (key: string): boolean => {
    const v = raw[key];
    if (typeof v !== "boolean") throw new Error(`policy_envelope_${key}_invalid`);
    return v;
  };
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
    throw new Error("policy_envelope_version_invalid");
  }
  if (!POLICY_RISK_CLASSES.includes(raw.riskCeiling as PolicyRiskClass)) {
    throw new Error("policy_envelope_riskCeiling_invalid");
  }
  if (raw.retentionDays !== null && (typeof raw.retentionDays !== "number" || raw.retentionDays < 0)) {
    throw new Error("policy_envelope_retentionDays_invalid");
  }
  return Object.freeze({
    policyEnvelopeId: str("policyEnvelopeId"),
    tenantId: str("tenantId"),
    version: raw.version,
    repositoryScope: list("repositoryScope"),
    branchScope: list("branchScope"),
    forbiddenZones: list("forbiddenZones"),
    allowedTools: list("allowedTools"),
    allowedModelClasses: list("allowedModelClasses"),
    externalProcessingAllowed: bool("externalProcessingAllowed"),
    residency: str("residency"),
    riskCeiling: raw.riskCeiling as PolicyRiskClass,
    reviewRequired: bool("reviewRequired"),
    deploymentAllowed: bool("deploymentAllowed"),
    trainingDataAllowed: bool("trainingDataAllowed"),
    retentionDays: (raw.retentionDays as number | null) ?? null,
    createdAt: str("createdAt"),
  });
}

/** Canonical JSON with sorted keys, so an envelope's stored text is stable. */
export function canonicalPolicyEnvelopeJson(envelope: PolicyEnvelope): string {
  return JSON.stringify({
    allowedModelClasses: [...envelope.allowedModelClasses],
    allowedTools: [...envelope.allowedTools],
    branchScope: [...envelope.branchScope],
    createdAt: envelope.createdAt,
    deploymentAllowed: envelope.deploymentAllowed,
    externalProcessingAllowed: envelope.externalProcessingAllowed,
    forbiddenZones: [...envelope.forbiddenZones],
    policyEnvelopeId: envelope.policyEnvelopeId,
    repositoryScope: [...envelope.repositoryScope],
    residency: envelope.residency,
    retentionDays: envelope.retentionDays,
    reviewRequired: envelope.reviewRequired,
    riskCeiling: envelope.riskCeiling,
    tenantId: envelope.tenantId,
    trainingDataAllowed: envelope.trainingDataAllowed,
    version: envelope.version,
  });
}
