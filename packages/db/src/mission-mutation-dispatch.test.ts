import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, insertPrincipal, type AppDb } from "./index.js";
import { bindMissionScope, createMission, getMission } from "./mission.js";
import {
  assertMissionMutationAuthority,
  createMissionMutationAuthority,
  type MissionMutationAuthorityV1,
} from "./mission-mutation-authority.js";
import {
  authorizeMissionMutationDispatch,
  beginMissionMutationRemoteCall,
  settleMissionMutationDispatch,
} from "./mission-mutation-dispatch.js";
import {
  revokePendingMissionMutationDispatches,
  revokePendingMissionTaskMutationDispatches,
} from "./mission-mutation-dispatch-fence.js";

const NOW = "2026-08-06T12:00:00.000Z";
const LATER = "2026-08-06T12:00:01.000Z";
const SHA = "a".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}`;
const opened: Array<{ db: AppDb; directory: string }> = [];

/** One tenant with a scoped, active Fettler Mission. */
function seedTenant(db: AppDb, tenant: string, suffix: string) {
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES (?, ?, ?, 'team', 'active', 10, ?)`,
  ).run(tenant, tenant, tenant, NOW);
  insertPrincipal(db, { id: `owner-${suffix}`, tenantId: tenant, kind: "human",
    subject: `owner-${suffix}@example.com`, displayName: "Owner", createdAt: NOW });
  db.raw.prepare(`INSERT INTO scm_connections
    (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
    VALUES (?, ?, 'github', 'app://1', '1', 'GitHub', ?, ?)`).run(`scm-${suffix}`, tenant, NOW, NOW);
  db.raw.prepare(`INSERT INTO connected_repositories
    (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
     environment, retention_days, status, created_at, updated_at)
    VALUES (?, ?, ?, '1', 'acme', 'sdk', 'main', 'main', 'production', 30, 'ready', ?, ?)`)
    .run(`repo-${suffix}`, tenant, `scm-${suffix}`, NOW, NOW);
  db.raw.prepare(`INSERT INTO repository_snapshots
    (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
     submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
    VALUES (?, ?, ?, 'main', ?, ?, 'C:\\snapshot', 'reject', 'reject', '[]', 1, ?,
     '2099-01-01T00:00:00.000Z')`)
    .run(`snapshot-${suffix}`, tenant, `repo-${suffix}`, SHA, `sha256:${"b".repeat(64)}`, NOW);
  createMission(db, { id: `mission-${suffix}`, tenantId: tenant, product: "fettler",
    triggerKind: "provider_change", objective: "Repair SDK", ownerPrincipalId: `owner-${suffix}`,
    eventId: `e-mission-${suffix}`, idempotencyKey: `c-mission-${suffix}`,
    correlationId: "corr", createdAt: NOW });
  bindMissionScope(db, { tenantId: tenant, missionId: `mission-${suffix}`,
    repositoryId: `repo-${suffix}`, snapshotId: `snapshot-${suffix}`,
    actorPrincipalId: `owner-${suffix}`, eventId: `e-scope-${suffix}`,
    idempotencyKey: `c-scope-${suffix}`, correlationId: "corr", createdAt: NOW });
  const mission = getMission(db, tenant, `mission-${suffix}`)!;
  return {
    mission,
    authority: createMissionMutationAuthority({ mission, task: null,
      repositoryId: `repo-${suffix}`, snapshotId: `snapshot-${suffix}`, resolvedSha: SHA }),
  };
}

/** A claimed job holding a live lease, which is what assertLease requires. */
function leaseJob(db: AppDb, tenant: string, jobId: string, workerId: string, generation: number) {
  db.raw.prepare(
    `INSERT INTO jobs (id, tenant_id, type, payload_json, status, attempts, max_attempts,
       created_at, available_at, lease_owner, lease_expires_at, lease_generation)
     VALUES (?, ?, 'warden.candidate.deliver', '{}', 'running', 1, 5, ?, ?, ?,
       '2099-01-01T00:00:00.000Z', ?)`,
  ).run(jobId, tenant, NOW, NOW, workerId, generation);
}

function handOverLease(db: AppDb, tenant: string, jobId: string, workerId: string, generation: number) {
  db.raw.prepare(
    `UPDATE jobs SET lease_owner = ?, lease_generation = ? WHERE id = ? AND tenant_id = ?`,
  ).run(workerId, generation, jobId, tenant);
}

/** A raw cross-tenant row, to prove each statement is tenant-scoped. */
function foreignDispatch(db: AppDb, input: Readonly<{
  tenant: string; missionId: string; jobId: string; state: string;
  authority: MissionMutationAuthorityV1; intentDigest?: string;
}>) {
  db.raw.prepare(`INSERT INTO mission_mutation_dispatches
    (id, tenant_id, mission_id, job_id, mutation_kind, aggregate_id, authority_json,
     intent_digest, state, lease_owner, lease_generation, authorized_at, dispatching_at, updated_at)
    VALUES (?, ?, ?, ?, 'fettler_candidate_delivery', 'delivery-foreign', ?, ?, ?,
     'worker-foreign', 1, ?, ?, ?)`).run(
    `mission-dispatch:${input.tenant}:${input.jobId}`, input.tenant, input.missionId, input.jobId,
    JSON.stringify(input.authority), input.intentDigest ?? DIGEST, input.state, NOW, NOW, NOW,
  );
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-mission-dispatch-"));
  const db = createDb(join(directory, "test.sqlite"));
  opened.push({ db, directory });
  const a = seedTenant(db, "tenant-a", "a");
  const b = seedTenant(db, "tenant-b", "b");
  return { db, a, b };
}

