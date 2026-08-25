/**
 * Bind a Mission to a Policy Envelope at creation/launch (spec §6.7: "Every
 * Mission MUST reference a versioned Policy Envelope"). This is the orchestration
 * seam that the persistence primitives (`@mendpoint/db`) and the envelope type
 * (`@mendpoint/policy`) deliberately do not couple to each other: `db` keeps the
 * envelope body opaque, `policy` owns the shape and canonical serializer, and
 * this module — which already depends on both — composes them.
 *
 * A tenant that has not authored a stricter envelope inherits a permissive-but-
 * explicit default (`defaultPolicyEnvelope`): review-first and no auto-deploy/no
 * training by default, unrestricted repository/branch/tool/model scope. The
 * default is created once per tenant (idempotent, immutable version 1) and every
 * Mission pins that version set-once, so a later policy upgrade is explicit and
 * auditable rather than a silent rebind (spec §6.7).
 */
import {
  bindMissionToPolicyEnvelope,
  createPolicyEnvelope,
  getPolicyEnvelope,
  type AppDb,
  type Mission,
} from "@mendpoint/db";
import {
  canonicalPolicyEnvelopeJson,
  defaultPolicyEnvelope,
} from "@mendpoint/policy";
import { createHash } from "node:crypto";

/** Deterministic, tenant-scoped id for the default envelope. */
export function defaultPolicyEnvelopeId(tenantId: string): string {
  return `pe-default-${createHash("sha256").update(tenantId, "utf8").digest("hex").slice(0, 32)}`;
}

/** The canonical version a tenant's default envelope is persisted under. */
export const DEFAULT_POLICY_ENVELOPE_VERSION = 1;

/**
 * Ensure the tenant's default Policy Envelope exists (version 1, immutable) and
 * bind the given Mission to it set-once. Idempotent: repeated calls return the
 * mission unchanged once bound, and never rewrite the envelope. Returns the
 * (possibly already-bound) Mission.
 */
export function ensureDefaultPolicyEnvelopeBinding(db: AppDb, input: {
  tenantId: string;
  missionId: string;
  actorPrincipalId: string;
  correlationId: string;
  createdAt: string;
  residency?: string;
}): Mission {
  const version = DEFAULT_POLICY_ENVELOPE_VERSION;
  const policyEnvelopeId = defaultPolicyEnvelopeId(input.tenantId);
  if (!getPolicyEnvelope(db, input.tenantId, version)) {
    const envelope = defaultPolicyEnvelope({
      tenantId: input.tenantId,
      policyEnvelopeId,
      createdAt: input.createdAt,
      version,
      residency: input.residency,
    });
    createPolicyEnvelope(db, {
      tenantId: input.tenantId,
      version,
      policyEnvelopeId,
      envelopeJson: canonicalPolicyEnvelopeJson(envelope),
      createdAt: input.createdAt,
    });
  }
  return bindMissionToPolicyEnvelope(db, {
    tenantId: input.tenantId,
    missionId: input.missionId,
    version,
    actorPrincipalId: input.actorPrincipalId,
    eventId: `${input.missionId}-policy-envelope-bound`,
    idempotencyKey: `mission-policy-bind-${input.missionId}-v${version}`,
    correlationId: input.correlationId,
    createdAt: input.createdAt,
  });
}
