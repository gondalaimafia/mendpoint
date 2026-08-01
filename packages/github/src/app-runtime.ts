/**
 * Production GitHub App runtime — JWT + installation tokens + multi-repo delivery.
 * Works with real credentials when set; unit-tested via injectable signers.
 */
import { createSign, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import type { FileEdit, GitHubDelivery, PullRequestResult } from "./index.js";

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
  return Boolean(env.GITHUB_APP_ID && (env.GITHUB_APP_PRIVATE_KEY || env.GITHUB_APP_PRIVATE_KEY_PATH));
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
  if (!appId) return null;
  let pem = env.GITHUB_APP_PRIVATE_KEY;
  if (!pem && env.GITHUB_APP_PRIVATE_KEY_PATH) {
    try {
      pem = readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
    } catch {
      return null;
    }
  }
  if (!pem) return null;
  return { appId, privateKeyPem: pem.replace(/\\n/g, "\n") };
}

export type TokenFetcher = (
  installationId: number,
  jwt: string,
) => Promise<InstallationToken>;

export async function defaultFetchInstallationToken(
  installationId: number,
  jwt: string,
): Promise<InstallationToken> {
  const octokit = new Octokit({ auth: jwt });
  const { data } = await octokit.request(
    "POST /app/installations/{installation_id}/access_tokens",
    { installation_id: installationId },
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

export class GitHubAppDelivery implements GitHubDelivery {
  private tokenCache = new Map<string, { token: string; expires: number }>();
  private readonly existingBranches = new Set<string>();

  constructor(
    private creds: AppCredentials,
    private installationId: number,
    private fetchToken: TokenFetcher = defaultFetchInstallationToken,
  ) {}

  private async octokit(): Promise<Octokit> {
    const key = String(this.installationId);
    const cached = this.tokenCache.get(key);
    if (cached && cached.expires > Date.now() + 60_000) {
      return new Octokit({ auth: cached.token, userAgent: "mendpoint-app" });
    }
    const jwt = createAppJwt(this.creds.appId, this.creds.privateKeyPem);
    const tok = await this.fetchToken(this.installationId, jwt);
    this.tokenCache.set(key, {
      token: tok.token,
      expires: Date.parse(tok.expiresAt) || Date.now() + 50 * 60_000,
    });
    return new Octokit({ auth: tok.token, userAgent: "mendpoint-app" });
  }

  private async branchMatchesFiles(
    octokit: Octokit,
    owner: string,
    repo: string,
    branch: string,
    files: FileEdit[],
  ): Promise<boolean> {
    try {
      const matches = await Promise.all(
        files.map(async (file) => {
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
        }),
      );
      return matches.every(Boolean);
    } catch {
      return false;
    }
  }

  async createBranch(
    owner: string,
    repo: string,
    branch: string,
    fromBranch = "main",
  ): Promise<void> {
    const o = await this.octokit();
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
    if (!files.length) return;
    const o = await this.octokit();
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
    const tree = await Promise.all(
      files.map(async (f) => {
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
      }),
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
    const o = await this.octokit();
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
    } catch {
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
): GitHubAppDelivery {
  const c = creds ?? loadAppCredentials();
  if (!c) throw new Error("GitHub App credentials missing (GITHUB_APP_ID + PRIVATE_KEY)");
  return new GitHubAppDelivery(c, installationId);
}
