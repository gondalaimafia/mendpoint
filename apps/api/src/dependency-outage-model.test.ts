/**
 * Delivery state-machine model test.
 *
 * This is the falsifiable specification the PR #606 redesign must satisfy. It
 * drives the REAL production machinery — a real `DependencyOutageQueue` on an
 * in-memory SQLite db, a real `GitHubAppDelivery` whose Octokit is the
 * content-addressed `FakeGitHub`, and the real `classifyDependencyOutage`
 * policy — through interleavings the eight review rounds each surfaced late.
 *
 * The invariants (design §1):
 *   I1 Uniqueness   — at most one open PR per delivery branch.
 *   I2 No orphan    — every PR whose head is the branch is recorded.
 *   I3 No destroyed write — refs move only by create or fast-forward.
 *   I5 Liveness     — a reachable, non-foreign branch reaches draft within
 *                     bounded attempts; elapsed time / lease / budget never make
 *                     the delivery terminal.
 *   I7 Monotone record — status never regresses from draft.
 *
 * Phase 1 of the redesign (this commit) pins the invariants and REPRODUCES the
 * defects that stopped the patch rounds, against the current `deliverExactDraft`
 * + ledger machinery at head 5752028b:
 *   - round-8 defect 1: a stalled worker's late write orphans a PR;
 *   - round-8 defect 2: an outage longer than the 1 h operation expiry leaves
 *     the delivery permanently failed;
 *   - D1: a failure write clobbers a recorded PR (status regresses).
 * Later phases repoint the same invariants at the adoptive-draft state machine,
 * where they must all hold.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createDb,
  createDependencyOutageQueue,
  insertMigrationPr,
  updateMigrationPrDelivery,
} from "@mendpoint/db";
import { GitHubAppDelivery, type ExactDraftDeliveryInput } from "@mendpoint/github";
import { classifyDependencyOutage } from "@mendpoint/ops";
import { FakeGitHub, type FakeGitHubOptions } from "@mendpoint/github/testing/fake-github";

const OWNER = "acme";
const REPO = "shop";
const BRANCH = "mendpoint/fettler/candidate-a";
const BASE_BRANCH = "main";

function credentials() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { appId: "99", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

/** A releasable hold used to park one worker mid-call while another proceeds. */
function makeHold(): { promise: Promise<void>; release: () => void; reached: Promise<void>; markReached: () => void } {
  let release!: () => void;
  let markReached!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { markReached = resolve; });
  return { promise, release, reached, markReached };
}

function draftInput(overrides: Partial<ExactDraftDeliveryInput> = {}): ExactDraftDeliveryInput {
  return {
    owner: OWNER,
    repo: REPO,
    baseBranch: BASE_BRANCH,
    expectedBaseSha: "",
    branch: BRANCH,
    commitMessage: "Open approved Fettler candidate",
    commitDate: "2026-09-02T12:00:00.000Z",
    title: "Fettler candidate",
    body: "Exact candidate body with structured package section",
    files: [{ path: "src/a.ts", content: "changed\n", mode: "100644" }],
    ...overrides,
  };
}

function makeDelivery(
  queue: ReturnType<typeof createDependencyOutageQueue>,
  fake: FakeGitHub,
  workerId: string,
  now: () => string,
): GitHubAppDelivery {
  const delivery = new GitHubAppDelivery(credentials(), 42, undefined, [77], {
    tenantId: "tenant-acme",
    outage: queue,
    decide: classifyDependencyOutage,
    retryBudget: 5,
    expiresInMs: 60 * 60_000,
    workerId,
    leaseMs: 30_000,
    authorityVersion: "installation-v1",
    now,
  });
  (delivery as unknown as { octokit: () => Promise<unknown> }).octokit = async () => fake;
  return delivery;
}

function fakeWith(options: FakeGitHubOptions, seedBase: string): { fake: FakeGitHub; baseSha: string } {
  const fake = new FakeGitHub(options);
  const baseSha = fake.seedDefaultBranch({
    owner: OWNER,
    repo: REPO,
    branch: BASE_BRANCH,
    content: { "src/a.ts": "original\n" },
    message: seedBase,
    date: "2026-09-02T11:00:00.000Z",
  });
  return { fake, baseSha };
}

// --- Reusable invariant checks (used by the redesign phases too) ------------

/** I1: at most one OPEN pull per delivery branch. */
function assertUniqueOpenPr(fake: FakeGitHub): void {
  expect(fake.openPulls(OWNER, REPO, BRANCH).length).toBeLessThanOrEqual(1);
}

/** I3: refs only ever move by create or fast-forward, never force/delete. */
function assertRefsOnlyForward(fake: FakeGitHub): void {
  for (const entry of fake.refLog(OWNER, REPO)) {
    expect(entry.op === "create" || (entry.op === "update" && entry.fastForward)).toBe(true);
  }
}

