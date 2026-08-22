import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimNextJob,
  createDb,
  enqueueJob,
  getAgentRun,
  getJob,
  upsertGitHubInstallation,
  type AppDb,
} from "@mendpoint/db";
import { runFettlerPrReviewDispatch } from "./fettler-pr-review-dispatch.js";

const opened: Array<{ db: AppDb; root: string }> = [];
const sha = (value: string) => value.repeat(40);
const NOW = "2026-08-21T12:00:00.000Z";

afterEach(() => {
  for (const value of opened.splice(0)) {
    value.db.raw.close();
    rmSync(value.root, { recursive: true, force: true });
  }
});

function agentRunCount(db: AppDb): number {
  const row = db.raw
    .prepare(`SELECT COUNT(*) AS count FROM jobs WHERE type = 'agent.run'`)
    .get() as { count: number };
  return Number(row.count);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-pr-review-dispatch-"));
  const db = createDb(join(root, "worker.sqlite"));
  opened.push({ db, root });
  upsertGitHubInstallation(db, {
    id: "install-a",
    installationId: "202",
    accountId: "303",
    accountLogin: "acme",
    tenantId: "tenant-a",
    repositorySelection: "selected",
    repositories: [{ id: 101, owner: "acme", name: "service" }],
    createdAt: NOW,
    updatedAt: NOW,
  });
  db.raw
    .prepare(
      `INSERT INTO consumers
         (id, name, github_owner, github_repo, installation_id, github_delivery_mode, tenant_id, created_at)
       VALUES ('consumer-a', 'Acme service', 'acme', 'service', '202', 'app', 'tenant-a', ?)`,
    )
    .run(NOW);
  enqueueJob(db, {
    id: "fettler-pr-dispatch-a",
    tenantId: "tenant-a",
    type: "fettler.pr.review",
    payload: {
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      remoteRepositoryId: 101,
      installationId: 202,
      consumerId: "consumer-a",
      pullRequestNumber: 42,
      headSha: sha("d"),
      headRef: "feature/x",
      deliveryId: "delivery-1",
    },
    createdAt: NOW,
  });
  const job = claimNextJob(db, ["fettler.pr.review"], {
    tenantId: "tenant-a",
    workerId: "worker-a",
    leaseMs: 60_000,
    now: "2026-08-21T12:00:30.000Z",
  })!;
  return { db, job, root };
}

