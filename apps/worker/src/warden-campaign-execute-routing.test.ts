import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, enqueueJob, listJobs, type AppDb } from "@mendpoint/db";

const NOW = "2026-01-02T00:00:00.000Z";
import {
  WardenCampaignExecutionError,
  type WardenCampaignExecutionDependencies,
} from "@mendpoint/pipeline";
import { WARDEN_CAMPAIGN_EXECUTE_JOB_TYPE, type WardenCampaignExecutor } from "./warden-campaign-execute-dispatch.js";
import { processJobsOnce } from "./cli.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.raw.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureDb(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-campaign-route-"));
  dirs.push(dir);
  const db = createDb(join(dir, "jobs.sqlite"));
  dbs.push(db);
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('tenant-a', 'a', 'A', 'team', 'active', 10, '2026-01-01T00:00:00.000Z')`).run();
  return db;
}

const deps = {} as unknown as WardenCampaignExecutionDependencies;

function enqueue(db: AppDb, id = "job-exec-1") {
  enqueueJob(db, {
    id,
    tenantId: "tenant-a",
    type: WARDEN_CAMPAIGN_EXECUTE_JOB_TYPE,
    createdAt: NOW,
    payload: {
      campaignId: "camp-1", targetId: "tgt-1", rolloutDecisionId: "rd-1",
      actorPrincipalId: "worker", runId: "run-1", createdAt: NOW,
      source: { sourceArtifactId: "src-1" },
      rolloutApproval: { decisionSha256: "a".repeat(64), approvedByPrincipalId: "reviewer", approvedAt: NOW },
      ownerApproval: { ownerPrincipalId: "owner", ownerHandle: "@team", approvedAt: NOW },
    },
  });
}

describe("warden.campaign.execute-target loop routing", () => {
  it("completes the job when the executor lands the target in review", async () => {
    const db = fixtureDb();
    enqueue(db);
    const execute = (async () => ({ stage: "review" }) as Awaited<ReturnType<WardenCampaignExecutor>>) as WardenCampaignExecutor;
    const result = await processJobsOnce(db, {
      allTenants: true, runWardenMaintenance: false,
      wardenCampaignExecution: { resolveDependencies: () => deps, execute },
    });
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, retried: 0 });
    expect(listJobs(db, 10, "tenant-a")[0]).toMatchObject({ id: "job-exec-1", status: "done" });
  });

  it("reschedules the job on a retryable executor error", async () => {
    const db = fixtureDb();
    enqueue(db);
    const execute = (async () => {
      throw new WardenCampaignExecutionError("warden_target_not_ready", true);
    }) as WardenCampaignExecutor;
    const result = await processJobsOnce(db, {
      allTenants: true, runWardenMaintenance: false,
      wardenCampaignExecution: { resolveDependencies: () => deps, execute },
    });
    expect(result).toMatchObject({ claimed: 1, succeeded: 0, failed: 1, retried: 1 });
    expect(listJobs(db, 10, "tenant-a")[0]).toMatchObject({ id: "job-exec-1", status: "pending" });
  });

  it("fails the job terminally on a non-retryable executor error", async () => {
    const db = fixtureDb();
    enqueue(db);
    const execute = (async () => {
      throw new WardenCampaignExecutionError("warden_owner_approval_mismatch", false);
    }) as WardenCampaignExecutor;
    const result = await processJobsOnce(db, {
      allTenants: true, runWardenMaintenance: false,
      wardenCampaignExecution: { resolveDependencies: () => deps, execute },
    });
    expect(result).toMatchObject({ claimed: 1, succeeded: 0, failed: 1 });
    const job = listJobs(db, 10, "tenant-a")[0];
    expect(job).toMatchObject({ id: "job-exec-1" });
    expect(["pending", "dead_letter", "failed"]).toContain(job.status);
  });

  it("does NOT claim the job when no execution dependencies are configured", async () => {
    const db = fixtureDb();
    enqueue(db);
    const result = await processJobsOnce(db, { allTenants: true, runWardenMaintenance: false });
    expect(result).toMatchObject({ claimed: 0, succeeded: 0 });
    expect(listJobs(db, 10, "tenant-a")[0]).toMatchObject({ id: "job-exec-1", status: "pending" });
  });
});
