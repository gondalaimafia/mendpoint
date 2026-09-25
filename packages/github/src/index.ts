import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Octokit } from "@octokit/rest";
import { newId } from "@mendpoint/shared";
import {
  deliverExactDraftWithOctokit,
  validateExactDraftDeliveryInput,
  type ExactDraftDeliveryInput,
  type ExactDraftDeliveryResult,
} from "./exact-draft.js";
import {
  createGitLabDelivery,
  gitlabAsReviewableChangeDelivery,
  type ReviewableChangeDelivery,
  type ScmDeliveryProvider,
} from "./gitlab.js";
import {
  deliverAdoptiveDraftWithOctokit,
  AdoptiveDraftBlockedError,
  type AdoptiveDraftInput,
  type AdoptiveDraftResult,
  type AdoptiveDeliveryOptions,
  type AdoptiveOctokit,
} from "./draft-adoption.js";
import {
  guardGitHubWrites,
  TENANT_IDENTITY_DELIVERY_ERROR,
  assertTenantIdPresent,
} from "./tenant-identity-guard.js";
import { FakeGitHub } from "./testing/fake-github.js";

/** The error a guarded transport throws on a tenant-id leak (#724). Shared by
 * every tenant-scoped client so the pipeline records the named, non-retryable
 * delivery_blocked code and the App outage path classifies it permanent. */
export function tenantIdentityGuardError(): AdoptiveDraftBlockedError {
  return new AdoptiveDraftBlockedError(TENANT_IDENTITY_DELIVERY_ERROR);
}

export type PullRequestResult = {
  number: number;
  url: string;
  branch: string;
  title: string;
};

export type FileEdit = { path: string; content: string } | { path: string; delete: true };

const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
const GITHUB_FILE_CONCURRENCY = 8;

function isNotFoundError(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 404;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await work(values[index]!, index);
      }
    }),
  );
  return results;
}

export interface GitHubDelivery {
  deliverExactDraft(input: ExactDraftDeliveryInput): Promise<ExactDraftDeliveryResult>;
  /**
   * Adoptive draft delivery (PR #606): the branch is the source of truth and
   * identity is (owner, repo, baseBranch, branch), so a delivery is one branch
   * and one ledger operation forever. `body` is supplied by options.resolveBody
   * per attempt. Optional so peripheral transports need not implement it; the
   * App / mock / Octokit transports do.
   */
  deliverAdoptiveDraft?(
    input: Omit<AdoptiveDraftInput, "body">,
    options: AdoptiveDeliveryOptions,
  ): Promise<AdoptiveDraftResult>;
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
  /**
   * Read the LIVE state of a delivered pull request (#724 body refresh): its
   * current body and state as GitHub holds it, so the refresh detects a leak on
   * the real PR and a human edit, not only the stored DB row. Optional so
   * peripheral transports need not implement it; App / PAT / mock do.
   */
  getOpenPullRequest?(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<{ body: string; state: "open" | "closed"; draft: boolean } | undefined>;
}

export class MockGitHubDelivery implements GitHubDelivery {
  constructor(private rootDir = join(process.cwd(), ".mendpoint/mock-github")) {}

  private readonly remoteBranchHeads = new Map<string, string>();
  // Adoptive delivery runs against an in-memory content-addressed fake GitHub so
  // GITHUB_MODE=mock exercises the real adoption state machine (idempotent create,
  // lost-response reconcile, foreign/ambiguous blocks) exactly like the App path.
  private readonly adoptiveFake = new FakeGitHub();

  async deliverAdoptiveDraft(
    input: Omit<AdoptiveDraftInput, "body">,
    options: AdoptiveDeliveryOptions,
  ): Promise<AdoptiveDraftResult> {
    // The pipeline's resolved base sha is a git/content digest, not a fake sha,
    // so register it as a real base commit the adoption machine can build against.
    this.adoptiveFake.registerBase({
      owner: input.owner,
      repo: input.repo,
      branch: input.baseBranch,
      sha: input.expectedBaseSha,
    });
    const result = await deliverAdoptiveDraftWithOctokit(
      this.adoptiveFake as unknown as AdoptiveOctokit,
      { ...input, body: options.resolveBody() },
      options.hooks ?? {},
    );
    // Mirror the delivered PR to the filesystem store so GITHUB_MODE=mock is
    // observable exactly like the pre-#606 deliverExactDraft path (dev/demo and
    // fixture tests read pulls/<n>.json).
    try {
      const repoDir = this.repoDir(input.owner, input.repo);
      const pullsDir = this.containedPathFrom(repoDir, "pulls");
      mkdirSync(pullsDir, { recursive: true });
      writeFileSync(join(pullsDir, `${result.number}.json`), JSON.stringify({
        number: result.number,
        url: result.url,
        state: result.state === "draft" ? "open" : result.state,
        draft: result.draft,
        title: result.title,
        body: result.body,
        branch: input.branch,
        base: input.baseBranch,
        baseSha: result.deliveredBaseSha ?? input.expectedBaseSha,
        commitSha: result.deliveredHeadSha ?? "",
      }, null, 2), "utf8");
    } catch { /* mirroring is best-effort observability, never a delivery failure */ }
    return result;
  }

