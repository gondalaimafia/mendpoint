import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, upsertGitHubInstallation, type AppDb } from "@mendpoint/db";
import type { TokenFetcher } from "@mendpoint/github";
import type { ApiEnv } from "./auth.js";
import { resolveRepoKey } from "./repo-path.js";
import {
  connectRepositoryCheckout,
  createSelfServeConnectRoutes,
  mockFixtureClone,
  selfServeConnectEnabled,
  type RepositoryCheckoutCloner,
} from "./repository-connect.js";

const roots: string[] = [];
const dbs: AppDb[] = [];
const previousReposDir = process.env.MENDPOINT_REPOS_DIR;
const previousNodeEnv = process.env.NODE_ENV;
const previousFlag = process.env.MENDPOINT_SELF_SERVE_CONNECT;
const previousMode = process.env.GITHUB_MODE;
const previousAppId = process.env.GITHUB_APP_ID;
const previousAppKey = process.env.GITHUB_APP_PRIVATE_KEY;
const previousBindings = process.env.GITHUB_APP_ACCOUNT_TENANT_BINDINGS;

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function makeTreeWritable(root: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    chmodSync(root, 0o644);
    return;
  }
  chmodSync(root, 0o755);
  for (const entry of readdirSync(root)) makeTreeWritable(join(root, entry));
}

function reposRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-connect-"));
  roots.push(root);
  return root;
}

