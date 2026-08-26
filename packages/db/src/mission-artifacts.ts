import type { AppDb } from "./index.js";
import { appendDomainEvent } from "./trust.js";
import {
  all,
  assertMissionScope,
  assertRecordPrincipal,
  boundedText,
  contentDigest,
  exactUtc,
  one,
} from "./mission-record-content.js";

// Mission artifact registry (task brief §2). Mission outputs are first-class:
// impact report, migration plan, candidate patch, pull request, test run,
// verification report, architecture report, rollback plan, graph diff.
//
// REFERENCES, NOT COPIES. Large artifacts already live in `artifact_manifests`
// (content-addressed, UNIQUE (tenant_id, kind, sha256)). The registry stores a
// foreign-key reference to that manifest plus its sha256 — never the bytes. A
// row here is a claim "this manifest is THIS mission's output in THIS role",
// not a duplicate of the content.
//
// LINEAGE IS THE VALUABLE PART. `mission_artifact_lineage` records which
// registered output derived from which (a derived_from DAG within the mission),
// so the provenance of a pull request back through its candidate patch, its
// migration plan, and its impact report is recoverable.
//
// Tenant binding is structural (Change Graph Tier-1): the row id is a sha256
// content digest over canonical JSON that INCLUDES tenant_id, so a different
// tenant produces a different primary key by construction — cross-tenant
// collision is arithmetically impossible, not merely filtered. Additionally the
// composite foreign keys (tenant_id, mission_id) -> mission(tenant_id, id) and
// (tenant_id, artifact_id) -> artifact_manifests(tenant_id, id) make it
// impossible for a row to reference another tenant's mission or artifact. This
// does NOT lean on assertTenantScope, which permits an undefined tenant as a
// global read.
//
// Append-only, enforced by BEFORE UPDATE/DELETE triggers on both tables. Both
// tables are brand-new, so — like the mission durable-record tables — they
// converge on fresh AND pre-change databases purely through CREATE TABLE/INDEX
// IF NOT EXISTS, with no ALTER and no shape change to any existing table. The
// one companion is an additive UNIQUE INDEX on artifact_manifests(id, tenant_id)
// (existing columns; index-only, no shape change) that the composite FK targets,
// mirroring repository_snapshots_id_tenant_uidx.

// The roles a mission output can fill. Closed set: an unknown role is rejected
// rather than silently admitted.
export const MISSION_ARTIFACT_ROLES = [
  "impact_report",
  "migration_plan",
  "candidate_patch",
  "pull_request",
  "test_run",
  "verification_report",
  "architecture_report",
  "rollback_plan",
  "graph_diff",
] as const;

export type MissionArtifactRole = (typeof MISSION_ARTIFACT_ROLES)[number];

const ROLE_SET = new Set<string>(MISSION_ARTIFACT_ROLES);
const MAX_LABEL = 512;
// A cap on the lineage walk. Bounded and fail-closed: if a mission somehow
// accumulates more edges than this on one ancestry path, recording a new edge is
// rejected rather than walked unboundedly.
const MAX_LINEAGE_WALK = 4_096;

export type MissionArtifact = Readonly<{
  id: string;
  tenantId: string;
  missionId: string;
  role: MissionArtifactRole;
  // A reference to artifact_manifests(id) — where the content actually lives.
  artifactId: string;
  artifactSha256: string;
  label: string;
  producerPrincipalId: string;
  contentDigest: string;
  createdAt: string;
  taskId: string | null;
  sourceSnapshot: string | null;
}>;

export type MissionArtifactLineageEdge = Readonly<{
  id: string;
  tenantId: string;
  missionId: string;
  // artifactId derived_from parentArtifactId.
  artifactId: string;
  parentArtifactId: string;
  relation: "derived_from";
  recordedByPrincipalId: string;
  contentDigest: string;
  createdAt: string;
}>;

type MissionArtifactRow = {
  id: string;
  tenant_id: string;
  mission_id: string;
  role: MissionArtifactRole;
  artifact_id: string;
  artifact_sha256: string;
  label: string;
  producer_principal_id: string;
  content_digest: string;
  created_at: string;
  task_id: string | null;
  source_snapshot: string | null;
};

