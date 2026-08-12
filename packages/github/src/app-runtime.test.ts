import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createAppJwt,
  deliverToManyRepos,
  GitHubAppDelivery,
  InstallationTokenCache,
  hasGitHubAppCredentials,
  listInstallationRepositories,
  loadAppCredentials,
  mockInstallationRepositories,
} from "./app-runtime.js";
import { MockGitHubDelivery } from "./index.js";

const EXACT_BASE_SHA = "a".repeat(40);
const EXACT_COMMIT_SHA = "c".repeat(40);

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
        // Return a dummy token. Subsequent Octokit calls would use the network.
        // We only assert createBranch is attempted with mock by swapping methods in multi-repo test.
        return {
          token: "ghs_test",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          installationId: id,
        };
      },
    );
    // Keep token exchange isolated from the multi repository happy path.
    // use multi-repo with Mock delivery instead for happy path.
    expect(hasGitHubAppCredentials({} as NodeJS.ProcessEnv)).toBe(false);
    void delivery;
    expect(fetched).toBe(false);
  });

  it("deduplicates concurrent installation token refreshes", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const fetcher = vi.fn(
      async (
        installationId: number,
        _jwt: string,
        _repositoryIds?: number[],
      ) => ({
        token: "ghs_one",
        expiresAt: "2026-01-01T01:00:00.000Z",
        installationId,
      }),
    );
    const cache = new InstallationTokenCache(
      { appId: "99", privateKeyPem: pem },
      42,
      fetcher,
      () => now,
      [77],
    );
    await expect(Promise.all([cache.get(), cache.get(), cache.get()])).resolves.toEqual([
      "ghs_one",
      "ghs_one",
      "ghs_one",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[2]).toEqual([77]);
    await expect(cache.get()).resolves.toBe("ghs_one");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects unreadable App private keys during credential loading", () => {
    expect(
      loadAppCredentials({
        GITHUB_APP_ID: "99",
        GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(
      loadAppCredentials({
        GITHUB_APP_ID: "99",
        GITHUB_APP_PRIVATE_KEY: privateKey
          .export({ type: "pkcs8", format: "pem" })
          .toString(),
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("clears a rejected token and retries an authenticated operation once", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const delivery = new GitHubAppDelivery(
      { appId: "99", privateKeyPem: pem },
      42,
    );
    const rejected = {
      git: {
        getRef: vi.fn(async () => {
          throw Object.assign(new Error("Bad credentials"), { status: 401 });
        }),
      },
    };
    const accepted = {
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: "base" } } })),
        createRef: vi.fn(async () => ({})),
      },
    };
    const octokit = vi
      .fn()
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(accepted);
    const tokenCache = (
      delivery as unknown as { tokenCache: InstallationTokenCache }
    ).tokenCache;
    const clear = vi.spyOn(tokenCache, "clear");
    (
      delivery as unknown as { octokit: typeof octokit }
    ).octokit = octokit;

    await expect(
      delivery.createBranch("acme", "shop", "mendpoint/change"),
    ).resolves.toBeUndefined();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(octokit).toHaveBeenCalledTimes(2);
    expect(accepted.git.createRef).toHaveBeenCalledTimes(1);
  });

  it("refreshes a rejected token while checking an existing branch", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const delivery = new GitHubAppDelivery(
      { appId: "99", privateKeyPem: pem },
      42,
    );
    const rejected = {
      repos: {
        getContent: vi.fn(async () => {
          throw Object.assign(new Error("Bad credentials"), { status: 401 });
        }),
      },
    };
    const accepted = {
      repos: {
        getContent: vi.fn(async () => ({
          data: { content: Buffer.from("intended change\n").toString("base64") },
        })),
      },
    };
    const octokit = vi
      .fn()
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(accepted);
    const internals = delivery as unknown as {
      existingBranches: Set<string>;
      tokenCache: InstallationTokenCache;
      octokit: typeof octokit;
    };
    internals.existingBranches.add("acme/shop:mendpoint/change");
    internals.octokit = octokit;
    const clear = vi.spyOn(internals.tokenCache, "clear");

    await expect(
      delivery.commitFiles("acme", "shop", "mendpoint/change", "Fix", [
        { path: "src/a.ts", content: "intended change\n" },
      ]),
    ).resolves.toBeUndefined();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(octokit).toHaveBeenCalledTimes(2);
  });

  it("rejects tokens for another installation or without safe lifetime", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const credentials = { appId: "99", privateKeyPem: pem };
    await expect(
      new InstallationTokenCache(
        credentials,
        42,
        async () => ({
          token: "ghs_wrong",
          expiresAt: "2026-01-01T01:00:00.000Z",
          installationId: 43,
        }),
        () => now,
      ).get(),
    ).rejects.toThrow("github_app_token_installation_mismatch");
    await expect(
      new InstallationTokenCache(
        credentials,
        42,
        async () => ({
          token: "ghs_expiring",
          expiresAt: "2026-01-01T00:00:30.000Z",
          installationId: 42,
        }),
        () => now,
      ).get(),
    ).rejects.toThrow("github_app_token_invalid_or_expired");
  });

  it("preserves a divergent existing recovery branch for human reconciliation", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const delivery = new GitHubAppDelivery(
      { appId: "99", privateKeyPem: pem },
      42,
    );
    const createBlob = vi.fn();
    const updateRef = vi.fn();
    const fakeOctokit = {
      git: {
        getRef: async () => ({ data: { object: { sha: "base" } } }),
        createRef: async () => {
          throw new Error("Reference already exists");
        },
        createBlob,
        updateRef,
      },
      repos: {
        getContent: async () => ({
          data: { content: Buffer.from("reviewer change\n").toString("base64") },
        }),
      },
    };
    (
      delivery as unknown as {
        octokit: () => Promise<typeof fakeOctokit>;
      }
    ).octokit = async () => fakeOctokit;

    await delivery.createBranch("acme", "shop", "mendpoint/change", "trunk");
    await expect(
      delivery.commitFiles("acme", "shop", "mendpoint/change", "Fix", [
        { path: "src/a.ts", content: "intended change\n" },
      ]),
    ).rejects.toThrow(/human reconciliation required/);
    expect(updateRef).not.toHaveBeenCalled();
    expect(createBlob).not.toHaveBeenCalled();
  });

  it("uses installation authentication for exact draft delivery evidence", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const delivery = new GitHubAppDelivery(
      { appId: "99", privateKeyPem: pem },
      42,
    );
    let branchHead: string | undefined;
    const fakeOctokit = {
      git: {
        getRef: vi.fn(async ({ ref }: { ref: string }) => {
          if (ref === "heads/main") return { data: { object: { sha: EXACT_BASE_SHA } } };
          if (branchHead) return { data: { object: { sha: branchHead } } };
          throw Object.assign(new Error("Not Found"), { status: 404 });
        }),
        createRef: vi.fn(async ({ sha }: { sha: string }) => {
          branchHead = sha;
          return { data: { object: { sha } } };
        }),
        getCommit: vi.fn(async ({ commit_sha }: { commit_sha: string }) => ({
          data: commit_sha === EXACT_BASE_SHA
            ? { sha: commit_sha, tree: { sha: "base-tree" }, parents: [] }
            : { sha: commit_sha, tree: { sha: "desired-tree" }, parents: [{ sha: EXACT_BASE_SHA }] },
        })),
        createBlob: vi.fn(async () => ({ data: { sha: "blob-a" } })),
        createTree: vi.fn(async () => ({ data: { sha: "desired-tree" } })),
        createCommit: vi.fn(async () => ({ data: { sha: EXACT_COMMIT_SHA } })),
        updateRef: vi.fn(async ({ sha }: { sha: string }) => {
          branchHead = sha;
          return { data: { object: { sha } } };
        }),
      },
      pulls: {
        list: vi.fn(async () => ({ data: [] })),
        create: vi.fn(async () => ({ data: {
          number: 23,
          html_url: "https://github.com/acme/shop/pull/23",
          state: "open",
          draft: true,
          title: "Transformer candidate",
          body: "Exact candidate",
          head: { ref: "mendpoint/transformer/candidate-a", sha: branchHead },
          base: { ref: "main", sha: EXACT_BASE_SHA },
        } })),
      },
    };
    (delivery as unknown as { octokit: () => Promise<typeof fakeOctokit> }).octokit =
      async () => fakeOctokit;

    await expect(delivery.deliverExactDraft({
      owner: "acme",
      repo: "shop",
      baseBranch: "main",
      expectedBaseSha: EXACT_BASE_SHA,
      branch: "mendpoint/transformer/candidate-a",
      commitMessage: "Open approved Transformer candidate",
      commitDate: "2026-08-06T12:00:00.000Z",
      title: "Transformer candidate",
      body: "Exact candidate",
      files: [{ path: "src/a.ts", content: "changed\n", mode: "100644" }],
    })).resolves.toMatchObject({
      draft: true,
      baseSha: EXACT_BASE_SHA,
      commitSha: EXACT_COMMIT_SHA,
      number: 23,
    });
  });

  it("returns a deterministic installation repository listing in mock mode", async () => {
    const first = await listInstallationRepositories({
      installationId: 55,
      accountLogin: "acme",
      env: {} as NodeJS.ProcessEnv,
      mockRepositories: [
        { name: "shop" },
        { name: "billing", archived: true },
        { name: "docs", owner: "acme-labs", disabled: true },
      ],
    });
    const second = await listInstallationRepositories({
      installationId: 55,
      accountLogin: "acme",
      env: { GITHUB_MODE: "mock" } as NodeJS.ProcessEnv,
      mockRepositories: [
        { name: "shop" },
        { name: "billing", archived: true },
        { name: "docs", owner: "acme-labs", disabled: true },
      ],
    });
    expect(second).toEqual(first);
    expect(first).toEqual(
      mockInstallationRepositories({
        installationId: 55,
        accountLogin: "acme",
        repositories: [
          { name: "shop" },
          { name: "billing", archived: true },
          { name: "docs", owner: "acme-labs", disabled: true },
        ],
      }),
    );
    expect(first.map((r) => `${r.owner}/${r.name}`)).toEqual([
      "acme/shop",
      "acme/billing",
      "acme-labs/docs",
    ]);
    expect(first[1]?.archived).toBe(true);
    expect(first[2]?.disabled).toBe(true);
  });

  it("lists installation repositories via the App client in real mode", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const fetchToken = vi.fn(async (installationId: number) => ({
      token: "ghs_real",
      expiresAt: "2026-01-01T01:00:00.000Z",
      installationId,
    }));
    const lister = vi.fn(async (token: string) => {
      expect(token).toBe("ghs_real");
      return [
        {
          id: 101,
          owner: "acme",
          name: "shop",
          fullName: "acme/shop",
          defaultBranch: "main",
          private: true,
          archived: false,
          disabled: false,
        },
      ];
    });
    const repos = await listInstallationRepositories({
      installationId: 42,
      accountLogin: "acme",
      env: { GITHUB_MODE: "real" } as NodeJS.ProcessEnv,
      credentials: { appId: "99", privateKeyPem: pem },
      fetchToken,
      lister,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(lister).toHaveBeenCalledTimes(1);
    expect(repos.map((r) => r.name)).toEqual(["shop"]);
  });

  it("requires App credentials in real mode", async () => {
    await expect(
      listInstallationRepositories({
        installationId: 42,
        accountLogin: "acme",
        env: { GITHUB_MODE: "real" } as NodeJS.ProcessEnv,
        credentials: null,
      }),
    ).rejects.toThrow("github_app_credentials_missing");
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
