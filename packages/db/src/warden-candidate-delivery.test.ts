import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, getJob, insertAgentRun, type AppDb } from "./index.js";
import {
  bindWardenCandidateDeliveryIntent,
  enqueueWardenCandidateDelivery,
  getWardenCandidateDelivery,
  getWardenCandidateDeliveryByRun,
  recordWardenCandidateDeliveryFailure,
  recordWardenCandidateDeliverySuccess,
} from "./warden-candidate-delivery.js";

const NOW = "2026-08-06T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-warden-delivery-db-"));
  const db = createDb(join(directory, "test.sqlite"));
  opened.push({ db, directory });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?),
            ('tenant-b', 'tenant-b', 'Tenant B', 'team', 'active', 10, ?)`,
  ).run(NOW, NOW);
  insertAgentRun(db, {
    id: "warden-run-1",
    tenantId: "tenant-a",
    jobId: "source-job-1",
    goal: "Repair the SDK",
    repoPath: "C:\\snapshot",
    status: "candidate_approved",
    ok: true,
    steps: 3,
    filesChanged: ["src/client.ts"],
    resultJson: JSON.stringify({
      source: {
        repositoryId: "repo-1",
        snapshotId: "snapshot-1",
        revision: "a".repeat(40),
      },
      artifacts: {
        approval: {
          path: "C:\\data\\warden-evidence\\tenant-a\\approvals\\seal.json",
          sha256: `sha256:${"b".repeat(64)}`,
        },
      },
      review: {
        decision: "approve",
        reviewerPrincipalId: "human:reviewer@example.com",
        rationale: "The target and regression checks pass.",
      },
    }),
    createdAt: NOW,
    finishedAt: NOW,
  });
  return db;
}

afterEach(() => {
  while (opened.length) {
    const entry = opened.pop()!;
    entry.db.raw.close();
    rmSync(entry.directory, { recursive: true, force: true });
  }
});

describe("Warden candidate delivery outbox", () => {
  it("atomically enqueues one deterministic tenant-scoped draft delivery", () => {
    const db = fixture();
    const input = {
      tenantId: "tenant-a",
      runId: "warden-run-1",
      repositoryId: "repo-1",
      snapshotId: "snapshot-1",
      baseBranch: "main",
      expectedBaseRevision: "a".repeat(40),
      sealedPath: "C:\\data\\warden-evidence\\tenant-a\\approvals\\seal.json",
      sealedSha256: `sha256:${"b".repeat(64)}`,
      requesterPrincipalId: "human:reviewer@example.com",
      rationale: "The target and regression checks pass.",
      now: NOW,
    } as const;

    const first = enqueueWardenCandidateDelivery(db, input);
    const replay = enqueueWardenCandidateDelivery(db, input);

    expect(replay).toEqual(first);
    expect(first.status).toBe("delivery_pending");
    expect(getJob(db, first.jobId, "tenant-a")).toMatchObject({
      type: "warden.candidate.deliver",
      status: "pending",
    });
    expect(getWardenCandidateDeliveryByRun(db, "tenant-a", "warden-run-1")).toEqual(first);
    expect(getWardenCandidateDeliveryByRun(db, "tenant-b", "warden-run-1")).toBeUndefined();
  });

  it("rejects a replay whose immutable repository binding differs", () => {
    const db = fixture();
    const base = {
      tenantId: "tenant-a",
      runId: "warden-run-1",
      repositoryId: "repo-1",
      snapshotId: "snapshot-1",
      baseBranch: "main",
      expectedBaseRevision: "a".repeat(40),
      sealedPath: "C:\\data\\warden-evidence\\tenant-a\\approvals\\seal.json",
      sealedSha256: `sha256:${"b".repeat(64)}`,
      requesterPrincipalId: "human:reviewer@example.com",
      rationale: "The target and regression checks pass.",
      now: NOW,
    } as const;
    enqueueWardenCandidateDelivery(db, base);
    expect(() => enqueueWardenCandidateDelivery(db, { ...base, baseBranch: "release" }))
      .toThrow("warden_candidate_delivery_conflict");
  });

  const deliveryInput = {
    tenantId: "tenant-a",
    runId: "warden-run-1",
    repositoryId: "repo-1",
    snapshotId: "snapshot-1",
    baseBranch: "main",
    expectedBaseRevision: "a".repeat(40),
    sealedPath: "C:\\data\\warden-evidence\\tenant-a\\approvals\\seal.json",
    sealedSha256: `sha256:${"b".repeat(64)}`,
    requesterPrincipalId: "human:reviewer@example.com",
    rationale: "The target and regression checks pass.",
    now: NOW,
  } as const;

  it("binds intent and records one draft delivery, idempotently", () => {
    const db = fixture();
    const delivery = enqueueWardenCandidateDelivery(db, deliveryInput);

    const bound = bindWardenCandidateDeliveryIntent(db, {
      tenantId: "tenant-a", deliveryId: delivery.id, intentDigest: `sha256:${"c".repeat(64)}`,
      branchName: "mendpoint/warden-run-1", observedAt: NOW,
    });
    expect(bound.intentDigest).toBe(`sha256:${"c".repeat(64)}`);
    expect(bindWardenCandidateDeliveryIntent(db, {
      tenantId: "tenant-a", deliveryId: delivery.id, intentDigest: `sha256:${"c".repeat(64)}`,
      branchName: "mendpoint/warden-run-1", observedAt: NOW,
    })).toEqual(bound);

    const delivered = recordWardenCandidateDeliverySuccess(db, {
      tenantId: "tenant-a", deliveryId: delivery.id, branchName: "mendpoint/warden-run-1",
      baseRevision: "a".repeat(40), commitSha: "d".repeat(40), draftPrNumber: 42,
      draftPrUrl: "https://github.com/acme/service/pull/42", observedAt: NOW,
    });
    expect(delivered.status).toBe("delivered");
    expect(delivered.draftPrNumber).toBe(42);
    // Replaying the identical PR is idempotent.
    expect(recordWardenCandidateDeliverySuccess(db, {
      tenantId: "tenant-a", deliveryId: delivery.id, branchName: "mendpoint/warden-run-1",
      baseRevision: "a".repeat(40), commitSha: "d".repeat(40), draftPrNumber: 42,
      draftPrUrl: "https://github.com/acme/service/pull/42", observedAt: NOW,
    })).toEqual(delivered);
    // A different PR against an already-delivered row must fail closed, not overwrite silently.
    expect(() => recordWardenCandidateDeliverySuccess(db, {
      tenantId: "tenant-a", deliveryId: delivery.id, branchName: "mendpoint/warden-run-1",
      baseRevision: "a".repeat(40), commitSha: "e".repeat(40), draftPrNumber: 99,
      draftPrUrl: "https://github.com/acme/service/pull/99", observedAt: NOW,
    })).toThrow("warden_candidate_delivery_not_pending");
  });

  it("fails closed when a retried job succeeds against a terminal delivery_failed row", () => {
    const db = fixture();
    const delivery = enqueueWardenCandidateDelivery(db, deliveryInput);
    // Attempt 1 exhausts its retries and dead-letters: the delivery goes terminal.
    const failed = recordWardenCandidateDeliveryFailure(db, {
      tenantId: "tenant-a", deliveryId: delivery.id, errorCode: "github_pr_failed",
      errorMessage: "draft PR creation failed", terminal: true, observedAt: NOW,
    });
    expect(failed.status).toBe("delivery_failed");

    // An operator retries the dead-lettered job; attempt 2 creates a REAL draft PR and reports back.
    // Both the intent bind and the success write must refuse the terminal row loudly rather than
    // silently discard the write and return a fake success.
    expect(() => bindWardenCandidateDeliveryIntent(db, {
      tenantId: "tenant-a", deliveryId: delivery.id, intentDigest: `sha256:${"c".repeat(64)}`,
      branchName: "mendpoint/warden-run-1", observedAt: NOW,
    })).toThrow("warden_candidate_delivery_not_pending");
    expect(() => recordWardenCandidateDeliverySuccess(db, {
      tenantId: "tenant-a", deliveryId: delivery.id, branchName: "mendpoint/warden-run-1",
      baseRevision: "a".repeat(40), commitSha: "d".repeat(40), draftPrNumber: 42,
      draftPrUrl: "https://github.com/acme/service/pull/42", observedAt: NOW,
    })).toThrow("warden_candidate_delivery_not_pending");

    // The terminal row is untouched: it never claims a delivery it did not persist, and the intent
    // fence never bound.
    const after = getWardenCandidateDelivery(db, "tenant-a", delivery.id)!;
    expect(after.status).toBe("delivery_failed");
    expect(after.intentDigest).toBeNull();
    expect(after.draftPrNumber).toBeNull();
  });
});
