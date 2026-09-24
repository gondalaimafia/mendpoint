import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  InstallationTokenCache,
  loadAppCredentials,
  type AppCredentials,
} from "./app-runtime.js";

const execFileAsync = promisify(execFile);

const REFRESH_TIMEOUT_MS = 30_000;
const SHA = /^[a-f0-9]{40}$/;
const INSTALLATION_ID = /^[1-9][0-9]*$/;
// A branch that cannot be read as a git option (no leading "-" or "/") and is
// restricted to the safe ref charset, so a value like "--upload-pack=..." can
// never be smuggled into a git argument vector.
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

export type RepositoryBaseRefreshResult =
  | Readonly<{ status: "refreshed"; headSha: string }>
  | Readonly<{ status: "not_applicable" }>
  | Readonly<{ status: "failed"; code: string }>;

export type RepositoryBaseRefreshInput = Readonly<{
  tenantId: string;
  repoRoot: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  installationId: string | null;
  /**
   * The resolver-validated remote repository id. When present the installation
   * token is minted scoped to just this repository, matching the delivery path.
   */
  repositoryId?: string | null;
}>;

export type RepositoryBaseRefresher = (
  input: RepositoryBaseRefreshInput,
) => Promise<RepositoryBaseRefreshResult>;

/** Run one git command, returning stdout. Injectable so tests never touch git or the network. */
export type RepositoryGitRunner = (
  input: Readonly<{ repoRoot: string; args: readonly string[]; env: Readonly<Record<string, string>> }>,
) => Promise<string>;

const defaultGitRunner: RepositoryGitRunner = async (input) => {
  const { stdout } = await execFileAsync("git", ["-C", input.repoRoot, ...input.args], {
    windowsHide: true,
    timeout: REFRESH_TIMEOUT_MS,
    env: { ...process.env, ...input.env },
  });
  return stdout.toString().trim();
};

/**
 * Refresh a git-backed clone's default branch to the current remote head before
 * draft generation, using the same GitHub App installation credentials the
 * delivery path uses (no new secret). The token is repository-scoped when the
 * caller passes the resolver-validated repository id, and it rides into git only
 * through the `http.extraHeader` git config passed in the environment
 * (GIT_CONFIG_*), never on the command line or in a URL, so it is not visible in
 * the process argument list. git-credential-manager is disabled, and the branch
 * is validated against option injection. The fetch is not shallow, so it never
 * truncates a full clone's history. A failure returns a named retryable code —
 * never the raw git error, never the token, and never a stale base. Repositories
 * with no git history, no commits, or no origin are not applicable (they deliver
 * through the content-manifest path).
 */
export function createRepositoryBaseRefresher(
  env: NodeJS.ProcessEnv = process.env,
  options: Readonly<{
    gitRunner?: RepositoryGitRunner;
    mintToken?: (credentials: AppCredentials, installationId: number, repositoryIds?: number[]) => Promise<string>;
  }> = {},
): RepositoryBaseRefresher {
  const gitRunner = options.gitRunner ?? defaultGitRunner;
  const mintToken =
    options.mintToken ??
    ((credentials: AppCredentials, installationId: number, repositoryIds?: number[]) =>
      new InstallationTokenCache(
        credentials,
        installationId,
        undefined,
        undefined,
        repositoryIds,
      ).get());

  return async (input): Promise<RepositoryBaseRefreshResult> => {
    // Only real GitHub App mode fetches; mock/dev delivery keeps its own base.
    if (env.GITHUB_MODE !== "real") return { status: "not_applicable" };
    if (!SAFE_BRANCH.test(input.defaultBranch)) {
      return { status: "failed", code: "github_repository_base_refresh_branch_invalid" };
    }
    const credentials = loadAppCredentials(env);
    if (!credentials) {
      return { status: "failed", code: "github_repository_base_refresh_credentials_missing" };
    }
    if (input.installationId === null || !INSTALLATION_ID.test(input.installationId)) {
      return { status: "failed", code: "github_repository_base_refresh_installation_invalid" };
    }

    // Resolve the repository top level so a clone rooted at a subdirectory still
    // works, and use it consistently for every git command. A path with no git
    // history, no commits, or no origin is treated as content-manifest (decision
    // A): not applicable to exact-draft base refresh.
    let repoRoot: string;
    try {
      repoRoot = await gitRunner({ repoRoot: input.repoRoot, args: ["rev-parse", "--show-toplevel"], env: {} });
      if (!repoRoot) return { status: "not_applicable" };
      await gitRunner({ repoRoot, args: ["rev-parse", "--verify", "HEAD"], env: {} });
      await gitRunner({ repoRoot, args: ["remote", "get-url", "origin"], env: {} });
    } catch {
      return { status: "not_applicable" };
    }

    const repositoryIds = input.repositoryId && INSTALLATION_ID.test(input.repositoryId)
      ? [Number(input.repositoryId)]
      : undefined;
    let token: string;
    try {
      token = await mintToken(credentials, Number(input.installationId), repositoryIds);
    } catch {
      return { status: "failed", code: "github_repository_base_refresh_token_unavailable" };
    }

    const encodedCredential = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
    // The credential rides in an http.extraHeader passed through the environment
    // (GIT_CONFIG_*, git >= 2.31), never on the command line — so the base64 token
    // is not visible in the process argument list. credential.helper is emptied
    // (a non-secret) so git-credential-manager is never consulted.
    const authArgs = ["-c", "credential.helper="];
    const gitEnv = Object.freeze({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${encodedCredential}`,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    });

    try {
      // Not shallow: a --depth fetch would truncate a full clone's history that
      // git-temporal analysis reads. "--" terminates option parsing so the
      // branch is always read as a refspec.
      await gitRunner({
        repoRoot,
        args: [...authArgs, "fetch", "origin", "--", input.defaultBranch],
        env: gitEnv,
      });
      await gitRunner({
        repoRoot,
        args: ["checkout", "-B", input.defaultBranch, "FETCH_HEAD"],
        env: {},
      });
      const head = (await gitRunner({ repoRoot, args: ["rev-parse", "HEAD"], env: {} })).toLowerCase();
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
