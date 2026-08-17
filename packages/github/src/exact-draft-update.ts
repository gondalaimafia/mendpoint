import type { Octokit } from "@octokit/rest";
import type { ExactDraftFileChange } from "./exact-draft.js";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const BRANCH = /^(?!\/)(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
const MAX_FILES = 1_000;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

export type ExactDraftUpdateInput = Readonly<{
  owner: string;
  repo: string;
  expectedRepositoryId: number;
  pullRequestNumber: number;
  baseBranch: string;
  branch: string;
  expectedHeadSha: string;
  commitMessage: string;
  commitDate: string;
  files: readonly ExactDraftFileChange[];
}>;

export type ExactDraftUpdateResult = Readonly<{
  number: number;
  url: string;
  branch: string;
  previousHeadSha: string;
  commitSha: string;
  draft: true;
}>;

export type ExactDraftUpdateReconciliation =
  | Readonly<{ status: "not_applied" }>
  | Readonly<{ status: "applied"; result: ExactDraftUpdateResult }>
  | Readonly<{ status: "unknown" }>;

function validate(input: ExactDraftUpdateInput): void {
  if (!IDENTITY.test(input.owner) || !IDENTITY.test(input.repo) ||
      !Number.isSafeInteger(input.expectedRepositoryId) || input.expectedRepositoryId < 1 ||
      !Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber < 1 ||
      !BRANCH.test(input.baseBranch) || !BRANCH.test(input.branch) || input.baseBranch === input.branch ||
      !SHA.test(input.expectedHeadSha) || !input.commitMessage.trim() || input.commitMessage.length > 4_000 ||
      /[\0\r]/.test(input.commitMessage) || new Date(input.commitDate).toISOString() !== input.commitDate ||
      !Array.isArray(input.files) || input.files.length < 1 || input.files.length > MAX_FILES) {
    throw new Error("github_exact_draft_update_invalid");
  }
  let total = 0;
  const paths = new Set<string>();
  for (const file of input.files) {
    const deletion = "delete" in file;
    if (!file.path || file.path.length > 1_000 || file.path.startsWith("/") || file.path.includes("\\") ||
        file.path.includes("//") || file.path.split("/").some((part: string) => !part || part === "." || part === "..") ||
        paths.has(file.path) || (deletion
          ? file.delete !== true || Object.keys(file).sort().join(",") !== "delete,path"
          : typeof file.content !== "string" ||
            (file.mode !== "100644" && file.mode !== "100755") ||
            Object.keys(file).some((key) => !["path", "content", "mode"].includes(key)))) {
      throw new Error("github_exact_draft_update_invalid");
    }
    paths.add(file.path);
    if (!deletion) total += Buffer.byteLength(file.content, "utf8");
    if (total > MAX_TOTAL_BYTES) throw new Error("github_exact_draft_update_too_large");
  }
}

async function refSha(octokit: Octokit, input: ExactDraftUpdateInput): Promise<string> {
  const response = await octokit.git.getRef({ owner: input.owner, repo: input.repo, ref: `heads/${input.branch}` });
  const value = String(response.data.object.sha ?? "");
  if (!SHA.test(value)) throw new Error("github_exact_draft_update_ref_invalid");
  return value;
}

async function assertPull(octokit: Octokit, input: ExactDraftUpdateInput): Promise<Readonly<{ head: string; url: string }>> {
  const { data: pull } = await octokit.pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pullRequestNumber,
  });
  if (pull.state !== "open" || pull.draft !== true) throw new Error("github_exact_draft_update_not_draft");
  if (pull.base.ref !== input.baseBranch || pull.head.ref !== input.branch ||
      pull.base.repo?.id !== input.expectedRepositoryId || pull.head.repo?.id !== input.expectedRepositoryId) {
    throw new Error("github_exact_draft_update_scope_mismatch");
  }
  const head = String(pull.head.sha ?? "");
  if (!SHA.test(head)) throw new Error("github_exact_draft_update_ref_invalid");
  return Object.freeze({ head, url: pull.html_url });
}

export async function updateExactDraftWithOctokit(
  octokit: Octokit,
  input: ExactDraftUpdateInput,
): Promise<ExactDraftUpdateResult> {
  validate(input);
  const initialPull = await assertPull(octokit, input);
  const branchHead = await refSha(octokit, input);
  if (initialPull.head !== branchHead) throw new Error("github_exact_draft_update_head_drift");

  const { data: parent } = await octokit.git.getCommit({
    owner: input.owner,
    repo: input.repo,
    commit_sha: input.expectedHeadSha,
  });
  const tree = await Promise.all(input.files.map(async (file) => {
    if ("delete" in file) {
      return { path: file.path, mode: "100644" as const, type: "blob" as const, sha: null };
    }
    const { data: blob } = await octokit.git.createBlob({
      owner: input.owner,
      repo: input.repo,
      content: Buffer.from(file.content, "utf8").toString("base64"),
      encoding: "base64",
    });
    return { path: file.path, mode: file.mode, type: "blob" as const, sha: blob.sha };
  }));
  const { data: nextTree } = await octokit.git.createTree({
    owner: input.owner,
    repo: input.repo,
    base_tree: parent.tree.sha,
    tree,
  });
  const identity = { name: "Mendpoint", email: "delivery@mendpoint.ai", date: input.commitDate };
  const { data: commit } = await octokit.git.createCommit({
    owner: input.owner,
    repo: input.repo,
    message: input.commitMessage,
    tree: nextTree.sha,
    parents: [input.expectedHeadSha],
    author: identity,
    committer: identity,
  });
  const desired = String(commit.sha ?? "");
  if (!SHA.test(desired)) throw new Error("github_exact_draft_update_commit_invalid");

  if (branchHead === input.expectedHeadSha) {
    try {
      await octokit.git.updateRef({
        owner: input.owner,
        repo: input.repo,
        ref: `heads/${input.branch}`,
        sha: desired,
        force: false,
      });
    } catch (error) {
      if (await refSha(octokit, input) !== desired) throw error;
    }
  } else if (branchHead !== desired) {
    throw new Error("github_exact_draft_update_head_drift");
  }
  if (await refSha(octokit, input) !== desired) throw new Error("github_exact_draft_update_head_drift");
  const finalPull = await assertPull(octokit, input);
  if (finalPull.head !== desired) throw new Error("github_exact_draft_update_head_drift");
  return Object.freeze({
    number: input.pullRequestNumber,
    url: finalPull.url,
    branch: input.branch,
    previousHeadSha: input.expectedHeadSha,
    commitSha: desired,
    draft: true as const,
  });
}

