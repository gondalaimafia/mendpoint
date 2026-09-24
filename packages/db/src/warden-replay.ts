import { createHash } from "node:crypto";
import type { AppDb } from "./index.js";
import {
  appendDomainEvent,
  listDomainEvents,
  verifyDomainEventIntegrity,
} from "./trust.js";
import type { DomainEventRow } from "./schema.js";

export const WARDEN_RUN_EVENT_KINDS = [
  "run_started",
  "artifact_ingested",
  "analysis_completed",
  "candidate_generated",
  "verification_completed",
  "policy_enforced",
  "review_recorded",
  "delivery_attempted",
  "run_completed",
  "run_failed",
] as const;

export type WardenRunEventKind = (typeof WARDEN_RUN_EVENT_KINDS)[number];

export type WardenRunVersionReference = Readonly<{
  kind: "model" | "recipe" | "tool" | "policy";
  id: string;
  version: string;
}>;

export type WardenRunArtifactReference = Readonly<{
  id: string;
  kind: string;
  sha256: string;
  storageRef: string;
}>;

export type WardenRunCost = Readonly<{
  currency: string;
  amountMicros: number;
  inputTokens: number;
  outputTokens: number;
  computeMs: number;
}>;

export type WardenRunReplayEnvelope = Readonly<{
  envelopeVersion: 1;
  eventId: string;
  tenantId: string;
  runId: string;
  eventKind: WardenRunEventKind;
  actorPrincipalId: string;
  correlationId: string;
  causationId: string | null;
  occurredAt: string;
  inputSha256: string;
  outputSha256: string;
  versions: readonly WardenRunVersionReference[];
  cost: WardenRunCost;
  artifacts: readonly WardenRunArtifactReference[];
  deterministic: Readonly<{
    eligible: boolean;
    replayKey: string | null;
    stateBeforeSha256: string;
    stateAfterSha256: string;
  }>;
  metadata: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type WardenRunReplayEvidence = Readonly<{
  tenantId: string;
  runId: string;
  correlationId: string;
  eventCount: number;
  eventIds: readonly string[];
  firstEventHash: string;
  lastEventHash: string;
  replaySha256: string;
  deterministicReplayEligible: boolean;
  versions: readonly WardenRunVersionReference[];
  artifacts: readonly WardenRunArtifactReference[];
  cost: WardenRunCost;
  integrity: Readonly<{ ok: true; checkedTenantEvents: number }>;
}>;

const SHA256 = /^[0-9a-f]{64}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    throw new Error(`warden_replay_${field}_required`);
  }
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("warden_replay_number_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("warden_replay_value_invalid");
}

function validateCost(cost: WardenRunCost): void {
  requiredText(cost.currency, "cost_currency");
  for (const [field, value] of Object.entries({
    amount_micros: cost.amountMicros,
    input_tokens: cost.inputTokens,
    output_tokens: cost.outputTokens,
    compute_ms: cost.computeMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`warden_replay_cost_${field}_invalid`);
    }
  }
}