type MissionArtifactLineageRow = {
  id: string;
  tenant_id: string;
  mission_id: string;
  artifact_id: string;
  parent_artifact_id: string;
  relation: "derived_from";
  recorded_by_principal_id: string;
  content_digest: string;
  created_at: string;
};

function artifactDigestBody(input: {
  tenantId: string;
  missionId: string;
  role: MissionArtifactRole;
  artifactId: string;
  artifactSha256: string;
  label: string;
  producerPrincipalId: string;
  createdAt: string;
}) {
  return {
    kind: "mission_artifact",
    schemaVersion: 1,
    tenantId: input.tenantId,
    missionId: input.missionId,
    role: input.role,
    artifactId: input.artifactId,
    artifactSha256: input.artifactSha256,
    label: input.label,
    producerPrincipalId: input.producerPrincipalId,
    createdAt: input.createdAt,
  };
}

function lineageDigestBody(input: {
  tenantId: string;
  missionId: string;
  artifactId: string;
  parentArtifactId: string;
  recordedByPrincipalId: string;
  createdAt: string;
}) {
  return {
    kind: "mission_artifact_lineage",
    schemaVersion: 1,
    relation: "derived_from",
    tenantId: input.tenantId,
    missionId: input.missionId,
    artifactId: input.artifactId,
    parentArtifactId: input.parentArtifactId,
    recordedByPrincipalId: input.recordedByPrincipalId,
    createdAt: input.createdAt,
  };
}

function hydrateArtifact(row: MissionArtifactRow): MissionArtifact {
  const body = artifactDigestBody({
    tenantId: row.tenant_id,
    missionId: row.mission_id,
    role: row.role,
    artifactId: row.artifact_id,
    artifactSha256: row.artifact_sha256,
    label: row.label,
    producerPrincipalId: row.producer_principal_id,
    createdAt: row.created_at,
  });
  if (contentDigest(body) !== row.content_digest || row.content_digest !== row.id) {
    throw new Error("mission_artifact_corrupt");
  }
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    missionId: row.mission_id,
    role: row.role,
    artifactId: row.artifact_id,
    artifactSha256: row.artifact_sha256,
    label: row.label,
    producerPrincipalId: row.producer_principal_id,
    contentDigest: row.content_digest,
    createdAt: row.created_at,
    taskId: row.task_id ?? null,
    sourceSnapshot: row.source_snapshot ?? null,
  });
}

function hydrateLineage(row: MissionArtifactLineageRow): MissionArtifactLineageEdge {
  const body = lineageDigestBody({
    tenantId: row.tenant_id,
    missionId: row.mission_id,
    artifactId: row.artifact_id,
    parentArtifactId: row.parent_artifact_id,
    recordedByPrincipalId: row.recorded_by_principal_id,
    createdAt: row.created_at,
  });
  if (contentDigest(body) !== row.content_digest || row.content_digest !== row.id) {
    throw new Error("mission_artifact_lineage_corrupt");
  }
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    missionId: row.mission_id,
    artifactId: row.artifact_id,
    parentArtifactId: row.parent_artifact_id,
    relation: row.relation,
    recordedByPrincipalId: row.recorded_by_principal_id,
    contentDigest: row.content_digest,
    createdAt: row.created_at,
  });
}

function assertRole(role: string): MissionArtifactRole {
  if (!ROLE_SET.has(role)) throw new Error("mission_artifact_role_invalid");
  return role as MissionArtifactRole;
}

// The referenced artifact must be a manifest of the SAME tenant. The composite
// FK enforces this at INSERT; this pre-check turns the raw constraint failure
// into a named error and returns the manifest's canonical sha256 so the registry
// records the real content digest, never a caller-asserted one.
function requireTenantArtifact(db: AppDb, tenantId: string, artifactId: string): string {
  const row = one<{ sha256: string }>(
    db,
    `SELECT sha256 FROM artifact_manifests WHERE id = ? AND tenant_id = ?`,
    [artifactId, tenantId],
  );
  if (!row) throw new Error("mission_artifact_manifest_not_found");
  return row.sha256;
}

