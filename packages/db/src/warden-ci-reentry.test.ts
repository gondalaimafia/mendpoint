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
  wakeWardenCiReviewObservation,
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
    `INSERT INTO fettler_candidate_deliveries
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
  it("upgrades an existing cycle table to the operator-pausable awaiting-review state", () => {
    const db = database();
    const cycle = enqueueWardenCiCycle(db, cycleInput);
    const schema = db.raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fettler_ci_cycles'")
      .get() as { sql: string };
    const columns = (db.raw.prepare("PRAGMA table_info(fettler_ci_cycles)").all() as Array<{ name: string }>)
      .map((column) => column.name).join(", ");
    db.raw.exec("DROP INDEX fettler_ci_cycles_tenant_status_idx");
    db.raw.exec(schema.sql.replace("CREATE TABLE fettler_ci_cycles", "CREATE TABLE fettler_ci_cycles_oldcheck")
      .replace(", 'awaiting_review'", ""));
    db.raw.exec(`INSERT INTO fettler_ci_cycles_oldcheck (${columns}) SELECT ${columns} FROM fettler_ci_cycles;
      DROP TABLE fettler_ci_cycles;
      ALTER TABLE fettler_ci_cycles_oldcheck RENAME TO fettler_ci_cycles;`);
    const path = paths.at(-1)!;
    db.raw.close();
    databases.splice(databases.indexOf(db), 1);
    const reopened = createDb(path);
    databases.push(reopened);
    recordWardenCiObservation(reopened, { tenantId: "tenant-a", cycleId: cycle.id, headSha: sha("d"),
      verdict: "success", observationDigest: digest("e"), evidenceArtifactId: "artifact-success-migration",
      evidenceDigest: digest("f"), observedAt: "2026-08-13T12:02:00.000Z" });
    expect(getWardenCiCycle(reopened, "tenant-a", cycle.id)?.status).toBe("awaiting_review");
  });

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

  it("fails closed when another worker moves the head between the read and the observation write", () => {
    const db = database();
    const cycle = enqueueWardenCiCycle(db, cycleInput);
    const movedHead = sha("9");
    // Reproduce the race: recordWardenCiObservation reads the cycle outside the transaction, so a
    // concurrent completeWardenCiUpdate can move current_head_sha in the window before BEGIN IMMEDIATE.
    // Fire that move exactly as the transaction opens.
    const realExec = db.raw.exec.bind(db.raw);
    let fired = false;
    (db.raw as unknown as { exec: (sql: string) => unknown }).exec = (sql: string) => {
      if (!fired && sql === "BEGIN IMMEDIATE") {
        fired = true;
        db.raw.prepare("UPDATE fettler_ci_cycles SET current_head_sha = ? WHERE id = ? AND tenant_id = ?")
          .run(movedHead, cycle.id, "tenant-a");
      }
      return realExec(sql);
    };
    try {
      expect(() => recordWardenCiObservation(db, {
        tenantId: "tenant-a", cycleId: cycle.id, headSha: sha("d"), verdict: "failure",
        observationDigest: digest("e"), evidenceArtifactId: "artifact-race-a",
        evidenceDigest: digest("f"), observedAt: "2026-08-13T12:02:00.000Z",
      })).toThrow("warden_ci_head_drift");
    } finally {
      (db.raw as unknown as { exec: typeof realExec }).exec = realExec;
    }
    // Nothing was persisted: no observation row, no repair job, and the cycle keeps its null digest.
    expect(listWardenCiObservations(db, "tenant-a", cycle.id)).toHaveLength(0);
    expect(listJobs(db, 20, "tenant-a").filter((job) => job.type === "warden.candidate.repair")).toHaveLength(0);
    const after = getWardenCiCycle(db, "tenant-a", cycle.id);
    expect(after?.currentHeadSha).toBe(movedHead);
    expect(after?.status).toBe("observation_pending");
    expect(after?.currentObservationDigest).toBeNull();
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

  it("transactionally wakes one exact succeeded draft cycle for authoritative review reobservation", () => {
    const db = database();
    const cycle = enqueueWardenCiCycle(db, cycleInput);
    recordWardenCiObservation(db, {
      tenantId: "tenant-a", cycleId: cycle.id, headSha: sha("d"), verdict: "success",
      observationDigest: digest("e"), evidenceArtifactId: "artifact-success-a",
      evidenceDigest: digest("f"), observedAt: "2026-08-13T12:02:00.000Z",
    });
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)?.status).toBe("awaiting_review");

    const woken = wakeWardenCiReviewObservation(db, {
      tenantId: "tenant-a", remoteRepositoryId: 101, installationId: 202,
      pullRequestNumber: 17, headSha: sha("d"), wakeId: "github-delivery-review-1",
      observedAt: "2026-08-13T12:03:00.000Z",
    });
    expect(woken).toMatchObject({ status: "woken", cycle: { id: cycle.id, status: "observation_pending" } });
    expect(woken.cycle?.observationJobId).not.toBe(cycle.observationJobId);
    expect(listJobs(db, 20, "tenant-a").filter((job) => job.type === "warden.candidate.observe"))
      .toHaveLength(2);

    const replay = wakeWardenCiReviewObservation(db, {
      tenantId: "tenant-a", remoteRepositoryId: 101, installationId: 202,
      pullRequestNumber: 17, headSha: sha("d"), wakeId: "github-delivery-review-1",
      observedAt: "2026-08-13T12:03:00.000Z",
    });
    expect(replay).toMatchObject({ status: "already_active", cycle: { observationJobId: woken.cycle?.observationJobId } });
    expect(listJobs(db, 20, "tenant-a").filter((job) => job.type === "warden.candidate.observe"))
      .toHaveLength(2);
  });

  it("does not wake a stale, cross-tenant, or identity-mismatched review event", () => {
    const db = database();
    const cycle = enqueueWardenCiCycle(db, cycleInput);
    recordWardenCiObservation(db, {
      tenantId: "tenant-a", cycleId: cycle.id, headSha: sha("d"), verdict: "success",
      observationDigest: digest("e"), evidenceArtifactId: "artifact-success-a",
      evidenceDigest: digest("f"), observedAt: "2026-08-13T12:02:00.000Z",
    });
    for (const mismatch of [
      { tenantId: "tenant-b" },
      { remoteRepositoryId: 102 },
      { installationId: 203 },
      { pullRequestNumber: 18 },
      { headSha: sha("c") },
    ]) {
      expect(wakeWardenCiReviewObservation(db, {
        tenantId: "tenant-a", remoteRepositoryId: 101, installationId: 202,
        pullRequestNumber: 17, headSha: sha("d"), wakeId: `github-delivery-${Object.keys(mismatch)[0]}`,
        observedAt: "2026-08-13T12:03:00.000Z", ...mismatch,
      })).toEqual({ status: "not_found", cycle: null });
    }
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)?.status).toBe("awaiting_review");
  });

  it("allows an operator to pause a cycle while it awaits GitHub review", () => {
    const db = database();
    const cycle = enqueueWardenCiCycle(db, cycleInput);
    recordWardenCiObservation(db, {
      tenantId: "tenant-a", cycleId: cycle.id, headSha: sha("d"), verdict: "success",
      observationDigest: digest("e"), evidenceArtifactId: "artifact-success-a",
      evidenceDigest: digest("f"), observedAt: "2026-08-13T12:02:00.000Z",
    });
    expect(pauseWardenCiCycle(db, {
      tenantId: "tenant-a", cycleId: cycle.id, actorPrincipalId: "principal-a",
      reason: "operator pause", observedAt: "2026-08-13T12:03:00.000Z",
    })).toMatchObject({ status: "paused", pauseReason: "operator pause" });
  });
});
