import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, listJobs } from "./index.js";
import {
  beginWardenCiRepair,
  enqueueWardenCiCycle,
  failWardenCiOperation,
  getWardenCiCycle,
  listWardenCiObservations,
  pauseWardenCiCycle,
  recordWardenCiObservation,
  settleWardenCiRepairWithoutCandidate,
} from "./warden-ci-reentry.js";

const paths: string[] = [];
const databases: ReturnType<typeof createDb>[] = [];
const sha = (value: string) => value.repeat(40);
const digest = (value: string) => `sha256:${value.repeat(64)}`;

function database() {
  const path = join(tmpdir(), `mendpoint-warden-ci-${crypto.randomUUID()}.sqlite`);
  paths.push(path);
  const db = createDb(path);
  databases.push(db);
  db.raw.prepare(
    `INSERT INTO warden_candidate_deliveries
     (id, tenant_id, run_id, job_id, status, repository_id, snapshot_id, base_branch,
      expected_base_revision, sealed_path, sealed_sha256, requester_principal_id, rationale,
      intent_digest, branch_name, base_revision, commit_sha, draft_pr, draft_pr_number,
      draft_pr_url, requested_at, delivered_at, updated_at)
     VALUES ('delivery-a', 'tenant-a', 'run-a', 'delivery-job-a', 'delivered', 'repo-a',
      'snapshot-a', 'main', ?, 'sealed', ?, 'principal-a', 'approved', ?,
      'mendpoint/warden-a', ?, ?, 1, 17, 'https://github.com/acme/service/pull/17', ?, ?, ?)`,
  ).run(sha("a"), digest("b"), digest("c"), sha("a"), sha("d"),
    "2026-08-13T12:00:00.000Z", "2026-08-13T12:01:00.000Z", "2026-08-13T12:01:00.000Z");
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.raw.close();
  for (const path of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  }
});

const cycleInput = Object.freeze({
  tenantId: "tenant-a",
  deliveryId: "delivery-a",
  repositoryId: "repo-a",
  remoteRepositoryId: 101,
  installationId: 202,
  requiredChecks: Object.freeze(["check:77:unit", "check:88:integration"]),
  allowedChangedPaths: Object.freeze(["src/a.ts"]),
  maxCycles: 3,
  maxModelCalls: 4,
  maximumCostUsd: 1.5,
  observedAt: "2026-08-13T12:01:00.000Z",
});