afterEach(() => {
  while (opened.length) {
    const entry = opened.pop()!;
    entry.db.raw.close();
    rmSync(entry.directory, { recursive: true, force: true });
  }
});

describe("Mission mutation dispatch tenant scope", () => {
  // Kills: dropping tenant_id from the mission-wide in-flight SELECT.
  it("does not read another tenant's in-flight dispatch as this Mission's in-flight fence", () => {
    const { db, a, b } = fixture();
    foreignDispatch(db, { tenant: "tenant-b", missionId: a.mission.id, jobId: "job-cross-1",
      state: "dispatching", authority: b.authority });

    expect(() => revokePendingMissionMutationDispatches(db, "tenant-a", a.mission.id, LATER))
      .not.toThrow();
    expect(db.raw.prepare(`SELECT state FROM mission_mutation_dispatches WHERE tenant_id = 'tenant-b'`)
      .get()).toEqual({ state: "dispatching" });
  });

  // Kills: dropping tenant_id from the task-scoped fence SELECT.
  it("does not read another tenant's in-flight dispatch as this task's in-flight fence", () => {
    const { db, a, b } = fixture();
    foreignDispatch(db, { tenant: "tenant-b", missionId: a.mission.id, jobId: "job-cross-2",
      state: "uncertain", authority: b.authority });

    expect(() => revokePendingMissionTaskMutationDispatches(db, "tenant-a", a.mission.id, null, LATER))
      .not.toThrow();
    expect(db.raw.prepare(`SELECT state FROM mission_mutation_dispatches WHERE tenant_id = 'tenant-b'`)
      .get()).toEqual({ state: "uncertain" });
  });

  // Kills: dropping tenant_id from the dispatch row() lookup.
  it("does not treat another tenant's row for the same job id as this tenant's prior dispatch", () => {
    const { db, a, b } = fixture();
    leaseJob(db, "tenant-a", "job-shared", "worker-a", 1);
    foreignDispatch(db, { tenant: "tenant-b", missionId: b.mission.id, jobId: "job-shared",
      state: "authorized", authority: b.authority });

    expect(authorizeMissionMutationDispatch(db, { tenantId: "tenant-a", jobId: "job-shared",
      mutationKind: "fettler_candidate_delivery", aggregateId: "delivery-a", authority: a.authority,
      intentDigest: DIGEST, workerId: "worker-a", leaseGeneration: 1, observedAt: LATER,
    })).toBe("authorized");
    expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM mission_mutation_dispatches`).get())
      .toEqual({ n: 2 });
  });

  // Kills: dropping tenant_id from the settle UPDATE.
  it("cannot settle another tenant's dispatch row", () => {
    const { db, a, b } = fixture();
    foreignDispatch(db, { tenant: "tenant-b", missionId: b.mission.id, jobId: "job-settle",
      state: "dispatching", authority: b.authority });

    expect(() => settleMissionMutationDispatch(db, { tenantId: "tenant-a", jobId: "job-settle",
      intentDigest: DIGEST, observedAt: LATER }))
      .toThrow("mission_mutation_dispatch_settlement_conflict");
    expect(db.raw.prepare(`SELECT state FROM mission_mutation_dispatches WHERE tenant_id = 'tenant-b'`)
      .get()).toEqual({ state: "dispatching" });
    expect(a.mission.id).not.toEqual(b.mission.id);
  });

  // Kills: deleting the mission.revision !== authority.missionRevision predicate.
  // ONLY the revision differs here, so no other predicate can reject it.
  it("refuses authority whose Mission revision has moved on", () => {
    const { db, a } = fixture();
    leaseJob(db, "tenant-a", "job-revision", "worker-a", 1);
    const stale = createMissionMutationAuthority({
      mission: { ...a.mission, revision: a.mission.revision + 1 },
      task: null, repositoryId: "repo-a", snapshotId: "snapshot-a", resolvedSha: SHA,
    });

    expect(() => assertMissionMutationAuthority(db, "tenant-a", stale))
      .toThrow("mission_mutation_authority_stale");
    expect(() => authorizeMissionMutationDispatch(db, { tenantId: "tenant-a", jobId: "job-revision",
      mutationKind: "fettler_candidate_delivery", aggregateId: "delivery-a", authority: stale,
      intentDigest: DIGEST, workerId: "worker-a", leaseGeneration: 1, observedAt: LATER,
    })).toThrow("mission_mutation_authority_stale");
  });
});

describe("Mission mutation dispatch fence, unreadable authority", () => {
  // Plant a dispatch row whose authority_json cannot be read as an authority.
  function corruptDispatch(db: AppDb, missionId: string, jobId: string, authorityJson: string) {
    db.raw.prepare(`INSERT INTO mission_mutation_dispatches
      (id, tenant_id, mission_id, job_id, mutation_kind, aggregate_id, authority_json,
       intent_digest, state, lease_owner, lease_generation, authorized_at, dispatching_at, updated_at)
      VALUES (?, 'tenant-a', ?, ?, 'fettler_candidate_delivery', 'agg-corrupt', ?, ?,
        'dispatching', 'worker-a', 1, ?, ?, ?)`).run(
      `mission-dispatch:${jobId}`, missionId, jobId, authorityJson, DIGEST, NOW, NOW, NOW,
    );
  }

  // THE FAIL-OPEN THIS GUARDS. `authorityTaskId` returning null for a row it
  // cannot parse is not the same as null meaning "mission-scoped, no task" - and
  // the task fence filters on `authorityTaskId(row) === taskId`, so an unreadable
  // `dispatching` row would simply drop out of the match set and STOP FENCING the
  // task. A remote mutation would then be armed against a Mission task that
  // already has one in flight. Turning any of the three throws into `return null`
  // kills one of these.
  it.each([
    ["unparseable json", "{not json"],
    ["not an object", '"a string"'],
    ["no taskId key", '{"missionId":"mission-a"}'],
    ["taskId of the wrong type", '{"taskId":42}'],
    ["blank taskId", '{"taskId":"   "}'],
  ])("keeps fencing a task when a dispatch row's authority is %s", (_label, authorityJson) => {
    const { db, a } = fixture();
    corruptDispatch(db, a.mission.id, "job-corrupt", authorityJson);

    // Fails CLOSED: the caller cannot proceed as though nothing were in flight.
    expect(() => revokePendingMissionTaskMutationDispatches(
      db, "tenant-a", a.mission.id, "task-anything", LATER,
    )).toThrow("mission_mutation_dispatch_authority_invalid");

    // ...and the in-flight row is left exactly as it was, never silently skipped.
    expect(db.raw.prepare("SELECT state FROM mission_mutation_dispatches WHERE job_id = 'job-corrupt'")
      .get()).toEqual({ state: "dispatching" });
  });

  // CONTROL: a legitimately mission-scoped row (taskId null) is NOT an error, and
  // is correctly excluded from a task-scoped fence. This is the other half of the
  // third state, and it proves the throws above are about unreadability, not
  // about null itself.
  it("treats an explicitly task-less authority as mission-scoped, not unreadable", () => {
    const { db, a } = fixture();
    corruptDispatch(db, a.mission.id, "job-taskless", JSON.stringify({ ...a.authority, taskId: null }));

    expect(() => revokePendingMissionTaskMutationDispatches(
      db, "tenant-a", a.mission.id, "task-anything", LATER,
    )).not.toThrow();
    expect(db.raw.prepare("SELECT state FROM mission_mutation_dispatches WHERE job_id = 'job-taskless'")
      .get()).toEqual({ state: "dispatching" });
  });
});

describe("Mission mutation dispatch lease handover", () => {
  // S1: a lost lease is an ordinary handover with no remote call made. Revoking
  // there stranded the delivery for good, because the successor then got
  // mission_mutation_dispatch_revoked, which no retryable pattern matches.
  it("leaves an armed dispatch re-armable when the lease moves before the remote call", () => {
    const { db, a } = fixture();
    leaseJob(db, "tenant-a", "job-handover", "worker-a", 1);
    expect(authorizeMissionMutationDispatch(db, { tenantId: "tenant-a", jobId: "job-handover",
      mutationKind: "fettler_candidate_delivery", aggregateId: "delivery-a", authority: a.authority,
      intentDigest: DIGEST, workerId: "worker-a", leaseGeneration: 1, observedAt: NOW,
    })).toBe("authorized");

    handOverLease(db, "tenant-a", "job-handover", "worker-b", 2);

    expect(() => beginMissionMutationRemoteCall(db, { tenantId: "tenant-a", jobId: "job-handover",
      authority: a.authority, intentDigest: DIGEST, workerId: "worker-a", leaseGeneration: 1,
      observedAt: LATER })).toThrow("mission_mutation_dispatch_lease_lost");

    // Still armed, never revoked: the successor must be able to take it over.
    expect(db.raw.prepare(`SELECT state FROM mission_mutation_dispatches WHERE job_id = 'job-handover'`)
      .get()).toEqual({ state: "authorized" });
    expect(authorizeMissionMutationDispatch(db, { tenantId: "tenant-a", jobId: "job-handover",
      mutationKind: "fettler_candidate_delivery", aggregateId: "delivery-a", authority: a.authority,
      intentDigest: DIGEST, workerId: "worker-b", leaseGeneration: 2, observedAt: LATER,
    })).toBe("authorized");
    expect(() => beginMissionMutationRemoteCall(db, { tenantId: "tenant-a", jobId: "job-handover",
      authority: a.authority, intentDigest: DIGEST, workerId: "worker-b", leaseGeneration: 2,
      observedAt: LATER })).not.toThrow();
  });
});
