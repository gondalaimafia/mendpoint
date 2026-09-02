import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createDependencyOutageQueue } from "@mendpoint/db";
import {
  GitHubAppDelivery,
  type ExactDraftDeliveryInput,
} from "@mendpoint/github";
import { classifyDependencyOutage } from "@mendpoint/ops";

const BASE_SHA = "a".repeat(40);
const COMMIT_SHA = "c".repeat(40);
const COMPLETION = "d".repeat(64);
const BASE_TREE_SHA = "1".repeat(40);
const HEAD_TREE_SHA = "2".repeat(40);
const BASE_BLOB_SHA = "3".repeat(40);
const HEAD_BLOB_SHA = "4".repeat(40);

function credentials() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    appId: "99",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function draftInput(): ExactDraftDeliveryInput {
  return {
    owner: "acme",
    repo: "shop",
    baseBranch: "main",
    expectedBaseSha: BASE_SHA,
    branch: "mendpoint/fettler/candidate-a",
    commitMessage: "Open approved Fettler candidate",
    commitDate: "2026-09-02T12:00:00.000Z",
    title: "Fettler candidate",
    body: "Exact candidate",
    files: [{ path: "src/a.ts", content: "changed\n", mode: "100644" }],
  };
}

describe("dependency outage producer-to-consumer recovery", () => {
  it("accepts the exact shared policy decision through the real durable queue", async () => {
    const db = new DatabaseSync(":memory:");
    const now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    const scope = {
      tenantId: "tenant-acme",
      dependencyKind: "model" as const,
      providerId: "muse-spark",
      operationId: "mission-123:model-call-4",
      operationDigest: "b".repeat(64),
    };

    await expect(queue.run({
      ...scope,
      workerId: "worker-1",
      retryBudget: 3,
      expiresAt: "2026-09-02T13:00:00.000Z",
      leaseMs: 30_000,
      authorityVersion: "model-authority-v1",
      reconcile: async () => ({ status: "missing" as const }),
      execute: async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
      classify: (_error, context) => classifyDependencyOutage({
        ...scope,
        failureKind: "transient",
        attempt: context.attempt,
        retryBudget: context.retryBudget,
        now: context.now,
        expiresAt: "2026-09-02T13:00:00.000Z",
        circuit: context.circuit,
      }),
    })).resolves.toMatchObject({
      status: "deferred",
      record: {
        status: "queued",
        lastFailureKind: "transient",
        lastFailureReason: "transient_failure",
      },
      decision: { attemptsRemaining: 2 },
    });
    db.close();
  });

  it("resumes a commit-ready draft through the real queue without repeating Git object writes", async () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    let branchSha = BASE_SHA;
    const queue = createDependencyOutageQueue(db, { now: () => now });
    const createBlob = vi.fn(async () => ({ data: { sha: HEAD_BLOB_SHA } }));
    const createTree = vi.fn(async () => ({ data: { sha: HEAD_TREE_SHA } }));
    const createCommit = vi.fn(async () => ({ data: { sha: COMMIT_SHA } }));
    const updateRef = vi.fn(async ({ sha }: { sha: string }) => {
      branchSha = sha;
      return { data: { object: { sha } } };
    });
    const exactPull = {
      number: 24,
      html_url: "https://github.com/acme/shop/pull/24",
      state: "open",
      draft: true,
      title: "Fettler candidate",
      body: "Exact candidate",
      head: { ref: "mendpoint/fettler/candidate-a", sha: COMMIT_SHA },
      base: { ref: "main", sha: BASE_SHA },
    };
    let pullCreateAttempts = 0;
    const fakeOctokit = {
      git: {
        getRef: vi.fn(async ({ ref }: { ref: string }) => ({
          data: { object: { sha: ref === "heads/main" ? BASE_SHA : branchSha } },
        })),
        getCommit: vi.fn(async ({ commit_sha }: { commit_sha: string }) => ({
          data: commit_sha === BASE_SHA
            ? { sha: BASE_SHA, tree: { sha: BASE_TREE_SHA }, parents: [] }
            : {
                sha: COMMIT_SHA,
                tree: { sha: HEAD_TREE_SHA },
                parents: [{ sha: BASE_SHA }],
                message: "Open approved Fettler candidate",
                author: {
                  name: "Mendpoint",
                  email: "delivery@mendpoint.ai",
                  date: "2026-09-02T12:00:00.000Z",
                },
                committer: {
                  name: "Mendpoint",
                  email: "delivery@mendpoint.ai",
                  date: "2026-09-02T12:00:00.000Z",
                },
              },
        })),
        getTree: vi.fn(async ({ tree_sha }: { tree_sha: string }) => ({
          data: {
            truncated: false,
            tree: [{
              path: "src/a.ts",
              type: "blob",
              mode: "100644",
              sha: tree_sha === BASE_TREE_SHA ? BASE_BLOB_SHA : HEAD_BLOB_SHA,
            }],
          },
        })),
        createBlob,
        createTree,
        createCommit,
        createRef: vi.fn(async () => { throw new Error("create_ref_not_expected"); }),
        updateRef,
      },
      repos: {
        getContent: vi.fn(async () => ({
          data: {
            type: "file",
            encoding: "base64",
            content: Buffer.from("changed\n", "utf8").toString("base64"),
          },
        })),
      },
      pulls: {
        list: vi.fn(async () => ({ data: [] })),
        create: vi.fn(async () => {
          pullCreateAttempts += 1;
          if (pullCreateAttempts === 1) {
            throw Object.assign(new Error("response_lost"), { code: "ECONNRESET" });
          }
          return { data: exactPull };
        }),
      },
    };
    const delivery = new GitHubAppDelivery(
      credentials(),
      42,
      undefined,
      [77],
      {
        tenantId: "tenant-acme",
        outage: queue,
        decide: classifyDependencyOutage,
        retryBudget: 5,
        expiresInMs: 60 * 60_000,
        workerId: "worker-1",
        authorityVersion: "installation-v1",
        now: () => now,
      },
    );
    (delivery as unknown as { octokit: () => Promise<typeof fakeOctokit> }).octokit =
      async () => fakeOctokit;

    await expect(delivery.deliverExactDraft(draftInput())).rejects.toMatchObject({ status: "blocked" });
    now = "2026-09-02T12:00:01.000Z";
    await expect(delivery.deliverExactDraft(draftInput())).resolves.toMatchObject({
      number: 24,
      commitSha: COMMIT_SHA,
      draft: true,
    });
    expect(createBlob).toHaveBeenCalledTimes(1);
    expect(createTree).toHaveBeenCalledTimes(1);
    expect(createCommit).toHaveBeenCalledTimes(1);
    expect(updateRef).toHaveBeenCalledTimes(1);
    expect(fakeOctokit.pulls.create).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("classifies a near-deadline GitHub replay against the retained queue expiry", async () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    let branchReads = 0;
    const queue = createDependencyOutageQueue(db, { now: () => now });
    const fakeOctokit = {
      git: {
        getRef: vi.fn(async () => {
          branchReads += 1;
          if (branchReads % 2 === 1) {
            throw Object.assign(new Error("not_found"), { status: 404 });
          }
          throw Object.assign(new Error("service_unavailable"), { status: 503 });
        }),
      },
    };
    const delivery = new GitHubAppDelivery(
      credentials(),
      42,
      undefined,
      [77],
      {
        tenantId: "tenant-acme",
        outage: queue,
        decide: classifyDependencyOutage,
        retryBudget: 5,
        expiresInMs: 60 * 60_000,
        workerId: "worker-1",
        authorityVersion: "installation-v1",
        now: () => now,
      },
    );
    (delivery as unknown as { octokit: () => Promise<typeof fakeOctokit> }).octokit =
      async () => fakeOctokit;

    await expect(delivery.deliverExactDraft(draftInput())).rejects.toMatchObject({ status: "deferred" });
    now = "2026-09-02T12:59:59.000Z";
    await expect(delivery.deliverExactDraft(draftInput())).rejects.toMatchObject({
      status: "failed",
      decision: { failureKind: "expired", reason: "operation_expired" },
    });
    expect(queue.tenantHealth({ tenantId: "tenant-acme" })).toMatchObject({
      standing: "degraded_failed",
      operations: [{ status: "failed", expiresAt: "2026-09-02T13:00:00.000Z" }],
    });
    db.close();
  });
});
