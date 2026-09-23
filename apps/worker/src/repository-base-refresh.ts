import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  InstallationTokenCache,
  loadAppCredentials,
  type AppCredentials,
} from "@mendpoint/github";
import type {
  RepositoryBaseRefresher,
  RepositoryBaseRefreshResult,
} from "@mendpoint/pipeline";

const REFRESH_TIMEOUT_MS = 30_000;
const SHA = /^[a-f0-9]{40}$/;
const INSTALLATION_ID = /^[1-9][0-9]*$/;

/** Run one git command, returning stdout. Injectable so tests never touch git or the network. */
export type RepositoryGitRunner = (
  input: Readonly<{ repoRoot: string; args: readonly string[]; env: Readonly<Record<string, string>> }>,
) => string;

const defaultGitRunner: RepositoryGitRunner = (input) =>
  execFileSync("git", ["-C", input.repoRoot, ...input.args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: REFRESH_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...input.env },
  }).trim();

/**
 * Worker-side implementation of the pipeline's repository base refresh seam.
 *
 * It updates a git-backed clone's default branch to the current remote head
 * before draft generation, using the same GitHub App installation credentials
 * the worker already uses for delivery (no new secret). The token is passed via
 * `http.extraHeader` (never in a URL that could be logged), the git command is
 * bounded, and a failure returns a named retryable code — never the raw git
 * error, never the token, and never a silent fallback to the stale base.
 */
export function createRepositoryBaseRefresher(
  env: NodeJS.ProcessEnv = process.env,
  options: Readonly<{
    gitRunner?: RepositoryGitRunner;
    mintToken?: (credentials: AppCredentials, installationId: number) => Promise<string>;
  }> = {},
): RepositoryBaseRefresher {
  const gitRunner = options.gitRunner ?? defaultGitRunner;
  const mintToken =
    options.mintToken ??
    ((credentials: AppCredentials, installationId: number) =>
      new InstallationTokenCache(credentials, installationId).get());

  return async (input): Promise<RepositoryBaseRefreshResult> => {
    // Only real GitHub App mode fetches; mock/dev delivery keeps its own base.
    if (env.GITHUB_MODE !== "real") return { status: "not_applicable" };
    // No git history: the content-manifest delivery path handles these.
    if (!existsSync(join(input.repoRoot, ".git"))) return { status: "not_applicable" };
    const credentials = loadAppCredentials(env);
    if (!credentials) {
      return { status: "failed", code: "github_repository_base_refresh_credentials_missing" };
    }
    if (input.installationId === null || !INSTALLATION_ID.test(input.installationId)) {
      return { status: "failed", code: "github_repository_base_refresh_installation_invalid" };
    }

    let token: string;
    try {
      token = await mintToken(credentials, Number(input.installationId));
    } catch {
      return { status: "failed", code: "github_repository_base_refresh_token_unavailable" };
    }

    const encodedCredential = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
    const gitEnv = Object.freeze({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${encodedCredential}`,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    });

    try {
      // Read-only fetch of the remote default branch; the token rides in the
      // extra header, never on the command line. The clone is never pushed.
      gitRunner({ repoRoot: input.repoRoot, args: ["fetch", "--depth", "1", "origin", input.defaultBranch], env: gitEnv });
      gitRunner({ repoRoot: input.repoRoot, args: ["checkout", "-B", input.defaultBranch, "FETCH_HEAD"], env: gitEnv });
      const head = gitRunner({ repoRoot: input.repoRoot, args: ["rev-parse", "HEAD"], env: {} }).toLowerCase();
      if (!SHA.test(head)) {
        return { status: "failed", code: "github_repository_base_refresh_head_invalid" };
      }
      return { status: "refreshed", headSha: head };
    } catch {
      // Deliberately drop the raw git error: it could echo the credential. The
      // named code is retryable and safe to log/audit.
      return { status: "failed", code: "github_repository_base_refresh_fetch_failed" };
    }
  };
}