describe("Fettler PR review dispatch", () => {
  it("enqueues exactly one agent run bound to the exact PR head snapshot", async () => {
    const { db, job, root } = fixture();
    const materializeHead = vi.fn(async () => ({
      repositoryId: "repo-a",
      snapshotId: "snapshot-review-a",
      revision: sha("d"),
      manifestSha256: "e".repeat(64),
      root,
    }));

    const result = await runFettlerPrReviewDispatch({
      db,
      job,
      materializeHead,
      now: () => "2026-08-21T12:01:00.000Z",
    });
    expect(result.status).toBe("review_enqueued");
    if (result.status !== "review_enqueued") throw new Error("unreachable");

    expect(materializeHead).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        repositoryId: "repo-a",
        remoteRepositoryId: 101,
        installationId: 202,
        headSha: sha("d"),
      }),
    );
    expect(agentRunCount(db)).toBe(1);

    const agentJob = getJob(db, result.agentJobId, "tenant-a")!;
    const payload = JSON.parse(agentJob.payload_json) as Record<string, unknown>;
    expect(payload.snapshotBinding).toEqual({
      repositoryId: "repo-a",
      snapshotId: "snapshot-review-a",
      revision: sha("d"),
      manifestSha256: "e".repeat(64),
    });
    expect(payload.consumerId).toBe("consumer-a");
    expect(payload.maxModelCalls).toBeGreaterThan(0);
    expect(payload.maximumCostUsd).toBeGreaterThan(0);

    const run = getAgentRun(db, result.runId, "tenant-a");
    expect(run?.status).toBe("queued");
  });

  it("never approves, merges, or pushes on this path", async () => {
    const { db, job, root } = fixture();
    const materializeHead = vi.fn(async () => ({
      repositoryId: "repo-a",
      snapshotId: "snapshot-review-a",
      revision: sha("d"),
      manifestSha256: "e".repeat(64),
      root,
    }));
    const result = await runFettlerPrReviewDispatch({
      db,
      job,
      materializeHead,
      now: () => "2026-08-21T12:01:00.000Z",
    });
    if (result.status !== "review_enqueued") throw new Error("unreachable");
    const agentJob = getJob(db, result.agentJobId, "tenant-a")!;
    const payload = JSON.parse(agentJob.payload_json) as Record<string, unknown>;
    // No delivery/merge/approve/push directive of any kind in the enqueued run.
    expect(payload).not.toHaveProperty("merge");
    expect(payload).not.toHaveProperty("approve");
    expect(payload).not.toHaveProperty("push");
    expect(payload).not.toHaveProperty("snapshotBinding.merge");
    expect(String(payload.goal)).toContain("do not approve, merge, or push");
    // The only jobs created are the dispatch (done) and one queued analysis run.
    const types = (
      db.raw.prepare(`SELECT type, status FROM jobs ORDER BY type`).all() as Array<{
        type: string;
        status: string;
      }>
    );
    expect(types.filter((row) => row.type === "agent.run")).toHaveLength(1);
    expect(types.some((row) => row.type.includes("deliver"))).toBe(false);
  });

  it("is idempotent: a second dispatch for the same head enqueues no second run", async () => {
    const { db, job, root } = fixture();
    const materializeHead = vi.fn(async () => ({
      repositoryId: "repo-a",
      snapshotId: "snapshot-review-a",
      revision: sha("d"),
      manifestSha256: "e".repeat(64),
      root,
    }));
    await runFettlerPrReviewDispatch({ db, job, materializeHead, now: () => "2026-08-21T12:01:00.000Z" });
    expect(agentRunCount(db)).toBe(1);

    // Re-deliver the same PR head through a fresh dispatch job.
    enqueueJob(db, {
      id: "fettler-pr-dispatch-b",
      tenantId: "tenant-a",
      type: "fettler.pr.review",
      payload: {
        tenantId: "tenant-a",
        repositoryId: "repo-a",
        remoteRepositoryId: 101,
        installationId: 202,
        consumerId: "consumer-a",
        pullRequestNumber: 42,
        headSha: sha("d"),
        headRef: "feature/x",
        deliveryId: "delivery-2",
      },
      createdAt: "2026-08-21T12:02:00.000Z",
    });
    const second = claimNextJob(db, ["fettler.pr.review"], {
      tenantId: "tenant-a",
      workerId: "worker-a",
      leaseMs: 60_000,
      now: "2026-08-21T12:02:30.000Z",
    })!;
    const result = await runFettlerPrReviewDispatch({
      db,
      job: second,
      materializeHead,
      now: () => "2026-08-21T12:03:00.000Z",
    });
    expect(result.status).toBe("already_enqueued");
    expect(agentRunCount(db)).toBe(1);
  });

  it("refuses to act when the installation is no longer authoritative", async () => {
    const { db, job, root } = fixture();
    db.raw
      .prepare(`UPDATE github_installations SET deleted_at = ? WHERE installation_id = '202'`)
      .run(NOW);
    const materializeHead = vi.fn(async () => ({
      repositoryId: "repo-a",
      snapshotId: "snapshot-review-a",
      revision: sha("d"),
      manifestSha256: "e".repeat(64),
      root,
    }));
    await expect(
      runFettlerPrReviewDispatch({ db, job, materializeHead, now: () => "2026-08-21T12:01:00.000Z" }),
    ).rejects.toThrow("fettler_pr_review_installation_not_authorized");
    expect(materializeHead).not.toHaveBeenCalled();
    expect(agentRunCount(db)).toBe(0);
  });
});