function validateEnvelope(envelope: WardenRunReplayEnvelope): void {
  if (envelope.envelopeVersion !== 1) throw new Error("warden_replay_version_invalid");
  requiredText(envelope.eventId, "event_id");
  requiredText(envelope.tenantId, "tenant_id");
  requiredText(envelope.runId, "run_id");
  if (!WARDEN_RUN_EVENT_KINDS.includes(envelope.eventKind)) {
    throw new Error("warden_replay_event_kind_invalid");
  }
  requiredText(envelope.correlationId, "correlation_id");
  requiredText(envelope.actorPrincipalId, "actor_principal_id");
  if (
    !CANONICAL_TIMESTAMP.test(envelope.occurredAt) ||
    !Number.isFinite(Date.parse(envelope.occurredAt)) ||
    new Date(Date.parse(envelope.occurredAt)).toISOString() !== envelope.occurredAt
  ) throw new Error("warden_replay_occurred_at_invalid");
  if (!SHA256.test(envelope.inputSha256) || !SHA256.test(envelope.outputSha256)) {
    throw new Error("warden_replay_io_hash_invalid");
  }
  if (!Array.isArray(envelope.versions) || envelope.versions.length === 0) {
    throw new Error("warden_replay_versions_required");
  }
  const versionKeys = new Set<string>();
  for (const version of envelope.versions) {
    if (!new Set(["model", "recipe", "tool", "policy"]).has(version.kind)) {
      throw new Error("warden_replay_version_kind_invalid");
    }
    requiredText(version.id, "version_id");
    requiredText(version.version, "version_value");
    const key = `${version.kind}:${version.id}`;
    if (versionKeys.has(key)) throw new Error("warden_replay_version_duplicate");
    versionKeys.add(key);
  }
  validateCost(envelope.cost);
  const artifactIds = new Set<string>();
  for (const artifact of envelope.artifacts) {
    requiredText(artifact.id, "artifact_id");
    requiredText(artifact.kind, "artifact_kind");
    requiredText(artifact.storageRef, "artifact_storage_ref");
    if (!SHA256.test(artifact.sha256)) throw new Error("warden_replay_artifact_hash_invalid");
    if (artifactIds.has(artifact.id)) throw new Error("warden_replay_artifact_duplicate");
    artifactIds.add(artifact.id);
  }
  if (
    !SHA256.test(envelope.deterministic.stateBeforeSha256) ||
    !SHA256.test(envelope.deterministic.stateAfterSha256)
  ) throw new Error("warden_replay_state_hash_invalid");
  if (envelope.deterministic.eligible) {
    requiredText(envelope.deterministic.replayKey ?? "", "replay_key");
  } else if (envelope.deterministic.replayKey !== null) {
    throw new Error("warden_replay_key_unexpected");
  }
  canonicalJson(envelope.metadata);
}

function assertArtifactBindings(
  db: AppDb,
  tenantId: string,
  artifacts: readonly WardenRunArtifactReference[],
): void {
  const query = db.raw.prepare(
    `SELECT kind, sha256, storage_ref FROM artifact_manifests WHERE tenant_id = ? AND id = ?`,
  );
  for (const artifact of artifacts) {
    const row = query.get(tenantId, artifact.id) as {
      kind: string;
      sha256: string;
      storage_ref: string;
    } | undefined;
    if (!row) throw new Error("warden_replay_artifact_not_found");
    if (
      row.kind !== artifact.kind ||
      row.sha256 !== artifact.sha256 ||
      row.storage_ref !== artifact.storageRef
    ) throw new Error("warden_replay_artifact_binding_mismatch");
  }
}

function runRows(db: AppDb, tenantId: string, runId: string): DomainEventRow[] {
  return listDomainEvents(db, tenantId, "warden_run", runId);
}

export function appendWardenRunEvent(
  db: AppDb,
  input: {
    tenantId: string;
    actorPrincipalId: string;
    idempotencyKey: string;
    createdAt: string;
    envelope: WardenRunReplayEnvelope;
  },
): { envelope: WardenRunReplayEnvelope; inserted: boolean; eventHash: string } {
  validateEnvelope(input.envelope);
  requiredText(input.idempotencyKey, "idempotency_key");
  if (
    input.envelope.tenantId !== input.tenantId ||
    input.envelope.actorPrincipalId !== input.actorPrincipalId ||
    input.envelope.occurredAt !== input.createdAt
  ) throw new Error("warden_replay_request_binding_invalid");
  assertArtifactBindings(db, input.tenantId, input.envelope.artifacts);
  const previous = runRows(db, input.tenantId, input.envelope.runId);
  const exactReplay = previous.some((event) =>
    event.id === input.envelope.eventId && event.idempotency_key === input.idempotencyKey);
  if (previous.length > 0 && !exactReplay) {
    const first = JSON.parse(previous[0]!.payload_json) as WardenRunReplayEnvelope;
    if (first.correlationId !== input.envelope.correlationId) {
      throw new Error("warden_replay_correlation_mismatch");
    }
  }
  if (!exactReplay && input.envelope.causationId !== null) {
    if (!previous.some((event) => event.id === input.envelope.causationId)) {
      throw new Error("warden_replay_causation_not_found");
    }
  } else if (!exactReplay && previous.length > 0) {
    throw new Error("warden_replay_causation_required");
  }
  const appended = appendDomainEvent(db, {
    id: input.envelope.eventId,
    tenantId: input.tenantId,
    schemaVersion: input.envelope.envelopeVersion,
    eventType: `warden.run.${input.envelope.eventKind}`,
    aggregateType: "warden_run",
    aggregateId: input.envelope.runId,
    actorPrincipalId: input.actorPrincipalId,
    correlationId: input.envelope.correlationId,
    causationId: input.envelope.causationId,
    idempotencyKey: input.idempotencyKey,
    payload: input.envelope,
    createdAt: input.createdAt,
  });
  return {
    envelope: Object.freeze(structuredClone(input.envelope)),
    inserted: appended.inserted,
    eventHash: appended.row.event_hash,
  };
}

