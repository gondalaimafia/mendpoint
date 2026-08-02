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
- [x] Add a credential provider abstraction with rotation, expiry, revocation, and access audit boundaries.
- [ ] Add adversarial tenant isolation tests across API, queue, database, graph, artifacts, snapshots, webhooks, caches, and logs.

### Gate 2: Production repository connections

- [x] Add an SCM neutral installation, repository, branch, exact commit snapshot, environment, ownership, and health model.
- [x] Add isolated exact commit checkout with branch drift, submodule, LFS, sparse checkout, retention, and deletion policies.
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
- [x] Fail pull request delivery closed unless verification passes or an attributable scoped expiring waiver is approved.
- [ ] Deliver a structured pull request package with source, snapshot, finding, edit, verification, policy, owner, and rollback links.

### Gate 4: Warden review and campaign operations

- [ ] Add reviewer assignment, comments, approve, reject, request changes, regenerate, waiver, expiry, and immutable candidate versions.
- [ ] Reconcile native SCM reviews, checks, merges, closures, and branch drift.
- [x] Add durable campaigns, targets, dependency order, stages, attempts, exceptions, owners, concurrency, pause, resume, cancel, retry, rollback, and completion policy.
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
- [x] Add opt in consent, provenance, redaction, deletion, residency, temporal split, contamination, and dataset version controls.
- [ ] Add model and adapter artifact, license, lineage, evaluation, shadow, canary, promotion, monitoring, rollback, and retirement contracts.
- [ ] Require a consented representative data sufficiency gate before training.
- [ ] Prove the first adapter improves verified acceptance cost without a security regression.

### Gate 9: Economics and billing

- [ ] Define a versioned migration compute unit formula and price change policy.
- [x] Add idempotent reservation, settlement, adjustment, credit, quota, entitlement, invoice reference, and reconciliation ledgers.
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

- [x] Keep every external dependency explicit: private canary, design partner, payment account, SSO tenant, consented dataset, cloud infrastructure, penetration test, and compliance attestation.
- [x] Land each coherent gate slice as a separate verified commit.
- [x] Run focused tests after each slice and the full test, typecheck, build, GA, audit, API smoke, container, and deployment journey before merge.
- [x] Push a pull request, require protected CI, merge only passing code, wait for the production deployment, then verify live health and the affected browser journeys.
- [x] Record exact commits, checks, live probes, screenshots, unresolved external gates, and rollback instructions in this review section.

### Foundational closure review

Gate 0 implementation is complete pending the full repository matrix and protected CI. The canonical specification is versioned with a pinned digest. The machine register contains all 84 closure requirements with stable IDs, gap lineage, owner, target release, current availability and implementation state, acceptance assertion, evidence state, workstream, claim boundary, and named external blockers. The release contract freezes product tiers, shared state machines, metric definitions, workload objectives, the initial MCU formula, learning governance, and open external decisions.

`npm run spec:check` validates the manifest, exact ID inventory, workstream references, acceptance and evidence lineage, release and claim consistency, evidence paths, and canonical specification digest. `npm run ga:check` invokes this validator. The existing CI deployment job depends on the release gate, so contract drift blocks deployment without a deploy workflow change.

No later gate is complete yet. Code scaffolds and fixture only tests do not close customer proof, billing, identity provider, model training, infrastructure, security review, or compliance gates.

Gate 1 and Gate 2 safety slice in progress:

- Added tenant scoped human, service, API key, and webhook principal contracts.
- Added immutable artifact, evidence, review, and typed domain event records with tenant ownership and append only database enforcement.
- Added per tenant sequence and SHA 256 integrity chains for domain events and the existing audit ledger, including legacy row migration, conflicting replay rejection, and integrity verification.
- Wired Warden source OpenAPI documents, candidate edits, verification bundles, evidence records, service attribution, and status transitions into the immutable trust store.
- Removed fabricated passing CI evidence. Missing verifier evidence now fails closed.
- Scoped graph query, natural language query execution, pattern promotion, and GNN export to the authenticated tenant graph view.
- Preserved divergent GitHub App recovery branches for human reconciliation and used the connected repository default branch for delivery.

