import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyMissionVerificationEvidence,
  createDb,
  createMission,
  insertPrincipal,
  listMissionVerifications,
  missionVerificationStanding,
  recordMissionVerification,
  resolveMissionSnapshotIdentity,
  type AppDb,
} from "./index.js";

const T0 = "2026-01-01T00:00:00.000Z";
const MANIFEST_A = "a".repeat(64);
const MANIFEST_B = "b".repeat(64);
const opened: Array<{ db: AppDb; dir: string }> = [];

function snapshot(db: AppDb, tenant: string, repoId: string, snapId: string, sha: string, manifest: string) {
  db.raw.prepare(`INSERT INTO repository_snapshots
    (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
     submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
    VALUES (?, ?, ?, 'main', ?, ?, ?, 'reject', 'reject', '[]', 1, ?, '2026-02-01T00:00:00.000Z')`)
    .run(snapId, tenant, repoId, sha, manifest, `C:/tmp/${snapId}`, T0);
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-mver-"));
  const db = createDb(join(dir, "v.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1','one','One','team','active',10,?), ('t2','two','Two','team','active',10,?)`).run(T0, T0);
  insertPrincipal(db, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com", displayName: "One", createdAt: T0 });
  insertPrincipal(db, { id: "p2", tenantId: "t2", kind: "human", subject: "two@example.com", displayName: "Two", createdAt: T0 });
  db.raw.prepare(`INSERT INTO scm_connections (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
    VALUES ('c1','t1','github','me://ref','acct','Acme',?,?), ('c2','t2','github','me://ref','acct2','Acme2',?,?)`).run(T0, T0, T0, T0);
  db.raw.prepare(`INSERT INTO connected_repositories
    (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch, environment, retention_days, status, created_at, updated_at)
    VALUES ('r1','t1','c1','1','acme','svc','main','main','production',30,'ready',?,?), ('r2','t2','c2','2','acme','svc','main','main','production',30,'ready',?,?)`).run(T0, T0, T0, T0);
  snapshot(db, "t1", "r1", "snapA", "1".repeat(40), MANIFEST_A);
  snapshot(db, "t1", "r1", "snapB", "2".repeat(40), MANIFEST_B);
  snapshot(db, "t2", "r2", "snapT2", "3".repeat(40), MANIFEST_A);
  createMission(db, { id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
    objective: "Migrate off v1", ownerPrincipalId: "p1", eventId: "ev-m1", idempotencyKey: "cm-m1", correlationId: "corr", createdAt: T0 });
  createMission(db, { id: "m2", tenantId: "t2", product: "fettler", triggerKind: "provider_change",
    objective: "Migrate off v1", ownerPrincipalId: "p2", eventId: "ev-m2", idempotencyKey: "cm-m2", correlationId: "corr", createdAt: T0 });
  return db;
}

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function record(db: AppDb, snapId: string, sha: string, manifest: string, status: "passed" | "failed" | "inconclusive", at = T0, scope = "stage-2") {
  return recordMissionVerification(db, { tenantId: "t1", missionId: "m1", verification: "integration tests",
    scope, snapshotId: snapId, resolvedSha: sha, manifestSha256: manifest, status,
    verifierPrincipalId: "p1", correlationId: "corr", createdAt: at });
}

describe("mission verification history", () => {
  it("classifies a passing verification against the current snapshot as current evidence", () => {
    const db = fixture();
    record(db, "snapA", "1".repeat(40), MANIFEST_A, "passed");
    const current = resolveMissionSnapshotIdentity(db, "t1", "snapA");
    const standing = missionVerificationStanding(db, { tenantId: "t1", missionId: "m1", scope: "stage-2", current });
    expect(standing.standing).toBe("current_evidence");
  });

  // THE CRITICAL CONTROL: verification against a CHANGED snapshot must not read
  // as current evidence. Deleting the snapshot-identity check in the classifier
  // (returning current_evidence whenever a passing record exists) fails this
  // test.
  it("does not read a verification against a changed snapshot as current evidence", () => {
    const db = fixture();
    record(db, "snapA", "1".repeat(40), MANIFEST_A, "passed");
    const movedTo = resolveMissionSnapshotIdentity(db, "t1", "snapB");
    const standing = missionVerificationStanding(db, { tenantId: "t1", missionId: "m1", scope: "stage-2", current: movedTo });
    expect(standing.standing).toBe("stale_evidence");
    expect(standing.standing).not.toBe("current_evidence");
    if (standing.standing === "stale_evidence") {
      expect(standing.changed.field).toBe("snapshot_id");
    }
  });

  // CONTROL: never-verified is distinguishable from verified-then-invalidated.
  it("distinguishes never-verified from verified-then-invalidated", () => {
    const db = fixture();
    const current = resolveMissionSnapshotIdentity(db, "t1", "snapA");
    const never = classifyMissionVerificationEvidence([], current);
    expect(never.standing).toBe("no_current_evidence");
    if (never.standing === "no_current_evidence") expect(never.reason).toBe("no_verification_recorded");

    record(db, "snapB", "2".repeat(40), MANIFEST_B, "passed");
    const invalidated = missionVerificationStanding(db, { tenantId: "t1", missionId: "m1", scope: "stage-2", current });
    expect(invalidated.standing).toBe("stale_evidence");
    // The two are not the same standing: absence never masquerades as stale evidence.
    expect(invalidated.standing).not.toBe(never.standing);
  });

  it("reports a failed verification of the current snapshot as no current evidence, distinct from never", () => {
    const db = fixture();
    record(db, "snapA", "1".repeat(40), MANIFEST_A, "failed");
    const current = resolveMissionSnapshotIdentity(db, "t1", "snapA");
    const standing = missionVerificationStanding(db, { tenantId: "t1", missionId: "m1", scope: "stage-2", current });
    expect(standing.standing).toBe("no_current_evidence");
    if (standing.standing === "no_current_evidence") expect(standing.reason).toBe("current_verification_failed");
  });

  it("treats a manifest-only change as a relevant change (any snapshot change invalidates)", () => {
    const db = fixture();
    record(db, "snapA", "1".repeat(40), MANIFEST_A, "passed");
    // Same snapshot id and resolved sha, but a different manifest digest.
    const changedManifest = { snapshotId: "snapA", resolvedSha: "1".repeat(40), manifestSha256: MANIFEST_B };
    const standing = classifyMissionVerificationEvidence(listMissionVerifications(db, "t1", "m1", "stage-2"), changedManifest);
    expect(standing.standing).toBe("stale_evidence");
    if (standing.standing === "stale_evidence") expect(standing.changed.field).toBe("manifest_sha256");
  });

  // CONTROL: fail-closed binding. Deleting the resolved_sha/manifest match in
  // recordMissionVerification fails this test.
  it("rejects recording a verification whose claimed commit does not match the snapshot", () => {
    const db = fixture();
    expect(() => recordMissionVerification(db, { tenantId: "t1", missionId: "m1", verification: "t",
      scope: "stage-2", snapshotId: "snapA", resolvedSha: "wrong-sha", manifestSha256: MANIFEST_A, status: "passed",
      verifierPrincipalId: "p1", correlationId: "corr", createdAt: T0 })).toThrow(/snapshot_binding_mismatch/);
  });

  // CONTROL: append-only.
  it("is append-only: UPDATE and DELETE are rejected", () => {
    const db = fixture();
    const v = record(db, "snapA", "1".repeat(40), MANIFEST_A, "passed");
    expect(() => db.raw.prepare(`UPDATE mission_verifications SET status = 'failed' WHERE id = ?`).run(v.id)).toThrow(/append_only/);
    expect(() => db.raw.prepare(`DELETE FROM mission_verifications WHERE id = ?`).run(v.id)).toThrow(/append_only/);
  });

  // CONTROL: cross-tenant read structurally impossible.
  it("makes cross-tenant collision structurally impossible", () => {
    const db = fixture();
    const v1 = record(db, "snapA", "1".repeat(40), MANIFEST_A, "passed");
    const v2 = recordMissionVerification(db, { tenantId: "t2", missionId: "m2", verification: "integration tests",
      scope: "stage-2", snapshotId: "snapT2", resolvedSha: "3".repeat(40), manifestSha256: MANIFEST_A, status: "passed",
      verifierPrincipalId: "p2", correlationId: "corr", createdAt: T0 });
    expect(v1.id).not.toBe(v2.id);
    // A t1 write cannot bind to t2's snapshot (snapshot not found for tenant t1).
    expect(() => recordMissionVerification(db, { tenantId: "t1", missionId: "m1", verification: "t",
      scope: "stage-2", snapshotId: "snapT2", resolvedSha: "3".repeat(40), manifestSha256: MANIFEST_A, status: "passed",
      verifierPrincipalId: "p1", correlationId: "corr", createdAt: T0 })).toThrow(/snapshot_not_found/);
    expect(listMissionVerifications(db, "t1", "m1").map((x) => x.id)).not.toContain(v2.id);
  });
});
