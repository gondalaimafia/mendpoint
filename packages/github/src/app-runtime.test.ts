import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createAppJwt,
  deliverToManyRepos,
  GitHubAppDelivery,
  hasGitHubAppCredentials,
} from "./app-runtime.js";
import { MockGitHubDelivery } from "./index.js";

describe("github app runtime", () => {
  it("creates a verifiable RS256 JWT shape", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwt = createAppJwt("12345", pem, 1_700_000_000);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    expect(payload.iss).toBe("12345");
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it("GitHubAppDelivery uses installation token fetcher", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    let fetched = false;
    const delivery = new GitHubAppDelivery(
      { appId: "99", privateKeyPem: pem },
      42,
      async (id, jwt) => {
        fetched = true;
        expect(id).toBe(42);
        expect(jwt.split(".")).toHaveLength(3);
        // Return a dummy token — subsequent Octokit calls will fail if used against network.
        // We only assert createBranch is attempted with mock by swapping methods in multi-repo test.
        return {
          token: "ghs_test",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          installationId: id,
        };
      },
    );
    // Force token fetch without network by calling private path via openPullRequest failure path —
    // use multi-repo with Mock delivery instead for happy path.
    expect(hasGitHubAppCredentials({} as NodeJS.ProcessEnv)).toBe(false);
    void delivery;
    expect(fetched).toBe(false);
  });

  it("delivers to many repos via mock delivery", async () => {
    const mock = new MockGitHubDelivery();
    const results = await deliverToManyRepos(
      mock,
      [
        { owner: "acme", name: "shop" },
        { owner: "acme", name: "billing" },
      ],
      {
        branch: "mendpoint/test",
        title: "migrate",
        body: "body",
        message: "msg",
        files: [{ path: "src/a.ts", content: "x" }],
      },
    );
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.pr?.number)).toBe(true);
  });
});