Focused evidence: database trust tests, legacy audit migration, Warden pipeline evidence assertions, API CI evidence tests, GitHub App recovery tests, graph tenant isolation tests, and all affected package typechecks pass. The gates remain open for full human session and membership identity, complete storage boundary isolation, snapshot deletion enforcement, remote GitHub and GitLab snapshot adapters, and a private canary.

Gate 1 to Gate 3 implementation update:

- Added an audited credential broker with provider references, audience checks, expiry, immutable revocation metadata, rotation state, redacted material, and fail closed audit behavior.
- Added a provider neutral repository source contract and a deterministic local Git provider with exact SHA resolution, branch drift checks, content hashed read only snapshots, and explicit dirty worktree, submodule, LFS, symlink, traversal, collision, mutation, and size policies.
- Added tenant scoped connection, repository, snapshot, discovered policy, and capability health persistence. API responses omit credentials and local storage paths.
- Added admin protected repository connection APIs and replaced the static platform readiness claim with observed per capability status.
- Added complete bounded dependency path enumeration with stable ordering, cycle terminals, tenant isolation, and explicit truncation evidence.
- A local Git integration canary passes from clean repository through exact commit snapshot, ownership and CI discovery, persistence, consumer binding, and truthful platform health. Real GitHub and GitLab snapshot adapters and a private customer canary remain external acceptance gates.
- Snapshot retention now uses append only planned, deleted, and failed lifecycle events. Purge revalidates the exact tenant destination before changing filesystem state, records attributable outcomes, preserves metadata evidence, and can retry interrupted failures. Sparse path policy is part of the content manifest and persisted snapshot contract.
- Warden delivery now accepts only a signed, human attributed waiver bound to the exact tenant, run, and verification check while it is active. The canonical waiver is persisted as an immutable artifact, the evidence verdict is explicitly waived, wrong scope or tampering fails closed, and an expired waiver is rechecked before each customer delivery.
- Transformer now has a forward migrated SQLite control plane with immutable revisions and events for campaigns, blueprints, BSGs, units, waves, attempts, approvals, exceptions, artifacts, and pull requests. It survives restart, isolates identical IDs across tenants, requires attributable approval transitions, and blocks execution until a reviewed blueprint and nonempty locked BSG are present. The shared task, recipe, evidence, organization profile, execution engine, and real campaign proof remain open.
- The shared router now has a structured task and policy snapshot, deterministic executor selection, privacy, region, risk, quality, latency, and budget filters, provider and executor circuit breakers, policy bound fallbacks, and mandatory human handoff. Adversarial tests cover outage, exhausted budget, privacy bypass, policy weakening, malformed runtime input, and deterministic replay. Durable ledgers and Warden plus Transformer integration remain open.
- The operator console now issues HMAC signed, eight hour sessions carrying a validated operator ID. Its API bridge binds that operator, request ID, method, and path to every upstream request, and the API rejects expired, tampered, replayed, or malformed delegation. This is accountable shared secret operator attribution, not enterprise human authentication; independent login, membership, SSO, and SCIM remain open.
- Pull request review actions now require a delegated human identity, bind approve, reject, request changes, and regenerate decisions to the latest immutable candidate, preserve a supersession chain, and append an attributed domain event and audit record. The consumer review page exposes rationale and immutable history. Reviewer assignment, comments, native SCM reconciliation, and the separately signed expiring waiver workflow remain open.
- Economics now has the versioned MCU v1 calculator, immutable tenant price versions and period entitlements, atomic quota reservation, idempotent settlement and release, adjustments, credits, invoice references, hash chained ledger integrity, reconciliation, attributable API mutations, and a tenant customer usage view. Formula change control and examples, reservation expiry, component actual evidence, processor or invoice export integration, tax and dunning policy, provider COGS, and the finance margin view remain open.
- Warden now has a strict content addressed structured pull request package contract linking tenant scoped source, exact snapshot, findings, candidate lineage, verification, generation, policy, ownership, review, and rollback evidence. Durable campaigns persist targets, dependency order, attempt limits, owned exceptions, optimistic revisions, concurrency, pause, resume, cancel, retry, completion policy, immutable attributed events, and reverse rollback plans. Pipeline generation, worker scheduling, native SCM reconciliation, and a real customer campaign remain open.
- Transformer now has an immutable content addressed recipe contract and the deterministic `node-runtime-18-to-20@1` recipe with declarative preconditions, allowlisted edits, offline verification commands, and drift protected inverse operations. Isolated workspace execution, persisted recipe binding, fenced jobs, staged delivery, and real repository evidence remain open.
- Governed learning now requires versioned opt in consent bound to purpose and residency, same tenant redacted artifacts, passed redaction, verification, and contamination evidence, accepted human review, temporal cutoff, deduplication, sealed dataset hashes, and append only deletion tombstones. Revocation and deletion remove records from training eligibility. Access review operations, model or adapter lifecycle, a representative consented dataset, external training, and measured adapter improvement remain open.

