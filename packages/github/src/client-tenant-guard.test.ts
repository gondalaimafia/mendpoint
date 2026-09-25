import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { OctokitGitHubDelivery } from "./index.js";
import { GitHubAppDelivery } from "./app-runtime.js";
import { HttpGitLabDelivery } from "./gitlab.js";
import { FakeGitHub } from "./testing/fake-github.js";
import { deliverAdoptiveDraftWithOctokit, type AdoptiveDraftInput } from "./draft-adoption.js";
import { TENANT_IDENTITY_DELIVERY_ERROR } from "./tenant-identity-guard.js";

// A production-shaped 64-hex tenant id, the form the Fettler/Regauge exact-draft
// PR bodies carried before the guard (blocker 1).
const TENANT = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const BASE = "b".repeat(40);
const OWNER = "org";
const REPO = "shop-app";

function seededFake(): FakeGitHub {
  const fake = new FakeGitHub();
  fake.registerBase({ owner: OWNER, repo: REPO, branch: "main", sha: BASE });
  return fake;
}

function exactDraftIntent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    owner: OWNER,
    repo: REPO,
    baseBranch: "main",
    expectedBaseSha: BASE,
    branch: "mendpoint/acme-payments-v2",
    commitMessage: "Adopt Acme Payments v2",
    commitDate: "2026-09-02T12:00:00.000Z",
    title: "Adopt Acme Payments v2",
    body: "Verification summary:\n- Goal: Apply the recorded acme-payments API migration.",
    files: [{ path: "src/client.ts", content: "export const v = 2;\n", mode: "100644" as const }],
    ...overrides,
  };
}

describe("exact-draft is guarded at every production client (#724 blocker 1)", () => {
  it("PAT client refuses an exact-draft whose body carries the tenant id, with no PR opened", async () => {
    const fake = seededFake();
    const delivery = new OctokitGitHubDelivery(TENANT, "token");
    (delivery as unknown as { octokit: FakeGitHub }).octokit = fake;
    await expect(
      delivery.deliverExactDraft(
        exactDraftIntent({ body: `Verification summary:\n- Goal: Apply the recorded ${TENANT}~acme-payments migration.` }),
      ),
    ).rejects.toMatchObject({ code: TENANT_IDENTITY_DELIVERY_ERROR });
    expect(fake.allPulls(OWNER, REPO)).toHaveLength(0);
  });

  it("PAT client delivers a clean exact-draft", async () => {
    const fake = seededFake();
    const delivery = new OctokitGitHubDelivery(TENANT, "token");
    (delivery as unknown as { octokit: FakeGitHub }).octokit = fake;
    const result = await delivery.deliverExactDraft(exactDraftIntent());
    expect(result.branch).toBe("mendpoint/acme-payments-v2");
    expect(fake.allPulls(OWNER, REPO)).toHaveLength(1);
    expect(fake.allPulls(OWNER, REPO)[0]!.body).not.toContain(TENANT);
  });

  it("App client refuses an exact-draft whose body carries the tenant id, with no PR opened", async () => {
    const fake = seededFake();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const delivery = new GitHubAppDelivery({ appId: "99", privateKeyPem: pem }, 42, TENANT);
    (delivery as unknown as { octokit: () => Promise<FakeGitHub> }).octokit = async () => fake;
    await expect(
      delivery.deliverExactDraft(
        exactDraftIntent({ body: `Goal: migrate {"tenantId":"${TENANT}"}` }),
      ),
    ).rejects.toMatchObject({ code: TENANT_IDENTITY_DELIVERY_ERROR });
    expect(fake.allPulls(OWNER, REPO)).toHaveLength(0);
  });

  it("App client refuses a PR/issue comment carrying the tenant id (the duplicate-close write cannot route around the client guard)", async () => {
    const fake = seededFake();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const delivery = new GitHubAppDelivery({ appId: "99", privateKeyPem: pem }, 42, TENANT);
    (delivery as unknown as { octokit: () => Promise<FakeGitHub> }).octokit = async () => fake;
    // Reach into withAuthRetry via a write method; any comment write flows through
    // the guarded client octokit. A leaking comment is refused before the API call.
    const guarded = await (delivery as unknown as {
      withAuthRetry: (work: (o: FakeGitHub) => Promise<unknown>) => Promise<unknown>;
    }).withAuthRetry(async (octokit) =>
      octokit.issues.createComment({ owner: OWNER, repo: REPO, issue_number: 1, body: `see ${TENANT}` }),
    ).then(
      () => "no-throw",
      (error: unknown) => (error as { code?: string }).code,
    );
    expect(guarded).toBe(TENANT_IDENTITY_DELIVERY_ERROR);
    expect(fake.comments(OWNER, REPO)).toHaveLength(0);
  });

  it("GitLab client refuses a commit whose message carries the tenant id, with no API call", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: {}, headers: {} };
    };
    const delivery = new HttpGitLabDelivery({ token: "glpat-abc", fetch: fetchImpl, tenantId: TENANT });
    await expect(
      delivery.commitFiles("acme", "shop", "mendpoint/x", `Adopt ${TENANT}~acme migration`, [
        { path: "src/a.ts", content: "x\n" },
      ]),
    ).rejects.toMatchObject({ code: TENANT_IDENTITY_DELIVERY_ERROR });
    expect(calls).toHaveLength(0);
  });

  it("GitLab client refuses a merge request whose body carries the tenant id, with no API call", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: {}, headers: {} };
    };
    const delivery = new HttpGitLabDelivery({ token: "glpat-abc", fetch: fetchImpl, tenantId: TENANT });
    await expect(
      delivery.openDraftMergeRequest("acme", "shop", "mendpoint/x", "Adopt v2", `checkout /srv/repos/${TENANT}/shop`, "main"),
    ).rejects.toMatchObject({ code: TENANT_IDENTITY_DELIVERY_ERROR });
    expect(calls).toHaveLength(0);
  });

  it("every tenant-scoped client refuses construction without a tenant id", () => {
    expect(() => new OctokitGitHubDelivery("", "token")).toThrow(/tenant/);
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => new GitHubAppDelivery({ appId: "99", privateKeyPem: pem }, 42, "")).toThrow(/tenant/);
    expect(() => new HttpGitLabDelivery({ token: "glpat-abc", tenantId: "" })).toThrow(/tenant/);
  });
});

