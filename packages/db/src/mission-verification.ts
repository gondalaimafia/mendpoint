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

// Mission verification history (task brief §3). The governing rule: verification
// against OLD code must not count as current evidence after relevant changes. A
// later stage may reuse "stage 2 passed integration tests at commit X" only if
// that evidence is still valid.
//
// This is the repo's signature defect waiting to happen: there are THREE states,
// not two — verified against current code, verified against code that has since
// changed, and never verified — and the second must never collapse into the
// first. That is made unrepresentable in the type: the `current_evidence`
// standing is the SOLE output that means "reusable now", and it is constructed
// in exactly one place (classifyMissionVerificationEvidence) and only after the
// record's snapshot identity is asserted equal to the current binding. No other
// code path can produce it, so verification against changed code cannot be read
// as current evidence.
//
// Binding: each verification is bound to an exact repository_snapshots row and
// its resolved commit AND manifest digest, captured at write and re-checked
// against the immutable snapshot — never a re-resolution of HEAD (the
// sourceBinding pattern in apps/api/src/warden-candidate-review.ts).
//
// "Relevant change" is defined as ANY change to the bound snapshot identity
// (a different snapshot row, resolved commit, or manifest digest). This is the
// honest default the brief prescribes: a sound scope-intersection rule would
// need a reliable mapping from changed files to a verification's declared scope,
// and no such mapping is wired to work-unit verification on main (change-graph
// impact is routed to PR bodies, not here). Treating any snapshot change as
// invalidating can only force re-verification — it can never over-credit stale
// evidence as current. See the PR body.

export type MissionVerificationStatus = "passed" | "failed" | "inconclusive";

export type SnapshotVerificationIdentity = Readonly<{
  snapshotId: string;
  resolvedSha: string;
  manifestSha256: string;
}>;

export type MissionVerificationRecord = Readonly<{
  id: string;
  tenantId: string;
  missionId: string;
  verification: string;
  scope: string;
  snapshotId: string;
  resolvedSha: string;
  manifestSha256: string;
  status: MissionVerificationStatus;
  verifierPrincipalId: string;
  contentDigest: string;
  createdAt: string;
}>;

// Distinct absence reasons — every branch a distinct reason (the fail-closed
// house template in packages/db/src/fettler-delegation-evidence.ts). Absence is
// never the reassuring answer: a caller can tell never-verified apart from a
// verification that failed, was inconclusive, or exists only against changed
// code.
export type MissionVerificationAbsence =
  | "no_verification_recorded"
  | "current_verification_failed"
  | "current_verification_inconclusive"
  | "only_stale_evidence";

export type SnapshotIdentityDelta = Readonly<{
  field: "snapshot_id" | "resolved_sha" | "manifest_sha256";
  recorded: string;
  current: string;
}>;

// The three freshness states. `current_evidence` is the only standing that means
// "reusable as current evidence", and it is produced only by the classifier.
export type MissionVerificationStanding =
  | Readonly<{ standing: "current_evidence"; record: MissionVerificationRecord }>
  | Readonly<{ standing: "stale_evidence"; record: MissionVerificationRecord; changed: SnapshotIdentityDelta }>
  | Readonly<{ standing: "no_current_evidence"; reason: MissionVerificationAbsence }>;

type MissionVerificationRow = {
  id: string;
  tenant_id: string;
  mission_id: string;
  verification: string;
  scope: string;
  snapshot_id: string;
  resolved_sha: string;
  manifest_sha256: string;
  status: MissionVerificationStatus;
  verifier_principal_id: string;
  content_digest: string;
  created_at: string;
};

const MAX_VERIFICATION = 4_000;
const MAX_SCOPE = 512;

function verificationDigestBody(input: {
  tenantId: string;
  missionId: string;
  verification: string;
  scope: string;
  snapshotId: string;
  resolvedSha: string;
  manifestSha256: string;
  status: MissionVerificationStatus;
  verifierPrincipalId: string;
  createdAt: string;
}) {
  return {
    kind: "mission_verification",
    schemaVersion: 1,
    tenantId: input.tenantId,
    missionId: input.missionId,
    verification: input.verification,
    scope: input.scope,
    snapshotId: input.snapshotId,
    resolvedSha: input.resolvedSha,
    manifestSha256: input.manifestSha256,
    status: input.status,
    verifierPrincipalId: input.verifierPrincipalId,
    createdAt: input.createdAt,
  };
}

