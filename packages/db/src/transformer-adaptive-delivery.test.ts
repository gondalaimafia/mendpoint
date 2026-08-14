import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindAdaptiveDeliveryIntent,
  claimNextJob,
  completeJob,
  createDb,
  enqueueAdaptiveDelivery,
  failJob,
  getAdaptiveDelivery,
  getAdaptiveDeliveryByCandidate,
  getJob,
  listAdaptiveDeliveries,
  recordAdaptiveCandidate,
  recordAdaptiveDeliveryFailure,
  recordAdaptiveDeliverySuccess,
  recoverExpiredJobs,
  reviewAdaptiveCandidate,
  type AppDb,
  type JobLeaseFence,
} from "./index.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];

afterEach(() => {
  while (dbs.length) {
    try {
      dbs.pop()?.raw.close();
    } catch {
      /* ignore */
    }
  }
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function freshDb(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-adaptive-delivery-"));
  dirs.push(dir);
  const db = createDb(join(dir, "test.sqlite"));
  dbs.push(db);
  return db;
}

const DIVERGED = `sha256:${"a".repeat(64)}`;
const CANDIDATE = `sha256:${"b".repeat(64)}`;
const SEAL = `sha256:${"c".repeat(64)}`;
const INTENT = `sha256:${"d".repeat(64)}`;
const BASE = "e".repeat(40);
const OTHER_BASE = "f".repeat(40);

function approvedCandidate(
  db: AppDb,
  tenantId = "tenant-a",
  expiresAt = "2026-08-07T00:00:00.000Z",
) {
  const candidate = recordAdaptiveCandidate(db, {
    tenantId,
    campaignId: "campaign-1",
    unitId: "unit-1",
    attemptId: "tfattempt_delivery",
    repositoryId: "repo-1",
    snapshotId: "snapshot-1",
    baseBranch: "main",
    expectedBaseRevision: BASE,
    divergedFromDigest: DIVERGED,
    candidateDigest: CANDIDATE,
    failingCommandId: "verify-1",
    sealedPath: "sealed/candidate.tar",
    sealedSha256: SEAL,
    changedPaths: ["src/client.ts"],
    expiresAt,
    now: "2026-08-06T00:00:00.000Z",
  });
  reviewAdaptiveCandidate(db, {
    tenantId,
    id: candidate.id,
    decision: "approve",
    reviewerPrincipalId: "human:reviewer-1",
    now: "2026-08-06T00:10:00.000Z",
  });
  return candidate;
}

function enqueue(db: AppDb, candidateId: string, overrides: Record<string, unknown> = {}) {
  return enqueueAdaptiveDelivery(db, {
    tenantId: "tenant-a",
    candidateId,
    repositoryId: "repo-1",
    snapshotId: "snapshot-1",
    baseBranch: "main",
    expectedBaseRevision: BASE,
    requesterPrincipalId: "human:reviewer-1",
    now: "2026-08-06T01:00:00.000Z",
    ...overrides,
  });
}

function claim(db: AppDb, workerId = "delivery-worker", now = "2026-08-06T01:01:00.000Z") {
  const job = claimNextJob(db, ["transformer.adaptive.deliver"], {
    tenantId: "tenant-a",
    workerId,
    leaseMs: 60_000,
    now,
  });
  expect(job).toBeDefined();
  return {
    job: job!,
    fence: {
      workerId,
      leaseGeneration: job!.lease_generation,
    } satisfies JobLeaseFence,
  };
}

describe("transformer adaptive delivery outbox", () => {
  it("requeues an expired max-attempt lease after dispatch intent is durably bound", () => {
    const db = freshDb();
    const candidate = approvedCandidate(db);
    const delivery = enqueue(db, candidate.id, { maxAttempts: 1 });
    const { job, fence } = claim(db);
    bindAdaptiveDeliveryIntent(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      jobId: job.id,
      ...fence,
      observedAt: "2026-08-06T01:01:01.000Z",
      intentDigest: INTENT,
      branchName: "mendpoint/transformer-stale-lease",
      baseBranch: "main",
      baseRevision: BASE,
    });

    expect(recoverExpiredJobs(db, "2026-08-06T01:03:00.000Z", "tenant-a")).toBe(1);
    expect(getJob(db, job.id)).toMatchObject({
      status: "pending",
      attempts: 1,
      error_code: "lease_expired_external_side_effect_uncertain",
      dead_at: null,
    });
    expect(getAdaptiveDelivery(db, "tenant-a", delivery.id)).toMatchObject({
      status: "delivery_pending",
      intentDigest: INTENT,
    });
    expect(claim(db, "delivery-worker-2", "2026-08-06T01:03:01.000Z").job.attempts).toBe(2);
  });

  it("atomically enqueues one deterministic job and rejects a colliding replay", () => {
    const db = freshDb();
    const candidate = approvedCandidate(db);
    const first = enqueue(db, candidate.id);
    const replay = enqueue(db, candidate.id);

    expect(replay.id).toBe(first.id);
    expect(replay.jobId).toBe(first.jobId);
    expect(replay.status).toBe("delivery_pending");
    expect(replay.baseBranch).toBe("main");
    expect(JSON.parse(getJob(db, first.jobId, "tenant-a")!.payload_json)).toEqual({
      candidateId: candidate.id,
    });
    expect(() => enqueue(db, candidate.id, { repositoryId: "repo-2" })).toThrow(
      "transformer_adaptive_delivery_conflict",
    );
    expect(() => enqueue(db, candidate.id, { baseBranch: "release" })).toThrow(
      "transformer_adaptive_delivery_conflict",
    );
    db.raw.prepare(
      "UPDATE regauge_adaptive_candidates SET status = 'expired' WHERE id = ?",
    ).run(candidate.id);
    expect(enqueue(db, candidate.id).jobId).toBe(first.jobId);
  });

  it("rolls back the outbox row when its deterministic queue identity collides", () => {
    const db = freshDb();
    const candidate = approvedCandidate(db);
    const first = enqueue(db, candidate.id);
    db.raw.prepare("DELETE FROM regauge_adaptive_deliveries WHERE id = ?").run(first.id);
    db.raw.prepare("UPDATE jobs SET payload_json = ? WHERE id = ?").run(
      JSON.stringify({ candidateId: "tfadapt_collision" }),
      first.jobId,
    );

    expect(() => enqueue(db, candidate.id)).toThrow("transformer_adaptive_delivery_conflict");
    expect(getAdaptiveDelivery(db, "tenant-a", first.id)).toBeUndefined();
  });

  it("keeps getters and lists tenant scoped", () => {
    const db = freshDb();
    const candidate = approvedCandidate(db);
    const delivery = enqueue(db, candidate.id);

    expect(getAdaptiveDelivery(db, "tenant-b", delivery.id)).toBeUndefined();
    expect(listAdaptiveDeliveries(db, "tenant-b")).toEqual([]);
    expect(getAdaptiveDelivery(db, "tenant-a", delivery.id)?.candidateId).toBe(candidate.id);
    expect(getAdaptiveDeliveryByCandidate(db, "tenant-a", candidate.id)?.id).toBe(delivery.id);
    expect(getAdaptiveDeliveryByCandidate(db, "tenant-b", candidate.id)).toBeUndefined();
    expect(listAdaptiveDeliveries(db, "tenant-a")).toHaveLength(1);
  });

  it("requires an approved candidate that is unexpired at enqueue time", () => {
    const db = freshDb();
    const pending = recordAdaptiveCandidate(db, {
      tenantId: "tenant-a",
      campaignId: "campaign-pending",
      unitId: "unit-1",
      attemptId: "tfattempt_pending",
      repositoryId: "repo-1",
      snapshotId: "snapshot-1",
      baseBranch: "main",
      expectedBaseRevision: BASE,
      divergedFromDigest: DIVERGED,
      candidateDigest: CANDIDATE,
      failingCommandId: null,
      sealedPath: "sealed/pending.tar",
      sealedSha256: SEAL,
      changedPaths: ["src/client.ts"],
      expiresAt: "2026-08-07T00:00:00.000Z",
      now: "2026-08-06T00:00:00.000Z",
    });
    expect(() => enqueue(db, pending.id)).toThrow(
      "transformer_adaptive_delivery_candidate_not_approved",
    );

    const expired = approvedCandidate(db, "tenant-expired", "2026-08-06T01:00:00.000Z");
    expect(() => enqueue(db, expired.id, { tenantId: "tenant-expired" })).toThrow(
      "transformer_adaptive_delivery_candidate_expired",
    );
  });

  it("requires exact commit SHAs for expected and bound base revisions", () => {
    const db = freshDb();
    const candidate = approvedCandidate(db);
    expect(() => enqueue(db, candidate.id, { expectedBaseRevision: "main" })).toThrow(
      "transformer_adaptive_delivery_expected_base_invalid",
    );
    expect(() => enqueue(db, candidate.id, { expectedBaseRevision: "a".repeat(41) })).toThrow(
      "transformer_adaptive_delivery_expected_base_invalid",
    );
    const delivery = enqueue(db, candidate.id);
    const active = claim(db);
    expect(() => bindAdaptiveDeliveryIntent(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      ...active.fence,
      intentDigest: INTENT,
      branchName: "mendpoint/adaptive-candidate",
      baseBranch: "release",
      baseRevision: BASE,
      observedAt: "2026-08-06T01:01:30.000Z",
    })).toThrow("transformer_adaptive_delivery_base_mismatch");
    expect(() => bindAdaptiveDeliveryIntent(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      ...active.fence,
      intentDigest: INTENT,
      branchName: "mendpoint/adaptive-candidate",
      baseBranch: "main",
      baseRevision: "main",
      observedAt: "2026-08-06T01:01:30.000Z",
    })).toThrow("transformer_adaptive_delivery_base_invalid");
    expect(() => bindAdaptiveDeliveryIntent(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      ...active.fence,
      intentDigest: INTENT,
      branchName: "mendpoint/adaptive-candidate",
      baseBranch: "main",
      baseRevision: "a".repeat(63),
      observedAt: "2026-08-06T01:01:30.000Z",
    })).toThrow("transformer_adaptive_delivery_base_invalid");
  });

  it("rejects stale lease mutations without changing the outbox", () => {
    const db = freshDb();
    const delivery = enqueue(db, approvedCandidate(db).id);
    const active = claim(db, "worker-a");
    db.raw.prepare(
      `UPDATE jobs SET lease_owner = 'worker-b', lease_generation = lease_generation + 1
       WHERE id = ?`,
    ).run(active.job.id);

    expect(() => bindAdaptiveDeliveryIntent(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      workerId: "worker-a",
      leaseGeneration: active.fence.leaseGeneration,
      intentDigest: INTENT,
      branchName: "mendpoint/adaptive-candidate",
      baseBranch: "main",
      baseRevision: BASE,
      observedAt: "2026-08-06T01:01:30.000Z",
    })).toThrow("transformer_adaptive_delivery_lease_lost");
    expect(getAdaptiveDelivery(db, "tenant-a", delivery.id)?.intentDigest).toBeNull();
  });

  it("joins an outer transaction and rolls back a bound intent", () => {
    const db = freshDb();
    const delivery = enqueue(db, approvedCandidate(db).id);
    const active = claim(db);

    db.raw.exec("BEGIN IMMEDIATE");
    bindAdaptiveDeliveryIntent(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      ...active.fence,
      intentDigest: INTENT,
      branchName: "mendpoint/adaptive-candidate",
      baseBranch: "main",
      baseRevision: BASE,
      observedAt: "2026-08-06T01:01:30.000Z",
    });
    db.raw.exec("ROLLBACK");

    expect(getAdaptiveDelivery(db, "tenant-a", delivery.id)?.intentDigest).toBeNull();
  });

  it("fails closed when success or terminal failure is attempted outside finalization", () => {
    const db = freshDb();
    const delivery = enqueue(db, approvedCandidate(db).id);
    const active = claim(db);
    bindAdaptiveDeliveryIntent(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      ...active.fence,
      intentDigest: INTENT,
      branchName: "mendpoint/adaptive-candidate",
      baseBranch: "main",
      baseRevision: BASE,
      observedAt: "2026-08-06T01:01:30.000Z",
    });

    expect(() => recordAdaptiveDeliverySuccess(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      ...active.fence,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      branchName: "mendpoint/adaptive-candidate",
      baseBranch: "main",
      baseRevision: BASE,
      draftPr: true,
      draftPrNumber: 42,
      draftPrUrl: "https://github.com/acme/repo/pull/42",
      observedAt: "2026-08-06T01:01:40.000Z",
    })).toThrow("transformer_adaptive_delivery_outer_transaction_required");
    expect(() => recordAdaptiveDeliveryFailure(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      ...active.fence,
      terminal: true,
      errorCode: "github_permission_denied",
      errorMessage: "installation cannot write the repository",
      observedAt: "2026-08-06T01:01:40.000Z",
    })).toThrow("transformer_adaptive_delivery_outer_transaction_required");
    expect(getAdaptiveDelivery(db, "tenant-a", delivery.id)).toMatchObject({
      status: "delivery_pending",
      commitSha: null,
      errorCode: null,
    });
  });

  it("preserves retryable failures as pending and marks only terminal failure", () => {
    const db = freshDb();
    const delivery = enqueue(db, approvedCandidate(db).id);
    const first = claim(db, "worker-a");

    db.raw.exec("BEGIN IMMEDIATE");
    recordAdaptiveDeliveryFailure(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      ...first.fence,
      terminal: false,
      errorCode: "github_unavailable",
      errorMessage: "temporary provider failure",
      observedAt: "2026-08-06T01:01:30.000Z",
    });
    expect(failJob(db, delivery.jobId, "temporary provider failure", "2026-08-06T01:01:30.000Z", {
      ...first.fence,
      errorCode: "github_unavailable",
      retryable: true,
      baseDelayMs: 1_000,
      maxDelayMs: 1_000,
    }).status).toBe("pending");
    db.raw.exec("COMMIT");
    expect(getAdaptiveDelivery(db, "tenant-a", delivery.id)?.status).toBe("delivery_pending");

    const second = claim(db, "worker-b", "2026-08-06T01:02:31.000Z");
    db.raw.exec("BEGIN IMMEDIATE");
    recordAdaptiveDeliveryFailure(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      ...second.fence,
      terminal: true,
      errorCode: "github_permission_denied",
      errorMessage: "installation cannot write the repository",
      observedAt: "2026-08-06T01:03:00.000Z",
    });
    expect(failJob(db, delivery.jobId, "installation cannot write the repository", "2026-08-06T01:03:00.000Z", {
      ...second.fence,
      errorCode: "github_permission_denied",
      retryable: false,
    }).status).toBe("dead_letter");
    db.raw.exec("COMMIT");
    expect(getAdaptiveDelivery(db, "tenant-a", delivery.id)).toMatchObject({
      status: "delivery_failed",
      errorCode: "github_permission_denied",
      failedAt: "2026-08-06T01:03:00.000Z",
    });
  });

  it("commits complete delivery evidence atomically and rolls it back with the job", () => {
    const db = freshDb();
    const delivery = enqueue(db, approvedCandidate(db).id);
    const active = claim(db);
    const mutation = {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      ...active.fence,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      branchName: "mendpoint/adaptive-candidate",
      baseBranch: "main",
      baseRevision: BASE,
      draftPr: true,
      draftPrNumber: 42,
      draftPrUrl: "https://github.com/acme/repo/pull/42",
      observedAt: "2026-08-06T01:01:30.000Z",
    } as const;

    db.raw.exec("BEGIN IMMEDIATE");
    bindAdaptiveDeliveryIntent(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      ...active.fence,
      intentDigest: INTENT,
      branchName: "mendpoint/adaptive-candidate",
      baseBranch: "main",
      baseRevision: BASE,
      observedAt: mutation.observedAt,
    });
    expect(() => recordAdaptiveDeliverySuccess(db, {
      ...mutation,
      baseRevision: OTHER_BASE,
    })).toThrow("transformer_adaptive_delivery_evidence_mismatch");
    db.raw.exec("ROLLBACK");

    db.raw.exec("BEGIN IMMEDIATE");
    bindAdaptiveDeliveryIntent(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      ...active.fence,
      intentDigest: INTENT,
      branchName: "mendpoint/adaptive-candidate",
      baseBranch: "main",
      baseRevision: BASE,
      observedAt: mutation.observedAt,
    });
    recordAdaptiveDeliverySuccess(db, mutation);
    expect(completeJob(db, delivery.jobId, { delivered: true }, mutation.observedAt, active.fence))
      .toBe(true);
    db.raw.exec("ROLLBACK");
    expect(getAdaptiveDelivery(db, "tenant-a", delivery.id)?.status).toBe("delivery_pending");
    expect(getJob(db, delivery.jobId, "tenant-a")?.status).toBe("running");

    db.raw.exec("BEGIN IMMEDIATE");
    bindAdaptiveDeliveryIntent(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      ...active.fence,
      intentDigest: INTENT,
      branchName: "mendpoint/adaptive-candidate",
      baseBranch: "main",
      baseRevision: BASE,
      observedAt: mutation.observedAt,
    });
    recordAdaptiveDeliverySuccess(db, mutation);
    expect(completeJob(db, delivery.jobId, { delivered: true }, mutation.observedAt, active.fence))
      .toBe(true);
    db.raw.exec("COMMIT");
    expect(getAdaptiveDelivery(db, "tenant-a", delivery.id)).toMatchObject({
      status: "delivered",
      commitSha: mutation.commitSha,
      draftPrNumber: 42,
      draftPrUrl: mutation.draftPrUrl,
      deliveredAt: mutation.observedAt,
    });
  });
});
