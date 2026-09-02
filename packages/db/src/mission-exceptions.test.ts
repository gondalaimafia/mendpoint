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

function insertMissionDispatch(
  db: AppDb,
  state: "authorized" | "dispatching" | "uncertain",
  suffix: string,
  tenantId = "t1",
  missionId = "m1",
) {
  db.raw.prepare(`INSERT INTO mission_mutation_dispatches
    (id, tenant_id, mission_id, job_id, mutation_kind, aggregate_id, authority_json,
     intent_digest, state, lease_owner, lease_generation, authorized_at, dispatching_at,
     uncertain_at, updated_at)
    VALUES (?, ?, ?, ?, 'fettler_candidate_delivery', ?, '{}', ?, ?, 'worker-1', 1, ?, ?, ?, ?)`)
    .run(`dispatch-${suffix}`, tenantId, missionId, `job-${suffix}`, `aggregate-${suffix}`,
      `sha256:${"e".repeat(64)}`, state, T0, state === "dispatching" ? T0 : null,
      state === "uncertain" ? T0 : null, T0);
}

function dispatchState(db: AppDb, suffix: string): string {
  return (db.raw.prepare(`SELECT state FROM mission_mutation_dispatches WHERE id = ?`)
    .get(`dispatch-${suffix}`) as { state: string }).state;
}

function exceptionEventCount(db: AppDb, tenantId = "t1", missionId = "m1"): number {
  return (db.raw.prepare(`SELECT COUNT(*) AS count FROM domain_events
    WHERE tenant_id = ? AND aggregate_type = 'mission' AND aggregate_id = ?
      AND event_type LIKE 'mission.exception_%'`).get(tenantId, missionId) as { count: number }).count;
}

