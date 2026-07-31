import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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

  private containedPathFrom(baseDir: string, ...segments: string[]) {
    const root = resolve(this.rootDir);
    const base = resolve(baseDir);
    const baseRel = relative(root, base);
    if (baseRel.startsWith("..") || isAbsolute(baseRel)) {
      throw new Error("Mock GitHub base path escapes its root");
    }
    const candidate = resolve(base, ...segments);
    const childRel = relative(base, candidate);
    if (childRel.startsWith("..") || isAbsolute(childRel)) {
      throw new Error("Mock GitHub path escapes its root");
    }
    const rel = relative(root, candidate);
    let cursor = root;
    for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
      cursor = join(cursor, segment);
      try {
        if (lstatSync(cursor).isSymbolicLink()) {
          throw new Error("Mock GitHub path contains a symbolic link");
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Mock GitHub path contains a symbolic link"
        ) {
          throw error;
        }
        break;
      }
    }
    return candidate;
  }

  private containedPath(...segments: string[]) {
    return this.containedPathFrom(resolve(this.rootDir), ...segments);
  }

  private branchDir(owner: string, repo: string, branch: string) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) ||
      branch.includes("..") ||
      branch.includes("//") ||
      branch.endsWith("/") ||
      branch.endsWith(".lock")
    ) {
      throw new Error("Invalid GitHub branch name");
    }
    return this.containedPathFrom(this.repoDir(owner, repo), "branches", branch);
  }

  private repoDir(owner: string, repo: string) {
    if (
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo) ||
      repo === "." ||
      repo === ".."
    ) {
      throw new Error("Invalid GitHub owner or repository name");
    }
    return this.containedPath(owner, repo);
  }

  async createBranch(owner: string, repo: string, branch: string): Promise<void> {
    const dir = this.branchDir(owner, repo, branch);
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
    const dir = this.branchDir(owner, repo, branch);
    mkdirSync(dir, { recursive: true });
    for (const f of files) {
      const target = this.containedPathFrom(dir, f.path);
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
    this.branchDir(owner, repo, branch);
    const prsDir = this.containedPath(
      relative(resolve(this.rootDir), this.repoDir(owner, repo)),
      "pulls",
    );
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
  private readonly existingBranches = new Set<string>();

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

  private async branchMatchesFiles(
    owner: string,
    repo: string,
    branch: string,
    files: FileEdit[],
  ): Promise<boolean> {
    try {
      const matches = await Promise.all(
        files.map(async (file) => {
          const { data } = await this.octokit.repos.getContent({
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
      // A prior attempt may already own this deterministic branch. Preserve its
      // current head so recovery never overwrites customer or reviewer work.
      if (/Reference already exists/i.test(msg)) {
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
    const branchKey = `${owner}/${repo}:${branch}`;
    if (this.existingBranches.has(branchKey)) {
      if (await this.branchMatchesFiles(owner, repo, branch, files)) return;
      throw new Error(
        "Recovery branch content differs from the intended patch; human reconciliation required",
      );
    }

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
