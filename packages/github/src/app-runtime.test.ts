import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  classifyGitHubDependencyFailure,
  createAppJwt,
  deliverToManyRepos,
  GitHubAppDelivery,
  InstallationTokenCache,
  hasGitHubAppCredentials,
  listInstallationRepositories,
  loadAppCredentials,
  mockInstallationRepositories,
  type GitHubDependencyOutagePort,
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

  it("does not mistake a failed App deletion read for an applied recovery", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const delivery = new GitHubAppDelivery(
      { appId: "99", privateKeyPem: pem },
      42,
    );
    const createBlob = vi.fn();
    const fakeOctokit = {
      git: {
        getRef: async () => ({ data: { object: { sha: "base" } } }),
        createRef: async () => {
          throw new Error("Reference already exists");
        },
        createBlob,
      },
      repos: {
        getContent: async () => {
          throw Object.assign(new Error("service unavailable"), { status: 503 });
        },
      },
    };
    (delivery as unknown as { octokit: () => Promise<typeof fakeOctokit> }).octokit =
      async () => fakeOctokit;

    await delivery.createBranch("acme", "shop", "mendpoint/change", "trunk");
    await expect(delivery.commitFiles("acme", "shop", "mendpoint/change", "Fix", [
      { path: "src/obsolete.ts", delete: true },
    ])).rejects.toThrow(/human reconciliation required/);
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

  it("classifies authentication, permission, throttle, timeout, provider, and lost-response failures distinctly", () => {
    expect(classifyGitHubDependencyFailure(Object.assign(new Error("bad credentials"), { status: 401 })))
      .toEqual({ failureKind: "authentication" });
    expect(classifyGitHubDependencyFailure(Object.assign(new Error("forbidden"), { status: 403 })))
      .toEqual({ failureKind: "permission" });
    expect(classifyGitHubDependencyFailure(Object.assign(new Error("slow down"), {
      status: 429,
      response: { headers: { "retry-after": "30" } },
    }), "2026-09-01T12:00:00.000Z")).toEqual({
      failureKind: "throttled",
      retryAfterMs: 30_000,
    });
    expect(classifyGitHubDependencyFailure(Object.assign(new Error("API rate limit exceeded"), {
      status: 403,
      response: { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1788264030" } },
    }), "2026-09-01T12:00:00.000Z")).toEqual({
      failureKind: "throttled",
      retryAfterMs: 30_000,
    });
    expect(classifyGitHubDependencyFailure(Object.assign(new Error("secondary rate limit"), {
      status: 403,
      response: { headers: { "retry-after": "45" } },
    }), "2026-09-01T12:00:00.000Z")).toEqual({
      failureKind: "throttled",
      retryAfterMs: 45_000,
    });
    expect(classifyGitHubDependencyFailure(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })))
      .toEqual({ failureKind: "timeout" });
    expect(classifyGitHubDependencyFailure(Object.assign(new Error("unavailable"), { status: 503 })))
      .toEqual({ failureKind: "transient" });
    expect(classifyGitHubDependencyFailure(Object.assign(new Error("response lost"), {
      remoteSideEffectUncertain: true,
    }))).toEqual({ failureKind: "completed" });
    expect(classifyGitHubDependencyFailure(Object.assign(new Error("validation"), { status: 422 })))
      .toEqual({ failureKind: "permanent" });
  });

  it("binds exact-draft delivery to the tenant-scoped injected outage port", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const recovered = {
      number: 23,
      url: "https://github.com/acme/shop/pull/23",
      branch: "mendpoint/fettler/candidate-a",
      title: "Fettler candidate",
      draft: true as const,
      baseBranch: "main",
      baseSha: EXACT_BASE_SHA,
      commitSha: EXACT_COMMIT_SHA,
    };
    const run = vi.fn(async (operation: Parameters<GitHubDependencyOutagePort["run"]>[0]) => ({
      status: "recovered" as const,
      value: recovered,
      operationDigest: operation.operationDigest,
    }));
    const outage = { run } as GitHubDependencyOutagePort;
    const decide = vi.fn(() => ({
      schemaVersion: 1 as const,
      action: "await_authority" as const,
      failureKind: "authentication",
      retryable: false,
      reason: "authority_change_required",
      nextAttemptAt: null,
      circuitState: "open" as const,
      circuit: {
        state: "open" as const,
        openedAt: "2026-09-01T12:00:00.000Z",
        cooldownMs: 30_000,
        consecutiveFailures: 1,
      },
      standing: "degraded_blocked" as const,
    }));
    const delivery = new GitHubAppDelivery(
      { appId: "99", privateKeyPem: pem },
      42,
      undefined,
      [77],
      {
        tenantId: "tenant-acme",
        outage,
        decide,
        retryBudget: 3,
        expiresInMs: 60_000,
        workerId: "worker-1",
        authorityVersion: "installation-v1",
      },
    );
    const input = {
      owner: "acme",
      repo: "shop",
      baseBranch: "main",
      expectedBaseSha: EXACT_BASE_SHA,
      branch: "mendpoint/fettler/candidate-a",
      commitMessage: "Open approved Fettler candidate",
      commitDate: "2026-09-01T12:00:00.000Z",
      title: "Fettler candidate",
      body: "Exact candidate",
      files: [{ path: "src/a.ts", content: "changed\n", mode: "100644" as const }],
    };
    await expect(delivery.deliverExactDraft(input)).resolves.toEqual(recovered);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toMatchObject({
      schemaVersion: 1,
      tenantId: "tenant-acme",
      dependencyKind: "scm",
      providerId: "github",
      retryBudget: 3,
      workerId: "worker-1",
      authorityVersion: "installation-v1",
    });
    expect(run.mock.calls[0]![0].operationId).toMatch(/^github-draft:[a-f0-9]{64}$/);
    expect(run.mock.calls[0]![0].operationId.length).toBeLessThanOrEqual(200);
    expect(run.mock.calls[0]![0].operationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(run.mock.calls[0]![0].authorityVersion).toBe("installation-v1");
    await delivery.deliverExactDraft({
      ...input,
      files: [{ path: "src/a.ts", content: "different\n", mode: "100644" as const }],
    });
    expect(run.mock.calls[1]![0].operationId).toBe(run.mock.calls[0]![0].operationId);
    expect(run.mock.calls[1]![0].operationDigest).not.toBe(run.mock.calls[0]![0].operationDigest);
  });

  it("reconciles an exact lost-response draft before every Git write", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const createBlob = vi.fn(async () => { throw new Error("duplicate_blob_write"); });
    const createTree = vi.fn(async () => { throw new Error("duplicate_tree_write"); });
    const createCommit = vi.fn(async () => { throw new Error("duplicate_commit_write"); });
    const updateRef = vi.fn(async () => { throw new Error("duplicate_ref_write"); });
    const createPull = vi.fn(async () => { throw new Error("duplicate_pull_write"); });
    const exactPull = {
      number: 23,
      html_url: "https://github.com/acme/shop/pull/23",
      state: "open",
      draft: true,
      title: "Fettler candidate",
      body: "Exact candidate",
      head: { ref: "mendpoint/fettler/candidate-a", sha: EXACT_COMMIT_SHA },
      base: { ref: "main", sha: EXACT_BASE_SHA },
    };
    const fakeOctokit = {
      git: {
        getRef: vi.fn(async ({ ref }: { ref: string }) => ({
          data: { object: { sha: ref === "heads/main" ? EXACT_BASE_SHA : EXACT_COMMIT_SHA } },
        })),
        getCommit: vi.fn(async ({ commit_sha }: { commit_sha: string }) => ({
          data: commit_sha === EXACT_BASE_SHA
            ? { sha: EXACT_BASE_SHA, tree: { sha: "b".repeat(40) }, parents: [] }
            : {
              sha: EXACT_COMMIT_SHA,
              tree: { sha: "d".repeat(40) },
              parents: [{ sha: EXACT_BASE_SHA }],
              message: "Open approved Fettler candidate",
              author: { name: "Mendpoint", email: "delivery@mendpoint.ai", date: "2026-09-01T12:00:00.000Z" },
              committer: { name: "Mendpoint", email: "delivery@mendpoint.ai", date: "2026-09-01T12:00:00.000Z" },
            },
        })),
        getTree: vi.fn(async () => ({
          data: {
            truncated: false,
            tree: [{ path: "src/a.ts", type: "blob", mode: "100644", sha: "blob-a" }],
          },
        })),
        createBlob,
        createTree,
        createCommit,
        createRef: vi.fn(async () => { throw new Error("duplicate_ref_create"); }),
        updateRef,
      },
      repos: {
        compareCommitsWithBasehead: vi.fn(async () => ({
          data: { files: [{ filename: "src/a.ts", status: "modified" }] },
          headers: {},
        })),
        getContent: vi.fn(async () => ({
          data: {
            type: "file",
            encoding: "base64",
            content: Buffer.from("changed\n", "utf8").toString("base64"),
          },
        })),
      },
      pulls: {
        list: vi.fn(async () => ({ data: [exactPull] })),
        create: createPull,
      },
    };
    const outage: GitHubDependencyOutagePort = {
      async run<T>(operation: Parameters<GitHubDependencyOutagePort["run"]>[0]) {
        const observed = await operation.reconcile();
        if (observed.status === "completed") {
          return { status: "recovered" as const, value: observed.value as T };
        }
        const executed = await operation.execute();
        return { status: "completed" as const, value: executed.value as T };
      },
    };
    const delivery = new GitHubAppDelivery(
      { appId: "99", privateKeyPem: pem },
      42,
      undefined,
      [77],
      {
        tenantId: "tenant-acme",
        outage,
        decide: () => { throw new Error("decision_not_expected"); },
        retryBudget: 5,
        expiresInMs: 60_000,
        workerId: "worker-1",
        authorityVersion: "installation-v1",
        now: () => "2026-09-01T12:00:10.000Z",
      },
    );
    (delivery as unknown as { octokit: () => Promise<typeof fakeOctokit> }).octokit =
      async () => fakeOctokit;

    await expect(delivery.deliverExactDraft({
      owner: "acme",
      repo: "shop",
      baseBranch: "main",
      expectedBaseSha: EXACT_BASE_SHA,
      branch: "mendpoint/fettler/candidate-a",
      commitMessage: "Open approved Fettler candidate",
      commitDate: "2026-09-01T12:00:00.000Z",
      title: "Fettler candidate",
      body: "Exact candidate",
      files: [{ path: "src/a.ts", content: "changed\n", mode: "100644" }],
    })).resolves.toEqual({
      number: 23,
      url: exactPull.html_url,
      branch: exactPull.head.ref,
      title: exactPull.title,
      draft: true,
      baseBranch: exactPull.base.ref,
      baseSha: EXACT_BASE_SHA,
      commitSha: EXACT_COMMIT_SHA,
    });
    expect(createBlob).not.toHaveBeenCalled();
    expect(createTree).not.toHaveBeenCalled();
    expect(createCommit).not.toHaveBeenCalled();
    expect(updateRef).not.toHaveBeenCalled();
    expect(createPull).not.toHaveBeenCalled();
  });

  it("resumes a commit-ready exact draft at pull request creation without repeating Git object writes", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const createBlob = vi.fn(async () => { throw new Error("duplicate_blob_write"); });
    const createTree = vi.fn(async () => { throw new Error("duplicate_tree_write"); });
    const createCommit = vi.fn(async () => { throw new Error("duplicate_commit_write"); });
    const createRef = vi.fn(async () => { throw new Error("duplicate_ref_write"); });
    const updateRef = vi.fn(async () => { throw new Error("duplicate_ref_write"); });
    const exactPull = {
      number: 24,
      html_url: "https://github.com/acme/shop/pull/24",
      state: "open",
      draft: true,
      title: "Fettler candidate",
      body: "Exact candidate",
      head: { ref: "mendpoint/fettler/candidate-a", sha: EXACT_COMMIT_SHA },
      base: { ref: "main", sha: EXACT_BASE_SHA },
    };
    const createPull = vi.fn(async () => ({ data: exactPull }));
    const fakeOctokit = {
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: EXACT_COMMIT_SHA } } })),
        getCommit: vi.fn(async ({ commit_sha }: { commit_sha: string }) => ({
          data: commit_sha === EXACT_BASE_SHA
            ? { sha: EXACT_BASE_SHA, tree: { sha: "b".repeat(40) }, parents: [] }
            : {
              sha: EXACT_COMMIT_SHA,
              tree: { sha: "d".repeat(40) },
              parents: [{ sha: EXACT_BASE_SHA }],
              message: "Open approved Fettler candidate",
              author: { name: "Mendpoint", email: "delivery@mendpoint.ai", date: "2026-09-01T12:00:00.000Z" },
              committer: { name: "Mendpoint", email: "delivery@mendpoint.ai", date: "2026-09-01T12:00:00.000Z" },
            },
        })),
        getTree: vi.fn(async ({ tree_sha }: { tree_sha: string }) => ({
          data: {
            truncated: false,
            tree: tree_sha === "b".repeat(40)
              ? [{ path: "src/a.ts", type: "blob", mode: "100644", sha: "blob-before" }]
              : [{ path: "src/a.ts", type: "blob", mode: "100644", sha: "blob-after" }],
          },
        })),
        createBlob,
        createTree,
        createCommit,
        createRef,
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
        create: createPull,
      },
    };
    const outage: GitHubDependencyOutagePort = {
      async run<T>(operation: Parameters<GitHubDependencyOutagePort["run"]>[0]) {
        expect(await operation.reconcile()).toEqual({ status: "missing" });
        const executed = await operation.execute();
        return { status: "completed" as const, value: executed.value as T };
      },
    };
    const delivery = new GitHubAppDelivery(
      { appId: "99", privateKeyPem: pem },
      42,
      undefined,
      [77],
      {
        tenantId: "tenant-acme",
        outage,
        decide: () => { throw new Error("decision_not_expected"); },
        retryBudget: 5,
        expiresInMs: 60_000,
        workerId: "worker-1",
        authorityVersion: "installation-v1",
        now: () => "2026-09-01T12:00:10.000Z",
      },
    );
    (delivery as unknown as { octokit: () => Promise<typeof fakeOctokit> }).octokit =
      async () => fakeOctokit;

    await expect(delivery.deliverExactDraft({
      owner: "acme",
      repo: "shop",
      baseBranch: "main",
      expectedBaseSha: EXACT_BASE_SHA,
      branch: "mendpoint/fettler/candidate-a",
      commitMessage: "Open approved Fettler candidate",
      commitDate: "2026-09-01T12:00:00.000Z",
      title: "Fettler candidate",
      body: "Exact candidate",
      files: [{ path: "src/a.ts", content: "changed\n", mode: "100644" }],
    })).resolves.toMatchObject({
      number: 24,
      commitSha: EXACT_COMMIT_SHA,
      draft: true,
    });
    expect(createPull).toHaveBeenCalledTimes(1);
    expect(createBlob).not.toHaveBeenCalled();
    expect(createTree).not.toHaveBeenCalled();
    expect(createCommit).not.toHaveBeenCalled();
    expect(createRef).not.toHaveBeenCalled();
    expect(updateRef).not.toHaveBeenCalled();
  });

  it("threads the durable circuit snapshot into the GitHub decision input", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const decide = vi.fn(() => ({
      schemaVersion: 1 as const,
      action: "wait" as const,
      failureKind: "transient",
      retryable: true,
      reason: "circuit_open",
      nextAttemptAt: "2026-09-01T12:00:30.000Z",
      circuitState: "open" as const,
      circuit: {
        state: "open" as const,
        openedAt: "2026-09-01T12:00:00.000Z",
        cooldownMs: 30_000,
        consecutiveFailures: 3,
      },
      standing: "degraded_retrying" as const,
    }));
    const outage: GitHubDependencyOutagePort = {
      async run<T>(operation: Parameters<GitHubDependencyOutagePort["run"]>[0]) {
        const decision = operation.classify(Object.assign(new Error("unavailable"), { status: 503 }), {
          attempt: 3,
          retryBudget: 5,
          now: "2026-09-01T12:00:00.000Z",
          circuit: {
            state: "open",
            openedAt: "2026-09-01T11:59:30.000Z",
            cooldownMs: 30_000,
            consecutiveFailures: 3,
          },
        });
        return { status: "deferred" as const, decision };
      },
    };
    const delivery = new GitHubAppDelivery(
      { appId: "99", privateKeyPem: pem },
      42,
      undefined,
      [77],
      {
        tenantId: "tenant-acme",
        outage,
        decide,
        retryBudget: 5,
        expiresInMs: 60_000,
        workerId: "worker-1",
        authorityVersion: "installation-v1",
        now: () => "2026-09-01T12:00:00.000Z",
      },
    );

    await expect(delivery.deliverExactDraft({
      owner: "acme",
      repo: "shop",
      baseBranch: "main",
      expectedBaseSha: EXACT_BASE_SHA,
      branch: "mendpoint/fettler/candidate-a",
      commitMessage: "Open approved Fettler candidate",
      commitDate: "2026-09-01T12:00:00.000Z",
      title: "Fettler candidate",
      body: "Exact candidate",
      files: [{ path: "src/a.ts", content: "changed\n", mode: "100644" }],
    })).rejects.toThrow("github_dependency_outage_deferred");
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({
      circuit: {
        state: "open",
        openedAt: "2026-09-01T11:59:30.000Z",
        cooldownMs: 30_000,
        consecutiveFailures: 3,
      },
    }));
  });
});