Release evidence:

- Pull request 5 merged to `main` as `bd0c5ef6e8e07de65c90972a4c725c3867e913b5` after protected run `30724340502` passed test, container builds, deployment E2E, and release gates.
- Main run `30724448785` passed test, release gates, real container builds, deployment E2E, Fly deployment, and production health for the exact merge commit.
- Independent production probes returned 200 from `/livez` and `/healthz`. Liveness reported the API and worker healthy. Readiness reported the API ready and authenticated, the worker healthy, and no due, scheduled, running, dead letter, or expired lease recovery work.
- The root returned the expected 307 to `/access`. `/access` returned 200. `/status` redirected to the protected access page rather than exposing an unauthenticated operator surface.
- The 1280 by 720 production browser check rendered the 480 pixel access card without horizontal overflow and without browser warnings or errors. Evidence is `C:\Users\Talal\Documents\Codex\2026-07-28\review\outputs\mendpoint-foundational-closure-production-viewport-2026-08-01.png`.
- The first full page browser capture compressed deferred content even though computed geometry was correct. A viewport capture and direct geometry inspection disproved a live layout defect; the full page artifact is not release evidence.
- External gates remain open for a private customer canary and scoped SCM credentials, a consented design partner campaign, payment processor and tax accounts, an SSO tenant, a representative consented learning dataset, enterprise cloud infrastructure, a penetration test, and compliance attestation.
- The product requirement register still reports 10 verified, 40 partial, 7 scaffold, 26 unimplemented, and 1 blocked external requirements. The release is materially safer and online, but the foundational specification is not fully closed and customer readiness claims must remain bounded to the implemented evidence.
- Rollback is the normal Fly release rollback to the prior healthy image or a revert of merge commit `bd0c5ef6e8e07de65c90972a4c725c3867e913b5`, followed by the same protected CI and production health gates.

### Foundational closure continuation 2

- [x] Reconcile the executable requirement register with the implementation evidence already merged for repository snapshots, Transformer persistence, and shared routing.
- [x] Complete the durable Transformer campaign contract with source linked BSGs, frozen recipe references, typed blueprint policy, attributable revisions, and idempotent tenant scoped mutations.
- [x] Add authenticated durable Transformer campaign API operations and focused restart, isolation, replay, stale revision, and sanitized response tests.
- [x] Normalize manual announcements and customer incidents into immutable, deduplicated, approval gated source artifacts with provenance and redaction evidence.
- [x] Persist attributable actual execution costs and reconcile them to MCU revenue without estimating missing attribution.
- [x] Add focused tests for every slice, then run full tests, typecheck, production build, GA checks, production dependency audit, container builds, deployment E2E, and diff integrity.
- [x] Push a protected pull request, merge only green code, deploy the exact main revision, and repeat independent live and browser verification.
- [x] Keep private customer proof, production SCM credentials, payment and tax accounts, SSO, external training infrastructure, VPC infrastructure, penetration testing, and compliance attestation explicitly external.

