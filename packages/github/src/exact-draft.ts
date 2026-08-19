import type { Octokit } from "@octokit/rest";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const BRANCH = /^(?!\/)(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
const MAX_FILES = 1_000;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

export type ExactDraftDeliveryInput = Readonly<{
  owner: string;
  repo: string;
  baseBranch: string;
  expectedBaseSha: string;
  branch: string;
  commitMessage: string;
  commitDate: string;
  title: string;
  body: string;
  files: readonly ExactDraftFileChange[];
}>;

export type ExactDraftFileChange =
  | Readonly<{
    path: string;
    content: string;
    mode: ExactDraftFileMode;
  }>
  | Readonly<{
    path: string;
    delete: true;
  }>;

export type ExactDraftFileMode = "100644" | "100755";

export type ExactDraftDeliveryResult = Readonly<{
  number: number;
  url: string;
  branch: string;
  title: string;
  draft: true;
  baseBranch: string;
  baseSha: string;
  commitSha: string;
  remoteTreeSha?: string;
}>;

export type ValidatedExactDraftDeliveryInput = ExactDraftDeliveryInput;

export class ExactDraftRemoteSideEffectUncertainError extends Error {
  readonly code = "GITHUB_EXACT_DRAFT_REMOTE_SIDE_EFFECT_UNCERTAIN";
  readonly remoteSideEffectUncertain = true;

  constructor(readonly cause: unknown) {
    super("github_exact_draft_remote_side_effect_uncertain");
    this.name = "ExactDraftRemoteSideEffectUncertainError";
  }
}

function requireText(value: string, code: string, max: number): void {
  if (!value.trim() || value.length > max || /[\0\r]/.test(value)) throw new Error(code);
}

export function validateExactDraftDeliveryInput(
  input: ExactDraftDeliveryInput,
): ValidatedExactDraftDeliveryInput {
  if (!IDENTITY.test(input.owner) || !IDENTITY.test(input.repo)) {
    throw new Error("github_exact_draft_repository_invalid");
  }
  for (const branch of [input.baseBranch, input.branch]) {
    if (!BRANCH.test(branch) || branch.endsWith("/") || branch.endsWith(".lock")) {
      throw new Error("github_exact_draft_branch_invalid");
    }
  }
  if (input.baseBranch === input.branch) throw new Error("github_exact_draft_branch_invalid");
  if (!SHA.test(input.expectedBaseSha)) throw new Error("github_exact_draft_base_sha_invalid");
  requireText(input.commitMessage, "github_exact_draft_commit_message_invalid", 4_000);
  requireText(input.title, "github_exact_draft_title_invalid", 512);
  requireText(input.body, "github_exact_draft_body_invalid", 100_000);
  if (new Date(input.commitDate).toISOString() !== input.commitDate) {
    throw new Error("github_exact_draft_commit_date_invalid");
  }
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > MAX_FILES) {
    throw new Error("github_exact_draft_files_invalid");
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of input.files) {
    const deletion = "delete" in file;
    if (
      typeof file.path !== "string" ||
      !file.path ||
      file.path.length > 1_000 ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.includes("//") ||
      file.path.split("/").some((part: string) => !part || part === "." || part === "..") ||
      paths.has(file.path) ||
      (deletion
        ? file.delete !== true || Object.keys(file).sort().join(",") !== "delete,path"
        : typeof file.content !== "string" ||
          (file.mode !== "100644" && file.mode !== "100755") ||
          Object.keys(file).some((key) => !["path", "content", "mode"].includes(key)))
    ) {
      throw new Error("github_exact_draft_files_invalid");
    }
    paths.add(file.path);
    if (!deletion) totalBytes += Buffer.byteLength(file.content, "utf8");
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("github_exact_draft_files_too_large");
  }
  return input;
}

function isNotFound(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 404;
}

function isExistingRef(error: unknown): boolean {
  return (
    (error as { status?: unknown } | null)?.status === 422 &&
    /already exists|reference exists/i.test(error instanceof Error ? error.message : String(error))
  );
}

function assertSha(value: string, code: string): string {
  if (!SHA.test(value)) throw new Error(code);
  return value;
}

