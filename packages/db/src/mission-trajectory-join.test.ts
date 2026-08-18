import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  insertPrincipal,
  linkRegaugeCampaignToMission,
  recordTrajectory,
  type AppDb,
} from "./index.js";

// The seam PR #191 could not close: a ReGauge delivery keys on
// candidate_id/attempt_id while trajectories key on run_id, so a ReGauge outcome
// could not be joined to the trajectory that produced it. With mission_id on both
// the trajectory and (transitively) the ReGauge lane, the join is:
//   regauge_adaptive_deliveries.candidate_id
//     -> regauge_adaptive_candidates.campaign_id
//     -> mission.regauge_campaign_id -> mission.id
//     -> trajectories.mission_id
// executed as a real, tenant-scoped query — not an assertion that a column is set.
const JOIN_SQL = `
  SELECT t.id AS trajectory_id, t.run_id AS run_id, t.mission_id AS mission_id
  FROM regauge_adaptive_deliveries d
  JOIN regauge_adaptive_candidates c
    ON c.id = d.candidate_id AND c.tenant_id = d.tenant_id
  JOIN mission m
    ON m.regauge_campaign_id = c.campaign_id AND m.tenant_id = d.tenant_id
  JOIN trajectories t
    ON t.mission_id = m.id AND t.tenant_id = d.tenant_id
  WHERE d.id = ? AND d.tenant_id = ?`;

const T0 = "2026-01-01T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-mission-join-"));
  const db = createDb(join(dir, "join.sqlite"));
  opened.push({ db, dir });
  db.raw
    .prepare(
      `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
       VALUES ('t1','one','One','team','active',10,?),('t2','two','Two','team','active',10,?)`,
    )
    .run(T0, T0);
  insertPrincipal(db, {
    id: "p1",
    tenantId: "t1",
    kind: "human",
    subject: "one@example.com",
    displayName: "One",
    createdAt: T0,
  });
  insertPrincipal(db, {
    id: "p2",
    tenantId: "t2",
    kind: "human",
    subject: "two@example.com",
    displayName: "Two",
    createdAt: T0,
  });
  return db;
}

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function regaugeMission(
  db: AppDb,
  o: { id: string; tenantId: string; principalId: string; campaignId: string },
) {
  createMission(db, {
    id: o.id,
    tenantId: o.tenantId,
    product: "regauge",
    triggerKind: "migration_objective",
    objective: "Runtime upgrade",
    ownerPrincipalId: o.principalId,
    eventId: `${o.id}-created`,
    idempotencyKey: `${o.id}-create`,
    correlationId: o.campaignId,
    createdAt: T0,
  });
  linkRegaugeCampaignToMission(db, {
    tenantId: o.tenantId,
    missionId: o.id,
    regaugeCampaignId: o.campaignId,
    actorPrincipalId: o.principalId,
    eventId: `${o.id}-linked`,
    idempotencyKey: `${o.id}-link`,
    correlationId: o.campaignId,
    createdAt: T0,
  });
}

function insertCandidate(
  db: AppDb,
  o: { tenantId: string; id: string; campaignId: string; unitId: string; attemptId: string },
) {
  db.raw
    .prepare(
      `INSERT INTO regauge_adaptive_candidates
        (id, tenant_id, campaign_id, unit_id, attempt_id, repository_id, snapshot_id, base_branch,
         expected_base_revision, kind, status, diverged_from_digest, candidate_digest, sealed_path,
         sealed_sha256, changed_paths_json, generation, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'repo', 'snap', 'main', 'rev', 'adaptive', 'review_pending',
               'df', 'cd', '/sealed', ?, '[]', 1, ?, ?, ?)`,
    )
    .run(o.id, o.tenantId, o.campaignId, o.unitId, o.attemptId, "a".repeat(64), T0, T0, T0);
}