/**
 * Where a fresh invocation of a run must continue from so that a retry never
 * reuses a previous attempt's identifiers.
 *
 * A run is one append-only causal chain: each execution attempt appends
 * `run_started` ... (`run_completed` | `run_failed`). Restarting the per-run
 * sequence at 0 on every attempt collides attempt N's events with attempt N-1's
 * at the same sequence number (two events at `:2:`, a `run_failed` and a
 * `run_completed` in the one run) and raises `domain_event_idempotency_conflict`
 * when two attempts fail before the same sequence with different payloads.
 *
 * `sequence`/`causationId`/`stateSha256` resume the envelope chain from the LAST
 * TERMINAL event (`run_completed` / `run_failed`) — the boundary of the last
 * COMPLETED attempt (0 / null / null when none). `attempt` is the number of
 * COMPLETED (terminal) attempts so far, NOT the count of invocations; callers
 * scope the run's OTHER per-attempt idempotency keys (the target transition
 * events, which are keyed by run id, not by sequence) with it so attempt N's
 * transitions never conflict with attempt N-1's.
 *
 * Which invocations re-enter the executor and hit this resume point:
 * - A crash BEFORE the `queued -> analyzing` transition leaves the target
 *   `queued` with only `run_started` committed (no terminal). The resume point
 *   is unchanged, so the replay re-appends that `run_started` byte-identically.
 * - A crash AFTER the transition leaves the target at its stage (`analyzing` /
 *   `editing` / `verifying`) with no terminal. `claimReadyWardenTargets` only
 *   picks `queued`, so that target is NOT retried today (pre-existing; see #676)
 *   and never reaches this function again.
 *
 * If #676 adds a requeue path for such a stranded target, it MUST first advance
 * `attempt` for the abandoned invocation — e.g. record a terminal `run_failed`
 * (or an abandoned) event for it — before the successor runs. Otherwise the
 * successor sees the same `attempt` and its `${runId}:${attempt}:target:*` keys
 * collide with the crashed invocation's transitions.
 */
export function wardenRunResumePoint(
  db: AppDb,
  tenantId: string,
  runId: string,
): Readonly<{ attempt: number; sequence: number; causationId: string | null; stateSha256: string | null }> {
  const rows = runRows(db, tenantId, runId);
  let attempt = 0;
  let last: Readonly<{ sequence: number; causationId: string; stateSha256: string }> | null = null;
  for (const row of rows) {
    if (row.event_type !== "warden.run.run_completed" && row.event_type !== "warden.run.run_failed") {
      continue;
    }
    attempt += 1;
    const envelope = JSON.parse(row.payload_json) as WardenRunReplayEnvelope;
    const sequence = envelope.metadata.sequence;
    if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 1) {
      throw new Error("warden_replay_resume_sequence_invalid");
    }
    if (!SHA256.test(envelope.outputSha256)) throw new Error("warden_replay_resume_state_invalid");
    last = { sequence, causationId: row.id, stateSha256: envelope.outputSha256 };
  }
  return Object.freeze({
    attempt,
    sequence: last?.sequence ?? 0,
    causationId: last?.causationId ?? null,
    stateSha256: last?.stateSha256 ?? null,
  });
}

