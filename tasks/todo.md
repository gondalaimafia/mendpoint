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
- `npm run ga:check`, including the required graph benchmark threshold
- Production API bootstrap and startup with `API_AUTH=required`
- Authenticated `/keys` request returns 200
- Invalid API key and unsigned production webhook each return 401
- CI and Compose YAML parse successfully
- CI startup smoke passes Bash syntax validation
- GitHub Actions builds the API, web, and worker container targets
- GitHub Actions run 30589321642 passes the combined production startup smoke
- `git diff --check`

Docker is not installed in the local environment. GitHub Actions run 30589321642
built all three production targets and passed the combined API, authenticated
web session, protected proxy, and worker startup smoke.

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

The code release gates pass locally and in GitHub Actions run 30589321642. The
supported first customer topology is one isolated Linux host per customer with
the web, API, and worker on the same host. SQLite and repository mounts make a
split or horizontally scaled deployment unsafe.

Fly access is available, but there is no existing Mendpoint app, no deploy manifest,
and no GitHub deployment secrets. A new Fly multi-machine deployment would separate
the shared SQLite database and repository filesystem, so it is not an acceptable
production target for this release.

Online provisioning remains blocked on an approved single-host target, public
hostnames, and customer-scoped secrets. These are external launch inputs, not code
failures, and must be supplied before a real customer repository can be connected.

## YC customer readiness and online pilot

- [x] Reconcile the one pager and YC application promises with the live product path.
- [x] Make GitHub delivery create reviewable draft PRs and allow safe failed-run retries.
- [x] Make verification fail closed when no approved command profile is configured.
- [x] Run queued work in one persistent worker with a durable heartbeat.
- [x] Add an idempotent secret-backed API key bootstrap for first deployment.
- [x] Add a single-Machine Fly runtime for web, API, and worker over one volume.
- [x] Expose only public health, access, and signed GitHub webhook routes.
- [x] Add focused regressions and extend the production container CI gate.
- [x] Run the full release matrix and review the final diff.
- [x] Provision the Fly app and volume, deploy the branch, and verify the live surface.
- [x] Update the customer readiness report with closed gaps and external blockers.
- [x] Commit and push all implementation and evidence.

## YC customer readiness review

Mendpoint is online at `https://mendpoint-talal.fly.dev` as a design partner
pilot. Fly runs one Machine in `sjc` with one encrypted 20 GB volume and a
passing health check. The health route verifies API readiness, API key access,
and a fresh worker heartbeat. Signed webhook verification passed for invalid,
valid, and duplicate deliveries. Browser login reached the authenticated home
page with no console warnings or errors.

All repository tests, typechecks, the production build, the GA check, and the
production dependency audit pass. GitHub Actions run 30604903683 passes tests,
release gates, all container builds, and the combined Fly runtime smoke.

The deployment remains a demo, not a first customer environment:
`GITHUB_MODE=mock`, fixture feed polling is disabled, and no customer repository
or scoped token was supplied. Immutable repository synchronization, internally
produced contract and security evidence, a real draft pull request canary, and
an off host restore drill remain P0 launch gates. The current gap report is
`C:\Users\Talal\Documents\Codex\2026-07-28\review\outputs\mendpoint-customer-readiness-gap-2026-07-30.md`.

## Self healing control plane

- [x] Require an approved or safely discovered verifier before Warden or repair can succeed.
- [x] Roll back every failed Warden and repair mutation to the exact pre-run checkout.
- [x] Enforce repository containment, symlink rejection, attempt bounds, edit bounds, and no-progress stops.
- [x] Persist due times, retry classes, dead-letter state, and fenced lease generations for jobs.
- [x] Renew active leases and reject completion from stale workers.
- [x] Continue past poison jobs while applying durable exponential retry delays.
- [x] Expose tenant-safe recovery summaries, sanitized job state, retry, and cancellation controls.
- [x] Show recovery state and bounded automation policy in the authenticated web product.
- [x] Separate process liveness from operational recovery degradation.
- [x] Remove force-reset behavior from existing GitHub recovery branches.
- [x] Add regressions for rollback, verifier absence, traversal, no progress, backoff, dead letter, fencing, and replay.
- [x] Run the full release matrix, review the final diff, commit, push, deploy, and verify live.