type TreeEntry = Readonly<{ path?: string; mode?: string; type?: string; sha?: string; size?: number }>;

function treeMap(entries: readonly TreeEntry[]): Map<string, TreeEntry> {
  const result = new Map<string, TreeEntry>();
  for (const entry of entries) {
    if (entry.type === "tree") continue;
    if (typeof entry.path !== "string" || !entry.path || result.has(entry.path) ||
        typeof entry.mode !== "string" || (entry.type !== "blob" && entry.type !== "commit") ||
        typeof entry.sha !== "string") {
      throw new Error("github_exact_draft_update_reconciliation_unknown");
    }
    result.set(entry.path, entry);
  }
  return result;
}

/** Read-only recovery for a prior commit-unknown update attempt. */
export async function reconcileExactDraftUpdateWithOctokit(
  octokit: Octokit,
  input: ExactDraftUpdateInput,
): Promise<ExactDraftUpdateReconciliation> {
  validate(input);
  const pull = await assertPull(octokit, input);
  const head = await refSha(octokit, input);
  if (pull.head !== head) return Object.freeze({ status: "unknown" as const });
  if (head === input.expectedHeadSha) return Object.freeze({ status: "not_applied" as const });

  try {
    const [{ data: candidate }, { data: base }] = await Promise.all([
      octokit.git.getCommit({ owner: input.owner, repo: input.repo, commit_sha: head }),
      octokit.git.getCommit({ owner: input.owner, repo: input.repo, commit_sha: input.expectedHeadSha }),
    ]);
    const parents = Array.isArray(candidate.parents) ? candidate.parents.map((parent) => String(parent.sha ?? "")) : [];
    const identity = { name: "Mendpoint", email: "delivery@mendpoint.ai", date: input.commitDate };
    if (parents.length !== 1 || parents[0] !== input.expectedHeadSha || candidate.message !== input.commitMessage ||
        candidate.author?.name !== identity.name || candidate.author?.email !== identity.email ||
        candidate.author?.date !== identity.date || candidate.committer?.name !== identity.name ||
        candidate.committer?.email !== identity.email || candidate.committer?.date !== identity.date) {
      return Object.freeze({ status: "unknown" as const });
    }
    const [candidateTreeResponse, baseTreeResponse] = await Promise.all([
      octokit.git.getTree({ owner: input.owner, repo: input.repo, tree_sha: candidate.tree.sha, recursive: "true" }),
      octokit.git.getTree({ owner: input.owner, repo: input.repo, tree_sha: base.tree.sha, recursive: "true" }),
    ]);
    if (candidateTreeResponse.data.truncated || baseTreeResponse.data.truncated) {
      return Object.freeze({ status: "unknown" as const });
    }
    const candidateTree = treeMap(candidateTreeResponse.data.tree);
    const baseTree = treeMap(baseTreeResponse.data.tree);
    const intended = new Map(input.files.map((file) => [file.path, file] as const));
    for (const file of input.files) {
      const next = candidateTree.get(file.path);
      if ("delete" in file) {
        const prior = baseTree.get(file.path);
        if (next || !prior || prior.type !== "blob") {
          return Object.freeze({ status: "unknown" as const });
        }
        continue;
      }
      if (!next || next.type !== "blob" || next.mode !== file.mode || !SHA.test(next.sha!)) {
        return Object.freeze({ status: "unknown" as const });
      }
      const blob = await octokit.git.getBlob({ owner: input.owner, repo: input.repo, file_sha: next.sha! });
      if (blob.data.encoding !== "base64" ||
          Buffer.from(blob.data.content.replace(/\s/g, ""), "base64").toString("utf8") !== file.content) {
        return Object.freeze({ status: "unknown" as const });
      }
    }
    const allPaths = new Set([...candidateTree.keys(), ...baseTree.keys()]);
    for (const path of allPaths) {
      if (intended.has(path)) continue;
      const next = candidateTree.get(path);
      const prior = baseTree.get(path);
      if (!next || !prior || next.mode !== prior.mode || next.type !== prior.type || next.sha !== prior.sha) {
        return Object.freeze({ status: "unknown" as const });
      }
    }
    return Object.freeze({ status: "applied" as const, result: Object.freeze({
      number: input.pullRequestNumber, url: pull.url, branch: input.branch,
      previousHeadSha: input.expectedHeadSha, commitSha: head, draft: true as const,
    }) });
  } catch {
    return Object.freeze({ status: "unknown" as const });
  }
}
