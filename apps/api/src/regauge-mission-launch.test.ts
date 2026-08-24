import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  insertPrincipal,
  linkRegaugeCampaignToMission,
  listDomainEvents,
  regaugeMissionId,
  resolveMissionForRegaugeCampaign,
  verifyDomainEventIntegrity,
  type AppDb,
} from "@mendpoint/db";
import { bindRegaugeMissionAtLaunch } from "./regauge-production-bootstrap-runtime.js";

// Focused coverage of the FAIL-CLOSED scope guard and idempotent-replay behaviour
// of the launch-seam mission binding. The single-repository BOUND path (a mission
// carrying the exact verified snapshot) is exercised end to end on the real
// production recipe in regauge-production-bootstrap-runtime.test.ts; here we lock
// the branches that test cannot reach without a synthetic multi-repository launch.

const opened: Array<{ db: AppDb; dir: string }> = [];
const AT = "2026-08-14T17:00:00.000Z";

function fixture(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-regauge-mission-launch-"));
  const db = createDb(join(dir, "app.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES ('t1', 'one', 'One', 'team', 'active', 10, '2026-01-01T00:00:00.000Z')`,
  ).run();
  insertPrincipal(db, {
    id: "svc-bootstrap",
    tenantId: "t1",
    kind: "service",
    subject: "service:regauge-production-bootstrap",
    displayName: "Bootstrap",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  insertPrincipal(db, {
    id: "human-owner",
    tenantId: "t1",
    kind: "human",
    subject: "owner@example.com",
    displayName: "Owner",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  db.raw.prepare(`INSERT INTO scm_connections
    (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
    VALUES ('connection-a', 't1', 'github', 'secret://github/app', 'account-a', 'GitHub', ?, ?)`)
    .run(AT, AT);
  db.raw.prepare(`INSERT INTO connected_repositories
    (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
     environment, retention_days, status, created_at, updated_at)
    VALUES ('repo-exact', 't1', 'connection-a', '99', 'acme', 'repo', 'main', 'main',
      'production', 30, 'ready', ?, ?)`)
    .run(AT, AT);
  db.raw.prepare(`INSERT INTO repository_snapshots
    (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
     submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
    VALUES ('snapshot-exact', 't1', 'repo-exact', 'main', ?, ?, '/snapshots/exact', 'reject',
      'pointer_only', '[]', 1, ?, '2026-08-15T17:00:00.000Z')`)
    .run("a".repeat(40), "b".repeat(64), AT);
  return db;
}

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("bindRegaugeMissionAtLaunch", () => {
  it("advances the mission out of created to executing on a launch", () => {
    const db = fixture();
    bindRegaugeMissionAtLaunch(db, {
      tenantId: "t1",
      campaignId: "campaign-a",
      ownerPrincipalId: "svc-bootstrap",
      objective: "Runtime upgrade to Node 22",
      // Two repositories that intentionally do not exist as connected rows: with
      // the fail-closed guard they are never bound, so no validation is needed.
      repositories: [
        { repositoryId: "repo-a", snapshotId: "snap-a" },
        { repositoryId: "repo-b", snapshotId: "snap-b" },
      ],
      createdAt: AT,
    });
    const mission = resolveMissionForRegaugeCampaign(db, "t1", "campaign-a");
    expect(mission?.state).toBe("executing");
    expect(mission?.objective).toBe("Runtime upgrade to Node 22");
  });

  it("binds NEITHER repository nor snapshot for a multi-repository campaign (fail closed)", () => {
    const db = fixture();
    bindRegaugeMissionAtLaunch(db, {
      tenantId: "t1",
      campaignId: "campaign-multi",
      ownerPrincipalId: "svc-bootstrap",
      objective: "Multi-repo upgrade",
      repositories: [
        { repositoryId: "repo-a", snapshotId: "snap-a" },
        { repositoryId: "repo-b", snapshotId: "snap-b" },
      ],
      createdAt: AT,
    });
    const mission = resolveMissionForRegaugeCampaign(db, "t1", "campaign-multi");
    // A single repository_id/snapshot_id cannot honestly represent two
    // repositories, so both stay null rather than privileging one.
    expect(mission?.repositoryId).toBeNull();
    expect(mission?.snapshotId).toBeNull();
    expect(mission?.state).toBe("executing");
  });

  it("binds NEITHER repository nor snapshot when no repository launched (fail closed)", () => {
    const db = fixture();
    bindRegaugeMissionAtLaunch(db, {
      tenantId: "t1",
      campaignId: "campaign-none",
      ownerPrincipalId: "svc-bootstrap",
      objective: "No repo",
      repositories: [],
      createdAt: AT,
    });
    const mission = resolveMissionForRegaugeCampaign(db, "t1", "campaign-none");
    expect(mission?.repositoryId).toBeNull();
    expect(mission?.snapshotId).toBeNull();
    expect(mission?.state).toBe("executing");
  });

  it("is idempotent on replay and keeps the domain-event chain verifiable", () => {
    const db = fixture();
    const args = {
      tenantId: "t1",
      campaignId: "campaign-replay",
      ownerPrincipalId: "svc-bootstrap",
      objective: "Replay",
      repositories: [{ repositoryId: "repo-a", snapshotId: "snap-a" }, { repositoryId: "repo-b", snapshotId: "snap-b" }],
      createdAt: AT,
    } as const;
    bindRegaugeMissionAtLaunch(db, args);
    // A replayed launch must not throw (no CAS conflict, no illegal transition)
    // and must not double-advance the mission.
    expect(() => bindRegaugeMissionAtLaunch(db, args)).not.toThrow();
    const mission = resolveMissionForRegaugeCampaign(db, "t1", "campaign-replay");
    expect(mission?.state).toBe("executing");
    // created(1) -> discovering -> scoped -> planning -> executing, plus the
    // set-once Policy Envelope bind. 6 and not 7 is the idempotency this test
    // exists to prove: the replayed launch does not rebind the envelope.
    expect(mission?.revision).toBe(6);
    expect(verifyDomainEventIntegrity(db, "t1").ok).toBe(true);
    const transitions = listDomainEvents(db, "t1", "mission", mission!.id)
      .filter((event) => event.event_type === "mission.transitioned");
    expect(transitions).toHaveLength(4);
  });

  it("reuses the control-plane mission instead of conflicting with its human owner", () => {
    const db = fixture();
    const campaignId = "campaign-control-plane";
    const missionId = regaugeMissionId("t1", campaignId);
    createMission(db, {
      id: missionId,
      tenantId: "t1",
      product: "regauge",
      triggerKind: "migration_objective",
      objective: "Runtime upgrade to Node 22",
      ownerPrincipalId: "human-owner",
      eventId: `${missionId}-created`,
      idempotencyKey: `mission-create-${missionId}`,
      correlationId: campaignId,
      createdAt: AT,
    });
    linkRegaugeCampaignToMission(db, {
      tenantId: "t1",
      missionId,
      regaugeCampaignId: campaignId,
      actorPrincipalId: "human-owner",
      eventId: `${missionId}-linked`,
      idempotencyKey: `mission-link-${missionId}`,
      correlationId: campaignId,
      createdAt: AT,
    });

    expect(() => bindRegaugeMissionAtLaunch(db, {
      tenantId: "t1",
      campaignId,
      ownerPrincipalId: "svc-bootstrap",
      objective: "Runtime upgrade to Node 22",
      repositories: [{ repositoryId: "repo-exact", snapshotId: "snapshot-exact" }],
      createdAt: AT,
    })).not.toThrow();
    const mission = resolveMissionForRegaugeCampaign(db, "t1", campaignId);
    expect(mission?.ownerPrincipalId).toBe("human-owner");
    expect(mission?.repositoryId).toBe("repo-exact");
    expect(mission?.snapshotId).toBe("snapshot-exact");
    expect(mission?.state).toBe("executing");
  });
});
