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

const baseInput = {
  tenantId: "tenant-a",
  owner: "acme",
  repo: "shop",
  defaultBranch: "main",
  installationId: "77",
};

describe("worker repository base refresher", () => {
  it("is not applicable outside real GitHub mode", async () => {
    const refresh = createRepositoryBaseRefresher({ GITHUB_MODE: "mock" } as NodeJS.ProcessEnv);
    expect(await refresh({ ...baseInput, repoRoot: gitRepoRoot() })).toEqual({ status: "not_applicable" });
  });

  it("is not applicable when the clone has no git history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-refresh-nogit-"));
    dirs.push(dir);
    const refresh = createRepositoryBaseRefresher(REAL_ENV, {
      mintToken: async () => "unused",
      gitRunner: () => { throw new Error("git must not run"); },
    });
    expect(await refresh({ ...baseInput, repoRoot: dir })).toEqual({ status: "not_applicable" });
  });

  it("fetches the remote default head and reports the refreshed sha", async () => {
    const head = "a".repeat(40);
    const calls: string[][] = [];
    const gitRunner: RepositoryGitRunner = (input) => {
      calls.push([...input.args]);
      return input.args[0] === "rev-parse" ? head : "";
    };
    const refresh = createRepositoryBaseRefresher(REAL_ENV, { mintToken: async () => "tok", gitRunner });
    expect(await refresh({ ...baseInput, repoRoot: gitRepoRoot() })).toEqual({ status: "refreshed", headSha: head });
    expect(calls[0]?.slice(0, 2)).toEqual(["fetch", "--depth"]);
    expect(calls.some((args) => args[0] === "checkout")).toBe(true);
  });

  it("returns a retryable named code when the fetch fails and never leaks the credential", async () => {
    const secretToken = "ghs_SUPER_SECRET_TOKEN_VALUE";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const gitRunner: RepositoryGitRunner = () => {
      // Simulate git echoing the injected credential in its failure output.
      throw new Error(`fatal: could not read from remote (Authorization: Basic ${secretToken})`);
    };
    const refresh = createRepositoryBaseRefresher(REAL_ENV, { mintToken: async () => secretToken, gitRunner });
    const result = await refresh({ ...baseInput, repoRoot: gitRepoRoot() });
    expect(result).toEqual({ status: "failed", code: "github_repository_base_refresh_fetch_failed" });
    // The credential must never appear in the returned outcome or any console output.
    expect(JSON.stringify(result)).not.toContain(secretToken);
    for (const spy of [errorSpy, logSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(secretToken);
      }
    }
  });

  it("fails with a named code when the token cannot be minted", async () => {
    const refresh = createRepositoryBaseRefresher(REAL_ENV, {
      mintToken: async () => { throw new Error("token backend down"); },
      gitRunner: () => { throw new Error("git must not run"); },
    });
    expect(await refresh({ ...baseInput, repoRoot: gitRepoRoot() }))
      .toEqual({ status: "failed", code: "github_repository_base_refresh_token_unavailable" });
  });

  it("rejects a malformed installation id before minting a token", async () => {
    const refresh = createRepositoryBaseRefresher(REAL_ENV, {
      mintToken: async () => { throw new Error("must not mint"); },
      gitRunner: () => { throw new Error("git must not run"); },
    });
    expect(await refresh({ ...baseInput, repoRoot: gitRepoRoot(), installationId: null }))
      .toEqual({ status: "failed", code: "github_repository_base_refresh_installation_invalid" });
  });
});
