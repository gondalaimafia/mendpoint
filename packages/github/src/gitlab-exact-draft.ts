import {
  validateExactDraftDeliveryInput,
  type ExactDraftDeliveryInput,
  type ExactDraftDeliveryResult,
} from "./exact-draft.js";
import {
  type GitLabCommitFile,
  type GitLabDelivery,
} from "./gitlab.js";

/**
 * The single-method exact-draft delivery contract Transformer's approved
 * candidate delivery depends on. GitHubDelivery satisfies it structurally
 * (via deliverExactDraft); GitLabDelivery is adapted onto it below so a
 * provider selector can return either without the delivery body changing.
 */
export interface ExactDraftDelivery {
  deliverExactDraft(input: ExactDraftDeliveryInput): Promise<ExactDraftDeliveryResult>;
}

/**
 * Adapt a Wave B GitLabDelivery onto the exact-draft delivery contract used by
 * Transformer's approved-candidate delivery. The same sealed exact-draft intent
 * (branch, exact files, title/body) is delivered as a GitLab *draft* merge
 * request: observe the base revision and fail closed if it has drifted away
 * from the approved base, create the source branch from that base, commit the
 * exact files, then open a draft merge request against the base branch.
 * Delivery evidence reports the base revision actually observed (not the
 * intent's own input) and the commit SHA GitLab actually returned (empty when
 * GitLab omits it; the worker's evidence assertions require a real 40-hex id
 * and reject an absent one, matching the GitHub lane). Delivery fails closed if
 * GitLab does not confirm the merge request is a draft; nothing is merged and
 * no branch is force-updated. This reuses GitLabDelivery rather than rebuilding
 * it, so the delivery worker stays delivery-interface-shaped.
 */
export function gitlabAsExactDraftDelivery(delivery: GitLabDelivery): ExactDraftDelivery {
  return {
    async deliverExactDraft(rawInput: ExactDraftDeliveryInput): Promise<ExactDraftDeliveryResult> {
      const input = validateExactDraftDeliveryInput(rawInput);
      // Observe the base revision instead of assuming it: resolve the base
      // branch to the commit it currently points at and fail closed if it has
      // moved off the approved base, exactly as the GitHub exact-draft path
      // throws github_exact_draft_base_revision_drift.
      const files: GitLabCommitFile[] = input.files.map((file) => "delete" in file
        ? { path: file.path, delete: true as const }
        : { path: file.path, content: file.content, mode: file.mode });
      const reconcileExactHead = async (
        candidateHead?: string,
      ): Promise<string | undefined> => {
        const head = candidateHead ?? await delivery.resolveBranchSha(
          input.owner,
          input.repo,
          input.branch,
        );
        if (!head) return undefined;
        const exact = await delivery.verifyExactCommit(
          input.owner,
          input.repo,
          input.branch,
          {
            commitSha: head,
            parentSha: input.expectedBaseSha,
            message: input.commitMessage,
            files,
          },
        );
        return exact ? head : undefined;
      };
      let committedSha: string | undefined;
      const existingHead = await delivery.resolveBranchSha(
        input.owner,
        input.repo,
        input.branch,
      );
      if (existingHead) {
        committedSha = await reconcileExactHead(existingHead);
        if (!committedSha) throw new Error("gitlab_exact_draft_branch_diverged");
      } else {
        const observedBaseSha = await delivery.resolveBranchSha(
          input.owner,
          input.repo,
          input.baseBranch,
        );
        if (observedBaseSha !== input.expectedBaseSha) {
          throw new Error("gitlab_exact_draft_base_revision_drift");
        }
        // GitLab accepts a commit SHA as the branch-creation ref. Pin creation
        // to the exact revision just observed, rather than rereading the mutable
        // base branch name after the drift check.
        try {
          await delivery.createBranch(input.owner, input.repo, input.branch, observedBaseSha);
        } catch (error) {
          // A concurrent worker can create and commit this deterministic branch
          // between our initial absence read and branch POST. Adopt it only when
          // read-only reconciliation proves the complete sealed commit; otherwise
          // preserve the branch-creation failure and perform no further mutation.
          committedSha = await reconcileExactHead();
          if (!committedSha) throw error;
        }
        if (!committedSha) {
          try {
            committedSha = await delivery.commitFiles(
              input.owner,
              input.repo,
              input.branch,
              input.commitMessage,
              files,
            );
          } catch (error) {
            // A lost create-commit response is uncertain. Reconcile read-only from
            // the branch head and accept it only when GitLab proves the exact sole
            // parent, message, paths, modes, and bytes. Never issue a second commit.
            committedSha = await reconcileExactHead();
            if (!committedSha) throw error;
          }
        }
      }
      if (committedSha === undefined) {
        throw new Error("gitlab_exact_draft_commit_sha_missing");
      }
      const mergeRequest = await delivery.openDraftMergeRequest(
        input.owner,
        input.repo,
        input.branch,
        input.title,
        input.body,
        input.baseBranch,
        committedSha,
      );
      if (mergeRequest.draft !== true) {
        throw new Error("gitlab_exact_draft_not_draft");
      }
      return Object.freeze({
        number: mergeRequest.number,
        url: mergeRequest.url,
        branch: input.branch,
        title: input.title,
        draft: true,
        baseBranch: input.baseBranch,
        // Recovery is anchored to a commit whose sole parent is this approved
        // revision, even if the mutable base branch moved after first delivery.
        baseSha: input.expectedBaseSha,
        // The commit id GitLab actually returned, unshaped. GitLab omitting it
        // yields an empty string, which the worker's delivery-evidence check
        // (40-hex required, matching Warden) rejects rather than accepting a
        // fabricated id.
        commitSha: committedSha,
      });
    },
  };
}
