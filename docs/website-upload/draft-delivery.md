# Draft delivery

Publish one exact, review-first source change to a draft pull request and reconcile uncertain responses without duplicate delivery.

Status: GitHub production path
Availability: GitHub draft delivery for approved pilot repositories. GitLab delivery is on the roadmap.
Last verified: 2026-08-14

## Start here

Approve a sealed candidate whose source, files, verification, and target repository still match current authority.

1. Review the candidate and verification evidence.
2. Record a fresh human approval bound to the exact candidate and head.
3. Authorize deterministic draft delivery.
4. Observe the remote draft and reconcile exact branch, commit, and pull request evidence.

## What it does

- Exact-base branch creation and content-addressed Git commits
- File bytes and executable mode preservation
- Draft-only pull request creation
- Same-request replay, response-loss adoption, and drift rejection
- Required-check observation and bounded same-branch Fettler repair after fresh approval

## When to use it

- A verified candidate is ready for human code review.
- A worker may crash after a remote write.
- A failed CI head needs one approved same-branch repair.

## How it works

1. The delivery intent binds repository, base SHA, branch, commit tree, candidate digest, and approval.
2. The GitHub App creates or adopts the exact commit and draft pull request.
3. A post-read verifies remote identity and bytes before local completion.
4. Uncertain writes enter read-only reconciliation; divergent state pauses for human review.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| Exact draft intent | Artifact | Repository, base, branch, tree, commit, PR, approval, and idempotency binding. |
| Draft delivered | Event | Immutable commit and pull-request evidence. |
| Draft observed | Event | Required checks, review state, and exact head evidence. |
| POST /agent/ci-cycles/:id/pause | API | Stop new Fettler CI repair authority. |

## Evidence and verification

- Exact GitHub draft: `packages/github/src/index.test.ts`
- Existing draft update: `packages/github/src/exact-draft-update.test.ts`
- Draft observation: `packages/github/src/exact-draft-observer.test.ts`

## Safety model

- Delivery is draft-only and cannot merge or deploy.
- Human approval is candidate-specific and expires on changed authority.
- The final remote side effect requires a current lease, pause state, expected head, and one-use intent.

## Limitations

- GitHub review comments are observed only as limited state today; full requested-change feedback reentry is next work.
- Production availability depends on App permissions and exact tenant-repository installation binding.
- Cross-SCM feature parity is not complete.

## See also

- [Repository connections](./repository-connections.md)
- [Verification and attestations](./verification-attestations.md)
- [Fettler — the first AI API Engineer](./fettler.md)
- [Regauge — the first AI Legacy Engineer](./regauge.md)