function insertDelivery(
  db: AppDb,
  o: { tenantId: string; id: string; candidateId: string; jobId: string; outcome?: string },
) {
  db.raw
    .prepare(
      `INSERT INTO regauge_adaptive_deliveries
        (id, tenant_id, candidate_id, job_id, status, repository_id, snapshot_id, base_branch,
         expected_base_revision, draft_pr_number, requester_principal_id, requested_at, outcome,
         outcome_at, outcome_source, updated_at)
       VALUES (?, ?, ?, ?, 'delivered', 'repo', 'snap', 'main', 'rev', 7, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.id,
      o.tenantId,
      o.candidateId,
      o.jobId,
      o.tenantId === "t1" ? "p1" : "p2",
      T0,
      o.outcome ?? null,
      o.outcome ? T0 : null,
      o.outcome ? "github" : null,
      T0,
    );
}

describe("ReGauge delivery-to-trajectory join through mission_id", () => {
  it("joins a delivery outcome to the trajectory that produced it", () => {
    const db = fixture();
    regaugeMission(db, { id: "m1", tenantId: "t1", principalId: "p1", campaignId: "camp-1" });
    insertCandidate(db, {
      tenantId: "t1",
      id: "cand-1",
      campaignId: "camp-1",
      unitId: "u1",
      attemptId: "att-1",
    });
    insertDelivery(db, {
      tenantId: "t1",
      id: "del-1",
      candidateId: "cand-1",
      jobId: "job-1",
      outcome: "merged",
    });
    recordTrajectory(db, {
      id: "traj-1",
      tenantId: "t1",
      product: "regauge",
      taskKind: "regauge.adaptive_candidate",
      taskSummary: "Adaptive candidate for unit u1",
      missionId: "m1",
      runId: "att-1",
      finalOutcome: "candidate_review_pending",
      createdAt: T0,
    });

    const rows = db.raw.prepare(JOIN_SQL).all("del-1", "t1") as Array<{
      trajectory_id: string;
      run_id: string | null;
      mission_id: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trajectory_id: "traj-1", run_id: "att-1", mission_id: "m1" });

    // The delivery's own recorded outcome is what the join starts from.
    const outcome = db.raw
      .prepare(`SELECT outcome FROM regauge_adaptive_deliveries WHERE id = ? AND tenant_id = ?`)
      .get("del-1", "t1") as { outcome: string };
    expect(outcome.outcome).toBe("merged");
  });

  it("keeps the join tenant-scoped even when two tenants share a campaign id", () => {
    const db = fixture();
    regaugeMission(db, { id: "m1", tenantId: "t1", principalId: "p1", campaignId: "camp-shared" });
    regaugeMission(db, { id: "m2", tenantId: "t2", principalId: "p2", campaignId: "camp-shared" });
    insertCandidate(db, {
      tenantId: "t1",
      id: "cand-1",
      campaignId: "camp-shared",
      unitId: "u1",
      attemptId: "att-1",
    });
    insertCandidate(db, {
      tenantId: "t2",
      id: "cand-2",
      campaignId: "camp-shared",
      unitId: "u1",
      attemptId: "att-2",
    });
    insertDelivery(db, {
      tenantId: "t1",
      id: "del-1",
      candidateId: "cand-1",
      jobId: "job-1",
      outcome: "merged",
    });
    recordTrajectory(db, {
      id: "traj-1",
      tenantId: "t1",
      product: "regauge",
      taskKind: "k",
      taskSummary: "s",
      missionId: "m1",
      runId: "att-1",
      createdAt: T0,
    });
    recordTrajectory(db, {
      id: "traj-2",
      tenantId: "t2",
      product: "regauge",
      taskKind: "k",
      taskSummary: "s",
      missionId: "m2",
      runId: "att-2",
      createdAt: T0,
    });

    const rows = db.raw.prepare(JOIN_SQL).all("del-1", "t1") as Array<{ trajectory_id: string }>;
    expect(rows.map((row) => row.trajectory_id)).toEqual(["traj-1"]);
    // The t1 delivery is invisible under t2's scope.
    expect(db.raw.prepare(JOIN_SQL).all("del-1", "t2")).toEqual([]);
  });

  it("reads a legacy null-mission trajectory without joining or throwing", () => {
    const db = fixture();
    // A campaign with NO mission (created before the primitive was wired), a
    // delivery, and a legacy trajectory whose mission_id is null.
    insertCandidate(db, {
      tenantId: "t1",
      id: "cand-1",
      campaignId: "camp-legacy",
      unitId: "u1",
      attemptId: "att-1",
    });
    insertDelivery(db, {
      tenantId: "t1",
      id: "del-1",
      candidateId: "cand-1",
      jobId: "job-1",
      outcome: "merged",
    });
    const legacy = recordTrajectory(db, {
      id: "traj-legacy",
      tenantId: "t1",
      product: "regauge",
      taskKind: "k",
      taskSummary: "s",
      runId: "att-1",
      createdAt: T0,
    });
    expect(legacy.missionId).toBeNull();

    // No mission exists for camp-legacy, so the mission-keyed join yields nothing:
    // the null is never fabricated into a match.
    expect(db.raw.prepare(JOIN_SQL).all("del-1", "t1")).toEqual([]);

    // And the legacy row reads back cleanly with mission_id null.
    const row = db.raw
      .prepare(`SELECT mission_id FROM trajectories WHERE id = ? AND tenant_id = ?`)
      .get("traj-legacy", "t1") as { mission_id: string | null };
    expect(row.mission_id).toBeNull();
  });
});