  /**
   * Set the current remote head of a branch so exact-draft delivery enforces the
   * base like the real transport: on first creation the expected base sha must
   * equal this head, otherwise delivery drifts. Tests use it to simulate a
   * branch that moved since the clone was connected.
   */
  setRemoteBranchHead(owner: string, repo: string, branch: string, sha: string): void {
    this.remoteBranchHeads.set(`${owner}\u0000${repo}\u0000${branch}`, sha);
  }

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

  async deliverExactDraft(rawInput: ExactDraftDeliveryInput): Promise<ExactDraftDeliveryResult> {
    const input = validateExactDraftDeliveryInput(rawInput);
    const repoDir = this.repoDir(input.owner, input.repo);
    const branchDir = this.branchDir(input.owner, input.repo, input.branch);
    const metadataPath = this.containedPathFrom(branchDir, ".exact-draft.json");
    const treeDigest = createHash("sha256")
      .update(JSON.stringify([...input.files].sort((a, b) => a.path.localeCompare(b.path))))
      .digest("hex");
    const commitSha = createHash("sha1").update(JSON.stringify({
      baseSha: input.expectedBaseSha,
      treeDigest,
      message: input.commitMessage,
      date: input.commitDate,
    })).digest("hex");
    const expectedMetadata = {
      baseBranch: input.baseBranch,
      baseSha: input.expectedBaseSha,
      branch: input.branch,
      treeDigest,
      commitSha,
      commitMessage: input.commitMessage,
      commitDate: input.commitDate,
      fileModes: [...input.files]
        .map((file) => "delete" in file
          ? ({ path: file.path, delete: true as const })
          : ({ path: file.path, mode: file.mode }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
    if (existsSync(branchDir)) {
      if (!existsSync(metadataPath)) throw new Error("github_exact_draft_branch_diverged");
      const existing = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
      // A re-delivery of THIS branch against a different approved base is base drift,
      // not content divergence: the branch's own recorded base moved. Report it as
      // base_revision_drift (distinct from a content change), keyed to the delivery
      // branch's own base — not a pinned first base per base branch, so a genuinely
      // moved default head still delivers on a fresh branch (see the per-new-branch
      // remote-head check below).
      if (existing.baseSha !== input.expectedBaseSha) {
        throw new Error("github_exact_draft_base_revision_drift");
      }
      if (JSON.stringify(existing) !== JSON.stringify(expectedMetadata)) {
        throw new Error("github_exact_draft_branch_diverged");
      }
      for (const file of input.files) {
        const path = this.containedPathFrom(branchDir, file.path);
        if ("delete" in file) {
          if (existsSync(path)) throw new Error("github_exact_draft_branch_diverged");
          continue;
        }
        if (
          !existsSync(path) ||
          readFileSync(path, "utf8") !== file.content ||
          (process.platform !== "win32" &&
            ((statSync(path).mode & 0o111) !== 0) !== (file.mode === "100755"))
        ) {
          throw new Error("github_exact_draft_branch_diverged");
        }
      }
    } else {
      // A new draft branch must anchor to the CURRENT remote head, exactly as
      // the real transport does (exact-draft.ts checks refSha(baseBranch) on
      // first creation). When a test has set the remote head, enforce it; a
      // stale base drifts and a base matching the moved head is accepted.
      const remoteHead = this.remoteBranchHeads.get(
        `${input.owner}\u0000${input.repo}\u0000${input.baseBranch}`,
      );
      if (remoteHead !== undefined && remoteHead !== input.expectedBaseSha) {
        throw new Error("github_exact_draft_base_revision_drift");
      }
      mkdirSync(branchDir, { recursive: true });
      for (const file of input.files) {
        const path = this.containedPathFrom(branchDir, file.path);
        if ("delete" in file) {
          if (existsSync(path)) rmSync(path, { force: true });
          continue;
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.content, "utf8");
        if (process.platform !== "win32") {
          chmodSync(path, file.mode === "100755" ? 0o755 : 0o644);
        }
      }
      writeFileSync(join(branchDir, ".branch"), input.branch, "utf8");
      writeFileSync(metadataPath, JSON.stringify(expectedMetadata), "utf8");
    }

    const pullsDir = this.containedPathFrom(repoDir, "pulls");
    mkdirSync(pullsDir, { recursive: true });
    const existingPulls = readdirSync(pullsDir)
      .filter((name) => /^[1-9][0-9]*\.json$/.test(name))
      .map((name) => JSON.parse(readFileSync(join(pullsDir, name), "utf8")) as Record<string, unknown>)
      .filter((pull) => pull.branch === input.branch);
    if (existingPulls.length > 0) {
      if (existingPulls.length !== 1) throw new Error("github_exact_draft_pull_request_diverged");
      const pull = existingPulls[0]!;
      if (
        pull.state !== "open" || pull.draft !== true || pull.base !== input.baseBranch ||
        pull.baseSha !== input.expectedBaseSha || pull.commitSha !== commitSha ||
        pull.title !== input.title || pull.body !== input.body
      ) {
        throw new Error("github_exact_draft_pull_request_diverged");
      }
      return Object.freeze({
        number: Number(pull.number),
        url: String(pull.url),
        branch: input.branch,
        title: input.title,
        draft: true,
        baseBranch: input.baseBranch,
        baseSha: input.expectedBaseSha,
        commitSha,
      });
    }
    const counterFile = join(pullsDir, "_counter");
    const number = existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8")) + 1 : 1;
    writeFileSync(counterFile, String(number), "utf8");
    const url = `https://github.com/${input.owner}/${input.repo}/pull/${number}`;
    writeFileSync(join(pullsDir, `${number}.json`), JSON.stringify({
      number,
      url,
      state: "open",
      draft: true,
      title: input.title,
      body: input.body,
      branch: input.branch,
      base: input.baseBranch,
      baseSha: input.expectedBaseSha,
      commitSha,
    }, null, 2), "utf8");
    return Object.freeze({
      number,
      url,
      branch: input.branch,
      title: input.title,
      draft: true,
      baseBranch: input.baseBranch,
      baseSha: input.expectedBaseSha,
      commitSha,
    });
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
      if ("delete" in f) {
        rmSync(target, { force: true });
        continue;
      }
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

  async getOpenPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<{ body: string; state: "open" | "closed"; draft: boolean } | undefined> {
    const file = this.containedPathFrom(this.repoDir(owner, repo), "pulls", `${prNumber}.json`);
    if (!existsSync(file)) return undefined;
    const pull = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      body: typeof pull.body === "string" ? pull.body : "",
      state: pull.state === "open" ? "open" : "closed",
      draft: pull.draft === true,
    };
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
  private readonly tenantId: string;

  constructor(tenantId: string, token?: string) {
    this.tenantId = assertTenantIdPresent(tenantId);
    const t = token ?? process.env.GITHUB_TOKEN;
    if (!t) {
      throw new Error(
        "GITHUB_MODE=real requires GITHUB_TOKEN (or pass a token). Use `gh auth token` or a classic PAT with `repo` scope.",
      );
    }
    this.octokit = new Octokit({
      auth: t,
      userAgent: "mendpoint-api",
      request: { timeout: GITHUB_REQUEST_TIMEOUT_MS },
    });
  }

  /**
   * The tenant-scoped, fail-closed transport (#724): every write through it —
   * exact-draft, adoptive, and the content-manifest create/commit/open path —
   * is refused if it carries the tenant id. A getter, so a test that injects a
   * fake `octokit` after construction is still guarded. Reads pass through.
   */
  private get tx(): Octokit {
    return guardGitHubWrites(this.octokit, this.tenantId, tenantIdentityGuardError) as Octokit;
  }

  async assertRepositoryIdentity(
    owner: string,
    repo: string,
    expectedRepositoryId: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(expectedRepositoryId) || expectedRepositoryId < 1) {
      throw new Error("github_repository_id_invalid");
    }
    const { data } = await this.octokit.repos.get({ owner, repo });
    if (
      data.id !== expectedRepositoryId ||
      data.owner.login.toLowerCase() !== owner.toLowerCase() ||
      data.name.toLowerCase() !== repo.toLowerCase()
    ) {
      throw new Error("github_repository_identity_mismatch");
    }
  }

  deliverExactDraft(input: ExactDraftDeliveryInput): Promise<ExactDraftDeliveryResult> {
    return deliverExactDraftWithOctokit(this.tx, input);
  }

  deliverAdoptiveDraft(
    input: Omit<AdoptiveDraftInput, "body">,
    options: AdoptiveDeliveryOptions,
  ): Promise<AdoptiveDraftResult> {
    return deliverAdoptiveDraftWithOctokit(
      this.tx as unknown as AdoptiveOctokit,
      { ...input, body: options.resolveBody() },
      options.hooks ?? {},
    );
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
      const matches = await mapWithConcurrency(
        files,
        GITHUB_FILE_CONCURRENCY,
        async (file) => {
          if ("delete" in file) {
            try {
              await this.octokit.repos.getContent({
                owner,
                repo,
                path: file.path.replace(/\\/g, "/"),
                ref: branch,
              });
              return false;
            } catch (error) {
              if (isNotFoundError(error)) return true;
              throw error;
            }
          }
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
        },
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
      await this.tx.git.createRef({
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
        const { data: blob } = await this.tx.git.createBlob({
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

    const { data: newTree } = await this.tx.git.createTree({
      owner,
      repo,
      base_tree: baseTree,
      tree,
    });

    const { data: newCommit } = await this.tx.git.createCommit({
      owner,
      repo,
      message,
      tree: newTree.sha,
      parents: [branchSha],
    });

    await this.tx.git.updateRef({
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
      const { data } = await this.tx.pulls.create({
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
        const { data } = await this.tx.pulls.create({
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

  async getOpenPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<{ body: string; state: "open" | "closed"; draft: boolean } | undefined> {
    try {
      const { data } = await this.octokit.pulls.get({ owner, repo, pull_number: prNumber });
      return {
        body: data.body ?? "",
        state: data.state === "open" ? "open" : "closed",
        draft: data.draft === true,
      };
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      throw error;
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
  tenantId?: string,
): Promise<GitHubDelivery> {
  if (mode === "real") {
    const token = await resolveGitHubToken();
    // #724: the real PAT transport is tenant-scoped and guarded; the tenant id is required.
    return new OctokitGitHubDelivery(assertTenantIdPresent(tenantId ?? ""), token);
  }
  return new MockGitHubDelivery();
}

export function createGitHubDelivery(
  mode = process.env.GITHUB_MODE ?? "mock",
  tenantId?: string,
): GitHubDelivery {
  if (mode === "real") {
    // Sync path: env only (use createGitHubDeliveryAsync for gh auth token)
    return new OctokitGitHubDelivery(assertTenantIdPresent(tenantId ?? ""), process.env.GITHUB_TOKEN);
  }
  return new MockGitHubDelivery();
}

/**
 * Provider-neutral delivery selector. Routes to the GitLab draft-MR adapter
 * when the caller (or SCM_PROVIDER) asks for GitLab; defaults to GitHub so all
 * existing GitHub behavior is unchanged when GitLab is not configured. The tenant
 * id is required for the real transports (#724): both are tenant-scoped and guarded.
 */
export function createReviewableChangeDelivery(
  tenantId: string,
  provider: ScmDeliveryProvider = (process.env.SCM_PROVIDER?.trim().toLowerCase() as ScmDeliveryProvider) ||
    "github",
): ReviewableChangeDelivery {
  if (provider === "gitlab") {
    return gitlabAsReviewableChangeDelivery(createGitLabDelivery(process.env.GITLAB_MODE, tenantId));
  }
  return createGitHubDelivery(undefined, tenantId);
}

export {
  ExactDraftRemoteSideEffectUncertainError,
  type ExactDraftFileChange,
  type ExactDraftFileMode,
  type ExactDraftDeliveryInput,
  type ExactDraftDeliveryResult,
} from "./exact-draft.js";

export {
  deliverAdoptiveDraftWithOctokit,
  adoptiveBodyDigest,
  AdoptiveDraftBlockedError,
  AdoptiveDraftContentionError,
  MAX_ADOPTIVE_PR_BODY_CHARS,
  type AdoptiveOctokit,
  type AdoptiveDraftInput,
  type AdoptiveDraftResult,
  type AdoptiveDraftBlocked,
  type AdoptiveDraftHooks,
  type AdoptiveDeliveryOptions,
} from "./draft-adoption.js";

export { adoptiveDraftOperationDigest } from "./app-runtime.js";

export {
  guardGitHubWrites,
  containsTenantIdentity,
  assertNoTenantIdentity,
  TENANT_IDENTITY_DELIVERY_ERROR,
  type CustomerWriteKind,
  type TenantIdentityLeak,
} from "./tenant-identity-guard.js";

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
  createRepositoryBaseRefresher,
  type RepositoryBaseRefresher,
  type RepositoryBaseRefreshResult,
  type RepositoryBaseRefreshInput,
  type RepositoryGitRunner,
} from "./repository-base-refresh.js";

export {
  createAppJwt,
  loadAppCredentials,
  hasGitHubAppCredentials,
  InstallationTokenCache,
  GitHubAppDelivery,
  deliverToManyRepos,
  createAppDelivery,
  defaultListInstallationRepositories,
  defaultFetchInstallationMetadata,
  listInstallationRepositories,
  mockInstallationRepositories,
  classifyGitHubDependencyFailure,
  GitHubDependencyOutageError,
  type AppCredentials,
  type InstallationToken,
  type TokenFetcher,
  type InstallationAccount,
  type InstallationMetadataFetcher,
  type InstallationRepository,
  type InstallationRepositoryLister,
  type MockInstallationRepositoryInput,
  type GitHubDependencyFailureKind,
  type GitHubDependencyFailureEvidence,
  type GitHubDependencyCircuitSnapshot,
  type GitHubDependencyOutageDecision,
  type GitHubDependencyOutageOperation,
  type GitHubDependencyOutageResult,
  type GitHubDependencyOutagePort,
  type GitHubDependencyOutagePolicy,
  type GitHubDependencyOutageOptions,
} from "./app-runtime.js";

export {
  EXACT_DRAFT_OBSERVATION_EVIDENCE_VERSION,
  observeExactDraftWithOctokit,
  type ExactDraftFailure,
  type ExactDraftCheckResult,
  type ExactDraftObservation,
  type ExactDraftObservationInput,
  type ExactDraftObservationEvidenceV1,
} from "./exact-draft-observer.js";

export {
  cleanupExactDraftWithOctokit,
  exactDraftCleanupOperationId,
  ExactDraftCleanupNotSupportedError,
  type ExactDraftCleanupEvidence,
  type ExactDraftCleanupInput,
  type ExactDraftCleanupOperationScope,
  type ExactHeadRefAuthorityReceiptScope,
  type ExactHeadRefCompareAndDeleteAuthority,
  type ExactHeadRefCompareAndDeleteInput,
  type ExactHeadRefCompareAndDeleteResult,
} from "./exact-draft-cleanup.js";

export {
  updateExactDraftWithOctokit,
  reconcileExactDraftUpdateWithOctokit,
  type ExactDraftUpdateInput,
  type ExactDraftUpdateReconciliation,
  type ExactDraftUpdateResult,
} from "./exact-draft-update.js";

export {
  GITHUB_DRAFT_DELIVERY_PERMISSIONS,
  GitHubAppLifecycle,
  GitHubAppLifecycleError,
  GitHubInstallationTokenRejectedError,
  type GitHubInstallationSeed,
  type GitHubInstallationRecord,
  type GitHubInstallationTokenRequest,
  type GitHubInstallationToken,
  type GitHubInstallationTokenAdapter,
  type GitHubDraftDeliveryIntent,
  type GitHubDraftDeliveryGrant,
  type GitHubAppLifecycleErrorCode,
} from "./app-lifecycle.js";

export {
  parseGitHubAccountTenantBindings,
  resolveGitHubInstallationTenant,
  resolveGitHubAccountTenantBinding,
  resolveGitHubTenantAccountBinding,
} from "./owner-bindings.js";

export {
  MockGitLabDelivery,
  HttpGitLabDelivery,
  GitLabDeliveryError,
  MOCK_GITLAB_BASE_REVISION,
  createGitLabDelivery,
  gitlabAsReviewableChangeDelivery,
  type GitLabDelivery,
  type GitLabDeliveryOperation,
  type GitLabFetch,
  type MergeRequestResult,
  type ReviewableChange,
  type ReviewableChangeDelivery,
  type ScmDeliveryProvider,
} from "./gitlab.js";

export {
  gitlabAsExactDraftDelivery,
  type ExactDraftDelivery,
} from "./gitlab-exact-draft.js";
