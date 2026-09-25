import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { OctokitGitHubDelivery } from "./index.js";
import { GitHubAppDelivery } from "./app-runtime.js";
import { HttpGitLabDelivery } from "./gitlab.js";
import { FakeGitHub } from "./testing/fake-github.js";
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
