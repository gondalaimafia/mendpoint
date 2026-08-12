import { createHash } from "node:crypto";
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
 * Derive a stable, hex commit identifier from the immutable commit inputs of an
 * exact-draft intent. GitLab's commit API does not surface a commit SHA through
 * the Wave B delivery interface, so delivery evidence uses this deterministic
 * digest of the exact base, branch, message, date, and sorted file tree. It is
 * shaped like a 64-char Git object id so the durable success record accepts it,
 * and it is identical on replay of the same sealed intent.
 */
function exactDraftCommitSha(input: ExactDraftDeliveryInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        baseSha: input.expectedBaseSha,
        branch: input.branch,
        message: input.commitMessage,
        date: input.commitDate,
        tree: [...input.files]
          .map((file) => ({ path: file.path, content: file.content, mode: file.mode }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Adapt a Wave B GitLabDelivery onto the exact-draft delivery contract used by
 * Transformer's approved-candidate delivery. The same sealed exact-draft intent
 * (branch, exact files, title/body) is delivered as a GitLab *draft* merge
 * request: create the source branch from the approved base, commit the exact
 * files, then open a draft merge request against the base branch. Delivery
 * fails closed if GitLab does not confirm the merge request is a draft; nothing
 * is merged and no branch is force-updated. This reuses GitLabDelivery rather
 * than rebuilding it, so the delivery worker stays delivery-interface-shaped.
 */
export function gitlabAsExactDraftDelivery(delivery: GitLabDelivery): ExactDraftDelivery {
  return {
    async deliverExactDraft(rawInput: ExactDraftDeliveryInput): Promise<ExactDraftDeliveryResult> {
      const input = validateExactDraftDeliveryInput(rawInput);
      const files: FileEdit[] = input.files.map((file) => ({
        path: file.path,
        content: file.content,
      }));
      await delivery.createBranch(input.owner, input.repo, input.branch, input.baseBranch);
      await delivery.commitFiles(input.owner, input.repo, input.branch, input.commitMessage, files);
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
        baseSha: input.expectedBaseSha,
        commitSha: exactDraftCommitSha(input),
      });
    },
  };
}
