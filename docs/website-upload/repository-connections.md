# Repository connections

Authorize least-privilege source access and materialize immutable repository snapshots at exact revisions.

Status: GitHub production path
Availability: GitHub App pilot path. GitLab delivery is on the roadmap.
Last verified: 2026-08-14

## Start here

Install the Mendpoint GitHub App for an approved account and select the exact repositories it may access.

1. Create or open the GitHub App install URL.
2. Complete the installation callback for the tenant account.
3. Register the allowed repository and selected branch.
4. Materialize an exact immutable snapshot before any agent run.

## What it does

- Tenant-bound GitHub App installation and repository authorization
- Short-lived installation tokens restricted to selected repositories
- Exact commit resolution, immutable file manifests, modes, hashes, and retention
- Connection revocation and snapshot purge
- Generic SCM capability adapters for GitHub, GitLab, Bitbucket, and Azure DevOps

## When to use it

- Fettler or Regauge needs authoritative source bytes.
- A repository must be read without storing a long-lived user token.
- A later worker must reconstruct the exact prior source state.

## How it works

1. An authenticated tenant administrator authorizes a GitHub account and selected repositories.
2. Mendpoint exchanges App authority for repository-scoped installation tokens.
3. The snapshot service resolves one revision, materializes bounded files, and persists an immutable manifest.
4. Agents receive snapshot bindings, not an unrestricted repository handle.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| GET /github/app/install-url | API | Start a GitHub App installation. |
| POST /github/app/callback | API | Bind the installation to the authenticated tenant. |
| POST /platform/scm/repositories | API | Register an approved repository. |
| POST /platform/scm/repositories/:id/snapshots | API | Materialize an exact snapshot. |
| POST /platform/scm/connections/:id/revoke | API | Revoke a connection. |

## Evidence and verification

- GitHub App lifecycle: `packages/github/src/app-lifecycle.test.ts`
- Repository source: `packages/platform/src/repository-source.test.ts`
- Connection API: `apps/api/src/repository-connections.test.ts`

## Safety model

- Tenant, account, installation, repository, and remote repository IDs must agree.
- Snapshot paths, symlinks, file sizes, modes, hashes, and totals are validated.
- Tokens are scoped, short-lived, and never embedded in snapshot artifacts.

## Limitations

- The main hosted demo uses mock GitHub; real delivery requires a customer or dedicated profile with App credentials.
- End to end GitLab onboarding, checkout, delivery, review, and revocation are not available.
- Bitbucket and Azure DevOps remain partial adapters.

## See also

- [Draft delivery](./draft-delivery.md)
- [Security and governance](./security-governance.md)
- [Fettler — the first AI API Engineer](./fettler.md)
- [Regauge — the first AI Legacy Engineer](./regauge.md)
