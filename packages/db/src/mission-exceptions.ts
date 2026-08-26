import type { AppDb } from "./index.js";
import { appendDomainEvent } from "./trust.js";
import { revokePendingMissionMutationDispatches } from "./mission-mutation-dispatch-fence.js";
import {
  all,
  assertMissionScope,
  assertRecordPrincipal,
  boundedText,
  contentDigest,
  exactUtc,
  one,
} from "./mission-record-content.js";

// Mission exception register (task brief §2). Its purpose is precise: stop
// agents repeatedly rediscovering the SAME blocker. Examples: a service that
// cannot migrate yet, missing runtime evidence, a manual database dependency, an
// unsupported language, a legacy vendor library.
//
// This is distinct from the transformer control-plane `tf_exception_versions`
// store (packages/transformer/src/control-plane-store.ts): that store is
// campaign-scoped, lives in a SEPARATE SQLite database, exists only for
// ReGauge/Transformer campaigns, and carries only { code, message, unitId }. A
// Fettler mission has no transformer campaign, and a mission may raise an
// exception before any campaign is linked (every production mission row has null
// campaign links). A mission-scoped register must therefore live beside the
// mission in the main database and carry the governance fields the register
// needs (impact, owner, resolution path, blocking). See the PR body.
//
// The store is append-only. An exception's lifecycle is expressed as a chain: an
// OPEN exception is later RESOLVED or WITHDRAWN by a new superseding row, or
// RE-AFFIRMED against the current context. A resolved exception stops blocking.
// An exception raised against a snapshot that the mission has since moved past is
// STALE: it is surfaced for re-affirmation and does NOT silently keep blocking.

export type MissionExceptionStatus = "open" | "resolved" | "withdrawn";

// The register standing a reader acts on. `blocking` counts against the mission;
// `stale` does not (it needs re-affirmation against current context); resolved
// and withdrawn never block.
export type MissionExceptionStanding = "blocking" | "non_blocking_open" | "stale" | "resolved" | "withdrawn";

export type SnapshotIdentity = Readonly<{ snapshotId: string; resolvedSha: string }>;

export type MissionException = Readonly<{
  id: string;
  tenantId: string;
  missionId: string;
  reason: string;
  impact: string;
  ownerPrincipalId: string;
  resolutionPath: string;
  blocking: boolean;
  status: MissionExceptionStatus;
  observedSnapshotId: string | null;
  observedResolvedSha: string | null;
  supersedesId: string | null;
  contentDigest: string;
  createdAt: string;
  taskId: string | null;
  category: string | null;
}>;

export type MissionExceptionView = MissionException &
  Readonly<{ standing: MissionExceptionStanding; supersededById: string | null }>;

export type MissionExceptionEvaluation = Readonly<{
  missionBlocked: boolean;
  blocking: readonly MissionExceptionView[];
  stale: readonly MissionExceptionView[];
  nonBlockingOpen: readonly MissionExceptionView[];
  resolved: readonly MissionExceptionView[];
  withdrawn: readonly MissionExceptionView[];
}>;

type MissionExceptionRow = {
  id: string;
  tenant_id: string;
  mission_id: string;
  reason: string;
  impact: string;
  owner_principal_id: string;
  resolution_path: string;
  blocking: number;
  status: MissionExceptionStatus;
  observed_snapshot_id: string | null;
  observed_resolved_sha: string | null;
  supersedes_id: string | null;
  content_digest: string;
  created_at: string;
  task_id: string | null;
  category: string | null;
};

const MAX_REASON = 4_000;
const MAX_IMPACT = 4_000;
const MAX_RESOLUTION = 4_000;

export const MISSION_EXCEPTION_CATEGORIES = [
  "graph_incomplete",
  "high_risk_change",
  "ambiguous_requirement",
  "policy_exception",
  "verification_failure",
  "architecture_decision_required",
  "other",
] as const;
export type MissionExceptionCategory = (typeof MISSION_EXCEPTION_CATEGORIES)[number];
const EXCEPTION_CATEGORY_SET = new Set<string>(MISSION_EXCEPTION_CATEGORIES);

function normalizeExceptionCategory(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!EXCEPTION_CATEGORY_SET.has(value)) throw new Error("mission_exception_category_invalid");
  return value;
}
function normalizeTaskId(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  return boundedText(value, "mission_exception_task_id_invalid", 256);
}