function prodEnv(root: string): NodeJS.ProcessEnv {
  return { NODE_ENV: "production", MENDPOINT_REPOS_DIR: root, MENDPOINT_SELF_SERVE_CONNECT: "1" };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  restoreEnv("MENDPOINT_REPOS_DIR", previousReposDir);
  restoreEnv("NODE_ENV", previousNodeEnv);
  restoreEnv("MENDPOINT_SELF_SERVE_CONNECT", previousFlag);
  restoreEnv("GITHUB_MODE", previousMode);
  restoreEnv("GITHUB_APP_ID", previousAppId);
  restoreEnv("GITHUB_APP_PRIVATE_KEY", previousAppKey);
  restoreEnv("GITHUB_APP_ACCOUNT_TENANT_BINDINGS", previousBindings);
  while (roots.length) {
    const root = roots.pop();
    if (root) {
      makeTreeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("self-serve connect flag", () => {
  it("is off by default", () => {
    expect(selfServeConnectEnabled({})).toBe(false);
    expect(selfServeConnectEnabled({ MENDPOINT_SELF_SERVE_CONNECT: "1" })).toBe(true);
  });
});

describe("clone-on-connect (mock mode)", () => {
  it("clones a repo into the tenant path so resolveRepoKey resolves it", async () => {
    const root = reposRoot();
    const env = prodEnv(root);
    const result = await connectRepositoryCheckout(
      { tenantId: "tenant-a", repoKey: "shop-app", owner: "acme", name: "shop-app" },
      env,
    );
    const expected = join(root, "tenant-a", "shop-app");
    expect(result.destination).toBe(resolveRepoKey("shop-app", "tenant-a", env));
    expect(result.destination).toBe(expected);
    expect(result.reused).toBe(false);
    expect(existsSync(join(expected, ".git"))).toBe(true);
    // A real, materializable worktree with exactly one commit.
    expect(git(expected, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("is idempotent on re-connect: updates in place without duplicating", async () => {
    const root = reposRoot();
    const env = prodEnv(root);
    const first = await connectRepositoryCheckout(
      { tenantId: "tenant-a", repoKey: "shop-app", owner: "acme", name: "shop-app" },
      env,
    );
    const second = await connectRepositoryCheckout(
      { tenantId: "tenant-a", repoKey: "shop-app", owner: "acme", name: "shop-app" },
      env,
    );
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.destination).toBe(first.destination);
    // Same single checkout, and the deterministic fixture added no new commit.
    expect(readdirSync(join(root, "tenant-a"))).toEqual(["shop-app"]);
    expect(git(first.destination, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("writes only the caller tenant's path", async () => {
    const root = reposRoot();
    const env = prodEnv(root);
    await connectRepositoryCheckout(
      { tenantId: "tenant-a", repoKey: "shop-app", owner: "acme", name: "shop-app" },
      env,
    );
    expect(existsSync(join(root, "tenant-a", "shop-app"))).toBe(true);
    expect(existsSync(join(root, "tenant-b"))).toBe(false);
    // Cross-tenant traversal is rejected before anything is written.
    await expect(
      connectRepositoryCheckout(
        { tenantId: "tenant-a", repoKey: "../tenant-b/evil", owner: "acme", name: "evil" },
        env,
      ),
    ).rejects.toThrow("repo_path_outside_tenant_root");
    expect(existsSync(join(root, "tenant-b"))).toBe(false);
  });
});

describe("flag off is byte-identical", () => {
  it("refuses to connect and leaves resolveRepoKey's pre-existing-checkout requirement intact", async () => {
    const root = reposRoot();
    const off = { NODE_ENV: "production", MENDPOINT_REPOS_DIR: root };
    await expect(
      connectRepositoryCheckout(
        { tenantId: "tenant-a", repoKey: "shop-app", owner: "acme", name: "shop-app" },
        off,
      ),
    ).rejects.toThrow("self_serve_connect_disabled");
    // No checkout was materialized...
    expect(existsSync(join(root, "tenant-a"))).toBe(false);
    // ...and resolveRepoKey still requires a pre-existing checkout (unchanged).
    expect(() => resolveRepoKey("shop-app", "tenant-a", off)).toThrow();
  });
});

describe("self-serve connect route", () => {
  function appWith(options: Parameters<typeof createSelfServeConnectRoutes>[0]) {
    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => {
      c.set("principal", { id: "p1", tenantId: "tenant-a", role: "owner" } as never);
      await next();
    });
    app.route("/self-serve/connect", createSelfServeConnectRoutes(options));
    return app;
  }

  function post(app: Hono<ApiEnv>, body: unknown) {
    return app.request("/self-serve/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("404s when the flag is off", async () => {
    const db = createDb(join(reposRoot(), "connect.sqlite"));
    dbs.push(db);
    const app = appWith({ db, enabled: false });
    const res = await post(app, { repoKey: "shop-app", owner: "acme", name: "shop-app" });
    expect(res.status).toBe(404);
  });

  it("clones and links a local_git repository when enabled (mock mode)", async () => {
    const root = reposRoot();
    process.env.MENDPOINT_REPOS_DIR = root;
    process.env.NODE_ENV = "test";
    process.env.MENDPOINT_SELF_SERVE_CONNECT = "1";
    delete process.env.GITHUB_MODE;
    const db = createDb(join(root, "connect.sqlite"));
    dbs.push(db);
    const app = appWith({ db, enabled: true });
    const res = await post(app, { repoKey: "shop-app", owner: "acme", name: "shop-app" });
    expect(res.status).toBe(201);
    const payload = (await res.json()) as {
      checkout: { path: string; reused: boolean; provider: string };
      connection: { provider: string };
      repository: { status: string; remote_id: string };
    };
    // Dev flat layout: MENDPOINT_REPOS_DIR/<repoKey>.
    expect(payload.checkout.path).toBe(resolveRepoKey("shop-app", "tenant-a"));
    expect(payload.checkout.reused).toBe(false);
    expect(payload.checkout.provider).toBe("github");
    expect(payload.connection.provider).toBe("local_git");
    expect(payload.repository.status).toBe("pending");
    expect(existsSync(join(root, "shop-app", ".git"))).toBe(true);
  });

  // Configures the ambient environment for real GitHub App mode. process.env is
  // the single source of truth here because registerConnectedRepository resolves
  // the checkout path from process.env, exactly as the deployed app does.
  function setRealEnv(root: string, bindings: string): void {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.NODE_ENV = "production";
    process.env.MENDPOINT_REPOS_DIR = root;
    process.env.MENDPOINT_SELF_SERVE_CONNECT = "1";
    process.env.GITHUB_MODE = "real";
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    process.env.GITHUB_APP_ACCOUNT_TENANT_BINDINGS = bindings;
  }

  function seedInstallation(
    db: AppDb,
    opts: {
      installationId: string;
      accountId: string;
      tenantId: string;
      owner: string;
      name: string;
      repoId: number;
    },
  ): void {
    upsertGitHubInstallation(db, {
      id: `inst-${opts.installationId}`,
      installationId: opts.installationId,
      accountId: opts.accountId,
      accountLogin: opts.owner,
      tenantId: opts.tenantId,
      permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        checks: "read",
      },
      repositories: [{ id: opts.repoId, owner: opts.owner, name: opts.name }],
      repositorySelection: "selected",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    });
  }

  function recordingFetchToken(): {
    fetchToken: TokenFetcher;
    calls: Array<{ installationId: number; repositoryIds?: number[] }>;
  } {
    const calls: Array<{ installationId: number; repositoryIds?: number[] }> = [];
    const fetchToken: TokenFetcher = async (installationId, _jwt, repositoryIds) => {
      calls.push({ installationId, repositoryIds });
      return {
        token: "ghs_test_token",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        installationId,
        repositories: [],
      };
    };
    return { fetchToken, calls };
  }

  describe("real mode (GitHub App token scoping)", () => {
    it("rejects a caller supplying another tenant's installation id, minting no token", async () => {
      const root = reposRoot();
      // tenant-a owns installation 555 for acme/shop-app; tenant-b owns 999.
      setRealEnv(root, '{"7123456":"tenant-a","8888888":"tenant-b"}');
      const db = createDb(join(root, "connect.sqlite"));
      dbs.push(db);
      seedInstallation(db, {
        installationId: "555",
        accountId: "7123456",
        tenantId: "tenant-a",
        owner: "acme",
        name: "shop-app",
        repoId: 456,
      });
      seedInstallation(db, {
        installationId: "999",
        accountId: "8888888",
        tenantId: "tenant-b",
        owner: "acme",
        name: "secret",
        repoId: 777,
      });
      const { fetchToken, calls } = recordingFetchToken();
      const cloner = vi.fn<RepositoryCheckoutCloner>();
      const app = appWith({ db, enabled: true, fetchToken, cloner });
      // Caller (tenant-a) references tenant-b's installation id in the body.
      const res = await post(app, {
        repoKey: "shop-app",
        owner: "acme",
        name: "shop-app",
        installationId: "999",
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "connect_installation_not_authorized" });
      // No token minted and nothing cloned into any tenant path.
      expect(calls).toHaveLength(0);
      expect(cloner).not.toHaveBeenCalled();
    });

    it("succeeds with a valid binding and scopes the token to the requested repo", async () => {
      const root = reposRoot();
      setRealEnv(root, '{"7123456":"tenant-a"}');
      const db = createDb(join(root, "connect.sqlite"));
      dbs.push(db);
      seedInstallation(db, {
        installationId: "555",
        accountId: "7123456",
        tenantId: "tenant-a",
        owner: "acme",
        name: "shop-app",
        repoId: 456,
      });
      const { fetchToken, calls } = recordingFetchToken();
      // Real cloner would network-clone; substitute one that exercises the token
      // provider (triggering the scoped mint) then writes a mock fixture.
      const cloner: RepositoryCheckoutCloner = async (request) => {
        await request.tokenProvider?.();
        await mockFixtureClone(request);
      };
      const app = appWith({ db, enabled: true, fetchToken, cloner });
      const res = await post(app, { repoKey: "shop-app", owner: "acme", name: "shop-app" });
      expect(res.status).toBe(201);
      // The minted token request is scoped to exactly the requested repository.
      expect(calls).toEqual([{ installationId: 555, repositoryIds: [456] }]);
      expect(existsSync(join(root, "tenant-a", "shop-app", ".git"))).toBe(true);
    });

    it("rejects a missing binding with the same error shape (no enumeration signal)", async () => {
      const root = reposRoot();
      // Installation exists and is authorized, but tenant-a has no account binding.
      setRealEnv(root, '{"8888888":"tenant-b"}');
      const db = createDb(join(root, "connect.sqlite"));
      dbs.push(db);
      seedInstallation(db, {
        installationId: "555",
        accountId: "7123456",
        tenantId: "tenant-a",
        owner: "acme",
        name: "shop-app",
        repoId: 456,
      });
      const { fetchToken, calls } = recordingFetchToken();
      const cloner = vi.fn<RepositoryCheckoutCloner>();
      const app = appWith({ db, enabled: true, fetchToken, cloner });
      const res = await post(app, { repoKey: "shop-app", owner: "acme", name: "shop-app" });
      expect(res.status).toBe(422);
      // Identical to the wrong-tenant rejection: caller cannot tell them apart.
      expect(await res.json()).toEqual({ error: "connect_installation_not_authorized" });
      expect(calls).toHaveLength(0);
      expect(cloner).not.toHaveBeenCalled();
    });
  });
});

describe("cloner contract", () => {
  it("mock fixture clone produces a valid worktree", async () => {
    const root = reposRoot();
    const destination = join(root, "fixture-repo");
    await mockFixtureClone({
      provider: "github",
      owner: "acme",
      name: "widget",
      branch: "main",
      destination,
    });
    expect(git(destination, "rev-parse", "--is-inside-work-tree")).toBe("true");
    expect(existsSync(join(destination, "package.json"))).toBe(true);
  });
});