/**
 * Register an existing artifact manifest as a first-class output of a mission,
 * by REFERENCE. The content stays in artifact_manifests; this records only the
 * reference (id + canonical sha256), the role it fills, and its producer.
 * Idempotent: re-registering identical logical content replays the same row.
 * One (mission, role, artifact) registration is permitted; a second under a
 * different timestamp is rejected as an already-registered conflict.
 */
export function registerMissionArtifact(db: AppDb, input: {
  tenantId: string;
  missionId: string;
  role: MissionArtifactRole | string;
  artifactId: string;
  label: string;
  producerPrincipalId: string;
  correlationId: string;
  causationId?: string | null;
  createdAt: string;
  taskId?: string | null;
  sourceSnapshot?: string | null;
}): MissionArtifact {
  const role = assertRole(input.role);
  const label = boundedText(input.label, "mission_artifact_label_invalid", MAX_LABEL);
  const correlationId = boundedText(input.correlationId, "mission_artifact_correlation_invalid", 256);
  const createdAt = exactUtc(input.createdAt, "mission_artifact_created_at_invalid");
  assertMissionScope(db, input.tenantId, input.missionId);
  assertRecordPrincipal(db, input.tenantId, input.producerPrincipalId, "mission_artifact_producer_tenant_mismatch");
  const artifactSha256 = requireTenantArtifact(db, input.tenantId, input.artifactId);
  const body = artifactDigestBody({
    tenantId: input.tenantId,
    missionId: input.missionId,
    role,
    artifactId: input.artifactId,
    artifactSha256,
    label,
    producerPrincipalId: input.producerPrincipalId,
    createdAt,
  });
  const digest = contentDigest(body);
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = one<MissionArtifactRow>(db, `SELECT * FROM mission_artifacts WHERE id = ?`, [digest]);
    if (existing) {
      const value = hydrateArtifact(existing);
      if (owns) db.raw.exec("COMMIT");
      return value;
    }
    // Distinct logical registration for the same (mission, role, artifact) —
    // caught as a named conflict rather than a raw UNIQUE failure.
    const claimed = one<{ id: string }>(
      db,
      `SELECT id FROM mission_artifacts WHERE tenant_id = ? AND mission_id = ? AND role = ? AND artifact_id = ?`,
      [input.tenantId, input.missionId, role, input.artifactId],
    );
    if (claimed) throw new Error("mission_artifact_already_registered");
    db.raw.prepare(`INSERT INTO mission_artifacts
      (id, tenant_id, mission_id, role, artifact_id, artifact_sha256, label,
       producer_principal_id, content_digest, created_at, task_id, source_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      digest, input.tenantId, input.missionId, role, input.artifactId, artifactSha256, label,
      input.producerPrincipalId, digest, createdAt,
      input.taskId ? boundedText(input.taskId, "mission_artifact_task_id_invalid", 256) : null,
      input.sourceSnapshot ? boundedText(input.sourceSnapshot, "mission_artifact_source_snapshot_invalid", 256) : null);
    appendDomainEvent(db, {
      id: `mission-artifact:${digest}`,
      tenantId: input.tenantId,
      schemaVersion: 1,
      eventType: "mission.artifact_registered",
      aggregateType: "mission",
      aggregateId: input.missionId,
      actorPrincipalId: input.producerPrincipalId,
      correlationId,
      causationId: input.causationId ?? null,
      idempotencyKey: `mission-artifact:${digest}`,
      payload: {
        artifactRegistrationId: digest,
        role,
        artifactId: input.artifactId,
        artifactSha256,
      },
      createdAt,
    });
    const value = hydrateArtifact(one<MissionArtifactRow>(db, `SELECT * FROM mission_artifacts WHERE id = ?`, [digest])!);
    if (owns) db.raw.exec("COMMIT");
    return value;
  } catch (error) {
    if (owns) db.raw.exec("ROLLBACK");
    throw error;
  }
}

// Would adding edge (artifactId derived_from parentArtifactId) create a cycle?
// A cycle exists iff `parentArtifactId` is already (transitively) derived from
// `artifactId` — i.e. following derived_from edges upward from the parent
// eventually reaches the child. Bounded, fail-closed walk over the mission's own
// edge set.
function wouldCreateCycle(db: AppDb, tenantId: string, missionId: string, artifactId: string, parentArtifactId: string): boolean {
  const frontier: string[] = [parentArtifactId];
  const seen = new Set<string>();
  let visited = 0;
  while (frontier.length > 0) {
    const node = frontier.pop()!;
    if (node === artifactId) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    if (++visited > MAX_LINEAGE_WALK) throw new Error("mission_artifact_lineage_walk_exceeded");
    const parents = all<{ parent_artifact_id: string }>(
      db,
      `SELECT parent_artifact_id FROM mission_artifact_lineage
       WHERE tenant_id = ? AND mission_id = ? AND artifact_id = ?`,
      [tenantId, missionId, node],
    );
    for (const p of parents) frontier.push(p.parent_artifact_id);
  }
  return false;
}

/**
 * Record that one registered mission output derived from another. Both endpoints
 * must already be registered outputs of THIS mission (so lineage stays
 * self-contained and recoverable), and both are, structurally, same-tenant
 * artifact_manifests. Self-loops and cycles are rejected — lineage is a DAG, so
 * it can always be reconstructed. Idempotent: re-recording the same edge replays
 * the same row. Emits a `mission.artifact_lineage_recorded` domain event, so the
 * derivation also lands on the mission timeline.
 */
export function recordMissionArtifactLineage(db: AppDb, input: {
  tenantId: string;
  missionId: string;
  artifactId: string;
  parentArtifactId: string;
  recordedByPrincipalId: string;
  correlationId: string;
  causationId?: string | null;
  createdAt: string;
}): MissionArtifactLineageEdge {
  const correlationId = boundedText(input.correlationId, "mission_artifact_lineage_correlation_invalid", 256);
  const createdAt = exactUtc(input.createdAt, "mission_artifact_lineage_created_at_invalid");
  // artifactId/parentArtifactId are manifest ids (opaque), not required to be a
  // particular format — identity is enforced by the registration checks below.
  if (input.artifactId === input.parentArtifactId) throw new Error("mission_artifact_lineage_self_loop");
  assertMissionScope(db, input.tenantId, input.missionId);
  assertRecordPrincipal(db, input.tenantId, input.recordedByPrincipalId, "mission_artifact_lineage_recorder_tenant_mismatch");
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    // Both endpoints must be registered outputs of THIS mission.
    const child = one<{ id: string }>(
      db,
      `SELECT id FROM mission_artifacts WHERE tenant_id = ? AND mission_id = ? AND artifact_id = ? LIMIT 1`,
      [input.tenantId, input.missionId, input.artifactId],
    );
    if (!child) throw new Error("mission_artifact_lineage_child_unregistered");
    const parent = one<{ id: string }>(
      db,
      `SELECT id FROM mission_artifacts WHERE tenant_id = ? AND mission_id = ? AND artifact_id = ? LIMIT 1`,
      [input.tenantId, input.missionId, input.parentArtifactId],
    );
    if (!parent) throw new Error("mission_artifact_lineage_parent_unregistered");
    const body = lineageDigestBody({
      tenantId: input.tenantId,
      missionId: input.missionId,
      artifactId: input.artifactId,
      parentArtifactId: input.parentArtifactId,
      recordedByPrincipalId: input.recordedByPrincipalId,
      createdAt,
    });
    const digest = contentDigest(body);
    const existing = one<MissionArtifactLineageRow>(db, `SELECT * FROM mission_artifact_lineage WHERE id = ?`, [digest]);
    if (existing) {
      const value = hydrateLineage(existing);
      if (owns) db.raw.exec("COMMIT");
      return value;
    }
    const claimed = one<{ id: string }>(
      db,
      `SELECT id FROM mission_artifact_lineage
       WHERE tenant_id = ? AND mission_id = ? AND artifact_id = ? AND parent_artifact_id = ?`,
      [input.tenantId, input.missionId, input.artifactId, input.parentArtifactId],
    );
    if (claimed) throw new Error("mission_artifact_lineage_already_recorded");
    if (wouldCreateCycle(db, input.tenantId, input.missionId, input.artifactId, input.parentArtifactId)) {
      throw new Error("mission_artifact_lineage_cycle");
    }
    db.raw.prepare(`INSERT INTO mission_artifact_lineage
      (id, tenant_id, mission_id, artifact_id, parent_artifact_id, relation,
       recorded_by_principal_id, content_digest, created_at)
      VALUES (?, ?, ?, ?, ?, 'derived_from', ?, ?, ?)`).run(
      digest, input.tenantId, input.missionId, input.artifactId, input.parentArtifactId,
      input.recordedByPrincipalId, digest, createdAt);
    appendDomainEvent(db, {
      id: `mission-artifact-lineage:${digest}`,
      tenantId: input.tenantId,
      schemaVersion: 1,
      eventType: "mission.artifact_lineage_recorded",
      aggregateType: "mission",
      aggregateId: input.missionId,
      actorPrincipalId: input.recordedByPrincipalId,
      correlationId,
      causationId: input.causationId ?? null,
      idempotencyKey: `mission-artifact-lineage:${digest}`,
      payload: {
        lineageId: digest,
        artifactId: input.artifactId,
        parentArtifactId: input.parentArtifactId,
        relation: "derived_from",
      },
      createdAt,
    });
    const value = hydrateLineage(one<MissionArtifactLineageRow>(db, `SELECT * FROM mission_artifact_lineage WHERE id = ?`, [digest])!);
    if (owns) db.raw.exec("COMMIT");
    return value;
  } catch (error) {
    if (owns) db.raw.exec("ROLLBACK");
    throw error;
  }
}

// List a mission's registered outputs (references), optionally filtered to a
// role, most recent first.
export function listMissionArtifacts(
  db: AppDb,
  tenantId: string,
  missionId: string,
  role?: MissionArtifactRole,
  limit?: number,
): MissionArtifact[] {
  const bounded = limit !== undefined;
  if (bounded && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) {
    throw new Error("mission_artifact_list_limit_invalid");
  }
  const rows = role === undefined
    ? bounded
      ? all<MissionArtifactRow>(db,
          `SELECT * FROM mission_artifacts WHERE tenant_id = ? AND mission_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
          [tenantId, missionId, limit])
      : all<MissionArtifactRow>(db,
          `SELECT * FROM mission_artifacts WHERE tenant_id = ? AND mission_id = ? ORDER BY created_at DESC, id DESC`,
          [tenantId, missionId])
    : bounded
      ? all<MissionArtifactRow>(db,
          `SELECT * FROM mission_artifacts WHERE tenant_id = ? AND mission_id = ? AND role = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
          [tenantId, missionId, role, limit])
      : all<MissionArtifactRow>(db,
          `SELECT * FROM mission_artifacts WHERE tenant_id = ? AND mission_id = ? AND role = ? ORDER BY created_at DESC, id DESC`,
          [tenantId, missionId, role]);
  return rows.map(hydrateArtifact);
}

// List a mission's lineage edges (derived_from), most recent first.
export function listMissionArtifactLineage(db: AppDb, tenantId: string, missionId: string): MissionArtifactLineageEdge[] {
  return all<MissionArtifactLineageRow>(db,
    `SELECT * FROM mission_artifact_lineage WHERE tenant_id = ? AND mission_id = ? ORDER BY created_at DESC, id DESC`,
    [tenantId, missionId]).map(hydrateLineage);
}

// Recover the full ancestry of one output: every artifact it derived from,
// transitively, following derived_from edges. Bounded by the same walk cap. The
// result is the set of ancestor artifact ids (the DAG is acyclic by
// construction, so the walk always terminates).
export function traceMissionArtifactAncestry(db: AppDb, tenantId: string, missionId: string, artifactId: string): string[] {
  const frontier: string[] = [artifactId];
  const seen = new Set<string>();
  const ancestors = new Set<string>();
  let visited = 0;
  while (frontier.length > 0) {
    const node = frontier.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (++visited > MAX_LINEAGE_WALK) throw new Error("mission_artifact_lineage_walk_exceeded");
    const parents = all<{ parent_artifact_id: string }>(
      db,
      `SELECT parent_artifact_id FROM mission_artifact_lineage
       WHERE tenant_id = ? AND mission_id = ? AND artifact_id = ?`,
      [tenantId, missionId, node],
    );
    for (const p of parents) {
      ancestors.add(p.parent_artifact_id);
      if (!seen.has(p.parent_artifact_id)) frontier.push(p.parent_artifact_id);
    }
  }
  return [...ancestors];
}
