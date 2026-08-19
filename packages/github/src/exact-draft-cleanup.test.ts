import type { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupExactDraftWithOctokit,
  exactDraftCleanupOperationId,
  ExactDraftCleanupNotSupportedError,
  type ExactHeadRefCompareAndDeleteAuthority,
  type ExactDraftCleanupInput,
} from "./exact-draft-cleanup.js";

const sha = (value: string) => value.repeat(40);

const inputScope = Object.freeze({
  owner: "acme",
  repo: "service",
  installationId: 501,
  expectedRepositoryId: 101,
  pullRequestNumber: 17,
  baseBranch: "main",
  expectedBaseSha: sha("a"),
  headBranch: "mendpoint/change",
  expectedHeadSha: sha("b"),
});
const input: ExactDraftCleanupInput = Object.freeze({
  ...inputScope,
  operationId: exactDraftCleanupOperationId(inputScope),
});

type HarnessOptions = Readonly<{
  initialState?: "open" | "closed";
  initialHeadAbsent?: boolean;
  repositoryId?: number;
  draft?: boolean;
  baseBranch?: string;
  baseSha?: string;
  headBranch?: string;
  headSha?: string;
  pullUrl?: string;
  preflightOpenPullCount?: number;
  preflightLink?: string;
  finalOpenPullCount?: number;
  finalLink?: string;
  closeResponseLost?: boolean;
  closeWithoutEffect?: boolean;
  deleteResponseLost?: boolean;
  deleteWithoutEffect?: boolean;
  driftHeadBeforeDelete?: string;
  driftBaseBeforeDelete?: string;
  moveHeadDuringAtomicDelete?: string;
  unauthenticatedNotFound?: boolean;
  receiptInstallationId?: number;
  receiptOperationId?: string;
}>;

function notFound(): Error & { status: number } {
  return Object.assign(new Error("Not Found"), { status: 404 });
}

function harness(options: HarnessOptions = {}): Readonly<{
  octokit: Octokit;
  authority: ExactHeadRefCompareAndDeleteAuthority;
  update: ReturnType<typeof vi.fn>;
  compareAndDelete: ReturnType<typeof vi.fn>;
  unsafeDeleteRef: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
}> {
  let state: "open" | "closed" = options.initialState ?? "open";
  let headExists = options.initialHeadAbsent !== true;
  let baseReads = 0;
  let headReads = 0;
  let listReads = 0;
  const repositoryId = options.repositoryId ?? 101;
  const baseBranch = options.baseBranch ?? "main";
  const headBranch = options.headBranch ?? "mendpoint/change";
  const initialBaseSha = options.baseSha ?? sha("a");
  const initialHeadSha = options.headSha ?? sha("b");

  const update = vi.fn(async () => {
    if (!options.closeWithoutEffect) state = "closed";
    if (options.closeResponseLost) throw new Error("connection reset after close");
    return { data: {} };
  });
  let currentHeadSha = initialHeadSha;
  const compareAndDelete = vi.fn(async (request: {
    expectedSha: string;
    installationId: number;
    expectedRepositoryId: number;
    branch: string;
    operationId: string;
  }) => {
    const { expectedSha } = request;
    const receiptScope = {
      operationId: options.receiptOperationId ?? request.operationId,
      installationId: options.receiptInstallationId ?? request.installationId,
      repositoryId: request.expectedRepositoryId,
      branch: request.branch,
      expectedSha: request.expectedSha,
    };
    if (options.moveHeadDuringAtomicDelete) currentHeadSha = options.moveHeadDuringAtomicDelete;
    if (!headExists) {
      return {
        status: "not_found" as const,
        authenticated: options.unauthenticatedNotFound === true ? false : true,
        evidenceRef: "git-authority:head-already-absent",
        ...receiptScope,
      };
    }
    if (currentHeadSha !== expectedSha) {
      return { status: "mismatch" as const, actualSha: currentHeadSha };
    }
    if (!options.deleteWithoutEffect) headExists = false;
    if (options.deleteResponseLost) throw new Error("connection reset after atomic delete");
    return {
      status: "deleted" as const,
      authenticated: true as const,
      evidenceRef: "git-authority:force-with-lease:receipt-1",
      ...receiptScope,
    };
  });
  const authority: ExactHeadRefCompareAndDeleteAuthority = Object.freeze({
    capability: "atomic_compare_and_delete",
    compareAndDeleteExactHead: compareAndDelete as unknown as
      ExactHeadRefCompareAndDeleteAuthority["compareAndDeleteExactHead"],
  });
  const unsafeDeleteRef = vi.fn(async () => ({ data: {} }));

  const pull = () => ({
    number: 17,
    html_url: options.pullUrl ?? "https://github.com/acme/service/pull/17",
    state,
    draft: options.draft ?? true,
    merged_at: null,
    base: { ref: baseBranch, sha: initialBaseSha, repo: { id: repositoryId } },
    head: { ref: headBranch, sha: initialHeadSha, repo: { id: repositoryId } },
  });

  const list = vi.fn(async () => {
    const preflight = listReads++ === 0;
    const count = preflight
      ? options.preflightOpenPullCount ?? (state === "open" ? 1 : 0)
      : options.finalOpenPullCount ?? 0;
    return {
      data: Array.from({ length: count }, () => pull()),
      headers: { link: preflight ? options.preflightLink : options.finalLink },
    };
  });
  const octokit = {
    pulls: {
      get: vi.fn(async () => ({ data: pull() })),
      update,
      list,
    },
    git: {
      getRef: vi.fn(async ({ ref }: { ref: string }) => {
        if (ref === "heads/main") {
          baseReads += 1;
          return { data: { object: { sha: baseReads > 1 && options.driftBaseBeforeDelete
            ? options.driftBaseBeforeDelete
            : initialBaseSha } } };
        }
        if (ref === "heads/mendpoint/change") {
          headReads += 1;
          if (!headExists) throw notFound();
          return { data: { object: { sha: headReads > 1 && options.driftHeadBeforeDelete
            ? options.driftHeadBeforeDelete
            : currentHeadSha } } };
        }
        throw new Error(`unexpected ref ${ref}`);
      }),
      deleteRef: unsafeDeleteRef,
    },
  } as unknown as Octokit;

  return Object.freeze({ octokit, authority, update, compareAndDelete, unsafeDeleteRef, list });
}