### Foundational closure continuation 2 review

- The executable register passes with all 84 requirements and now reports 10 verified, 52 partial, 7 scaffold, 14 unimplemented, and 1 blocked external. The status changes are evidence backed and remain conservative.
- Transformer campaign creation and review are atomic across campaign, blueprint, BSG, event, revision, and idempotency records. Fault injection proves rollback and safe retry after a later write fails.
- Authenticated Transformer routes persist tenant scoped campaigns, exact recipe references, source linked BSGs, attributable evidence, transitions, and exceptions. Cross tenant reads fail closed and responses redact secrets and local paths.
- Manual announcements and customer incidents persist as append only, content addressed source artifacts. The API binds tenant and actor to authentication, rejects unsafe sources and raw incident material, blocks fanout before approval and customer confirmation, and reconciles a crash between the domain append and request ledger completion.
- Actual execution cost records are immutable and hash chained. The API owns tenant, actor, timestamp, and idempotency. Gross margin remains null whenever cost, accepted outcome, settlement, campaign, currency, or ledger integrity attribution is incomplete.
- Focused contract, Transformer, source intake, database, and API tests pass. Full tests, typecheck, production build, GA check, current production dependency audit, capability corpus, offline demo, and production API smoke pass.
- Local Docker is unavailable in this Windows environment. The protected Linux workflow remains the authoritative gate for all four image builds, production container startup, deployment E2E, crash recovery, and Fly deployment.
- Local production API smoke returned 200 for readiness, authenticated keys, execution cost listing, and gross margin; tenant scoped missing Transformer and source records returned 404; invalid authentication returned 401.
- The remaining 14 unimplemented requirements are not represented as complete. Three require named external infrastructure or independent evidence; the remaining internal execution, workspace, identity, recovery, performance, value proof, and pilot contract gaps continue in later closure tranches.
- Pull request 7 merged to `main` as `0fd02baecf8c40f50f3fc0adc599af4b3b8db650` after protected run `30726515246` passed tests, release gates, all production image builds, container startup, and deployment E2E with crash recovery.
- Exact main run `30726592463` repeated the full protected matrix, deployed the merge commit to Fly, and passed workflow production health checks.
- Independent probes returned 200 from `/livez`, `/healthz`, and `/access`; the root returned the expected 307 to `/access?next=%2F`. Liveness and readiness reported the API and worker healthy, API authentication enabled, and zero due, scheduled, running, dead letter, or expired lease recovery work.
- Unauthenticated requests to the live billing economics, change source, and Transformer control plane proxy routes returned 401, proving the new surfaces exist behind the session boundary.
- The 1280 by 720 live browser check rendered a centered 480 pixel access card, matched document scroll width to client width at 1280 pixels, and reported no warnings or errors. Evidence is `C:\Users\Talal\Documents\Codex\2026-07-28\review\outputs\mendpoint-foundational-closure-2-production-viewport-2026-08-01.png`.
- Rollback is the normal Fly release rollback to the prior healthy image or a revert of merge commit `0fd02baecf8c40f50f3fc0adc599af4b3b8db650`, followed by the same protected CI, health, and browser gates.

## Website claim closure program

### Program constraints

- [x] Reconcile the 2026-08-01 website claim analysis from audited commit `7756d4c` to current `main` before changing implementation status.
- [x] Keep public claim correction separate from product capability construction. A roadmap label closes a public truth gap but does not prove the capability.
- [x] Keep customer proof, commercial agreements, compliance attestations, production identity providers, payment processors, cloud accounts, and external website credentials explicitly external until authoritative evidence exists.
- [ ] Use the public Manus and Cloudflare surface only through an authenticated owner session. Do not infer access from the product repository.

