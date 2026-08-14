import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimNextJob, createDb, getJob, listJobs } from "./index.js";
import {
  bindWardenCiUpdateIntent,
  completeWardenCiUpdate,
  enqueueWardenCiUpdate,
  getWardenCiCycle,
  getWardenCiUpdate,
  pauseWardenCiCycle,
} from "./warden-ci-reentry.js";

const paths: string[] = [];
const databases: ReturnType<typeof createDb>[] = [];
const sha = (value: string) => value.repeat(40);
const digest = (value: string) => `sha256:${value.repeat(64)}`;

function fixture() {
  const path = join(tmpdir(), `mendpoint-warden-ci-update-${crypto.randomUUID()}.sqlite`);
  paths.push(path);
  const db = createDb(path);
  databases.push(db);
  db.raw.prepare(`INSERT INTO warden_ci_cycles
    (id, tenant_id, delivery_id, observation_job_id, status, repository_id, remote_repository_id,
     installation_id, pull_request_number, base_branch, branch_name, base_revision, current_head_sha,
     required_checks_json, allowed_changed_paths_json, max_cycles, used_cycles, max_model_calls,
     maximum_cost_usd, current_observation_digest, repair_run_id, repair_job_id, created_at, updated_at)
    VALUES ('cycle-a', 'tenant-a', 'delivery-a', 'observe-old', 'repair_pending', 'repo-a', 101,
     202, 17, 'main', 'mendpoint/warden-a', ?, ?, '["check:77:unit"]', '["src/a.ts"]',
     3, 1, 6, 3, ?, 'repair-run-a', 'repair-agent-job-a', ?, ?)`)
    .run(sha("a"), sha("d"), digest("e"), "2026-08-13T12:00:00.000Z", "2026-08-13T12:03:00.000Z");
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.raw.close();
  for (const path of paths.splice(0)) for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
});

describe("Warden CI exact draft update authority", () => {
  it("creates one fresh-approval update job and advances to a new exact observation after delivery", () => {
    const db = fixture();
    expect(getWardenCiCycle(db, "tenant-a", "cycle-a")).toMatchObject({
      status: "repair_pending", repairRunId: "repair-run-a", currentHeadSha: sha("d"),
    });
    const update = enqueueWardenCiUpdate(db, { tenantId: "tenant-a", cycleId: "cycle-a",
      repairRunId: "repair-run-a", expectedHeadSha: sha("d"), sealedPath: "sealed/approval.json",
      sealedSha256: digest("f"), reviewerPrincipalId: "principal-a", rationale: "Approve CI repair",
      observedAt: "2026-08-13T12:04:00.000Z" });
    expect(enqueueWardenCiUpdate(db, { tenantId: "tenant-a", cycleId: "cycle-a",
      repairRunId: "repair-run-a", expectedHeadSha: sha("d"), sealedPath: "sealed/approval.json",
      sealedSha256: digest("f"), reviewerPrincipalId: "principal-a", rationale: "Approve CI repair",
      observedAt: "2026-08-13T12:04:00.000Z" })).toEqual(update);
    expect(getJob(db, update.jobId, "tenant-a")?.type).toBe("warden.candidate.update");
    expect(getWardenCiCycle(db, "tenant-a", "cycle-a")?.status).toBe("update_pending");
    claimNextJob(db, ["warden.candidate.update"], { tenantId: "tenant-a", workerId: "worker-a",
      leaseMs: 60_000, now: "2026-08-13T12:04:30.000Z" });

    bindWardenCiUpdateIntent(db, { tenantId: "tenant-a", updateId: update.id,
      intentDigest: digest("1"), workerId: "worker-a", leaseGeneration: 1,
      observedAt: "2026-08-13T12:05:00.000Z" });
    expect(() => pauseWardenCiCycle(db, { tenantId: "tenant-a", cycleId: "cycle-a",
      actorPrincipalId: "principal-b", reason: "too late", observedAt: "2026-08-13T12:05:29.000Z" }))
      .toThrow("warden_ci_mutation_in_flight");
    const completed = completeWardenCiUpdate(db, { tenantId: "tenant-a", updateId: update.id,
      expectedHeadSha: sha("d"), commitSha: sha("f"), observedAt: "2026-08-13T12:06:00.000Z" });

    expect(completed.status).toBe("delivered");
    expect(getWardenCiCycle(db, "tenant-a", "cycle-a")).toMatchObject({
      status: "observation_pending", currentHeadSha: sha("f"), currentObservationDigest: null,
      repairRunId: null, repairJobId: null,
    });
    expect(listJobs(db, 50, "tenant-a")).toContainEqual(expect.objectContaining({
      type: "warden.candidate.observe", status: "pending",
    }));
  });

  it("rejects update approval after a human pause", () => {
    const db = fixture();
    db.raw.prepare("UPDATE warden_ci_cycles SET status = 'paused' WHERE id = 'cycle-a'").run();
    expect(() => enqueueWardenCiUpdate(db, { tenantId: "tenant-a", cycleId: "cycle-a",
      repairRunId: "repair-run-a", expectedHeadSha: sha("d"), sealedPath: "sealed/approval.json",
      sealedSha256: digest("f"), reviewerPrincipalId: "principal-a", rationale: "Approve CI repair",
      observedAt: "2026-08-13T12:04:00.000Z" })).toThrow("warden_ci_update_not_authorized");
    expect(getWardenCiUpdate(db, "tenant-a", "missing")).toBeUndefined();
  });
});
