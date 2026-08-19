import { createHash } from "node:crypto";
import type { Octokit } from "@octokit/rest";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const BRANCH = /^(?!\/)(?!refs\/)(?!.*(?:\.\.|\/\/|@\{|[~^:?*\\\s\x00-\x1f\x7f]))[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
const OPERATION_ID = /^sha256:[a-f0-9]{64}$/;

export type ExactDraftCleanupOperationScope = Readonly<{
  owner: string;
  repo: string;
  installationId: number;
  expectedRepositoryId: number;
  pullRequestNumber: number;
  baseBranch: string;
  expectedBaseSha: string;
  headBranch: string;
  expectedHeadSha: string;
}>;

export type ExactDraftCleanupInput = ExactDraftCleanupOperationScope & Readonly<{
  operationId: string;
}>;

export type ExactDraftCleanupEvidence = Readonly<{
  installationId: number;
  operationId: string;
  repositoryId: number;
  pullRequestNumber: number;
  pullRequestUrl: string;
  pullRequestState: "closed";
  draft: true;
  baseBranch: string;
  baseSha: string;
  headBranch: string;
  headSha: string;
  branchState: "deleted";
  deletionAuthorityEvidenceRef: string;
  openPullRequestsForHead: 0;
  evidenceRefs: readonly string[];
}>;

export type ExactHeadRefCompareAndDeleteInput = Readonly<{
  owner: string;
  repo: string;
  installationId: number;
  operationId: string;
  expectedRepositoryId: number;
  branch: string;
  expectedSha: string;
}>;

export type ExactHeadRefAuthorityReceiptScope = Readonly<{
  operationId: string;
  installationId: number;
  repositoryId: number;
  branch: string;
  expectedSha: string;
}>;

export type ExactHeadRefCompareAndDeleteResult =
  | (ExactHeadRefAuthorityReceiptScope & Readonly<{
      status: "deleted"; authenticated: true; evidenceRef: string;
    }>)
  | (ExactHeadRefAuthorityReceiptScope & Readonly<{
      status: "not_found"; authenticated: true; evidenceRef: string;
    }>)
  | Readonly<{ status: "mismatch"; actualSha: string }>;

/**
 * Trust-boundary port for an atomic ref authority. This package intentionally
 * provides no concrete production implementation or capability claim.
 */
export interface ExactHeadRefCompareAndDeleteAuthority {
  readonly capability: "atomic_compare_and_delete";
  compareAndDeleteExactHead(
    input: ExactHeadRefCompareAndDeleteInput,
  ): Promise<ExactHeadRefCompareAndDeleteResult>;
}

export class ExactDraftCleanupNotSupportedError extends Error {
  readonly code = "github_exact_draft_cleanup_not_supported" as const;

  constructor() {
    super("Atomic compare-and-delete authority is required for exact draft cleanup");
    this.name = "ExactDraftCleanupNotSupportedError";
  }
}

type PullIdentity = Readonly<{
  url: string;
  state: string;
  draft: boolean | null;
  baseBranch: string;
  baseSha: string;
  baseRepositoryId: number | undefined;
  headBranch: string;
  headSha: string;
  headRepositoryId: number | undefined;
}>;

function validBranch(value: string): boolean {
  return BRANCH.test(value) && !value.endsWith("/") && !value.endsWith(".") &&
    value.split("/").every((part) => part !== "." && part !== ".." && !part.endsWith(".lock"));
}

export function exactDraftCleanupOperationId(scope: ExactDraftCleanupOperationScope): string {
  const canonical = JSON.stringify({
    owner: scope.owner,
    repo: scope.repo,
    installationId: scope.installationId,
    repositoryId: scope.expectedRepositoryId,
    pullRequestNumber: scope.pullRequestNumber,
    baseBranch: scope.baseBranch,
    baseSha: scope.expectedBaseSha,
    headBranch: scope.headBranch,
    headSha: scope.expectedHeadSha,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function validate(input: ExactDraftCleanupInput): void {
  if (!IDENTITY.test(input.owner) || !IDENTITY.test(input.repo) ||
      !Number.isSafeInteger(input.installationId) || input.installationId < 1 ||
      !Number.isSafeInteger(input.expectedRepositoryId) || input.expectedRepositoryId < 1 ||
      !Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber < 1 ||
      !validBranch(input.baseBranch) || !validBranch(input.headBranch) ||
      input.baseBranch === input.headBranch ||
      !SHA.test(input.expectedBaseSha) || !SHA.test(input.expectedHeadSha) ||
      !OPERATION_ID.test(input.operationId) ||
      input.operationId !== exactDraftCleanupOperationId(input)) {
    throw new Error("github_exact_draft_cleanup_invalid");
  }
}

function isNotFound(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 404;
}

function hasNextPage(link: unknown): boolean {
  return typeof link === "string" && /(?:^|,)\s*<[^>]+>\s*;[^,]*\brel="next"(?:\s*;|\s*$)/i.test(link);
}

function authorityEvidenceRef(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 1_000 ||
      /[\0\r\n]/.test(value)) {
    throw new Error("github_exact_draft_cleanup_delete_uncertain");
  }
  return value;
}

function pullIdentity(data: Readonly<{
  html_url?: unknown;
  state?: unknown;
  draft?: unknown;
  base?: { ref?: unknown; sha?: unknown; repo?: { id?: unknown } | null };
  head?: { ref?: unknown; sha?: unknown; repo?: { id?: unknown } | null };
}>): PullIdentity {
  return Object.freeze({
    url: String(data.html_url ?? ""),
    state: String(data.state ?? ""),
    draft: typeof data.draft === "boolean" ? data.draft : null,
    baseBranch: String(data.base?.ref ?? ""),
    baseSha: String(data.base?.sha ?? ""),
    baseRepositoryId: Number.isSafeInteger(data.base?.repo?.id) ? Number(data.base?.repo?.id) : undefined,
    headBranch: String(data.head?.ref ?? ""),
    headSha: String(data.head?.sha ?? ""),
    headRepositoryId: Number.isSafeInteger(data.head?.repo?.id) ? Number(data.head?.repo?.id) : undefined,
  });
}

async function readPull(octokit: Octokit, input: ExactDraftCleanupInput): Promise<PullIdentity> {
  const response = await octokit.pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pullRequestNumber,
  });
  return pullIdentity(response.data);
}

function assertExactPull(
  pull: PullIdentity,
  input: ExactDraftCleanupInput,
  expectedState: "open" | "closed",
): void {
  let urlMatches = false;
  try {
    const url = new URL(pull.url);
    urlMatches = url.protocol === "https:" && url.hostname === "github.com" &&
      !url.username && !url.password && !url.search && !url.hash &&
      url.pathname.toLowerCase() ===
        `/${input.owner}/${input.repo}/pull/${input.pullRequestNumber}`.toLowerCase();
  } catch {
    urlMatches = false;
  }
  if (pull.state !== expectedState || pull.draft !== true ||
      pull.baseBranch !== input.baseBranch || pull.baseSha !== input.expectedBaseSha ||
      pull.baseRepositoryId !== input.expectedRepositoryId ||
      pull.headBranch !== input.headBranch || pull.headSha !== input.expectedHeadSha ||
      pull.headRepositoryId !== input.expectedRepositoryId ||
      !urlMatches) {
    throw new Error("github_exact_draft_cleanup_authority_mismatch");
  }
}

async function readRef(
  octokit: Octokit,
  input: ExactDraftCleanupInput,
  branch: string,
): Promise<string | null> {
  try {
    const response = await octokit.git.getRef({
      owner: input.owner,
      repo: input.repo,
      ref: `heads/${branch}`,
    });
    const revision = String(response.data.object.sha ?? "");
    if (!SHA.test(revision)) throw new Error("github_exact_draft_cleanup_ref_invalid");
    return revision;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function listOpenForExactHead(
  octokit: Octokit,
  input: ExactDraftCleanupInput,
): Promise<readonly Readonly<{ number: number }>[]> {
  const response = await octokit.pulls.list({
    owner: input.owner,
    repo: input.repo,
    state: "open",
    head: `${input.owner}:${input.headBranch}`,
    per_page: 100,
  });
  if (hasNextPage(response.headers.link)) {
    throw new Error("github_exact_draft_cleanup_pagination_incomplete");
  }
  return response.data.map((pull) => Object.freeze({ number: pull.number }));
}

async function reconcileClosedPull(
  octokit: Octokit,
  input: ExactDraftCleanupInput,
): Promise<PullIdentity> {
  try {
    const pull = await readPull(octokit, input);
    assertExactPull(pull, input, "closed");
    return pull;
  } catch (error) {
    throw new Error("github_exact_draft_cleanup_close_uncertain", { cause: error });
  }
}

async function compareAndDelete(
  authority: ExactHeadRefCompareAndDeleteAuthority,
  input: ExactDraftCleanupInput,
): Promise<Readonly<{ status: "deleted" | "not_found"; evidenceRef: string }>> {
  try {
    const deletion = await authority.compareAndDeleteExactHead({
      owner: input.owner,
      repo: input.repo,
      installationId: input.installationId,
      operationId: input.operationId,
      expectedRepositoryId: input.expectedRepositoryId,
      branch: input.headBranch,
      expectedSha: input.expectedHeadSha,
    });
    if (deletion.status === "mismatch") {
      if (!SHA.test(deletion.actualSha)) {
        throw new Error("github_exact_draft_cleanup_delete_uncertain");
      }
      throw new Error("github_exact_draft_cleanup_head_mismatch");
    }
    if (deletion.authenticated !== true ||
        deletion.operationId !== input.operationId ||
        deletion.installationId !== input.installationId ||
        deletion.repositoryId !== input.expectedRepositoryId ||
        deletion.branch !== input.headBranch ||
        deletion.expectedSha !== input.expectedHeadSha) {
      throw new Error("github_exact_draft_cleanup_delete_uncertain");
    }
    return Object.freeze({
      status: deletion.status,
      evidenceRef: authorityEvidenceRef(deletion.evidenceRef),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "github_exact_draft_cleanup_head_mismatch") throw error;
    throw new Error("github_exact_draft_cleanup_delete_uncertain", { cause: error });
  }
}

/**
 * Closes an exact draft and deletes only its pinned head ref. Every mutation is
 * preceded and followed by authoritative reads. PR-close response loss can be
 * reconciled from the PR itself; atomic-delete response loss fails closed
 * because later ref absence cannot prove which actor deleted it.
 */
export async function cleanupExactDraftWithOctokit(
  octokit: Octokit,
  input: ExactDraftCleanupInput,
  authority?: ExactHeadRefCompareAndDeleteAuthority,
): Promise<ExactDraftCleanupEvidence> {
  validate(input);
  if (authority?.capability !== "atomic_compare_and_delete" ||
      typeof authority.compareAndDeleteExactHead !== "function") {
    throw new ExactDraftCleanupNotSupportedError();
  }

  const [initialPull, initialBase, initialHead, initialOpenPulls] = await Promise.all([
    readPull(octokit, input),
    readRef(octokit, input, input.baseBranch),
    readRef(octokit, input, input.headBranch),
    listOpenForExactHead(octokit, input),
  ]);
  if (initialBase !== input.expectedBaseSha) {
    throw new Error("github_exact_draft_cleanup_authority_mismatch");
  }
  let closedPull: PullIdentity;
  let deletionAuthorityEvidenceRef: string;
  if (initialPull.state === "closed") {
    assertExactPull(initialPull, input, "closed");
    if (initialHead !== null || initialOpenPulls.length !== 0) {
      throw new Error("github_exact_draft_cleanup_authority_mismatch");
    }
    const recovery = await compareAndDelete(authority, input);
    if (recovery.status !== "not_found") {
      throw new Error("github_exact_draft_cleanup_delete_uncertain");
    }
    closedPull = initialPull;
    deletionAuthorityEvidenceRef = recovery.evidenceRef;
  } else {
    assertExactPull(initialPull, input, "open");
    if (initialHead !== input.expectedHeadSha) {
      throw new Error("github_exact_draft_cleanup_authority_mismatch");
    }
    if (initialOpenPulls.length !== 1 || initialOpenPulls[0]?.number !== input.pullRequestNumber) {
      throw new Error("github_exact_draft_cleanup_open_pull_mismatch");
    }

    try {
      await octokit.pulls.update({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullRequestNumber,
        state: "closed",
      });
    } catch {
      await reconcileClosedPull(octokit, input);
    }

    const [observedClosedPull, predeleteBase, predeleteHead] = await Promise.all([
      reconcileClosedPull(octokit, input),
      readRef(octokit, input, input.baseBranch),
      readRef(octokit, input, input.headBranch),
    ]);
    if (predeleteBase !== input.expectedBaseSha || predeleteHead !== input.expectedHeadSha) {
      throw new Error("github_exact_draft_cleanup_predelete_drift");
    }

    const deletion = await compareAndDelete(authority, input);
    if (deletion.status !== "deleted") {
      throw new Error("github_exact_draft_cleanup_delete_uncertain");
    }
    closedPull = observedClosedPull;
    deletionAuthorityEvidenceRef = deletion.evidenceRef;
  }

  const [finalPull, finalBase, finalHead, finalOpenPulls] = await Promise.all([
    readPull(octokit, input),
    readRef(octokit, input, input.baseBranch),
    readRef(octokit, input, input.headBranch),
    listOpenForExactHead(octokit, input),
  ]);
  assertExactPull(finalPull, input, "closed");
  if (finalBase !== input.expectedBaseSha || finalHead !== null || finalOpenPulls.length !== 0) {
    throw new Error("github_exact_draft_cleanup_not_complete");
  }

  const evidenceRefs = Object.freeze([
    `github:installation:${input.installationId}`,
    `github:repository:${input.expectedRepositoryId}`,
    `github:cleanup-operation:${input.operationId}`,
    `github:pull-request:${input.owner}/${input.repo}#${input.pullRequestNumber}:closed`,
    `github:base:${input.baseBranch}:${input.expectedBaseSha}`,
    `github:head:${input.headBranch}:${input.expectedHeadSha}:deleted`,
    `github:open-pulls:${input.owner}:${input.headBranch}:0`,
    deletionAuthorityEvidenceRef,
  ]);
  return Object.freeze({
    installationId: input.installationId,
    operationId: input.operationId,
    repositoryId: input.expectedRepositoryId,
    pullRequestNumber: input.pullRequestNumber,
    pullRequestUrl: closedPull.url,
    pullRequestState: "closed" as const,
    draft: true as const,
    baseBranch: input.baseBranch,
    baseSha: input.expectedBaseSha,
    headBranch: input.headBranch,
    headSha: input.expectedHeadSha,
    branchState: "deleted" as const,
    deletionAuthorityEvidenceRef,
    openPullRequestsForHead: 0 as const,
    evidenceRefs,
  });
}