### Phase 0: Executable claim governance

- [x] Add a machine checked public claim registry with exact wording, owner, evidence owner, state, scope, evidence, limitations, expiry, and required qualifier.
- [x] Fail the release gate when a public claim lacks current evidence, contains an unapproved absolute, or references an expired statistic.
- [x] Map every homepage, metadata, structured data, pricing, FAQ, CTA, documentation, and product link to the registry.

Exit gate: every public statement is proven, limited availability, preview, roadmap, or thesis with current evidence and an explicit qualifier.

### Phase 1: Truthful public site and acquisition path

- [x] Build a versioned public site replacement that presents Mendpoint as a Private Design Partner Preview.
- [x] Remove unsupported prices, statistics, annual spend ranges, unlimited scale, no egress, universal coverage, unsupported model stack, GitLab GA, SSO, and executable Transformer claims.
- [x] Mark all demo figures as illustrative and publish supported Warden scope, limitations, verification profiles, providers, languages, and repository boundaries.
- [x] Add one durable design partner application flow with validation, consent, spam controls, confirmation, failure handling, owner, response objective, and attribution events.
- [x] Add working contact, privacy, terms, security, documentation, status, product login, and GitHub destinations.
- [ ] Publish through the current Manus surface or cut over Cloudflare to the versioned replacement only after owner access and rollback are proven.

Exit gate: every CTA completes a real path, every link resolves, the site has no unsupported present tense claim, and browser, accessibility, SEO, structured data, and responsive checks pass.

### Phase 2: Verified Warden delivery and review

- [ ] Complete GitHub installation scoped exact commit checkout, snapshot, branch, commit, draft pull request, webhook, CI, review, outcome, revocation, and recovery through the repository neutral contract.
- [ ] Persist required baseline and post edit compile, lint, test, security, and contract artifacts for every delivered draft pull request.
- [ ] Fail delivery closed unless required evidence passes or a human grants an attributable scoped expiring waiver.
- [ ] Attach source, snapshot, impact, edit, policy, verifier, review, rollback, and outcome lineage to every candidate.
- [ ] Complete reviewer assignment, comments, request changes, regeneration, approval synchronization, native SCM reconciliation, and immutable candidate history.
- [ ] Finish the private GitHub canary with the repository scoped credential, degraded draft pull request, immutable restore, passed rerun, revocation, and retained evidence.

Exit gate: a clean private GitHub repository completes exact snapshot to verified draft pull request to restore with disclosed evidence and human review.

### Phase 3: Monitoring and measurable coverage

- [ ] Enable governed production feed polling with configured sources, freshness objectives, deduplication, alerting, recovery, and operator health.
- [ ] Version the supported OpenAPI change taxonomy, provider catalog, language frontends, repository limits, verification profiles, and abstention behavior.
- [ ] Persist graph and evidence provenance, confidence, ambiguity, truncation, and unsupported classifications.
- [ ] Define and measure feed freshness, precision, recall, abstention, change to draft time, verification pass rate, reviewer delta, merge outcome, and regression by cohort.

Exit gate: coverage and speed claims use defined workloads and observed p50 or p95 evidence rather than universal wording.

### Phase 4: Bounded Transformer product

- [ ] Select one runtime migration with two to five disposable repositories and freeze its behavioral graph, recipe, organization policy, blueprint, verification, rollout, and rollback contract.
- [ ] Execute the versioned recipe in isolated fenced workspaces with exact source snapshots and persisted attempts.
- [ ] Stage verified draft pull requests by dependency wave and reconcile CI, review, drift, partial merge, retry, pause, resume, exception, and cancellation.
- [ ] Build the Transformer workspace for objective intake, blueprint review, graph, semantic changes, progress, evidence, exceptions, approvals, retry, pause, and rollback.
- [ ] Pass injected crash, CI failure, branch drift, partial merge, recovery, and reverse dependency rollback scenarios.

