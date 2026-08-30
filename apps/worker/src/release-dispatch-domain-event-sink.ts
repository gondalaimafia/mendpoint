import { createHash } from "node:crypto";
import {
  appendDomainEvent,
  getPrincipal,
  insertPrincipal,
  verifyDomainEventRecordIntegrity,
  type AppDb,
  type DomainEventRow,
} from "@mendpoint/db";

export const RELEASE_DISPATCH_CONTRACT_VERSION = "catalog.release-dispatch.v1" as const;
export const RELEASE_DISPATCH_EVENT_TYPE = "catalog.release_dispatch.accepted" as const;
export const RELEASE_DISPATCH_AGGREGATE_TYPE = "catalog_release_dispatch" as const;

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PAYLOAD_KEYS = Object.freeze([
  "artifactContentSha256",
  "artifactId",
  "contractVersion",
  "dispatchId",
  "tenantId",
] as const);

export const RELEASE_DISPATCH_SINK_FAILURE_CODES = Object.freeze({
  authorityInvalid: "release_dispatch_authority_invalid",
  validationFailed: "release_dispatch_validation_failed",
  idempotencyConflict: "release_dispatch_idempotency_conflict",
  infrastructureUnavailable: "release_dispatch_infrastructure_unavailable",
  internalFailure: "release_dispatch_internal_failure",
} as const);

export type ReleaseDispatchSinkFailureCode =
  typeof RELEASE_DISPATCH_SINK_FAILURE_CODES[keyof typeof RELEASE_DISPATCH_SINK_FAILURE_CODES];

export type ReleaseDispatchEnvelope = Readonly<{
  contractVersion: typeof RELEASE_DISPATCH_CONTRACT_VERSION;
  tenantId: string;
  dispatchId: string;
  artifactId: string;
  artifactContentSha256: string;
}>;

export type ReleaseDispatchSinkError = Error & Readonly<{
  code: ReleaseDispatchSinkFailureCode;
  retryable: boolean;
}>;

function sinkError(code: ReleaseDispatchSinkFailureCode, retryable: boolean): ReleaseDispatchSinkError {
  return Object.assign(new Error(code), { code, retryable });
}

function validTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function requireIdentifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw sinkError(RELEASE_DISPATCH_SINK_FAILURE_CODES.validationFailed, false);
  }
  return value;
}

export function parseReleaseDispatchEnvelope(value: unknown): ReleaseDispatchEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw sinkError(RELEASE_DISPATCH_SINK_FAILURE_CODES.validationFailed, false);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== PAYLOAD_KEYS.length || keys.some((key, index) => key !== PAYLOAD_KEYS[index])) {
    throw sinkError(RELEASE_DISPATCH_SINK_FAILURE_CODES.validationFailed, false);
  }
  if (record.contractVersion !== RELEASE_DISPATCH_CONTRACT_VERSION) {
    throw sinkError(RELEASE_DISPATCH_SINK_FAILURE_CODES.validationFailed, false);
  }
  const artifactContentSha256 = typeof record.artifactContentSha256 === "string"
    ? record.artifactContentSha256
    : "";
  if (!SHA256.test(artifactContentSha256)) {
    throw sinkError(RELEASE_DISPATCH_SINK_FAILURE_CODES.validationFailed, false);
  }
  return Object.freeze({
    contractVersion: RELEASE_DISPATCH_CONTRACT_VERSION,
    tenantId: requireIdentifier(record.tenantId),
    dispatchId: requireIdentifier(record.dispatchId),
    artifactId: requireIdentifier(record.artifactId),
    artifactContentSha256,
  });
}