async function refSha(
  octokit: Octokit,
  input: ExactDraftDeliveryInput,
  branch: string,
): Promise<string | undefined> {
  try {
    const { data } = await octokit.git.getRef({
      owner: input.owner,
      repo: input.repo,
      ref: `heads/${branch}`,
    });
    return assertSha(data.object.sha, "github_exact_draft_ref_invalid");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function matchingPull(
  pull: {
    number: number;
    html_url: string;
    state: string;
    draft?: boolean | null;
    title: string;
    body?: string | null;
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
  },
  input: ExactDraftDeliveryInput,
  commitSha: string,
  remoteTreeSha: string,
): ExactDraftDeliveryResult | undefined {
  if (
    pull.state !== "open" ||
    pull.draft !== true ||
    pull.head.ref !== input.branch ||
    pull.head.sha !== commitSha ||
    pull.base.ref !== input.baseBranch ||
    pull.title !== input.title ||
    pull.body !== input.body
  ) {
    return undefined;
  }
  return Object.freeze({
    number: pull.number,
    url: pull.html_url,
    branch: input.branch,
    title: pull.title,
    draft: true,
    baseBranch: input.baseBranch,
    baseSha: input.expectedBaseSha,
    commitSha,
    remoteTreeSha,
  });
}

async function recoverExactPull(
  octokit: Octokit,
  input: ExactDraftDeliveryInput,
  commitSha: string,
  remoteTreeSha: string,
): Promise<ExactDraftDeliveryResult | undefined> {
  const { data: pulls } = await octokit.pulls.list({
    owner: input.owner,
    repo: input.repo,
    state: "all",
    head: `${input.owner}:${input.branch}`,
  });
  if (pulls.length === 0) return undefined;
  if (pulls.length !== 1) throw new Error("github_exact_draft_pull_request_diverged");
  const result = matchingPull(pulls[0]!, input, commitSha, remoteTreeSha);
  if (!result) throw new Error("github_exact_draft_pull_request_diverged");
  return result;
}

/**
 * Deliver one immutable draft from an approved base revision. Every externally
 * visible boundary is replay-safe. First creation requires the named base to
 * be at the approved revision. Recovery is anchored to the exact deterministic
 * commit with that revision as its sole parent, so later base movement is safe.
 * An existing pull request is reused only when its immutable draft evidence
 * matches; GitHub's mutable base SHA is not treated as delivery evidence.
 */
export async function deliverExactDraftWithOctokit(
  octokit: Octokit,
  rawInput: ExactDraftDeliveryInput,
): Promise<ExactDraftDeliveryResult> {
  const input = validateExactDraftDeliveryInput(rawInput);
  let branchHead = await refSha(octokit, input, input.branch);
  if (!branchHead) {
    const baseHead = await refSha(octokit, input, input.baseBranch);
    if (baseHead !== input.expectedBaseSha) {
      throw new Error("github_exact_draft_base_revision_drift");
    }
    try {
      await octokit.git.createRef({
        owner: input.owner,
        repo: input.repo,
        ref: `refs/heads/${input.branch}`,
        sha: input.expectedBaseSha,
      });
      branchHead = input.expectedBaseSha;
    } catch (error) {
      if (!isExistingRef(error)) throw error;
      branchHead = await refSha(octokit, input, input.branch);
      if (!branchHead) throw new Error("github_exact_draft_branch_race");
    }
  }

  const { data: baseCommit } = await octokit.git.getCommit({
    owner: input.owner,
    repo: input.repo,
    commit_sha: input.expectedBaseSha,
  });
  const tree = await Promise.all(input.files.map(async (file) => {
    if ("delete" in file) {
      return {
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: null,
      };
    }
    const { data: blob } = await octokit.git.createBlob({
      owner: input.owner,
      repo: input.repo,
      content: Buffer.from(file.content, "utf8").toString("base64"),
      encoding: "base64",
    });
    return {
      path: file.path,
      mode: file.mode,
      type: "blob" as const,
      sha: blob.sha,
    };
  }));
  const { data: desiredTree } = await octokit.git.createTree({
    owner: input.owner,
    repo: input.repo,
    base_tree: baseCommit.tree.sha,
    tree,
  });

  const identity = {
    name: "Mendpoint",
    email: "delivery@mendpoint.ai",
    date: input.commitDate,
  };
  const { data: createdCommit } = await octokit.git.createCommit({
    owner: input.owner,
    repo: input.repo,
    message: input.commitMessage,
    tree: desiredTree.sha,
    parents: [input.expectedBaseSha],
    author: identity,
    committer: identity,
  });
  const commitSha = assertSha(createdCommit.sha, "github_exact_draft_commit_invalid");

  if (branchHead === input.expectedBaseSha) {
    try {
      await octokit.git.updateRef({
        owner: input.owner,
        repo: input.repo,
        ref: `heads/${input.branch}`,
        sha: commitSha,
        force: false,
      });
    } catch (error) {
      const recovered = await refSha(octokit, input, input.branch);
      if (recovered !== commitSha) throw error;
    }
    if (await refSha(octokit, input, input.branch) !== commitSha) {
      throw new Error("github_exact_draft_branch_diverged");
    }
  } else if (branchHead !== commitSha) {
    throw new Error("github_exact_draft_branch_diverged");
  }

  const existing = await recoverExactPull(octokit, input, commitSha, desiredTree.sha);
  if (existing) return existing;

  let createdPull;
  try {
    ({ data: createdPull } = await octokit.pulls.create({
      owner: input.owner,
      repo: input.repo,
      title: input.title,
      head: input.branch,
      base: input.baseBranch,
      body: input.body,
      draft: true,
    }));
  } catch (error) {
    try {
      const recovered = await recoverExactPull(octokit, input, commitSha, desiredTree.sha);
      if (recovered) return recovered;
    } catch (recoveryError) {
      if (
        recoveryError instanceof Error &&
        recoveryError.message === "github_exact_draft_pull_request_diverged"
      ) {
        throw recoveryError;
      }
      throw new ExactDraftRemoteSideEffectUncertainError(error);
    }
    throw new ExactDraftRemoteSideEffectUncertainError(error);
  }
  const result = matchingPull(createdPull, input, commitSha, desiredTree.sha);
  if (!result) throw new Error("github_exact_draft_pull_request_diverged");
  return result;
}
