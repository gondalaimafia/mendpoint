/**
 * Production GitHub App runtime for JWT, installation tokens, and multi repository delivery.
 * Works with real credentials when set; unit-tested via injectable signers.
 */
import { createSign, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import type { FileEdit, GitHubDelivery, PullRequestResult } from "./index.js";
import {
  deliverExactDraftWithOctokit,
  type ExactDraftDeliveryInput,
  type ExactDraftDeliveryResult,
} from "./exact-draft.js";
import {
  observeExactDraftWithOctokit,
  type ExactDraftObservation,
  type ExactDraftObservationInput,
} from "./exact-draft-observer.js";
import {
  updateExactDraftWithOctokit,
  reconcileExactDraftUpdateWithOctokit,
  type ExactDraftUpdateInput,
  type ExactDraftUpdateReconciliation,
  type ExactDraftUpdateResult,
} from "./exact-draft-update.js";

const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
const GITHUB_FILE_CONCURRENCY = 8;

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await work(values[index]!);
      }
    }),
  );
  return results;
}

function octokitFor(auth: string, userAgent?: string): Octokit {
  return new Octokit({
    auth,
    userAgent,
    request: { timeout: GITHUB_REQUEST_TIMEOUT_MS },
  });
}

export type AppCredentials = {
  appId: string;
  /** PEM private key (PKCS#1 or PKCS#8) */
  privateKeyPem: string;
  /** Optional client id for newer apps */
  clientId?: string;
};

export type InstallationToken = {
  token: string;
  expiresAt: string;
  installationId: number;
  repositories?: Array<{ owner: string; name: string }>;
};

export function hasGitHubAppCredentials(
  env = process.env,
): boolean {
  return Boolean(
    env.GITHUB_APP_ID &&
    /^[1-9][0-9]*$/.test(env.GITHUB_APP_ID) &&
    (env.GITHUB_APP_PRIVATE_KEY || env.GITHUB_APP_PRIVATE_KEY_PATH),
  );
}

function isAuthenticationError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  const message = error instanceof Error ? error.message : String(error);
  return (
    status === 401 ||
    /bad credentials|requires authentication|token expired/i.test(message)
  );
}

function isNotFoundError(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 404;
}

/** Create RS256 JWT for GitHub App authentication (10 min max). */
export function createAppJwt(
  appId: string,
  privateKeyPem: string,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSec - 60,
    exp: nowSec + 9 * 60,
    iss: appId,
  };
  const enc = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const data = `${enc(header)}.${enc(payload)}`;
  const key = createPrivateKey(privateKeyPem.replace(/\\n/g, "\n"));
  const sign = createSign("RSA-SHA256");
  sign.update(data);
  sign.end();
  const sig = sign.sign(key).toString("base64url");
  return `${data}.${sig}`;
}

export function loadAppCredentials(env = process.env): AppCredentials | null {
  const appId = env.GITHUB_APP_ID;
  if (!appId || !/^[1-9][0-9]*$/.test(appId)) return null;
  let pem = env.GITHUB_APP_PRIVATE_KEY;
  if (!pem && env.GITHUB_APP_PRIVATE_KEY_PATH) {
    try {
      pem = readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
    } catch {
      return null;
    }
  }
  if (!pem) return null;
  const privateKeyPem = pem.replace(/\\n/g, "\n");
  try {
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== "rsa") return null;
    const modulusLength = key.asymmetricKeyDetails?.modulusLength;
    if (typeof modulusLength === "number" && modulusLength < 2048) return null;
  } catch {
    return null;
  }
  return { appId, privateKeyPem };
}

export type TokenFetcher = (
  installationId: number,
  jwt: string,
  repositoryIds?: number[],
) => Promise<InstallationToken>;

export class InstallationTokenCache {
  private cached: { token: string; expires: number } | null = null;
  private refresh: Promise<string> | null = null;

