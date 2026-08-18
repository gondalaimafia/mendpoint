import {
  validateExactDraftDeliveryInput,
  type ExactDraftDeliveryInput,
  type ExactDraftDeliveryResult,
} from "./exact-draft.js";
import type { FileEdit } from "./index.js";
import { type GitLabDelivery } from "./gitlab.js";

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
      const observedBaseSha = await delivery.resolveBranchSha(
        input.owner,
        input.repo,
        input.baseBranch,
      );
      if (observedBaseSha !== input.expectedBaseSha) {
        throw new Error("gitlab_exact_draft_base_revision_drift");
      }
      const files: FileEdit[] = input.files.map((file) => "delete" in file
        ? { path: file.path, delete: true }
        : { path: file.path, content: file.content });
      await delivery.createBranch(input.owner, input.repo, input.branch, input.baseBranch);
      const committedSha = await delivery.commitFiles(
        input.owner,
        input.repo,
        input.branch,
        input.commitMessage,
        files,
      );
      const mergeRequest = await delivery.openDraftMergeRequest(
        input.owner,
        input.repo,
        input.branch,
        input.title,
        input.body,
        input.baseBranch,
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
        // The observed base revision, verified equal to the approved base above.
        baseSha: observedBaseSha,
        // The commit id GitLab actually returned, unshaped. GitLab omitting it
        // yields an empty string, which the worker's delivery-evidence check
        // (40-hex required, matching Warden) rejects rather than accepting a
        // fabricated id.
        commitSha: committedSha,
      });
    },
  };
}