function hydrate(row: MissionVerificationRow): MissionVerificationRecord {
  const body = verificationDigestBody({
    tenantId: row.tenant_id,
    missionId: row.mission_id,
    verification: row.verification,
    scope: row.scope,
    snapshotId: row.snapshot_id,
    resolvedSha: row.resolved_sha,
    manifestSha256: row.manifest_sha256,
    status: row.status,
    verifierPrincipalId: row.verifier_principal_id,
    createdAt: row.created_at,
  });
  if (contentDigest(body) !== row.content_digest || row.content_digest !== row.id) {
    throw new Error("mission_verification_corrupt");
  }
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    missionId: row.mission_id,
    verification: row.verification,
    scope: row.scope,
    snapshotId: row.snapshot_id,
    resolvedSha: row.resolved_sha,
    manifestSha256: row.manifest_sha256,
    status: row.status,
    verifierPrincipalId: row.verifier_principal_id,
    contentDigest: row.content_digest,
    createdAt: row.created_at,
  });
}

function assertStatus(status: MissionVerificationStatus): MissionVerificationStatus {
  if (status !== "passed" && status !== "failed" && status !== "inconclusive") {
    throw new Error("mission_verification_status_invalid");
  }
  return status;
}

// Read the immutable snapshot identity for a snapshot row. This is how a caller
// obtains a BOUND current identity to classify against, without re-resolving
// HEAD anywhere.
export function resolveMissionSnapshotIdentity(db: AppDb, tenantId: string, snapshotId: string): SnapshotVerificationIdentity {
  const row = one<{ resolved_sha: string; manifest_sha256: string }>(db,
    `SELECT resolved_sha, manifest_sha256 FROM repository_snapshots WHERE id = ? AND tenant_id = ?`,
    [snapshotId, tenantId]);
  if (!row) throw new Error("mission_verification_snapshot_not_found");
  return Object.freeze({ snapshotId, resolvedSha: row.resolved_sha, manifestSha256: row.manifest_sha256 });
}

