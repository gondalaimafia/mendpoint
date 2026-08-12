# Transformer GitLab delivery (Stage T4a)

Transformer delivers an approved adaptive candidate as an exact draft: a source
branch, one deterministic commit of the exact sealed files, and a draft change
that a human reviews and merges. Stage T4a lets that same approved candidate be
delivered to a **GitLab** project as a draft merge request, as an alternative to
the default GitHub draft pull request. GitHub stays the default and is
unchanged when GitLab is not selected.

This document states exactly what exists so any public claim stays accurate. It
builds on the general GitLab delivery described in
[`GITLAB_DELIVERY.md`](./GITLAB_DELIVERY.md).

## What is delivered

For an approved candidate, delivery builds one provider-neutral exact-draft
intent: the target branch name, the exact files with their modes, a commit
message and date, and the review title and body. That intent is delivered as
either a GitHub draft pull request or a GitLab draft merge request. The review
evidence body, branch name, and file set are identical across providers; only
the destination changes.

On the GitLab side the exact-draft intent is applied with the Wave B
`GitLabDelivery` (`packages/github/src/gitlab.ts`):

1. `createBranch` creates the source branch from the approved base revision.
2. `commitFiles` commits the exact sealed files onto that branch.
3. `openDraftMergeRequest` opens a draft merge request against the base branch.

The adapter that maps the exact-draft intent onto those three calls is
`gitlabAsExactDraftDelivery` (`packages/github/src/gitlab-exact-draft.ts`). It
reuses `GitLabDelivery` rather than rebuilding delivery, so the delivery worker
stays shaped around a single `deliverExactDraft` call and barely changes.

### Draft-only and fail closed

Delivery accepts the result only when GitLab confirms the merge request is a
draft. If the returned merge request is not a draft, delivery raises
`gitlab_exact_draft_not_draft` and records a delivery failure instead of
reporting success. Nothing is merged and no branch is force-updated. Human
review and manual merge stay in force, the same as the GitHub path.

Because GitLab's commit API does not surface a commit SHA through the Wave B
delivery interface, the delivery evidence records a deterministic hex commit
identifier derived from the immutable commit inputs (base revision, branch,
message, date, and the sorted file tree). It is stable on replay of the same
sealed intent.

## Provider selection

Selection is driven by the existing `SCM_PROVIDER` configuration and wired where
the worker constructs the delivery for a `transformer.adaptive.deliver` job
(`transformerAdaptiveScmDelivery` in `apps/worker/src/cli.ts`):

- `SCM_PROVIDER` unset or `github`: the existing GitHub App / token delivery is
  used, byte for byte unchanged. A default deployment is unaffected.
- `SCM_PROVIDER=gitlab`: delivery routes to the GitLab draft-MR path built from
  `createGitLabDelivery()`, which returns the deterministic in-memory mock by
  default and the real HTTP client only when `GITLAB_MODE=real` and
  `GITLAB_TOKEN` are set.

The Warden candidate delivery path is not affected by this selector and stays on
GitHub.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `SCM_PROVIDER` | `gitlab` routes Transformer approved-candidate delivery to GitLab; unset or `github` keeps GitHub. | `github` |
| `GITLAB_MODE` | `real` selects the HTTP client; anything else uses the mock. | `mock` |
| `GITLAB_TOKEN` | Project, group, or personal access token, required for `real`. | none |
| `GITLAB_API_URL` | REST v4 base URL, for self-managed GitLab. | `https://gitlab.com/api/v4` |

This stage lands gated off. `MENDPOINT_TRANSFORMER_GATE` stays denied by default
and the customer-warden profile keeps Transformer off, so no candidate is
delivered anywhere until Transformer is explicitly enabled.

## What this is not

- **Not an org-wide GitLab App install.** This is token-authenticated draft
  merge-request delivery, the same scope as the general GitLab delivery. There
  is no hosted install, consent, or callback flow for GitLab. Access is a token
  supplied through configuration.
- **Not automatic merge.** Delivery is draft only. A human reviews and merges.
  This is intentional and permanent.
- **Not a change to the GitHub path.** When GitLab is not selected, GitHub
  delivery, its App and token enforcement, and the review-first, no-auto-merge
  model are unchanged.

## Summary for marketing

Transformer can deliver an approved candidate as a **token-authenticated draft
merge request** to a GitLab project on gitlab.com or a self-managed instance,
selected with `SCM_PROVIDER=gitlab`, with the same human-review-first,
no-auto-merge guarantees as the GitHub draft pull request. State it as "GitLab
draft merge-request delivery via access token," not as a hosted GitLab App
install.