## Self healing acceptance criteria

- A failed or unverified automated run leaves the customer checkout byte for byte unchanged.
- An automated run cannot report success without an approved verification command passing.
- Repair stops on repeated failure fingerprints, repeated patches, policy violations, or exhausted bounded budgets.
- Only the current lease generation can renew, complete, or fail a running job.
- Retryable failures receive a persisted future due time. Terminal or exhausted failures enter dead letter.
- A poison job cannot block later due work.
- Owners can retry or cancel eligible work without seeing raw payloads or host filesystem paths.
- Health distinguishes an alive process from queued recovery work that needs attention.
- All generated GitHub changes remain reviewable drafts. Self healing never merges.

## Self healing review

Local implementation and verification are complete.

- Warden and repair run through the durable worker in production. The legacy
  inline executor was removed.
- Failed, cancelled, stale lease, and unverified mutations roll back. Verified
  mutations remain in the tenant checkout and are never merged automatically.
- Claims use due times, renewable leases, generation fences, bounded retry
  backoff, cancellation, and dead letter state.
- The worker continues after poison jobs and reports active work plus recovery
  counts in its heartbeat.
- Process liveness checks the web, API, and worker without conflating a dead
  letter with a crashed process. Operational health still reports recovery
  degradation.
- Recovery actions require tenant administration permission. API responses do
  not expose job payloads or host repository paths.
- Production verifier execution fails closed. A read only root `check.mjs`,
  `check.cjs`, or `check.js` runs with a scrubbed environment and Node
  filesystem permissions. Arbitrary repository scripts require a separate
  isolated runner and remain disabled by default.
- The pilot fixture includes a protected verifier. The startup migration adds
  it only when it is missing.
- Existing GitHub recovery branches are never reset. A retry proceeds only when
  the branch contents already match the intended patch; divergent work requires
  human reconciliation.

Verification:

- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run ga:check`
- `npm audit --omit=dev`
- Production API startup smoke with `/ready` and `/health` returning 200
- `git diff --check`

Docker is not installed locally. Container verification passed in GitHub
Actions and the Fly deployment build before live promotion.

## End to end deployment gate

- [x] Define deterministic critical journeys across access, session, API, worker, persistence, recovery, and webhooks.
- [x] Add a production combined runtime harness with bounded waits and isolated test state.
- [x] Add browser assertions for access control, authenticated status, and recovery visibility.
- [x] Add API assertions for tenant authentication, queue completion, retry controls, and sanitized results.
- [x] Add signed webhook assertions for invalid signatures, completed delivery replay, and duplicate suppression.
- [x] Retain traces, screenshots, runtime logs, and machine readable results on CI failure.
- [x] Make the suite a required CI dependency before the production deploy job can run.
- [x] Run the suite locally where supported, in GitHub Actions, and against the deployed pilot.

## End to end acceptance criteria

- The suite starts the exact combined production image used by Fly.
- Unauthenticated protected pages redirect to access and invalid API credentials fail.
- A valid server side web session reaches authenticated status without exposing the API key.
- The worker claims and completes a real queued job, with bounded polling and durable state.
- Recovery responses contain no job payloads, host paths, source content, or verifier logs.
- Invalid webhook signatures fail and repeated completed delivery IDs do not repeat side effects.
- Liveness remains available while operational health reports recovery degradation accurately.
- A failing assertion prevents deployment and uploads enough evidence to reproduce the failure.

## End to end deployment gate review

Playwright discovers one serial critical journey against the exact combined Fly
image. It covers production operator login, protected API behavior, secure
server side session state, signed webhook validation and replay, browser queued
repair, operator cancellation and retry, forced container loss, durable volume
recovery, worker completion, sanitized job responses, and recovery visibility.

The job uploads browser traces, screenshots, video, JUnit output, and runtime
logs on failure. Production deployment from main depends on all unit, type,
build, audit, container, and Playwright jobs. Local Docker is unavailable, so
the production image journey ran on the GitHub Linux runner. Run 30667255540
passed the exact Fly image journey in 1 minute 55 seconds and all other release
jobs. The same revision was deployed to the pilot.

Webhook processing failure recovery is covered below the HTTP boundary because
there is no production fault injection endpoint. Adding such an endpoint would
weaken the deployed surface. Post deployment verification remains read only so
the pilot cannot accumulate synthetic customer work.

Live verification returned 200 from `/livez` and `/healthz`, with API readiness,
API authentication, a fresh worker heartbeat, and no dead letters or expired
leases. The authenticated status page rendered the recovery panel with no
browser console warnings or errors. The saved screenshot is
`C:\Users\Talal\.codex\visualizations\2026\07\28\019faa95-ac3a-7743-af3d-4dcfed07ca3a\mendpoint-live-status-2026-07-31.png`.

The original pilot web access token appeared in a browser DOM snapshot during
verification and was rotated immediately. The exposed value is invalid. The
replacement was used only in memory and did not appear in output or a saved
artifact.

## Devin inspired UX and performance pass

- [x] Research the latest official Cognition and Devin interaction patterns.
- [x] Audit the current Mendpoint journeys, information architecture, accessibility, and rendering cost.
- [x] Replace the flat navigation with a task oriented workspace shell that remains usable on mobile.
- [x] Turn the home page into an operational command center with clear attention, activity, and action states.
- [x] Standardize page hierarchy, status language, empty states, tables, and responsive behavior.
- [x] Reduce unnecessary route prefetching and rendering work without hiding live operational state.
- [x] Add regression coverage for the new shell and critical command center states.
- [x] Run typecheck, tests, production build, release checks, accessibility checks, and browser verification.
- [x] Commit, push, deploy through the existing gate, and verify production health.

## UX and performance acceptance criteria

- The first screen answers what needs attention, what is running, and what the operator can do next.
- Core workflows are grouped by intent instead of presented as an undifferentiated list.
- Every operational state has visible text, not color alone, and every interactive control has a keyboard focus state.
- Desktop navigation stays persistent while narrow screens receive a compact, scrollable workspace bar.
- Long lists and below fold panels avoid unnecessary initial paint work.
- Navigation does not prefetch every dynamic operational route on initial load.
- Loading and failure states keep the shell stable and provide a recovery action.
- Existing authentication, recovery controls, and deployment E2E behavior remain intact.

## UX and performance review

The operator workspace now leads with attention, current work, evidence, and a
single next action. Navigation is grouped by operator intent and remains usable
at a 375 pixel viewport without document overflow. Loading and failure
boundaries preserve the shell, tables expose accessible names, and the release
browser test now rejects serious or critical WCAG A and AA violations.

Job polling now requests one sanitized job record instead of repeatedly loading
the latest 50 jobs. Independent server reads run concurrently, provider pull
request matching uses an indexed lookup, and graph retries receive the newly
created retry identifier. The shared client bundle remained 103 kB before and
after the pass.

Local evidence: full tests, full typecheck, production build, GA preflight,
Playwright discovery, dependency audit, desktop browser review, and 375 pixel
browser review passed. Pull request 2 merged after all release jobs passed. Main
run 30716051102 passed the exact container journey, deployed the pilot, and
verified production health. Direct live checks returned 200 from `/livez` and
`/healthz`. The public root redirected to access as designed, with no browser
console warnings, errors, or document overflow at the desktop viewport.

## Warden and Transformer capability training

- [x] Research current primary standards and real world failure patterns for API repair and multi repository migrations.
- [x] Inventory existing Warden, Transformer, and evaluation behavior against the researched taxonomy.
- [x] Define a versioned corpus of common, edge, adversarial, recovery, and safety scenarios.
- [x] Train Warden behavior through generalized diagnosis and repair policies backed by deterministic scenarios.
- [x] Train Transformer behavior through dependency aware planning, compatibility, rollout, rollback, and resume scenarios.
- [x] Add capability, regression, and safety evaluators with release thresholds and actionable reports.
- [x] Wire deterministic critical scenarios into the release gate without requiring live model credentials.
- [x] Run focused tests, full tests, typecheck, build, GA preflight, audit, and container E2E.
- [x] Commit, push, deploy through the protected release path, and verify production health.

## Warden and Transformer capability acceptance criteria

- Common and edge scenarios are traceable to current primary sources or observed repository behavior.
- Every scenario has explicit expected evidence, safe action, refusal boundary, and recovery behavior.
- Critical safety failures score zero and fail the release gate even when aggregate quality passes.
- Evaluation is deterministic in CI and mirrors the production policy and repair path.
- Warden does not propose speculative edits without evidence or bypass verification and policy gates.
- Transformer plans preserve dependency order, compatibility windows, resumability, approvals, and rollback.
- Reports separate unsupported capability from regression, infrastructure failure, and model variance.

## Warden and Transformer capability review

Research and implementation are complete. The versioned corpus contains 102
deterministic cases: 55 for Warden and 47 for Transformer. The Warden set maps
all 50 known failure modes and five end to end repository cases. The Transformer
set maps 32 compatibility rules plus 15 graph and differential behaviors.

Warden now treats issue text, logs, source, and tool output as untrusted. It
redacts secrets before model calls, validates model tool output, protects tests,
verifiers, fixtures, snapshots, and package manifests from generated edits, and
blocks private network, metadata, mutating, and unsafe redirect probes. Repairs
that cannot be proven locally produce an explicit safe handoff instead of a
speculative patch. The strict repository benchmark requires all five cases to
pass and enforces expected outcome, diagnosis, allowed files, forbidden files,
and bounded execution time.

Transformer now rejects malformed dependency graphs, produces deterministic
topological plans and stable repository assignments, covers every node exactly
once, serializes work for the same repository, and compares JSON like outputs
structurally. Compatibility classification spans source, wire, semantic, state,
security, and operational behavior across REST, GraphQL, protobuf, databases,
dependencies, runtimes, Kubernetes, Terraform, webhooks, and OAuth. Campaign
input limits and graph validation live at the domain boundary; invalid API
requests return a client error.

The CI capability gate has no model or network dependency and fails on any
corpus regression or critical safety failure. Pull request 3 passed unit tests,
the capability gate, GA preflight, audit, typecheck, production build, API
startup smoke, all production container builds, and the Playwright production
journey with crash recovery. Main run 30717940803 deployed commit `ac5cb4d` and
passed its production health step.

Direct live verification returned 200 from `/livez` and `/healthz`. API
readiness, API authentication, and the worker were healthy, with no active job,
due recovery work, scheduled recovery work, dead letters, or expired leases.
The public root returned the intended 307 redirect to access. Browser review
rendered the operator access page with no console logs. Evidence is saved at
`C:\Users\Talal\.codex\visualizations\2026\07\28\019faa95-ac3a-7743-af3d-4dcfed07ca3a\mendpoint-warden-transformer-live-2026-08-01.png`.

## Foundational product specification closure

Source of truth: `C:\Users\Talal\Downloads\mendpoint_product_spec.md`

Execution contract: `C:\Users\Talal\Documents\Codex\2026-07-28\review\outputs\mendpoint-foundational-spec-gap-analysis-and-plan-2026-08-01.md`

### Gate 0: Testable product contract

- [x] Version the complete foundational specification in the repository and mark the compressed predecessor as superseded.
- [x] Assign stable requirement IDs and one release tier, owner, status, and acceptance evidence definition to every requirement.
- [x] Define source artifact, change, repository snapshot, impact, candidate edit, verification, pull request, review, job, campaign, and usage state machines.
- [x] Add the metric dictionary, workload tiers, performance objectives, and explicit open product decisions.
- [x] Add deterministic traceability validation and make it part of the release checks.
- [x] Verify every foundational requirement maps to an executable test, an external evidence gate, or an approved later tier.

### Gate 1: Customer trust foundation

- [ ] Add attributable human and service actor identities without weakening existing API key authentication.
- [ ] Make immutable source, snapshot, evidence, verification, candidate, review, artifact, and typed event contracts tenant scoped.
- [ ] Add audit correlation, causation, integrity chaining, retention, and replay verification.
- [ ] Add a credential provider abstraction with rotation, expiry, revocation, and access audit boundaries.
- [ ] Add adversarial tenant isolation tests across API, queue, database, graph, artifacts, snapshots, webhooks, caches, and logs.

### Gate 2: Production repository connections

- [ ] Add an SCM neutral installation, repository, branch, exact commit snapshot, environment, ownership, and health model.
- [ ] Add isolated exact commit checkout with branch drift, submodule, LFS, sparse checkout, retention, and deletion policies.
- [ ] Bind GitHub App installation credentials to snapshot and draft pull request delivery.
- [ ] Discover and version CODEOWNERS, protected branch expectations, CI definitions, and approved verification commands.
- [ ] Report configured, authenticated, read, write, webhook, CI, sync, delivery, and revocation health independently.
- [ ] Wire GitLab through the same contract after the GitHub canary path is stable.
- [ ] Prove a clean private canary connection to verified draft pull request flow with real credentials.

### Gate 3: Safe Warden remediation

- [ ] Unify uploads, polls, releases, SDK registries, announcements, and incidents into immutable source artifacts.
- [ ] Complete the versioned compatibility taxonomy and evidence preserving ingestion adapters.
- [ ] Add payments first signed recipes with semantic edits, preconditions, postconditions, rollback, and outcome telemetry.
- [ ] Add versioned graph snapshots, complete bounded dependency paths, evidence provenance, coverage, and held out benchmarks.
- [ ] Persist baseline and post edit compile, lint, test, security, and contract verification artifacts.
- [ ] Fail pull request delivery closed unless verification passes or an attributable scoped expiring waiver is approved.
- [ ] Deliver a structured pull request package with source, snapshot, finding, edit, verification, policy, owner, and rollback links.

### Gate 4: Warden review and campaign operations

- [ ] Add reviewer assignment, comments, approve, reject, request changes, regenerate, waiver, expiry, and immutable candidate versions.
- [ ] Reconcile native SCM reviews, checks, merges, closures, and branch drift.
- [ ] Add durable campaigns, targets, dependency order, stages, attempts, exceptions, owners, concurrency, pause, resume, cancel, retry, rollback, and completion policy.
- [ ] Add exact Warden metric events, definitions, data quality tests, and support telemetry.
- [ ] Complete a consented payments or fintech design partner run, including rollback drill and observed outcome.

### Gate 5: Transformer control plane

- [ ] Select and declare one bounded first migration across two to five repositories.
- [ ] Freeze and persist task, blueprint, behavioral specification graph, recipe, evidence, campaign, unit, wave, attempt, artifact, approval, exception, pull request, and event contracts.
- [ ] Extract a nonempty source linked behavioral specification graph from code, tests, schemas, traces, and approved human additions.
- [ ] Ingest organization conventions with explicit precedence and evidence.
- [ ] Generate a reviewable blueprint with risks, unknowns, owners, verification coverage, rollback, and approval gating.
- [ ] Add durable Transformer blueprint and campaign workspaces.

### Gate 6: Governed Transformer execution

- [ ] Implement one executable versioned migration recipe in isolated repository workspaces.
- [ ] Execute fenced jobs and stage verified draft pull requests by dependency wave.
- [ ] Reconcile webhooks and support pause, resume, retry, exception, drift, partial merge, and exactly once recovery.
- [ ] Generate and execute reverse dependency rollback plans.
- [ ] Pass a three repository real campaign with injected crash, CI failure, drift, partial merge, and verified rollback evidence.

### Gate 7: Shared vertical router

- [ ] Use one structured task specification across Warden and Transformer.
- [ ] Add a versioned executor registry for rules, recipes, open models, adapters, and frontier models.
- [ ] Enforce tenant privacy, region, risk, quality, latency, and budget policy on every route and fallback.
- [ ] Add typed fallback, limits, circuit breakers, redaction, validation, human handoff, and deterministic replay.
- [ ] Persist decision rationale, actual cost, latency, retries, fallback, verification, and outcome.
- [ ] Pass held out quality, outage, security, fail closed, and accepted output cost gates.

### Gate 8: Governed learning and adapter lifecycle

- [ ] Persist proposed and accepted patches, reviewer deltas, comments, verification, regressions, routes, recipes, and costs.
- [ ] Add opt in consent, provenance, redaction, deletion, residency, temporal split, contamination, and dataset version controls.
- [ ] Add model and adapter artifact, license, lineage, evaluation, shadow, canary, promotion, monitoring, rollback, and retirement contracts.
- [ ] Require a consented representative data sufficiency gate before training.
- [ ] Prove the first adapter improves verified acceptance cost without a security regression.

### Gate 9: Economics and billing

- [ ] Define a versioned migration compute unit formula and price change policy.
- [ ] Add idempotent reservation, settlement, adjustment, credit, quota, entitlement, invoice reference, and reconciliation ledgers.
- [ ] Add contract pricing, invoice export or payment processor integration, taxes, credits, payment state, and dunning policy.
- [ ] Add customer usage and finance gross margin views with independently reproducible invoice lines.

### Gate 10: Enterprise release tier

- [ ] Finish supported self hosted sizing, TLS, upgrade, migration, backup, restore, rollback, monitoring, air gap, and support lifecycle.
- [ ] Add horizontally safe cloud queue, quota, lock, control plane, performance, load, soak, and outage behavior.
- [ ] Build a VPC reference architecture with private connectivity, network policy, BYOK, residency, and customer logs.
- [ ] Add human login, SSO, SCIM, policy packs, customer managed keys, and enterprise audit exports.
- [ ] Add privacy, security, resilience, vulnerability, SBOM, penetration, incident, continuity, and SOC 2 evidence controls.
- [ ] Pass an enterprise security review using generated evidence.

### Release and deployment

- [ ] Keep every external dependency explicit: private canary, design partner, payment account, SSO tenant, consented dataset, cloud infrastructure, penetration test, and compliance attestation.
- [ ] Land each coherent gate slice as a separate verified commit.
- [ ] Run focused tests after each slice and the full test, typecheck, build, GA, audit, API smoke, container, and deployment journey before merge.
- [ ] Push a pull request, require protected CI, merge only passing code, wait for the production deployment, then verify live health and the affected browser journeys.
- [ ] Record exact commits, checks, live probes, screenshots, unresolved external gates, and rollback instructions in this review section.

### Foundational closure review

Gate 0 implementation is complete pending the full repository matrix and protected CI. The canonical specification is versioned with a pinned digest. The machine register contains all 84 closure requirements with stable IDs, gap lineage, owner, target release, current availability and implementation state, acceptance assertion, evidence state, workstream, claim boundary, and named external blockers. The release contract freezes product tiers, shared state machines, metric definitions, workload objectives, the initial MCU formula, learning governance, and open external decisions.

`npm run spec:check` validates the manifest, exact ID inventory, workstream references, acceptance and evidence lineage, release and claim consistency, evidence paths, and canonical specification digest. `npm run ga:check` invokes this validator. The existing CI deployment job depends on the release gate, so contract drift blocks deployment without a deploy workflow change.

No later gate is complete yet. Code scaffolds and fixture only tests do not close customer proof, billing, identity provider, model training, infrastructure, security review, or compliance gates.