Exit gate: one bounded migration campaign completes across real disposable repositories with verified staged draft pull requests and restore evidence.

### Phase 5: GitLab end to end

- [ ] Add GitLab OAuth or PAT connection, project selection, exact snapshot, branch, commit, merge request, pipeline, discussions, approvals, webhooks, revocation, recovery, and health through the shared repository contract.
- [ ] Prove the same Warden delivery and restore journey in a private GitLab canary before changing the public claim from roadmap.

Exit gate: a clean private GitLab project completes the same evidence backed candidate and restore flow as GitHub.

### Phase 6: Router and model execution

- [ ] Connect Warden and Transformer to the shared structured task and policy contract.
- [ ] Add tested Anthropic and Gemini executors only if their credentials and data policy are approved.
- [ ] Keep LiteLLM and Langfuse removed from public claims unless installed, configured, exercised, secured, and observable.
- [ ] Persist route eligibility, rationale, privacy, region, budget, latency, retries, fallback, actual cost, verification, outcome, and deterministic replay.
- [ ] Pass held out quality, outage, budget, privacy, security, handoff, and accepted output cost gates.

Exit gate: only exercised executors and observability components can appear in present tense claims.

### Phase 7: Commercial system

- [ ] Freeze the billable outcome, MCU version, aggregation, retries, failures, credits, price changes, settlement, and cancellation policy.
- [ ] Complete actual cost attribution, reservations, expiry, entitlements, invoice lines, credits, reconciliation, and customer and finance views.
- [ ] Integrate one approved payment or invoice processor with tax, payment state, dunning, refund, and export policy.
- [ ] Publish pricing only after the account, trial or contract, usage, invoice, cancellation, and support journeys pass end to end.

Exit gate: every commercial number is generated by the canonical pricing and settlement system or is clearly labeled proposed.

### Phase 8: Identity, self hosting, and enterprise controls

- [ ] Add human users, memberships, MFA capable OIDC, reviewer identity, session controls, offboarding, service principals, and audit export.
- [ ] Add SAML and SCIM only against an approved identity provider tenant with lifecycle acceptance evidence.
- [ ] Publish and test self hosted sizing, TLS, upgrades, migrations, backup, restore, rollback, monitoring, dependencies, egress modes, offline mode, and support lifecycle.
- [ ] Add vault backed secret lifecycle, tenant isolation proof, HA and outage behavior, VPC reference architecture, private connectivity, BYOK, residency, customer logs, SBOM, vulnerability, incident, continuity, penetration, and compliance evidence.

Exit gate: enterprise claims name concrete proven controls and approved contractual commitments. External attestations remain blocked until independently supplied.

### Integration and release

- [x] Land each independent phase slice as a focused commit with tests and migration compatibility.
- [x] Run focused tests after every slice and the full test, typecheck, build, GA, audit, capability corpus, production smoke, container, deployment E2E, accessibility, and click path matrix before merge.
- [ ] Open a protected pull request, merge only green code, deploy the exact main revision, and repeat independent API and browser verification.
- [ ] Record exact commits, checks, live probes, screenshots, claim status changes, unresolved external gates, and rollback instructions in this review.

### Website claim closure review

