import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  insertPrincipal,
  listDomainEvents,
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
    expect(mission?.revision).toBe(5); // created(1) -> discovering -> scoped -> planning -> executing
    expect(verifyDomainEventIntegrity(db, "t1").ok).toBe(true);
    const transitions = listDomainEvents(db, "t1", "mission", mission!.id)
      .filter((event) => event.event_type === "mission.transitioned");
    expect(transitions).toHaveLength(4);
  });
});