// Record a verification result bound to an exact snapshot. The caller supplies
// the snapshot identity it verified against; we re-read the immutable snapshot
// and REQUIRE the resolved commit and manifest digest to match, so the record is
// bound to a real snapshot rather than a re-resolution of HEAD. A binding
// mismatch is rejected — an unverifiable claim is never asserted.
export function recordMissionVerification(db: AppDb, input: {
  tenantId: string;
  missionId: string;
  verification: string;
  scope: string;
  snapshotId: string;
  resolvedSha: string;
  manifestSha256: string;
  status: MissionVerificationStatus;
  verifierPrincipalId: string;
  correlationId: string;
  causationId?: string | null;
  createdAt: string;
}): MissionVerificationRecord {
  const verification = boundedText(input.verification, "mission_verification_text_invalid", MAX_VERIFICATION);
  const scope = boundedText(input.scope, "mission_verification_scope_invalid", MAX_SCOPE);
  const correlationId = boundedText(input.correlationId, "mission_verification_correlation_invalid", 256);
  const createdAt = exactUtc(input.createdAt, "mission_verification_created_at_invalid");
  const status = assertStatus(input.status);
  assertMissionScope(db, input.tenantId, input.missionId);
  assertRecordPrincipal(db, input.tenantId, input.verifierPrincipalId, "mission_verification_verifier_tenant_mismatch");
  const bound = resolveMissionSnapshotIdentity(db, input.tenantId, input.snapshotId);
  if (bound.resolvedSha !== input.resolvedSha || bound.manifestSha256 !== input.manifestSha256) {
    throw new Error("mission_verification_snapshot_binding_mismatch");
  }
  const body = verificationDigestBody({
    tenantId: input.tenantId,
    missionId: input.missionId,
    verification,
    scope,
    snapshotId: input.snapshotId,
    resolvedSha: input.resolvedSha,
    manifestSha256: input.manifestSha256,
    status,
    verifierPrincipalId: input.verifierPrincipalId,
    createdAt,
  });
  const digest = contentDigest(body);
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = one<MissionVerificationRow>(db, `SELECT * FROM mission_verifications WHERE id = ?`, [digest]);
    if (existing) {
      const value = hydrate(existing);
      if (owns) db.raw.exec("COMMIT");
      return value;
    }
    db.raw.prepare(`INSERT INTO mission_verifications
      (id, tenant_id, mission_id, verification, scope, snapshot_id, resolved_sha, manifest_sha256,
       status, verifier_principal_id, content_digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      digest, input.tenantId, input.missionId, verification, scope, input.snapshotId,
      input.resolvedSha, input.manifestSha256, status, input.verifierPrincipalId, digest, createdAt);
    appendDomainEvent(db, {
      id: `mission-verification:${digest}`,
      tenantId: input.tenantId,
      schemaVersion: 1,
      eventType: "mission.verification_recorded",
      aggregateType: "mission",
      aggregateId: input.missionId,
      actorPrincipalId: input.verifierPrincipalId,
      correlationId,
      causationId: input.causationId ?? null,
      idempotencyKey: `mission-verification:${digest}`,
      payload: {
        verificationId: digest,
        scope,
        status,
        snapshotId: input.snapshotId,
        resolvedSha: input.resolvedSha,
        manifestSha256: input.manifestSha256,
      },
      createdAt,
    });
    const value = hydrate(one<MissionVerificationRow>(db, `SELECT * FROM mission_verifications WHERE id = ?`, [digest])!);
    if (owns) db.raw.exec("COMMIT");
    return value;
  } catch (error) {
    if (owns) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function identityMatches(record: MissionVerificationRecord, current: SnapshotVerificationIdentity): boolean {
  return record.snapshotId === current.snapshotId
    && record.resolvedSha === current.resolvedSha
    && record.manifestSha256 === current.manifestSha256;
}

function firstDelta(record: MissionVerificationRecord, current: SnapshotVerificationIdentity): SnapshotIdentityDelta {
  if (record.snapshotId !== current.snapshotId) {
    return { field: "snapshot_id", recorded: record.snapshotId, current: current.snapshotId };
  }
  if (record.resolvedSha !== current.resolvedSha) {
    return { field: "resolved_sha", recorded: record.resolvedSha, current: current.resolvedSha };
  }
  return { field: "manifest_sha256", recorded: record.manifestSha256, current: current.manifestSha256 };
}

// THE tristate classifier. Given the verification records for a scope and the
// mission's CURRENT bound snapshot identity, decide whether any reusable current
// evidence exists. This is the only constructor of the `current_evidence`
// standing, and it emits it only after asserting the record's snapshot identity
// equals `current`.
//
// Precedence:
//   1. A PASSING verification bound to the current snapshot -> current_evidence.
//   2. Otherwise, if the current snapshot WAS verified but did not pass -> no
//      current evidence, with the failing/inconclusive reason (current code was
//      checked and is not green).
//   3. Otherwise, a PASSING verification against a DIFFERENT snapshot ->
//      stale_evidence (verified-then-invalidated; never reads as current).
//   4. Otherwise -> no current evidence: nothing recorded, or only non-passing
//      stale records.
export function classifyMissionVerificationEvidence(
  records: readonly MissionVerificationRecord[],
  current: SnapshotVerificationIdentity,
): MissionVerificationStanding {
  const byRecency = [...records].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : (a.id < b.id ? 1 : -1)));
  const currentIdentity = byRecency.filter((r) => identityMatches(r, current));
  const passingCurrent = currentIdentity.find((r) => r.status === "passed");
  if (passingCurrent) {
    return Object.freeze({ standing: "current_evidence" as const, record: passingCurrent });
  }
  if (currentIdentity.length > 0) {
    // Current code was verified and did not pass. Do not fall through to stale.
    const latest = currentIdentity[0];
    const reason: MissionVerificationAbsence = latest.status === "failed"
      ? "current_verification_failed"
      : "current_verification_inconclusive";
    return Object.freeze({ standing: "no_current_evidence" as const, reason });
  }
  const passingStale = byRecency.find((r) => r.status === "passed");
  if (passingStale) {
    return Object.freeze({
      standing: "stale_evidence" as const,
      record: passingStale,
      changed: firstDelta(passingStale, current),
    });
  }
  const reason: MissionVerificationAbsence = records.length === 0
    ? "no_verification_recorded"
    : "only_stale_evidence";
  return Object.freeze({ standing: "no_current_evidence" as const, reason });
}

// List verification records for a mission (optionally filtered to one scope),
// most recent first.
export function listMissionVerifications(db: AppDb, tenantId: string, missionId: string, scope?: string): MissionVerificationRecord[] {
  const rows = scope === undefined
    ? all<MissionVerificationRow>(db,
        `SELECT * FROM mission_verifications WHERE tenant_id = ? AND mission_id = ? ORDER BY created_at DESC, id DESC`,
        [tenantId, missionId])
    : all<MissionVerificationRow>(db,
        `SELECT * FROM mission_verifications WHERE tenant_id = ? AND mission_id = ? AND scope = ? ORDER BY created_at DESC, id DESC`,
        [tenantId, missionId, scope]);
  return rows.map(hydrate);
}

// Convenience: classify the reusable-evidence standing for one scope of a
// mission against a current bound snapshot identity.
export function missionVerificationStanding(db: AppDb, input: {
  tenantId: string;
  missionId: string;
  scope: string;
  current: SnapshotVerificationIdentity;
}): MissionVerificationStanding {
  const records = listMissionVerifications(db, input.tenantId, input.missionId, input.scope);
  return classifyMissionVerificationEvidence(records, input.current);
}
