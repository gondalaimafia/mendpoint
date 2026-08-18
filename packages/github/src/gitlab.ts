import { createHash } from "node:crypto";
import type { FileEdit } from "./index.js";

/**
 * GitLab merge-request delivery, parallel to the GitHub draft-PR delivery.
 *
 * The contract mirrors GitHubDelivery: create a source branch, commit the
 * migration files, then open a *draft* merge request against the target
 * branch. Human review and manual merge stay in force; nothing here merges or
 * force-pushes. A deterministic Mock backs tests and local runs; a real HTTP
 * client (GitLab REST v4, token auth) is selected only when configured.
 *
 * See docs/GITLAB_DELIVERY.md for exactly what is and is not supported.
 */

const GITLAB_BRANCH =
  /^(?!\/)(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
// GitLab namespaces may contain subgroups, so the namespace may include "/".
const GITLAB_NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
const GITLAB_PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** GitLab commit ids are 40-hex SHA-1 object names. */
const GITLAB_HEAD_SHA = /^[a-f0-9]{40}$/i;
const GITLAB_REQUEST_TIMEOUT_MS = 15_000;

export type MergeRequestResult = {
  /** GitLab merge request internal id (iid). */
  number: number;
  /** GitLab web_url for the merge request. */
  url: string;
  /** Source branch the merge request was opened from. */
  branch: string;
  title: string;
  draft: true;
};

/** A provider-neutral "reviewable change": the shared shape GitHub PRs and GitLab MRs both return. */
export type ReviewableChange = {
  number: number;
  url: string;
  branch: string;
  title: string;
};

/**
 * The minimal "open a reviewable change" contract shared by GitHub and GitLab.
 * GitHubDelivery satisfies this structurally (createBranch / commitFiles /
 * openPullRequest); GitLabDelivery is adapted onto it via
 * gitlabAsReviewableChangeDelivery so a provider selector can return either.
 */
export interface ReviewableChangeDelivery {
  createBranch(
    owner: string,
    repo: string,
    branch: string,
    fromBranch?: string,
  ): Promise<void>;
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
  ): Promise<ReviewableChange>;
}

export type ScmDeliveryProvider = "github" | "gitlab";

/**
 * Default revision the deterministic in-memory mock reports for a base branch
 * that no commit has advanced. Real GitLab reports a branch's actual head; the
 * mock has no repository history, so it treats an untouched base branch as
 * sitting at this fixed genesis revision. A delivery whose base has moved off it
 * (advance it with commitFiles, or seed it with seedBranchHead) fails closed as
 * base-revision drift, exactly as the real path does.
 */
export const MOCK_GITLAB_BASE_REVISION = "a".repeat(40);

export interface GitLabDelivery {
  createBranch(
    namespace: string,
    project: string,
    branch: string,
    fromBranch?: string,
  ): Promise<void>;
  /**
   * Resolve a branch to the commit SHA it currently points at, or undefined if
   * the branch does not exist. Used to OBSERVE the base revision at delivery
   * time instead of assuming it, so exact-draft delivery can fail closed when
   * the base has drifted away from the approved revision.
   */
  resolveBranchSha(
    namespace: string,
    project: string,
    branch: string,
  ): Promise<string | undefined>;
  /**
   * Commit the exact files onto the source branch and return the created
   * commit's SHA (GitLab reports a 40-hex SHA-1 as `id`). Returns an empty
   * string only if GitLab omits the id; callers fall back accordingly.
   */
  commitFiles(
    namespace: string,
    project: string,
    branch: string,
    message: string,
    files: FileEdit[],
  ): Promise<string>;
  openDraftMergeRequest(
    namespace: string,
    project: string,
    sourceBranch: string,
    title: string,
    body: string,
    targetBranch?: string,
  ): Promise<MergeRequestResult>;
}

export type GitLabDeliveryOperation =
  | "createBranch"
  | "resolveBranchSha"
  | "commitFiles"
  | "openDraftMergeRequest";

export class GitLabDeliveryError extends Error {
  readonly provider = "gitlab" as const;

  constructor(
    readonly operation: GitLabDeliveryOperation,
    readonly status: number,
    readonly response: unknown,
    reason?: string,
  ) {
    super(
      `gitlab ${operation} failed with status ${status}${reason ? `: ${reason}` : ""}`,
    );
    this.name = "GitLabDeliveryError";
  }
}

export type GitLabFetch = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json: unknown }>;

async function defaultGitLabFetch(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(GITLAB_REQUEST_TIMEOUT_MS),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  } catch (error) {
    return { ok: false, status: 0, json: { error: String(error) } };
  }
}

