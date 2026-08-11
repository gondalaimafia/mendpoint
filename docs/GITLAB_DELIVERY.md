# GitLab delivery

Mendpoint can deliver a migration as a **draft merge request** to a GitLab
project, mirroring the GitHub draft pull-request delivery. A customer on GitLab
gets the same review-first output: a source branch, the migration commit, and a
draft merge request that a human reviews and merges. Nothing is merged
automatically and no branch is force-updated.

This document states exactly what exists today so that any public claim stays
accurate.

## What is supported

- **Draft merge-request delivery.** `GitLabDelivery` (in
  `packages/github/src/gitlab.ts`) creates a source branch, commits the
  migration files, and opens a draft merge request against the target branch.
  The draft state is set by prefixing the title with `Draft:`, which is how
  GitLab marks a merge request as a draft. A returned merge request is only
  accepted when GitLab confirms it is a draft.
- **Token authentication.** The real client authenticates with a project
  access token, group access token, or personal access token, sent as the
  `PRIVATE-TOKEN` header. This is what "org-wide install" reduces to for v1: a
  group access token scoped to the projects a group wants covered.
- **gitlab.com and self-managed GitLab.** The API base URL defaults to
  `https://gitlab.com/api/v4` and is overridable with `GITLAB_API_URL` for a
  self-managed instance.
- **Mock and real modes.** `createGitLabDelivery()` returns a deterministic
  in-memory `MockGitLabDelivery` by default and the real `HttpGitLabDelivery`
  only when `GITLAB_MODE=real` and `GITLAB_TOKEN` are set. This mirrors the
  GitHub `MockGitHubDelivery` / `OctokitGitHubDelivery` split.
- **Idempotent re-runs.** Creating a branch that already exists is treated as
  success, and opening a merge request for a source and target branch that
  already has one open returns the existing merge request instead of creating a
  duplicate.
- **Fail closed.** Every failed GitLab API call raises `GitLabDeliveryError`
  with the operation, status, and response body. Delivery never fabricates a
  merge request on error.
- **Provider selector.** `createReviewableChangeDelivery(provider)` returns the
  GitHub or GitLab adapter behind one shared `ReviewableChangeDelivery`
  contract (`createBranch`, `commitFiles`, `openPullRequest`). It defaults to
  GitHub, so all existing GitHub behavior is unchanged when GitLab is not
  configured. `SCM_PROVIDER=gitlab` selects GitLab.
- **Deterministic fixture for review controls.** `GitLabFixtureAdapter` (in
  `packages/platform/src/gitlab-fixture.ts`) models branches, commits, draft
  merge requests, pipeline status, discussions, self-approval refusal, and
  signed webhook receipt for tests, without a live token.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `GITLAB_MODE` | `real` selects the HTTP client; anything else uses the mock. | `mock` |
| `GITLAB_TOKEN` | Project, group, or personal access token (required for `real`). | none |
| `GITLAB_API_URL` | REST v4 base URL, for self-managed GitLab. | `https://gitlab.com/api/v4` |
| `SCM_PROVIDER` | Default provider for `createReviewableChangeDelivery()`. | `github` |

Namespace and project map to a GitLab project path. `createBranch`,
`commitFiles`, and `openDraftMergeRequest` take `(namespace, project, ...)`,
which becomes the URL-encoded project id `namespace/project`.

## What is not supported yet

- **Full GitLab App or OAuth install flow.** There is no hosted org-wide
  install, consent, or callback flow. Access is a token supplied through
  configuration. The GitHub side has a full App install lifecycle; GitLab does
  not.
- **Webhook ingestion into the pipeline.** The fixture can verify a signed
  GitLab webhook, but there is no live webhook endpoint wired into the running
  service for GitLab merge-request or pipeline events.
- **Group-level install management.** There is no UI or persistence for binding
  a GitLab group to a tenant, revoking access, or listing covered projects. The
  GitHub owner-to-tenant binding and installation records have no GitLab
  equivalent.
- **Pipeline routing for GitLab consumers.** `runChangePipeline` still resolves
  delivery through the GitHub-specific resolver (installation identity,
  `github_owner`, `github_repo`). GitLab draft-MR delivery is available today
  through the standalone `createGitLabDelivery` / `createReviewableChangeDelivery`
  factories, not yet by registering a GitLab consumer and running the full
  pipeline against it.
- **Automatic merge.** This is intentional and permanent. Delivery is draft
  only; a human reviews and merges.

## Summary for marketing

GitLab support today means **token-authenticated draft merge-request delivery**
to a GitLab project on gitlab.com or a self-managed instance, with the same
human-review-first, no-auto-merge guarantees as GitHub. It does **not** yet
mean a hosted org-wide GitLab App install, webhooks, or group management. State
it as "GitLab draft merge-request delivery via access token," not as full
parity with the GitHub App install experience.
