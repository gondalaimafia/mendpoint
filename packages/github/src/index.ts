import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { Octokit } from "@octokit/rest";
import { newId } from "@mendpoint/shared";

export type PullRequestResult = {
  number: number;
  url: string;
  branch: string;
  title: string;
};

export type FileEdit = { path: string; content: string };

export interface GitHubDelivery {
  createBranch(owner: string, repo: string, branch: string, fromBranch?: string): Promise<void>;
  commitFiles(
    owner: string,
    repo: string,
    branch: string,
    message: string,
    files: FileEdit[],
  ): Promise<void>;
  openPullRequest(
    owner: string,
    repo: string,
    branch: string,
    title: string,
    body: string,
    base?: string,
  ): Promise<PullRequestResult>;
}

export class MockGitHubDelivery implements GitHubDelivery {
  constructor(private rootDir = join(process.cwd(), ".mendpoint/mock-github")) {}

  private repoDir(owner: string, repo: string) {
    return join(this.rootDir, owner, repo);
  }

  async createBranch(owner: string, repo: string, branch: string): Promise<void> {
    const dir = join(this.repoDir(owner, repo), "branches", branch);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".branch"), branch, "utf8");
  }

  async commitFiles(
    owner: string,
    repo: string,
    branch: string,
    message: string,
    files: FileEdit[],
  ): Promise<void> {
    const dir = join(this.repoDir(owner, repo), "branches", branch);
    mkdirSync(dir, { recursive: true });
    for (const f of files) {
      const target = join(dir, f.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content, "utf8");
    }
    writeFileSync(join(dir, "COMMIT_MSG"), message, "utf8");
  }

  async openPullRequest(
    owner: string,
    repo: string,
    branch: string,
    title: string,
    body: string,
    base = "main",
  ): Promise<PullRequestResult> {
    const prsDir = join(this.repoDir(owner, repo), "pulls");
    mkdirSync(prsDir, { recursive: true });
    const counterFile = join(prsDir, "_counter");
    let n = 1;
    if (existsSync(counterFile)) {
      n = Number(readFileSync(counterFile, "utf8")) + 1;
    }
    writeFileSync(counterFile, String(n), "utf8");
    const pr = {
      number: n,
      url: `https://github.com/${owner}/${repo}/pull/${n}`,
      branch,
      title,
      body,
      base,
      draft: true,
      id: newId(),
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(prsDir, `${n}.json`), JSON.stringify(pr, null, 2), "utf8");
    return { number: pr.number, url: pr.url, branch, title };
  }
}

/**
 * Real GitHub delivery via PAT / gh token + Octokit.
 * Creates branch from default base, commits files via Git Data API, opens PR.
 * Never force-pushes; never targets protected branch directly for content (PR only).
 */
export class OctokitGitHubDelivery implements GitHubDelivery {
  private octokit: Octokit;

  constructor(token?: string) {
    const t = token ?? process.env.GITHUB_TOKEN;
    if (!t) {
      throw new Error(
        "GITHUB_MODE=real requires GITHUB_TOKEN (or pass a token). Use `gh auth token` or a classic PAT with `repo` scope.",
      );
    }
    this.octokit = new Octokit({ auth: t, userAgent: "mendpoint-api" });
  }

  private async refSha(owner: string, repo: string, ref: string): Promise<string> {
    const { data } = await this.octokit.git.getRef({
      owner,
      repo,
      ref: ref.startsWith("heads/") ? ref : `heads/${ref}`,
    });
    return data.object.sha;
  }

  async createBranch(
    owner: string,
    repo: string,
    branch: string,
    fromBranch = "main",
  ): Promise<void> {
    let baseSha: string;
    try {
      baseSha = await this.refSha(owner, repo, fromBranch);
    } catch {
      // fallback to master
      baseSha = await this.refSha(owner, repo, "master");
    }

    try {
      await this.octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: baseSha,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Branch may already exist — update is ok for idempotent re-runs on same name
      if (/Reference already exists/i.test(msg)) {
        await this.octokit.git.updateRef({
          owner,
          repo,
          ref: `heads/${branch}`,
          sha: baseSha,
          force: true,
        });
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

    const branchSha = await this.refSha(owner, repo, branch);
    const { data: baseCommit } = await this.octokit.git.getCommit({
      owner,
      repo,
      commit_sha: branchSha,
    });
    const baseTree = baseCommit.tree.sha;

    const tree = await Promise.all(
      files.map(async (f) => {
        const { data: blob } = await this.octokit.git.createBlob({
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

    const { data: newTree } = await this.octokit.git.createTree({
      owner,
      repo,
      base_tree: baseTree,
      tree,
    });

    const { data: newCommit } = await this.octokit.git.createCommit({
      owner,
      repo,
      message,
      tree: newTree.sha,
      parents: [branchSha],
    });

    await this.octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommit.sha,
    });
  }

  async openPullRequest(
    owner: string,
    repo: string,
    branch: string,
    title: string,
    body: string,
    base = "main",
  ): Promise<PullRequestResult> {
    // Prefer existing open PR for same head to avoid duplicates on re-run
    const head = `${owner}:${branch}`;
    const { data: existing } = await this.octokit.pulls.list({
      owner,
      repo,
      state: "open",
      head,
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
      const { data } = await this.octokit.pulls.create({
        owner,
        repo,
        title,
        head: branch,
        base,
        body,
        draft: true,
      });
      return {
        number: data.number,
        url: data.html_url,
        branch,
        title: data.title,
      };
    } catch (e: unknown) {
      // base might be master
      if (base === "main") {
        const { data } = await this.octokit.pulls.create({
          owner,
          repo,
          title,
          head: branch,
          base: "master",
          body,
          draft: true,
        });
        return {
          number: data.number,
          url: data.html_url,
          branch,
          title: data.title,
        };
      }
      throw e;
    }
  }
}

export async function resolveGitHubToken(): Promise<string | undefined> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const { execSync } = await import("node:child_process");
    const t = execSync("gh auth token", { encoding: "utf8" }).trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

export async function createGitHubDeliveryAsync(
  mode = process.env.GITHUB_MODE ?? "mock",
): Promise<GitHubDelivery> {
  if (mode === "real") {
    const token = await resolveGitHubToken();
    return new OctokitGitHubDelivery(token);
  }
  return new MockGitHubDelivery();
}

export function createGitHubDelivery(mode = process.env.GITHUB_MODE ?? "mock"): GitHubDelivery {
  if (mode === "real") {
    // Sync path: env only (use createGitHubDeliveryAsync for gh auth token)
    return new OctokitGitHubDelivery(process.env.GITHUB_TOKEN);
  }
  return new MockGitHubDelivery();
}

export {
  parseWebhookHeaders,
  verifyGitHubSignature,
  normalizeGitHubEvent,
  prFeedbackFromWebhook,
  type GitHubWebhookHeaders,
  type NormalizedWebhookAction,
} from "./webhooks.js";

export {
  formatCiCheckComment,
  postCiCheck,
  MockPrCommenter,
  OctokitPrCommenter,
  maybeCommentCiOnPr,
  type CiCheckInput,
  type PrCommenter,
} from "./checks.js";

export {
  getGitHubAppConfig,
  buildInstallUrl,
  normalizeMockInstall,
  type GitHubAppConfig,
  type MockInstallInput,
} from "./app-install.js";

export {
  createAppJwt,
  loadAppCredentials,
  hasGitHubAppCredentials,
  GitHubAppDelivery,
  deliverToManyRepos,
  createAppDelivery,
  type AppCredentials,
  type InstallationToken,
} from "./app-runtime.js";
