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

  it("exposes typed blocked and contention errors", () => {
    expect(new AdoptiveDraftBlockedError("github_delivery_branch_foreign").blocked).toBe(true);
    expect(new AdoptiveDraftContentionError().retryable).toBe(true);
  });
});