describe("mission exception register", () => {
  // NOT A MUTATION-KILLING TEST, and it must not be presented as one. Removing
  // the tenant predicate at the id lookup leaves this GREEN, because the row id
  // IS its content digest and that digest covers tenant_id, so hydrate() rejects
  // any foreign row with mission_exception_corrupt before it can be returned.
  // The predicate is defense-in-depth for the day the id scheme changes; what
  // this test actually pins is the guarantee underneath it — a planted foreign
  // row is never handed back to this tenant, by either route.
  it("never hands a caller another tenant's exception row for the same record id", () => {
    const db = fixture();
    const input = {
      tenantId: "t1", missionId: "m1", reason: "policy_exception",
      impact: "A policy blocker forbids remote mutation.",
      ownerPrincipalId: "p1", resolutionPath: "Resolve the policy exception.",
      blocking: true, correlationId: "corr", createdAt: T0,
    } as const;
    // The record id is a content digest of the input, so the SAME input yields
    // the same id in any database. Learn it here, then plant a row under the
    // other tenant carrying that id in a fresh database. The table is
    // append-only, so this is the only way to construct the collision at all.
    const raised = raiseMissionException(db, input);

    const other = fixture();
    other.raw.prepare(`INSERT INTO mission_exceptions
      (id, tenant_id, mission_id, reason, impact, owner_principal_id, resolution_path,
       blocking, status, content_digest, created_at)
      VALUES (?, 't2', 'm2', 'policy_exception', 'Another tenant entirely.', 'p2',
        'Resolve it over there.', 1, 'open', ?, ?)`)
      .run(raised.id, "f".repeat(64), T0);

    let returned: ReturnType<typeof raiseMissionException> | undefined;
    try { returned = raiseMissionException(other, input); } catch { /* failing closed is fine */ }

    // What must never happen is t1 receiving t2's row.
    expect(returned?.tenantId).not.toBe("t2");
    expect(returned === undefined || returned.tenantId === "t1").toBe(true);
  });

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

  it("carries task_id and category onto a resolved head, not only into history", () => {
    const db = fixture();
    const raised = raiseMissionException(db, { tenantId: "t1", missionId: "m1",
      reason: "graph incomplete for payments", impact: "cannot plan edits", ownerPrincipalId: "p1",
      resolutionPath: "await_human_resolution", blocking: true, correlationId: "corr", createdAt: T0,
      taskId: "task-7", category: "graph_incomplete" });
    const resolved = resolveMissionException(db, { tenantId: "t1", priorExceptionId: raised.id,
      resolutionNote: "graph reindexed", actorPrincipalId: "p1", correlationId: "corr",
      createdAt: "2026-01-03T00:00:00.000Z" });
    // The resolving row is the new head; it must keep the annotation rather than
    // reading back with a NULL category once the exception is closed.
    expect(resolved.taskId).toBe("task-7");
    expect(resolved.category).toBe("graph_incomplete");
    const head = listMissionExceptions(db, "t1", "m1").find((row) => row.supersededById === null)!;
    expect(head.id).toBe(resolved.id);
    expect(head.category).toBe("graph_incomplete");
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

  it("keeps an exact stale blocking raise replay independent from newer dispatch authority", () => {
    const db = fixture();
    const original = raise(db, { observedAgainst: snapA });
    expect(evaluateMissionExceptions(db, "t1", "m1", snapB).missionBlocked).toBe(false);
    insertMissionDispatch(db, "authorized", "raise-stale-replay");
    const beforeEvents = exceptionEventCount(db);

    const replay = raise(db, { observedAgainst: snapA });

    expect(replay).toEqual(original);
    expect(dispatchState(db, "raise-stale-replay")).toBe("authorized");
    expect(exceptionEventCount(db)).toBe(beforeEvents);
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

  it("revokes authorized Mission mutation authority before reaffirming a blocking head", () => {
    const db = fixture();
    const prior = raise(db, { observedAgainst: snapA });
    insertMissionDispatch(db, "authorized", "reaffirm-authorized");

    const reaffirmed = reaffirmMissionException(db, { tenantId: "t1", priorExceptionId: prior.id,
      blocking: true, observedAgainst: snapB, actorPrincipalId: "p1", correlationId: "corr",
      createdAt: "2026-01-04T00:00:00.000Z" });

    expect(reaffirmed.supersedesId).toBe(prior.id);
    expect(dispatchState(db, "reaffirm-authorized")).toBe("revoked");
    expect(evaluateMissionExceptions(db, "t1", "m1", snapB).blocking).toHaveLength(1);
  });

  it.each(["dispatching", "uncertain"] as const)(
    "rolls back a blocking reaffirmation while a Mission mutation is %s",
    (state) => {
      const db = fixture();
      const prior = raise(db, { observedAgainst: snapA });
      insertMissionDispatch(db, state, `reaffirm-${state}`);
      const beforeRows = listMissionExceptions(db, "t1", "m1");
      const beforeEvents = exceptionEventCount(db);

      expect(() => reaffirmMissionException(db, { tenantId: "t1", priorExceptionId: prior.id,
        blocking: true, observedAgainst: snapB, actorPrincipalId: "p1", correlationId: "corr",
        createdAt: "2026-01-04T00:00:00.000Z" }))
        .toThrow("mission_mutation_dispatch_in_flight");

      expect(dispatchState(db, `reaffirm-${state}`)).toBe(state);
      expect(listMissionExceptions(db, "t1", "m1")).toEqual(beforeRows);
      expect(exceptionEventCount(db)).toBe(beforeEvents);
      expect(evaluateMissionExceptions(db, "t1", "m1", snapB)).toMatchObject({
        missionBlocked: false,
        blocking: [],
      });
      expect(evaluateMissionExceptions(db, "t1", "m1", snapB).stale).toHaveLength(1);
    },
  );

  it("fences only the exact tenant and Mission during blocking reaffirmation", () => {
    const db = fixture();
    const prior = raise(db, { observedAgainst: snapA });
    insertMissionDispatch(db, "authorized", "reaffirm-exact");
    insertMissionDispatch(db, "dispatching", "reaffirm-sibling-tenant", "t2", "m2");

    reaffirmMissionException(db, { tenantId: "t1", priorExceptionId: prior.id, blocking: true,
      observedAgainst: snapB, actorPrincipalId: "p1", correlationId: "corr",
      createdAt: "2026-01-04T00:00:00.000Z" });

    expect(dispatchState(db, "reaffirm-exact")).toBe("revoked");
    expect(dispatchState(db, "reaffirm-sibling-tenant")).toBe("dispatching");
  });

  it("does not touch dispatch authority when reaffirmation snapshot validation fails", () => {
    const db = fixture();
    const prior = raise(db, { observedAgainst: snapA });
    insertMissionDispatch(db, "authorized", "reaffirm-snapshot-invalid");
    const beforeRows = listMissionExceptions(db, "t1", "m1");
    const beforeEvents = exceptionEventCount(db);

    expect(() => reaffirmMissionException(db, { tenantId: "t1", priorExceptionId: prior.id,
      blocking: true, observedAgainst: { ...snapB, resolvedSha: "f".repeat(40) },
      actorPrincipalId: "p1", correlationId: "corr", createdAt: "2026-01-04T00:00:00.000Z" }))
      .toThrow("mission_exception_snapshot_binding_mismatch");

    expect(dispatchState(db, "reaffirm-snapshot-invalid")).toBe("authorized");
    expect(listMissionExceptions(db, "t1", "m1")).toEqual(beforeRows);
    expect(exceptionEventCount(db)).toBe(beforeEvents);
  });

  it("keeps nonblocking reaffirmation and exact replay independent from dispatch fencing", () => {
    const db = fixture();
    const prior = raise(db, { blocking: false, observedAgainst: snapA });
    insertMissionDispatch(db, "dispatching", "reaffirm-nonblocking");
    const reaffirmed = reaffirmMissionException(db, { tenantId: "t1", priorExceptionId: prior.id,
      blocking: false, observedAgainst: snapB, actorPrincipalId: "p1", correlationId: "corr",
      createdAt: "2026-01-04T00:00:00.000Z" });
    expect(reaffirmed.blocking).toBe(false);
    expect(dispatchState(db, "reaffirm-nonblocking")).toBe("dispatching");

    const replayDb = fixture();
    const replayPrior = raise(replayDb, { observedAgainst: snapA });
    reaffirmMissionException(replayDb, { tenantId: "t1", priorExceptionId: replayPrior.id,
      blocking: true, observedAgainst: snapB, actorPrincipalId: "p1", correlationId: "corr",
      createdAt: "2026-01-04T00:00:00.000Z" });
    insertMissionDispatch(replayDb, "authorized", "reaffirm-replay");
    expect(() => reaffirmMissionException(replayDb, { tenantId: "t1", priorExceptionId: replayPrior.id,
      blocking: true, observedAgainst: snapB, actorPrincipalId: "p1", correlationId: "corr",
      createdAt: "2026-01-04T00:00:00.000Z" }))
      .toThrow("mission_exception_already_superseded");
    expect(dispatchState(replayDb, "reaffirm-replay")).toBe("authorized");
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
