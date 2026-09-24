import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepositoryBaseRefresher, type RepositoryGitRunner } from "./repository-base-refresh.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function gitRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-refresh-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

const REAL_ENV = { GITHUB_MODE: "real", GITHUB_APP_ID: "42", GITHUB_APP_PRIVATE_KEY: APP_PRIVATE_KEY } as unknown as NodeJS.ProcessEnv;
const baseInput = { tenantId: "tenant-a", owner: "acme", repo: "shop", defaultBranch: "main", installationId: "77" };

// A git runner that answers the "has commits" and "has origin" probes and then
// a scripted response for fetch/checkout/rev-parse. Records the calls.
function scriptedRunner(head: string): { runner: RepositoryGitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: RepositoryGitRunner = async (input) => {
    calls.push([...input.args]);
    const args = input.args;
    if (args[0] === "rev-parse" && args.includes("--verify")) return head; // "has commits" probe
    if (args[0] === "remote") return "https://github.com/acme/shop.git"; // "has origin" probe
    if (args[0] === "rev-parse") return head; // final HEAD
    return ""; // fetch / checkout
  };
  return { runner, calls };
}

describe("repository base refresher", () => {
  it("is not applicable outside real GitHub mode", async () => {
    const refresh = createRepositoryBaseRefresher({ GITHUB_MODE: "mock" } as NodeJS.ProcessEnv);
    expect(await refresh({ ...baseInput, repoRoot: gitRepoRoot() })).toEqual({ status: "not_applicable" });
  });

  it("is not applicable when the clone has no git directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-refresh-nogit-"));
    dirs.push(dir);
    const refresh = createRepositoryBaseRefresher(REAL_ENV, {
      mintToken: async () => "unused",
      gitRunner: async () => { throw new Error("git must not run"); },
    });
    expect(await refresh({ ...baseInput, repoRoot: dir })).toEqual({ status: "not_applicable" });
  });

  it("is not applicable for a git folder with no commits or no origin", async () => {
    for (const failingProbe of ["rev-parse", "remote"]) {
      const refresh = createRepositoryBaseRefresher(REAL_ENV, {
        mintToken: async () => { throw new Error("must not mint before probes pass"); },
        gitRunner: async (input) => {
          if (input.args[0] === failingProbe) throw new Error("no commits / no origin");
          return "";
        },
      });
      expect(await refresh({ ...baseInput, repoRoot: gitRepoRoot() })).toEqual({ status: "not_applicable" });
    }
  });

  it("fetches the remote default head, in order, and reports the checked-out sha", async () => {
    const head = "a".repeat(40);
    const { runner, calls } = scriptedRunner(head);
    const refresh = createRepositoryBaseRefresher(REAL_ENV, { mintToken: async () => "tok", gitRunner: runner });
    expect(await refresh({ ...baseInput, repoRoot: gitRepoRoot() })).toEqual({ status: "refreshed", headSha: head });
    // Order: probes, then fetch, then checkout, then the final rev-parse HEAD.
    // Config (-c) flags precede the subcommand, so detect verbs by membership.
    const fetchAt = calls.findIndex((c) => c.includes("fetch"));
    const checkoutAt = calls.findIndex((c) => c.includes("checkout"));
    const headAt = calls.map((c) => c[0] === "rev-parse" && !c.includes("--verify"))
      .lastIndexOf(true);
    expect(fetchAt).toBeGreaterThanOrEqual(0);
    expect(fetchAt).toBeLessThan(checkoutAt);
    expect(checkoutAt).toBeLessThan(headAt);
  });

  it("sends the credential in an http.extraHeader, never in the URL/argv, and disables credential.helper", async () => {
    const secretToken = "ghs_SUPER_SECRET_TOKEN_VALUE";
    const fetchArgs: string[] = [];
    const runner: RepositoryGitRunner = async (input) => {
      if (input.args[0] === "rev-parse" && input.args.includes("--verify")) return "a".repeat(40);
      if (input.args[0] === "remote") return "url";
      if (input.args.includes("fetch")) fetchArgs.push(...input.args);
      if (input.args[0] === "rev-parse") return "a".repeat(40);
      return "";
    };
    const refresh = createRepositoryBaseRefresher(REAL_ENV, { mintToken: async () => secretToken, gitRunner: runner });
    await refresh({ ...baseInput, repoRoot: gitRepoRoot() });
    // Auth header present (this dies if the header is removed).
    expect(fetchArgs.some((a) => a.startsWith("http.extraHeader=Authorization: Basic "))).toBe(true);
    // credential.helper emptied so git-credential-manager is never consulted.
    expect(fetchArgs).toContain("credential.helper=");
    // Option-terminator before the refspec; bare "origin" remote (this dies if
    // the token is moved into a URL in argv).
    expect(fetchArgs).toContain("origin");
    expect(fetchArgs).toContain("--");
    for (const arg of fetchArgs) {
      expect(arg).not.toContain(secretToken); // raw token never on the command line
      expect(arg).not.toMatch(/^https?:\/\//); // no URL argument at all
    }
  });

  it("mints a repository-scoped token when the validated repository id is provided", async () => {
    let seenRepositoryIds: number[] | undefined = [-1];
    const refresh = createRepositoryBaseRefresher(REAL_ENV, {
      mintToken: async (_c, _i, repositoryIds) => { seenRepositoryIds = repositoryIds; return "tok"; },
      gitRunner: scriptedRunner("a".repeat(40)).runner,
    });
    await refresh({ ...baseInput, repoRoot: gitRepoRoot(), repositoryId: "9042" });
    expect(seenRepositoryIds).toEqual([9042]);
  });

  it("rejects a branch that could be read as a git option before running git or minting", async () => {
    const refresh = createRepositoryBaseRefresher(REAL_ENV, {
      mintToken: async () => { throw new Error("must not mint"); },
      gitRunner: async () => { throw new Error("git must not run"); },
    });
    expect(await refresh({ ...baseInput, repoRoot: gitRepoRoot(), defaultBranch: "--upload-pack=evil" }))
      .toEqual({ status: "failed", code: "github_repository_base_refresh_branch_invalid" });
  });

  it("returns a retryable named code when the fetch fails and never leaks the credential", async () => {
    const secretToken = "ghs_SUPER_SECRET_TOKEN_VALUE";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const runner: RepositoryGitRunner = async (input) => {
      if (input.args[0] === "rev-parse" && input.args.includes("--verify")) return "a".repeat(40);
      if (input.args[0] === "remote") return "url";
      throw new Error(`fatal: could not read from remote (Authorization: Basic ${secretToken})`);
    };
    const refresh = createRepositoryBaseRefresher(REAL_ENV, { mintToken: async () => secretToken, gitRunner: runner });
    const result = await refresh({ ...baseInput, repoRoot: gitRepoRoot() });
    expect(result).toEqual({ status: "failed", code: "github_repository_base_refresh_fetch_failed" });
    expect(JSON.stringify(result)).not.toContain(secretToken);
    for (const spy of [errorSpy, logSpy]) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(secretToken);
    }
  });

  it("fails with a named code when the token cannot be minted", async () => {
    const refresh = createRepositoryBaseRefresher(REAL_ENV, {
      mintToken: async () => { throw new Error("token backend down"); },
      gitRunner: scriptedRunner("a".repeat(40)).runner,
    });
    expect(await refresh({ ...baseInput, repoRoot: gitRepoRoot() }))
      .toEqual({ status: "failed", code: "github_repository_base_refresh_token_unavailable" });
  });

  it("rejects a malformed installation id before minting a token", async () => {
    const refresh = createRepositoryBaseRefresher(REAL_ENV, {
      mintToken: async () => { throw new Error("must not mint"); },
      gitRunner: async () => { throw new Error("git must not run"); },
    });
    expect(await refresh({ ...baseInput, repoRoot: gitRepoRoot(), installationId: null }))
      .toEqual({ status: "failed", code: "github_repository_base_refresh_installation_invalid" });
  });
});