  constructor(
    private readonly credentials: AppCredentials,
    private readonly installationId: number,
    private readonly fetchToken: TokenFetcher = defaultFetchInstallationToken,
    private readonly now: () => number = Date.now,
    private readonly repositoryIds?: number[],
  ) {}

  async get(): Promise<string> {
    if (this.cached && this.cached.expires > this.now() + 60_000) {
      return this.cached.token;
    }
    if (this.refresh) return this.refresh;
    this.refresh = (async () => {
      const jwt = createAppJwt(
        this.credentials.appId,
        this.credentials.privateKeyPem,
        Math.floor(this.now() / 1_000),
      );
      const token = await this.fetchToken(
        this.installationId,
        jwt,
        this.repositoryIds,
      );
      const expires = Date.parse(token.expiresAt);
      if (token.installationId !== this.installationId) {
        throw new Error("github_app_token_installation_mismatch");
      }
      if (!token.token.trim() || !Number.isFinite(expires) || expires <= this.now() + 60_000) {
        throw new Error("github_app_token_invalid_or_expired");
      }
      this.cached = { token: token.token, expires };
      return token.token;
    })();
    try {
      return await this.refresh;
    } finally {
      this.refresh = null;
    }
  }

  clear(): void {
    this.cached = null;
  }
}

export async function defaultFetchInstallationToken(
  installationId: number,
  jwt: string,
  repositoryIds?: number[],
): Promise<InstallationToken> {
  const octokit = octokitFor(jwt);
  const { data } = await octokit.request(
    "POST /app/installations/{installation_id}/access_tokens",
    {
      installation_id: installationId,
      ...(repositoryIds?.length ? { repository_ids: repositoryIds } : {}),
    },
  );
  return {
    token: data.token,
    expiresAt: data.expires_at,
    installationId,
    repositories: (data.repositories ?? []).map((r: { owner?: { login?: string }; name?: string }) => ({
      owner: r.owner?.login ?? "",
      name: r.name ?? "",
    })),
  };
}

export type InstallationAccount = Readonly<{
  installationId: number;
  /** GitHub's numeric account id, or null when the installation reports none. */
  accountId: number | null;
  accountLogin: string | null;
  accountType: string | null;
}>;

export type InstallationMetadataFetcher = (
  installationId: number,
  jwt: string,
) => Promise<InstallationAccount>;

/**
 * Read an installation's authoritative account identity as the App. Authenticates
 * with the App JWT (not an installation token), exactly like the access-token
 * exchange above, so it makes no assumption about the very identity it observes.
 * The response's `account.id` is the verified value; a missing account yields
 * nulls rather than a fabricated id.
 */
export async function defaultFetchInstallationMetadata(
  installationId: number,
  jwt: string,
): Promise<InstallationAccount> {
  const octokit = octokitFor(jwt);
  const { data } = await octokit.request(
    "GET /app/installations/{installation_id}",
    { installation_id: installationId },
  );
  const account =
    (data as { account?: { id?: number; login?: string; type?: string } | null })
      .account ?? null;
  const accountId =
    account && Number.isSafeInteger(account.id) ? Number(account.id) : null;
  return {
    installationId,
    accountId,
    accountLogin: account?.login ?? null,
    accountType: account?.type ?? null,
  };
}

export type InstallationRepository = Readonly<{
  id: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  disabled: boolean;
}>;

export type InstallationRepositoryLister = (
  token: string,
) => Promise<InstallationRepository[]>;

type RawInstallationRepository = {
  id?: number;
  name?: string;
  full_name?: string;
  private?: boolean;
  archived?: boolean;
  disabled?: boolean;
  default_branch?: string;
  owner?: { login?: string } | null;
};

function normalizeInstallationRepository(
  repo: RawInstallationRepository,
): InstallationRepository {
  const owner = repo.owner?.login ?? "";
  const name = repo.name ?? "";
  return Object.freeze({
    id: Number(repo.id ?? 0),
    owner,
    name,
    fullName: repo.full_name ?? `${owner}/${name}`,
    defaultBranch: repo.default_branch ?? "main",
    private: Boolean(repo.private),
    archived: Boolean(repo.archived),
    disabled: Boolean(repo.disabled),
  });
}