describe("Warden CI reentry authority", () => {
  it("creates one deterministic observation job bound to the delivered draft", () => {
    const db = database();
    const first = enqueueWardenCiCycle(db, cycleInput);
    const replay = enqueueWardenCiCycle(db, cycleInput);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      status: "observation_pending",
      deliveryId: "delivery-a",
      pullRequestNumber: 17,
      branchName: "mendpoint/warden-a",
      currentHeadSha: sha("d"),
      maxCycles: 3,
      usedCycles: 0,
    });
    expect(listJobs(db, 20, "tenant-a")).toContainEqual(expect.objectContaining({
      id: first.observationJobId,
      type: "warden.candidate.observe",
      status: "pending",
    }));
    expect(() => enqueueWardenCiCycle(db, { ...cycleInput, requiredChecks: ["check:77:other"] }))
      .toThrow("warden_ci_cycle_conflict");
  });

  it("stores one exact failed-head observation and reserves one cumulative repair cycle", () => {
    const db = database();
    const cycle = enqueueWardenCiCycle(db, cycleInput);
    const observed = recordWardenCiObservation(db, {
      tenantId: "tenant-a",
      cycleId: cycle.id,
      headSha: sha("d"),
      verdict: "failure",
      observationDigest: digest("e"),
      evidenceArtifactId: "artifact-failure-a",
      evidenceDigest: digest("f"),
      observedAt: "2026-08-13T12:02:00.000Z",
    });
    const replay = recordWardenCiObservation(db, {
      tenantId: "tenant-a",
      cycleId: cycle.id,
      headSha: sha("d"),
      verdict: "failure",
      observationDigest: digest("e"),
      evidenceArtifactId: "artifact-failure-a",
      evidenceDigest: digest("f"),
      observedAt: "2026-08-13T12:02:00.000Z",
    });

    expect(replay).toEqual(observed);
    expect(listWardenCiObservations(db, "tenant-a", cycle.id)).toHaveLength(1);
    expect(listJobs(db, 20, "tenant-a")).toContainEqual(expect.objectContaining({
      type: "warden.candidate.repair",
      status: "pending",
    }));
    const repair = beginWardenCiRepair(db, {
      tenantId: "tenant-a",
      cycleId: cycle.id,
      observationDigest: digest("e"),
      repairRunId: "repair-run-a",
      repairJobId: "repair-job-a",
      observedAt: "2026-08-13T12:03:00.000Z",
    });
    expect(repair).toMatchObject({ status: "repair_pending", usedCycles: 1, repairRunId: "repair-run-a" });
    expect(() => beginWardenCiRepair(db, {
      tenantId: "tenant-a", cycleId: cycle.id, observationDigest: digest("e"),
      repairRunId: "repair-run-b", repairJobId: "repair-job-b", observedAt: "2026-08-13T12:04:00.000Z",
    })).toThrow("warden_ci_repair_conflict");
  });

  it("honors a human pause before reserving repair authority", () => {
    const db = database();
    const cycle = enqueueWardenCiCycle(db, cycleInput);
    recordWardenCiObservation(db, {
      tenantId: "tenant-a", cycleId: cycle.id, headSha: sha("d"), verdict: "failure",
      observationDigest: digest("e"), evidenceArtifactId: "artifact-failure-a",
      evidenceDigest: digest("f"), observedAt: "2026-08-13T12:02:00.000Z",
    });
    pauseWardenCiCycle(db, {
      tenantId: "tenant-a", cycleId: cycle.id, actorPrincipalId: "principal-a",
      reason: "review requested", observedAt: "2026-08-13T12:03:00.000Z",
    });

    expect(() => beginWardenCiRepair(db, {
      tenantId: "tenant-a", cycleId: cycle.id, observationDigest: digest("e"),
      repairRunId: "repair-run-a", repairJobId: "repair-job-a", observedAt: "2026-08-13T12:04:00.000Z",
    })).toThrow("warden_ci_cycle_paused");
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)).toMatchObject({ status: "paused" });
  });

  it("exhausts a delivery-wide cycle budget without resetting on replay", () => {
    const db = database();
    const cycle = enqueueWardenCiCycle(db, { ...cycleInput, maxCycles: 1 });
    recordWardenCiObservation(db, {
      tenantId: "tenant-a", cycleId: cycle.id, headSha: sha("d"), verdict: "failure",
      observationDigest: digest("e"), evidenceArtifactId: "artifact-failure-a",
      evidenceDigest: digest("f"), observedAt: "2026-08-13T12:02:00.000Z",
    });
    beginWardenCiRepair(db, {
      tenantId: "tenant-a", cycleId: cycle.id, observationDigest: digest("e"),
      repairRunId: "repair-run-a", repairJobId: "repair-job-a", observedAt: "2026-08-13T12:03:00.000Z",
    });

    expect(getWardenCiCycle(db, "tenant-a", cycle.id)).toMatchObject({ usedCycles: 1 });
  });

  it("pauses only the exact active repair run when it terminates without a candidate", () => {
    const db = database();
    const cycle = enqueueWardenCiCycle(db, cycleInput);
    recordWardenCiObservation(db, {
      tenantId: "tenant-a", cycleId: cycle.id, headSha: sha("d"), verdict: "failure",
      observationDigest: digest("e"), evidenceArtifactId: "artifact-failure-a",
      evidenceDigest: digest("f"), observedAt: "2026-08-13T12:02:00.000Z",
    });
    beginWardenCiRepair(db, {
      tenantId: "tenant-a", cycleId: cycle.id, observationDigest: digest("e"),
      repairRunId: "repair-run-a", repairJobId: "repair-job-a", observedAt: "2026-08-13T12:03:00.000Z",
    });

    expect(() => settleWardenCiRepairWithoutCandidate(db, {
      tenantId: "tenant-a", cycleId: cycle.id, repairRunId: "foreign-run",
      reason: "warden_attempt_internal_error", observedAt: "2026-08-13T12:04:00.000Z",
    })).toThrow("warden_ci_repair_settlement_not_authorized");
    const settled = settleWardenCiRepairWithoutCandidate(db, {
      tenantId: "tenant-a", cycleId: cycle.id, repairRunId: "repair-run-a",
      reason: "warden_attempt_baseline_target_green", observedAt: "2026-08-13T12:04:00.000Z",
    });
    expect(settled).toMatchObject({ status: "paused", repairRunId: "repair-run-a",
      pausedBy: "warden-ci-system", pauseReason: "warden_attempt_baseline_target_green" });
    expect(settleWardenCiRepairWithoutCandidate(db, {
      tenantId: "tenant-a", cycleId: cycle.id, repairRunId: "repair-run-a",
      reason: "warden_attempt_baseline_target_green", observedAt: "2026-08-13T12:04:00.000Z",
    })).toEqual(settled);
  });

  it("fails a terminal operation into a durable paused cycle and rejects a foreign job", () => {
    const db = database();
    const cycle = enqueueWardenCiCycle(db, cycleInput);

    expect(() => failWardenCiOperation(db, {
      tenantId: "tenant-a", cycleId: cycle.id, jobId: "foreign-job",
      reason: "github_observation_failed", observedAt: "2026-08-13T12:02:00.000Z",
    })).toThrow("warden_ci_operation_failure_not_authorized");

    const failed = failWardenCiOperation(db, {
      tenantId: "tenant-a", cycleId: cycle.id, jobId: cycle.observationJobId,
      reason: "github_observation_failed", observedAt: "2026-08-13T12:02:00.000Z",
    });
    expect(failed).toMatchObject({
      status: "paused", pausedBy: "warden-ci-system", pauseReason: "github_observation_failed",
    });
  });
});