function assertNames(namespace: string, project: string): void {
  if (!GITLAB_NAMESPACE.test(namespace) || !GITLAB_PROJECT.test(project)) {
    throw new Error("gitlab_project_identity_invalid");
  }
}

function assertBranch(branch: string): void {
  if (
    !GITLAB_BRANCH.test(branch) ||
    branch.endsWith("/") ||
    branch.endsWith(".lock")
  ) {
    throw new Error("gitlab_branch_invalid");
  }
}

function draftTitle(title: string): string {
  return /^draft:/i.test(title.trim()) ? title : `Draft: ${title}`;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function mergeRequestFromJson(
  operation: GitLabDeliveryOperation,
  status: number,
  json: unknown,
  sourceBranch: string,
): MergeRequestResult {
  const mr = json as {
    iid?: unknown;
    web_url?: unknown;
    title?: unknown;
    draft?: unknown;
    work_in_progress?: unknown;
  };
  const iid = mr?.iid;
  if (typeof iid !== "number" || !Number.isFinite(iid) || iid <= 0) {
    throw new GitLabDeliveryError(operation, status, json, "missing iid");
  }
  const url = mr?.web_url;
  if (typeof url !== "string" || !url.trim()) {
    throw new GitLabDeliveryError(operation, status, json, "missing web_url");
  }
  const title = typeof mr?.title === "string" ? mr.title : "";
  const isDraft =
    mr?.draft === true ||
    mr?.work_in_progress === true ||
    /^draft:/i.test(title.trim());
  if (!isDraft) {
    throw new GitLabDeliveryError(
      operation,
      status,
      json,
      "merge request is not a draft",
    );
  }
  return { number: iid, url, branch: sourceBranch, title, draft: true };
}

/**
 * Real GitLab delivery over the REST v4 API using token auth.
 *
 * Auth is a project, group, or personal access token passed as the
 * PRIVATE-TOKEN header. GITLAB_API_URL selects gitlab.com (default) or a
 * self-managed instance. Every failed request fails closed with a
 * GitLabDeliveryError; nothing is merged and no branch is force-updated.
 */
export class HttpGitLabDelivery implements GitLabDelivery {
  readonly provider = "gitlab" as const;
  private readonly token: string;
  private readonly api: string;
  private readonly fetchImpl: GitLabFetch;

  constructor(opts?: { token?: string; apiUrl?: string; fetch?: GitLabFetch }) {
    const token = opts?.token ?? process.env.GITLAB_TOKEN;
    if (!token) {
      throw new Error(
        "GITLAB_MODE=real requires GITLAB_TOKEN (project, group, or personal access token). Set GITLAB_API_URL for self-managed GitLab.",
      );
    }
    this.token = token;
    this.api = (opts?.apiUrl ?? process.env.GITLAB_API_URL ?? "https://gitlab.com/api/v4").replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = opts?.fetch ?? defaultGitLabFetch;
  }

  private headers(json = false): Record<string, string> {
    const base: Record<string, string> = { "PRIVATE-TOKEN": this.token };
    if (json) base["Content-Type"] = "application/json";
    return base;
  }

  private projectId(namespace: string, project: string): string {
    assertNames(namespace, project);
    return encodeURIComponent(`${namespace}/${project}`);
  }

  async createBranch(
    namespace: string,
    project: string,
    branch: string,
    fromBranch = "main",
  ): Promise<void> {
    assertBranch(branch);
    assertBranch(fromBranch);
    const id = this.projectId(namespace, project);
    const created = await this.fetchImpl(
      `${this.api}/projects/${id}/repository/branches?branch=${encodeURIComponent(branch)}&ref=${encodeURIComponent(fromBranch)}`,
      { method: "POST", headers: this.headers() },
    );
    if (created.ok) return;
    // A prior attempt may already own this deterministic branch. Confirm it
    // exists and continue; never overwrite existing branch content.
    const existing = await this.fetchImpl(
      `${this.api}/projects/${id}/repository/branches/${encodeURIComponent(branch)}`,
      { headers: this.headers() },
    );
    if (existing.ok) return;
    throw new GitLabDeliveryError("createBranch", created.status, created.json);
  }

  async resolveBranchSha(
    namespace: string,
    project: string,
    branch: string,
  ): Promise<string | undefined> {
    assertBranch(branch);
    const id = this.projectId(namespace, project);
    const resolved = await this.fetchImpl(
      `${this.api}/projects/${id}/repository/branches/${encodeURIComponent(branch)}`,
      { headers: this.headers() },
    );
    if (resolved.status === 404) return undefined;
    if (!resolved.ok) {
      throw new GitLabDeliveryError("resolveBranchSha", resolved.status, resolved.json);
    }
    // GitLab reports the branch head as `commit.id`, a 40-hex SHA-1 object name.
    const sha = (resolved.json as { commit?: { id?: unknown } } | null)?.commit?.id;
    if (typeof sha !== "string" || !GITLAB_HEAD_SHA.test(sha)) {
      throw new GitLabDeliveryError(
        "resolveBranchSha",
        resolved.status,
        resolved.json,
        "missing or malformed branch head sha",
      );
    }
    return sha.toLowerCase();
  }

  async commitFiles(
    namespace: string,
    project: string,
    branch: string,
    message: string,
    files: FileEdit[],
  ): Promise<string> {
    if (!files.length) return "";
    assertBranch(branch);
    const id = this.projectId(namespace, project);
    const actions: Array<
      { action: "create" | "update"; file_path: string; content: string } |
      { action: "delete"; file_path: string }
    > = [];
    for (const file of files) {
      const filePath = normalizePath(file.path);
      const head = await this.fetchImpl(
        `${this.api}/projects/${id}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`,
        { headers: this.headers() },
      );
      if ("delete" in file) {
        if (!head.ok) throw new Error("gitlab_delete_source_missing");
        actions.push({ action: "delete", file_path: filePath });
      } else {
        actions.push({
          action: head.ok ? "update" : "create",
          file_path: filePath,
          content: file.content,
        });
      }
    }
    const committed = await this.fetchImpl(
      `${this.api}/projects/${id}/repository/commits`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({
          branch,
          commit_message: message,
          actions,
        }),
      },
    );
    if (!committed.ok) {
      throw new GitLabDeliveryError("commitFiles", committed.status, committed.json);
    }
    // GitLab's create-commit response carries the new commit SHA as `id`.
    const commitId = (committed.json as { id?: unknown } | null)?.id;
    return typeof commitId === "string" ? commitId : "";
  }

  async openDraftMergeRequest(
    namespace: string,
    project: string,
    sourceBranch: string,
    title: string,
    body: string,
    targetBranch = "main",
  ): Promise<MergeRequestResult> {
    assertBranch(sourceBranch);
    assertBranch(targetBranch);
    const id = this.projectId(namespace, project);
    // Reuse an existing open MR for the same source/target to avoid duplicates.
    const existing = await this.fetchImpl(
      `${this.api}/projects/${id}/merge_requests?source_branch=${encodeURIComponent(sourceBranch)}&target_branch=${encodeURIComponent(targetBranch)}&state=opened`,
      { headers: this.headers() },
    );
    if (existing.ok && Array.isArray(existing.json) && existing.json.length > 0) {
      return mergeRequestFromJson(
        "openDraftMergeRequest",
        existing.status,
        existing.json[0],
        sourceBranch,
      );
    }
    const created = await this.fetchImpl(
      `${this.api}/projects/${id}/merge_requests`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({
          source_branch: sourceBranch,
          target_branch: targetBranch,
          title: draftTitle(title),
          description: body,
        }),
      },
    );
    if (!created.ok) {
      throw new GitLabDeliveryError("openDraftMergeRequest", created.status, created.json);
    }
    return mergeRequestFromJson(
      "openDraftMergeRequest",
      created.status,
      created.json,
      sourceBranch,
    );
  }
}