export function replayWardenRun(
  db: AppDb,
  tenantId: string,
  runId: string,
  expectedReplaySha256?: string,
): WardenRunReplayEvidence {
  const integrity = verifyDomainEventIntegrity(db, tenantId);
  if (!integrity.ok) throw new Error(`warden_replay_integrity_invalid:${integrity.error}`);
  const rows = runRows(db, tenantId, runId);
  if (rows.length === 0) throw new Error("warden_replay_run_not_found");
  const envelopes = rows.map((row) => {
    const envelope = JSON.parse(row.payload_json) as WardenRunReplayEnvelope;
    validateEnvelope(envelope);
    if (
      envelope.eventId !== row.id ||
      envelope.tenantId !== tenantId ||
      envelope.runId !== runId ||
      envelope.actorPrincipalId !== row.actor_principal_id ||
      envelope.correlationId !== row.correlation_id ||
      envelope.causationId !== row.causation_id ||
      envelope.occurredAt !== row.created_at
    ) throw new Error("warden_replay_envelope_binding_invalid");
    assertArtifactBindings(db, tenantId, envelope.artifacts);
    return envelope;
  });
  const correlationId = envelopes[0]!.correlationId;
  const seen = new Set<string>();
  for (const [index, envelope] of envelopes.entries()) {
    if (envelope.correlationId !== correlationId) throw new Error("warden_replay_correlation_mismatch");
    if (index === 0 && envelope.causationId !== null) throw new Error("warden_replay_initial_causation_invalid");
    if (index > 0 && (!envelope.causationId || !seen.has(envelope.causationId))) {
      throw new Error("warden_replay_causation_order_invalid");
    }
    seen.add(envelope.eventId);
  }
  const currencies = new Set(envelopes.map((envelope) => envelope.cost.currency));
  if (currencies.size !== 1) throw new Error("warden_replay_currency_mismatch");
  const versions = new Map<string, WardenRunVersionReference>();
  const artifacts = new Map<string, WardenRunArtifactReference>();
  let amountMicros = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let computeMs = 0;
  for (const envelope of envelopes) {
    for (const version of envelope.versions) versions.set(`${version.kind}:${version.id}:${version.version}`, version);
    for (const artifact of envelope.artifacts) artifacts.set(`${artifact.id}:${artifact.sha256}`, artifact);
    amountMicros += envelope.cost.amountMicros;
    inputTokens += envelope.cost.inputTokens;
    outputTokens += envelope.cost.outputTokens;
    computeMs += envelope.cost.computeMs;
  }
  const replaySha256 = digest(canonicalJson(rows.map((row) => ({
    id: row.id,
    payloadSha256: row.payload_sha256,
    eventHash: row.event_hash,
    previousHash: row.prev_hash,
  }))));
  if (expectedReplaySha256 && expectedReplaySha256 !== replaySha256) {
    throw new Error("warden_replay_expected_digest_mismatch");
  }
  return Object.freeze({
    tenantId,
    runId,
    correlationId,
    eventCount: rows.length,
    eventIds: Object.freeze(rows.map((row) => row.id)),
    firstEventHash: rows[0]!.event_hash,
    lastEventHash: rows.at(-1)!.event_hash,
    replaySha256,
    deterministicReplayEligible: envelopes.every((envelope) => envelope.deterministic.eligible),
    versions: Object.freeze([...versions.values()].sort((left, right) =>
      `${left.kind}:${left.id}:${left.version}`.localeCompare(`${right.kind}:${right.id}:${right.version}`))),
    artifacts: Object.freeze([...artifacts.values()].sort((left, right) => left.id.localeCompare(right.id))),
    cost: Object.freeze({
      currency: [...currencies][0]!, amountMicros, inputTokens, outputTokens, computeMs,
    }),
    integrity: Object.freeze({ ok: true as const, checkedTenantEvents: integrity.checked }),
  });
}