export function assertActiveReleaseDispatchPrincipal(input: Readonly<{
  db: AppDb;
  tenantId: string;
  actorPrincipalId: string;
  observedAt: string;
}>): void {
  const tenantId = requireIdentifier(input.tenantId);
  const actorPrincipalId = requireIdentifier(input.actorPrincipalId);
  if (!validTimestamp(input.observedAt)) {
    throw sinkError(RELEASE_DISPATCH_SINK_FAILURE_CODES.validationFailed, false);
  }
  let principal;
  try {
    principal = getPrincipal(input.db, tenantId, actorPrincipalId);
  } catch {
    throw sinkError(RELEASE_DISPATCH_SINK_FAILURE_CODES.infrastructureUnavailable, true);
  }
  const observedAt = Date.parse(input.observedAt);
  const createdAt = principal ? Date.parse(principal.created_at) : Number.NaN;
  const revokedAt = principal?.revoked_at ? Date.parse(principal.revoked_at) : null;
  const expiresAt = principal?.expires_at ? Date.parse(principal.expires_at) : null;
  if (
    !principal || principal.kind !== "service" || principal.subject !== "release-dispatch" ||
    principal.display_name !== "Release dispatch worker" ||
    !Number.isFinite(createdAt) || createdAt > observedAt ||
    (revokedAt !== null && (!Number.isFinite(revokedAt) || revokedAt <= observedAt)) ||
    (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= observedAt))
  ) {
    throw sinkError(RELEASE_DISPATCH_SINK_FAILURE_CODES.authorityInvalid, false);
  }
}

