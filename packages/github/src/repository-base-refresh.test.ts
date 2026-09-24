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

// A git runner that answers the top-level / commits / origin probes and then a
// scripted response for fetch/checkout/rev-parse. Records the calls.
function scriptedRunner(head: string): { runner: RepositoryGitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: RepositoryGitRunner = async (input) => {
    calls.push([...input.args]);
    const args = input.args;
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) return input.repoRoot; // repo root
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

  it("is not applicable when the path is not a git working tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-refresh-nogit-"));
    dirs.push(dir);
    const refresh = createRepositoryBaseRefresher(REAL_ENV, {
      mintToken: async () => "unused",
      // rev-parse --show-toplevel fails outside a git working tree.
      gitRunner: async () => { throw new Error("not a git repository"); },
    });
    expect(await refresh({ ...baseInput, repoRoot: dir })).toEqual({ status: "not_applicable" });
  });

  it("is not applicable for a git folder with no commits or no origin", async () => {
    for (const failingProbe of ["--verify", "remote"]) {
      const refresh = createRepositoryBaseRefresher(REAL_ENV, {
        mintToken: async () => { throw new Error("must not mint before probes pass"); },
        gitRunner: async (input) => {
          if (input.args[0] === "rev-parse" && input.args.includes("--show-toplevel")) return input.repoRoot;
          if (failingProbe === "--verify" && input.args.includes("--verify")) throw new Error("no commits");
          if (failingProbe === "remote" && input.args[0] === "remote") throw new Error("no origin");
          return "";
        },
      });
      expect(await refresh({ ...baseInput, repoRoot: gitRepoRoot() })).toEqual({ status: "not_applicable" });
    }
  });

  it("resolves the repository top level so a subdirectory clone still refreshes", async () => {
    const toplevel = "/repo/root";
    const seen: string[] = [];
    const runner: RepositoryGitRunner = async (input) => {
      seen.push(input.repoRoot);
      if (input.args[0] === "rev-parse" && input.args.includes("--show-toplevel")) return toplevel;
      if (input.args[0] === "rev-parse" && input.args.includes("--verify")) return "a".repeat(40);
      if (input.args[0] === "remote") return "url";
      if (input.args[0] === "rev-parse") return "a".repeat(40);
      return "";
    };
    const refresh = createRepositoryBaseRefresher(REAL_ENV, { mintToken: async () => "tok", gitRunner: runner });
    expect(await refresh({ ...baseInput, repoRoot: "/repo/root/packages/sub" }))
      .toEqual({ status: "refreshed", headSha: "a".repeat(40) });
    // Every command after top-level resolution runs against the resolved root.
    expect(seen.filter((r) => r !== toplevel)).toEqual(["/repo/root/packages/sub"]);
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

  it("carries the credential only in GIT_CONFIG env, never in argv, and disables credential.helper", async () => {
    const secretToken = "ghs_SUPER_SECRET_TOKEN_VALUE";
    const secretBase64 = Buffer.from(`x-access-token:${secretToken}`, "utf8").toString("base64");
    let fetchArgs: string[] = [];
    let fetchEnv: Record<string, string> = {};
    const runner: RepositoryGitRunner = async (input) => {
      if (input.args[0] === "rev-parse" && input.args.includes("--show-toplevel")) return input.repoRoot;
      if (input.args[0] === "rev-parse" && input.args.includes("--verify")) return "a".repeat(40);
      if (input.args[0] === "remote") return "url";
      if (input.args.includes("fetch")) { fetchArgs = [...input.args]; fetchEnv = { ...input.env }; }
      if (input.args[0] === "rev-parse") return "a".repeat(40);
      return "";
    };
    const refresh = createRepositoryBaseRefresher(REAL_ENV, { mintToken: async () => secretToken, gitRunner: runner });
    await refresh({ ...baseInput, repoRoot: gitRepoRoot() });
    // The credential rides in the environment, not the command line.
    expect(fetchEnv.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    expect(fetchEnv.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${secretBase64}`);
    // credential.helper emptied so git-credential-manager is never consulted.
    expect(fetchArgs).toContain("credential.helper=");
    // Bare "origin" remote and an option terminator before the refspec.
    expect(fetchArgs).toContain("origin");
    expect(fetchArgs).toContain("--");
    // Neither the raw token nor its base64 form nor a URL ever appears in argv
    // (this dies if the header is moved to -c on the command line).
    for (const arg of fetchArgs) {
      expect(arg).not.toContain(secretToken);
      expect(arg).not.toContain(secretBase64);
      expect(arg).not.toMatch(/^https?:\/\//);
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
      if (input.args[0] === "rev-parse" && input.args.includes("--show-toplevel")) return input.repoRoot;
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