describe("delivery state machine — invariants and reproduced defects (head 5752028b)", () => {
  it("REPRODUCES round-8 defect 2: an outage longer than the operation expiry fails the delivery permanently (I5 violated)", async () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    // The outage is a clock window: every call fails 503 while now is inside it.
    // The window outlasts the 1 h operation expiry.
    const outageEndsAt = Date.parse("2026-09-02T14:00:00.000Z"); // 2 h > 1 h expiry
    const { fake, baseSha } = fakeWith(
      { clock: () => now, faults: ({ now: at }) =>
        Date.parse(at) < outageEndsAt
          ? { kind: "fail-before", status: 503, message: "service_unavailable" }
          : { kind: "pass" } },
      "seed",
    );
    const delivery = makeDelivery(queue, fake, "worker-1", () => now);
    const input = draftInput({ expectedBaseSha: baseSha });

    // Attempt 1 during the outage defers (transient 503).
    await expect(delivery.deliverExactDraft(input)).rejects.toMatchObject({ status: "deferred" });
    // Advance past the 1 h operation expiry, still inside the outage. The queue
    // fails the expired operation terminally (via the claim-time expiry branch).
    now = "2026-09-02T13:30:00.000Z";
    await expect(delivery.deliverExactDraft(input)).rejects.toMatchObject({ status: "failed" });
    // The outage is over and the branch is fully reachable, but the operation is
    // permanently failed and never recovers — I5 (liveness) is violated. A retry
    // with the SAME identity re-observes the terminal row and stays failed.
    now = "2026-09-02T14:30:00.000Z";
    await expect(delivery.deliverExactDraft(input)).rejects.toMatchObject({ status: "failed" });
    expect(queue.tenantHealth({ tenantId: "tenant-acme", now }).standing).toBe("degraded_failed");
    // Nothing was ever delivered even though GitHub is now healthy.
    expect(fake.allPulls(OWNER, REPO).length).toBe(0);
    db.close();
  });

  it("REPRODUCES round-8 defect 1: a stalled worker's late write orphans a PR (I2 violated)", async () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    const createRefHold = makeHold();
    // Worker 1 is held just before its createRef lands; every other call passes.
    const { fake, baseSha } = fakeWith(
      { clock: () => now, faults: ({ method }) => {
        if (method === "git.createRef") {
          createRefHold.markReached();
          return { kind: "hold", release: createRefHold.promise };
        }
        return { kind: "pass" };
      } },
      "seed",
    );
    const w1 = makeDelivery(queue, fake, "worker-1", () => now);
    const input = draftInput({ expectedBaseSha: baseSha });

    // Worker 1 runs; it claims the operation (30 s lease) and parks before its
    // createRef writes.
    const w1Promise = w1.deliverExactDraft(input).then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error }),
    );
    await createRefHold.reached;

    // The lease expires while worker 1 is stalled.
    now = "2026-09-02T12:00:40.000Z";
    // From now on, worker 2's createRef fails transiently (503) so worker 2
    // reclaims the expired lease and SETTLES the row (a retry-scheduled failure,
    // no write) without ever writing a branch. Worker 1 stays parked on the
    // hold it already captured.
    fake.setFaults(({ method }) =>
      method === "git.createRef"
        ? { kind: "fail-before", status: 503, message: "service_unavailable" }
        : { kind: "pass" });
    const w2 = makeDelivery(queue, fake, "worker-2", () => now);
    await w2.deliverExactDraft(input).catch(() => undefined);
    // The pipeline's retire path proves no write happened and supersedes the
    // operation, clearing the anchor — exactly what main does when a second
    // worker settles a stalled delivery.
    const retirement = await w1.retireDeliveryOperation({
      owner: OWNER,
      repo: REPO,
      branch: BRANCH,
      baseSha,
    });

    // Now worker 1's held createRef is released: it lands, and worker 1 finishes
    // creating the commit and OPENS A PULL REQUEST — after the operation was
    // settled/retired, so nothing records it.
    fake.setFaults(() => ({ kind: "pass" }));
    createRefHold.release();
    const w1Result = await w1Promise;

    const openPulls = fake.openPulls(OWNER, REPO, BRANCH);
    // The defect: a PR now exists on the branch that no consumer row records.
    // The operation was retired (the pipeline abandoned it) AND worker 1 was
    // fenced out of recording — so the created PR is orphaned (I2 violated).
    expect(retirement.superseded).toBe(true);
    expect(openPulls.length).toBe(1);
    expect(w1Result.ok).toBe(false);
    // The identity uniqueness invariant still holds (one branch, one open PR).
    assertUniqueOpenPr(fake);
    assertRefsOnlyForward(fake);
    db.close();
  }, 60_000);

  it("I7 holds (was D1): a failure write can never clobber a recorded PR", () => {
    const directory = mkdtempSync(join(tmpdir(), "dependency-outage-model-"));
    const db = createDb(join(directory, "app.sqlite"));
    // Isolate the migration_prs write: skip the api_changes/consumers FKs.
    db.raw.exec("PRAGMA foreign_keys = OFF");
    insertMigrationPr(db, {
      id: "pr-1",
      changeId: "change-1",
      consumerId: "consumer-1",
      title: "t",
      body: "b",
      branchName: BRANCH,
      status: "draft",
      risk: "low",
      patchUnified: "diff",
      githubPrNumber: 24,
      githubPrUrl: "https://github.com/acme/shop/pull/24",
      createdAt: "2026-09-02T12:00:00.000Z",
    });

    // A late failure write from another worker: no PR number, status delivery_failed.
    // The D1 CAS guards this write on `github_pr_number IS NULL`, so it matches no
    // row (the PR is recorded) and returns silently — the recorded draft wins.
    updateMigrationPrDelivery(db, "pr-1", { status: "delivery_failed" });
    // A delivery_blocked write is guarded identically.
    updateMigrationPrDelivery(db, "pr-1", { status: "delivery_blocked" });
    const row = db.raw.prepare("SELECT status, github_pr_number FROM migration_prs WHERE id = ?").get("pr-1") as
      { status: string; github_pr_number: number | null };
    // The status never regresses from draft (I7); the PR number is intact (I2).
    expect(row.github_pr_number).toBe(24);
    expect(row.status).toBe("draft");
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