- Reconciliation used current `origin/main` revision `94c91d3e95dd6c85cb0b54d9131f0366ddcca9b3`; the earlier report remains valid for the external Manus site, while several product internals had advanced since audited revision `7756d4c`.
- The repository now owns a truthful Private Design Partner Preview site, exact source mappings for 14 claims, a release claim gate, working public destinations, and responsive, accessibility, SEO, structured data, error, and application journey checks.
- The application path now uses same origin validation, bounded payloads, abuse controls, authenticated server identity, per record encryption keys, 90 day access expiry, mandatory audited reveal, cryptographic erasure, immutable redacted metadata, and a protected owner queue.
- GitHub repository intake now authorizes numeric installation and repository IDs, resolves an exact commit, rechecks branch drift, enforces size, path, symlink, submodule, LFS, sparse path, case collision, tenant, revocation, cleanup, and replay controls, and reports test transports as unproven.
- Router work now has a selected executor bound Warden port, policy and availability snapshots, redacted deterministic evidence, retry and fallback controls, actual cost and verification outcomes, and replay. No unapproved model executor is registered or claimed.
- Transformer now has a bounded Node 18 to Node 20 workspace executor with immutable recipe operations, lease fencing, fixed command execution, drift detection, redacted evidence, inverse restore, and disposal. Worker, campaign, and staged pull request integration remains open.
- Coverage work now has a fail closed observed cohort contract for scope, provenance, uncertainty, abstention, feed freshness, precision, recall, draft latency, verification, reviewer delta, merge outcome, and regression. Live collectors, persistence, scheduling, and publishable customer evidence remain open.
- Focused suites, full repository tests, root typecheck, production build, GA checks, production dependency audit, Playwright discovery, and diff integrity pass locally. Protected run `30730027985` passed Linux tests, release gates, both production container builds, and the 2 minute 20 second deployment browser journey with application submission, owner reveal and erasure, repair queue, crash, and recovery.
- The current public `www.mendpoint.ai` surface still runs on Manus behind Cloudflare. Publishing the versioned replacement requires an authenticated owner cutover and rollback proof after the Fly release is deployed.
- GitHub draft pull request delivery and restore, a real private canary, governed feed operations, full Transformer campaign delivery, GitLab, approved external executors, payment or invoicing, enterprise identity, VPC and HA infrastructure, penetration testing, and compliance evidence remain open and must not appear as present tense public claims.

## Warden and Transformer eval program

- [x] Merge approved pull request 9 and identify its exact main deployment run.
- [x] Research current coding agent evaluation frameworks, benchmarks, safety practices, and reproducibility controls from primary sources.
- [x] Inventory the real Warden and Transformer contracts without treating roadmap behavior as implemented.
- [x] Define a versioned scenario schema with deterministic graders, repetitions, budgets, and release thresholds.
- [x] Add held out Warden repair, abstention, rollback, adversarial, routing, and efficiency evaluations.
- [x] Add held out Transformer planning, recipe execution, restore, fencing, evidence, adversarial, and efficiency evaluations.
- [x] Add machine readable reports and make critical eval failures block the release gate.
- [x] Run focused evals, full tests, typecheck, build, GA checks, dependency audit, container builds, and deployment E2E.
- [x] Push a protected pull request, merge only green code, deploy the exact main revision, and repeat live API and browser verification.

### Eval acceptance criteria

- Every critical safety, rollback, restore, fencing, and evidence integrity case passes in all required repetitions.
- Every declared Warden repair mode and Transformer compatibility rule has at least one versioned corpus case.
- Held out cases grade observable repository state and evidence, not agent prose.
- Unsupported work produces an explicit safe handoff or abstention and never a false success.
- Repeated deterministic trials produce the same disposition, changed paths, output digest, and evidence shape.
- Agent step, changed file, changed byte, duration, and evidence size budgets fail closed when exceeded.
- Reports retain corpus version, scenario identity, grader outcomes, budgets, and aggregate pass at one and pass to the power of k metrics.
- Release claims remain cohort scoped and never infer universal quality or performance from the internal corpus.

### Eval review

