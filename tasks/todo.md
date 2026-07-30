# Mendpoint GA review

- [x] Confirm `main` and `origin/main` are at `8725ba4`.
- [x] Map the GA delta from `b843e0e` through `8725ba4`.
- [x] Audit API, authentication, and production controls.
- [x] Audit platform, harness, SCM, RBAC, and sandbox paths.
- [x] Audit graph learning, persistence, and incremental paths.
- [x] Audit CI, packaging, web status, and operational readiness.
- [x] Run build, typecheck, tests, and GA checks.
- [x] Validate every candidate finding against exact source lines.

## Review

Review outcome: do not treat `8725ba4` as production ready.

- The API aborts before listening because `@mendpoint/db` re-exports missing registry symbols.
- The web production build and monorepo typecheck fail.
- API key identity is discarded in favor of caller supplied role and tenant headers.
- Unsigned public webhooks and public GitHub App mutation routes can change state.
- Platform isolation, harness result reporting, SCM failure handling, and incremental graph deletion have release blocking defects.
- `npm test` and `npm run ga:check` pass, demonstrating that the current CI gate misses deployable artifact failures.

Full report: `C:\Users\Talal\Documents\Codex\2026-07-28\review\outputs\mendpoint-main-8725ba4-review.md`

## GA remediation

- [x] Create a dedicated remediation branch.
- [x] Restore API startup and fix all root type errors.
- [x] Bind RBAC and tenant identity to authenticated API keys and enforce scopes.
- [x] Require signed production webhooks and protect GitHub App mutation and inventory routes.
- [x] Add a safe first key bootstrap path.
- [x] Remove host shell injection and false VM isolation.
- [x] Preserve harness failures and propagate live SCM errors.
- [x] Fix capped incremental deletion and graph model/query consistency defects.
- [x] Make the production image self contained and writable.
- [x] Add root tests, build, typecheck, authenticated API startup, and container gates to CI.
- [x] Add regression tests for every reviewed failure path.
- [x] Run full tests, typecheck, build, authenticated API smoke, and GA verification.
- [x] Verify both container targets in GitHub Actions.
- [x] Review the final diff and commit without unrelated changes.

## Remediation review

Local verification is green:

- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run ga:check`, including 20 of 20 graph benchmark cases
- Production API bootstrap and startup with `API_AUTH=required`
- Authenticated `/keys` request returns 200
- Invalid API key and unsigned production webhook each return 401
- CI and Compose YAML parse successfully
- CI startup smoke passes Bash syntax validation
- GitHub Actions builds both API and web container targets
- `git diff --check`

Docker is not installed in the local environment. GitHub Actions completed both
the `api` and `web` target builds successfully.

## Whole repository debug

- [x] Reconfirm the current branch, upstream state, and clean baseline.
- [x] Run the complete test, typecheck, build, GA, demo, and dependency checks.
- [x] Exercise production API authentication, tenancy, webhook, and rate limits.
- [x] Exercise web proxy, standalone runtime, worker, CLI, and persistence paths.
- [x] Audit graph, harness, platform, SCM, and sandbox failure boundaries.
- [x] Reproduce suspected defects and identify their root causes.
- [x] Rerun the representative release matrix.
- [x] Record root causes, verification evidence, and deployment limits.

## Whole repository debug review

Diagnosis is complete. No product fixes were applied in this pass.

- Full tests, typecheck, build, and GA preflight pass.
- Targeted probes confirmed production blockers in tenant isolation, host command
  containment, the web credential proxy, release gates, and repair delivery.
- Additional defects were reproduced in job recovery, GitHub attribution,
  sandbox caching, catalog retry and validation, graph ingestion, SCM handling,
  demo data isolation, and runtime configuration.
- `npm audit --omit=dev` reports three high and one moderate production
  dependency findings.
- Docker remains unavailable locally, so the existing green GitHub container
  builds were not started in this pass.

Full report:
`C:\Users\Talal\Documents\Codex\2026-07-28\review\outputs\mendpoint-whole-repo-debug-2026-07-28.md`

## Whole repository remediation

- [x] Add required tenant ownership to request facing data and graph queries.
- [x] Complete route permission mapping, audit attribution, and two tenant tests.
- [x] Correct GitHub webhook identity, installation state, and tenant attribution.
- [x] Secure the web proxy and route plan editing through the protected boundary.
- [x] Remove caller controlled host paths and commands from tenant API operations.
- [x] Enforce real filesystem containment and honest sandbox capabilities.
- [x] Make job claims atomic, leased, recoverable, and tenant scoped.
- [x] Add worker topology and validate runtime configuration strictly.
- [x] Isolate demo data and make seed behavior idempotent.
- [x] Make orchestration, contract, harness, and repair delivery fail closed.
- [x] Repair catalog retries, OpenAPI validation, SCM validation, and graph correctness.
- [x] Resolve production dependency advisories without unsupported downgrades.
- [x] Add regression tests for every confirmed root cause.
- [x] Run focused regressions, full tests, typecheck, build, GA, and CI container gates.
- [x] Review the final diff, commit, push, and record production limits.

## Customer launch readiness

- [x] Recheck the full repository after remediation.
- [x] Repair the existing database upgrade path.
- [x] Repair the API to worker job contract.
- [x] Pass contract and security evidence through synchronous and queued pipelines.
- [x] Restrict production repositories to an authenticated tenant directory.
- [x] Block production feed SSRF, local file reads, unsafe redirects, and oversized bodies.
- [x] Require the PAT that the real delivery path actually uses.
- [x] Disable the incomplete GitHub App install path in production.
- [x] Protect the entire web surface with a server side session.
- [x] Add production dependency, build, runtime, auth, web session, and worker container gates.
- [x] Inspect available hosting and repository deployment credentials.
- [ ] Provision the isolated production host, TLS routes, durable mounts, backup job, and uptime checks.
- [ ] Add the customer scoped GitHub token, webhook secret, API key, and web access secret.
- [ ] Mount the approved customer repository and run the first real change to PR smoke.
- [ ] Browser verify the live web surface.

## Customer launch review

The code release gates pass locally. The supported first customer topology is one
isolated Linux host per customer with the web, API, and worker on the same host.
SQLite and repository mounts make a split or horizontally scaled deployment unsafe.

Fly access is available, but there is no existing Mendpoint app, no deploy manifest,
and no GitHub deployment secrets. A new Fly multi-machine deployment would separate
the shared SQLite database and repository filesystem, so it is not an acceptable
production target for this release.

Online provisioning remains blocked on an approved single-host target, public
hostnames, and customer-scoped secrets. These are external launch inputs, not code
failures, and must be supplied before a real customer repository can be connected.