export function ensureReleaseDispatchPrincipal(input: Readonly<{
  db: AppDb;
  tenantId: string;
  actorPrincipalId: string;
  observedAt: string;
}>): void {
  const tenantId = requireIdentifier(input.tenantId);
  const actorPrincipalId = requireIdentifier(input.actorPrincipalId);
  if (!validTimestamp(input.observedAt)) {
    throw sinkError(RELEASE_DISPATCH_SINK_FAILURE_CODES.validationFailed, false);
  }
  try {
    const existing = getPrincipal(input.db, tenantId, actorPrincipalId);
    const principal = existing ?? insertPrincipal(input.db, {
        id: actorPrincipalId,
        tenantId,
        kind: "service",
        subject: "release-dispatch",
        displayName: "Release dispatch worker",
        createdAt: input.observedAt,
      });
    if (
      principal.id !== actorPrincipalId ||
      principal.tenant_id !== tenantId ||
      principal.kind !== "service" ||
      principal.subject !== "release-dispatch" ||
      principal.display_name !== "Release dispatch worker"
    ) {
      throw sinkError(RELEASE_DISPATCH_SINK_FAILURE_CODES.authorityInvalid, false);
    }
  } catch (error) {
    if ((error as ReleaseDispatchSinkError)?.code) throw error;
    if (error instanceof Error && error.message === "principal_identity_conflict") {
      throw sinkError(RELEASE_DISPATCH_SINK_FAILURE_CODES.authorityInvalid, false);
    }
    throw sinkError(RELEASE_DISPATCH_SINK_FAILURE_CODES.infrastructureUnavailable, true);
  }
  assertActiveReleaseDispatchPrincipal(input);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function eventId(envelope: ReleaseDispatchEnvelope): string {
  return `event_catalog_release_${sha256([
    envelope.tenantId,
    envelope.dispatchId,
    envelope.artifactId,
    envelope.artifactContentSha256,
  ].join("\0")).slice(0, 40)}`;
}

function assertReturnedEvent(input: Readonly<{
  row: DomainEventRow;
  envelope: ReleaseDispatchEnvelope;
  actorPrincipalId?: string;
  expectedEventId: string;
  expectedPayloadJson: string;
}>): void {
  const idempotencyKey = `catalog-release:${input.envelope.dispatchId}`;
  if (
    input.row.id !== input.expectedEventId ||
    input.row.tenant_id !== input.envelope.tenantId ||
    input.row.schema_version !== 1 ||
    input.row.event_type !== RELEASE_DISPATCH_EVENT_TYPE ||
    input.row.aggregate_type !== RELEASE_DISPATCH_AGGREGATE_TYPE ||
    input.row.aggregate_id !== input.envelope.dispatchId ||
    (input.actorPrincipalId !== undefined && input.row.actor_principal_id !== input.actorPrincipalId) ||
    input.row.correlation_id !== input.envelope.dispatchId ||
    input.row.causation_id !== input.envelope.artifactId ||
    input.row.idempotency_key !== idempotencyKey ||
    input.row.payload_json !== input.expectedPayloadJson ||
    input.row.payload_sha256 !== sha256(input.expectedPayloadJson)
  ) {
    throw sinkError(RELEASE_DISPATCH_SINK_FAILURE_CODES.idempotencyConflict, false);
  }
}

function existingReleaseDispatchEvent(input: Readonly<{
  db: AppDb;
  tenantId: string;
  idempotencyKey: string;
}>): DomainEventRow | null {
  return (input.db.raw.prepare(
    `SELECT * FROM domain_events WHERE tenant_id = ? AND idempotency_key = ?`,
  ).get(input.tenantId, input.idempotencyKey) as DomainEventRow | undefined) ?? null;
}

function assertExactReplay(input: Readonly<{
  db: AppDb;
  row: DomainEventRow;
  envelope: ReleaseDispatchEnvelope;
  actorPrincipalId: string;
  expectedEventId: string;
  expectedPayloadJson: string;
}>): void {
  assertReturnedEvent(input);
  const integrity = verifyDomainEventRecordIntegrity(
    input.db,
    input.envelope.tenantId,
    input.row.id,
  );
  if (!integrity.ok) {
    throw sinkError(RELEASE_DISPATCH_SINK_FAILURE_CODES.idempotencyConflict, false);
  }
  assertActiveReleaseDispatchPrincipal({
    db: input.db,
    tenantId: input.envelope.tenantId,
    actorPrincipalId: input.row.actor_principal_id,
    observedAt: input.row.created_at,
  });
}

export function acceptReleaseDispatchDomainEvent(input: Readonly<{
  db: AppDb;
  actorPrincipalId: string;
  envelope: unknown;
  observedAt: string;
}>): Readonly<{ eventId: string; inserted: boolean }> {
  const envelope = parseReleaseDispatchEnvelope(input.envelope);
  const actorPrincipalId = requireIdentifier(input.actorPrincipalId);
  assertActiveReleaseDispatchPrincipal({
    db: input.db,
    tenantId: envelope.tenantId,
    actorPrincipalId,
    observedAt: input.observedAt,
  });
  const expectedEventId = eventId(envelope);
  const expectedPayloadJson = JSON.stringify(envelope);
  const idempotencyKey = `catalog-release:${envelope.dispatchId}`;
  try {
    const existing = existingReleaseDispatchEvent({
      db: input.db,
      tenantId: envelope.tenantId,
      idempotencyKey,
    });
    if (existing) {
      assertExactReplay({
        db: input.db,
        row: existing,
        envelope,
        actorPrincipalId,
        expectedEventId,
        expectedPayloadJson,
      });
      return Object.freeze({ eventId: existing.id, inserted: false });
    }
    const appended = appendDomainEvent(input.db, {
      id: expectedEventId,
      tenantId: envelope.tenantId,
      schemaVersion: 1,
      eventType: RELEASE_DISPATCH_EVENT_TYPE,
      aggregateType: RELEASE_DISPATCH_AGGREGATE_TYPE,
      aggregateId: envelope.dispatchId,
      actorPrincipalId,
      correlationId: envelope.dispatchId,
      causationId: envelope.artifactId,
      idempotencyKey,
      payload: envelope,
      createdAt: input.observedAt,
    });
    assertReturnedEvent({
      row: appended.row,
      envelope,
      actorPrincipalId,
      expectedEventId,
      expectedPayloadJson,
    });
    return Object.freeze({ eventId: appended.row.id, inserted: appended.inserted });
  } catch (error) {
    if ((error as ReleaseDispatchSinkError)?.code) throw error;
    if (error instanceof Error && error.message === "domain_event_idempotency_conflict") {
      try {
        const raced = existingReleaseDispatchEvent({
          db: input.db,
          tenantId: envelope.tenantId,
          idempotencyKey,
        });
        if (!raced) {
          throw sinkError(RELEASE_DISPATCH_SINK_FAILURE_CODES.idempotencyConflict, false);
        }
        assertExactReplay({
          db: input.db,
          row: raced,
          envelope,
          actorPrincipalId,
          expectedEventId,
          expectedPayloadJson,
        });
        return Object.freeze({ eventId: raced.id, inserted: false });
      } catch (replayError) {
        if ((replayError as ReleaseDispatchSinkError)?.code) throw replayError;
        throw sinkError(RELEASE_DISPATCH_SINK_FAILURE_CODES.infrastructureUnavailable, true);
      }
    }
    throw sinkError(RELEASE_DISPATCH_SINK_FAILURE_CODES.infrastructureUnavailable, true);
  }
}