- Corpus `2026-08-01.v2`: 14 Warden cases, 11 Transformer cases, 3 repetitions, 75 total trials.
- Strict local gate: pass at one `1.000`, pass at three `1.000`, pass to the power of three `1.000`, zero critical failures, zero deterministic failures.
- Focused eval workspace: 6 files and 35 tests passed.
- Repository validation: full tests and typecheck passed; production build passed; GA preflight passed; production dependency audit found zero vulnerabilities; Playwright discovered the deployment recovery test.
- Protected pull request 10 run `30732427791` passed Linux tests, the agent eval gate and evidence upload, release gates, every production container build, and the production crash recovery browser journey.
- Pull request 10 merged as `e42b9c3cfa1fbb5aa0f3b4024ab28448395f1a90`. Exact main run `30732521117` repeated every gate and deployed successfully to Fly.
- The downloaded main artifact records Warden `14/14`, Transformer `11/11`, 75 trials, pass at one `1.000`, pass at three `1.000`, pass to the power of three `1.000`, zero critical failures, and zero deterministic failures.
- Independent production probes returned `200` for `/`, `/livez`, and `/healthz`; `/console` returned the expected `307` access redirect. Both health endpoints reported `ok: true`, the worker was current, and the recovery queues were empty.
- The deployed public page rendered the private preview scope and known limits with no browser console messages; the verification screenshot is retained in the release handoff.

## Specialized agent effectiveness and efficiency release

- [x] Establish the exact `origin/main` baseline and record current Warden, Transformer, and evaluation behavior.
- [x] Synthesize current primary source practices with the specialist audits and select only bounded, evidence backed improvements.
- [x] Add failing Warden tests for model request limits, budget exhaustion, output bounds, and execution telemetry.
- [x] Implement a fail closed Warden model gateway with explicit time, call, and response budgets plus attributable execution metrics.
- [x] Add failing Transformer tests for applicability analysis, safe abstention, deterministic provenance, and repeated source reuse.
- [x] Implement Transformer recipe analysis and a bounded content addressed analysis cache without retaining customer source.
- [x] Extend the held out evaluation corpus and machine readable report with the new safety and efficiency behaviors.
- [x] Run focused tests, full tests, typecheck, production build, GA checks, dependency audit, and diff integrity.
- [ ] Open a protected pull request, merge only green code, deploy the exact main revision, and repeat independent live and browser verification.

### Specialized agent acceptance criteria

- Warden stops before a model call when its call budget is exhausted, aborts a slow request, rejects an oversized response, and reports calls, tool actions, elapsed time, and bytes without exposing prompts or repository content.
- Transformer classifies a recipe as applicable, already applied, or unsupported before mutation and provides deterministic recipe and source digests, matched paths, operation estimates, and reasons.
- Repeated Transformer analysis for the same immutable recipe and source snapshot avoids duplicate parsing while cache entries remain bounded and contain derived metadata only.
- New held out cases grade observable limits, classifications, provenance, and determinism rather than agent prose.
- No change expands autonomous permissions, adds automatic merge, claims unproven providers, or weakens human review.

### Specialized agent review

- Primary source research and three specialist audits converged on bounded agent interfaces, strict structured outputs, executable verifier feedback, immutable recipe provenance, idempotent analysis, and evals that separate agent failures from harness failures.
- Warden now enforces call, request time, and response byte budgets for its optional model planner. It parses exact schema constrained JSON, records model and tool usage, and stops with an explicit reason on timeout, transport, size, invalid response, or budget exhaustion.
- Model evidence contains paths and content hashes by default. A task must explicitly allow redacted source excerpts.
- Transformer now classifies immutable snapshots as applicable, already applied, or unsupported before workspace creation. Execution evidence binds that analysis to the exact source and recipe.
- Transformer analysis reuse is content addressed, tenant scoped, least recently used, capped at 128 entries in workspace execution, and stores derived metadata without customer source.
- Warden bench now rejects an already green verifier as a repair success and reports resolved, already green, safe handoff, wrong patch, timeout, and error separately.
- Eval corpus `2026-08-01.v3`: 14 Warden scenarios, 12 Transformer scenarios, 3 repetitions, 78 trials. Pass at one, pass at three, and pass to the power of three are all `1.000`; critical and deterministic failures are zero.
- Focused Warden, Transformer, and eval tests pass. Full repository tests, root typecheck, production build, GA checks, dependency audit, and diff integrity pass locally.
- Protected Linux containers, deployment recovery, Fly promotion, and independent production verification remain pending the pull request workflow.
