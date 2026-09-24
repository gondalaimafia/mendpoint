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

  // Stateful fake Octokit for the exact-draft flow, shaped exactly like the
  // successful-reconcile fixture above so commit_ready reconciliation works.
  // Hooks let a test fail branch creation for a specific base or lose the
  // pull-creation response.
  function deliveryHarness(opts?: {
    baseHead?: () => string;
    onCreateRef?: (sha: string, call: number) => "ok" | "503";
    onPullsCreate?: (call: number) => "ok" | "econnreset";
  }) {
    let branchHead: string | null = null;
    let pull: Record<string, unknown> | null = null;
    let createRefCall = 0;
    let pullsCreateCall = 0;
    const baseHead = opts?.baseHead ?? (() => BASE_SHA);
    const octokit = {
      git: {
        getRef: vi.fn(async ({ ref }: { ref: string }) => {
          if (ref === "heads/main") return { data: { object: { sha: baseHead() } } };
          if (branchHead === null) throw Object.assign(new Error("not_found"), { status: 404 });
          return { data: { object: { sha: branchHead } } };
        }),
        getCommit: vi.fn(async ({ commit_sha }: { commit_sha: string }) => ({
          data: commit_sha === COMMIT_SHA
            ? {
                sha: COMMIT_SHA,
                tree: { sha: HEAD_TREE_SHA },
                parents: [{ sha: BASE_SHA }],
                message: "Open approved Fettler candidate",
                author: { name: "Mendpoint", email: "delivery@mendpoint.ai", date: "2026-09-02T12:00:00.000Z" },
                committer: { name: "Mendpoint", email: "delivery@mendpoint.ai", date: "2026-09-02T12:00:00.000Z" },
              }
            : { sha: commit_sha, tree: { sha: BASE_TREE_SHA }, parents: [] },
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
        createBlob: vi.fn(async () => ({ data: { sha: HEAD_BLOB_SHA } })),
        createTree: vi.fn(async () => ({ data: { sha: HEAD_TREE_SHA } })),
        createCommit: vi.fn(async () => ({ data: { sha: COMMIT_SHA } })),
        createRef: vi.fn(async ({ sha }: { sha: string }) => {
          createRefCall += 1;
          if ((opts?.onCreateRef?.(sha, createRefCall) ?? "ok") === "503") {
            throw Object.assign(new Error("service_unavailable"), { status: 503 });
          }
          branchHead = sha;
          return {};
        }),
        updateRef: vi.fn(async ({ sha }: { sha: string }) => {
          branchHead = sha;
          return { data: { object: { sha } } };
        }),
      },
      repos: {
        getContent: vi.fn(async () => ({
          data: { type: "file", encoding: "base64", content: Buffer.from("changed\n", "utf8").toString("base64") },
        })),
      },
      pulls: {
        list: vi.fn(async () => ({ data: pull ? [pull] : [] })),
        create: vi.fn(async (args: { title: string; body: string; head: string; base: string }) => {
          pullsCreateCall += 1;
          if ((opts?.onPullsCreate?.(pullsCreateCall) ?? "ok") === "econnreset") {
            throw Object.assign(new Error("response_lost"), { code: "ECONNRESET" });
          }
          // Echo the requested title/body/head/base so the exact-draft
          // verification (which requires byte-equality) accepts the created PR
          // whatever dynamic body the caller sends.
          pull = {
            number: 24,
            html_url: "https://github.com/acme/shop/pull/24",
            state: "open",
            draft: true,
            title: args.title,
            body: args.body,
            head: { ref: args.head, sha: COMMIT_SHA },
            base: { ref: args.base, sha: baseHead() },
          };
          return { data: pull };
        }),
      },
    };
    return { octokit, branchHead: () => branchHead };
  }

  function harnessDelivery(
    queue: ReturnType<typeof createDependencyOutageQueue>,
    octokit: unknown,
    now: () => string,
  ): GitHubAppDelivery {
    const delivery = new GitHubAppDelivery(credentials(), 42, undefined, [77], {
      tenantId: "tenant-acme",
      outage: queue,
      decide: classifyDependencyOutage,
      retryBudget: 5,
      expiresInMs: 60 * 60_000,
      workerId: "worker-1",
      authorityVersion: "installation-v1",
      now,
    });
    (delivery as unknown as { octokit: () => Promise<unknown> }).octokit = async () => octokit;
    return delivery;
  }

  it("(i) retries the identical operation and delivers one PR after a single 503 on branch creation (no move)", async () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    // The remote head never moves; branch creation fails once then succeeds.
    const { octokit } = deliveryHarness({ onCreateRef: (_sha, call) => (call === 1 ? "503" : "ok") });
    const delivery = harnessDelivery(queue, octokit, () => now);

    // Attempt 1 defers the operation (transient 503, branch not created).
    await expect(delivery.deliverExactDraft(draftInput())).rejects.toMatchObject({ status: "deferred" });
    // Attempt 2 replays the IDENTICAL operation (same base and body) — the
    // durable queue accepts the same digest and it delivers. A re-anchor here
    // would regenerate the body, change the digest, and be rejected forever.
    now = "2026-09-02T12:00:05.000Z";
    await expect(delivery.deliverExactDraft(draftInput())).resolves.toMatchObject({
      number: 24,
      commitSha: COMMIT_SHA,
      draft: true,
    });
    expect(octokit.git.createRef).toHaveBeenCalledTimes(2);
    expect(octokit.pulls.create).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("(ii) supersedes the abandoned operation and re-anchors onto the moved base to deliver one PR", async () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    const movedBase = "e".repeat(40);
    let currentBase = BASE_SHA;
    const queue = createDependencyOutageQueue(db, { now: () => now });
    // Branch creation fails for the original base (X) forever; it succeeds only
    // for the moved base (Y). The remote head is X, then moves to Y.
    const { octokit } = deliveryHarness({
      baseHead: () => currentBase,
      onCreateRef: (sha) => (sha === BASE_SHA ? "503" : "ok"),
    });
    const delivery = harnessDelivery(queue, octokit, () => now);

    // Attempt against base X fails before the branch is created.
    await expect(delivery.deliverExactDraft(draftInput())).rejects.toMatchObject({ status: "deferred" });
    // No write happened, so the abandoned operation may be retired.
    const retirement = await delivery.retireDeliveryOperation({
      owner: "acme",
      repo: "shop",
      branch: "mendpoint/fettler/candidate-a",
      baseSha: BASE_SHA,
    });
    expect(retirement).toEqual({ superseded: true });

    // The remote head moves to Y; the re-anchored delivery is a fresh operation
    // (base is part of the operation id), so no digest conflict — it delivers.
    now = "2026-09-02T12:00:05.000Z";
    currentBase = movedBase;
    await expect(
      delivery.deliverExactDraft({ ...draftInput(), expectedBaseSha: movedBase }),
    ).resolves.toMatchObject({ number: 24, draft: true });

    // The old operation is retired (a superseded transition), not deleted, and
    // it no longer reads as an outstanding degraded outage.
    const health = queue.tenantHealth({ tenantId: "tenant-acme" });
    expect(health.standing).toBe("healthy");
    expect(health.operations.some((op) => op.lastTransition?.kind === "superseded")).toBe(true);
    db.close();
  });

  it("(iii) reconciles the existing PR after a lost pull-creation response even when the base moved (base reused)", async () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    let currentBase = BASE_SHA;
    const movedBase = "e".repeat(40);
    const queue = createDependencyOutageQueue(db, { now: () => now });
    // The branch and commit are written; the first pull-creation response is
    // lost. The remote head then moves, but the base is REUSED (the branch
    // exists), so reconciliation resumes from the existing commit.
    const { octokit } = deliveryHarness({
      baseHead: () => currentBase,
      onPullsCreate: (call) => (call === 1 ? "econnreset" : "ok"),
    });
    const delivery = harnessDelivery(queue, octokit, () => now);

    await expect(delivery.deliverExactDraft(draftInput())).rejects.toMatchObject({ status: "blocked" });
    now = "2026-09-02T12:00:05.000Z";
    currentBase = movedBase;
    // The SAME base is replayed (lost-response reconciliation), so the operation
    // id and digest are unchanged and the existing commit resumes to one PR.
    await expect(delivery.deliverExactDraft(draftInput())).resolves.toMatchObject({
      number: 24,
      commitSha: COMMIT_SHA,
    });
    expect(octokit.pulls.create).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("(v) refuses to supersede an operation whose PR was written (completed)", async () => {
    const db = new DatabaseSync(":memory:");
    const now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    const { octokit } = deliveryHarness();
    const delivery = harnessDelivery(queue, octokit, () => now);

    await expect(delivery.deliverExactDraft(draftInput())).resolves.toMatchObject({ number: 24 });
    // The operation completed (the PR was written), so retirement is refused —
    // never abandon and re-anchor away from a delivery that wrote.
    const retirement = await delivery.retireDeliveryOperation({
      owner: "acme",
      repo: "shop",
      branch: "mendpoint/fettler/candidate-a",
      baseSha: BASE_SHA,
    });
    expect(retirement).toEqual({ superseded: false, reason: "operation_completed" });
    db.close();
  });

  it("branchExists is fail-closed: false only on 404, true on a hit, and rejects on any other error", async () => {
    const db = new DatabaseSync(":memory:");
    const now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    let mode: "hit" | "missing" | "error" = "missing";
    const octokit = {
      git: {
        getRef: vi.fn(async () => {
          if (mode === "hit") return { data: { object: { sha: COMMIT_SHA } } };
          if (mode === "missing") throw Object.assign(new Error("not_found"), { status: 404 });
          throw Object.assign(new Error("service_unavailable"), { status: 503 });
        }),
      },
    };
    const delivery = harnessDelivery(queue, octokit, () => now);
    mode = "missing";
    await expect(delivery.branchExists("acme", "shop", "mendpoint/x")).resolves.toBe(false);
    mode = "hit";
    await expect(delivery.branchExists("acme", "shop", "mendpoint/x")).resolves.toBe(true);
    mode = "error";
    await expect(delivery.branchExists("acme", "shop", "mendpoint/x")).rejects.toMatchObject({ status: 503 });
    db.close();
  });

  it("(wedge) a base revisited after retirement delivers under a higher generation with no permanent digest conflict", async () => {
    const db = new DatabaseSync(":memory:");
    const now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    // The remote head never leaves base X here; branch creation fails once so
    // the generation-0 operation is retired before any write.
    const { octokit } = deliveryHarness({ onCreateRef: (_sha, call) => (call === 1 ? "503" : "ok") });
    const delivery = harnessDelivery(queue, octokit, () => now);
    const branch = "mendpoint/fettler/candidate-a";

    await expect(delivery.deliverExactDraft(draftInput())).rejects.toMatchObject({ status: "deferred" });
    expect(await delivery.retireDeliveryOperation({ owner: "acme", repo: "shop", branch, baseSha: BASE_SHA, lineage: 0 }))
      .toEqual({ superseded: true });

    // The remote returns to base X and the pipeline regenerates the body. With a
    // base-only id (round 7) this would collide with the retired row's digest
    // and wedge on dependency_outage_operation_digest_conflict forever...
    await expect(
      delivery.deliverExactDraft({ ...draftInput(), body: "Regenerated body", deliveryLineage: 0 }),
    ).rejects.toThrow("dependency_outage_operation_digest_conflict");
    // ...but generation 1 is a distinct operation, so it delivers one PR.
    await expect(
      delivery.deliverExactDraft({ ...draftInput(), body: "Regenerated body", deliveryLineage: 1 }),
    ).resolves.toMatchObject({ number: 24, draft: true });
    db.close();
  });
});