// #730 (should-fix 2): three write sites that are guarded only structurally —
// nothing pinned that they route through the guarded transport, so a mutation
// swapping the guarded client for the raw octokit survived review. Each test
// drives the REAL client/state-machine method with a tenant id injected into the
// text it sends, and asserts the write is refused (and never reaches the fake).
describe("three structurally guarded write sites are pinned (#730)", () => {
  // A recording octokit double that also answers the reads `updateExactDraft`
  // makes before its first write; every write records its name so the test can
  // prove the guard refused it before it landed.
  function recordingUpdateOctokit(): { octokit: unknown; writes: string[] } {
    const writes: string[] = [];
    const head = "a".repeat(40);
    const pull = {
      number: 17,
      html_url: `https://github.com/${OWNER}/${REPO}/pull/17`,
      state: "open",
      draft: true,
      base: { ref: "main", repo: { id: 101 } },
      head: { ref: "mendpoint/acme-payments-v2", sha: head, repo: { id: 101 } },
    };
    const octokit = {
      pulls: { get: async () => ({ data: pull }) },
      git: {
        getRef: async () => ({ data: { object: { sha: head } } }),
        getCommit: async () => ({ data: { tree: { sha: "parent-tree" } } }),
        createBlob: async () => { writes.push("createBlob"); return { data: { sha: "blob-a" } }; },
        createTree: async () => { writes.push("createTree"); return { data: { sha: "next-tree" } }; },
        createCommit: async () => { writes.push("createCommit"); return { data: { sha: "b".repeat(40) } }; },
        updateRef: async () => { writes.push("updateRef"); return { data: { object: { sha: "b".repeat(40) } } }; },
      },
    };
    return { octokit, writes };
  }

  it("App updateExactDraft refuses a file whose content carries the tenant id (guarded, not raw octokit)", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const delivery = new GitHubAppDelivery({ appId: "99", privateKeyPem: pem }, 42, TENANT);
    const { octokit, writes } = recordingUpdateOctokit();
    (delivery as unknown as { octokit: () => Promise<unknown> }).octokit = async () => octokit;
    await expect(
      delivery.updateExactDraft({
        owner: OWNER,
        repo: REPO,
        expectedRepositoryId: 101,
        pullRequestNumber: 17,
        baseBranch: "main",
        branch: "mendpoint/acme-payments-v2",
        expectedHeadSha: "a".repeat(40),
        commitMessage: "Adopt Acme Payments v2",
        commitDate: "2026-09-02T12:00:00.000Z",
        files: [{ path: "src/client.ts", content: `export const tenant = "${TENANT}";\n`, mode: "100644" as const }],
      }),
    ).rejects.toMatchObject({ code: TENANT_IDENTITY_DELIVERY_ERROR });
    // The guard refused the blob before it (or any later write) reached the transport.
    expect(writes).toHaveLength(0);
  });

  it("PAT commitFiles refuses a file whose content carries the tenant id (guarded, not raw octokit)", async () => {
    const fake = new FakeGitHub();
    const branch = "mendpoint/acme-payments-v2";
    const seeded = fake.seedDefaultBranch({ owner: OWNER, repo: REPO, branch, content: { "src/a.ts": "seed\n" } });
    const delivery = new OctokitGitHubDelivery(TENANT, "token");
    (delivery as unknown as { octokit: FakeGitHub }).octokit = fake;
    await expect(
      delivery.commitFiles(OWNER, REPO, branch, "Adopt Acme Payments v2", [
        { path: "src/client.ts", content: `export const tenant = "${TENANT}";\n` },
      ]),
    ).rejects.toMatchObject({ code: TENANT_IDENTITY_DELIVERY_ERROR });
    // No commit landed: the guarded blob write was refused, so the branch head is
    // unchanged. A raw-octokit blob would have let the commit and ref move through.
    expect(fake.refHead(OWNER, REPO, branch)).toBe(seeded);
  });

  it("the duplicate-close comment routes through the guarded tx, not the raw octokit", async () => {
    const fake = new FakeGitHub({ clock: () => "2026-09-02T12:00:00.000Z" });
    const branch = "mendpoint/acme-payments-v2";
    const baseSha = fake.seedDefaultBranch({ owner: OWNER, repo: REPO, branch: "main", content: { "src/a.ts": "seed\n" } });
    // The close-duplicate comment body is FIXED text ("Closing this duplicate; the
    // original delivery pull request already exists."), so a 64-hex id can never
    // appear in it. To prove the comment traverses the guard, we configure the
    // guard with an id that IS a substring of that fixed text ("duplicate"); every
    // other write on the path (commit message, file paths/content, the close
    // pulls.update) is free of it, so the guard can only fire on the comment.
    const tenantId = "duplicate";
    const draftInput = (overrides: Partial<AdoptiveDraftInput> = {}): AdoptiveDraftInput => ({
      owner: OWNER,
      repo: REPO,
      baseBranch: "main",
      expectedBaseSha: baseSha,
      branch,
      deliveryKey: "change-1:consumer-1",
      tenantId,
      title: "Adopt Acme Payments v2",
      body: "Verification summary of the recorded migration.",
      commitDate: "2026-09-02T12:00:00.000Z",
      files: [{ path: "src/client.ts", content: "export const v = 2;\n", mode: "100644" }],
      ...overrides,
    });

    // Open PR #1, a human closes it, and a stale duplicate PR #2 is opened for the
    // same branch — the D7 close-late-duplicate scenario.
    const first = await deliverAdoptiveDraftWithOctokit(fake, draftInput());
    fake.humanClosePull(OWNER, REPO, first.number);
    const dup = await fake.pulls.create({
      owner: OWNER, repo: REPO, title: "dup", head: `${OWNER}:${branch}`, base: "main", body: "dup", draft: true,
    });
    expect(dup.data.number).toBeGreaterThan(first.number);

    // A fresh delivery must close the duplicate and comment through the guarded tx.
    // The guard refuses the fixed comment (it carries the configured id), so the
    // delivery is blocked and NO comment is written. A raw-octokit route would post
    // the comment and return a closed outcome instead.
    await expect(deliverAdoptiveDraftWithOctokit(fake, draftInput())).rejects.toMatchObject({
      code: TENANT_IDENTITY_DELIVERY_ERROR,
    });
    expect(fake.comments(OWNER, REPO)).toHaveLength(0);
  });
});
