import { describe, expect, it } from "vitest";
import {
  guardGitHubWrites,
  containsTenantIdentity,
  TENANT_IDENTITY_DELIVERY_ERROR,
} from "./tenant-identity-guard.js";
import { AdoptiveDraftBlockedError } from "./draft-adoption.js";

// Production-shaped: a 64-hex sha256 tenant id and a `<reposDir>/<tenantId>/<repoKey>`
// server checkout path (the two forms that leaked before #713).
const TENANT = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const REPO_KEY = "shop-app";
const CHECKOUT_PATH = `/srv/mendpoint/repos/${TENANT}/${REPO_KEY}`;

const makeError = () => new AdoptiveDraftBlockedError(TENANT_IDENTITY_DELIVERY_ERROR);

/**
 * A fake GitHub transport that records every call. "No API call made" is proven
 * by an empty `calls` array after a guarded write throws.
 */
function recordingTransport() {
  const calls: Array<{ method: string; args: unknown }> = [];
  const record = (method: string) => (args: unknown) => {
    calls.push({ method, args });
    return Promise.resolve({ data: { number: 1, id: 1, sha: "s", html_url: "u" } });
  };
  return {
    calls,
    git: {
      getRef: record("git.getRef"),
      createRef: record("git.createRef"),
      updateRef: record("git.updateRef"),
      createCommit: record("git.createCommit"),
      createBlob: record("git.createBlob"),
      createTree: record("git.createTree"),
    },
    pulls: {
      list: record("pulls.list"),
      create: record("pulls.create"),
      update: record("pulls.update"),
    },
    issues: { createComment: record("issues.createComment") },
    checks: { create: record("checks.create") },
  };
}

describe("guardGitHubWrites — fail-closed at each customer-facing write (#724)", () => {
  // owner/repo constant across cases.
  const R = { owner: "org", repo: REPO_KEY };

  const leakingWrites: Array<{ name: string; run: (tx: ReturnType<typeof recordingTransport>) => Promise<unknown> }> = [
    { name: "title", run: (tx) => tx.pulls.create({ ...R, title: `Update for ${TENANT}`, head: "b", base: "main", body: "clean" }) },
    { name: "body", run: (tx) => tx.pulls.create({ ...R, title: "clean", head: "b", base: "main", body: `paths: ${CHECKOUT_PATH}` }) },
    { name: "body(update)", run: (tx) => tx.pulls.update({ ...R, pull_number: 1, title: "clean", body: `{"tenantId":"${TENANT}"}` }) },
    { name: "branch", run: (tx) => tx.git.createRef({ ...R, ref: `refs/heads/mendpoint/${TENANT}-x`, sha: "s" }) },
    { name: "branch(update)", run: (tx) => tx.git.updateRef({ ...R, ref: `heads/mendpoint/${TENANT}-x`, sha: "s" }) },
    { name: "commit", run: (tx) => tx.git.createCommit({ ...R, message: `Deliver\n\nowner ${TENANT} x`, tree: "t", parents: ["p"] }) },
    { name: "file(content)", run: (tx) => tx.git.createBlob({ ...R, content: Buffer.from(`const t = "${TENANT}";`, "utf8").toString("base64"), encoding: "base64" }) },
    { name: "file(path)", run: (tx) => tx.git.createTree({ ...R, tree: [{ path: `config/${TENANT}.json`, mode: "100644", type: "blob", sha: "x" }] }) },
    { name: "comment", run: (tx) => tx.issues.createComment({ ...R, issue_number: 1, body: `see ${TENANT}` }) },
    { name: "check_run", run: (tx) => tx.checks.create({ ...R, name: `check ${TENANT}`, head_sha: "s", output: { title: "t", summary: "s", text: "x" } }) },
  ];

  for (const { name, run } of leakingWrites) {
    it(`blocks the ${name} write with the named error and makes no API call`, async () => {
      const transport = recordingTransport();
      const guarded = guardGitHubWrites(transport, TENANT, makeError);
      await expect(run(guarded as unknown as ReturnType<typeof recordingTransport>)).rejects.toMatchObject({
        code: TENANT_IDENTITY_DELIVERY_ERROR,
      });
      expect(transport.calls).toHaveLength(0);
    });
  }

  it("blocks a check-run leak hidden only in the output text", async () => {
    const transport = recordingTransport();
    const guarded = guardGitHubWrites(transport, TENANT, makeError) as unknown as ReturnType<typeof recordingTransport>;
    await expect(
      guarded.checks.create({ ...R, name: "clean", head_sha: "s", output: { title: "clean", summary: `path ${CHECKOUT_PATH}`, text: "x" } }),
    ).rejects.toMatchObject({ code: TENANT_IDENTITY_DELIVERY_ERROR });
    expect(transport.calls).toHaveLength(0);
  });

  it("passes a clean write through to the transport (every field tenant-free)", async () => {
    const transport = recordingTransport();
    const guarded = guardGitHubWrites(transport, TENANT, makeError) as unknown as ReturnType<typeof recordingTransport>;
    await guarded.pulls.create({ ...R, title: "Adopt Acme Payments v2", head: "mendpoint/acme-payments-v2", base: "main", body: `Registry: org/${REPO_KEY}` });
    await guarded.git.createBlob({ ...R, content: Buffer.from("export const ok = 1;\n", "utf8").toString("base64"), encoding: "base64" });
    await guarded.issues.createComment({ ...R, issue_number: 1, body: "Closing duplicate." });
    expect(transport.calls.map((c) => c.method)).toEqual(["pulls.create", "git.createBlob", "issues.createComment"]);
  });

  it("passes reads through untouched (guards writes only)", async () => {
    const transport = recordingTransport();
    const guarded = guardGitHubWrites(transport, TENANT, makeError) as unknown as ReturnType<typeof recordingTransport>;
    // A read whose args mention the tenant id must not be blocked.
    await guarded.git.getRef({ ...R, ref: `heads/mendpoint/${TENANT}-x` });
    await guarded.pulls.list({ ...R, state: "all" });
    expect(transport.calls.map((c) => c.method)).toEqual(["git.getRef", "pulls.list"]);
  });
});

describe("containsTenantIdentity — the fail-closed substring the projection misses", () => {
  it("matches an embedded id that publicGraphToken's segment filter would pass", () => {
    // Not a whole `:`-separated segment — exactly the fail-open gap #724 closes.
    expect(containsTenantIdentity(TENANT, `owner ${TENANT} x`)).toBe(true);
    expect(containsTenantIdentity(TENANT, `{"tenantId":"${TENANT}"}`)).toBe(true);
    expect(containsTenantIdentity(TENANT, CHECKOUT_PATH)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(containsTenantIdentity(TENANT.toUpperCase(), `x${TENANT}y`)).toBe(true);
  });

  it("does not match a tenant-free string", () => {
    expect(containsTenantIdentity(TENANT, "org/shop-app Adopt v2")).toBe(false);
    expect(containsTenantIdentity(TENANT, "")).toBe(false);
    expect(containsTenantIdentity("", "anything")).toBe(false);
  });
});
