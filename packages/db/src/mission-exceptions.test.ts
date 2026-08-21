import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  evaluateMissionExceptions,
  insertPrincipal,
  listMissionExceptions,
  raiseMissionException,
  reaffirmMissionException,
  resolveMissionException,
  withdrawMissionException,
  type AppDb,
  type SnapshotIdentity,
} from "./index.js";

const T0 = "2026-01-01T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

function snapshot(db: AppDb, tenant: string, repoId: string, snapId: string, sha: string) {
  db.raw.prepare(`INSERT INTO repository_snapshots
    (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
     submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
    VALUES (?, ?, ?, 'main', ?, ?, ?, 'reject', 'reject', '[]', 1, ?, '2026-02-01T00:00:00.000Z')`)
    .run(snapId, tenant, repoId, sha, "b".repeat(64), `C:/tmp/${snapId}`, T0);
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-mexc-"));
  const db = createDb(join(dir, "e.sqlite"));
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
  snapshot(db, "t1", "r1", "snapA", "a".repeat(40));
  snapshot(db, "t1", "r1", "snapB", "c".repeat(40));
  snapshot(db, "t2", "r2", "snapT2", "d".repeat(40));
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

const snapA: SnapshotIdentity = { snapshotId: "snapA", resolvedSha: "a".repeat(40) };
const snapB: SnapshotIdentity = { snapshotId: "snapB", resolvedSha: "c".repeat(40) };

function raise(db: AppDb, opts: { blocking?: boolean; observedAgainst?: SnapshotIdentity; reason?: string } = {}) {
  return raiseMissionException(db, { tenantId: "t1", missionId: "m1",
    reason: opts.reason ?? "payments-svc cannot migrate yet", impact: "blocks wave 2",
    ownerPrincipalId: "p1", resolutionPath: "await vendor SDK 3.0", blocking: opts.blocking ?? true,
    observedAgainst: opts.observedAgainst, correlationId: "corr", createdAt: T0 });
}

describe("mission exception register", () => {
  it("blocks the mission while an open blocking exception stands", () => {
    const db = fixture();
    raise(db);
    const evalResult = evaluateMissionExceptions(db, "t1", "m1");
    expect(evalResult.missionBlocked).toBe(true);
    expect(evalResult.blocking).toHaveLength(1);
  });

  // CONTROL: a resolved exception stops blocking. Deleting the resolved-standing
  // branch (or counting resolved rows as blocking) fails this test.
  it("stops blocking once the exception is resolved", () => {
    const db = fixture();
    const e = raise(db);
    resolveMissionException(db, { tenantId: "t1", priorExceptionId: e.id, resolutionNote: "vendor shipped SDK 3.0",
      actorPrincipalId: "p1", correlationId: "corr", createdAt: "2026-01-03T00:00:00.000Z" });
    const evalResult = evaluateMissionExceptions(db, "t1", "m1");
    expect(evalResult.missionBlocked).toBe(false);
    expect(evalResult.resolved).toHaveLength(1);
    expect(evalResult.blocking).toHaveLength(0);
  });

  // CONTROL: a stale exception does not silently keep blocking. Deleting the
  // staleness branch (treating a context-bound open exception as blocking
  // regardless of current snapshot) fails this test.
  it("does not let a stale exception silently keep blocking", () => {
    const db = fixture();
    raise(db, { observedAgainst: snapA });
    // Against the snapshot it was raised on, it blocks.
    expect(evaluateMissionExceptions(db, "t1", "m1", snapA).missionBlocked).toBe(true);
    // Once the mission has moved to a different snapshot, it is stale, not blocking.
    const moved = evaluateMissionExceptions(db, "t1", "m1", snapB);
    expect(moved.missionBlocked).toBe(false);
    expect(moved.stale).toHaveLength(1);
    expect(moved.blocking).toHaveLength(0);
    // Absence of a current context is also treated as stale, never silent blocking.
    expect(evaluateMissionExceptions(db, "t1", "m1").missionBlocked).toBe(false);
  });

  it("re-affirming a stale exception against the current snapshot blocks again", () => {
    const db = fixture();
    const e = raise(db, { observedAgainst: snapA });
    reaffirmMissionException(db, { tenantId: "t1", priorExceptionId: e.id, blocking: true,
      observedAgainst: snapB, actorPrincipalId: "p1", correlationId: "corr", createdAt: "2026-01-04T00:00:00.000Z" });
    expect(evaluateMissionExceptions(db, "t1", "m1", snapB).missionBlocked).toBe(true);
    // The original, now superseded, is no longer a live head.
    expect(evaluateMissionExceptions(db, "t1", "m1", snapB).stale).toHaveLength(0);
  });

  it("withdraws an exception without re-affirmation and it stops blocking", () => {
    const db = fixture();
    const e = raise(db);
    withdrawMissionException(db, { tenantId: "t1", priorExceptionId: e.id, rationale: "never applied",
      actorPrincipalId: "p1", correlationId: "corr", createdAt: "2026-01-03T00:00:00.000Z" });
    const evalResult = evaluateMissionExceptions(db, "t1", "m1");
    expect(evalResult.missionBlocked).toBe(false);
    expect(evalResult.withdrawn).toHaveLength(1);
  });

  it("refuses to close the same exception twice", () => {
    const db = fixture();
    const e = raise(db);
    resolveMissionException(db, { tenantId: "t1", priorExceptionId: e.id, resolutionNote: "done",
      actorPrincipalId: "p1", correlationId: "corr", createdAt: "2026-01-03T00:00:00.000Z" });
    expect(() => withdrawMissionException(db, { tenantId: "t1", priorExceptionId: e.id, rationale: "x",
      actorPrincipalId: "p1", correlationId: "corr", createdAt: "2026-01-04T00:00:00.000Z" }))
      .toThrow(/already_superseded/);
  });

  it("rejects a snapshot binding that does not match the immutable snapshot", () => {
    const db = fixture();
    expect(() => raiseMissionException(db, { tenantId: "t1", missionId: "m1", reason: "r", impact: "i",
      ownerPrincipalId: "p1", resolutionPath: "path", blocking: true,
      observedAgainst: { snapshotId: "snapA", resolvedSha: "wrong" }, correlationId: "corr", createdAt: T0 }))
      .toThrow(/snapshot_binding_mismatch/);
  });

  // CONTROL: append-only.
  it("is append-only: UPDATE and DELETE are rejected", () => {
    const db = fixture();
    const e = raise(db);
    expect(() => db.raw.prepare(`UPDATE mission_exceptions SET status = 'resolved' WHERE id = ?`).run(e.id)).toThrow(/append_only/);
    expect(() => db.raw.prepare(`DELETE FROM mission_exceptions WHERE id = ?`).run(e.id)).toThrow(/append_only/);
  });

  // CONTROL: cross-tenant read structurally impossible.
  it("makes cross-tenant collision structurally impossible", () => {
    const db = fixture();
    const e1 = raise(db);
    const e2 = raiseMissionException(db, { tenantId: "t2", missionId: "m2",
      reason: "payments-svc cannot migrate yet", impact: "blocks wave 2", ownerPrincipalId: "p2",
      resolutionPath: "await vendor SDK 3.0", blocking: true, correlationId: "corr", createdAt: T0 });
    expect(e1.id).not.toBe(e2.id);
    expect(() => raiseMissionException(db, { tenantId: "t1", missionId: "m2", reason: "r", impact: "i",
      ownerPrincipalId: "p1", resolutionPath: "p", blocking: true, correlationId: "corr", createdAt: T0 }))
      .toThrow(/mission_not_found/);
    expect(listMissionExceptions(db, "t1", "m1").map((x) => x.id)).not.toContain(e2.id);
  });
});
