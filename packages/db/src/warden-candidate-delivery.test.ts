import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, getJob, insertAgentRun, type AppDb } from "./index.js";
import {
  enqueueWardenCandidateDelivery,
  getWardenCandidateDeliveryByRun,
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
});