function exceptionDigestBody(input: {
  tenantId: string;
  missionId: string;
  reason: string;
  impact: string;
  ownerPrincipalId: string;
  resolutionPath: string;
  blocking: boolean;
  status: MissionExceptionStatus;
  observedSnapshotId: string | null;
  observedResolvedSha: string | null;
  supersedesId: string | null;
  createdAt: string;
}) {
  return {
    kind: "mission_exception",
    schemaVersion: 1,
    tenantId: input.tenantId,
    missionId: input.missionId,
    reason: input.reason,
    impact: input.impact,
    ownerPrincipalId: input.ownerPrincipalId,
    resolutionPath: input.resolutionPath,
    blocking: input.blocking,
    status: input.status,
    observedSnapshotId: input.observedSnapshotId,
    observedResolvedSha: input.observedResolvedSha,
    supersedesId: input.supersedesId,
    createdAt: input.createdAt,
  };
}

function hydrate(row: MissionExceptionRow): MissionException {
  const body = exceptionDigestBody({
    tenantId: row.tenant_id,
    missionId: row.mission_id,
    reason: row.reason,
    impact: row.impact,
    ownerPrincipalId: row.owner_principal_id,
    resolutionPath: row.resolution_path,
    blocking: row.blocking === 1,
    status: row.status,
    observedSnapshotId: row.observed_snapshot_id,
    observedResolvedSha: row.observed_resolved_sha,
    supersedesId: row.supersedes_id,
    createdAt: row.created_at,
  });
  if (contentDigest(body) !== row.content_digest || row.content_digest !== row.id) {
    throw new Error("mission_exception_corrupt");
  }
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    missionId: row.mission_id,
    reason: row.reason,
    impact: row.impact,
    ownerPrincipalId: row.owner_principal_id,
    resolutionPath: row.resolution_path,
    blocking: row.blocking === 1,
    status: row.status,
    observedSnapshotId: row.observed_snapshot_id,
    observedResolvedSha: row.observed_resolved_sha,
    supersedesId: row.supersedes_id,
    contentDigest: row.content_digest,
    createdAt: row.created_at,
    taskId: row.task_id ?? null,
    category: row.category ?? null,
  });
}

// Resolve and validate an observed snapshot binding. The exception is bound to
// the exact repository_snapshots row and its resolved commit; we re-read the
// immutable snapshot and require the caller-supplied resolved_sha to match, so
// the binding is to a real snapshot, never a re-resolution of HEAD.
function resolveObservedSnapshot(db: AppDb, tenantId: string, binding: SnapshotIdentity): { snapshotId: string; resolvedSha: string } {
  const row = one<{ resolved_sha: string }>(db,
    `SELECT resolved_sha FROM repository_snapshots WHERE id = ? AND tenant_id = ?`,
    [binding.snapshotId, tenantId]);
  if (!row) throw new Error("mission_exception_snapshot_not_found");
  if (row.resolved_sha !== binding.resolvedSha) throw new Error("mission_exception_snapshot_binding_mismatch");
  return { snapshotId: binding.snapshotId, resolvedSha: binding.resolvedSha };
}