/** Real listing of an installation's accessible repositories (App/Octokit). */
export async function defaultListInstallationRepositories(
  token: string,
): Promise<InstallationRepository[]> {
  const octokit = octokitFor(token, "mendpoint-app");
  const repos = (await octokit.paginate("GET /installation/repositories", {
    per_page: 100,
  })) as RawInstallationRepository[];
  return repos.map(normalizeInstallationRepository);
}

export type MockInstallationRepositoryInput = Readonly<{
  owner?: string;
  name: string;
  archived?: boolean;
  disabled?: boolean;
  private?: boolean;
  defaultBranch?: string;
  id?: number;
}>;

/** Deterministic installation repository listing for GITHUB_MODE=mock. */
export function mockInstallationRepositories(
  input: Readonly<{
    installationId: number | string;
    accountLogin: string;
    repositories?: readonly MockInstallationRepositoryInput[];
  }>,
): InstallationRepository[] {
  const base = Number(input.installationId) || 0;
  const repos = input.repositories ?? [{ name: "shop-app" }];
  return repos.map((repo, index) => {
    const owner = repo.owner ?? input.accountLogin;
    return normalizeInstallationRepository({
      id: repo.id ?? base * 1000 + index + 1,
      owner: { login: owner },
      name: repo.name,
      full_name: `${owner}/${repo.name}`,
      private: repo.private ?? true,
      archived: repo.archived ?? false,
      disabled: repo.disabled ?? false,
      default_branch: repo.defaultBranch ?? "main",
    });
  });
}

/**
 * List an installation's accessible repositories. Uses the App/Octokit client
 * with real credentials when GITHUB_MODE=real; otherwise returns a deterministic
 * mock so org enrollment works without real GitHub credentials. Reuses the
 * existing installation token cache; auth is not rebuilt here.
 */
export async function listInstallationRepositories(
  input: Readonly<{
    installationId: number;
    accountLogin: string;
    env?: NodeJS.ProcessEnv;
    credentials?: AppCredentials | null;
    fetchToken?: TokenFetcher;
    lister?: InstallationRepositoryLister;
    mockRepositories?: readonly MockInstallationRepositoryInput[];
    now?: () => number;
  }>,
): Promise<InstallationRepository[]> {
  const env = input.env ?? process.env;
  if ((env.GITHUB_MODE ?? "mock") !== "real") {
    return mockInstallationRepositories({
      installationId: input.installationId,
      accountLogin: input.accountLogin,
      repositories: input.mockRepositories,
    });
  }
  if (!Number.isSafeInteger(input.installationId) || input.installationId < 1) {
    throw new Error("github_installation_id_invalid");
  }
  const credentials = input.credentials ?? loadAppCredentials(env);
  if (!credentials) throw new Error("github_app_credentials_missing");
  const cache = new InstallationTokenCache(
    credentials,
    input.installationId,
    input.fetchToken ?? defaultFetchInstallationToken,
    input.now ?? Date.now,
  );
  const token = await cache.get();
  const lister = input.lister ?? defaultListInstallationRepositories;
  return lister(token);
}

export class GitHubAppDelivery implements GitHubDelivery {
  private readonly tokenCache: InstallationTokenCache;
  private readonly existingBranches = new Set<string>();

  constructor(
    private creds: AppCredentials,
    private installationId: number,
    private fetchToken: TokenFetcher = defaultFetchInstallationToken,
    private repositoryIds?: number[],
  ) {
    this.tokenCache = new InstallationTokenCache(
      this.creds,
      this.installationId,
      this.fetchToken,
      Date.now,
      this.repositoryIds,
    );
  }

  private async octokit(): Promise<Octokit> {
    return octokitFor(await this.tokenCache.get(), "mendpoint-app");
  }

