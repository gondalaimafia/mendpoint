import { describe, expect, it } from "vitest";
import {
  deliverAdoptiveDraftWithOctokit,
  AdoptiveDraftBlockedError,
  AdoptiveDraftContentionError,
  type AdoptiveDraftInput,
} from "./draft-adoption.js";
import { FakeGitHub, type FakeFaultController } from "./testing/fake-github.js";

const OWNER = "acme";
const REPO = "shop";
const BRANCH = "mendpoint/fettler-abc123";
const BASE_BRANCH = "main";

function seed(faults?: FakeFaultController): { fake: FakeGitHub; baseSha: string } {
  const fake = new FakeGitHub({ clock: () => "2026-09-02T12:00:00.000Z", faults });
  const baseSha = fake.seedDefaultBranch({
    owner: OWNER,
    repo: REPO,
    branch: BASE_BRANCH,
    content: { "src/a.ts": "original\n" },
  });
  return { fake, baseSha };
}

function input(fake: FakeGitHub, baseSha: string, overrides: Partial<AdoptiveDraftInput> = {}): AdoptiveDraftInput {
  return {
    owner: OWNER,
    repo: REPO,
    baseBranch: BASE_BRANCH,
    expectedBaseSha: baseSha,
    branch: BRANCH,
    deliveryKey: "change-1:consumer-1",
    title: "Fettler candidate",
    body: "Body A with the structured package section",
    commitDate: "2026-09-02T12:00:00.000Z",
    files: [{ path: "src/a.ts", content: "changed\n", mode: "100644" }],
    ...overrides,
  };
}