type MockProject = {
  branches: Map<string, Map<string, string>>;
  /** Head commit SHA per branch, so a base revision can be observed and drift detected. */
  heads: Map<string, string>;
  mergeRequests: Map<
    number,
    MergeRequestResult & { sourceBranch: string; targetBranch: string; body: string }
  >;
  nextIid: number;
};

/**
 * Deterministic in-memory GitLab delivery for tests and local runs. It records
 * branches, committed file contents, and draft merge requests, and never
 * touches the network. Re-opening a merge request for the same source/target
 * branch returns the existing one, mirroring the real dedupe behavior.
 */
export class MockGitLabDelivery implements GitLabDelivery {
  readonly provider = "gitlab" as const;
  readonly #projects = new Map<string, MockProject>();

  #project(namespace: string, project: string): MockProject {
    assertNames(namespace, project);
    const key = `${namespace}/${project}`;
    let existing = this.#projects.get(key);
    if (!existing) {
      existing = { branches: new Map(), heads: new Map(), mergeRequests: new Map(), nextIid: 1 };
      this.#projects.set(key, existing);
    }
    return existing;
  }

  /** The head an un-advanced branch reports: its tracked head, else the genesis default. */
  #head(proj: MockProject, branch: string): string {
    return proj.heads.get(branch) ?? MOCK_GITLAB_BASE_REVISION;
  }

  /**
   * Seed a branch head so a test can model a base branch sitting at a specific
   * revision (or move it to simulate drift). Advancing the base off the revision
   * a delivery was approved against makes that delivery fail closed.
   */
  seedBranchHead(namespace: string, project: string, branch: string, sha: string): void {
    assertBranch(branch);
    this.#project(namespace, project).heads.set(branch, sha);
  }

  async resolveBranchSha(
    namespace: string,
    project: string,
    branch: string,
  ): Promise<string | undefined> {
    assertBranch(branch);
    return this.#head(this.#project(namespace, project), branch);
  }

  async createBranch(
    namespace: string,
    project: string,
    branch: string,
    fromBranch = "main",
  ): Promise<void> {
    assertBranch(branch);
    assertBranch(fromBranch);
    const proj = this.#project(namespace, project);
    if (!proj.branches.has(branch)) {
      const base = proj.branches.get(fromBranch) ?? new Map<string, string>();
      proj.branches.set(branch, new Map(base));
      // A new branch points at the same commit as the branch it was cut from.
      proj.heads.set(branch, this.#head(proj, fromBranch));
    }
  }

  async commitFiles(
    namespace: string,
    project: string,
    branch: string,
    message: string,
    files: FileEdit[],
  ): Promise<string> {
    assertBranch(branch);
    const proj = this.#project(namespace, project);
    const contents = proj.branches.get(branch) ?? new Map<string, string>();
    for (const file of files) {
      const path = normalizePath(file.path);
      if ("delete" in file) {
        if (!contents.delete(path)) throw new Error("gitlab_delete_source_missing");
      } else {
        contents.set(path, file.content);
      }
    }
    proj.branches.set(branch, contents);
    // A deterministic 40-hex SHA-1 over the commit inputs, mirroring a real
    // GitLab commit id: stable across replay of the same commit, so exact-draft
    // evidence threads it through unchanged.
    const sha = createHash("sha1")
      .update(
        JSON.stringify({
          namespace,
          project,
          branch,
          message,
          files: files.map((file) => "delete" in file
            ? { path: normalizePath(file.path), delete: true }
            : { path: normalizePath(file.path), content: file.content }),
        }),
      )
      .digest("hex");
    proj.heads.set(branch, sha);
    return sha;
  }

  async openDraftMergeRequest(
    namespace: string,
    project: string,
    sourceBranch: string,
    title: string,
    body: string,
    targetBranch = "main",
  ): Promise<MergeRequestResult> {
    assertBranch(sourceBranch);
    assertBranch(targetBranch);
    const proj = this.#project(namespace, project);
    for (const mr of proj.mergeRequests.values()) {
      if (mr.sourceBranch === sourceBranch && mr.targetBranch === targetBranch) {
        return { number: mr.number, url: mr.url, branch: mr.branch, title: mr.title, draft: true };
      }
    }
    const iid = proj.nextIid++;
    const title2 = draftTitle(title);
    const url = `https://gitlab.com/${namespace}/${project}/-/merge_requests/${iid}`;
    proj.mergeRequests.set(iid, {
      number: iid,
      url,
      branch: sourceBranch,
      title: title2,
      draft: true,
      sourceBranch,
      targetBranch,
      body,
    });
    return { number: iid, url, branch: sourceBranch, title: title2, draft: true };
  }
}

export function createGitLabDelivery(
  mode = process.env.GITLAB_MODE ?? "mock",
): GitLabDelivery {
  if (mode === "real") {
    return new HttpGitLabDelivery();
  }
  return new MockGitLabDelivery();
}

/** Adapt a GitLabDelivery onto the provider-neutral ReviewableChangeDelivery contract. */
export function gitlabAsReviewableChangeDelivery(
  delivery: GitLabDelivery,
): ReviewableChangeDelivery {
  return {
    createBranch: (owner, repo, branch, fromBranch) =>
      delivery.createBranch(owner, repo, branch, fromBranch),
    commitFiles: async (owner, repo, branch, message, files) => {
      // The provider-neutral contract returns void; the commit SHA is used only
      // by the exact-draft adapter, not this reviewable-change wrapper.
      await delivery.commitFiles(owner, repo, branch, message, files);
    },
    openPullRequest: (owner, repo, branch, title, body, base) =>
      delivery.openDraftMergeRequest(owner, repo, branch, title, body, base),
  };
}