  private async withAuthRetry<T>(work: (octokit: Octokit) => Promise<T>): Promise<T> {
    try {
      return await work(await this.octokit());
    } catch (error) {
      if (!isAuthenticationError(error)) throw error;
      this.tokenCache.clear();
      return work(await this.octokit());
    }
  }

  deliverExactDraft(input: ExactDraftDeliveryInput): Promise<ExactDraftDeliveryResult> {
    return this.withAuthRetry((octokit) => deliverExactDraftWithOctokit(octokit, input));
  }

  observeExactDraft(input: ExactDraftObservationInput): Promise<ExactDraftObservation> {
    return this.withAuthRetry((octokit) => observeExactDraftWithOctokit(octokit, input));
  }

  updateExactDraft(input: ExactDraftUpdateInput): Promise<ExactDraftUpdateResult> {
    return this.withAuthRetry((octokit) => updateExactDraftWithOctokit(octokit, input));
  }

  reconcileExactDraftUpdate(input: ExactDraftUpdateInput): Promise<ExactDraftUpdateReconciliation> {
    return this.withAuthRetry((octokit) => reconcileExactDraftUpdateWithOctokit(octokit, input));
  }

  private async branchMatchesFiles(
    octokit: Octokit,
    owner: string,
    repo: string,
    branch: string,
    files: FileEdit[],
  ): Promise<boolean> {
    try {
      const matches = await mapWithConcurrency(
        files,
        GITHUB_FILE_CONCURRENCY,
        async (file) => {
          if ("delete" in file) {
            try {
              await octokit.repos.getContent({
                owner,
                repo,
                path: file.path.replace(/\\/g, "/"),
                ref: branch,
              });
              return false;
            } catch (error) {
              if (isAuthenticationError(error)) throw error;
              if (isNotFoundError(error)) return true;
              throw error;
            }
          }
          const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: file.path.replace(/\\/g, "/"),
            ref: branch,
          });
          if (Array.isArray(data) || !("content" in data) || typeof data.content !== "string") {
            return false;
          }
          return Buffer.from(data.content, "base64").toString("utf8") === file.content;
        },
      );
      return matches.every(Boolean);
    } catch (error) {
      if (isAuthenticationError(error)) throw error;
      return false;
    }
  }

  async createBranch(
    owner: string,
    repo: string,
    branch: string,
    fromBranch = "main",
  ): Promise<void> {
    return this.withAuthRetry((octokit) =>
      this.createBranchWithOctokit(octokit, owner, repo, branch, fromBranch),
    );
  }

  private async createBranchWithOctokit(
    o: Octokit,
    owner: string,
    repo: string,
    branch: string,
    fromBranch: string,
  ): Promise<void> {
    let baseSha: string;
    try {
      const { data } = await o.git.getRef({ owner, repo, ref: `heads/${fromBranch}` });
      baseSha = data.object.sha;
    } catch {
      const { data } = await o.git.getRef({ owner, repo, ref: "heads/master" });
      baseSha = data.object.sha;
    }
    try {
      await o.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/already exists/i.test(msg)) {
        this.existingBranches.add(`${owner}/${repo}:${branch}`);
        return;
      }
      throw e;
    }
  }

  async commitFiles(
    owner: string,
    repo: string,
    branch: string,
    message: string,
    files: FileEdit[],
  ): Promise<void> {
    return this.withAuthRetry((octokit) =>
      this.commitFilesWithOctokit(octokit, owner, repo, branch, message, files),
    );
  }

  private async commitFilesWithOctokit(
    o: Octokit,
    owner: string,
    repo: string,
    branch: string,
    message: string,
    files: FileEdit[],
  ): Promise<void> {
    if (!files.length) return;
    const branchKey = `${owner}/${repo}:${branch}`;
    if (this.existingBranches.has(branchKey)) {
      if (await this.branchMatchesFiles(o, owner, repo, branch, files)) return;
      throw new Error(
        "Recovery branch content differs from the intended patch; human reconciliation required",
      );
    }
    const { data: ref } = await o.git.getRef({ owner, repo, ref: `heads/${branch}` });
    const branchSha = ref.object.sha;
    const { data: baseCommit } = await o.git.getCommit({ owner, repo, commit_sha: branchSha });
    const tree = await mapWithConcurrency(
      files,
      GITHUB_FILE_CONCURRENCY,
      async (f) => {
        if ("delete" in f) {
          return {
            path: f.path.replace(/\\/g, "/"),
            mode: "100644" as const,
            type: "blob" as const,
            sha: null,
          };
        }
        const { data: blob } = await o.git.createBlob({
          owner,
          repo,
          content: Buffer.from(f.content, "utf8").toString("base64"),
          encoding: "base64",
        });
        return {
          path: f.path.replace(/\\/g, "/"),
          mode: "100644" as const,
          type: "blob" as const,
          sha: blob.sha,
        };
      },
    );
    const { data: newTree } = await o.git.createTree({
      owner,
      repo,
      base_tree: baseCommit.tree.sha,
      tree,
    });
    const { data: newCommit } = await o.git.createCommit({
      owner,
      repo,
      message,
      tree: newTree.sha,
      parents: [branchSha],
    });
    await o.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: newCommit.sha });
  }

  async openPullRequest(
    owner: string,
    repo: string,
    branch: string,
    title: string,
    body: string,
    base = "main",
  ): Promise<PullRequestResult> {
    return this.withAuthRetry((octokit) =>
      this.openPullRequestWithOctokit(
        octokit,
        owner,
        repo,
        branch,
        title,
        body,
        base,
      ),
    );
  }

  private async openPullRequestWithOctokit(
    o: Octokit,
    owner: string,
    repo: string,
    branch: string,
    title: string,
    body: string,
    base: string,
  ): Promise<PullRequestResult> {
    const { data: existing } = await o.pulls.list({
      owner,
      repo,
      state: "open",
      head: `${owner}:${branch}`,
    });
    if (existing[0]) {
      return {
        number: existing[0].number,
        url: existing[0].html_url,
        branch,
        title: existing[0].title,
      };
    }
    try {
      const { data } = await o.pulls.create({
        owner,
        repo,
        title,
        head: branch,
        base,
        body,
        draft: true,
      });
      return { number: data.number, url: data.html_url, branch, title: data.title };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/base.*(?:invalid|not found|does not exist)/i.test(message)) throw error;
      const { data } = await o.pulls.create({
        owner,
        repo,
        title,
        head: branch,
        base: "master",
        body,
        draft: true,
      });
      return { number: data.number, url: data.html_url, branch, title: data.title };
    }
  }
}