function insertException(db: AppDb, input: {
  tenantId: string;
  missionId: string;
  reason: string;
  impact: string;
  ownerPrincipalId: string;
  resolutionPath: string;
  blocking: boolean;
  status: MissionExceptionStatus;
  observedSnapshotId: string | null;
  observedResolvedSha: string | null;
  supersedesId: string | null;
  eventType: string;
  actorPrincipalId: string;
  correlationId: string;
  causationId?: string | null;
  createdAt: string;
  taskId?: string | null;
  category?: string | null;
}): MissionException {
  const body = exceptionDigestBody(input);
  const digest = contentDigest(body);
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = one<MissionExceptionRow>(db, `SELECT * FROM mission_exceptions WHERE id = ?`, [digest]);
    if (existing) {
      const value = hydrate(existing);
      if (owns) db.raw.exec("COMMIT");
      return value;
    }
    db.raw.prepare(`INSERT INTO mission_exceptions
      (id, tenant_id, mission_id, reason, impact, owner_principal_id, resolution_path, blocking,
       status, observed_snapshot_id, observed_resolved_sha, supersedes_id, content_digest, created_at,
       task_id, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      digest, input.tenantId, input.missionId, input.reason, input.impact, input.ownerPrincipalId,
      input.resolutionPath, input.blocking ? 1 : 0, input.status, input.observedSnapshotId,
      input.observedResolvedSha, input.supersedesId, digest, input.createdAt,
      normalizeTaskId(input.taskId), normalizeExceptionCategory(input.category));
    appendDomainEvent(db, {
      id: `mission-exception:${digest}`,
      tenantId: input.tenantId,
      schemaVersion: 1,
      eventType: input.eventType,
      aggregateType: "mission",
      aggregateId: input.missionId,
      actorPrincipalId: input.actorPrincipalId,
      correlationId: input.correlationId,
      causationId: input.causationId ?? null,
      idempotencyKey: `mission-exception:${digest}`,
      payload: {
        exceptionId: digest,
        status: input.status,
        blocking: input.blocking,
        supersedesId: input.supersedesId,
      },
      createdAt: input.createdAt,
    });
    const value = hydrate(one<MissionExceptionRow>(db, `SELECT * FROM mission_exceptions WHERE id = ?`, [digest])!);
    if (owns) db.raw.exec("COMMIT");
    return value;
  } catch (error) {
    if (owns) db.raw.exec("ROLLBACK");
    throw error;
  }
}

// Raise a new open exception. `resolutionPath` is required — an exception with no
// path to resolution is exactly the rediscovery hole this register exists to
// close. An optional `observedAgainst` binds the exception to a snapshot, making
// it go STALE (needing re-affirmation) once the mission moves past that
// snapshot; omitting it makes the exception context-independent, blocking until
// explicitly resolved or withdrawn.
export function raiseMissionException(db: AppDb, input: {
  tenantId: string;
  missionId: string;
  reason: string;
  impact: string;
  ownerPrincipalId: string;
  resolutionPath: string;
  blocking: boolean;
  observedAgainst?: SnapshotIdentity;
  correlationId: string;
  causationId?: string | null;
  createdAt: string;
  taskId?: string | null;
  category?: string | null;
}): MissionException {
  const reason = boundedText(input.reason, "mission_exception_reason_invalid", MAX_REASON);
  const impact = boundedText(input.impact, "mission_exception_impact_invalid", MAX_IMPACT);
  const resolutionPath = boundedText(input.resolutionPath, "mission_exception_resolution_invalid", MAX_RESOLUTION);
  const correlationId = boundedText(input.correlationId, "mission_exception_correlation_invalid", 256);
  const createdAt = exactUtc(input.createdAt, "mission_exception_created_at_invalid");
  if (typeof input.blocking !== "boolean") throw new Error("mission_exception_blocking_invalid");
  assertMissionScope(db, input.tenantId, input.missionId);
  assertRecordPrincipal(db, input.tenantId, input.ownerPrincipalId, "mission_exception_owner_tenant_mismatch");
  const bound = input.observedAgainst ? resolveObservedSnapshot(db, input.tenantId, input.observedAgainst) : null;
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    if (input.blocking) revokePendingMissionMutationDispatches(
      db, input.tenantId, input.missionId, createdAt,
    );
    const value = insertException(db, {
    tenantId: input.tenantId,
    missionId: input.missionId,
    reason,
    impact,
    ownerPrincipalId: input.ownerPrincipalId,
    resolutionPath,
    blocking: input.blocking,
    status: "open",
    observedSnapshotId: bound?.snapshotId ?? null,
    observedResolvedSha: bound?.resolvedSha ?? null,
    supersedesId: null,
    eventType: "mission.exception_raised",
    actorPrincipalId: input.ownerPrincipalId,
    correlationId,
    causationId: input.causationId ?? null,
    createdAt,
    taskId: input.taskId ?? null,
    category: input.category ?? null,
    });
    if (owns) db.raw.exec("COMMIT");
    return value;
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function loadHead(db: AppDb, tenantId: string, priorId: string): MissionExceptionRow {
  const prior = one<MissionExceptionRow>(db,
    `SELECT * FROM mission_exceptions WHERE id = ? AND tenant_id = ?`, [priorId, tenantId]);
  if (!prior) throw new Error("mission_exception_prior_not_found");
  const superseded = one<{ id: string }>(db,
    `SELECT id FROM mission_exceptions WHERE tenant_id = ? AND supersedes_id = ?`, [tenantId, priorId]);
  if (superseded) throw new Error("mission_exception_already_superseded");
  return prior;
}

function transition(db: AppDb, input: {
  tenantId: string;
  priorExceptionId: string;
  status: MissionExceptionStatus;
  blocking: boolean;
  observedSnapshotId: string | null;
  observedResolvedSha: string | null;
  eventType: string;
  actorPrincipalId: string;
  note?: string;
  correlationId: string;
  causationId?: string | null;
  createdAt: string;
}): MissionException {
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const prior = loadHead(db, input.tenantId, input.priorExceptionId);
    if (input.status === "open" && input.blocking) {
      revokePendingMissionMutationDispatches(
        db, input.tenantId, prior.mission_id, input.createdAt,
      );
    }
    // A resolution/withdrawal records the resolver's note on the resolution_path
    // so the chain carries how it was closed; a re-affirmation keeps the prior
    // resolution_path unchanged.
    const resolutionPath = input.note ?? prior.resolution_path;
    const value = insertException(db, {
      tenantId: input.tenantId,
      missionId: prior.mission_id,
      reason: prior.reason,
      impact: prior.impact,
      ownerPrincipalId: prior.owner_principal_id,
      resolutionPath,
      blocking: input.blocking,
      status: input.status,
      observedSnapshotId: input.observedSnapshotId,
      observedResolvedSha: input.observedResolvedSha,
      supersedesId: input.priorExceptionId,
      eventType: input.eventType,
      actorPrincipalId: input.actorPrincipalId,
      correlationId: input.correlationId,
      causationId: input.causationId ?? null,
      createdAt: input.createdAt,
      // Carry the annotation forward so a superseding head keeps its task and
      // category; without these the resolved head reads back as uncategorised.
      taskId: prior.task_id,
      category: prior.category,
    });
    if (owns) db.raw.exec("COMMIT");
    return value;
  } catch (error) {
    if (owns) db.raw.exec("ROLLBACK");
    throw error;
  }
}

// Resolve an exception. It stops blocking immediately and forever (a resolved
// row can no longer be superseded, and never counts as blocking).
export function resolveMissionException(db: AppDb, input: {
  tenantId: string;
  priorExceptionId: string;
  resolutionNote: string;
  actorPrincipalId: string;
  correlationId: string;
  causationId?: string | null;
  createdAt: string;
}): MissionException {
  const resolutionNote = boundedText(input.resolutionNote, "mission_exception_resolution_invalid", MAX_RESOLUTION);
  const correlationId = boundedText(input.correlationId, "mission_exception_correlation_invalid", 256);
  const createdAt = exactUtc(input.createdAt, "mission_exception_created_at_invalid");
  assertRecordPrincipal(db, input.tenantId, input.actorPrincipalId, "mission_exception_owner_tenant_mismatch");
  return transition(db, {
    tenantId: input.tenantId,
    priorExceptionId: input.priorExceptionId,
    status: "resolved",
    blocking: false,
    observedSnapshotId: null,
    observedResolvedSha: null,
    eventType: "mission.exception_resolved",
    actorPrincipalId: input.actorPrincipalId,
    note: resolutionNote,
    correlationId,
    causationId: input.causationId ?? null,
    createdAt,
  });
}

// Withdraw an exception that no longer applies (was never a real blocker, or the
// basis disappeared). It stops blocking and is not surfaced for re-affirmation.
export function withdrawMissionException(db: AppDb, input: {
  tenantId: string;
  priorExceptionId: string;
  rationale: string;
  actorPrincipalId: string;
  correlationId: string;
  causationId?: string | null;
  createdAt: string;
}): MissionException {
  const rationale = boundedText(input.rationale, "mission_exception_resolution_invalid", MAX_RESOLUTION);
  const correlationId = boundedText(input.correlationId, "mission_exception_correlation_invalid", 256);
  const createdAt = exactUtc(input.createdAt, "mission_exception_created_at_invalid");
  assertRecordPrincipal(db, input.tenantId, input.actorPrincipalId, "mission_exception_owner_tenant_mismatch");
  return transition(db, {
    tenantId: input.tenantId,
    priorExceptionId: input.priorExceptionId,
    status: "withdrawn",
    blocking: false,
    observedSnapshotId: null,
    observedResolvedSha: null,
    eventType: "mission.exception_withdrawn",
    actorPrincipalId: input.actorPrincipalId,
    note: rationale,
    correlationId,
    causationId: input.causationId ?? null,
    createdAt,
  });
}

// Re-affirm a stale exception against the current context. The prior (stale)
// exception is superseded by a fresh open exception bound to the current
// snapshot, so it blocks again — deliberately, not silently.
export function reaffirmMissionException(db: AppDb, input: {
  tenantId: string;
  priorExceptionId: string;
  blocking: boolean;
  observedAgainst: SnapshotIdentity;
  actorPrincipalId: string;
  correlationId: string;
  causationId?: string | null;
  createdAt: string;
}): MissionException {
  const correlationId = boundedText(input.correlationId, "mission_exception_correlation_invalid", 256);
  const createdAt = exactUtc(input.createdAt, "mission_exception_created_at_invalid");
  if (typeof input.blocking !== "boolean") throw new Error("mission_exception_blocking_invalid");
  assertRecordPrincipal(db, input.tenantId, input.actorPrincipalId, "mission_exception_owner_tenant_mismatch");
  const bound = resolveObservedSnapshot(db, input.tenantId, input.observedAgainst);
  return transition(db, {
    tenantId: input.tenantId,
    priorExceptionId: input.priorExceptionId,
    status: "open",
    blocking: input.blocking,
    observedSnapshotId: bound.snapshotId,
    observedResolvedSha: bound.resolvedSha,
    eventType: "mission.exception_reaffirmed",
    actorPrincipalId: input.actorPrincipalId,
    correlationId,
    causationId: input.causationId ?? null,
    createdAt,
  });
}

function standingOf(row: MissionExceptionRow, current: SnapshotIdentity | undefined): MissionExceptionStanding {
  if (row.status === "resolved") return "resolved";
  if (row.status === "withdrawn") return "withdrawn";
  // status === 'open'
  if (row.observed_snapshot_id === null) {
    // Context-independent: it blocks (or not) regardless of snapshot.
    return row.blocking === 1 ? "blocking" : "non_blocking_open";
  }
  // Context-bound: it only counts against the CURRENT context. If the mission
  // has moved to a different snapshot — or no current context is supplied — the
  // exception is stale and must not silently keep blocking.
  const matches = current !== undefined
    && current.snapshotId === row.observed_snapshot_id
    && current.resolvedSha === row.observed_resolved_sha;
  if (!matches) return "stale";
  return row.blocking === 1 ? "blocking" : "non_blocking_open";
}

// Evaluate the register for a mission against the mission's CURRENT snapshot
// binding. Chain heads (rows not yet superseded) are bucketed by standing. A
// resolved exception never blocks; a stale one is surfaced but does not count
// toward missionBlocked; only an open exception against the current context (or
// a context-independent open one) blocks.
export function evaluateMissionExceptions(db: AppDb, tenantId: string, missionId: string, current?: SnapshotIdentity): MissionExceptionEvaluation {
  const rows = all<MissionExceptionRow>(db,
    `SELECT * FROM mission_exceptions WHERE tenant_id = ? AND mission_id = ? ORDER BY created_at, id`,
    [tenantId, missionId]);
  const supersededBy = new Map<string, string>();
  for (const row of rows) {
    if (row.supersedes_id) supersededBy.set(row.supersedes_id, row.id);
  }
  const blocking: MissionExceptionView[] = [];
  const stale: MissionExceptionView[] = [];
  const nonBlockingOpen: MissionExceptionView[] = [];
  const resolved: MissionExceptionView[] = [];
  const withdrawn: MissionExceptionView[] = [];
  for (const row of rows) {
    const supersededById = supersededBy.get(row.id) ?? null;
    if (supersededById) continue; // only chain heads carry a live standing
    const standing = standingOf(row, current);
    const view: MissionExceptionView = Object.freeze({ ...hydrate(row), standing, supersededById });
    if (standing === "blocking") blocking.push(view);
    else if (standing === "stale") stale.push(view);
    else if (standing === "non_blocking_open") nonBlockingOpen.push(view);
    else if (standing === "resolved") resolved.push(view);
    else withdrawn.push(view);
  }
  return Object.freeze({
    missionBlocked: blocking.length > 0,
    blocking: Object.freeze(blocking),
    stale: Object.freeze(stale),
    nonBlockingOpen: Object.freeze(nonBlockingOpen),
    resolved: Object.freeze(resolved),
    withdrawn: Object.freeze(withdrawn),
  });
}

// Full exception history for a mission, oldest first, each annotated with its
// standing against the supplied current context and its place in the chain.
export function listMissionExceptions(db: AppDb, tenantId: string, missionId: string, current?: SnapshotIdentity): MissionExceptionView[] {
  const rows = all<MissionExceptionRow>(db,
    `SELECT * FROM mission_exceptions WHERE tenant_id = ? AND mission_id = ? ORDER BY created_at, id`,
    [tenantId, missionId]);
  const supersededBy = new Map<string, string>();
  for (const row of rows) {
    if (row.supersedes_id) supersededBy.set(row.supersedes_id, row.id);
  }
  return rows.map((row) => {
    const supersededById = supersededBy.get(row.id) ?? null;
    // Standing is a live signal for chain heads; for superseded rows it is
    // historical, and supersededById tells the reader the row is not current.
    const standing = standingOf(row, current);
    return Object.freeze({ ...hydrate(row), standing, supersededById });
  });
}