describe("cleanupExactDraftWithOctokit", () => {
  it("closes only the exact draft, deletes only its exact head, and returns immutable evidence", async () => {
    const client = harness();

    const evidence = await cleanupExactDraftWithOctokit(client.octokit, input, client.authority);

    expect(client.update).toHaveBeenCalledWith({
      owner: "acme", repo: "service", pull_number: 17, state: "closed",
    });
    expect(client.compareAndDelete).toHaveBeenCalledWith({
      owner: "acme", repo: "service", expectedRepositoryId: 101,
      installationId: 501, operationId: input.operationId,
      branch: "mendpoint/change", expectedSha: sha("b"),
    });
    expect(client.unsafeDeleteRef).not.toHaveBeenCalled();
    expect(client.list).toHaveBeenNthCalledWith(1, {
      owner: "acme", repo: "service", state: "open", head: "acme:mendpoint/change", per_page: 100,
    });
    expect(evidence).toEqual({
      installationId: 501,
      operationId: input.operationId,
      repositoryId: 101,
      pullRequestNumber: 17,
      pullRequestUrl: "https://github.com/acme/service/pull/17",
      pullRequestState: "closed",
      draft: true,
      baseBranch: "main",
      baseSha: sha("a"),
      headBranch: "mendpoint/change",
      headSha: sha("b"),
      branchState: "deleted",
      deletionAuthorityEvidenceRef: "git-authority:force-with-lease:receipt-1",
      openPullRequestsForHead: 0,
      evidenceRefs: [
        "github:installation:501",
        "github:repository:101",
        `github:cleanup-operation:${input.operationId}`,
        "github:pull-request:acme/service#17:closed",
        `github:base:main:${sha("a")}`,
        `github:head:mendpoint/change:${sha("b")}:deleted`,
        "github:open-pulls:acme:mendpoint/change:0",
        "git-authority:force-with-lease:receipt-1",
      ],
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.evidenceRefs)).toBe(true);
  });

  it.each([
    ["repository identity", { repositoryId: 202 }, "github_exact_draft_cleanup_authority_mismatch"],
    ["draft state", { draft: false }, "github_exact_draft_cleanup_authority_mismatch"],
    ["base branch", { baseBranch: "release" }, "github_exact_draft_cleanup_authority_mismatch"],
    ["base ref", { baseSha: sha("c") }, "github_exact_draft_cleanup_authority_mismatch"],
    ["head branch", { headBranch: "other" }, "github_exact_draft_cleanup_authority_mismatch"],
    ["head ref", { headSha: sha("c") }, "github_exact_draft_cleanup_authority_mismatch"],
    ["pull URL", { pullUrl: "https://github.com/acme/other/pull/17" },
      "github_exact_draft_cleanup_authority_mismatch"],
    ["duplicate open PR", { preflightOpenPullCount: 2 }, "github_exact_draft_cleanup_open_pull_mismatch"],
    ["incomplete preflight list", { preflightLink: '<https://api.github.test/page=2>; rel="next"' },
      "github_exact_draft_cleanup_pagination_incomplete"],
  ] as const)("rejects %s drift before any mutation", async (_name, options, code) => {
    const client = harness(options);

    await expect(cleanupExactDraftWithOctokit(client.octokit, input, client.authority)).rejects.toThrow(code);
    expect(client.update).not.toHaveBeenCalled();
    expect(client.compareAndDelete).not.toHaveBeenCalled();
    expect(client.unsafeDeleteRef).not.toHaveBeenCalled();
  });

  it("returns typed not_supported before closing when no atomic delete authority is available", async () => {
    const client = harness();
    const promise = cleanupExactDraftWithOctokit(client.octokit, input);
    await expect(promise).rejects.toBeInstanceOf(ExactDraftCleanupNotSupportedError);
    await expect(promise).rejects.toMatchObject({ code: "github_exact_draft_cleanup_not_supported" });
    expect(client.update).not.toHaveBeenCalled();
    expect(client.unsafeDeleteRef).not.toHaveBeenCalled();
  });

  it("reconciles a lost close response with an authoritative read", async () => {
    const client = harness({ closeResponseLost: true });
    await expect(cleanupExactDraftWithOctokit(client.octokit, input, client.authority)).resolves.toMatchObject({
      pullRequestState: "closed",
      branchState: "deleted",
    });
    expect(client.compareAndDelete).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a lost atomic-delete response even when the head is later absent", async () => {
    const client = harness({ deleteResponseLost: true });
    await expect(cleanupExactDraftWithOctokit(client.octokit, input, client.authority))
      .rejects.toThrow("github_exact_draft_cleanup_delete_uncertain");
  });

  it("recovers after restart only with the authority's authenticated not-found receipt", async () => {
    const client = harness({ deleteResponseLost: true });
    await expect(cleanupExactDraftWithOctokit(client.octokit, input, client.authority))
      .rejects.toThrow("github_exact_draft_cleanup_delete_uncertain");

    await expect(cleanupExactDraftWithOctokit(client.octokit, input, client.authority)).resolves.toMatchObject({
      pullRequestState: "closed",
      branchState: "deleted",
      deletionAuthorityEvidenceRef: "git-authority:head-already-absent",
      openPullRequestsForHead: 0,
    });
    expect(client.compareAndDelete).toHaveBeenCalledTimes(2);
    expect(client.compareAndDelete).toHaveBeenLastCalledWith({
      owner: "acme", repo: "service", expectedRepositoryId: 101,
      installationId: 501, operationId: input.operationId,
      branch: "mendpoint/change", expectedSha: sha("b"),
    });
  });

  it.each([
    ["closed draft with a present head", {
      initialState: "closed", preflightOpenPullCount: 0,
    }],
    ["open draft with an absent head", {
      initialHeadAbsent: true,
    }],
  ] as const)("rejects the invalid restart combination: %s", async (_name, options) => {
    const client = harness(options);
    await expect(cleanupExactDraftWithOctokit(client.octokit, input, client.authority))
      .rejects.toThrow("github_exact_draft_cleanup_authority_mismatch");
    expect(client.update).not.toHaveBeenCalled();
    expect(client.compareAndDelete).not.toHaveBeenCalled();
  });

  it("rejects closed-and-absent recovery without an authenticated authority receipt", async () => {
    const client = harness({
      initialState: "closed",
      initialHeadAbsent: true,
      unauthenticatedNotFound: true,
    });
    await expect(cleanupExactDraftWithOctokit(client.octokit, input, client.authority))
      .rejects.toThrow("github_exact_draft_cleanup_delete_uncertain");
    expect(client.update).not.toHaveBeenCalled();
    expect(client.compareAndDelete).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["wrong installation", { receiptInstallationId: 999 }],
    ["unrelated operation", { receiptOperationId: `sha256:${"f".repeat(64)}` }],
  ] as const)("rejects an authenticated not-found receipt for the %s", async (_name, receipt) => {
    const client = harness({
      initialState: "closed",
      initialHeadAbsent: true,
      ...receipt,
    });
    await expect(cleanupExactDraftWithOctokit(client.octokit, input, client.authority))
      .rejects.toThrow("github_exact_draft_cleanup_delete_uncertain");
    expect(client.update).not.toHaveBeenCalled();
    expect(client.compareAndDelete).toHaveBeenCalledTimes(1);
  });

  it("does not delete a ref pushed after the final read but before atomic deletion", async () => {
    const client = harness({ moveHeadDuringAtomicDelete: sha("c") });

    await expect(cleanupExactDraftWithOctokit(client.octokit, input, client.authority))
      .rejects.toThrow("github_exact_draft_cleanup_head_mismatch");
    expect(client.compareAndDelete).toHaveBeenCalledTimes(1);
    expect(client.unsafeDeleteRef).not.toHaveBeenCalled();
    await expect(client.octokit.git.getRef({
      owner: input.owner, repo: input.repo, ref: `heads/${input.headBranch}`,
    })).resolves.toMatchObject({ data: { object: { sha: sha("c") } } });
  });

  it("does not delete a head or base that drifted after the close", async () => {
    const movedHead = harness({ driftHeadBeforeDelete: sha("c") });
    await expect(cleanupExactDraftWithOctokit(movedHead.octokit, input, movedHead.authority))
      .rejects.toThrow("github_exact_draft_cleanup_predelete_drift");
    expect(movedHead.compareAndDelete).not.toHaveBeenCalled();

    const movedBase = harness({ driftBaseBeforeDelete: sha("c") });
    await expect(cleanupExactDraftWithOctokit(movedBase.octokit, input, movedBase.authority))
      .rejects.toThrow("github_exact_draft_cleanup_predelete_drift");
    expect(movedBase.compareAndDelete).not.toHaveBeenCalled();
  });

  it("fails closed when close or delete did not take effect", async () => {
    const open = harness({ closeResponseLost: true, closeWithoutEffect: true });
    await expect(cleanupExactDraftWithOctokit(open.octokit, input, open.authority))
      .rejects.toThrow("github_exact_draft_cleanup_close_uncertain");
    expect(open.compareAndDelete).not.toHaveBeenCalled();

    const present = harness({ deleteResponseLost: true, deleteWithoutEffect: true });
    await expect(cleanupExactDraftWithOctokit(present.octokit, input, present.authority))
      .rejects.toThrow("github_exact_draft_cleanup_delete_uncertain");
  });

  it.each([
    ["remaining open PR", { finalOpenPullCount: 1 }, "github_exact_draft_cleanup_not_complete"],
    ["incomplete final list", { finalLink: '<https://api.github.test/page=2>; rel="next"' },
      "github_exact_draft_cleanup_pagination_incomplete"],
  ] as const)("withholds success for %s", async (_name, options, code) => {
    const client = harness(options);
    await expect(cleanupExactDraftWithOctokit(client.octokit, input, client.authority)).rejects.toThrow(code);
  });

  it.each([
    { ...input, owner: "../acme" },
    { ...input, pullRequestNumber: 0 },
    { ...input, expectedRepositoryId: 0 },
    { ...input, installationId: 0 },
    { ...input, operationId: `sha256:${"0".repeat(64)}` },
    { ...input, baseBranch: input.headBranch },
    { ...input, expectedBaseSha: "main" },
    { ...input, headBranch: "refs/heads/change" },
  ])("rejects malformed or unsafe input", async (invalid) => {
    const client = harness();
    await expect(cleanupExactDraftWithOctokit(client.octokit, invalid, client.authority))
      .rejects.toThrow("github_exact_draft_cleanup_invalid");
    expect(client.update).not.toHaveBeenCalled();
    expect(client.compareAndDelete).not.toHaveBeenCalled();
  });
});
