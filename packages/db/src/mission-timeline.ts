import type { AppDb } from "./index.js";
import type { DomainEventRow } from "./schema.js";
import { listDomainEvents, verifyDomainEventIntegrity } from "./trust.js";
import { one } from "./mission-record-content.js";

// Mission timeline (task brief §1). This is a PROJECTION, not a new store.
//
// A mission's meaningful history is already recorded: every mission lifecycle
// write appends a hash-chained `domain_events` row under aggregate_type
// 'mission' / aggregate_id = missionId — creation, each state transition (a
// stage completing), scope binding (graph snapshot linked), campaign linkage,
// and — through the sibling durable-record writers — decisions recorded and
// superseded (a human resolving an ambiguity, a plan approved), exceptions
// opened/resolved/withdrawn (an exception created and cleared), verification
// results, and artifact registration and lineage. So the durable timeline
// already exists; only a reader was missing. Building a second event log beside
// `domain_events` would be strictly worse, so this file adds no table.
//
// The events are meaningful by construction: only lifecycle-significant writes
// emit a `domain_events` row. This reader neither invents entries nor collapses
// every state read into one — it surfaces exactly what was recorded, in the
// tenant's append-only sequence order.

// Fail-closed contract. The domain-event log is hash-chained PER TENANT (a
// mission's events are a subsequence of the tenant chain), so integrity can only
// be judged over the whole tenant chain. Three states are kept distinct and
// never collapsed — the repo's signature defect is a two-valued type asked to
// carry three states, and a timeline is exactly where "could not read" must not
// masquerade as "clean and empty", nor a tampered chain as an ordered history:
//
//   - "ok"           -> the tenant chain verified; `entries` is authoritative,
//                       in order. An empty `entries` with `missionExists=false`
//                       means "nothing recorded", which is distinct from...
//   - "chain_broken" -> the hash chain failed verification. NO entries are
//                       returned: a caller cannot render broken data as a clean
//                       timeline, because there is no clean data to render.
//   - "unreadable"   -> the events could not be read at all (e.g. a store
//                       error). Distinct from "nothing recorded".
export type MissionTimelineEntry = Readonly<{
  sequence: number;
  eventId: string;
  eventType: string;
  actorPrincipalId: string;
  correlationId: string;
  causationId: string | null;
  payload: unknown;
  payloadSha256: string;
  eventHash: string;
  createdAt: string;
}>;

export type MissionTimeline =
  | Readonly<{
      status: "ok";
      tenantId: string;
      missionId: string;
      missionExists: boolean;
      entries: readonly MissionTimelineEntry[];
      eventCount: number;
      integrity: Readonly<{ verified: true; checked: number }>;
    }>
  | Readonly<{
      status: "chain_broken";
      tenantId: string;
      missionId: string;
      // Deliberately no `entries`: a failed chain has no authoritative history to
      // present. `checked` is how far the tenant chain verified before failing;
      // `error` names the first offending event.
      integrity: Readonly<{ verified: false; checked: number; error: string }>;
    }>
  | Readonly<{
      status: "unreadable";
      tenantId: string;
      missionId: string;
      reason: string;
    }>;

function toEntry(row: DomainEventRow): MissionTimelineEntry {
  return Object.freeze({
    sequence: row.event_sequence,
    eventId: row.id,
    eventType: row.event_type,
    actorPrincipalId: row.actor_principal_id,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    // The payload was hash-chained at write; we surface it as recorded. Parsing
    // is inside the try/catch below, so a corrupt row falls to "unreadable"
    // rather than throwing out of the reader.
    payload: JSON.parse(row.payload_json),
    payloadSha256: row.payload_sha256,
    eventHash: row.event_hash,
    createdAt: row.created_at,
  });
}

/**
 * Project a mission's durable timeline out of the hash-chained domain-event log.
 *
 * Order: entries are returned in the tenant's append-only `event_sequence`
 * order, which is the true happened-before order of the recorded events.
 *
 * Integrity: the whole tenant chain is verified. If it fails ANYWHERE, the
 * result is `chain_broken` with no entries — never a rendered timeline. This is
 * intentionally conservative: a break in an unrelated later region still flags
 * the mission, because a compromised append-only log cannot certify any
 * projection drawn from it. Over-reporting broken is safe; under-reporting is
 * the defect this guards against.
 *
 * Tenant isolation is structural: `listDomainEvents` filters on `tenant_id`, and
 * the mission-existence probe is tenant-scoped, so a mission id from another
 * tenant resolves to an empty, non-existent timeline rather than leaking events.
 */
export function readMissionTimeline(db: AppDb, tenantId: string, missionId: string): MissionTimeline {
  try {
    // Verify BEFORE trusting any row. A broken chain short-circuits to
    // chain_broken with no entries.
    const integrity = verifyDomainEventIntegrity(db, tenantId);
    if (!integrity.ok) {
      return Object.freeze({
        status: "chain_broken" as const,
        tenantId,
        missionId,
        integrity: Object.freeze({
          verified: false as const,
          checked: integrity.checked,
          error: integrity.error ?? "domain_event_integrity_failed",
        }),
      });
    }
    const missionExists = one<{ id: string }>(
      db,
      `SELECT id FROM mission WHERE id = ? AND tenant_id = ?`,
      [missionId, tenantId],
    ) !== undefined;
    const rows = listDomainEvents(db, tenantId, "mission", missionId);
    const entries = rows.map(toEntry);
    return Object.freeze({
      status: "ok" as const,
      tenantId,
      missionId,
      missionExists,
      entries: Object.freeze(entries),
      eventCount: entries.length,
      integrity: Object.freeze({ verified: true as const, checked: integrity.checked }),
    });
  } catch (error) {
    // Reading failed outright — distinct from "nothing recorded". Do not leak a
    // partial or fabricated timeline; report unreadable with the store's reason.
    return Object.freeze({
      status: "unreadable" as const,
      tenantId,
      missionId,
      reason: error instanceof Error ? error.message : "mission_timeline_unreadable",
    });
  }
}