/** Multi-repo fan-out using one installation. */
export async function deliverToManyRepos(
  delivery: GitHubDelivery,
  repos: Array<{ owner: string; name: string }>,
  work: {
    branch: string;
    title: string;
    body: string;
    files: FileEdit[];
    message: string;
    base?: string;
  },
): Promise<Array<{ owner: string; repo: string; pr?: PullRequestResult; error?: string }>> {
  const out: Array<{ owner: string; repo: string; pr?: PullRequestResult; error?: string }> = [];
  for (const r of repos) {
    try {
      await delivery.createBranch(r.owner, r.name, work.branch, work.base);
      await delivery.commitFiles(r.owner, r.name, work.branch, work.message, work.files);
      const pr = await delivery.openPullRequest(
        r.owner,
        r.name,
        work.branch,
        work.title,
        work.body,
        work.base,
      );
      out.push({ owner: r.owner, repo: r.name, pr });
    } catch (e) {
      out.push({
        owner: r.owner,
        repo: r.name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

export function createAppDelivery(
  installationId: number,
  creds?: AppCredentials | null,
  repositoryIds?: number[],
): GitHubAppDelivery {
  const c = creds ?? loadAppCredentials();
  if (!c) throw new Error("GitHub App credentials missing (GITHUB_APP_ID + PRIVATE_KEY)");
  return new GitHubAppDelivery(c, installationId, defaultFetchInstallationToken, repositoryIds);
}