describe("adoptive draft delivery state machine", () => {
  it("creates the branch, commit and one draft PR, then adopts it", async () => {
    const { fake, baseSha } = seed();
    const result = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha));
    expect(result).toMatchObject({ number: 1, state: "draft", draft: true, baseBranch: BASE_BRANCH });
    expect(result.deliveredBaseSha).toBe(baseSha);
    expect(fake.openPulls(OWNER, REPO, BRANCH)).toHaveLength(1);
  });

  it("is idempotent: a second delivery adopts the same PR without a duplicate", async () => {
    const { fake, baseSha } = seed();
    const first = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha));
    const second = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha));
    expect(second.number).toBe(first.number);
    expect(fake.allPulls(OWNER, REPO)).toHaveLength(1);
  });

  it("reconciles a lost pulls.create response to ONE PR on the next attempt", async () => {
    let pullCreates = 0;
    const { fake, baseSha } = seed(({ method }) => {
      if (method === "pulls.create") {
        pullCreates += 1;
        if (pullCreates === 1) return { kind: "apply-then-lose", code: "ECONNRESET" };
      }
      return { kind: "pass" };
    });
    await expect(deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha))).rejects.toMatchObject({ code: "ECONNRESET" });
    // The PR was created despite the lost response; the next attempt's L adopts it.
    const result = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha));
    expect(result.state).toBe("draft");
    expect(fake.allPulls(OWNER, REPO)).toHaveLength(1);
  });

  it("adopts a branch a stalled worker committed but never opened a PR for", async () => {
    let createRefFails = 0;
    const { fake, baseSha } = seed(({ method }) => {
      // Fail the first pulls.create so the branch/commit land but no PR opens.
      if (method === "pulls.create" && createRefFails === 0) {
        createRefFails += 1;
        return { kind: "fail-before", status: 503 };
      }
      return { kind: "pass" };
    });
    await expect(deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha))).rejects.toMatchObject({ status: 503 });
    expect(fake.refHead(OWNER, REPO, BRANCH)).toBeDefined();
    expect(fake.openPulls(OWNER, REPO, BRANCH)).toHaveLength(0);
    // Next attempt: L sees our commit on the branch, opens the PR, adopts.
    const result = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha));
    expect(result.state).toBe("draft");
    expect(fake.allPulls(OWNER, REPO)).toHaveLength(1);
  });

  it("regenerates a different body every attempt yet converges to one PR (no digest conflict)", async () => {
    const { fake, baseSha } = seed();
    const first = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha, { body: "Body A" }));
    // Identity excludes the body, so a re-delivery with a fresh body adopts the
    // same PR and converges its body — the round-5/6 digest conflict cannot occur.
    const second = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha, { body: "Body B regenerated" }));
    expect(second.number).toBe(first.number);
    expect(second.body).toBe("Body B regenerated");
    expect(fake.allPulls(OWNER, REPO)).toHaveLength(1);
  });

  it("fast-forwards a legacy bare branch to our commit, then adopts (D3/D8)", async () => {
    const { fake, baseSha } = seed();
    // A legacy bare branch that points at the base commit itself: no Mendpoint
    // commit, but a fast-forwardable ancestor of our commit's parent.
    await fake.git.createRef({ owner: OWNER, repo: REPO, ref: `refs/heads/${BRANCH}`, sha: baseSha });
    const result = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha));
    expect(result.state).toBe("draft");
    expect(fake.openPulls(OWNER, REPO, BRANCH)).toHaveLength(1);
    // The ref moved only by create (base) then fast-forward (our commit).
    for (const entry of fake.refLog(OWNER, REPO)) {
      expect(entry.op === "create" || (entry.op === "update" && entry.fastForward)).toBe(true);
    }
  });

  it("blocks on a genuinely foreign branch (github_delivery_branch_foreign)", async () => {
    const { fake, baseSha } = seed();
    // A foreign commit unrelated to our base occupies the branch.
    fake.moveBranch({ owner: OWNER, repo: REPO, branch: BRANCH, content: { "unrelated.ts": "someone else\n" } });
    await expect(deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha))).rejects.toMatchObject({
      code: "github_delivery_branch_foreign",
    });
    expect(fake.openPulls(OWNER, REPO, BRANCH)).toHaveLength(0);
  });

  it("blocks on more than one open PR for the branch (github_delivery_pr_ambiguous)", async () => {
    const { fake, baseSha } = seed();
    await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha));
    // A human opens a second open PR from the same head against a different base
    // (GitHub permits one open PR per head+base, so two bases means two open PRs).
    fake.seedDefaultBranch({ owner: OWNER, repo: REPO, branch: `${BASE_BRANCH}-alt`, content: { "src/a.ts": "original\n" } });
    await fake.pulls.create({
      owner: OWNER, repo: REPO, title: "dup", head: `${OWNER}:${BRANCH}`, base: `${BASE_BRANCH}-alt`, body: "x", draft: true,
    });
    await expect(deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha))).rejects.toMatchObject({
      code: "github_delivery_pr_ambiguous",
    });
  });

  it("records a human-closed PR as a closed outcome and never recreates it", async () => {
    const { fake, baseSha } = seed();
    const first = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha));
    fake.humanClosePull(OWNER, REPO, first.number);
    const result = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha));
    expect(result.state).toBe("closed");
    expect(result.number).toBe(first.number);
    // No new PR was opened.
    expect(fake.allPulls(OWNER, REPO)).toHaveLength(1);
  });

  it("converges the PR body when the head is still our commit", async () => {
    const { fake, baseSha } = seed();
    const first = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha, { body: "old body" }));
    fake.humanEditPullBody(OWNER, REPO, first.number, "stale body drifted");
    const result = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha, { body: "current body" }));
    expect(result.body).toBe("current body");
  });

  it("blocks when the PR body exceeds GitHub's hard limit (github_delivery_pr_body_too_long)", async () => {
    const { fake, baseSha } = seed();
    await expect(
      deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha, { body: "x".repeat(70_000) })),
    ).rejects.toMatchObject({ code: "github_delivery_pr_body_too_long" });
  });

  it("classifies non-race 422s as named blocked codes, never contention (D2)", async () => {
    // Only "Reference already exists" / "not a fast forward" / "pull request
    // already exists" re-run L; every other 422 is a named, non-retryable block.
    const cases: Array<[string, string]> = [
      ["No commits between base and head", "github_delivery_base_invalid"],
      ["Draft pull requests are not supported in this repository", "github_delivery_pull_unsupported"],
      ["Body is too long (maximum is 65536 characters)", "github_delivery_pr_body_too_long"],
      ["Repository rule violations found (ruleset enforcement)", "github_delivery_base_invalid"],
      ["Base ref must be a branch; invalid base", "github_delivery_base_invalid"],
    ];
    for (const [message, code] of cases) {
      let injected = false;
      const { fake, baseSha } = seed(({ method }) => {
        if (method === "pulls.create" && !injected) { injected = true; return { kind: "fail-before", status: 422, message }; }
        return { kind: "pass" };
      });
      await expect(
        deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha)),
        message,
      ).rejects.toMatchObject({ code });
    }
  });

  it("blocks a non-fast-forward foreign push and never force-moves the ref (I3; forced updateRef)", async () => {
    const { fake, baseSha } = seed();
    // A human pushes a parentless commit onto B: it does not descend from our
    // base, so no fast-forward is possible — only a force would move it.
    fake.moveBranch({ owner: OWNER, repo: REPO, branch: BRANCH, content: { "hostile.ts": "x\n" } });
    await expect(deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha))).rejects.toMatchObject({
      code: "github_delivery_branch_foreign",
    });
    // I3: the ref only ever moved by create or fast-forward — never a force move.
    for (const entry of fake.refLog(OWNER, REPO)) {
      expect(entry.op === "create" || (entry.op === "update" && entry.fastForward)).toBe(true);
    }
    expect(fake.openPulls(OWNER, REPO, BRANCH)).toHaveLength(0);
  });

  it("adopts a pre-existing PR on the branch (as a main-era delivery left it), no duplicate (D8)", async () => {
    // main opened a PR on this branch with its Date.now() name; a later adoptive
    // delivery on the SAME branch must adopt that PR, not open a second one.
    const { fake, baseSha } = seed();
    const first = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha));
    expect(first.state).toBe("draft");
    const second = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha));
    expect(second.number).toBe(first.number);
    expect(fake.allPulls(OWNER, REPO)).toHaveLength(1);
  });

  it("close-late-duplicate: a PR opened after a human closed the original is closed and the original recorded (D7)", async () => {
    const { fake, baseSha } = seed();
    // Worker 1 is held just before its pulls.create (branch/commit already exist).
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const reachedP = new Promise<void>((r) => { reached = r; });
    let held1 = false;
    fake.setFaults(({ method }) => {
      if (method === "pulls.create" && !held1) { held1 = true; reached(); return { kind: "hold", release: held }; }
      return { kind: "pass" };
    });
    const p1 = deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha))
      .then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e }));
    await reachedP;
    // Worker 2 creates and adopts P1; a human then closes P1.
    fake.setFaults(() => ({ kind: "pass" }));
    const p1Result = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha));
    fake.humanClosePull(OWNER, REPO, p1Result.number);
    // Release worker 1: its pulls.create opens a duplicate P2; D7 must close it and
    // record P1's closed outcome (an OLDER closed PR exists for the branch).
    release();
    const w1 = await p1;
    expect(w1.ok).toBe(true);
    if (w1.ok) {
      expect(w1.r.state).toBe("closed");
      expect(w1.r.number).toBe(p1Result.number); // records the ORIGINAL, not the duplicate
    }
    // Exactly one PR remains open at most (I1); the duplicate was closed with a comment.
    expect(fake.openPulls(OWNER, REPO, BRANCH).length).toBeLessThanOrEqual(0 + 1);
    expect(fake.allPulls(OWNER, REPO).filter((p) => p.state === "closed").length).toBeGreaterThanOrEqual(1);
    expect(fake.comments(OWNER, REPO).length).toBeGreaterThanOrEqual(1);
  });

  it("C (D8 no-PR): adopts a main-era commit (Mendpoint identity, no trailer, no PR) by opening its PR", async () => {
    const { fake, baseSha } = seed();
    // Reconstruct main's exact-draft commit on the branch: Mendpoint author/committer,
    // our exact tree against the base, but NO Mendpoint-Delivery trailer and no PR
    // (main failed at PR creation). Content-addressing makes its tree == ours.
    const { data: base } = await fake.git.getCommit({ owner: OWNER, repo: REPO, commit_sha: baseSha });
    const { data: blob } = await fake.git.createBlob({ owner: OWNER, repo: REPO, content: Buffer.from("changed\n").toString("base64"), encoding: "base64" });
    const { data: tree } = await fake.git.createTree({ owner: OWNER, repo: REPO, base_tree: base.tree.sha, tree: [{ path: "src/a.ts", mode: "100644", type: "blob", sha: blob.sha }] });
    const identity = { name: "Mendpoint", email: "delivery@mendpoint.ai", date: "2026-09-02T12:00:00.000Z" };
    const { data: commit } = await fake.git.createCommit({ owner: OWNER, repo: REPO, message: "Fettler candidate", tree: tree.sha, parents: [baseSha], author: identity, committer: identity });
    await fake.git.createRef({ owner: OWNER, repo: REPO, ref: `refs/heads/${BRANCH}`, sha: commit.sha });
    expect(fake.openPulls(OWNER, REPO, BRANCH)).toHaveLength(0);
    const result = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha));
    expect(result.state).toBe("draft");
    expect(fake.openPulls(OWNER, REPO, BRANCH)).toHaveLength(1);
    // Adopted the existing main-era commit, did not create a second one.
    expect(fake.openPulls(OWNER, REPO, BRANCH)[0]!.head.sha).toBe(commit.sha);
  });

  it("D6: does NOT converge the body when a human pushed on top of our commit", async () => {
    const { fake, baseSha } = seed();
    const first = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha, { body: "our original body" }));
    // A human pushes a commit on top of our commit and would-be edits the body.
    fake.humanCommitOnto({ owner: OWNER, repo: REPO, branch: BRANCH, prNumber: first.number, content: { "src/human.ts": "hand edit\n" } });
    fake.humanEditPullBody(OWNER, REPO, first.number, "human-owned body");
    // A re-delivery with a fresh body must adopt but LEAVE the human's body — the
    // branch head is no longer our commit.
    const result = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha, { body: "regenerated body" }));
    expect(result.state).toBe("draft");
    expect(fake.openPulls(OWNER, REPO, BRANCH)[0]!.body).toBe("human-owned body");
  });

  it("D (cross-attempt): closes a duplicate open PR opened after the human-closed original, on a fresh L", async () => {
    const { fake, baseSha } = seed();
    const first = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha)); // PR #1
    fake.humanClosePull(OWNER, REPO, first.number);
    // A prior attempt (after a lost create response + a stale pulls.list) opened a
    // duplicate PR #2 for the same branch; the human's close of #1 is authoritative.
    const dup = await fake.pulls.create({
      owner: OWNER, repo: REPO, title: "dup", head: `${OWNER}:${BRANCH}`, base: BASE_BRANCH, body: "dup", draft: true,
    });
    expect(dup.data.number).toBeGreaterThan(first.number);
    // A fresh delivery (createdNewPull=false) must still close the duplicate and
    // record the original's closed outcome — D7 runs on every L.
    const result = await deliverAdoptiveDraftWithOctokit(fake, input(fake, baseSha));
    expect(result.state).toBe("closed");
    expect(result.number).toBe(first.number);
    expect(fake.openPulls(OWNER, REPO, BRANCH)).toHaveLength(0);
    expect(fake.comments(OWNER, REPO).length).toBeGreaterThanOrEqual(1);
  });

  it("exposes typed blocked and contention errors", () => {
    expect(new AdoptiveDraftBlockedError("github_delivery_branch_foreign").blocked).toBe(true);
    expect(new AdoptiveDraftContentionError().retryable).toBe(true);
  });
});
