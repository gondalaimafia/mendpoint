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
- [x] Open a protected pull request, merge only green code, deploy the exact main revision, and repeat independent live and browser verification.

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
- Pull request 12 passed every protected gate and merged as `f17354e402d0f4ed0ff4cabcdbc8d7281664eabc`. Exact main run `30734355042` repeated the unit, agent eval, GA, release, container, production journey, crash recovery, deploy, and health gates successfully.
- Production browser verification exposed one unrelated missing public icon request. Pull requests 13 and 14 added the site icon and allowed only `/icon.svg` through the unauthenticated middleware boundary; pull request 14 merged as `ec2c819979c73806456ae842c95550fac62adeab`.
- Exact main run `30735222962` passed every protected gate and deployed successfully. Independent probes returned `200` for `/`, `/livez`, `/healthz`, and `/icon.svg`; the icon response is `image/svg+xml` rather than a login redirect.
- Final Chrome verification at 1280 by 900 and 375 by 812 returned `200` with no console issues, failed requests, HTTP failures, horizontal overflow, or layout shift. Observed LCP was 392 ms on desktop and 248 ms on mobile.

## Customer readiness closure program

Source of truth: `C:\Users\Talal\Downloads\mendpoint_product_spec.md`

Audited baseline: exact `origin/main` revision `4134b51b5d1e38da31a31c7c99189ef747e77329`

Program interpretation: close every repository controlled acceptance criterion in dependency order, prove each state with current executable evidence, and keep credentials, customer outcomes, commercial accounts, cloud infrastructure, and independent attestations explicitly external. A repository release must not claim that an external acceptance event occurred.

### Stage 0: Evidence contract and release truth

- [x] Reconcile all 84 requirement records and 14 public claims against exact main code and tests.
- [x] Reject `partial` requirements that contain only planned, external, or live evidence and no current implementation locator.
- [x] Reject malformed blocker types and require every external evidence record to match a named blocker.
- [x] Link every public claim to requirement IDs and prevent proven claims from depending on incomplete product capability.
- [x] Mark the repository website registry as a replacement candidate until authenticated owner cutover is proven.
- [x] Reconcile stale historical checklists without rewriting prior release evidence.

Acceptance: contract tests fail on unsupported partial status, malformed blockers, unmatched external evidence, missing claim requirement links, and capability claims that exceed requirement state. `spec:check`, `claims:check`, and `ga:check` pass on the corrected registries.

Stage 0 review: commit `328c350` hardened both registries, corrected the evidence ledger, and repaired the root graph test harness. The contract workspace passes 69 tests, full typecheck passes, `spec:check` reports 18 verified, 40 partial, 13 scaffold, 12 unimplemented, and 1 blocked external, and `claims:check` passes 14 claims and 9 destinations. Public surface binding is now checked by claim ID so a registry entry cannot point only at an unrelated file.

### Stage 1: Warden private preview implementation

- [ ] Unify OpenAPI uploads, polls, releases, SDK registries, announcements, and incidents into immutable source artifacts with persisted validation evidence.
- [ ] Add fixture backed RSS, Atom, GitHub Release, provider page, and SDK release adapters with durable schedules, idempotent windows, stale alerts, and operator health.
- [ ] Version the complete compatibility taxonomy and signed shared recipe catalog, including preconditions, edits, verification, rollback, ownership, and outcome telemetry.
- [ ] Add repository graph coverage, owner, test, CI, runtime, and deployment evidence, explicit staleness and deletion semantics, cross repository ordering, phase specific confidence, and held out benchmarks.
- [ ] Enforce owner and verification coverage before a repository target becomes executable.
- [ ] Persist baseline and post edit verification comparison and create the structured pull request package in the live Warden pipeline.
- [ ] Complete reviewer assignment, comments, waiver action, policy precedence and simulation, durable attempts and exceptions, rollout planning, typed event coverage, and production metrics collection.

Acceptance: a clean exact SHA fixture plus a submitted OpenAPI change produces an immutable source artifact, evidence graph, baseline, candidate, post edit verification, structured draft pull request package, review lineage, and restore evidence. Missing attribution or verification fails closed.

### Stage 2: Transformer planning and execution

- [ ] Generate a reviewable blueprint from a bounded objective and connected repository evidence.
- [ ] Extract a nonempty source linked behavioral specification graph from code, tests, schemas, traces, and approved human additions.
- [ ] Ingest organization constraints with explicit evidence and precedence.
- [ ] Bind durable campaign units and waves to isolated fenced recipe execution and persist attempt and artifact evidence.
- [ ] Stage verified draft pull request batches through the neutral SCM contract and reconcile drift, CI, review, closure, merge, retry, pause, cancellation, and exactly once recovery.
- [ ] Execute reverse dependency restore for unmerged units and verified compensating changes for merged units.
- [ ] Build the protected Transformer operator workspace, outcome metrics, feature gates, and crash, drift, partial merge, and recovery evaluations.

Acceptance: one declared runtime migration completes across two to five disposable repositories with reviewed blueprint and BSG, dependency ordered verified draft candidates, visible exceptions, injected failure recovery, and exact restore evidence. Live SCM acceptance remains external until approved repositories and credentials exist.

### Stage 3: Shared router and governed learning

- [ ] Complete one structured Warden and Transformer task contract with product, allowed tools, required verification, data handling, fallback, and handoff policy.
- [ ] Add typed executor kinds, versions, price schedules, hard limits, health, license, and artifact metadata.
- [ ] Replace free form failures with a closed taxonomy and persist route, execution, verification, review, regression, cost, latency, recipe, and consent feedback as one lineage.
- [ ] Add a held out baseline versus router comparator for verified acceptance, security regression, accepted output cost, and latency.
- [ ] Add adapter lifecycle contracts for artifact, license, lineage, evaluation, shadow, canary, promotion, monitoring, rollback, retirement, and data sufficiency.

Acceptance: routing and fallback are deterministic, policy bound, replayable, cost attributable, and fail closed. Adapter promotion remains blocked until a consented representative dataset and approved training and serving infrastructure exist.

### Stage 4: Identity, isolation, secrets, and audit

- [ ] Add users, memberships, MFA capable OIDC sessions, service principals, reviewer binding, session lifecycle, and offboarding without weakening API key authentication.
- [ ] Remove optional tenant scope from production storage and execution paths and add boundary wide adversarial isolation tests.
- [ ] Add a production vault provider, envelope encryption, versioned rotation and revocation workflow, and customer managed key interface.
- [ ] Add audit retention classes, legal holds, redaction profiles, governed export destinations, and replay verification.

Acceptance: every protected API, queue, database, graph, artifact, snapshot, webhook, cache, log, and export path requires explicit tenant and attributable actor context. OIDC, SAML, and SCIM acceptance remains external until an approved identity provider tenant exists.

### Stage 5: Reliability, disaster recovery, performance, and self hosting

- [ ] Persist one correlation context across request, job, graph, model, verification, SCM, webhook, billing, and audit.
- [ ] Add a horizontally safe cloud queue and lock adapter while preserving SQLite as the documented single node self hosted mode.
- [ ] Standardize dependency circuit breakers, retry budgets, durable outage queues, and customer visible degraded state.
- [ ] Define workload tiers and p50, p95, and p99 objectives; add load and soak suites for first result, scan, verification, queue, and campaign fanout.
- [ ] Implement backup, restore, migration, rollback, RTO, RPO, regional failure, and recurring drill evidence for database, graph, artifacts, and configuration.
- [ ] Complete the self hosted sizing, TLS, upgrade, air gap, monitoring, dependency, egress, and support lifecycle contract.

Acceptance: injected dependency, process, storage, and regional failures recover within declared objectives without cross tenant or evidence loss. VPC deployment remains external until an approved cloud account, region, and enterprise network exist.

### Stage 6: Metering, billing, and customer operations

- [ ] Make the MCU schedule a governed versioned artifact and meter Warden, Transformer, router, verification, graph, and sandbox work automatically.
- [ ] Reserve usage on admission, settle or release on verified outcome, record actual execution cost, and feed gross margin reconciliation without manual attribution.
- [ ] Add the processor or invoice export boundary and payment state machine for contract pricing, tax, credits, refunds, dunning, and finance reconciliation.
- [ ] Persist a tenant owned onboarding checklist and pilot success contract covering identity, agreement, repositories, permissions, policy, commands, canary, baseline, owners, support, privacy, rollback, weekly review, thresholds, and conversion decision.
- [ ] Promote public proof only from accepted external evidence and observed outcomes.

Acceptance: every invoice line and margin result is reproducible from immutable usage and cost records. Processor, tax, pricing, signed agreement, and observed customer outcome acceptance remains external.

### Stage 7: Later provider and enterprise acceptance

- [ ] Complete GitLab snapshot, branch, commit, merge request, pipeline, discussion, approval, webhook, revocation, and recovery through the neutral SCM contract.
- [ ] Build the VPC reference deployment and generated security, privacy, vulnerability, SBOM, incident, continuity, and control mapping evidence.
- [ ] Complete authenticated owner cutover and rollback proof for `www.mendpoint.ai`.
- [ ] Complete the private GitHub canary, private GitLab canary, approved Transformer repository campaign, billing account integration, identity provider lifecycle test, VPC deployment, independent penetration test, and compliance assessment.

Acceptance: internal adapters can pass fixture and disposable repository tests before external authority exists, but no live or customer ready claim advances until the named third party evidence is retained.

### Release discipline

- [ ] Land coherent slices as focused commits and protected pull requests from `codex/customer-readiness-closure` or descendant branches.
- [ ] For every slice run focused tests, full tests, typecheck, production build, GA checks, dependency audit, production image builds, deployment E2E, crash recovery, exact main deployment, live probes, and desktop and mobile browser verification.
- [ ] Record exact commits, workflow runs, evidence changes, unresolved external gates, screenshots, and rollback instructions.

### Current planning evidence

- The initial audit found 10 verified, 52 partial, 7 scaffold, 14 unimplemented, and 1 blocked external requirements. That was a baseline, not the shipped state.
- The shipped product contract records 41 verified, 40 partial, 2 scaffold, and 1 blocked external requirements. Every promotion is bound to current executable evidence.
- The full workspace test, typecheck, production build, GA, specialist eval, dependency audit, container, crash recovery, deployment, live health, and browser gates pass on exact main revision `67275208425b5039d700bcd86b77e7d13cefabd8`.

## Customer readiness closure tranche 1

- [x] Harden product requirement and public claim evidence contracts.
- [x] Add human OIDC identity and tenant membership enforcement without weakening API keys.
- [x] Add runtime graph evidence, Warden rollout planning, and structured draft PR packages.
- [x] Add a protected Transformer workspace, deterministic blueprints, source linked BSG extraction, and staged draft PR batches.
- [x] Add signed provider recipes, held out router value proof, exact Warden metrics, and bounded performance probes.
- [x] Add release and SDK ingestion fixtures, a GitLab fixture adapter, and adapter lifecycle promotion controls.
- [x] Add pilot success contracts, disaster recovery drills, a VPC contract, and a compliance evidence catalog.
- [x] Complete calibrated confidence and held out impact benchmark verification.
- [x] Complete cross boundary Transformer experimental gate verification.
- [x] Complete billing contract and invoice export boundary verification.
- [x] Run full tests, typecheck, production build, GA checks, specialist evals, dependency audit, and diff integrity locally.
- [x] Run container, deployment journey, crash recovery, and production browser gates in protected CI.
- [x] Commit focused slices, push the protected branch, merge only green CI, deploy exact main, and browser verify.

### Tranche 1 evidence boundary

Repository controls are retained as internal or experimental unless live evidence
exists. No code artifact satisfies real customer proof, approved credentials,
cloud or network approval, legal approval, payment processing, identity provider
lifecycle, production regional recovery, penetration testing, compliance
assessment, or public website cutover.

### Tranche 1 integration review

- Product contract: 84 requirements, 41 verified, 40 partial, 2 scaffold, and 1 blocked external. The earlier blanket partial explanation was corrected; repository controlled gaps and named external gates are tracked separately.
- Public claims: 14 claims and 9 destinations pass the evidence binding check.
- Full workspace tests pass, including 41 catalog, 93 contract, 59 database, 28 web, and 15 worker tests.
- Full workspace typecheck and the Next production build pass. The build emits 21 static pages and the protected Warden, Transformer, billing, graph, install, status, and review routes.
- GA preflight passes with graph bench 19 of 20. Agent eval corpus `2026-08-01.v3` passes Warden 14 of 14 and Transformer 12 of 12 across 78 trials, with pass at one, pass at three, and pass to the power of three all 1.000 and zero critical or deterministic failures.
- Production dependency audit reports zero vulnerabilities. Diff integrity and the source secret and banned language scan pass.
- The combined audit found and fixed one stale web session payload type before release. Human review identity now derives from active OIDC membership, Transformer merge observation requires exact revision CI and review evidence, feed scheduling is durable and replay safe, and pilot contract mutations write audit evidence transactionally.
- Live SCM execution, approved private repository drills, real customer outcome evidence, identity provider lifecycle, payment processing, cloud network deployment, regional recovery, independent security assessment, and public website owner cutover remain explicit acceptance gates.

### Tranche 1 delivery evidence

- Pull request 16 passed protected tests, release gates, production container builds, and the deployment crash recovery journey, then merged as exact main revision `67275208425b5039d700bcd86b77e7d13cefabd8`.
- Exact main workflow `30759585732` repeated every protected gate and deployed successfully to Fly.
- Fly machine version 23 is started in `sjc` with its health check passing. `/`, `/livez`, `/healthz`, and `/icon.svg` return 200. `/status` returns the expected 307 access redirect. Both health documents report `ok: true`, a current worker heartbeat, and empty recovery queues.
- Public browser QA at 1440 by 900, 768 by 1024, and 375 by 812 found zero console messages, failed requests, HTTP failures, horizontal overflow, layout shift, or axe accessibility violations. Observed LCP was 572 ms, 456 ms, and 396 ms respectively.
- Every public internal navigation destination resolves. `/contact` intentionally redirects to `/design-partners`.

## Post-audit closure sequence

- [ ] Land the Warden policy and review safety slice: durable versioned policy precedence, simulation, approvals, expiring waivers, reviewer activity, and replay evidence.
- [ ] Land the unified change to impact slice: immutable source artifacts, complete change taxonomy, monitored ingestion health, ownership and CI enforcement, and runtime and deployment evidence collection.
- [ ] Land the trust floor slice: adversarial tenant boundary tests, vault and key lifecycle, governed audit retention and export, and correlated service health.
- [ ] Land remaining Warden execution slice: executable campaign attempts, baseline to post-edit comparison, recovery, and GitHub App lifecycle wiring.
- [ ] Land remaining Transformer slice: durable worker and SCM execution, reverse-order restore, constraint enforcement, outcome ingestion, and failure evaluations behind the default-deny gate.
- [ ] Land the shared router service slice: registered executors, durable routing and fallback decisions, cost attribution, handoff, and outcome feedback.
- [ ] Keep live customer, provider credential, IdP, payment processor, cloud network, regional recovery, penetration test, assessor, and website owner cutover gates blocked until the named authority and evidence exist.

## Whole repository coherence and optimization audit: 2026-08-02

Audited baseline: exact `origin/main` revision `f2da58b5e9376920a1ae8510adc3dfab52c38e7b`.

- [x] Map package, API, worker, web, persistence, authentication, SCM, Warden, Transformer, router, billing, and operations boundaries and identify duplicated or conflicting authority.
- [x] Run the full test, typecheck, production build, GA, specialist eval, dependency audit, diff integrity, API startup, container, deployment journey, and production health matrix.
- [x] Review security, tenant isolation, authorization, secret handling, filesystem boundaries, injection surfaces, retry and recovery semantics, and unsafe default behavior.
- [x] Review correctness, transactionality, idempotency, state transitions, concurrency, resource ceilings, error handling, and data migration compatibility.
- [x] Review performance across database access, graph queries, feed polling, worker fanout, repository indexing, API pagination, web waterfalls, bundle output, and release pipeline duplication.
- [x] Review product coherence, public claims, empty and failure states, responsive behavior, accessibility, navigation, protected workflows, and first customer readiness boundaries.
- [x] Reproduce and rank every confirmed issue, synthesize the root cause, and implement the smallest coherent fixes with regression tests.
- [ ] Repeat the complete release matrix, land through protected pull requests, deploy exact main, and independently verify production desktop and mobile behavior.

Acceptance: no confirmed critical or high severity repository controlled defect remains; every code change has a regression test; all local and protected release gates pass; public and product claims remain within executable evidence; external acceptance gates remain explicit.

### Whole repository audit review

- Fixed the Warden prototype-key crash and indexed this repository successfully: 2,411 nodes and 7,605 edges.
- Restored OIDC human authorization, scoped all graph operations, restricted shared catalog mutation, isolated web rate limits, and fail-closed unverified GitHub installation claims.
- Made feed dispatch tenant-safe, removed the default-tenant worker pin, added two bounded job lanes, cooperative shutdown, graph WAL and busy handling, and in-place tenant graph statistics.
- Bounded collection responses, removed consumer and change-detail scans, indexed tenant ordering paths, and added SCM deadlines plus fixed file upload concurrency.
- Made review, event, and audit writes atomic. Restricted Transformer result mutations to scoped machine principals.
- Repaired production audit export and replaced developer setup text with customer recovery actions. Structured evidence, verification, risk, rollback, ownership, and delivery controls are visible and required for approval.
- Local release evidence: all workspace tests pass, all workspace typechecks pass, the 21 page production build passes, GA checks pass, 78 specialist trials pass with zero critical failures, production dependency audit reports zero vulnerabilities, and local health and readiness return 200.
- Protected CI, exact-main deploy, production probes, and browser verification remain open until this branch is committed and pushed.

### Whole repository remediation verification

- Closed the independent follow-up findings: fenced feed dispatch recovery, fair all-tenant worker claims, shared feed fetches, stable offset pagination, fail-closed trusted proxy configuration, and the missing shared catalog publish guard.
- Replaced per-request tenant graph copies with read-only SQLite projections for persistent stores. The 10,000 node benchmark returned the same result in 7.2 ms instead of 390.8 ms, about 54 times faster.
- Added browser OIDC Authorization Code with PKCE, encrypted short-lived server sessions, exact bearer delegation, preview-only decision blocking, and a customer-ready startup gate that requires human identity plus real GitHub delivery.
- Independent security, product, UX, performance, and reliability re-reviews report no remaining P0 or P1 repository-controlled findings.
- Full tests, full typecheck, the 21 page production build, GA checks, 78 specialist eval trials, dependency audit, and diff integrity pass. Production dependencies report zero vulnerabilities.
- Docker is not installed in this local environment. The production image and deployment journey remain protected CI gates.
- The private PAT canary and restore drill is complete. Customer-ready promotion remains externally blocked on an approved identity provider configuration and production GitHub App credentials with installation, refresh, revocation, and permission drift proof.

## Private GitHub canary and restore drill: 2026-08-04

- [x] Capture the exact default branch revision and verification contract for the disposable private repository.
- [x] Activate the staged scoped credential and verify the production service remains healthy.
- [x] Use Mendpoint's real GitHub delivery implementation to create a branch, commit the bounded canary edit, and open a draft pull request.
- [x] Require the repository checks to pass and retain the exact pull request, revision, and check evidence.
- [x] Close the draft pull request, delete the canary branch, and prove the default branch revision and content are unchanged.
- [x] Remove the temporary production credential, verify production health, and record the remaining customer-ready gates.

Acceptance: the real product delivery path completes a private draft pull request without writing to the protected default branch; repository verification passes; recovery leaves no canary branch and the exact baseline remains unchanged; the temporary credential is absent after the drill.

### Canary drill review

- Repository: private `gondalaimafia/mendpoint-canary-drill-20260801`.
- Immutable default branch before and after: `d47e9b5c8da59fddbe6573e3a0995c3c1cc49135`.
- Mendpoint delivery commit: `014c285da6665d19fcfd293e76a16115f3c95cec`.
- Exact baseline restore commit: `e0563d9db5c0408f6b638c01b1f48a7a77428ac8`.
- Draft pull request: `https://github.com/gondalaimafia/mendpoint-canary-drill-20260801/pull/1`, closed without merge after both injection and restore verification checks passed.
- Recovery result: zero net changed files, no open pull requests, canary branch lookup returns 404, and the default branch is unchanged.
- Credential result: the temporary fine grained PAT was removed from Fly. Production machine version 28 is healthy and `/`, `/livez`, and `/healthz` return 200.
- Remaining boundary: this proves PAT based private delivery and restore. It does not prove the GitHub App installation token lifecycle, approved customer repository use, or customer outcome.

## Production GitHub App setup callback: 2026-08-04

- [x] Add the authenticated browser return route used by GitHub after an installation is selected.
- [x] Preserve tenant-bound install state across webhook delivery races and consume it exactly once only after the signed installation is verified.
- [x] Require the signed webhook to bind the installation through preapproved repository ownership; never claim an unassigned installation from browser parameters.
- [x] Bound callback retries, expose useful recovery states, and keep every mutation behind the same-origin authenticated proxy.
- [x] Align the GitHub App manifest, runtime configuration, permissions, webhook events, and production URLs.
- [x] Add database, API service, web callback, replay, expiry, cross-tenant, and webhook race regression tests.
- [ ] Run focused tests, full typecheck, production build, GA checks, dependency audit, protected CI, exact-main deployment, and live verification.

Acceptance: a signed GitHub installation event, independently verified repository ownership, and the originating principal's unexpired state complete through the browser setup return exactly once; webhook races can retry without losing state; unassigned and foreign installations fail closed; the published App form values match executable routes and least privilege permissions.

### GitHub App callback local review: 2026-08-05

- Added a public, no-referrer setup return page that immediately removes GitHub query parameters, resumes authenticated setup after access, bounds webhook-race retries, and exposes accessible pending, success, and recovery states.
- Bound every installation state to an authenticated principal and tenant. Completion is idempotent, requires the exact installation, owner mapping, permission set, numeric repository evidence, and repository scope, and supports a verified first installation before consumer creation.
- Added explicit `app`, `legacy_pat`, and `revoked` delivery modes. App delivery uses exact repository scoped installation tokens, RSA keys of at least 2048 bits, one bounded authentication refresh, and fail-closed permission or lifecycle drift behavior.
- Added durable suspend and delete tombstones. Delayed create or repository events cannot restore access; only an explicit unsuspend can clear suspension, while deletion remains terminal.
- Focused verification passes: database 66, API 92, GitHub 42, pipeline 17, worker 18, web 46, and operations 32 tests. Independent security, reliability, and UX reviews report no remaining P0, P1, or P2 findings.
- Full workspace tests, full typecheck, the 22 page production build, GA checks, agent evals, dependency audit, diff integrity, and isolated API startup pass. The API returns 200 for live, ready, and version. Production dependencies report zero vulnerabilities.
- Playwright discovers the expanded deployment journey. Docker is unavailable locally; protected CI remains the authoritative production image, crash recovery, and browser journey gate before merge.

### GitHub App callback delivery evidence

- Pull request 20 passed protected tests, release gates, production container builds, and the deployment journey, then merged as exact main revision `103bac3c21e6599cffd32c8a64e9c6749b726292`.
- Exact main workflow `31037652176` repeated every protected gate and deployed successfully. Fly machine version 30 is started in `sjc` with its health check passing.
- `/`, `/livez`, `/healthz`, and `/github/setup` return 200. `/status` returns the expected 307 access redirect. The setup return page passed public Edge verification with no console errors.
- Live GitHub App creation remains externally blocked on the signed in GitHub account's sudo verification and action time confirmation before submission.
- The complete production setup procedure (App form values, redirect on update, secrets, account tenant bindings, install flow, troubleshooting) is documented in `docs/GITHUB_APP_SETUP.md`.

## Devin level agent execution closure: Transformer durable attempt runner

Baseline: exact `origin/main` revision `103bac3c21e6599cffd32c8a64e9c6749b726292`.

- [x] Audit the real Warden and Transformer tool loops, worker wiring, persistence, recovery, and eval corpus against current autonomous coding agent requirements.
- [x] Select the highest value repository controlled gap: Transformer claims durable attempts but no production caller loads the exact snapshot, executes the recipe, persists the candidate, or closes the attempt.
- [x] Bind each attempt lease to its expected candidate digest and changed path contract, and add a reusable current fence assertion.
- [x] Add fenced, typed attempt failure recording for source drift, candidate drift, verification failure, execution failure, and worker crash. Stale workers must be unable to pause or mutate the campaign.
- [x] Build the production attempt runner: exact immutable snapshot load, bounded recipe execution, durable candidate artifact persistence, final fence check, exact completion, and deterministic recovery output.
- [x] Wire the runner into an independent production worker lane that discovers runnable campaigns from the shared pilot store while the existing default deny Transformer gate remains authoritative.
- [x] Add deterministic tests for success, source mismatch, candidate mismatch, command failure with inverse rollback, stale lease during execution, stale failure recording, duplicate replay, crash recovery, candidate artifact integrity, cleanup, and tenant gate denial.
- [x] Add a held out end to end eval that uses a real temporary repository snapshot and verifier failure instead of an always successful injected command result. Run three fresh trials and retain pass, time, and consistency evidence.
- [x] Run focused tests, full workspace tests, full typecheck, production build, GA checks, agent evals, dependency audit, diff integrity, isolated API startup, and independent security, reliability, and product reviews.
- [ ] Commit by explicit file, push a protected branch, require every protected check, merge only green CI, verify exact main deployment, probe production, and browser verify.

Acceptance: a default denied production worker can only execute an explicitly gated, exact tenant and campaign scoped attempt; every mutation is fenced; the exact source and output digests are verified; candidate files and evidence survive process exit; failed attempts rollback and pause safely; successful attempts become draft eligible but cannot merge or deploy; the real execution eval passes three of three trials.

### Transformer durable attempt runner local review: 2026-08-05

- Exact snapshot ID, revision, manifest digest, source digest, candidate digest, and changed paths now bind every lease. Claims are one transaction, token fenced, append only, and exactly replayable across connections and later attempt generations.
- The independent worker lane expires abandoned leases, filters authorized campaigns before its limit, executes the allowlisted recipe in a disposable workspace, persists candidate and evidence artifacts, and closes or pauses the exact attempt. Infrastructure failures fail operational readiness; handled customer verification failures do not.
- The production lane eval uses the real application database, pilot store, snapshot loader, default command runner, fixed external candidate gold, an independent fail to pass target judge, and an independent pass to pass regression judge. Three fresh trials pass: Warden 14 of 14, Transformer 13 of 13, 81 total trials, pass at 1 and pass at 3 both 1.000, with zero critical or deterministic failures.
- Full workspace tests, full typecheck, the 22 page production build, GA checks, dependency audit, diff integrity, and isolated production mode API startup pass. API live, ready, and version return 200. Production dependencies report zero vulnerabilities. Independent security and reliability reviews found no remaining P0 or P1 issue in this slice.
- Product contract status remains honest: 41 of 84 requirements are verified, 40 partial, 2 scaffold, and 1 externally blocked. Transformer remains experimental in the GA declaration. SCM draft creation, an adaptive inspect and edit retry loop, artifact retention and orphan cleanup, synchronous SQLite contention hardening, and the source grounded Warden loop remain subsequent gaps; this slice does not claim Devin parity.

## Devin level agent execution closure: Warden source grounded loop

Baseline: exact `origin/main` revision `4c49b28cd9b3f09381ea50a4376275d6515da142`.

- [x] Reaudit the current Warden planner, tools, worker entrypoint, persistence, repository source controls, and eval corpus against the full coding agent objective.
- [x] Bind every production attempt to the tenant owned active snapshot ID, exact revision, stored manifest digest, expiry, deletion state, and canonical read only storage root.
- [x] Copy the exact source into a private per attempt candidate workspace; never mutate the canonical snapshot or a shared checkout.
- [x] Define a provider independent planner port whose production adapter and test planner receive the same bounded typed observation contract.
- [x] Make model enabled Warden planner first from the first post baseline step, while retaining the deterministic heuristic as an explicit unavailable provider fallback.
- [x] Present bounded, redacted, untrusted repository observations to the planner and record nonsecret source evidence metrics and digests.
- [x] Require read before write for existing files, directory observation before new files, and an exact content fence before every mutation so stale or unobserved source cannot be changed.
- [x] Bound file reads, repository walks, searches, search bytes, search hits, prompt evidence, model response bytes, model calls, wall time, and verifier execution.
- [x] Enable the production worker to provide source context only from its tenant scoped repository root and persist the grounding evidence with the run result.
- [x] Require a failing target baseline plus passing regression and security baselines, then independently rerun target, regression, and security verification on the candidate.
- [x] Recompute source and candidate manifests, enforce a nonempty bounded diff, retain the successful candidate artifact, and discard every failed or stale workspace.
- [x] Add a held out multifile Warden task with distractors and repository prompt injection where the correct repair can only be derived from the repository contract.
- [x] Require an external fail to pass judge, external pass to pass regression judge, protected input check, secret redaction check, allowed file check, baseline failure, source observation proof, and nonzero typed planner calls.
- [x] Add adversarial regressions for unobserved writes, source mutation after observation, secret bearing source, context truncation, repeated calls, cancellation, provider timeout, malformed response, rollback, source symlinks, snapshot manifest mismatch, and concurrent attempts.
- [x] Run three fresh scripted planner trials through the release eval gate and retain completion, consistency, time, model call, context, and critical safety evidence.
- [x] Run three fresh live provider trials under the tenant model source policy and retain model quality, token, cost, timeout, and consistency evidence. 2026-08-05: three of three trials of `warden.live.path_repair.live` passed against Meta `muse-spark-1.2-contributor` (the operator-approved training-tier model) with machine-verified provenance — provider host match, exact model echo, request IDs, nonzero consistent tokens, https transport, computed cost, model-planned steps, zero scripted injection. Tokens 3583-3639 per trial, cost $0.00041-0.00042 per trial ($0.00126 total of a $25 cap), latency 3.7-6.3s, zero timeouts, consistent across repetitions. Fix required en route: the planner wire schema's top-level `oneOf` is rejected by provider strict mode; flattened to an object root with nullable all-required args.
- [x] Run focused tests, full workspace tests, full typecheck, production build, GA checks, dependency audit, diff integrity, isolated API startup, and independent security, reliability, and product reviews.
- [ ] Commit by explicit file, push a protected branch, require every protected check, merge only green CI, verify exact main deployment, probe production, and browser verify.

Acceptance: Warden must inspect a bounded tenant scoped repository, derive a repair from source evidence that is absent from the task text, mutate only observed and unchanged source, pass independent repair and regression judges, retain replayable nonsecret grounding evidence, recover without preserving failed writes, and pass three of three release trials with real planner calls. This slice improves the source grounded coding loop but does not by itself establish Devin parity.

### Verification results: 2026-08-05

Local gates, all green after the review fixes below:

- Focused suites: agent 89/89, worker 64/64, api 114/114, web 50/50, db 67/67, platform 106/106, eval 59/59.
- Full workspace `npm test`, `npm run typecheck`, and `npm run build` all exit 0.
- `npm run ga:check`: product contract 84 requirements pass, public claims 14/14 pass, readiness ok, GA CHECK PASS.
- `npm run eval:agents -- --repetitions=3`: 87 trials, Warden 16/16, Transformer 13/13, contract evidence 27/27, scripted planner evidence 2/2, live model evidence 0/0 with live model capability reported as not evaluated, pass@1 = pass@3 = pass^3 = 1.000, zero critical and zero deterministic failures.
- `npm audit --omit=dev`: 0 vulnerabilities. `git diff --check`: clean (CRLF conversion warnings only).
- Isolated production configuration API start: `/live`, `/ready`, `/health`, `/version` all 200 with env, data dir, and db ping checks ok; degraded status attributable only to deliberate isolation settings (mock GitHub, unset CORS).

Release blockers closed in this pass:

- Human review auth rejects any request carrying an `apiKeyId`, even with a synthesized human principal and trust record.
- Candidate and evidence tenant roots are resolved through a full component walk from the real data root that rejects junctions or symlinks at `warden-candidates`, `warden-evidence`, or the tenant directory, with Windows junction regression tests.
- Approval now seals a content addressed immutable artifact from the validated in-memory buffers under the tenant evidence root, persisted at `artifacts.approval` in the same transaction as `candidate_approved`; `readWardenApprovalArtifact` reverifies the digest byte for byte and is the only sanctioned SCM promotion input.
- Candidate source responses carry `Cache-Control: private, no-store, max-age=0` and `Pragma: no-cache`, proven through the web proxy.
- All ten lifecycle and retention items now have adversarial regression tests; implementations were verified correct as found.
- Warden replay evidence serializes the immutable first-observation source digests (`sourceEvidenceFiles`) while the mutation fence advances separately.

Independent security, reliability, product, and eval diff review findings resolved:

- P0: the orphan reconciler could recursively delete the tenant `approvals` directory; it is now exempt from reaping, `artifacts.approval.path` counts as referenced, and approvals bytes are excluded from the attempt storage quota.
- P1: concurrent approve race could delete a committed approval artifact; seal writes are now exclusive (`wx`) with digest-verified EEXIST handling, rollback deletes only files the request created, and run status is re-read after body parse.
- P1: full-tree hashing was synchronous on the request path; tree scans are now async behind a concurrency gate so candidate requests cannot block the API event loop.
- Eval truthfulness dimension reviewed fully clean: scenario counts, lane split, pre-mutation source digest grading, and the absence of any live model claim were all verified in code.

Tracked follow-ups from review (P2, not blocking this slice):

- [x] Live attempt workspaces are protected by the authoritative running `agent.run` job reference; a job claimed after the maintenance read can create only a fresh grace-protected workspace.
- [x] Attempt execution and candidate review share a 40 changed file, 256KB per file, and 2MB total contract, so every successful candidate fits review and sealing.
- [x] Review UI with preview access presents no decision controls and links to the existing company OIDC sign in path.
- [x] Removed the dead 409 branch, guarded malformed review result JSON, and reduced the development npm fallback environment to an operational allowlist.

Warden follow-up verification: attempt engine 15/15, worker CLI 43/43, candidate API 12/12, review UI 1/1. Agent and web typechecks pass. API and worker typechecks are temporarily blocked by concurrent Transformer `adaptiveBudgetRemaining` edits outside this Warden scope.

## Claude change review and agent parity continuation: 2026-08-06

Review scope: exact `origin/main..HEAD` commits `584885a` and `37efac3`, plus the current uncommitted adaptive candidate review worktree on `codex/adaptive-candidate-review`.

- [x] Inventory every changed production, database, API, worker, router, Transformer, and test surface.
- [x] Independently review security, tenant isolation, persistence, recovery, concurrency, resource bounds, evidence truthfulness, product coherence, and customer workflow.
- [x] Run focused tests and typechecks for every changed workspace, then the complete release matrix.
- [x] Reproduce and fix every repository controlled P0 and P1 finding with adversarial regression coverage.
- [x] Reassess the remaining specialist capability gaps against the foundational product specification and pursue the highest value gap after the review is clean.
- [ ] Commit by explicit path, push protected branches, require green CI, merge in dependency order, and verify exact production behavior before recording release evidence.

Acceptance: the final diff has no confirmed repository controlled P0 or P1 defect; adaptive Transformer execution, candidate review, and shared routing are tenant safe, fenced, bounded, recoverable, and covered by realistic production path evaluations; all full release gates pass; external evidence gaps remain explicit.

### Claude change review findings

- [x] Review both Claude commits and every uncommitted adaptive candidate file with independent security, Transformer, and product and eval passes.
- [x] Run focused tests and typechecks for agent, database, worker, Transformer, API, platform, and eval workspaces. All passed, while production path gaps below remain reproducible.
- [x] Make routing fail closed when breaker state or the durable decision ledger is unavailable.
- [x] Describe and route the actual Warden planner provider, deployment, region, data policy, cost, and model provenance instead of classifying model backed execution as internal deterministic work.
- [x] Apply typed breaker feedback exactly once, transactionally, and only for provider or executor availability failures after the final lease fenced job transition.
- [x] Bind the reconstructed deterministic candidate to the attempt lease before adaptive repair, enforce hard planner and gate deadlines, count invocations independently, and reject oversized edits before allocation.
- [x] Wire a policy bound adaptive planner into the production Transformer lane and enforce cumulative campaign attempt, token, cost, and elapsed time budgets.
- [x] Fence candidate sealing and insertion to the live lease, then add tenant quotas, expiry enforcement, cleanup retry, and orphan reconciliation.
- [x] Add candidate discovery and bounded review evidence, require appropriate human authorization, and make promotion apply the exact sealed bytes to a fenced campaign and draft delivery workflow.
- [x] Add held out release scenarios for routing fallback and provenance, adaptive failure to pass, candidate review and promotion, stale lease behavior, retention boundaries, and draft delivery.
- [x] Normalize the database source line endings and replace literal NUL bytes with escaped source text before review.

Review conclusion: no hardcoded secret was introduced and existing tenant query scoping, path containment, symlink rejection, and artifact digests are sound. The branch must not merge or deploy until the repository controlled P1 items above are closed.

### Current specialist agent parity acceptance

- Router: select from actual executable provider and model adapters, record exact provenance and measured economics, fall back only for typed retryable failures, and never execute without a durable decision.
- Adaptive repair: production must run inspect, plan, edit, verify, and critique under hard attempt, time, model call, token, cost, file, byte, and changed line limits. Repository state and external verification determine success.
- Execution: every attempt starts from a pinned snapshot in an isolated disposable workspace with workspace scoped writes, default denied network, step scoped secrets, and explicit retained artifacts.
- Customer workflow: list candidates, inspect bounded evidence and diffs, approve or reject with attribution, promote the exact seal to a draft pull request, and expose the trace and CI outcome.
- Release evidence: production router, planner, workspace, verifier, review, and delivery paths must run in held out trials at least three times, with pass at one, consistency, latency, tokens, cost, provenance, and stop reason retained. Scripted fixtures cannot certify the live path.

### Adaptive delivery repository authorization and base branch binding

- [x] Bind the reviewed base branch immutably from repository snapshot through sealed artifact, candidate, delivery intent, API evidence, and GitHub draft creation.
- [x] Require production adaptive GitHub delivery credentials to be tenant scoped and authorized for the exact connected repository identity.
- [x] Add existing schema upgrade coverage for every new persisted column and adversarial regressions for branch mutation and cross tenant or unpinned credentials.
- [x] Run focused database, Transformer, API, worker, GitHub, web, and eval tests plus affected package typechecks.

Acceptance: an approved adaptive candidate can only create a draft against the exact reviewed repository, repository ID, base branch, and base revision. Production never falls back to an operator wide unscoped token.

Review: the adaptive seal is schema v3 and binds `baseBranch`; existing candidate and delivery rows gain and backfill `base_branch` from the exact tenant, repository, and snapshot relationship. GitHub App delivery requires the connected installation and numeric repository ID to match the authorized installation. PAT delivery requires one configured tenant, one eligible `env://GITHUB_TOKEN` repository, and a live numeric repository identity preflight. Focused tests passed: database 58, Transformer artifact 16, GitHub 15, API 15, worker 60, web 4, eval 1. All seven affected workspace typechecks passed.

### Adaptive review customer readiness closure

- [x] Define and test a deterministic serialized-byte preview contract that always fits through the web proxy, including escaping-heavy content.
- [x] Add customer-visible review history across pending, approved, delivery pending, delivery failed, delivered, rejected, and expired states.
- [x] Reverify and serve retained immutable evidence for terminal records, while reporting intentional retention cleanup separately from corruption.
- [x] Run full API and web tests, affected typechecks, and the web production build. Full workspace gates remain with the coordinating release pass after concurrent delivery changes finish.

Acceptance: every API response declared reviewable traverses the customer web proxy; every candidate remains discoverable through its lifecycle; successful draft delivery never displays a false corruption state; genuine seal corruption still fails closed; human-only review and worker-only promotion remain unchanged.

Review: the API and web proxy now share one 5 MiB response contract and candidate detail measures the exact serialized UTF-8 envelope. An escaping-heavy 1 MiB candidate reproduced a 6.29 MiB pre-fix response and now returns a bounded, non-approvable preview. Candidate lists expose bounded file counts plus delivery state, normalize elapsed pending records, and keep active work and terminal history discoverable. Retained promoted seals are reverified and served; intentional rejected or expired cleanup is neutral, while unexpected digest failure is explicit. Full API tests pass 134 of 134, full web tests pass 58 of 58, API, web, and shared typechecks pass, and the 22-page web production build passes.

### Adaptive delivery P1 remediation: 2026-08-06

- [x] Keep approved delivery eligible after the review window and cover provider and finalization retries that cross expiry.
- [x] Remove orphan sweeping from live worker maintenance while retaining exact cleanup of rejected and expired records.
- [x] Restrict the standalone orphan reconciler to explicit offline maintenance and cover the seal reference race.
- [x] Allow PAT delivery only for an explicit disposable canary deployment with one tenant, one repository, and live numeric identity verification.
- [x] Require GitHub App authorization for customer production delivery and update existing deployment configuration examples.
- [x] Run focused worker, Transformer, and ops tests plus affected typechecks.

Acceptance: human approval survives the review deadline; live maintenance cannot delete a seal that a concurrent planner may reference; and a production customer deployment cannot use PAT delivery.

Review: approved deliveries now recover after expiry from both GitHub rate limiting and post-GitHub finalization failure. Live maintenance deletes only seals named by rejected or expired durable records; the bounded orphan reconciler remains available only with an explicit offline acknowledgement and stopped writers. Real customer deployments require GitHub App credentials, while PAT delivery requires the disposable canary class, one tenant, one eligible connected repository, and live numeric identity verification. Current focused evidence: worker 55/55, Transformer artifact 17/17, ops environment 12/12; worker, Transformer, and ops typechecks pass; `git diff --check` passes. The broader ops suite also exposed an unrelated intermittent Windows directory rename denial in disaster recovery; the affected ops environment suite passed independently.
## Warden reviewed candidate draft delivery closure: 2026-08-06

- [x] Specify failing API, database, worker, UI, concurrency, and adversarial tests for rationale, regeneration, exact sealed draft delivery, and durable status.
- [x] Add additive existing-schema-safe Warden delivery and supersession persistence.
- [x] Require bounded attributed human decisions; enqueue approval atomically and create immutable superseding regeneration runs without mutating reviewed seals.
- [x] Deliver only exact reverified approval bytes through tenant-authorized GitHub draft delivery and persist evidence, failures, and URL idempotently.
- [x] Expose rationale, regeneration, and delivery status in the non-technical review UI.
- [x] Run focused suites, affected typechecks, and diff integrity; document review evidence.

Acceptance: approval creates only a draft pull request from the exact immutable reviewed seal and exact authorized repository/base identity; rejection and regeneration require attributable rationale; regeneration creates a new superseding run; concurrent review losers cannot remove the winner's seal; delivery is durable, idempotent, fail closed, and never merges or deploys.

Review: the API now accepts only bounded attributed human approve, reject, or regenerate decisions. Approval seals the exact reviewed bytes and atomically creates one tenant-scoped delivery job; exact replay is idempotent and conflicting immutable bindings fail closed. Regeneration creates a new queued run with the reviewer rationale and an immutable supersession link. The worker reverifies the shared approval artifact, repository, snapshot, branch, revision, paths, contents, modes, attribution, and rationale before tenant-authorized GitHub draft delivery, then persists the delivery URL and audit evidence. The customer review page exposes rationale, all three decisions, and queued, delivered, or failed delivery status while stating that approval never merges or deploys. Focused evidence: database 2/2, API 15/15, worker 2/2, web 3/3; agent, database, API, worker, and web typechecks pass; `git diff --check` passes; the legacy review route is absent.

## Final integrated P1 closure: 2026-08-06

- [x] Deliver the complete source to final Transformer candidate while preserving the adaptive only delta for explanation, with a multifile exact draft regression.
- [x] Recover uncertain and post side effect Warden GitHub deliveries past ordinary retry limits without duplicating a draft pull request.
- [x] Preserve approved Warden deliveries and seals through delayed, retried, or uncertain delivery; make interrupted seal creation recover safely.
- [x] Bind structured rationale, category, risk, confidence, and exact verification evidence into Warden review, both immutable seals, both customer views, audit events, and both draft bodies.
- [x] Preserve Warden review attribution, rationale, supersession lineage, delivery state, and permanent draft URL in terminal run history independently of candidate bytes.
- [x] Add attributed Transformer regeneration with immutable supersession lineage in active and terminal history.
- [x] Add an executable, opt in Transformer live model eval lane with production routing, provenance, token, cost, objective verification, and consistency evidence.
- [ ] Run focused regressions, the complete release matrix, protected CI, exact main deployment, production probes, and authenticated browser verification.

Acceptance: no confirmed repository controlled P0 or P1 remains; exact approved bytes reach one draft pull request; uncertain remote state remains recoverable; review evidence and history survive process exit and retention cleanup; Warden and Transformer both support attributed regeneration and truthful live model evaluation; all release gates prove the integrated result before merge.

Review: Transformer regeneration preserves attributed immutable lineage and remains recoverably pending until explicit customer authorization permits review feedback to reach the configured model. Reconciliation is idempotent, consumes no attempt, and mutates no pilot state while blocked. A future authorized transition is bound to the exact imported candidate and originating exception, including a worker crash after import. The opt in live eval uses the production adapter and router over hard coded synthetic input, records provenance, repetitions, objective verification, tokens, cost, and thresholds, and fails closed. Focused Transformer suites passed 116 tests, the full eval package passed 85 tests, five affected workspace typechecks passed, and the production web build passed.

Final local release evidence: full workspace tests, full typecheck, the 22 page production build, GA contract and claims checks, the three repetition agent eval, production dependency audit, diff integrity, and isolated production API startup all pass. The agent eval completed 90 trials with Warden 16 of 16, Transformer 14 of 14, pass at one and pass at three both 1.000, and zero critical or deterministic failures. Local API live, ready, health, and version probes all returned 200. Docker is not installed in this environment, so protected CI remains the authoritative container gate. Independent final review reports no repository controlled P0 or P1 in the reviewed scope.

## Live Warden objective evidence truthfulness: 2026-08-06 to 2026-08-07

Baseline: exact deployed `origin/main` revision `6d2b25c1129eccee3f333ceb47dbc1585d0bfe20`.

- [x] Reproduce that valid provider provenance can pass the Warden live lane even when the coding task does not complete.
- [x] Add machine grades for the actual Warden outcome, protected verifier success, exact allowed changed paths, and semantic consistency.
- [x] Preserve the existing exact provider, model, request ID, token, cost, HTTPS, and no scripted planner provenance gates.
- [x] Reject provenance valid runs that stop early, edit the wrong file, leave the objective unsatisfied, exceed the hard cost cap, or diverge semantically across repetitions.
- [x] Run the focused eval tests, eval package typecheck, full agent eval regression, diff integrity, and an independent review.
- [ ] Commit by explicit path, push a protected branch, require green CI, and merge only after the evidence gates pass.

Acceptance: a Warden live trial passes only when a real approved model both satisfies every provenance gate and completes the held out repair through the production agent loop, with independent verification and the exact allowed diff. Provider identity alone can never certify coding capability.

Review evidence: the original lane reproduced a provider-valid false positive while the task stopped without progress. Schema v2 now binds every pass to the production agent outcome, a non-executing source verifier, an independent hidden semantic judge, a bounded final-tree digest, exact allowed files, tool-ledger agreement, immutable verifier bytes, rollback state, approved model provenance, semantic consistency, and one shared worst-case USD ledger across all attempts. Default secret protections are unioned at both the public Warden and exported low-level tool boundaries. Missing, zero, unpriced, or inconsistent live-provider usage fails closed and charges the reserved worst case. Provider rate limits, typed cross-platform connection failures, timeouts, and retry-safe HTTP statuses receive bounded backoff; permanent failures do not retry. A fresh real three-repetition run passed 3 of 3 with consistent `verify_passed` outcomes, zero timeouts, and $0.002485 total spend. Full workspace tests, every workspace typecheck, the 22-page production build, GA and claims checks, the 90-trial deterministic agent eval, production dependency audit, and diff integrity pass. Independent final adversarial review reports no P0 or P1 finding. Protected delivery remains before merge.

## Transformer live objective and spend truthfulness: 2026-08-07

Baseline: exact deployed `origin/main` revision `14bee419b7d22999a33a4e91add1984d8a41996b`.

- [x] Reject missing, zero, non-integral, or inconsistent provider usage at the production adaptive planner boundary.
- [x] Reserve worst-case cost before every live call and charge it for failed, malformed, unknown, or over-budget settlements across all repetitions.
- [x] Accept measured cost only for a positive, internally consistent successful settlement within its reservation.
- [x] Make the final report require every trial and held-out objective to pass, regardless of configurable aggregate thresholds.
- [x] Reject present-but-invalid live budget configuration before any provider call.
- [x] Add adversarial regressions for zero or missing usage, failed-call charging, shared remaining-budget exhaustion, zero-threshold objective failure, unauthorized extra fields, strict provider schemas, parsed object content, truncated output, and isolated CLI selection.
- [x] Run focused suites, all affected typechecks, the complete release matrix, and a real three-repetition live Transformer lane.
- [ ] Obtain an independent final review, then push, require protected CI, merge, deploy, and verify production.

Acceptance: no provider request can escape the configured live-eval cost ceiling through missing or untrusted usage; no collection of failed objectives can certify Transformer capability; and only three consistent real-provider successes through the production router can supply live evidence.

Review evidence: the first real run exposed a strict-schema compatibility error and charged all three failed reservations conservatively. The provider required every declared property in the schema's required array, then returned parsed structured content rather than a JSON string. The production adapter now supports both safe envelopes, rejects refusals and truncated output, and retains the same strict local plan parser. A fresh isolated Meta Muse Spark run passed 3 of 3 with exact objective success, consistency 1.000, 8,472 total tokens, and $0.001570 measured and charged spend. The final full workspace tests, every workspace typecheck, the 22-page production build, GA and claims checks, the 90-trial deterministic agent eval, production dependency audit, and diff integrity all pass. Independent final adversarial review reports no P0 or P1 finding. Protected delivery remains pending.

## Mid scale customer readiness closure: 2026-08-07

Baseline: exact `origin/main` revision `4106f4598f1f1b7876d8d46c1e2e2a2c412a9ea7`. The foundational authority is `C:\Users\Talal\Downloads\mendpoint_product_spec.md`; repository documents and website copy are evidence surfaces, not competing specifications.

Research baseline: GitHub App least privilege, short lived tokens, frequent authorization checks, signed webhooks, deletion, security logging, and breach response; NIST SSDF 1.1 and 800-218A; NIST AI RMF Generative AI Profile; OWASP agentic threats and mitigations; OpenTelemetry semantic conventions; SLSA provenance; SCIM and OAuth/OIDC standards. The audit treats a control as complete only when implementation, automated verification, deployed evidence, and named external dependencies agree.

### Final adversarial P1 closure before protected delivery

- [x] Require stable numeric GitHub account identity at the final delivery sink and revoke every legacy installation whose account identity was not independently proven.
- [x] Replace heuristic API exception mapping with exact allowlists and injected unknown-error regressions.
- [x] Reject stale, future, or hung feed success evidence in customer readiness.
- [x] Make customer backup resources strict, complete, encrypted, authenticated, restorable, isolated, ownership-safe, and observable; require explicit external storage and key configuration.
- [x] Resolve YAML aliases before checking action keys so mutable references cannot hide behind anchors.
- [x] Bind general Warden pipeline delivery and pull request feedback to immutable numeric repository, installation, account, and pull request identities; restrict PAT delivery to one disposable canary.
- [x] Fence launcher bootstrap plus API and worker store initialization before any customer mutation or schema migration.
- [x] Reject zero, missing, or inconsistent production model usage and charge the conservative reservation when Warden or Transformer usage evidence is not trustworthy.
- [x] Re-run focused tests, full tests, typecheck, build, GA checks, agent evaluations, dependency audit, local process probes, and independent adversarial review before staging.

### P0: truthful and operable customer boundary

- [x] Add explicit `demo`, `pilot`, and `customer` deployment profiles. Customer mode must reject mock GitHub, disabled or local-only feeds, pilot seeding, missing real App credentials, and missing customer authorization before any process or seed mutation.
- [x] Make capability readiness report GitHub delivery authorization, signed webhook state, worker freshness, feed enablement and freshness, queue recovery, Transformer lane state, schema and writable storage independently; required customer capabilities must return 503 when unavailable.
- [ ] Build a clean-tenant Warden golden path that joins approved identity, GitHub App install and selection, exact snapshot, change ingestion, impact, verified candidate, attributed human review, exact draft delivery, SCM reconciliation, regeneration, restore, audit export, and observed outcome without duplicate side effects.
- [ ] Add an exhaustive cross-tenant denial matrix for routes, records, graph state, artifacts, queues, credentials, model routing, review, and SCM delivery. Missing tenant scope must be impossible in customer production constructors.
- [x] Bind GitHub installations, authenticated setup state, repositories, and tenant authorization to stable numeric account and repository IDs. Mutable logins remain display-only and cannot assign ownership.
- [x] Replace raw unhandled exception responses with stable error codes plus request IDs and recursively redacted structured logs. Internal paths, SQL, provider payloads, prompts, source, patches, credentials, and resource existence must never leak through an unexpected error response.
- [x] Pin every CI and deploy action to a reviewed full commit SHA and fail the release gate on mutable action references.
- [ ] Build, attest, and deploy the tested image digest before claiming supply-chain provenance.
- [ ] Replace the live `mendpoint.ai` trial, GitLab, unlimited repository, every usage, no-egress, pricing, and outcome claims with the approved claim registry. Add a deployed-site claim crawl gate. This is externally blocked until the website source repository and deployment access are in scope.
- [x] Replace live WAL filesystem copy backup with a fenced application-consistent, encrypted, authenticated, semantically verified seven-resource backup and exact restore boundary.
- [ ] Measure RPO and RTO against the selected off-host storage and recovery environment. Keep unmeasured objectives out of customer claims.

### P1: specialist agent capability and customer workflow

- [ ] Wire Transformer objective-only intake through the real blueprint planner, exact connected snapshots, organization constraints, human blueprint review, fenced execution, staged draft waves, reconciliation, exceptions, and reverse dependency restore.
- [ ] Add Warden structured plan-before-edit, evidence-linked hypotheses, verifier-driven replan, privacy-safe context compaction, approved knowledge digests, sealed checkpoints, and exact crash resume.
- [ ] Build sealed Warden long-horizon incident repair evaluations for webhook secret rotation, OAuth refresh concurrency, pagination-envelope migration, and unknown-commit payment recovery with hidden behavioral, security, regression, diff, checkpoint, cost, and pass to three graders.
- [ ] Permit bounded Transformer concurrency across independent repositories while preserving one active unit per repository and dependency fences. Build a four-repository REST v1 to v2 campaign with hidden adaptive recovery, bounded abstention, crash replay, branch drift, regeneration, exact draft delivery, and reverse dependency restore.
- [ ] Make per-edit evidence, target symbol, precondition, postcondition, rollback, calibrated confidence, risk reason, verifier result, and router rationale mandatory for delivery eligibility; abstain rather than invent missing evidence.
- [ ] Add a customer Warden campaign surface and tests for owner, stages, thresholds, pause, retry, cancel, exception, rollback, canary status, review, and PR outcomes.
- [ ] Bind observed SCM, CI, reviewer delta, regression, elapsed effort, support load, route, cost, and consent into an immutable outcome ledger that cannot mix synthetic estimates with observed facts.

### P1: mid scale operations and delivery

- [ ] Replace single-failure-domain SQLite cloud operation with a shared durable state design, versioned object artifacts, stateless API and web, independently scalable worker classes, distributed admission control, and generation-fenced transactional claims. Preserve SQLite only as an explicitly bounded single-node pilot tier.
- [ ] Add privacy-safe OpenTelemetry traces, metrics, and structured logs across request, queue, worker, model, verifier, database, webhook, and SCM boundaries. Export no source, prompts, credentials, or raw tool content by default.
- [ ] Build once in CI, emit SBOM and signed provenance, deploy the tested digest, verify exact revision, canary the joined customer journey, and restore the last known good digest automatically on failure.
- [ ] Add Warden and Transformer load, soak, overload, recovery, and multi-tenant fairness suites with queue age, saturation, storage growth, provider quota, and cost evidence.
- [ ] Add tenant-safe diagnostics, tested incident runbooks, paging integration boundary, and game-day evidence for bad deploy, stuck queue, uncertain SCM side effect, provider outage, secret compromise, corruption, and restore.

### External acceptance gates

- [ ] Configure a production GitHub App, signed webhook, approved owner-to-tenant binding, selected disposable private repository, and real non-local provider feed before changing Fly from demo to customer profile.
- [ ] Select managed Postgres, versioned object storage, KMS, telemetry backend, paging receiver, container registry/signing policy, recovery region, residency, retention, RPO, RTO, quotas, and support owner.
- [ ] Run the clean private canary, independent security test, restore drill, capacity run, and one consented design-partner outcome. External evidence must not be promoted to verified before observation.

Acceptance: Warden can serve a clean mid scale design partner through one joined, recoverable, least privilege, evidence-backed workflow; Transformer can turn an objective into a governed multi-repository campaign; both agents pass sealed long-horizon evaluations and conservative live-model gates; the platform survives bounded failures without data loss or duplicate external effects; public claims match deployed proof exactly.

Review: the immediate repository-controlled release blockers are closed and the settled tree passes the full workspace test command, every workspace typecheck, the 22-page production build, GA/spec/claim/action checks, 90 held-out agent trials with pass at one and pass at three equal to 1.000, a zero-vulnerability production audit, and isolated `/live`, `/ready`, `/health`, and `/version` probes. Independent rereview found no P0 or P1 in the one-way GitHub delivery identity, privileged path safety, or customer Compose topology slices. Current production remains a demo profile, not a customer-ready deployment. The open items above are material mid-scale gaps: joined clean-tenant proof, long-horizon agent controls and evals, objective-to-campaign Transformer intake, shared durable cloud state, telemetry, tested image provenance, capacity evidence, and external provider configuration.

## Bounded Warden pilot release: 2026-08-10

- [x] Isolate the Warden-only customer release from Transformer and broader UX work.
- [x] Fix the customer Warden model gate and complete tenant membership administration.
- [x] Add the single-machine customer deployment profile with real OIDC, GitHub App, provider feed, model, and object-backup contracts.
- [x] Add object-native encrypted backup publication and total-volume-loss restore recovery.
- [x] Prevent a one-version feed baseline from creating a deterministic dead letter and preserve terminal evidence during acknowledgement.
- [x] Fix the protected CI Warden false rejection without weakening untrusted model mutation controls.
- [x] Pass the full local test command and three-repetition held-out agent evaluation.
- [ ] Obtain green protected CI, merge the reviewed pull request, and deploy the exact customer profile.
- [ ] Acknowledge the preserved Stripe baseline dead letter without retrying it.
- [ ] Redeliver the genuine GitHub installation repository event, run the consented private draft pull request canary, and complete the object-store restore drill.
- [ ] Verify the deployed customer journey in Chrome and retain screenshots, logs, revision, backup, restore, and draft pull request evidence.

### Bounded Warden pilot review

The first protected run exposed six Warden false rejections hidden behind the combined report. Repository-owned deterministic repairs were being classified like untrusted model edits whenever their executable shape changed. Runtime-only provenance now authorizes only six exact, single-site built-in transformations; model-proposed edits cannot forge that provenance, and broad multi-site replacements still stop before mutation. Full workspace tests pass. The three-repetition held-out evaluation passes Warden 16 of 16, Transformer 14 of 14, all 90 trials, pass at one and pass at three equal to 1.000, with zero critical or deterministic failures. Production remains unchanged until the updated protected run is green.

### Customer profile cutover incident: 2026-08-10

- [x] Roll back the restart-looping customer release to the last verified healthy image and demo manifest.
- [x] Confirm `/livez` and `/healthz` return 200 after rollback.
- [x] Identify the exact startup failure from Fly logs.
- [x] Add a failing regression proving the web server child receives its required server-side API key while browser-inappropriate secrets remain absent.
- [x] Fix the role-scoped child environment and run focused tests, full workspace tests, typecheck, production build, and GA checks.
- [x] Ship the fix through protected CI.
- [ ] Retry the customer profile only from exact merged main, then run the private draft pull request canary and restore drill.

Incident evidence: customer release v56 restarted because the web production validator reported `MENDPOINT_API_KEY is required`. The key existed at the Fly application boundary but `customerWardenChildEnvironment("web", env)` removed it before launching the Next.js server. Release v57 restored the exact main image from v54 with the demo manifest; public liveness and health returned 200 and recovery queues remained clear. The new regression failed before the fix and passed afterward. Focused profile, web production, and launcher suites pass 9 of 9; the full workspace test command, every workspace typecheck, the 22-page production build, and GA checks pass.

## Website brand and capability truth: 2026-08-10

- [x] Capture the rendered website logo, colors, fonts, layout patterns, navigation, and customer-facing claims.
- [x] Compare every material website claim with implementation, automated verification, deployed runtime evidence, and known limitations.
- [x] Replace the product app's conflicting emerald mark, palette, and system typography with the website's approved arrow mark, indigo-to-cyan palette, Sora, Inter, and JetBrains Mono.
- [x] Preserve the app's bounded preview wording where the website overstates current product status.
- [x] Add brand rendering, navigation, responsive, keyboard, and accessibility regressions.
- [x] Run focused web tests, full tests, typecheck, production build, GA and claim checks, and desktop and mobile browser QA.
- [ ] Verify the exact deployed revision, production health, and branded UI after protected main deployment.
- [ ] Ship through protected main only after the claim matrix and browser evidence are complete.

Acceptance: the application and website are recognizably one product without weakening the application's truthful preview boundaries. A public claim is marked functional only when its production path, automated proof, and deployed evidence all agree. Claims that are partial, roadmap, unpriced, or unproven must be corrected or explicitly qualified rather than inferred from component existence.

Review: the product app now uses the website's arrow mark, blue-to-cyan identity, Sora headings, Inter interface text, JetBrains Mono technical labels, and dark indigo grid/glow surface while keeping the truthful bounded-pilot copy. The full workspace tests and typecheck pass, the 22-page production build passes, GA/spec/claim/action checks pass, the production dependency audit reports zero vulnerabilities, and diff integrity passes. The exact production build returns 200 at desktop and mobile widths with no console errors, no horizontal overflow, the expected fonts and logo, and no unnamed buttons or links. The exact final build also passes axe WCAG A/AA with zero violations at both widths; filled actions and text accents use accessible variants while the official `#356CFF` pigment remains the brand identity. The claim audit does not certify the current marketing page as truthful: real GitHub delivery remains disabled in the live demo, Transformer and GitLab are not customer-functional, commercial pricing/trials and SAML are unavailable, no-egress and universal-coverage wording is false or overstated, outcome numbers are not customer evidence, and every non-GitHub conversion button on the marketing site is inert. Website source and deployment access remain outside this repository, so those public-page corrections are still an external release blocker.

## Claims-derived product closure program: 2026-08-10

Baseline: exact deployed-main source revision `1ab7eebf935a5d4587496c6d0b8bad379ab51f28`. The public website is an input to this backlog, not a delivery target. Completion requires product implementation, automated proof, deployed evidence, and the named external acceptance evidence. Component existence alone is not functional completion.

### Release 1: joined GitHub Warden pilot

- [ ] Join one submitted OpenAPI change to normalized change evidence, bounded JS/TS impact analysis, a source-bound Warden candidate, configured target/regression/security verification, attributed human approval, exact-base draft pull request delivery, webhook reconciliation, and restore.
- [ ] Derive repository, snapshot, allowed paths, verification profile, network policy, model policy, budget, and delivery authority server-side. Customer text and repository content cannot widen them.
- [ ] Make intake, worker execution, model accounting, candidate seal, branch creation, draft pull request creation, webhook reconciliation, and restore exactly-once across retries and process interruption.
- [ ] Prove one consented private repository canary end to end with exact source, candidate, verifier, approval, pull request, cost, audit, and restore receipts. Never merge or deploy customer code.
- [ ] Measure and expose unsupported, ambiguous, truncated, and abstained analysis so supported-scope coverage is honest and universal recall is never inferred.

Acceptance: one real approved OpenAPI migration for one connected private GitHub repository reaches exactly one verified human-approved draft pull request and can be restored without duplicate remote effects or source mutation.

#### Release 1 internal intake and join review

- [x] Add authenticated reference-only Warden pilot intake. The caller selects only an approved provider and tenant-owned consumer; repository, snapshot, changed paths, verification, network, model, budget, and delivery authority remain runtime-owned.
- [x] Join real OpenAPI pipeline impact evidence to one immutable-snapshot `agent.run`, preserve the source chain in the candidate, abstain on unsupported scope, and create no draft before attributed human approval.
- [x] Make child enqueue and fenced parent completion one transaction. Equivalent later parent requests reuse the canonical child, retain immutable execution provenance, and append an audited replay linkage.
- [x] Pass API 197/197, Worker 166/166, full workspace tests, full typecheck, the 22-page production build, GA/spec/claims/action checks, dependency audit, and diff integrity. Independent adversarial review found no remaining P0 or P1 in this slice.
- [ ] Run the consented private GitHub App canary through Warden execution, candidate review, exact draft delivery, webhook reconciliation, and object-store restore. This external proof remains the Release 1 completion gate.

Review: this slice closes the missing trusted OpenAPI-to-Warden handoff without broadening public claims. It does not complete Release 1 until the real private canary, approval, draft pull request, reconciliation, and restore receipts exist. It does not start Transformer, GitLab, billing, enterprise identity, multi-node scaling, or claim-grade outcome work.

### Release 2: Warden long-horizon operation and debug evidence

- [ ] Add persistent mission planning, evidence-linked hypotheses, bounded context compaction, crash-safe checkpoints, exact resume, verification-feedback replanning, and cumulative budget continuity.
- [ ] Persist privacy-safe trajectories across request, queue, model, tool, verifier, approval, SCM, CI, and restore boundaries.
- [ ] Provide operator replay of decisions and receipts without replaying external side effects or exposing raw source, prompts, credentials, or internal errors.
- [ ] Pass multi-file, large-file, ambiguous-symbol, mid-mutation crash, regression-feedback, stale-base, and security-injection evaluations for at least three repetitions.

Acceptance: Warden can investigate and repair a bounded multi-file API migration across process interruption, explain every accepted action from retained evidence, and resume without duplicate model charges, commits, or pull requests.

### Release 3: governed provider monitoring and coverage

- [ ] Add a tenant-approved provider source catalog, signed source/version identity, freshness, deduplication, baseline handling, retry and dead-letter recovery, and per-source health.
- [ ] Bind detected changes to exact OpenAPI/changelog evidence and supported repair recipes before creating customer work.
- [ ] Add measured precision, recall, ambiguity, truncation, unsupported-language, and runtime-evidence coverage by provider and repository profile.
- [ ] Add load, soak, provider-quota, queue-age, and cost bounds for the single-node pilot tier.

Acceptance: monitoring can safely create a Warden mission only from fresh, attributable, non-duplicate provider evidence and reports measured bounded coverage rather than universal coverage.

### Release 4: trusted Transformer execution

- [ ] Connect reviewed objectives and blueprints to tenant-scoped authoritative constraints, exact repository snapshots, human approval, trusted compilation, durable pilot state, and immutable receipts.
- [ ] Reject raw caller-authored authority, budgets, snapshots, candidates, constraints, or execution policy.
- [ ] Add fenced phase checkpoints, crash resume, independent same-wave repository concurrency, dependency and merge fences, campaign-level verification, exact draft delivery, reconciliation, regeneration, and reverse-dependency restore.
- [ ] Prove a two-repository campaign first, then a four-repository Node runtime migration with branch drift, partial-wave failure, resume, and exact draft pull requests.

Acceptance: an approved Transformer objective produces bounded, verified, dependency-safe draft migration pull requests across multiple repositories without trusting caller-authored execution state.

### Release 5: GitLab production path

- [ ] Add production OAuth or scoped PAT authorization, stable group/project identity, selection, immutable snapshots, branches, commits, draft merge requests, webhooks, pipelines, discussions, approvals, revocation, reconciliation, and restore through the SCM-neutral contract.
- [ ] Add tenant isolation, credential encryption, least privilege, retry and uncertain-side-effect recovery equivalent to GitHub.
- [ ] Run a consented private GitLab project canary and recovery drill.

Acceptance: the same bounded Warden workflow reaches exactly one human-reviewable draft merge request through real GitLab credentials and survives revocation, replay, drift, and crash boundaries.

### Release 6: commercial plans and billing

- [ ] Define founder-approved pilot, trial, plan, entitlement, repository, provider, usage, and support limits. Do not infer current website prices or outcome terms as approved policy.
- [ ] Add payment processor integration, customer and subscription lifecycle, invoices, taxes, credits, cancellation, delinquency, refunds, webhook reconciliation, and ledger-to-invoice evidence.
- [ ] Bind MCU/usage pricing only to independently defined billable outcomes; separate measured provider cost, platform cost, and customer price.
- [ ] Add finance-safe idempotency, audit, reconciliation, failure recovery, access control, and customer-visible receipts.

Acceptance: one test-mode customer can start an approved plan, consume bounded service, receive an exact reconciled invoice, cancel, and be restored/refunded without duplicate charge or entitlement drift.

### Release 7: enterprise identity and deployment

- [ ] Complete OIDC membership administration and MFA/ACR evidence, then add SAML federation, SCIM provisioning/offboarding, session policy, service principals, reviewer attribution, and break-glass recovery.
- [ ] Define and prove the supported single-node self-hosted tier: sizing, TLS, installation, upgrade, backup, object-store restore, monitoring, support, retention, RPO, RTO, and no duplicate worker guarantees.
- [ ] Treat no-egress as a separate mode requiring local model policy, offline dependencies, customer-managed SCM, telemetry and backup destinations, and a verified egress deny test.
- [ ] Add multi-node shared durable state, stateless API/web, worker-class scaling, distributed claims, and generation fencing only after the bounded single-node pilot succeeds.

Acceptance: an enterprise tenant can provision and revoke people and services through approved identity systems, deploy the documented tier, restore it, and prove its exact egress and support boundary.

### Release 8: governed multi-model routing and observability

- [ ] Add approved provider adapters only through the existing router authority, with tenant policy, data classification, residency, endpoint, model revision, rate, budget, usage, refusal, and fallback evidence.
- [ ] Add Claude, GPT, Gemini, and xAI only when each has a real authorized adapter and live eval. LiteLLM or another gateway and Langfuse or another telemetry backend are implementation choices, not requirements or claims.
- [ ] Export privacy-safe OpenTelemetry traces, metrics, and structured logs for latency, saturation, errors, tokens, cost, verifier outcomes, retries, and SCM side effects without source or prompts by default.
- [ ] Add provider outage, quota, timeout, malformed usage, region, and data-classification failure drills.

Acceptance: every external model call is policy-authorized, source-classified, durably accounted, observable, and fail-closed; unavailable providers cannot silently broaden data handling or spend.

### Release 9: customer and outcome proof

- [ ] Define the first design partner, pilot scope, support limit, success contract, consent, retention, and termination terms.
- [ ] Record observed repository count, affected usages, accepted pull requests, elapsed engineering effort, defects, intervention, support load, model cost, and customer outcome in an immutable ledger.
- [ ] Keep synthetic estimates, demonstrations, and illustrative figures separate from observed customer outcomes.
- [ ] Run claim-grade Warden and Transformer specialty evaluations against a native Devin arm only after the corresponding product paths are live and retain signed receipts.

Acceptance: every customer or performance statement is backed by a dated consented cohort and immutable evidence; no illustrative statistic can be presented as a customer result.

### Program release gates

- [ ] Every production change begins with a failing acceptance test and passes focused, full workspace, typecheck, build, GA, claim, action-pin, audit, container, deployment, and browser gates as applicable.
- [ ] Every database change boots both a fresh database and the exact prior production schema before deployment.
- [ ] Build once, attest the image, deploy the tested digest, verify exact revision, run a joined canary, and retain rollback evidence.
- [ ] Obtain independent adversarial review and close every P0/P1 before staging each release.

Program acceptance: the underlying product does everything claimed within explicitly stated supported scopes. Unsupported providers, languages, repositories, deployment modes, prices, identity systems, and outcomes remain unavailable until their individual release acceptance evidence passes.

## Customer Warden entrypoint: 2026-08-10

- [x] Add red-first web proxy tests for authenticated `POST /warden/pilot` and tenant membership administration, including OIDC bearer preservation and method/path denial.
- [x] Allow only the exact trusted Warden pilot and tenant membership routes through the same-origin web proxy.
- [x] In customer mode, replace raw goal/path/verifier authority with provider and consumer references sent to `/api/warden/pilot`; retain the existing raw form only for demo mode.
- [x] Add focused customer/demo form regressions and stable customer-facing failure copy.
- [x] Run focused web/API tests, full workspace tests, typecheck, production build, GA checks, dependency audit, and diff integrity.
- [ ] Obtain independent adversarial review, merge through protected main, verify exact deployed revision, then retry the Warden-only customer profile.
- [ ] Run the consented private GitHub canary and object-store restore drill without merging or deploying customer code.

Acceptance: an authenticated customer operator can select only an approved provider and tenant-owned consumer, producing one reference-only Warden pilot request through the web boundary. The browser cannot submit repository paths, verifier commands, model policy, budget, snapshots, or delivery authority.

Review: the customer web path now forces the same-origin proxy, preserves the operator OIDC bearer, and accepts only provider and repository references. Preview access receives `company_identity_required`, raw `/agent/runs` is unavailable in customer mode, and membership administration is exposed only through exact OIDC-protected routes. Red tests first reproduced the missing proxy routes and the preview-session privilege escalation. The corrected tree passes 28 focused web tests, the full workspace suite, every workspace typecheck, the 22-page production build, GA/spec/claim/action checks, a zero-vulnerability production audit, and diff integrity. Independent adversarial rereview found no remaining P0 or P1. Protected-main deployment, customer-profile readiness, the private canary, and restore receipts remain pending.

## Production OIDC public redirect: 2026-08-10

- [x] Reproduce the Fly internal-host redirect after a successful Auth0 callback.
- [x] Anchor the local return path to the configured public OIDC callback origin.
- [x] Prove external return paths remain rejected and the human OIDC session still delegates its bearer token server side.
- [x] Run focused web tests, web typecheck, production build, and diff integrity.
- [ ] Merge through protected main, verify the exact deployed revision, and repeat the browser sign-in flow.

Acceptance: a successful production OIDC callback always returns to the configured public Mendpoint origin, never Fly's internal listener address, while preserving the encrypted local return path and all existing session security controls.

## Coherent Claude and Codex release: 2026-08-11

- [x] Inventory every worktree, branch, pull request, commit, and dirty file created today; retain exact provenance and leave experimental work recoverable.
- [x] Review current protected main and the Codex Warden and Transformer commit train for P0 and P1 safety, integrity, tenancy, accounting, replay, and deployment risks.
- [x] Build one clean integration branch from current `origin/main`; integrate only commits that remain correct against the combined tree.
- [x] Run focused package tests, the repository verification entrypoint, full typecheck, production build, GA checks, claim checks, dependency audit, container and deployment checks as applicable.
- [x] Obtain independent adversarial review of the final combined diff and close every P0 and P1 before staging.
- [ ] Push the reviewed branch, use protected checks, merge without bypassing hooks, and confirm the deployed release is the intended merged revision.
- [ ] Verify live liveness, health, authenticated status, OIDC return, desktop and mobile app behavior, and rollback readiness without mutating customer repositories.
- [ ] Publish an evidence-backed capability rundown that separates production-functional behavior, default-off foundations, and work deliberately excluded from the release.

Acceptance: protected main contains one coherent, reviewed release; required checks are green; the intended revision is live and browser-verified; unsafe or incomplete experiments remain out of production; and every capability claim is tied to code, tests, and deployed evidence.

Review before PR: the release branch was created from current `origin/main` at `7d8cb3a`. It includes the complete reviewed Warden checkpoint foundation and the complete reviewed Transformer checkpoint and cross-worker resume foundation. The two dirty experimental worktrees remain unchanged and were not merged. Focused verification passed Warden 33 of 33, Transformer 126 of 126, and worker/Fly preflight 18 of 18. `./scripts/verify.sh` passed every workspace typecheck, all tests, production build, GA checks, and diff integrity. Independent final review found no P0 or P1 and separately passed Agent 294 of 294, Transformer 304 of 304, and Worker 188 of 188. Transformer activation remains off because production is still one machine with local state and no shared checkpoint coordinator or artifact backend.
## Generalized migration foundations: 2026-08-12

Scope: build complete, testable, default-off foundations on `codex/generalized-foundations`. Do not push, merge, deploy, activate, change Fly or CI configuration, provision secrets, call external training services, or mutate customer repositories.

### Architecture and safety

- [x] Create an isolated worktree from current `origin/main` and preserve the dirty Warden and Transformer experiments untouched.
- [x] Run the full repository baseline before implementation.
- [x] Define fail-closed boundaries for GraphQL, legacy extraction, documentation, attestations, post-trained adapters, and multi-node compute.
- [x] Keep all new runtime paths absent or disabled by default and prove importing them has no network, process, filesystem, listener, training, publishing, or deployment side effect.

### Generalized GraphQL ingestion

- [x] Add red-first SDL and introspection normalization tests with canonical schema identity and bounded input handling.
- [x] Add deterministic GraphQL diffing for types, fields, arguments, input fields, enums, unions, interfaces, and nullability/default changes.
- [x] Classify breaking, dangerous, additive, and nonbreaking changes with exact locations and migration hints.
- [x] Export the library without wiring API routes, feeds, queues, or production polling.

### Automatic legacy behavior extraction

- [x] Add red-first deterministic collector orchestration over snapshot-bound code, test, schema, trace, and graph evidence.
- [x] Pin collector identity, version, and digest; enforce tenant, repository, revision, snapshot, content digest, and evidence limits.
- [x] Feed only explicit grounded assertions and relations into the existing BSG extractor; never infer executable behavior from labels or model output.
- [x] Keep repository read and mutation authority false in the resulting graph.

### Evidence-linked documentation generation

- [x] Add red-first deterministic Markdown projection from an authenticated BSG.
- [x] Require exact evidence locators for every active statement, separate stale or deleted evidence, escape Markdown, redact secrets, and bound output.
- [x] Return only a draft artifact with `mayWriteRepository=false` and `mayPublish=false`.

### Formal software attestations

- [x] Add red-first DSSE-style signed statement envelopes over existing artifact, verification, policy, source, candidate, and delivery evidence.
- [x] Canonicalize statements, domain-separate signatures, verify key identity and algorithm, reject tamper, replay, malformed payloads, and cross-tenant subjects.
- [x] Keep signing and persistence behind injected ports; add no production keys, routes, or automatic publication.

### Post-trained model lifecycle

- [x] Add red-first adapter deployment manifest validation and lifecycle admission through the existing adapter authority and policy router.
- [x] Require exact tenant, base model, dataset, consent, artifact, serving revision, evaluation, infrastructure approval, canary, rollback, and evidence bindings.
- [x] Recheck lifecycle and consent immediately before dispatch; expose no model invoker and perform no training or network call.
- [x] Prove deterministic recipes remain preferred when eligible and revoked or rolled-back adapters fail closed.

### Default-off multi-node Transformer compute

- [x] Add a red-first authenticated, bounded coordinator client contract with exact checkpoint identity, idempotent replay, timeout, abort, and stale-error handling.
- [x] Add an immutable encrypted artifact adapter with create-only publication, exact readback, collision detection, bounded I/O, and conservative lifecycle evidence.
- [x] Add exact source materialization and an explicit `run-transformer-service` role that constructs no local coordinator or AppDb and has no legacy fallback.
- [x] Add private readiness that proves coordinator and artifact access without mutating state.
- [x] Keep the foundation unreachable from existing runtime commands; leave existing `run-service`, Fly, Docker, CI, profiles, gates, and production unchanged.
- [x] State the honest boundary: complete local multi worker service with one SQLite coordinator and shared immutable artifacts, not a deployed or highly available coordinator.

### Verification and review

- [x] Run focused red-green suites for every new module.
- [x] Run package typechecks for every changed package and full changed-package tests.
- [x] Run production build, GA/spec/claim/action checks, dependency audit, and diff integrity where applicable.
- [x] Obtain independent specification and code-quality review; close every P0 and P1.
- [x] Confirm no push, PR, merge, deployment, activation, external training, or customer mutation occurred.

Acceptance: the repository contains six evidence-bound, fail-closed foundations with real tests and stable public APIs, but no new production behavior. Every external side effect remains behind an unconfigured injected authority or an explicit disabled command.

Review: this original foundation milestone was superseded by the scope correction below. The libraries remain default off, and each is now integrated into a complete local application path. Production topology and activation remain deliberately unchanged.

### Scope correction: complete local features, still unshipped

- [x] Integrate GraphQL ingestion with authenticated tenant-scoped API, durable schema versions, baseline selection, retrieval, and pipeline evidence.
- [x] Add snapshot-backed built-in legacy collectors, persisted BSG artifacts, draft documentation persistence, and authenticated retrieval.
- [x] Add authoritative attestation pipeline persistence, signed envelope verification and retrieval, plus durable post-trained adapter administration and route dry runs.
- [x] Add the full Transformer coordinator RPC surface, source materialization, concrete shared artifact transport, dedicated worker command, and private readiness.
- [x] Run joined end-to-end tests proving each feature through its application boundary while production remains disabled.
- [x] Keep all production deployment, Fly, CI, customer flags, secrets, external training, repository writes, pushes, merges, and activation unchanged.

Corrected acceptance: every requested capability is a complete, elaborate, locally runnable product feature. "Do not ship" applies only to source-control publication, deployment, production configuration, external training, and customer activation; it does not permit stopping at an internal library foundation.

Review: GraphQL ingestion now accepts SDL and introspection, stores immutable tenant schema versions, selects explicit or latest baselines, classifies compatibility changes, and exposes authenticated retrieval. Legacy analysis now loads authoritative snapshots, runs grounded built-in collectors, verifies and persists behavioral graphs, and produces evidence-linked draft documentation. Software attestations now use interoperable DSSE and in-toto envelopes with durable scope verification, while post-trained model administration owns dataset consent, fenced training, authenticated receipts, adapter registration, and router dry runs. Transformer now has an authenticated coordinator, exact source service, encrypted filesystem and S3-compatible artifacts, an explicit service command, readiness, response-loss reconciliation, and two-worker takeover tests. All paths are default off. No push, merge, Fly or CI change, secret provisioning, external training call, customer repository write, activation, or deployment occurred.

## Coherent Claude and Codex integration: 2026-08-12

Scope: review every Mendpoint worktree and branch changed today, preserve all dirty work, integrate only code that remains correct against current `origin/main`, close confirmed defects, push one reviewed release branch, and use protected pull request checks. Do not push experimental branches, force push, bypass hooks, mutate customer repositories, activate disabled features, or deploy directly.

### Inventory and provenance

- [x] Record every worktree, local and remote branch, unique commit, stash, modified file, and untracked file from Claude and Codex.
- [x] Separate current main work, the generalized applications commit, demo and design system commits, Claude's bounded pilot changes, and stale Warden or Transformer experiments.
- [x] Preserve each dirty tree before integration and identify superseded or duplicate implementations.

### Review and remediation

- [x] Review Claude's bounded pilot, execution authority, compiler, evaluation, and UI changes for tenancy, authorization, durability, idempotency, accounting, rollback, and claim accuracy.
- [x] Review the generalized GraphQL, legacy analysis, attestation, post trained model, and multi worker Transformer applications against current main.
- [x] Review demo seed, demo polish, and design system overlap; retain one coherent current implementation and reject obsolete duplicates.
- [x] Add red regressions for every confirmed P0 or P1 and fix root causes before integration.
- [x] Keep unsafe Warden adaptive checkpoint and incomplete shared runtime experiments out unless their full protocol is independently proven.

### Integration and release candidate

- [x] Rebase the generalized applications onto exact current `origin/main`.
- [x] Replay reviewed additions in dependency order with explicit conflict resolution and no whole tree overwrite; the demo bundle was reviewed and removed after its fixed wildcard credential failed the release security gate.
- [x] Produce one clean `codex/` release branch with coherent commits and an evidence backed capability summary.

### Verification and publication

- [x] Run focused changed surface tests, every changed workspace test and typecheck, full repository tests, production build, GA/spec/claim/action checks, dependency audit, diff integrity, API startup, and container checks where available.
- [x] Obtain independent adversarial review of the exact final diff and close every P0 and P1.
- [x] Push only the final reviewed release branch and open a protected pull request; do not merge until exact head checks are green.
- [ ] After protected merge, verify the exact main revision and production health before claiming shipment.

Acceptance: one reviewable branch contains all safe, nonduplicative Claude and Codex work from today on current main; dirty experiments remain recoverable but excluded; every included capability is tested and honestly gated; and no direct main push, force push, hook bypass, or unverified production deployment occurs.

Review before publication: the release branch is based on `origin/main` at `8ca583c`. The design system and Claude PR series 61 to 71 were already present on main and were not duplicated. The generalized applications remain default off. The demo bundle is excluded after review found a fixed wildcard credential that could target an arbitrary data directory. Older Warden mission resume, alternate shared coordinator, bounded pilot compiler, and overlapping UI work remain preserved in their original worktrees but excluded because they are stale, incomplete, or superseded. Confirmed release blockers were closed with focused regressions: passing attestations require successful post edit verification; Transformer polling retains one identity for response loss but creates a new session identity after process restart; GraphQL and legacy writes require graph write authority and durable producer identity; training dispatch is single flight with database fencing; registration replay ignores server time; completed training binds adapter, base model, exact evaluation, and exact canary claims; and consent plus lifecycle evidence are verified against their durable subjects. Focused verification passed API 9 of 9, Pipeline 10 of 10, Worker 4 of 4, and all affected typechecks. `scripts/verify.sh` then passed every workspace typecheck, the complete repository test suite, production build, GA/spec/claim/action checks, and diff integrity in 251 seconds. The production dependency audit reports zero vulnerabilities. A local production API startup probe with an ephemeral application key returned HTTP 200 from health. Independent final review found no remaining P0 or P1.

## Self-serving Warden and Transformer parity: 2026-08-13

Objective: make Warden and Transformer self-serving coding agents in their specialty areas with a complete delivery loop comparable to Devin for mid-market US software teams and fintechs. Success requires more than model output: authoritative intake, repository understanding, planning, implementation, verification, evidence, pull-request delivery, durable recovery, human controls, and production operation must work together.

### Baseline and capability contract

- [x] Compare exact deployed main against the authoritative product specification, Warden and Transformer gap analyses, evals, and current official Devin capabilities.
- [x] Build an evidence-backed parity scorecard for intake, context, planning, coding, verification, delivery, recovery, collaboration, security, and enterprise operations.
- [x] Identify the highest-leverage missing vertical slice using current code and runtime evidence, not roadmap intent.

### Red-first implementation

- [x] Define Warden recovery evals for model receipt, deleted-workspace mutation, completed verifier, lease abort, and response loss.
- [x] Observe the expected RED failures at the runtime authority and attempt takeover boundaries.
- [x] Route Warden model, tool, mutation, and verifier effects through the live job checkpoint and lease fence.
- [x] Add crash, response-loss, stale-lease, accounting, and reconstructed-workspace cases for the Warden slice.
- [ ] Preserve terminal Warden checkpoint evidence and re-enter the mission from post-PR CI failures.
  - [x] Add an authority-specific runtime terminal transition after independent verification and artifact creation.
  - [x] Retain the exact authenticated encrypted terminal head in `agent_runs` before `jobs.result_json` is replaced.
  - [x] Prove terminal response loss, stale lease rejection, exact replay, transactional rollback, and post-completion evidence recovery.
  - [ ] Bind failed PR checks to the exact Warden run, repository, snapshot, PR, and head SHA.
  - [ ] Enqueue one budgeted repair mission idempotently and reject stale, foreign, pending, or non-actionable observations.
  - [ ] Prove repaired candidate delivery remains human-reviewed and cannot duplicate external PR effects.
- [ ] Build the Transformer objective-to-blueprint-to-campaign-to-draft-PR vertical.
  - [x] Discover an exact applicable recipe and derive units, paths, owners, and review scope from immutable snapshots.
  - [x] Compile only integrity-checked blueprints with independent reviewer receipts into the pilot execution contract.
  - [x] Require the acting control-plane principal to be a configured independent reviewer and persist the approval.
  - [x] Join persisted blueprint review to exact source compilation and pilot execution creation in one application service.
  - [x] Expose repository-backed mission planning and approved campaign creation through the authenticated API.
    - [x] Derive tenant organization, reviewer, CODEOWNERS, and constraint evidence from durable authorities instead of request input.
    - [x] Load and reverify the exact active repository snapshot with bounded UTF-8 files, modes, hashes, retention, and symlink protections.
    - [x] Bind the reviewed organization evidence to the exact organization-constraint digest and fail launch on authority drift.
    - [x] Require plan execution permission, a durable trust principal, exact request and idempotency evidence, and tenant-only lookup.
  - [x] Join terminal verified candidates to real SCM draft delivery and post-PR verification evidence.
    - [x] Persist a coordinator-owned, lease-fenced draft delivery record when the reviewed wave is authorized.
    - [x] Reopen the terminal checkpoint on a replacement worker and authenticate the shared candidate workspace before SCM access.
    - [x] Deliver one deterministic GitHub draft through the existing exact delivery contract and reconcile response loss without duplicates.
    - [x] Persist exact PR and commit evidence, then observe CI/review state and feed failures back into the campaign controls.

### Dedicated Transformer production pilot

- [x] Rebase the verified delivery slice onto current `origin/main` while preserving billing changes.
- [x] Add a separate Transformer Fly profile with one authoritative coordinator and independently scalable workers.
- [x] Require shared immutable artifact storage, exact tenant and campaign scope, checkpoint key, real GitHub App mode, and worker API authority before startup.
- [x] Keep the Warden application and its customer profile unchanged.
- [ ] Prove one-worker canary, two-worker takeover, exact draft delivery, CI observation, readiness, and rollback.
- [ ] Merge through protected checks, deploy the exact tested revision, and verify live health plus browser behavior.

### Verification and release

- [ ] Run focused tests, affected full package tests, typechecks, production build, repository verification, security audit, and joined deployment tests.
- [ ] Obtain independent P0/P1 review and close every confirmed blocker.
- [ ] Merge through protected checks, deploy the exact tested revision, verify live health and browser behavior, and record rollback evidence.
- [ ] Update the parity scorecard with what is now proven, what remains partial, and the next highest-leverage slice.

Acceptance: a named specialty workflow can start from an authorized customer request and autonomously produce a verified, evidence-backed, human-reviewable delivery artifact, survive an injected worker or process failure without duplicate external effects, and complete through the production path under tenant, policy, budget, and approval controls. The broader goal remains active until both Warden and Transformer meet this bar across their supported specialty workflows.

Dedicated production profile review: the separate Transformer app now defines one coordinator process with durable SQLite authority and independently scalable stateless worker processes over encrypted S3 checkpoints. Startup requires exact tenant, campaign, production gate, delivery approval, real GitHub App, worker credential, keys, executor digest, and evidence bindings. The shared API preflight recognizes only this explicit profile, global RBAC maps its coordinator path to the narrow Transformer worker permission, and credential rotation transactionally revokes prior managed worker keys without touching user keys. Focused Ops, Platform, API, and Worker tests pass 66 of 66, their typechecks pass, Fly configuration validates, and the complete repository gate passed before the final authority corrections. Independent strict review approved source publication with no remaining P0 or P1. Local Docker is unavailable and Fly authentication is invalid, so container boot, live secret inventory, canary, scale-out, and production health remain release evidence to obtain after protected CI and restored Fly access.

Review checkpoint: Warden recovery now durably owns paid planning, reads, mutations, and verifier commands under the production job lease. Focused drills rebuild a deleted candidate workspace from authenticated mutation bytes and replay a committed verifier result without executing it twice. The worker derives a domain-separated checkpoint key from the application data key and fails closed in the customer profile when the key is missing. Remaining Warden work is terminal evidence retention and post-PR CI repair re-entry. Transformer remains next: plain objective and connected repository must compile into an independently reviewed blueprint, internal execution, deterministic candidate review, and real draft PR.

Transformer orchestration checkpoint: exact snapshot inputs now select one applicable deterministic recipe or abstain, derive scope and owners, and produce the existing evidence-bound blueprint. A new compiler verifies blueprint integrity, exact source parity, recipe output, path constraints, and independent reviewer receipts before creating a runnable pilot campaign input. Control-plane review now rejects planners and unconfigured actors and stores the approved reviewer. Full Transformer tests pass 351/351; focused API control and execution tests pass 30/30. Repository-backed API intake, campaign join, and actual draft delivery remain in progress.

Joined mission checkpoint: the API application service now persists the derived blueprint and behavior-unit graph in the control plane, refuses launch before the review quorum, reloads the authenticated blueprint and approval receipts, recompiles against the exact repository authority, and creates the existing pilot execution campaign. Focused joined API tests pass 20/20. The remaining intake work is the production AppDb snapshot adapter and authenticated routes; delivery remains the next boundary.

Production intake checkpoint: authenticated `POST /transformer/missions` now derives tenant and actor solely from the authenticated principal, derives a stable campaign from the idempotency key, and reads exact retained repository bytes from the append-only snapshot manifest. CODEOWNERS, active tenant human memberships, snapshot policy, and a recomputed organization constraint contract supply scope and independent reviewers. Launch re-reads those authorities and rejects any reviewer, membership, policy, repository, or constraint drift. Recipe-specific source subsets now share the exact digest the worker reconstructs. Focused route, authority, service, control-plane, execution, planner, and compiler tests pass; API and Transformer typechecks are green. Real draft delivery remains next.

Warden terminal evidence review: successful attempts now defer terminal sealing until the worker's existing completion transaction. The authenticated terminal checkpoint, public job completion, routing outcome, `agent_runs` archive, and metering commit or roll back together, so no running job can be stranded behind a sealed terminal head. The runtime reconciles lost terminal responses, rejects stale leases and conflicting outcomes, holds exclusive controller ownership while finalizing, and rejects later effects. The worker archive keeps the exact encrypted terminal envelope and publishes only its digest in the public job result. Forced failure after terminal CAS restores the prior resumable checkpoint and leaves no partial routing or run record. Full Agent tests pass 333 of 333; full Worker tests pass 253 of 253; both typechecks and diff integrity pass. Independent strict review found no remaining P0 or P1 in this slice. Post PR CI repair reentry remains deliberately separate and unfinished.

Post-rebase regression review: the checkpointed mutation path now preserves the existing `replace_in_file.global` argument instead of stripping it between trusted heuristic planning and runtime event validation. The forced terminal rollback drill passes, the Warden training knowledge tests pass 5 of 5, Agent and Worker typechecks pass, and the held-out contract evaluation is restored to Warden 16 of 16, Transformer 26 of 26, contract evidence 39 of 39, with zero critical or deterministic failures. The intermittent Windows backup rename failure was rerun in isolation and passed 19 of 19, so no speculative production retry logic was added.

## Warden post PR CI repair reentry: 2026-08-13

Objective: extend a human-approved Warden draft delivery into a durable, bounded CI feedback loop. The system must observe the exact draft head, diagnose actionable check failures, repair the same branch under fresh authority, and stop safely on success, pause, stale state, policy exhaustion, or human intervention. It must never merge or deploy.

### Protocol and authority

- [x] Bind every observation to tenant, Warden run, delivery, repository, pull request, base SHA, head branch, and exact head SHA.
- [x] Persist one idempotent CI cycle and one lease-fenced attempt per observed head.
- [x] Require the original approved scope, allowed paths, model policy, verification profile, and an explicit bounded repair budget.
- [x] Reject foreign, stale, superseded, running, missing, ambiguous, or manually paused observations before any model or repository mutation.

### Red-first joined behavior

- [x] Observe RED tests for failed CI detail capture, same-head idempotency, response loss, stale lease, human pause, and exhausted budget.
- [x] Observe RED tests proving a replacement worker repairs the same draft branch with compare-and-swap head authority and cannot duplicate commits or pull requests.
- [x] Observe RED tests proving successful checks terminalize the cycle without a repair and no path can merge, publish, or deploy.

### Implementation

- [x] Extend exact draft observation with bounded, authenticated failed-check details and exact required-check identities.
- [x] Add an exact existing-draft branch update that requires the expected head SHA and reconciles response loss byte-for-byte.
- [x] Add the durable CI cycle coordinator, worker job, immutable source reconstruction, Warden repair execution, and same-branch delivery join.
- [x] Wire polling and bounded enqueue behavior without reusing the mutable legacy `repair.run` checkout path.

### Verification and release

- [x] Run focused GitHub, DB, Agent, API, Worker, and joined CI reentry tests plus affected full package suites.
- [x] Run typechecks, held-out evals, production build, repository verify, dependency audit, diff integrity, and deployment tests.
- [x] Obtain independent P0 and P1 review and close every confirmed blocker.
- [ ] Ship through a protected pull request, verify exact main and production health, and update the handover and parity report.

Acceptance: after a human approves and delivers a Warden draft, an exact failed CI head can trigger only one bounded repair mission. A replacement worker can reconstruct the branch, produce and verify a scoped patch, update that same draft branch exactly once, and observe the rerun. Success, human pause, stale authority, policy exhaustion, and uncertain external outcomes all stop fail-closed. No code path merges or deploys.

Review before publication: Warden now observes only configured GitHub check-run identities on an exact open draft head, stores bounded redacted failure evidence, and opens one durable tenant-scoped CI cycle. A repair uses a fresh immutable snapshot, inherits the original path, model, verification, and cumulative budget authorities, and requires a new human-approved candidate before updating the same draft branch. The update protocol persists a lease-fenced one-use intent, reconciles response loss read-only, compares every tracked leaf and every approved blob byte-for-byte, and cannot mutate after pause or stale authority. Reject, regenerate, expiry, polling exhaustion, and terminal worker errors settle the cycle instead of stranding it. The feature has no merge or deploy capability. Full affected suites passed GitHub 115 of 115, DB 202 of 202, API 338 of 338, and Worker 276 of 276; all affected typechecks passed. `scripts/verify.sh` passed all workspace typechecks, the complete repository tests, production build, GA/spec/claim/action checks, and diff integrity in 245 seconds. `npm audit --omit=dev` found zero vulnerabilities. Independent strict review approved the final reconciliation and control protocol with no remaining P0 or P1. Protected publication and live production verification remain pending.

## Warden durable mission planning and verifier replanning: 2026-08-13

Objective: make Warden plan and execute multi-step repository repairs as an explicit, durable mission rather than a sequence of isolated tool calls. Every hypothesis and planned action must be grounded in observed repository evidence, survive worker takeover, and be revised from authenticated verifier feedback without resetting cumulative authority or spend.

### Capability contract

- [x] Define a bounded structured mission-plan schema with ordered steps, evidence-linked hypotheses, acceptance checks, confidence, risk, and revision lineage.
- [x] Persist the exact active plan and revision cursor in the authenticated Warden runtime checkpoint and restore it before any new model or tool effect.
- [x] Require every mutating model call to reference an active plan step and exact observed evidence; abstain when grounding is missing or stale.
- [x] Feed authenticated verifier failures into a new plan revision while retaining completed steps, prior evidence, accounting, and causal history.
- [x] Project the plan, revisions, completed steps, and blocker reason into review evidence without exposing secrets or raw prompts.

### Red-first evaluation

- [x] Observe a failing multi-step repository task that requires diagnosis, two source observations, one scoped mutation, and verifier-driven replanning.
- [x] Observe a crash after plan persistence and prove the replacement worker reuses the exact plan without another planning charge.
- [x] Observe stale evidence, unsupported mutation, repeated failure fingerprint, exhausted revision budget, and conflicting verifier feedback fail closed through the mission authority and existing Warden stop controls.

### Verification and release

- [x] Run focused Agent runtime, attempt-engine, evidence, Worker join, and held-out long-horizon evals.
- [x] Run full affected suites, typechecks, production build, repository verification, dependency audit, and diff integrity.
- [ ] Ship through protected checks and verify exact production health before claiming the capability live.

Acceptance: on a supported multi-step repository repair, Warden produces and persists an evidence-grounded plan, executes only its authorized current step, revises the plan from exact verifier feedback, survives process loss without repeating completed planning or tool work, and returns a reviewable candidate whose evidence explains the plan, revisions, actions, checks, spend, and any blocker. Unsupported or ungrounded work abstains.

Review before publication: Warden now stores a bounded authenticated mission plan alongside the paid planner receipt, including exact effect and request digests, evidence-linked hypotheses, confidence, risk, acceptance checks, revision lineage, and action results. Mutations must match the active plan effect, original model call digest, target, and current repository evidence. Failed verifier results produce a causally linked revision without resetting earlier steps or accounting, and takeover replays the paid plan receipt instead of planning again. The attempt evidence and customer report expose the redacted plan lineage and blocker without raw prompts. Full Agent 335 of 335, Worker 276 of 276, and Eval 108 of 108 passed. `scripts/verify.sh` passed every workspace typecheck, the complete repository tests, production build, GA/spec/claim/action checks, and diff integrity in 243 seconds. `npm audit --omit=dev` found zero vulnerabilities. Protected publication and live production verification remain pending.

## Rename hardening and dirty-work consolidation: 2026-08-14

Objective: close the confirmed Fettler and Regauge rename defects on current main, preserve compatibility with existing data and integrations, recover the reviewed public documentation work, and classify every remaining dirty worktree without merging unsafe experiments.

### Confirmed blockers

- [x] Replace the one-way physical database rename with a rollback-safe compatibility strategy and prove current and previous binaries see the same durable rows.
- [x] Emit Fettler in new PR evidence while retaining dual-read support for historical Warden markers.
- [x] Replace remaining customer and operator-facing Warden and Transformer labels with Fettler and Regauge.
- [x] Add a case-insensitive public-name gate with exact compatibility exceptions.
- [x] Correct the Regauge navigation glyph and regenerate public documentation output without stale legacy pages.

### Dirty work consolidation

- [x] Inventory every dirty worktree by base revision, owned paths, tests, and overlap with current main.
- [x] Port the reviewed Stripe-style product documentation onto this branch and reconcile the naming convention.
- [x] Port only independently verified, non-duplicated work from other dirty trees.
- [x] Leave unsafe or superseded experiments isolated with an explicit disposition and no destructive cleanup.

### Verification and release

- [x] Observe red regressions for database rollback, dual PR marker parsing, public-name enforcement, and stale generated docs.
- [x] Run focused package tests after each fix.
- [x] Run full workspace tests, typecheck, production build, GA checks, dependency audit, and diff integrity.
- [x] Obtain strict review of the combined diff before commit or push.
- [x] Record exact merge-ready and quarantined work in this section.

Review: the merge-ready branch contains the rollback-tolerant database prerequisite, per-machine Regauge worker identity, public Fettler and Regauge naming with exact compatibility exceptions, 13 component documentation guides with a deterministic 29-file upload bundle, and the reviewed offline Fettler investor reel. The complete repository tests, all 31 workspace typechecks, production build, docs drift check, GA gates, public claims, product contract, action pinning, dependency audit, and diff integrity pass on current `origin/main`. Strict review found no remaining P0 or P1 in the database, naming, docs, or worker identity boundaries. The older compiler UI overlay, partial Fettler runtime-resume experiments, superseded Regauge coordinator prototype, and stale rename dogfood report remain isolated in their original worktrees; none were deleted or merged.

Release note: this is database Release A. It makes the current schema tolerant of compatible legacy tables and is the rollback prerequisite for any future dual-namespace bridge. Do not combine a Release B dual-table bridge with this deployment. The dedicated Regauge Fly app still requires a valid Fly session and a live secret audit before activation evidence can be claimed; source code intentionally rejects app-wide worker identity secrets in the production pilot.

## Comprehensive repository audit and end to end hardening: 2026-08-14

Objective: review the complete repository against the enterprise ready Fettler and Regauge goal, exercise every established component and joined workflow, fix confirmed defects with regression coverage, and distinguish source correctness from production activation evidence.

### Baseline and inventory

- [x] Inventory every workspace, application, package, command, route, persistence boundary, external integration, test suite, and generated artifact.
- [x] Classify tracked source, tests, generated output, third party dependencies, and quarantined or dormant code.
- [x] Scan for unfinished markers, skipped or focused tests, unsafe compatibility fallbacks, stale claims, hardcoded credentials, and unbounded external effects.

### Verification matrix

- [x] Run every workspace test suite and typecheck.
- [x] Run production builds, repository verification, GA, claims, names, documentation, dependency, and action pinning gates.
- [x] Run API startup and health checks, Playwright deployment journeys, container builds and startup checks where the environment permits them.
- [x] Exercise component joins for ingestion, graph impact, repository access, Fettler execution and delivery, Regauge planning and execution, verification, attestations, routing, billing, recovery, and multi worker fencing.

### Review and repair

- [x] Review tenant isolation, authentication, authorization, input validation, secret handling, SQL boundaries, artifact integrity, lease fencing, idempotency, response loss reconciliation, and external side effect controls.
- [x] Review runtime cost, latency, memory, pagination, filesystem, subprocess, and model context bounds for production hot paths.
- [x] Add red regressions for every confirmed defect, implement the smallest durable fix, and rerun affected full suites.

### Final evidence

- [x] Rerun the complete repository matrix after the final patch.
- [x] Verify the deployed public and health surfaces independently from configuration intent.
- [x] Record exact pass counts, remaining external blockers, optimization outcomes, release disposition, and rollback constraints.

Acceptance: no known P0 or P1 source defect remains in supported product paths; every established automated component and joined end to end workflow passes after the final patch; security, durability, and least privilege boundaries have explicit evidence; unsupported or externally blocked production capabilities are reported rather than inferred.

Review: audited the current 34 workspace repository after rebasing onto `origin/main` `1bc0671`. The exact final patch passes every workspace test in 199.1 seconds, all 31 workspace typechecks, the production Next build with 50 pages, GA/spec/claims/names/actions/docs gates, and a zero vulnerability production dependency audit. Held out evidence passes 126 agent trials, Fettler capability 55 of 55, Regauge capability 47 of 47, Fettler bench 5 of 5, and four deterministic Regauge canary families. Local API startup returned ready with encrypted application storage and the corrected Fettler release identity. Local production browser checks passed six public routes at desktop and mobile sizes with zero console errors, zero overflow, and no visible legacy product names.

Confirmed defects fixed: the API now rejects oversized bodies globally and validates the local sandbox request schema, paths, URLs, file count, and byte budgets before allocating a workspace. A shared hard timeout and streaming response cap now protects Fettler model calls, Regauge adaptive planning, model based repair and impact confirmation, GitHub repository reads, and Slack or paging notifications, including providers that ignore abort signals or stall after response headers. The startup probe found and fixed the final public release metadata label from Warden to Fettler, and the product naming gate now covers that surface.

External limits: Docker is not installed in this Windows environment, so container image startup and the checked in containerized deployment journey must be proven by protected hosted CI. Live model evaluation remains 0 of 0 and the Regauge canary uses mock SCM. A safe performance or soak target was not supplied, so the destructive load runner was not aimed at production. Direct live probes returned 200 for the current Mendpoint liveness and health endpoints, but the combined worker reports Regauge disabled and inactive, while the dedicated Regauge pilot hostname does not resolve. Production activation is therefore not proven despite any configuration intent. The product contract remains 41 verified, 40 partial, 2 scaffolded, and 1 externally blocked; those declared roadmap gaps are not reclassified as shipped functionality.

## Regauge production proof: 2026-08-14

Objective: turn the checked in dedicated Regauge profile into an independently verifiable production pilot. The proof must cover the exact deployed revision, unique worker identity, coordinator and artifact readiness, a bounded live model evaluation, a real draft only source control canary, and a non destructive production soak. Configuration intent alone is not evidence.

### Release authority

- [x] Add a protected, manual dedicated Regauge deployment workflow that fails before mutation when any exact environment, secret, approval, or target binding is missing.
- [ ] Prove the Regauge container starts both coordinator and worker roles under Fly like machine identity and reports dependency backed readiness.
- [ ] Deploy exactly one coordinator and one worker first, retaining a documented pause and scale to zero rollback path.

### Live evidence

- [x] Run at least three budget bounded live model trials against the compiled synthetic Regauge fixture and retain the exact provider, model, token, cost, latency, and objective grades.
- [ ] Run one real GitHub draft only canary against an explicitly approved repository, installation, tenant, campaign, source revision, and allowed path set. Never merge or deploy the candidate.
- [ ] Run a Regauge specific read only readiness soak first, then a bounded execution soak only against an explicitly approved disposable campaign target.

### Production verification

- [ ] Verify the dedicated hostname resolves and both coordinator and worker health checks are green on the deployed revision.
- [ ] Restart the worker and coordinator separately and prove checkpoint recovery, unique lease identity, and no duplicate model effect or pull request.
- [ ] Update the product contract only for requirements supported by retained production evidence. Do not promote roadmap or externally blocked requirements by assertion.

Acceptance: the dedicated Regauge hostname resolves, the exact production revision has one healthy coordinator and at least one uniquely identified worker, encrypted shared checkpoint storage is ready, the live model lane passes its configured repetitions and budget, one approved real draft pull request is created exactly once, and a bounded production soak completes without mutation outside the approved canary. Every artifact is retained and linked to the deployed revision.

Live model checkpoint: the compiled synthetic Regauge lane passed 3 of 3 trials with a 1.000 pass rate and 1.000 consistency rate. The three calls used 9,619 tokens, cost $0.001799 total, and completed in 21,098 ms, 14,780 ms, and 18,386 ms. The retained structured report is `test-results/regauge-production/local-live-model.json`; it contains provider, model, deployment, execution region, policy digest, request provenance, token usage, measured and accounted cost, objective grades, and changed paths. No repository or customer data was read.

Source checkpoint: the new manual `regauge-production` workflow requires the exact draft only confirmation, protected environment, tenant, campaign, gate, repository owner and name, S3 authority, GitHub App authority, live model authority, and bounded evaluation and soak settings before it creates or changes Fly resources. It provisions one coordinator volume, stages secrets without printing values, deploys one coordinator and one worker, verifies the exact source revision through `/version`, runs the live synthetic model lane, requires exact durable GitHub draft evidence for the approved repository, performs a read only readiness soak, and retains all evidence for 90 days. The public version endpoint now reports only a validated immutable 40 or 64 character revision, and the production profile refuses to boot without it.

Verification checkpoint: focused Regauge production proof tests pass 60 of 60. Every workspace test, all workspace typechecks, the production build, GA, spec, public claims, naming, documentation, action pinning, dependency audit, Fly configuration validation, and diff integrity pass in the combined 359.7 second gate. The local Fly credential is present but unauthenticated. The repository has only `FLY_API_TOKEN` and no `regauge-production` environment or Regauge tenant, campaign, storage, GitHub App, model, approval, or target authorities. Therefore the workflow cannot safely run yet, the hostname remains unprovisioned, and draft canary plus production soak remain open external activation work.

### Regauge Fly authority preflight: 2026-08-14

- [x] Merge the production proof workflow through protected checks and verify the exact main deployment.
- [x] Create a protected `regauge-production` environment restricted to protected branches and explicit owner approval.
- [x] Bind the environment's non-secret policy to the existing private canary repository and bounded live-model limits.
- [x] Add a default read-only workflow phase that proves the repository Fly token, enumerates authorized organizations, records whether the dedicated app exists, and retains the result without creating or changing infrastructure.
- [x] Run the hosted preflight, select the exact Fly organization from retained evidence, and configure only the missing production authorities.
- [ ] Activate one coordinator and one worker, complete the real draft-only canary and readiness soak, then update requirement states from retained evidence.

Review: pull request 117 merged as `c8516be2a5d346766a24c4d866d24863f3086715`. Main run `31822603567` passed unit tests, agent evals, GA checks, dependency audit, typecheck, production build, API startup, every container build including Regauge, container startup, the production journey with crash recovery, Fly deployment, and workflow health verification. Independent live probes returned 200 from `/livez` and `/healthz`; the combined customer worker remains intentionally Regauge-disabled because the dedicated profile has not been activated. The protected environment and private canary metadata now exist. Local model credentials were not copied to GitHub without separate explicit authorization, and the dedicated infrastructure, GitHub App, storage, tenant, campaign, and approval secrets remain unset.

Hosted preflight review: workflow run `31824565761` passed on exact revision `24751eb0a1a48616276eb3aa35a7010d08dc24df`. Retained evidence proves the repository Fly token is valid, the authorized organization slug is `personal`, and `mendpoint-transformer-pilot` does not exist. The protected environment is restricted to protected branches and the current repository owner is a required reviewer. The private canary repository and bounded live model policy variables are configured. Three newly generated Regauge-only cryptographic authorities are protected; existing local model credentials were not copied without explicit authorization.

### Regauge managed checkpoint storage: 2026-08-14

- [x] Add red regressions for Fly Tigris standard environment variables, alias conflicts, private bucket provisioning, and removal of externally copied storage credentials.
- [x] Resolve one canonical S3 configuration for both production validation and the worker runtime.
- [x] Provision or adopt exactly one private Tigris bucket on the dedicated Fly app without logging credentials or making the bucket public.
- [x] Run focused tests, affected workspace tests and typechecks, workflow validation, dependency audit, and diff integrity.
- [ ] Merge through protected checks and rerun the read only Fly preflight before any activation mutation.

Acceptance: an organization-authorized bootstrap can provision private checkpoint storage directly into the dedicated Fly app, while the protected activation workflow verifies the exact staged or deployed Tigris secret names using only an app-scoped token. The Regauge runtime accepts Fly's standard Tigris aliases, conflicting custom and standard aliases fail closed, and no S3 credential is copied through GitHub.

Review: official Fly documentation and the installed CLI confirm `fly storage create --app ... --org ... --yes` provisions private Tigris object storage and injects `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` directly into the app. The protected workflow does not receive organization-wide add-on authority; it verifies those five secret names through the app-scoped Fly API before deployment. The runtime resolves the standard variables through one immutable configuration shared by production validation and execution, and any conflicting custom alias fails closed. Full Worker tests pass 285 of 285, the workflow suite passes 3 of 3, Worker typecheck and the 50-page production build pass, every Actions dependency is pinned, the production dependency audit reports zero vulnerabilities, Fly configuration validation passes, and diff integrity is clean.

### Catalog feed poll release hotfix: 2026-08-14

- [x] Reproduce the merged main failure under a fixed clock.
- [x] Make latest feed outcome selection deterministic when multiple polls share one timestamp.
- [x] Run the focused catalog test, the full Catalog suite, Catalog typecheck, and repository diff integrity.
- [ ] Merge through protected checks and prove the exact main revision deploys healthy before resuming Regauge preflight.

Acceptance: two feed polls written at the same clock instant select the newest inserted outcome deterministically, dispatch a queued pipeline once, and leave the second poll unchanged. Main CI and its production health gate return green.

Review: main run `31826317708` exposed one Catalog failure after the Regauge storage merge: two successful feed polls with an identical `polled_at` timestamp were ordered nondeterministically, so the older hash could be selected and the second pipeline poll returned `new_version`. A fixed-clock regression reproduced the failure. Feed history now orders equal timestamps by newest SQLite row ID. The focused test passes 8 of 8, full Catalog passes 45 of 45, full DB passes 213 of 213, both workspace typechecks pass, and diff integrity is clean.

### Regauge production campaign bootstrap: 2026-08-14

Objective: make a new dedicated Regauge coordinator capable of establishing one exact, independently reviewed, draft-only canary campaign before any worker is activated. A configured campaign identifier on an empty volume is not campaign authority.

- [x] Define red tests for a coordinator-local bootstrap contract that binds the tenant, GitHub App installation, private repository, exact snapshot, planner, independent reviewer, recipe, gate, and production approval evidence.
- [x] Compose existing repository materialization, mission planning, blueprint review, and execution launch authorities without a seed or mock fallback.
- [x] Make exact replay idempotent and reject changed repository, revision, reviewer, objective, recipe, gate, or campaign bindings.
- [x] Integrate bootstrap after coordinator provisioning and before worker scaling in the protected Regauge workflow.
- [x] Prove a fresh volume cannot report worker-ready until the exact campaign exists and is executable.
- [x] Run focused and full tests, typechecks, production build, workflow validation, dependency audit, and diff integrity.
- [ ] Merge and deploy through protected CI before resuming the dedicated Fly activation.

Acceptance: a fresh dedicated coordinator can use an approved GitHub App installation to materialize the exact private canary revision, persist immutable snapshot and policy evidence, require an independent human blueprint approval, launch exactly one bounded production campaign, and return an authenticated bootstrap receipt. Replays return the same receipt. Drift or missing approval fails before the worker is scaled above zero.

Review: the bootstrap now runs before worker credential creation and API startup, materializes only the protected branch at commit `1f6b21665d68541c9f3c9dda81642485a66a6baa`, selects the single Node 20 to Node 22 recipe, normalizes CODEOWNERS identities, requires a distinct human reviewer, launches one execution campaign, and records a hash chained receipt. Receipt replay revalidates both control-plane and execution authority, so a surviving receipt cannot hide a deleted or drifted campaign database. Coordinator and worker readiness are bound to the exact tenant and campaign; a fresh volume returns 503 until bootstrap succeeds, while a later paused campaign remains observable for safe reconciliation. Revision mismatch now stops before GitHub tree content is read.

Verification: every workspace test passes, all workspace typechecks pass, the 50-page production build passes, GA/spec/claims/names/action-pin gates pass, the generated docs bundle is current, production dependency audit reports zero vulnerabilities, Fly configuration validates, and diff integrity is clean. The protected environment contains the authorized local model values plus the exact nonsecret canary repository revision and reviewer identity. Production activation is still withheld because the GitHub App installation ID, App ID, private key, and webhook secret are absent, and the durable delivery gate write was rejected as broader than the one-draft authorization. No deployment or SCM mutation was attempted.

## Fettler post pull request review feedback loop: 2026-08-14

Objective: let an engineer request changes on a Fettler draft in GitHub and receive one new bounded, checkpointed repair candidate without trusting webhook text, widening scope, resetting budgets, or bypassing fresh Mendpoint approval.

### Authoritative observation

- [x] Add red tests for current-head change requests, unresolved inline comments, stale or dismissed reviews, outdated or resolved threads, pagination, bounds, and prompt-safety redaction.
- [x] Extend exact GitHub draft observation to return immutable current-head review feedback with stable evidence identities.
- [x] Keep webhooks wake-only: normalize stable review and review-comment identities, then refetch the pull request authoritatively before any model input.

### Durable reentry

- [x] Add a tenant, installation, repository, pull request, and head-bound cycle wake transition with transactional idempotency.
- [x] Convert green-check review feedback into the existing cumulative-budget repair dispatch while preserving exact snapshot, allowed paths, model policy, and verification policy.
- [x] Require the existing fresh human candidate approval before the same draft branch can change, then reobserve the new exact head.

### Verification and release

- [x] Run focused GitHub, DB, API, Worker, and joined repair-update tests, then full affected suites and typechecks.
- [x] Run repository release gates, production build, dependency audit, diff integrity, and an independent P0/P1 review.
- [ ] Commit, push, merge through protected CI, verify the exact main deployment, and retain rollback evidence.

Acceptance: a signed GitHub review or review-comment webhook can only wake an exact known Fettler draft cycle. The worker refetches fully paginated current-head review state, persists bounded redacted evidence, enqueues at most one standard checkpointed repair under inherited cumulative budgets and unchanged path authority, and cannot update GitHub until a fresh authorized human approves the new candidate. Duplicate, stale, dismissed, outdated, resolved, cross-tenant, paused, exhausted, or drifted input performs no mutation.

Review: GitHub review and review-comment payloads are wake-only and tenant authority is derived from the active installation plus exact repository, pull request, and head binding. The worker refetches current-head GitHub reviews and threads, rejects incomplete pagination, keeps only active human change requests, redacts prose, caps feedback at 64 KiB and total observation evidence at 128 KiB, and binds the resulting digest through repair, fresh human approval, and the final branch mutation. A second authoritative read immediately before GitHub rejects dismissed, edited, resolved, or otherwise drifted feedback. Regeneration now consumes the delivery-wide cycle budget rather than resetting it. The full repository test command, every workspace typecheck, the 50-page production build, GA/spec/claims/names/action-pin gates, dependency audit, and diff integrity pass. The final bodyless-change-request regression was observed red before the observer was corrected and passes green.

## Regauge one-draft activation authority: 2026-08-14

- [x] Derive the delivery approval, evidence, and gate from the protected workflow run instead of reusable environment secrets.
- [x] Bind the approval to the exact tenant, campaign, repository ID, release revision, run, attempt, and one draft.
- [x] Scale the delivery worker to zero after success or failure and retain containment evidence.
- [x] Run red-first workflow/profile tests, affected suites, typechecks, workflow parsing, and diff checks.
- [x] Request only the remaining GitHub App secret-transfer authority after the reusable gate is removed.

Acceptance: the protected workflow cannot persist or reuse a generic production delivery approval. Every activation creates one exact run-scoped approval for the authorized canary, and every outcome leaves the coordinator available for evidence while the delivery worker is stopped.

Review: the protected workflow now derives an exact one-draft approval, evidence record, and gate from the approved tenant, campaign, numeric repository ID, release revision, workflow run, and attempt. The worker rejects missing, malformed, drifted, future-dated, or expired activation authority before provider or GitHub work, rechecks expiry before every coordinator poll and immediately before draft delivery, and reports not ready after expiration. The workflow contains the worker at zero after every normal outcome and retains a structured containment record; the authorization window is seventy minutes, the job is sixty minutes, and the readiness soak is capped at thirty minutes. Red regressions were captured at every new boundary. The focused matrix passes 25 of 25, all repository tests pass, every workspace typecheck passes, the 50-page production build passes, GA/spec/claims/names/action-pin gates pass, docs are current, the production dependency audit reports zero vulnerabilities, Fly configuration validates, and diff integrity is clean. Activation still requires separate authority to transfer or replace the GitHub App private key and webhook secret; no infrastructure or SCM mutation was performed by this source patch.

## Fettler green-baseline feature tasks: 2026-08-14

Objective: let an engineer delegate an explicitly declared feature task when the approved verification baseline is green, while preserving repair-mode fail-closed behavior and every existing snapshot, path, model, budget, review, and delivery boundary.

- [x] Add red attempt-engine tests proving feature mode requires a fully green baseline, produces a nonempty independently verified candidate, and keeps repair mode baseline-failure-only.
- [x] Add red API and worker tests proving the task mode is explicit, authenticated, persisted, and bound into checkpoint authority.
- [x] Add the task-mode control through intake, job payload, attempt execution, evidence, and operator UI without changing the default repair contract.
- [x] Prove takeover cannot reopen one mode as another and feature mode cannot waive a failing baseline command.
- [x] Run focused and full tests, all typechecks, production build, release gates, dependency audit, and diff integrity.

Acceptance: `mode: feature` runs only when every approved source verification command passes, requires at least one intent-bound source change, independently reruns every command on the candidate, and enters the existing human review and draft-only delivery path. Missing mode remains repair for compatibility. A repair task with a green target remains no action; a feature task with any failing baseline is rejected before model or mutation work.

Review: feature mode is explicit from the operator form through authenticated API intake, durable job payload, policy routing, private attempt execution, checkpoint authority, candidate manifest, review evidence, and completed run records. It requires an approved model, excludes repair-only error-log context, requires every baseline target, regression, and security command to be green before planner execution, requires a nonempty intent-bound diff, and independently reruns every verifier before entering the unchanged human review and draft-only delivery path. Missing mode remains repair. Default repair checkpoint and routing authority remain byte-compatible with the deployed revision, while feature mode uses a distinct bound authority domain.

Verification: red regressions were observed for green-baseline early exit, red-baseline planner execution, missing model admission, stale repair context, missing Eval planner mode, changed checkpoint authority, and changed repair routing descriptors. The final full repository test command and every workspace typecheck pass. The 50-page production build, GA/spec/claims/names/action gates, generated-doc drift check, production dependency audit, Fly configuration validation, and diff integrity pass. A real local API process returned 200 from `/live`, `/health`, `/ready`, and `/version` with database and schema checks valid. The Docker-backed Playwright deployment journey could not start because Docker is not running on this host; protected CI must supply the container, crash-recovery, and browser evidence before merge.

## Fettler review-feedback documentation correction: 2026-08-14

- [x] Add a regression that rejects the obsolete not-implemented review-feedback limitation.
- [x] Update the canonical Fettler and draft-delivery docs to describe the shipped, bounded current-head feedback path.
- [x] Regenerate the website upload bundle and run focused docs, claims, names, web typecheck, production build, and diff checks.
- [ ] Merge through protected CI and visually verify the corrected production page.

Acceptance: public Fettler documentation must describe the shipped GitHub requested-change reentry path without broadening its authority. It must state that only fully paginated, current-head, active change requests can reenter, comments do not authorize mutation, cumulative budgets remain in force, and a fresh Mendpoint human approval is required before the branch changes.

Review: post-deploy desktop and mobile browser QA on the Fettler guide found the obsolete limitation with zero console or network errors and no horizontal overflow. A focused regression failed on the stale wording before the catalog was corrected. Fettler and draft delivery now describe authoritative current-head requested-change observation, full pagination, inherited cumulative budgets, unchanged path scope, untrusted comment evidence, and fresh human approval. Full Web tests pass 164 of 164, Web typecheck and the 50-page production build pass, claims and naming gates pass, the generated upload bundle is current, and diff integrity is clean.

## Regauge protected activation authority continuation: 2026-08-14

- [x] Reconfirm exact current main and the protected one-draft workflow before mutation.
- [x] Verify the authorized private canary repository ID and exact baseline revision.
- [x] Prove the existing GitHub App installation can read the exact private canary repository without exporting its private key.
- [x] Verify the App identity and exact least-privilege installation permissions, then bind its public App ID.
- [x] Bind the installation ID, reviewer identity, model provider, execution region, and account-to-tenant map in the protected environment.
- [x] Refresh the read-only hosted Fly preflight on exact current main and retain its evidence.
- [ ] Transfer or replace the GitHub App private key and webhook secret under explicit secret-transfer authority.
- [ ] Run the protected activation, one real draft-only canary, readiness soak, restart recovery, and containment verification.

Review: current main is `a880aad0974ef40e523a28130dc8bf4604639be4`. The protected environment contains the previously authorized Regauge model URL, model ID, and API key by secret name, plus the exact tenant, campaign, installation, reviewer, repository, revision, provider, region, and tenant-account bindings. A short-lived token minted inside the existing production Fly machine proved installation `151614362` can read private repository `gondalaimafia/mendpoint-canary-drill-20260801` with repository ID `1319732323`; no App key left the machine. A signed installation read additionally proved App ID `4502800`, selected-repository scope, no suspension, and exactly `checks:read`, `contents:write`, `metadata:read`, and `pull_requests:write`; the public App ID is now bound in the protected environment. Read-only workflow run `31846991594` passed on exact main and retained Fly preflight evidence. The dedicated app still does not exist. Activation remains fail-closed because `REGAUGE_GITHUB_APP_PRIVATE_KEY` and `REGAUGE_GITHUB_WEBHOOK_SECRET` are absent; those credentials were not copied because the current explicit authorization covered only the local model credentials.

## Fettler precise edit review authority: 2026-08-14

- [x] Add red schema, attempt, approval, and delivery regressions for complete source-bound edit evidence.
- [x] Preserve existing version one review evidence and version three approval artifacts for already-created candidates.
- [x] Emit version two review evidence with the exact hypothesis, target symbol, source evidence, precondition, expected observation, postcondition, rollback, stop condition, risk, confidence, and verifier digests.
- [x] Bind new review evidence and candidate manifests to persisted SHA 256 digests before human approval.
- [x] Seal version two evidence only inside a version four approval artifact and render its full authority in the draft pull request.
- [x] Run focused adversarial tests, every workspace test, every workspace typecheck, the production build, GA gates, dependency audit, and diff integrity.
- [x] Commit, push, merge through protected checks, and verify the exact deployed revision.

Acceptance: every newly generated Fettler candidate exposes enough authenticated evidence for a reviewer to understand exactly why each file changed, what source observation authorized it, which condition must remain true, what outcome was expected, how to roll it back, when execution should stop, and which independent verifier outputs passed. Rewriting a valid-looking evidence artifact after execution must fail before approval. Existing version one candidates remain reviewable and deliverable.

Review: red tests first failed at all four intended boundaries because only review evidence version one and approval artifact version three existed. The implementation now emits version two precise edit evidence, stores one immutable digest snapshot for both terminal checkpointing and the durable run result, requires exact manifest and evidence bytes for every new candidate review, and seals version two only as approval artifact version four. The delivery worker renders every source-bound field while retaining the legacy body for existing approvals. A focused tampering regression proves valid JSON with a changed rollback instruction is rejected. All repository tests pass, all workspace typechecks pass, the 50-page production build passes, GA/spec/claims/names/action-pin gates pass, the production dependency audit reports zero vulnerabilities, and diff integrity is clean.

## Fettler precise evidence review UI: 2026-08-14

- [x] Add red rendering tests for authenticated review evidence versions one and two.
- [x] Render every version two source, condition, risk, confidence, and verifier field before the human decision controls.
- [x] Preserve the version one candidate review experience for already-created candidates.
- [x] Run focused and full Web tests, Web typecheck, the production build, release gates, dependency audit, and diff integrity.
- [ ] Commit, push, merge through protected checks, and verify the exact deployed revision and review page in a browser.

Acceptance: before a reviewer can approve, regenerate, or reject a newly generated Fettler candidate, the page displays the exact authenticated hypothesis, target symbol, source paths and digests, precondition, expected observation, postcondition, rollback, stop condition, risk, confidence, assessment source, and verifier evidence returned by the candidate API. Existing version one candidates remain readable.

Review: the existing candidate page was statically limited to review evidence version one and omitted the newly authenticated precise edit fields. The new typed panel renders both versions, with every version two source and condition visible ahead of file diffs and the human decision controls. React performs all text escaping, arrays remain bounded by the authoritative shared schema, and no second evidence source was introduced. The focused test first failed because the panel did not exist. The final focused tests pass 4 of 4, full Web passes 166 of 166, all workspace typechecks pass, the 50-page production build passes, GA/spec/claims/names/action-pin gates pass, the production dependency audit reports zero vulnerabilities, and diff integrity is clean. The full repository suite had one Windows temporary-directory rename race while tests and typechecks ran concurrently; the complete Ops suite then passed 94 of 94 in isolation.

## Fettler exact file deletion: 2026-08-14

Objective: let Fettler remove an obsolete tracked source file as one evidence-bound mutation and deliver that deletion in the same human-reviewed, replay-safe draft workflow as file writes.

- [x] Add red tests for source-observed deletion, protected-path rejection, rollback restoration, runtime replay, and stale-fence rejection.
- [x] Add red tests proving candidate manifests and approval artifacts retain the deleted file preimage, absent post-state, precise intent, and verifier evidence.
- [x] Add red tests for initial GitHub draft deletion, review-feedback update deletion, exact response-loss reconciliation, and omitted or extra tree changes failing closed.
- [x] Implement the smallest end-to-end delete-file operation without widening path, model, network, merge, or deploy authority.
- [x] Run focused suites, every workspace test and typecheck, the production build, GA gates, dependency audit, diff integrity, and independent P0/P1 review.
- [ ] Merge through protected CI and verify the exact production revision.

Acceptance: a model or deterministic planner may delete only an allowed, fully observed regular file with an authenticated version-one mutation intent bound to its exact digest. The checkpoint journal records the pre-state and authenticated absent post-state, takeover does not repeat an already-completed deletion, rollback restores the exact bytes and mode, review evidence states why the deletion is safe, and GitHub draft creation or update removes exactly that leaf while preserving every other tracked leaf. Human approval remains mandatory, and Fettler still cannot merge or deploy.

Review: the operation now shares Fettler's existing containment, symlink, protected-path, observation, change-budget, intent, lease, checkpoint, verification, review, approval, and delivery authorities. Durable takeover replays the authenticated absent state without repeating the tool effect, and rollback retains the original bytes and executable mode. GitHub and GitLab initial drafts and same-draft review updates express deletion as an exact tree operation. A strict review found and closed two additional fail-closed boundaries: durable planning now uses the same path resolver as tool execution, and response-loss recovery treats only an authoritative 404 as proof of deletion rather than accepting transport or provider failures. Full affected Agent, GitHub, Worker, API, Eval, Pipeline, and ReGauge suites pass at bounded concurrency; every workspace typechecks; the production build, GA gates, production dependency audit, and diff integrity pass. The unconstrained Windows workspace run saturated process and filesystem timing budgets in unrelated tests; every reported case passed in its complete package or isolated bounded rerun.

## Governed model learning and post training: 2026-08-14

Capability: every verified Fettler or ReGauge migration outcome can become a governed learning event, a validated lesson, and a correctly classified improvement to model weights, router policy, retrieval, graph, parser, tooling, deterministic recipes, prompts, calibration, or product logic. Eligible model lessons can proceed through immutable datasets, disjoint train, validation, and holdout partitions, authenticated training, unseen evaluation, human promotion, selective routing, shadow or canary use, monitoring, and rollback. Work outcome capture never implies permission to train, and training completion never implies permission to serve.

### Constraints and trust boundaries

- [x] Keep raw repository content out of the base lesson record. Store only fail closed redacted derivatives, immutable digests, review authority, verification evidence, temporal cutoff, tenant, purpose, and residency.
- [x] Require an active purpose specific consent and a tenant administrator for dataset sealing and corpus materialization. Revocation and deletion must remove records from future eligibility without rewriting sealed evidence.
- [ ] Preserve exactly once trainer dispatch, authenticated response loss reconciliation, database time leases, evaluation and canary gates, human promotion, monitoring, and rollback.
- [x] Keep training and serving external through explicit authenticated ports. Do not claim Mendpoint ships model weights or a trainer until a real configured provider returns durable evidence.

### Build

- [x] Verify the actual repository control flow and document it in `docs/learning/current-state.md`.
- [x] Record the parallel Claude ownership boundary and collision protocol in `docs/learning/parallel-work-notes.md`.
- [x] Replace the inferred plan with the master prompt implementation and acceptance contract in `docs/learning/implementation-plan.md`.
- [x] Define one versioned learning event for Fettler, ReGauge, and synthetic ground truth, with canonical provenance, bounded observable output, router economics, tenant, residency, consent, and immutable references.
- [ ] Capture approved, rejected, corrected, failed, abstained, escalated, merged, and rolled back Fettler and ReGauge outcomes without storing private chain of thought.
- [x] Extract evidence validated lessons and classify them into model weight, router policy, retrieval, graph, parser, tooling, deterministic recipe, prompt, product logic, calibration, or no action.
- [x] Add red tests for a generic consented dataset to corpus operation, exact replay, tenant isolation, stale or revoked consent, temporal leakage, empty datasets, artifact digest verification, provenance separation, quarantine, and train to holdout leakage.
- [ ] Build capability specific datasets and deterministic train, validation, and holdout exports that distinguish synthetic development, synthetic hidden, design partner, and production holdouts.
- [ ] Add red API tests for consent grant and revocation, learning status, dataset sealing, corpus materialization, training dispatch, status, reconciliation, cancellation, candidate registration, lifecycle transition, canary, rollback, and least privilege authorization.
- [ ] Join the trainer to Claude's synthetic evaluation boundary without modifying Claude's benchmark or allowing train scenarios into hidden holdouts.
- [x] Register trained candidates with exact lineage, compare them against the current baseline, reject regressions, require independent human promotion, and make approved candidates selectively router eligible.
- [ ] Add an injected serving path with immediate consent and lifecycle checks, shadow and bounded canary allocation, monitoring, circuit breaking, and atomic rollback.
- [ ] Record router decisions, execution economics, calibration, abstention, and canary outcomes as new governed learning events.
- [ ] Add threshold based scheduling that prepares datasets and candidates but never promotes automatically.
- [x] Add tenant scoped status counts for events, lessons, datasets, training, evaluation, canary, and adapters; retain full traffic and operations dashboards as an explicit follow-up.
- [x] Correct verified API documentation and naming, then create `docs/learning/ship-readiness.md` with every master prompt answer marked ready, ship blocker, or explicitly deferred.

### Verification and shipment

- [ ] Prove one joined Fettler and one joined ReGauge path from mission outcome through next generation learning, including unverified, consent, tenancy, residency, duplicate, timeout, response loss, forged receipt, failed holdout, rejection, approval, canary failure, and rollback cases.
- [x] Run focused red and green suites, all affected package suites and typechecks, full repository tests, production build, GA gates, dependency audit, migration validation, and diff integrity.
- [x] Reconcile Claude's concurrent diff before each commit and before push. Preserve unrelated changes and stop on overlapping edits.
- [ ] Push a reviewed branch, open a pull request, require protected CI, merge only when green, verify the exact deployed revision, and probe the authenticated learning surface.
- [ ] Verify feature flags, trainer configuration, model registry, monitoring, rollback, and governance before activation. A missing external trainer or serving authority remains a ship blocker rather than a mocked production claim.

Acceptance: Fettler, ReGauge, and Claude's synthetic system emit standardized governed events whose provenance remains distinct. Observable outcomes become validated lessons and only true model learning lessons enter immutable capability datasets with reproducible disjoint splits. Training dispatch is crash safe and authenticated. Candidate lineage, unseen evaluation, human promotion, selective router eligibility, shadow or canary traffic, monitoring, and rollback are durable and auditable. Router, production, and rollback outcomes feed the next cycle. No unreviewed work, private chain of thought, raw secret bearing content, cross tenant data, failed evaluation, leaked holdout, revoked consent, stale lifecycle, or unconfigured trainer can train or serve a model.

Review: the branch now contains a common bounded Fettler and ReGauge event, authoritative lesson classification, purpose-specific consent, immutable disjoint corpus artifacts, crash-safe external training, independent evaluation, a separate canary authority, exact human registration, selective router eligibility, and human rollback. The joined API proof covers consent through rollback, while `docs/learning/ship-readiness.md` records automatic product capture, live providers, real adapter invocation, live canary traffic, and next-generation feedback as blockers rather than shipped behavior. Claude's landed eval harness was merged from current main; its 44 tests pass, but its checked-in ground truth remains development data and is not represented as an unseen holdout. Final local evidence: 89 focused learning and proxy tests pass, full Pipeline passes 72 of 72, full API passes 381 of 381, full Web passes 167 of 167, the complete workspace test command passes, every workspace typechecks, the 50-page production build passes, GA/spec/claims/names/action-pin gates pass, docs are current, the production dependency audit reports zero vulnerabilities, and diff integrity is clean.

## Tomorrow: Regauge protected activation authority: 2026-08-18

- [ ] Keep the protected activation workflow fail closed until both `REGAUGE_GITHUB_APP_PRIVATE_KEY` and `REGAUGE_GITHUB_WEBHOOK_SECRET` are present through an explicitly authorized secret transfer or replacement.
- [ ] Re-audit the protected environment for every required nonsecret reviewer and model-routing binding used by `.github/workflows/regauge-production.yml`.
- [ ] Resolve each missing nonsecret binding from an existing authoritative repository, GitHub environment, installation, or runtime source. Do not infer or synthesize reviewer or routing authority.
- [ ] Rerun the read-only protected preflight and retain exact evidence before any activation mutation.
- [ ] Only after every authority is complete, run the one-draft canary, readiness soak, restart recovery, and containment verification.

Acceptance: the workflow remains unable to deploy or deliver while either GitHub credential or any exact reviewer/model-routing authority is absent. Completing the checklist requires authoritative source evidence for every binding, a green read-only preflight, and a separately authorized protected activation.

## PR 140 strict integration review: 2026-08-17

- [x] Rebase the review onto current main after PR 143.
- [x] Reproduce first-party workspace code being misclassified as vendored third-party code.
- [x] Preserve declared workspace packages as editable first-party source.
- [x] Exclude block-comment-only field mentions from confident edit sites.
- [x] Preserve case-insensitive Go and Java field discovery.
- [ ] Run focused tests, typechecks, full protected CI, and merge PR 140.

Acceptance: vendored third-party copies remain update-only references, while declared first-party workspace packages and capitalized language-level field references remain eligible edit sites. Reachable block comments cannot create confident migration edits.

Review: the first strict probe reproduced a declared npm workspace package being classified as vendored. Three red regressions then isolated that boundary, a multiline block-comment false positive, and a capitalized Go field miss. The implementation now recognizes root npm and pnpm workspace declarations before treating nested package boundaries as third party, scans comments and strings across the complete source instead of resetting at each line, and matches language-level fields without case sensitivity. The focused regression passes 7 of 7, full Code Impact passes 65 of 65, Shared passes 43 of 43, Eval passes 109 of 109, both relevant synthetic edge scenarios pass with 100 percent precision, and all affected package typechecks pass. Protected CI and final merge remain pending.

## Dual agent engineering workflow: 2026-08-17

- [x] Read the attached Codex, Claude, review, protocol, security, and definition of done instructions.
- [x] Compare the setup package with current main, open work, and repository checks.
- [x] Install the authoritative workflow files in an isolated Codex worktree.
- [x] Protect main with the exact pull request checks without requiring an unavailable reviewer integration.
- [x] Validate configuration syntax, links, secret boundaries, naming, specification integrity, and repository gates.
- [x] Commit and push the isolated branch, open the dogfood pull request, and request Claude review.
- [x] Record the attributable review response or the exact integration blocker.

Acceptance: Codex and Claude have separate branch and worktree conventions, one shared issue and pull request protocol, conservative credential boundaries, actual current pull request checks, a review handoff contract, and an authoritative product specification. The setup itself is introduced through a protected pull request and is not self merged.

Review: main now requires the current pull request checks `test`, `release-gates`, `container-builds`, and `deployment-e2e`, dismisses stale reviews, requires resolved conversations, applies to administrators, and rejects force pushes and deletion without locking the branch. Approval count remains zero until an attributable reviewer integration is proven, preventing a sole-maintainer lockout while the documented human merge boundary remains in force. Claude JSON and Codex TOML parse, all local Markdown links resolve, the setup contains no credential material, the Markdown specification digest is `sha256:a62e1b0a7569b9599cf8b155d6489a99c11f47a892885981ced61c3a573f74c9`, and the 73-page PDF contains the Fettler and ReGauge product identities. All workspace tests, all workspace typechecks, the 50-page production build, product contract, public claims, action pinning, and product naming gates pass.

Dogfood evidence: commit `8cca909` is pushed on `codex/141-dual-agent-setup`, and pull request `#142` closes issue `#141` under the new main protection. The review request is recorded at `https://github.com/gondalaimafia/mendpoint/pull/142#issuecomment-5319134808`. The trigger produced no attributable Claude acknowledgement, comment, or review during the bounded verification window, so Claude review automation remains an exact external integration blocker rather than a claimed capability. The pull request remains open and unmerged for human control.

## Regauge protected production activation execution: 2026-08-17

Objective: activate the dedicated Regauge pilot only for the previously authorized tenant, campaign, private repository, exact source revision, independent reviewer, and one draft pull request, then retain live model, readiness, recovery, soak, and containment evidence tied to the deployed source revision.

- [x] Start from exact deployed main and verify the protected workflow source.
- [x] Verify both authorized GitHub credentials are present by secret name without reading their values.
- [x] Verify every required tenant, campaign, repository, installation, reviewer, model routing, region, classification, and cost binding from authoritative GitHub environment or repository state.
- [x] Revalidate private repository ID `1319732323`, branch `codex/regauge-canary-baseline`, and revision `1f6b21665d68541c9f3c9dda81642485a66a6baa` immediately before activation.
- [ ] Run the protected workflow with `REGAUGE_DRAFT_ONLY`, three live model repetitions, and a 300 second read only soak.
- [x] Fix the real GitHub App authorization check so an exact repository-scoped installation token is accepted even when GitHub omits meaningful `permissions.pull` metadata from the repository response.
- [x] Add a regression matching the live GitHub response, run the affected package and activation gates, and merge the fix through protected CI before retrying activation.
- [ ] Deploy and prove the coordinator before deploying a worker whose readiness depends on that coordinator, then merge the red-first workflow regression through protected CI.
- [ ] Prove one healthy coordinator and one uniquely identified worker on the exact workflow revision, with encrypted shared checkpoint storage ready.
- [ ] Prove exactly one real GitHub draft against the authorized repository, no merge, no deployment, and no mutation outside the approved branch and repository.
- [ ] Prove worker containment, restart or takeover recovery, bounded live model cost, readiness soak, and retained workflow artifacts.
- [ ] Update requirement and public claim states only where retained production evidence is exact, then merge any evidence-only repository update through protected checks.

Acceptance: no activation begins until the protected environment is complete and the read-only authority audit passes. Success requires the dedicated hostname to resolve, the exact source revision to be healthy, the live model lane to pass within budget, the authorized canary to create exactly one draft pull request, and the workflow to contain the worker after the evidence run. Any missing authority, source drift, reviewer mismatch, provider error, uncertain source-control result, or readiness failure must leave the run failed and mutation authority contained.

Interim review: protected run `32082417252` proved the App installation is selected-repository scoped and includes the exact private canary repository, but coordinator boot failed closed because `createGitHubRepositorySource` also required `permissions.pull === true`. GitHub returned the exact repository with HTTP 200 under a token explicitly restricted to repository ID `1319732323`, while its generic repository `permissions` object contained all false values. No model call or source-control mutation occurred. The corrected source check binds the authenticated response, exact numeric repository ID, and exact full name instead of treating user-oriented permission metadata as installation authority. The live response regression first failed at that boundary and now passes; full Platform passes 178 of 178, focused API and activation suites pass 18 of 18, every workspace typechecks, GA gates pass, and diff integrity is clean. Protected CI and merge remain pending before another activation attempt.

Activation retry review: pull request 160 merged as `cce5727df29371a34bb650f02646df05f833d086`, and the exact main run `32083901143` passed release, test, synthetic evaluation, GA, container runtime, browser journey, crash recovery, deploy, and production health gates. Protected run `32084500381` then passed authority, app, volume, storage, and secret validation, but Fly's rolling multi-process deployment started the worker before replacing the previously failed coordinator. Worker readiness correctly failed because the coordinator dependency was still unavailable, so no model evaluation or source-control delivery began. A new red-first workflow regression requires a healthy exact-revision coordinator before the worker deployment.

Protected CI review: pull request run `32085792187` proved the coordinator-first branch through tests, release gates, container startup, and the deployment journey. Two hosted runners timed out before the journey because Playwright's `--with-deps` path hung while refreshing the unreachable Azure Ubuntu mirror; the exact log never reached product code. A fresh runner completed the same browser install and full journey in 2 minutes 41 seconds. The final current-main validation now installs only the pinned Chromium binary and relies on the hosted Ubuntu image's preinstalled system libraries, with the protected browser journey retained as the authoritative compatibility proof.

Runtime activation review: pull request 166 merged as `5ea1e6bd8866b4b20d6706c7254c0eb5800ec7ac`, and exact-main run `32089123504` passed tests, release gates, container builds, deployment E2E, deploy, and production health. Protected activation run `32089435387` then passed authority, application, volume, object storage secret-name, and protected credential staging checks. Its coordinator failed closed before listening because Fly invoked the image's base entrypoint and the fresh mounted volume did not yet contain `/data/repos`; the worker was never deployed, and no model or SCM operation began. The health loop also lacked a per-request timeout, so an unavailable proxy could consume the job-level timeout. The run was canceled after the exact failure was retained. Red-first regressions now require the checked-in Fly profile to invoke `/app/scripts/start-transformer-entrypoint.sh` for both roles and require every public revision/readiness request to terminate after ten seconds. Both focused suites, the Actions policy check, worker typecheck, Fly manifest validation, and diff integrity pass locally. Protected CI, merge, and activation retry remain pending.

Image-stage review: pull request 170 merged as `6488ab21b2ec1e2aaa0223ced7eead7779e7fa16`, and exact-main run `32090477234` passed tests, agent and synthetic evals, release gates, the production build, API smoke, every container build and runtime start, the deployment journey, deploy, and production health. Protected run `32090908515` proved the Fly entrypoint override reached the coordinator, then failed closed because `[build].target` is not Fly's multistage key. The API stage therefore supplied a present but non-executable script. The worker, live model evaluation, draft canary, and soak were skipped, containment succeeded, and the crash-looping coordinator was scaled to zero. The official Fly configuration contract requires `[build].build-target`; a red regression now distinguishes that exact key from the ignored spelling before the one-line manifest correction.
## Fly sandbox image and egress provisioning: 2026-08-18

Objective: publish the exact sandbox runtime image, retain its immutable registry digest, converge the dedicated `mendpoint-sandbox` Fly app, enforce default-deny outbound traffic for every sandbox Machine, and rotate a sandbox-scoped Fly token into the deployed verifier without exposing credential material.

- [x] Start from a clean worktree at current `origin/main` and inspect the sandbox image and verifier runbooks.
- [x] Verify Fly authentication, existing app inventory, and deployed verifier secret names without reading secret values.
- [x] Run focused sandbox image, Fly adapter, and verifier tests from the exact build commit.
- [x] Build and push `Dockerfile.sandbox` with the Fly remote builder and capture the registry `@sha256:` digest.
- [x] Converge the `mendpoint-sandbox` app and apply a network policy selecting every Machine with default-deny egress.
- [x] Prove the policy exists through the Fly Machines API and run a direct-IP blocked-egress canary.
- [x] Mint a sandbox-app-scoped token, set `MENDPOINT_SANDBOX_FLY_TOKEN` on the deployed verifying app, and verify its health after restart.
- [x] Record the final image, policy, app, secret, and health evidence below.

Review: the exact image source commit was `3eb2724df86d99e339c557fc75dc036161a2ebbc`. The remote builder published `registry.fly.io/mendpoint-sandbox:sha-c1f0ccb583e8`, resolved by the live canary to `registry.fly.io/mendpoint-sandbox@sha256:6eacb37b3a9a795d2fed6baf4b032ced118c639e6d4d523b2bc9db9ff1a95c88`. The existing empty `mendpoint-sandbox` app was retained and converged. Network policy `01KZC4JJ74H8XMAYKZ2XQMTQFC` selects all Machines and permits only the API-required TCP port-0 sentinel, so all usable outbound ports are denied. A live direct-IP connection to `1.1.1.1:443` returned `EGRESS_BLOCKED:TimeoutError`. The canary also exposed that Fly's `/exec` endpoint ignores the OCI image user and starts as root; a red-first adapter regression now requires every verification command to execute through `/usr/sbin/runuser -u node`, and the live image proved `uid=1000(node)`. The full Platform suite passes 196/196, the joined Repair sandbox suite passes 6/6, the API sandbox suite passes 6/6, full repository typecheck passes, and the production build passes. A 90-day app-scoped token expiring 2026-11-16 was installed as deployed secret `MENDPOINT_SANDBOX_FLY_TOKEN` on `mendpoint-talal`. Its rolling restart reached one passing health check, and both `/healthz` and `/livez` returned HTTP 200. The canary was destroyed; the sandbox app retains no Machines and no public IPs.

## Change Graph, Muse, verifier, and sandbox release integration: 2026-08-18

Objective: review Claude's broader intelligence implementation as one release unit, make its architecture authority reproducible, prove the exact model behind every Muse result, and integrate the already-provisioned sandbox controls into the open deployment changes.

- [x] Inventory every unique commit and dirty change in PRs 202, 182, 190, 164, and 165 against current main.
- [x] Check the exact governing Change Graph authority document into the repository and verify its SHA-256 from a repository gate.
- [x] Remove any unsupported ADR approval assertion and bind ADR-0005 to separately recorded owner authority.
- [x] Prove the deployed provider and exact model identity without exposing credentials.
- [x] Make Muse-specific evaluations fail closed unless requested and echoed provider/model identity match the approved binding.
- [x] Rebase and repair the sandbox demo and customer profile changes with the immutable image digest, app, policy, and token prerequisites already proven.
- [x] Run focused graph, eval, verifier, sandbox, typecheck, build, and release gates on the combined candidate.
- [x] Perform a final security and regression review before pushing one coherent pull request.

Acceptance: no architectural approval depends on an absent local file, no metric labeled Muse can be produced by an implicit fallback model, and no sandbox profile is merged until the checked-in app, image, default-deny policy, and scoped token contracts match live evidence.

Review: the release unit is Claude's larger intelligence implementation, not the sandbox prerequisite. The Change Graph authority is checked in byte-for-byte at SHA-256 `5a37d827a4a1126ea1323d41bde8cbc5aa6b7ffca843b21895f5f942da8c58cc`, ADR-0005 records owner authority without inventing approval, and production configuration pins `muse-spark-1.2-contributor` for generation and evaluation identity. DeepSeek remains default-off and shadow-only; deterministic evidence remains authoritative. The review fixed invalid probability fixtures exposed by strict backend accounting, preserved the authority file against Windows line-ending conversion, and admitted real production corpus examples through repository-bound evaluation identities while retaining synthetic scenario identities for generated examples.

Verification: all workspace typechecks; production web build with 50 pages; Worker 334 of 334; Pipeline 89 of 89; Verifier 47 of 47; synthetic eval 161 of 161; GA, architecture, model, claims, names, action-pin, docs, and Fly configuration gates; zero production dependency vulnerabilities; import side-effect probe; secret scan; and API `/health` plus `/ready` 200 passed. One unchanged repository materialization test exceeded its 15-second budget during the fully loaded monorepo rerun; the exact file then passed 14 of 14 without changing a production timeout, and the complete API suite had already passed 392 of 392 earlier in the same review. The larger learning flywheel still does not automatically join every Fettler and Regauge terminal outcome into the next governed training generation, and the synthetic corpus still lacks a genuine held-out partition; those remain explicit follow-up product gaps rather than being represented as sandbox work or shipped capability.

## Foundational Change Graph intelligence architecture: 2026-08-17

Authority: `C:\Users\Talal\Downloads\Mendpoint_CODEX_Change_Graph_Intelligence_Prompt.md` governs this initiative. Existing product specifications, ADRs, schemas, and APIs are compatibility constraints, not authority to narrow this contract.

### Coordination and archaeology

- [x] Read the complete authority document, repository instructions, review standard, and dual-agent operating protocol.
- [x] Fetch current `origin/main`, create issue 185, claim `codex/185-change-graph-intelligence`, and isolate the worktree.
- [x] Inspect open PRs 180 to 184 and record non-overlap with Claude-owned intelligence, trajectory, and evaluation files.
- [x] Read the security boundaries, canonical product specification Change Graph sections, accepted ADRs, existing graph documents, and relevant implementations end to end.
- [x] Record what is real, partial, seeded, duplicated, or dormant in `docs/graph/CURRENT_STATE.md`.

### Architecture and contracts

- [x] Record an accepted ADR making the Change Graph Mendpoint's versioned, evidenced software-relationship memory while retaining the existing relational persistence substrate for the first proof.
- [x] Define the smallest versioned entity, edge, provenance, temporal, coverage, conflict, and failure contracts required by the first indirect Fettler question.
- [x] Preserve canonical identity, tenant scope, repository/provider snapshots, deterministic serialization, immutable mission graph versions, and explicit ambiguity.
- [x] Define bounded query and context-compiler contracts that retain evidence while excluding irrelevant graph state.
- [x] Document ontology, provenance, coverage, storage, query, incremental build, and benchmark methodology without duplicating equivalent documents.

### Red-first vertical slice

- [x] Add red tests for exact, alias, ambiguous, unresolved, and colliding entity resolution.
- [x] Add red tests for provider endpoint to SDK method to internal wrapper to indirect symbol to relevant test materialization with resolvable provenance.
- [x] Add red tests for immutable graph versions, incremental invalidation, historical mission reads, stale/conflicting evidence, partial coverage, and failed publication retaining the previous valid graph.
- [x] Add red tests for bounded indirect impact traversal, compact context compilation, no-impact versus unknown-impact distinction, and graph failure destination classification.
- [x] Add red tests proving tenant isolation and provider-snapshot-bound facts inside each tenant graph.
- [x] Implement the smallest coherent entity resolver, materializer, version publisher, query layer, and Fettler impact/context integration on existing persistence and graph packages.

### Representation benchmark and learning

- [x] Build development, validation, and hidden-holdout synthetic cases with at least half requiring indirect relationships and answer keys isolated from runtime inputs.
- [x] Compare raw retrieval and graph representation with the same task, model contract, grader, and acceptance criteria; record correctness, retrieval calls, context size, tokens, latency, cost, abstention, and failure categories.
- [x] Integrate DeepSeek verification only through an explicit compatible boundary; it remains soft and cannot rescue deterministic failure. Do not copy unmerged PR 182 code.
- [x] Route missing or wrong relationships to graph, entity, parser, runtime, query, or context fixes before model-learning eligibility.
- [x] Emit graph coverage and failure telemetry plus a governed learning event reference without exposing chain of thought or admitting representation failures to model training.

### Verification and publication

- [x] Run focused red and green suites, complete affected package suites, all workspace typechecks, full tests, production build, release gates, dependency audit, and diff integrity.
- [x] Inspect the complete diff for tenant, provenance, temporal, compatibility, performance, failure-recovery, and rollback defects.
- [ ] Commit scoped changes, sync with current main, push the issue branch, open the PR, and request attributable Claude peer review.
- [ ] Resolve P0 and P1 findings red first, require protected CI, and leave merge to the protected human decision unless explicitly delegated.

Acceptance: issue 185 demonstrates one real indirect Fettler relationship chain as versioned, tenant-safe, evidence-backed graph state; Fettler traverses it deterministically into a compact impact pack; uncertainty and coverage remain explicit; incremental publication preserves historical mission meaning; controlled raw-versus-graph evidence distinguishes representation gains from model gains; DeepSeek remains a soft optional reviewer; and graph failures improve the representation layer instead of becoming model training data by default.

Review: the bounded first slice is implemented on top of the existing SQLite and TypeScript graph substrate. It publishes immutable content-addressed software graph versions with exact tenant, repository, provider, snapshot, extractor, temporal, confidence, status, conflict, and coverage bindings. It resolves exact, alias, ambiguous, unresolved, and collision cases; preserves independent provider heads and historical reads; materializes the first provider endpoint to SDK to repository wrapper to test chain from a real code index; distinguishes no impact from unknown coverage; compiles a bounded evidence-bearing Fettler context; and records graph-representation learning evidence as ineligible for model-weight training.

The current-schema live benchmark used `muse-spark-1.2-contributor` on six programmatically materialized repositories across development, validation, and holdout splits. Raw and graph arms both scored 6 of 6. The graph arm was 6.2 percent faster but used 71.9 percent more input tokens and cost 1.7 percent more, so graph-first retrieval remains shadow-only. Arm C was not run because no approved DeepSeek credential was configured.

Verification: Graph Learn 101 of 101, Code Impact 77 of 77, Pipeline 81 of 81, Eval 132 of 132, all workspace and script typechecks, the 50-page production build, GA/spec 3.0/claims/names/action-pin gates, production dependency audit, and diff integrity pass. The unconstrained monorepo test command saturated Windows filesystem timing budgets in unrelated API and worker cases; every timed-out case passed in its complete file or exact isolated rerun. No product timeout was widened and no source behavior was weakened. Commit, protected CI, and attributable peer review remain pending.
## Issue 172: Muse 1.2 plus DeepSeek V4 Flash verification layer: 2026-08-17

Objective: keep Muse 1.2 as the sole primary reasoning and code generation model, add DeepSeek V4 Flash as an independent, evidence constrained verifier and scorer, prove whether it improves Fettler and ReGauge candidate selection, and stop at shadow behavior unless retained benchmark evidence supports a narrower rollout.

### Authority and architecture

- [x] Create issue 172, claim the scope, and isolate the work on `codex/172-muse-deepseek-verifier`, then rebase before implementation when PR 169 advanced exact main to `1d3ae5a`.
- [x] Read the canonical product specification, operating protocol, applicable ADRs, repository lessons, and the complete attached master prompt.
- [x] Inspect `llm-as-a-verifier` and TurboAgent at exact upstream revisions, record license and algorithm semantics, and decide explicitly between direct dependency, adapter, or TypeScript implementation.
- [x] Audit current Fettler, ReGauge, router, verification, evaluation, telemetry, security, and governed learning seams. Reconcile any parallel Claude work before every commit.
- [x] Add proposed ADR 0006 for evidence constrained model verification, deterministic precedence, rollout authority, data egress, and rollback.
- [x] Write `docs/agents/MUSE_DEEPSEEK_VERIFIER_DESIGN.md` with the trust hierarchy, threat model, evidence pack, criteria, model roles, execution modes, config schema, rollout stages, kill switch, economics, and compatibility decision.

### Core implementation, red first

- [x] Create `@mendpoint/verifier` as a TypeScript package with a versioned `AgentVerifier` contract, immutable observable trajectories, evidence packs, criteria, hard evidence, soft scores, cost and latency, typed failures, and deterministic digests.
- [x] Reject private chain of thought, unredacted secrets, unsafe controls, oversized inputs, prompt injection authority confusion, tenant or artifact mismatches, unsupported residency, absent consent, and external model ineligible tasks before any model call.
- [x] Implement deterministic candidate filtering so failed required checks, explicit acceptance misses, scope violations, unsafe edits, or contradictory hard evidence can never be rescued by a model score.
- [x] Implement fine grained A to T expected reward extraction from logprobs, repeated criterion scoring, pairwise comparison, deterministic seeded Probabilistic Pivot Tournament selection, stable tie handling, and progress tracking.
- [x] Implement versioned policy routing for pass through, Muse self verification control, DeepSeek verification, Muse Best of N plus DeepSeek, human escalation, and the exact OFF, OFFLINE, SHADOW, ADVISORY, SELECTIVE, AUTOMATED stages.
- [x] Implement the global kill switch `DEEPSEEK_VERIFIER_ENABLED=false`, per tenant and per capability gates, budget ceilings, timeouts, cancellation, fail closed response parsing, and no silent fallback that changes an action.
- [x] Implement secure OpenAI compatible DeepSeek V4 Flash transport with exact model binding, `thinking.type=disabled`, `logprobs=true`, `top_logprobs=20`, bounded JSON output, request digesting, no credential logging, and observable usage only.
- [x] Implement a Muse self verifier backend only as a controlled comparison arm. Muse remains the generator and ordinary generation is never routed to DeepSeek.

### Product integration

- [x] Add a shared evidence assembler for Fettler and ReGauge that binds task, snapshot, acceptance criteria, observable plan or patch, graph and retrieval evidence, deterministic checks, changed paths, blast radius, and verification artifacts without private reasoning.
- [x] Add Fettler criteria for semantic migration correctness, blast radius correctness, evidence quality, scope discipline, verification strength, and safety.
- [x] Add ReGauge criteria for architecture correctness, staged migration safety, behavior preservation, rollback, scope discipline, and verification strength.
- [x] Integrate default off and shadow only hooks at the actual Fettler and ReGauge generation boundaries. Shadow scores must not change candidates, PRs, approvals, routing, or execution.
- [x] Persist bounded verifier telemetry and disagreement signals with exact model, config, evidence, criteria, candidate, cost, latency, decision, and deterministic outcome digests.
- [x] Emit verifier reward, disagreement, calibration, and selection data only as soft governed learning signals. Deterministic verification and human outcomes remain hard signals and eligibility rules remain authoritative.

### Evaluation and rollout evidence

- [x] Build the canonical experiment for Muse Pass at 1, Muse self selected Best of N, DeepSeek selected Best of N, and oracle Best of N across Fettler and ReGauge synthetic tasks.
- [x] Measure Pass at N, selection accuracy, oracle gap, misranking, false confidence, disagreement, error correlation, calibration, tokens, verifier cost, generation cost, latency, and accepted output economics for N equals 1, 2, 3, and 5 where the cohort supports it.
- [x] Add hard negative scenarios for deterministic failure with a high model score, prompt injection, secret bearing evidence, cross tenant input, revoked consent, unsupported residency, malformed or missing logprobs, timeouts, score ties, positional bias, stochastic reproducibility, and kill switch activation.
- [x] Add offline fixture tests for every production path. Live DeepSeek calls may occur only in an explicitly marked opt in evaluation with an available protected `DEEPSEEK_API_KEY`; absence must produce an honest skipped or blocked result, never a mock success.
- [x] Write `docs/agents/MUSE_DEEPSEEK_BENCHMARK.md` from retained artifacts and answer whether DeepSeek measurably improves Muse 1.2, for which risk classes and candidate counts, and at what incremental cost.
- [x] Keep rollout at SHADOW unless the held out comparison clears exact quality, safety, calibration, and economic gates. Do not claim selective or automated rollout from fixture evidence.

### Verification, review, and shipment

- [x] Run focused verifier, agent, platform, worker, pipeline, and eval tests; all affected package suites and typechecks; complete workspace tests and typechecks; production build; GA, spec, claims, names, action pin, dependency audit, and diff integrity gates.
- [x] Compare exact behavior with main, verify imports have no side effects, and inspect telemetry and evidence artifacts for secrets, private reasoning, mutable aliases, noncanonical ordering, and cross tenant leakage.
- [ ] Obtain reciprocal Claude review under the operating protocol, address every P0 and P1 red first, and retain the attributable review evidence.
- [ ] Commit by logical slice, push issue 172 branch, open a protected pull request, and merge only after protected CI and human authority permit it.
- [ ] If merged, verify the exact deployed revision and shadow health. Do not enable DeepSeek traffic or copy credentials without a separate explicit activation authority and a green protected preflight.

Acceptance: Muse 1.2 remains the generator. DeepSeek V4 Flash can only judge bounded redacted observable evidence after deterministic filters. Hard evidence always outranks model reward. The independent and self verifier arms, Best of N plan and implementation selection, progress tracking, Pivot Tournament, policy routing, costs, calibration, disagreement, failure taxonomy, telemetry, learning capture, and kill switch are implemented and tested. Fettler and ReGauge have real default off shadow integration. A retained benchmark establishes where independent verification improves or harms selection. No private reasoning, secret material, ineligible tenant data, failed deterministic candidate, unreviewed verifier preference, missing credential, or unproven rollout stage can change production behavior.

Review: the branch now contains a provider neutral verifier contract, exact DeepSeek V4 Flash transport, Muse self control, deterministic survivor filtering, content addressed and position balanced tournament scoring, progress and completion evidence, conservative request cost reservation, an at most once durable shadow dispatch claim, immutable unknown verdict telemetry, and soft learning signals that remain training ineligible without a later deterministic or human label. Fettler observes only after its job and terminal evidence commit. ReGauge observes only after its authoritative attempt completion. Both hooks preserve the incumbent and swallow advisory failures. The canonical four arm holdout benchmark is implemented and its deterministic fixture proves the calculations, but no protected `DEEPSEEK_API_KEY` is available, so real model quality and economics remain blocked and selective rollout stays rejected. The complete workspace test command is green, including 323 Agent, 440 Transformer, 389 API, 315 Worker, and 36 Verifier tests. All workspace typechecks, the 50 page production build, synthetic evaluation checks, GA/spec/claims/names/action pin checks, docs consistency, the production dependency audit, import side effect probe, secret scan, and diff integrity are green.

## Fix-agent findings closure: 2026-08-18

Objective: integrate every still-valid P0 and P1 finding from fix-agent PRs 213, 214, and 216 onto the exact deployed intelligence release, without weakening evidence, coverage, egress, or public-claim authority.

- [x] Reproduce and review the repair-lane model-egress bypass and unconstrained edit-path findings against current `main`.
- [x] Integrate fail-closed egress checks, boot-time endpoint visibility, slice-scoped repair actions, and verifier configuration protection.
- [x] Reproduce and review the public guardrail claim certification gap, then gate proven guardrails identically to proven capabilities.
- [x] Align CLM-006 wording and availability with what the requirement register can currently certify.
- [x] Reproduce and review omitted Change Graph coverage and false-complete provenance paths.
- [x] Require explicit query coverage, make target absence and unknown coverage reachable, and represent no-anchor paths honestly.
- [x] Run focused affected-package suites, full typecheck, production build, GA and claims checks, complete local tests, and deployment preflight gates.
- [ ] Record review evidence, push one protected PR, merge only when clean and green, then verify the exact live revision.

Acceptance: no auxiliary model endpoint bypasses local-only egress policy; model-proposed repair actions cannot escape the evidence slices or rewrite verifier authority; proven guardrails cannot rest on partial or non-public requirements; every graph query declares its coverage; missing producers and missing anchors cannot be reported as complete; and the combined release passes the same protected gates as the deployed intelligence implementation.

Review: fix-agent PRs 213, 214, and 216 were replayed onto exact current main as three isolated commits and reviewed as one merge result. The combined audit found and fixed four residual gaps red first: malformed replacement values reaching the mutation layer, code-impact endpoints and provider defaults hidden from boot-time egress validation, absent targeted graph queries still reporting complete coverage, and one-node no-anchor paths rendering as direct provider use. Complete affected suites pass: Repair 43 of 43, Graph Learn 109 of 109, Code Impact 93 of 93, Shared 94 of 94, Ops 96 of 96, Generation 8 of 8, and Contract 155 of 155. The complete monorepo test command, every workspace and script typecheck, the 50-page production build, GA/spec/claims/names/action-pin/architecture/model gates, public docs consistency, 161 synthetic eval tests, production dependency audit with zero vulnerabilities, and diff integrity are green. Protected CI, merge, and exact live deployment verification remain pending.

## Fix-agent findings closure, round two: 2026-08-18

Objective: close fix-agent PRs 217, 218, and 219 on top of the exact deployed findings release, including any residual authority defects found during integration review.

- [x] Integrate production refusal of Fly sandbox mock evidence and tenant-scoped local and VM build caches.
- [x] Integrate observed GitLab base and commit evidence plus platform-authoritative security attestation verification.
- [x] Add the complete scripts test directory to the root and protected CI test command.
- [x] Prove GitLab exact-draft source creation is bound to the observed immutable base revision across base movement, response loss, and concurrent branch-creation races.
- [x] Review mock injection, cache lifecycle, GitLab response loss, scanner authority, SDK tenant authority, and all changed call sites for residual P0 and P1 defects.
- [x] Run affected suites, complete tests, typecheck, production build, GA checks, dependency audit, and diff integrity.
- [ ] Push one protected PR, merge only when every gate is green, then verify the exact live revision.

Acceptance: no mock sandbox result can be mistaken for production verification; cache reuse, hit signals, and eviction are tenant isolated; GitLab delivery evidence comes from the remote system and source creation is pinned to the observed base commit; caller labels cannot mint verified security evidence; every scripts test runs in CI; and all protected release gates remain green.

## Comprehensive Claude work review: 2026-08-18

Objective: review every Claude-originated branch, pull request, commit, and dirty worktree against exact current main; deduplicate merged and patch-equivalent work; verify active code paths; and report all actionable defects or unintegrated work without changing product behavior.

- [x] Inventory every `claude/*` branch and associated worktree, including ahead or behind state, reachability from current main, dirty paths, and pull-request state.
- [x] Group merged work by product boundary and review the resulting current-main implementation rather than stale intermediate copies.
- [x] Review every unique unmerged commit and every dirty Claude worktree for correctness, security, authority, tenant isolation, replay safety, evidence honesty, and overlap with newer main code.
- [x] Run focused verification for each current active component, then require current protected CI, typecheck, build, dependency, claims, names, and architecture evidence where applicable.
- [x] Record findings in severity order with exact file and line evidence, distinguish blockers from stale or superseded work, and document residual verification limitations.

Acceptance: every Claude work item is accounted for as merged, open, unique unmerged, dirty, stale, or superseded; current shipped behavior is reviewed at the final integrated state; actionable P0 to P2 findings are precise and reproducible; no mock, fixture, stale branch, or uncommitted prototype is represented as shipped capability.

Review: the audit accounted for 66 local Claude branches and 63 Claude pull requests: 55 merged, seven closed after reviewed replay into consolidated releases, and one still-open Claude-head review PR against a verifier base that was later superseded by consolidated PR 215. Three branches have no pull request; two are clean pointers to merged history, while `claude/fix-denylist-and-sandbox-kind` carries 16 uncommitted paths on a stale base. The merged Claude pull requests total 47,021 additions, 3,290 deletions, and 476 changed-file touches. Exact current main `26658b0` passed protected unit, synthetic eval, GA, dependency, typecheck, build, API smoke, container, deployment E2E, deploy, and live health gates.

The review found no confirmed P0 in deployed code and two release-relevant P1 findings. Current main lets a tenant `never_touch_paths` array replace the baseline denylist, and the seeded five-item array omits key, PEM, Terraform, and several lockfile protections; an exact runtime probe accepted `.env` when the override was empty. Current main also silently maps an unrecognized `MENDPOINT_SANDBOX_KIND` to local host execution; an exact runtime probe returned `local` for `fly-machines`. The dirty Claude fix addresses both concepts but is not merge-ready: the Policy suite fails because its union implementation duplicates the complete default list on every Warden policy layer.

Change Graph and verifier code are already integrated in current main through consolidated PR 215. The released verifier rejects recognized probability mass below `0.5`, so the older open verifier review finding about a configurable zero floor no longer applies to deployed code. Its Best of N generation, policy resolver, progress, and soft-learning helpers remain tested library surfaces rather than production callers; the only live hook is explicitly shadow-only completion observation over one deterministic survivor, so this is a documented rollout boundary rather than a production safety defect. Open PRs 182, 190, and 202 now point at stale or superseded branches and should be closed rather than merged, to prevent old code from being reintroduced.

## Close Claude review P1 guardrails: 2026-08-18

Objective: preserve the immutable protected-path baseline through tenant and layered policy overrides, and fail closed when a configured sandbox kind is invalid, without changing the documented absent-configuration local default.

- [x] Add red regressions proving empty, custom, duplicate, and layered policy overrides cannot remove or duplicate baseline paths.
- [x] Implement one canonical baseline union at the policy authority boundary and update layered policy expectations.
- [x] Add a red regression proving an invalid configured sandbox kind throws while an absent value still resolves to local.
- [x] Implement strict sandbox-kind parsing without changing valid explicit, tenant, or environment selections.
- [x] Run focused Policy and Platform suites, affected typechecks, complete tests, production build, GA checks, dependency audit, and diff integrity.
- [x] Review the final diff for compatibility and add exact results here.

Acceptance: `.env`, credentials, keys, Terraform, production configuration, and lockfiles remain blocked regardless of tenant policy contents; the effective override is preserved without duplicate baseline entries; existing layer precedence is unchanged; missing sandbox configuration retains the local development default; malformed configured sandbox values fail before execution; and all existing supported sandbox backends remain unchanged.

Review: red-first regressions failed at both intended boundaries: an empty policy override returned no protected paths, the branch policy returned only its branch rule, and `MENDPOINT_SANDBOX_KIND=fly-machines` resolved to local. `mergePolicy` now creates one stable exact union of the baseline plus effective override, preserving layer precedence without repeated defaults. `resolveSandboxKind` now applies the existing explicit, tenant, environment precedence, retains local only when the setting is absent, accepts every supported kind, and throws `sandbox_kind_invalid` for configured unknown values. Exact post-fix probes block `.env` with no allowed edits and reject `fly-machines`.

Verification: Policy 14 of 14, Platform 206 of 206, Pipeline 89 of 89, ReGauge agent configuration 25 of 25, Repair sandbox 6 of 6, and all affected typechecks pass. The first complete test run encountered the known timing-sensitive ReGauge near-expiry lease test after 463 adjacent tests passed; the exact test and the complete 464-test ReGauge package passed on immediate isolated rerun. The second complete repository test command, including every workspace and all 50 scripts tests, passed. Every workspace and scripts typecheck, the 50-page production build, GA spec, claims, action pin, architecture, model, and naming checks, the production dependency audit with zero vulnerabilities, and diff integrity all pass.

Review: PRs 217, 218, and 219 were replayed onto the exact deployed findings release as separate commits, then reviewed as one authority boundary. The strict pass found and fixed additional defects red first: process-wide VM cache metadata exposed tenant keys and host roots; the tenant-bound SDK accepted a second caller-controlled tenant; evidence-authority exceptions crashed attestation requests; an unverified scanner override omitted its downgrade record; GitLab branch creation used mutable or drifted authority; commit and merge-request response loss could duplicate remote effects; replay did not prove exact parent, message, complete diff, paths, modes, bytes, and current head; and a concurrent worker winning branch creation was not reconcilable. GitLab now uses read-only exact reconciliation for every uncertain boundary and never retries a remote mutation after an uncertain result. Focused affected suites, all workspace and script typechecks, the complete monorepo test command, the 50-page production build, GA and documentation gates, 161 synthetic evaluation checks, production dependency audit, and diff integrity are green. Protected publication and exact live verification remain the only pending step.

## Repository outstanding-work closure: 2026-08-18

Objective: reconcile every dirty Mendpoint worktree and open pull request against exact current main, finish current work, preserve user and parallel-agent experiments, and leave one evidence-backed repository state without silently deleting historical work.

- [x] Merge the fully green policy and sandbox guardrail fix and record the exact merge commit.
- [x] Close duplicate or superseded pull requests only after proving current main contains the reviewed replacement.
- [x] Classify every dirty worktree as current, already integrated, generated evidence, superseded prototype, or unique unfinished code.
- [x] For every unique unfinished code path, reproduce its acceptance failure on current main before porting the smallest valid fix.
- [x] Run focused tests for any ported work, then complete repository tests, typecheck, production build, GA checks, dependency audit, and diff integrity.
- [x] Commit and push only the reviewed closure changes, obtain protected CI, and record remaining preserved worktrees that require an explicit archival or deletion decision.

Acceptance: no open pull request points at superseded authority code; no current defect is hidden in an old worktree; no stale experiment is merged merely because it is dirty; no user or parallel-agent work is deleted; current main remains green through production and release gates; and the final report distinguishes completed repository work from preserved historical artifacts.

Review complete: all 125 registered worktrees were inspected. Twelve historical dirty worktrees were classified and preserved with named Git stashes, including untracked files, then verified clean; no worktree or branch was deleted. Review of the remaining stale repair pull request exposed a current-main policy bypass: repair-only files were appended after the canonical migration-policy decision, and the repair filesystem used a narrower protected-path baseline. Red-first tests reproduced protected Terraform edits and low-confidence repair edits crossing that boundary. The fix now re-evaluates every newly introduced repair path through the canonical policy, fails the entire delivery closed when any verified workspace edit is unauthorized, and shares the canonical protected-path baseline at the filesystem boundary. Focused Pipeline and Repair suites and both workspace typechecks are green. The complete repository test command passed every workspace plus all 50 script tests; every workspace and script typecheck, the 50-page production build, GA specification, claims, action pin, architecture, model, naming, and readiness checks, the production dependency audit with zero vulnerabilities, and diff integrity all pass. PR #224 merged as `d08194790131d20be7141a0627ef733168268691`; post-merge workflow 32163152807 passed container builds, deployment E2E, full tests and evals, release gates, Fly deployment, and production health verification. Superseded PR #222 is closed with its branch preserved, and GitHub reports no open pull requests.

## Fettler vendored-evidence readiness correction: 2026-08-18

Objective: remove the two current P0 false-positive failures without weakening first-party analysis by making the generated evaluation corpus carry the same authoritative third-party provenance that the production detector requires.

- [x] Add a red corpus regression proving every vendored trap has a foreign package boundary and is reached from first-party code through an exact relative import.
- [x] Correct the synthetic repository template without adding path-name or comment-based product heuristics.
- [x] Rerun the focused generator, code-impact, and Fettler scenarios and regenerate retained readiness evidence.
- [x] Run complete evaluation checks, affected package suites, typecheck, build, GA checks, dependency audit, and diff integrity.
- [x] Review, publish through protected CI, and record the next apply-verify-delivery gap.

Acceptance: the vendored-only and combined generated-vendored scenarios represent real third-party provenance; production reports those files as vendored references rather than edit targets; ordinary first-party files under a `vendor/` directory remain editable; the two P0 failures close for the right reason; and retained readiness reports remain honest about unmeasured generation, verification, delivery, and live-model dimensions.

Review before publication: the synthetic template previously labeled a path as vendored without the foreign package boundary and first-party relative-import provenance required by the production detector. The red regression failed on the missing nested manifest. Commit `7eaa7b1` now creates a distinct `provider-sdk-copy` package and imports it from first-party source; no production heuristic changed. The exact-commit synthetic run improved from 55 of 64 to 57 of 64, closed both generated-vendored P0 failures, raised impact precision from 96.4% to 98.2%, and kept overall readiness FAIL because recall remains 79.3% against an 85% gate. The 120-second large-monorepo timeout remains the sole P1 in this evaluation slice. Full evidence is green: 162 synthetic harness tests, 93 code-impact tests, every repository workspace and all 50 script tests, every workspace and script typecheck, the 50-page production build, GA specification and governance gates, production dependency audit with zero vulnerabilities, and diff integrity. The retained scorecard is bound to `7eaa7b1` and continues to mark patch generation, sandbox verification, delivery, rollback, and live-model cost dimensions as not measured.

Post-publication review: PR 226 merged as `3ef10573f7316ff9d9c06246fb0d121be15cd7ed`. Exact-head workflow 32170666255 passed container builds, complete tests and evaluations, release gates, the production deployment, and production health verification. Its Chromium deployment journey passed one of one tests in 46.79 seconds, covering the production image, protected operator access, queued-work recovery after a crash, and uploaded browser/runtime evidence. Direct post-deploy probes returned HTTP 200 for `/`, `/livez`, and `/healthz`. The live combined worker still reports Regauge disabled and inactive, so this publication proves the Fettler evaluation correction and shared production health, not dedicated Regauge activation. The next readiness vertical is an apply-verify-delivery benchmark that measures patch generation, sandbox verification, reviewable draft delivery, rollback, and live-model cost on an approved bounded target; the current analysis-only scorecard must not be used as evidence for those dimensions.

## Fettler apply, verify, and draft-delivery benchmark: 2026-08-18

Objective: measure one complete, bounded Fettler delegation through the existing queued worker, immutable snapshot, production attempt engine, deterministic verification, sealed human-review artifact, production delivery worker, and exact draft boundary without presenting scripted model or local SCM evidence as live production capability.

- [x] Add a red integration scenario that starts from a failing provider migration, preserves independent passing regressions, and permits exactly one source edit.
- [x] Require the real queued worker and attempt engine to produce a source-bound candidate with replayable evidence, measured planner calls, and exact changed bytes.
- [x] Seal the exact candidate and verification evidence into the existing version-four approval format, then persist a distinct human approval and deterministic delivery outbox entry.
- [x] Run the production Fettler candidate-delivery worker against the exact draft contract and prove one draft, no merge, no deploy, exact base revision, exact files, exact modes, evidence in the review body, and byte-identical replay.
- [x] Add fail-closed controls for tampered approval bytes, unexpected changed paths, verifier failure, base drift, and divergent draft replay.
- [x] Register the scenario in the retained agent evaluation report as `simulated_scripted`, with `liveModelCapability: false`, so it cannot satisfy live-model or real-SCM readiness.
- [x] Run focused tests first, then the full agent evaluation, affected workspaces, repository tests, typecheck, build, GA checks, dependency audit, and diff integrity.
- [x] Run the protected browser journey, crash recovery, and exact live health probes against the merged commit.
- [x] Review and publish through protected CI, then record the remaining live-model, live-SCM, cost, soak, and Regauge production activation gaps.

Acceptance: a well-scoped provider migration reaches a reviewable draft through production execution and delivery code; the immutable source remains unchanged; baseline fail-to-pass and pass-to-pass judges behave correctly; the candidate changes only the authorized path; every required verification passes; the approval and delivery bind exact digests and tenant scope; response replay creates no second draft; no code path can merge or deploy; and the report states plainly that a scripted planner and local exact-draft backend are contract evidence, not live-model or customer-production proof.

Review before publication: red-first coverage began with the missing delegation module, then exposed missing Fettler and ReGauge trajectory authority and stale retained-report counts. The final scenario runs the existing queued worker and attempt engine, persists one source-bound trajectory, changes exactly `src/payments/gateway-client.mjs`, proves baseline fail-to-pass and pass-to-pass behavior, seals the exact version-four approval bytes, and invokes the production candidate-delivery worker over the exact draft contract. It creates one draft-only result, preserves exact files and modes, includes review and objective verification evidence, replays byte-identically, and rejects approval tampering, base drift, and divergent replay. The retained report passes 46 of 46 scenarios, including 42 contract and four scripted lanes, while keeping live-model evidence at 0 of 0 and explicitly marking live SCM and authenticated human approval unproven.

Local verification: the complete Eval package passes 135 of 135 tests; focused Worker delivery and trajectory tests pass 12 of 12; Agent attempt-engine recovery and verification passes 35 of 35; GitHub draft-contract tests pass 23 of 23; the complete repository test command passes every workspace and script suite; every workspace typechecks; the 50-page production build passes; GA specification, claims, action-pin, architecture, model, naming, and readiness gates pass; the production dependency audit reports zero vulnerabilities; and diff integrity is clean.

Post-publication review: PR 228 merged as `0701646b12eff9dc8a88f0c8995d3d17bf8ef1ce`. Exact-head workflow 32176701309 passed all tests and evaluations, release gates, container builds, the protected Chromium deployment journey, production deployment, and production health verification. The deployment journey covered the production image, protected operator access, queued-work recovery after a crash, accessibility checks, mobile layout, and uploaded browser/runtime evidence. Direct post-deploy probes returned HTTP 200 for `/`, `/livez`, and `/healthz`; health reported the API ready and authenticated with no due, scheduled, running, dead-letter, or expired recovery work. Direct Chrome screenshots of the live desktop home page, 375 by 812 mobile home page, and Fettler documentation page showed no clipping, horizontal overflow, broken navigation, or obvious layout regression. This proves the bounded scripted Fettler execution and exact-draft delivery contract through production worker code plus shared-site deployment health. It does not prove a live model, real SCM delivery, authenticated human approval, cost, soak, rollback, or dedicated Regauge activation. Live-model evaluation remains 0 of 0, and the combined production worker still reports Regauge disabled and inactive.

## Protected ReGauge production proof: 2026-08-18

Objective: execute the already-authorized bounded ReGauge canary on the dedicated Fly app after the documented multistage-build correction, then preserve exact live-model, real-SCM, draft-only, readiness, soak, and containment evidence.

- [x] Prove the previous activation failure occurred before the `build-target = "transformer"` correction reached `main`.
- [x] Revalidate the protected environment, exact tenant, campaign, repository, revision, GitHub installation, model-routing bindings, volume, storage, draft-only confirmation, live-eval budget, soak bounds, and worker containment.
- [ ] Run the protected activation from exact current `main` with three live-model repetitions and a 300-second readiness soak.
- [ ] Verify the exact deployed revision, coordinator and worker readiness, one real draft PR with no merge or deploy authority, live-model result artifact, soak artifact, and post-run worker containment.
- [ ] Browser-check the dedicated public health surface and the resulting GitHub draft review surface, then record screenshots and exact URLs.
- [ ] If any gate fails, preserve artifacts and logs, keep the worker contained, reproduce the root cause red first, and publish only the smallest correction through protected CI before retrying.

Acceptance: the proof is bound to tenant `tenant_regauge_canary`, campaign `campaign_regauge_canary_20260814`, repository `gondalaimafia/mendpoint-canary-drill-20260801`, the protected workflow run and exact source revision; it spends no more than the configured live-eval budget; it opens at most one draft; it cannot merge or deploy; it survives the bounded soak; and the worker is scaled to zero after evidence capture.

Review before placement publication: protected run `32179466165` was approved for exact main `3f1edf4`. Attempts one and two both built the intended `transformer` image stage with `gosu` and the executable entrypoint, then Fly failed before starting a machine because SJC could not place a two-shared-CPU coordinator beside volume `vol_4ojd7q87kdxy8xxr`. Both attempts skipped the worker, live model, draft, and soak, completed containment, and uploaded evidence. Red-first regressions failed two of 23 focused tests on the oversized coordinator and absent bounded capacity retry. The corrected manifest retains 2 GB memory with one shared CPU and the workflow retries only the exact volume-capacity error up to three times. Focused tests pass 23 of 23; Worker passes 339 of 339; all repository workspace and scripts tests pass; every workspace and scripts typecheck; the 50-page production build; Fly configuration validation; and diff integrity are green.

Post-publication placement review: PR 230 merged as `8b47f0ee55093dda6097ffa445759798497db4a4` after all four protected CI gates passed. Protected run `32181632758` passed Fly authority discovery, exact environment approval, secret validation, immutable image build, and one-run gate derivation. Fly then rejected all three bounded `shared-cpu-1x` coordinator placements against unattached encrypted SJC volume `vol_4ojd7q87kdxy8xxr` with the exact capacity error. The worker, live-model evaluation, draft canary, and soak did not run. Containment passed and the app remains at zero Machines. This remains an external placement blocker, not production activation evidence.

## Enterprise execution hardening: 2026-08-18

Objective: close the two confirmed production P1 findings before the next live delegated-PR proof: token-safe repository materialization on every failure path, and authoritative default-deny sandbox-egress proof bound to the exact app and immutable verifier image.

- [x] Add a red repository-clone regression that forces fetch or checkout failure after authenticated remote setup and proves no token survives in the remote URL, `.git/config`, error, or retained workspace.
- [x] Replace success-only credential scrubbing with a fail-safe authentication mechanism or a `finally`-based restoration that preserves the original failure.
- [x] Add a red Fly sandbox regression proving a production verification command never starts when the forbidden-address acceptance probe succeeds or when egress evidence is missing, expired, or bound to another app or image.
- [x] Implement a versioned, authoritative egress-policy acceptance receipt and revalidate it immediately before production execution without weakening deterministic verifier authority.
- [x] Run focused repository connection and Fly sandbox suites, complete affected workspace tests and typechecks, complete repository tests, production build, GA gates, dependency audit, and diff integrity.
- [ ] Publish through a protected PR, merge only after every check is green, then rerun the exact production safety probes and browser checks.

Acceptance: repository credentials are absent from every retained clone after success, fetch failure, checkout failure, and response loss; production Fly verification cannot execute without fresh app-and-image-bound proof that forbidden outbound access fails while the allowed verification path succeeds; mock or caller-supplied labels cannot mint that proof; and no soft-model signal can override deterministic verification.

Review before publication: authenticated repository clones now keep the public remote URL on disk and pass the short-lived installation credential only through a child-process Git configuration header. Fetch, checkout, and partial-clone failures redact the token and encoded credential without a success-only cleanup dependency. The sandbox image installs and verifies IPv4 and IPv6 output-drop policies before dropping to uid 1000. Production startup and every live sandbox run require a fresh Ed25519 receipt bound to the exact app, immutable image digest, policy digest, denied public probe, allowed local probe, and protected evidence. The acceptance workflow now destroys the temporary Machine and proves it absent before it can sign or rotate the receipt.

Live proof before publication: `mendpoint-sandbox` ran image `registry.fly.io/mendpoint-sandbox@sha256:58a68f6680467330d10a4f76308a0bd12356d219a027fc4a4e482166c44e6684`; Machine `8654535a641de8` reported exact IPv4 and IPv6 `OUTPUT DROP` rules, executed the local probe as uid 1000, returned `blocked` for public HTTPS, and was destroyed. The app then listed zero Machines. The protected `sandbox-production` environment holds the scoped app credentials, signing authority, exact image and policy bindings, and required reviewer. The matching verifier receipt is staged on `mendpoint-talal` but has not been activated yet.

Local verification before publication: repository API tests pass 14 of 14, Platform passes 215 of 215, Worker passes 340 of 340, Ops passes 99 of 99, and all 53 scripts tests pass. The second complete repository test command is green after correcting two customer-launcher fixtures for the new mandatory authority. Every workspace and scripts typecheck, the 50-page production build, GA specification, claims, action-pin, architecture, model, and naming checks, all three Fly profile validations, the production dependency audit with zero vulnerabilities, and diff integrity pass.

## Live browser accessibility correction: 2026-08-18

Objective: close the keyboard-accessibility failure found during the required post-deploy desktop and mobile browser review without changing the documentation content or navigation contract.

- [x] Reproduce the failure against live production with Chromium and Axe at the 375 by 812 mobile viewport.
- [x] Make the interfaces table keyboard focusable with an exact accessible name.
- [x] Extend the protected deployment journey so mobile pages receive the same blocking accessibility scan as desktop pages.
- [x] Run focused web tests, typecheck, production build, GA checks, and the live desktop and mobile browser matrix.
- [ ] Publish through a protected pull request, verify the exact deployed revision, and record screenshots and live health evidence.

Acceptance: all public pages under the browser matrix return HTTP 200, have no horizontal overflow, no console errors, no failed requests, and no serious or critical accessibility violations at desktop and mobile widths; the documentation table can receive keyboard focus; and the exact deployed revision remains healthy.

Review before publication: the live 375 by 812 Chromium scan reproduced one serious `scrollable-region-focusable` violation on the Fettler interfaces table. The table now has an exact page-specific accessible name and participates in keyboard focus order. The protected deployment journey now runs its serious and critical Axe scan after every public route is resized to mobile, closing the coverage gap that allowed the defect through desktop-only checks. The complete Web suite passes 192 of 192 tests, Web typecheck passes, the 50-page optimized build passes, and all GA specification, claims, action-pin, architecture, model, naming, and readiness checks pass. A local production build passed the eight-page desktop and mobile browser matrix with HTTP 200, zero horizontal overflow, zero console errors, zero failed requests, and zero serious or critical accessibility violations; desktop and mobile screenshots were visually reviewed without clipping or broken navigation.

## Fettler impact readiness correction: 2026-08-18

Objective: clear the current precision-first Fettler impact gate by correcting deterministic discovery defects rather than training a model around missing evidence. Preserve abstention and precision while making structured request and response fixtures visible and bounding large-repository analysis work.

- [x] Add red regressions proving exact renamed keys in bounded JSON fixture and test-data files become reviewable impact candidates without promoting OpenAPI specifications, package manifests, or unrelated structured files.
- [x] Add red instrumentation proving candidate discovery reads each indexed file at most once even when a change produces several impact surfaces.
- [x] Cache repository source reads and file-function lookup within one discovery invocation without changing candidate ordering or authority.
- [x] Promote only valid, bounded structured payload fixtures carrying the exact changed wire key, with deterministic line evidence and medium confidence.
- [x] Rerun every previously failing language scenario, the large-repository budget scenario, unseen holdout, complete synthetic suite, and readiness scorecard.
- [x] Run affected workspace tests and typechecks, all repository tests, production build, GA gates, dependency audit, and diff integrity.
- [x] Publish through a protected pull request only if precision, recall, abstention, holdout, scale, and all release gates pass.

Acceptance: Fettler impact recall meets or exceeds the owner-set 85 percent gate; precision remains at or above 90 percent; abstention remains 100 percent; holdout remains within the accepted development gap; no P0 opens; the 25,000-plus-file scenario completes within its 120-second budget; and the implementation derives findings only from repository content available to the product, never from evaluator answer keys.

Review before publication: red-first coverage proved that valid request and response JSON fixtures were absent from the impact index and that repeated surfaces reread the same repository file. The implementation indexes bounded JSON separately from executable source, admits only valid fixture and test-data payloads with an exact changed wire key, caches every indexed read once, and preserves medium-confidence review rather than edit authority. The scale scenario exposed a harness defect rather than a product timeout: Windows copy-on-scan overhead consumed the subprocess budget and 811 abandoned staged repositories had accumulated. Normal and live runs now stage and clean up in a finally boundary. The deterministic, model-free scale lane may use the registered corpus directly only after the authoritative index-extension check proves no answer-key file is readable. The 25,507-file scenario completes in 21.9 to 23.0 seconds with 100 percent precision and recall, and a complete synthetic run leaves zero staged directories.

Readiness evidence before publication: the complete synthetic suite passes 61 of 64 scenarios and the owner-set readiness contract passes. Fettler precision is 98.5 percent, recall is 96.3 percent, and abstention is 100 percent. All ReGauge family gates and the holdout gate pass, with no P0. The three remaining scenario findings are P2 language-specific gaps recorded in `evals/FAILURES.md`; this slice does not claim live-model, real-SCM, authenticated-approval, or production delegation evidence. Complete repository tests, every workspace and scripts typecheck, the 50-page production build, GA specification and governance gates, production dependency audit with zero vulnerabilities, and diff integrity are green.

Post-publication review: PR 233 merged as `cc6192fbab1f4cc417e19dc0fd2537a7a8159ae5`. Exact-head workflow 32196856255 passed all repository tests and evaluations, release gates, all container builds, the protected Chromium deployment journey and crash recovery, production deployment, and production health verification. Direct probes returned HTTP 200 for `/`, `/livez`, and `/healthz`; API readiness and authentication were true with no due, scheduled, running, dead-letter, or expired recovery work. A separate live Chromium matrix checked nine public pages at 1440 by 900 and 375 by 812. All 18 page and viewport combinations returned 200 with zero horizontal overflow, zero serious or critical Axe violations, zero console errors, and zero failed requests. Desktop home and mobile Fettler documentation screenshots were reviewed without clipping or broken navigation. The shared combined worker still reports Regauge disabled and inactive, so this publication proves the Fettler impact-readiness correction and shared production health, not dedicated Regauge activation or live delegated-PR readiness.

## Enterprise delegated pull request proof: 2026-08-18

Objective: make Devin-level delegation readiness a machine-verifiable, fail-closed claim. A deterministic or scripted fixture may keep proving regression behavior, but it must never satisfy enterprise readiness without exact live model, real source-control draft, authenticated human approval, independent verification, accounting, repetition, and cleanup evidence.

- [x] Audit current authoritative model, verification, approval, delivery, observation, accounting, and cleanup evidence seams.
- [x] Add red contract tests proving deterministic-only evidence is not enterprise ready.
- [x] Add red adversarial tests for mock SCM, direct-database approval, stale or mismatched source and candidate bindings, missing provider accounting, failed independent judges, duplicate drafts, inconsistent repetitions, and incomplete cleanup.
- [x] Implement one bounded, immutable delegated-PR proof contract with pass^3 acceptance and explicit failure reasons.
- [x] Integrate the proof result into the agent evaluation report without mislabeling ordinary regression CI.
- [ ] Add a separate production enforcement switch that can consume only an authority-verified proof.
- [ ] Add a protected live workflow seam that can produce and validate the exact proof without exposing credentials or allowing merge/deploy authority.
- [x] Run focused tests, Eval regression, full repository checks, typecheck, production build, and security review before publication.

Acceptance: enterprise readiness is false when live-model, real-SCM, authenticated-approval, exact binding, independent verification, accounting, exactly-one-draft, pass^3, or cleanup evidence is absent or inconsistent. A passing result must bind one repository and immutable source revision to one candidate, one authenticated human approval, one draft pull request, exact provider receipts, exact verification artifacts, cumulative budget, and reversible cleanup evidence for every trial.

Review before publication: the evaluator now emits a narrow `delegatedPrAccepted` result rather than upgrading deterministic regression evidence into an enterprise claim. It requires three exact live trials, approved model provenance and accounting, OIDC human authority, immutable source and candidate bindings, independent fail-to-pass and pass-to-pass verification, one observed real draft, DSSE attestation verification, and complete cleanup. Candidate approval now binds the durable trust principal, active tenant membership, exact candidate digests, seal, delivery request, and chained audit event inside one transaction; revoked principals and membership changes fail closed. The durable reader reports missing evidence explicitly and never infers remote cleanup. GitHub cleanup is installation and operation bound. Its deployable default can close the exact draft, prove the base unchanged and zero open pull requests, and retain the exact immutable head for audit and rollback. Deletion remains an explicit separate mode that performs no mutation without an injected atomic compare-and-delete authority. The cleanup mode is part of the operation digest, so callers cannot silently fall back from deletion to retention.

Verification before publication: the focused acceptance and authority matrix passes 94 of 94 tests. The complete repository test command passes every workspace and script suite, including API 399 of 399, Worker 340 of 340, Web 192 of 192, DB 280 of 280, Eval 155 of 155, and GitHub 170 of 170. Every workspace and script typechecks, the 50-page optimized web build passes, GA specification and governance checks pass, the production dependency audit reports zero vulnerabilities, and diff integrity passes. A local Chromium pass checked the home page plus canonical Fettler and Regauge documentation at 1440 by 900 and 375 by 812 with HTTP 200, zero horizontal overflow, zero console errors, and zero serious or critical Axe violations; protected candidate review failed closed with HTTP 503 when web access configuration was absent.

Outstanding production authority: no durable authenticated cleanup receipt, delegated-proof evidence assembler, or protected three-run live workflow exists yet. Atomic branch deletion remains unsupported, but it is no longer required for a safe proof because exact retained-head cleanup is accepted. The production enforcement switch therefore remains absent and no live enterprise delegation, merge, or deployment claim is authorized by this branch.

## Delegated proof authority: 2026-08-18

Objective: turn exact GitHub cleanup and the durable Fettler run inventory into authenticated evidence that the delegated pull request evaluator can consume without trusting caller-authored claims.

- [x] Define a versioned signed cleanup statement bound to tenant, installation, repository, pull request, source, head, operation, disposition, and exact cleanup evidence.
- [x] Add red tests for forged payloads, wrong scope, wrong signer, stale receipts, content tampering, duplicate replay, and cross-tenant reads.
- [x] Persist the verified cleanup envelope as an immutable artifact, passed evidence record, and hash-chained domain event under one authoritative controller.
- [x] Extend the durable delegation reader to surface only verified cleanup scope and reject malformed, ambiguous, stale, or mismatched records.
- [ ] Add an authority-only assembler that joins the durable run inventory, exact model and verification evidence, GitHub observation, attestation, and cleanup into the existing evaluator input.
- [x] Run focused package tests, full affected workspaces, repository tests, typecheck, build, GA gates, dependency audit, and diff integrity before publication.

Acceptance: no route or caller can mint cleanup success from JSON or IDs alone; every accepted cleanup is signed by an authorized service key, binds the exact GitHub installation, is content-addressed, immutable, tenant scoped, replay safe, and exactly joined to the delegated run and draft. Missing live evidence remains `not_observed` and cannot satisfy `delegatedPrAccepted`.

Review before publication: the default-off controller now performs the exact GitHub cleanup itself after proving the durable delivery, CI cycle, installation, repository, pull request, base, and head bindings. It snapshots caller input and signer configuration before remote code, persists a content-addressed rollback artifact and hash-chained pending record, then signs the exact authoritative artifact set through the existing DSSE in-toto software attestation path. Only after signing succeeds does one transaction publish the passed evidence row and attested event. Replay never repeats the remote mutation, changed replay content conflicts, stale or untrusted receipts fail, and a tenant-scoped verified reader is the only path that upgrades cleanup from `not_observed` to `observed`. No API route or production activation was added.

Verification before publication: the red-first cleanup suite passes 4 of 4, Pipeline passes 96 of 96, GitHub passes 174 of 174, the focused DB evidence suite passes 14 of 14, and the delegated acceptance suite passes 18 of 18. The complete repository test command, every workspace and scripts typecheck, the 50-page optimized production build, GA specification and governance gates, the production dependency audit with zero vulnerabilities, and diff integrity all pass. The authority-only full trial assembler and protected three-run live workflow remain explicitly unfinished.

## Delegated trial authority assembly: 2026-08-18

Objective: assemble the evaluator input only from immutable, tenant-scoped artifacts and verified durable run records. The assembler must fail closed when any model, accounting, source, candidate, verification, approval, delivery, cleanup, workflow, or attestation binding is absent or inconsistent.

- [x] Add red tests proving a syntactically valid caller-authored trial cannot become authoritative.
- [x] Define the exact stored trial bundle schema, producer identity, artifact kind, evidence relationship, and hash-chained event contract.
- [x] Re-read and verify the durable Fettler inventory plus signed cleanup authority before accepting a stored bundle.
- [x] Bind every evaluator field to either a verified durable record or a content-addressed artifact covered by the trial attestation.
- [x] Expose a concrete `DelegatedPrAcceptanceAuthority` that returns no trial for missing or cross-tenant evidence and rejects corruption, replay ambiguity, stale evidence, or scope drift.
- [x] Run the focused red and green matrix, affected package suites and typechecks, complete repository gates, and diff integrity.

Acceptance: the evaluator receives no caller-authored success claims. A loaded trial is immutable, content-addressed, signed by an authorized producer, bound to one tenant, run, correlation, job, repository, source, candidate, approval, delivery, cleanup, and workflow, and rejected when any durable relationship changes after assembly. This slice does not claim a protected live trial until the three-run workflow executes against real model and GitHub authorities.

Review before publication: the authority loader accepts only one immutable trial bundle joined to one passed evidence record and one intact hash-chained event. It re-reads the durable run, trajectory, model reservations, routing ledger, meter, OIDC approval, delivery, CI observation, terminal outcome, and signed cleanup evidence. Every derived workflow, model, accounting, approval, delivery, verification, cleanup, timeline, and changed-path claim must exist as an exact content-addressed artifact. Independent verification evidence is bound to the configured verifier principal, code digest, commit, candidate, and command results. The loader also binds run and candidate-ready timestamps, exact GitHub repository and pull request identity, assembly time, producer revision, DSSE issuance time, and the contract's explicit signer-key allowlist.

Red-first evidence: focused failures were observed for missing authority code, durable timing drift, an unapproved but cryptographically valid signer, a missing claim artifact, a missing assembler commit binding, and a pre-finalization assembly timestamp. The final focused matrix passes 28 of 28 tests. Eval passes 165 of 165, Pipeline 96 of 96, DB 280 of 280, GitHub 174 of 174, API 399 of 399, Worker 340 of 340, and every remaining workspace and script suite passes. Every workspace and script typechecks, the 50-page production build passes, GA specification, public-claims, action-pin, architecture, model-binding, and naming gates pass, the production dependency audit reports zero vulnerabilities, and diff integrity passes. This remains a production-capable authority reader, not evidence that the protected three-trial live workflow has run.

## Graphify structural extraction integration: 2026-08-18

Objective: evaluate Graphify against Mendpoint's current structural extraction and integrate it only where measured evidence shows a quality, efficiency, coverage, or maintenance advantage. Graphify may provide tenant-private, snapshot-bound structural facts; Mendpoint remains authoritative for canonical identity, semantic relationships, temporal Change Graph versions, evidence, coverage, migrations, routing, verification, and learning.

- [x] Read the owner-supplied Graphify authority, project operating protocol, review standard, security boundaries, canonical v3 product specification, and accepted Change Graph ADR.
- [x] Fetch current remote state, inspect open issues and pull requests, audit graph-related worktrees, create issue #238, and create isolated branch `codex/238-graphify-integration` from exact `origin/main` `a69526c`.
- [x] Preserve the owner authority document in `docs/authority` with its exact SHA-256 `083069e29c6711d309c6af2ed07ae1968a103f18374232a55a493d00ef7105b0` and add an integrity gate.
- [x] Inspect and pin the exact upstream Graphify revision, library API, output schema, language extractors, incremental behavior, security boundary, benchmark evidence, license, and notices.
- [x] Inventory current Mendpoint structural extraction, graph publication, entity resolution, provider join, provenance, coverage, tenant isolation, incremental update, and benchmark seams.
- [x] Add red tests for a Mendpoint-owned `StructuralGraphExtractor` contract before implementation.
- [x] Implement Graphify normalization behind that interface without leaking upstream types or storage into Mendpoint public contracts.
- [x] Preserve extractor version, source locations, upstream relation, upstream confidence, snapshot, tenant, warnings, ambiguities, metrics, and failure taxonomy.
- [x] Add a default-off selection and fallback contract proving the current extractor remains authoritative. No environment flag or production caller exists while the adoption decision is negative.
- [x] Implement one bounded Stripe SDK method to endpoint semantic promotion and an indirect Fettler impact path with relevant test evidence.
- [ ] Benchmark current extraction, Graphify normalized extraction, and Graphify plus Mendpoint semantic resolution on direct and relationship-heavy development, validation, and hidden-holdout cases.
- [ ] Test reflection, dynamic import, dependency injection, ORM, generated code, shell, cron, runtime plugin, feature flag, queue, and shared-database blind spots with explicit coverage outcomes.
- [ ] Measure full and incremental build time, normalization, semantic promotion, memory, storage, and query latency on small, medium, large, and monorepo classes.
- [x] Record the evaluation, extractor contract, adapter, promotion path, benchmark, explicit adoption decision, license implications, rollback, and upgrade policy in the required graph documents and ADR.
- [ ] Run strict P0/P1 review, affected and full repository verification, then open the protected PR and request attributable Claude peer review.

Acceptance: the first production-worthy milestone satisfies all fifteen gates in the owner authority. An adoption decision is forbidden until the controlled benchmark and hidden holdout are complete. Graphify-specific types or storage never become the canonical Change Graph contract, static blind spots remain explicit, tenant relationships never cross boundaries, and disabling the adapter restores the existing extraction path without making Mendpoint unbootable.

Review before publication: Graphify `graphifyy` `0.9.46` at commit `558df6d57d61cb6ef79c740ec7473c6d953d79a7` is retained as an internal evaluation candidate only. The upstream package is not installed, no Python process or production flag is wired, and no Graphify result can influence delivery. The new Mendpoint contract binds exact tenant, repository, snapshot, revision, manifest files and bytes, resource ceilings, deterministic identities, and upstream provenance. A bounded Stripe test proves Mendpoint provider semantics can join Graphify-shaped structural calls through a wrapper and relevant test into one immutable graph version. The three-arm benchmark schema stages labels separately, but it is deliberately incapable of recommending adoption until exact-path accuracy, trap correctness, incremental equivalence, network denial, and a sealed external holdout are measured. A red-first strict pass caught and removed an earlier simplified adoption result, then added process-identity, fallback-callback, and manifest-entry snapshot hardening.

Verification before publication: the complete repository test command passes every workspace and all 53 script tests; the structural package passes 24 of 24; the focused Stripe and materializer suite passes 9 of 9; every workspace and scripts typecheck; the optimized 50-page web build; GA specification, claims, action-pin, Change Graph authority, model, and naming gates; the production dependency audit with zero vulnerabilities; and diff integrity all pass. The real 18-case external holdout, full blind-spot corpus, pinned Python child process, and four-tier end-to-end performance run remain intentionally incomplete, so the recorded decision is `KEEP AS INTERNAL TOOL ONLY` rather than production adoption.

## Graphify post-merge review corrections: 2026-08-19

Objective: close every substantive finding from the attributable review of PR 239 without activating Graphify or weakening the recorded internal-only decision.

- [x] Add red regressions for authority-byte stability, missing confidence, honest empty-prediction precision, label-free predictor input, projection coverage honesty, confidence propagation, and attribute-sensitive incremental diffing.
- [x] Add red regressions for source digest verification, warning provenance, semantic-status consistency, and relation normalization.
- [x] Add red regressions for immutable process inputs, bounded termination acknowledgement, repository-owned extractor pinning, fail-closed fallback, extraction invariant validation, and sealed benchmark cohort evidence.
- [x] Apply the smallest contract-preserving fixes and update only claims invalidated by those fixes.
- [x] Run the focused structural, Stripe, authority, affected typecheck, full repository, build, GA, audit, and diff gates.
- [x] Obtain a strict P0/P1 review, publish a protected follow-up PR, and verify the exact protected head before merge.

Acceptance: missing or malformed upstream evidence fails closed; benchmark predictors receive no split, family, or indirect labels; zero predictions never score perfect precision; coverage never becomes complete from fabricated diagnostics; structural confidence remains visible through semantic materialization; temporal diffs detect meaningful edge evidence changes; source bytes match their manifest hashes; the authority hash is platform-stable; and Graphify remains default-off with no production caller or delivery authority.

Review before publication: the post-merge pass closed every original review finding plus the later process, evidence, and scope findings. The adapter now reads exact files through one bounded handle, passes bytes rather than paths, requires confirmed child exit, and admits fallback only for explicit operational failures after the current extractor succeeds and the exact transition is recorded. Reloaded structural evidence must retain the exact manifest and file bindings and satisfy a complete normalized schema. Tenant, repository, snapshot, revision, manifest, content digest, and epistemic confidence remain bound through call-graph projection and semantic publication. Benchmark reports bind the cohort, staged predictions, and sealed key; empty prediction precision is undefined rather than perfect; indirect recall uses only sealed indirect edges; and all public evidence is deeply frozen. Graphify remains an internal, default-off evaluation candidate with no process implementation or production caller.

Verification before publication: 69 focused structural, Stripe, materializer, performance, benchmark, and authority tests pass. Structural Graph passes 49 of 49 and Code Impact passes 103 of 103 in the complete repository run. Every workspace and scripts typechecks, every workspace and script test passes, the optimized 50-page web build passes, GA specification and governance checks pass, the production dependency audit reports zero vulnerabilities, and diff integrity passes. Two independent strict reviews found no remaining P0 or P1 blocker after the final fixes.

Protected publication evidence: PR 244 source commit `7a36dbdc49dbeb8ad36395145887238120e4617d` passed tests, release gates, all container builds, and the deployment E2E browser and crash-recovery journey. GitHub reported the pull request cleanly mergeable against `b1486c38f98edc0371629651f2cefcfe03393409` before the final ledger-only update.

## Enterprise sandbox proof prerequisite: 2026-08-19

Objective: land the fail-closed sandbox containment and result-integrity contract required by an independent Fettler verifier without breaking explicit demo and CI environments.

- [x] Re-audit open sandbox PR 242 against exact current main and identify the protected-gate failure.
- [x] Replay the reviewed sandbox integrity change onto exact main without importing unrelated branch history.
- [x] Add red regressions proving every production process declares its sandbox kind and customer profiles accept only `fly_machines`.
- [x] Configure CI demo processes explicitly as `local` while preserving production Fly as `fly_machines`.
- [x] Run focused Ops, Platform, Worker, startup, deployment E2E, typecheck, build, GA, audit, and diff gates.
- [x] Correct the live Fly exec evidence contract after runs `32308148571` and `32309223296` proved successful commands omit `exit_code` and compound commands require an explicit shell.
- [x] Rerun the protected v2 proof, verify zero residual sandbox machines, and rotate the exact signed receipt.
- [x] Obtain strict P0 and P1 review, publish, merge, deploy, and verify production health before building the delegated trial producer.

Acceptance: production never silently defaults to host execution; customer profiles require the pinned Fly sandbox and verified egress attestation; an absent execution exit code cannot become success; ambiguous egress failures cannot prove containment; demo and CI host execution remains explicit and auditable; and the exact deployed main revision remains healthy.

Review before publication: the protected acceptance receipt is now schema v2 and binds the exact raw-IP forbidden probe command, ordered targets, allowed command, sandbox app, immutable image, and firewall policy. The sandbox installs explicit IPv4 and IPv6 reject rules behind a default-drop policy, so a timeout remains ambiguous while an exact firewall refusal is measurable. Production customer API and worker processes both require the complete v2 sandbox authority because both can reach pipeline verification. Web and backup processes receive none. The ReGauge coordinator is the only sandbox-exempt role, and both of its synchronous pipeline routes fail closed while queued coordinator work remains available. Demo and CI paths declare local execution explicitly. The protected workflow rejects absent command exit codes and rotates the receipt, public key, policy digest, and minimum schema together.

Verification before publication: focused sandbox, startup, customer-profile, and workflow coverage passes 136 of 136 tests; the post-review API, worker, Ops, and script correction matrix also passes. The complete Worker package passes 347 of 347, the complete repository and script test command passes, every workspace and scripts typecheck passes, the optimized 50-page production build passes, GA specification and governance checks pass, and the production dependency audit reports zero vulnerabilities. An independent strict review found no remaining P0 or P1 after the role-boundary corrections. The local deployment browser journey could not start because Docker is not installed on this machine; its exact container, crash-recovery, accessibility, and Chromium gate remains mandatory in protected CI before merge.

Protected pre-merge evidence: PR 245 source commit `7a799d4` passed tests, release gates, all container builds, and the deployment E2E Chromium and crash-recovery journey in workflow `32306984027`. PR 242 was closed as superseded rather than merging its stale red branch.

Post-deploy evidence: PR 247 merged as `43ec87e0b55cf5451694887e904e307d70b2da20`. Protected sandbox acceptance run `32310817758` passed authority validation, default-deny and local-execution proof, v2 receipt signing and verification, production secret rotation, evidence upload, and teardown. `mendpoint-sandbox` lists zero Machines. Main workflow `32310192697` attempt two passed every test, evaluation, release, container, browser, deployment, and production-health job. The production Machine reports one passing check; `/livez` and `/healthz` return HTTP 200 with API and worker healthy. Live Chromium checks on the home, Fettler, and Regauge pages at 1440 by 900 and 375 by 812 returned HTTP 200, zero horizontal overflow, zero serious or critical accessibility violations, zero console errors, and zero actionable request failures.

## Delegated candidate promotion and independent verification: 2026-08-19

Objective: turn one exact `candidate_ready` Fettler run into immutable candidate and independent verifier evidence that the existing stored-trial authority can consume. No approval, GitHub delivery, cleanup, or enterprise-acceptance claim may be inferred from this slice.

- [x] Add red tests proving a candidate-ready run with only attempt-engine verification cannot satisfy delegated verification authority.
- [x] Validate the exact source and candidate trees, manifest, evidence, tenant, repository, snapshot, revision, changed paths, and allowed verification commands before any external verifier effect.
- [x] Publish one content-addressed `delegated_pr_candidate` artifact bound to the durable run and exact source authority.
- [x] Execute fail-to-pass and pass-to-pass through an independent, configured verifier principal and sandbox authority without accepting caller-authored verdicts.
- [x] Persist two exact `delegated_pr_verification_execution` artifacts plus evidence rows atomically only after both command contracts pass.
- [x] Make dispatch replay safe across response loss and reject same-key content drift without repeating spend or verifier effects.
- [x] Wire the operation behind a default-off worker job that derives authority from server configuration and durable IDs only.
- [ ] Run focused red and green tests, affected full suites and typechecks, repository gates, build, strict review, protected publication, and live fail-closed verification.

Acceptance: no caller can mint candidate or verifier success from JSON, paths, booleans, or digests alone. Every accepted artifact is tenant scoped, content addressed, immutable, bound to one durable run and snapshot, produced by an active independent service principal, and replay safe. Deterministic attempt-engine checks remain necessary but cannot substitute for independent delegated verification.

Review: the candidate authority and verifier effect protocol are implemented. The verifier protocol is fail closed, lease fenced, signed receipt bound, response-loss reconcilable, and persists the exact sandbox execution authority in each immutable execution artifact. The default-off worker job derives all authority from protected configuration and durable run IDs. Its concrete Fly sandbox adapter independently reconstructs and hashes the sealed source and candidate, then runs the fail-to-pass and pass-to-pass contracts in isolated workspaces. Exact replay after response loss performs no second sandbox execution, infrastructure exit codes settle as terminal failures, and candidate drift reaches no sandbox call. Focused worker coverage passes 10 of 10, the complete Worker suite passes 357 of 357, the complete Pipeline suite passes 114 of 114, and the complete Eval suite passes 166 of 166. All repository typechecks, the optimized 50-page production build, GA governance checks, and the production dependency audit pass. The bounded adapter currently rejects executable-file candidates, caps each reconstructed tree at 5,000 files and 8 MiB, and leaves a post-dispatch transport-unknown effect pending rather than risking a duplicate external execution. Protected live Fly execution remains required before activation.
## Claude review five-fix remediation: 2026-08-21

Objective: close the five approved review findings without weakening existing authority or compatibility contracts.

- [x] Require OIDC human identity and active membership evidence for every human-only Organization Memory mutation.
- [x] Derive corroboration from authoritative source identity and matching semantic content; reject contradictory observations.
- [x] Converge ReGauge Mission creation and launch onto one owner/scope contract without swallowed ID conflicts.
- [x] Bind delegated fail-to-pass acceptance to authoritative observed check identities, or narrow the contract so it makes no unearned identity claim.
- [x] Reject U+061C ARABIC LETTER MARK in ReGauge recipe paths.
- [x] Capture a valid RED regression for each finding before production edits.
- [x] Run focused tests and typechecks after each fix, then repository-wide tests, typecheck, production build, dependency audit, and diff integrity.
- [x] Publish only through a protected pull request after all gates pass.

Acceptance: API keys cannot perform human-only memory transitions; contradictory observations cannot corroborate each other; campaign creation and launch converge on one exact Mission; delegated acceptance proves exactly what the verifier observed; all Unicode bidi controls are rejected from reviewable paths; and no existing compatibility or replay behavior regresses.

Review before publication: Organization Memory now derives corroboration identity from an active tenant principal and exact passed evidence records. Human lifecycle mutations require OIDC plus membership evidence, while same-principal, reused-evidence, contradictory, revoked, and expired observations fail closed. ReGauge campaign creation and live launch share one deterministic Mission ID; launch preserves the human owner, binds the exact repository snapshot once, advances the durable state, and no longer returns success when Mission authority cannot be established. Delegated verification no longer requires or echoes check identities its independent command runner never observes. Recipe validation now rejects U+061C with the rest of the Unicode bidirectional controls.

Red-first evidence: the focused matrix failed on API-key mutation, same-principal and contradictory corroboration, missing evidence, Mission identity conflict, missing Mission authority, the unobserved delegated identity contract, and U+061C classification before production changes. After implementation and rebasing onto current main, DB passes 321 of 321, Worker 369 of 369, Eval 170 of 170, and the isolated API, Pipeline, and Transformer timeout cases pass 33 of 33, 19 of 19, and 3 of 3. Their full parallel runs reached 411 of 415, 140 of 141, and 464 of 465 before only machine-load timeouts; every timed-out test passed alone. Every workspace and scripts typechecks, the optimized 50-page production build passes, GA specification and governance checks pass, the production dependency audit reports zero vulnerabilities, and diff integrity passes.

Protected publication evidence: PR 264 source commit `4d240eb9268300a5dd6f892fb94dbbe727ba358b` passed test, release-gates, container-builds, and the deployment E2E Chromium and crash-recovery journey in workflow `32507334372`. GitHub reported the head cleanly mergeable before squash merge as `bd37545cc8ba1f476b69b8e8fac59bfb69fd084a`.

Post-deploy evidence: the first main deployment attempt correctly failed closed because the prior signed sandbox egress receipt had expired. Protected sandbox-production workflow `32508677722` independently reproved default-deny IPv4 and IPv6 egress plus local execution, signed and verified a fresh receipt, rotated the verifying-app authority, uploaded evidence, and removed its proof Machine. Main workflow `32507761206` attempt two then deployed exact commit `bd37545cc8ba1f476b69b8e8fac59bfb69fd084a` and passed production health. Fly reports one passing service check with API and Worker healthy; the home, `/livez`, and `/healthz` return HTTP 200. In-app browser checks at 1440 by 900 and 375 by 812 found zero horizontal overflow and zero console warnings or errors. The canonical Fettler and Regauge documentation pages render the approved names and headings without overflow.

## Delegated production evidence chain: 2026-08-21

Objective: make the protected Fettler delegated pull request path causally require independent verification, then create a durable handoff from an exact successful GitHub observation to cleanup and trial assembly.

- [x] Add RED API coverage proving a pending, failed, missing-required, ambiguous, or corrupt delegated verification cannot authorize human approval or GitHub delivery.
- [x] Require the exact completed delegated verification job and its durable completed event before approval when protected verification is configured; preserve ordinary approval when no delegated verification was requested.
- [x] Add RED worker coverage proving only an exact successful check observation creates one deterministic tenant-scoped cleanup job in the same transaction.
- [x] Implement the cleanup handoff without inferring cleanup success or mutating GitHub from the observation worker.
- [x] Port only the still-valid exact observation authority from stale PR 237, including repository, installation, base/head, remote tree, changed paths, and complete draft enumeration bindings.
- [x] Persist the successful observation as a canonical artifact and evidence record that the stored trial authority can independently verify.
- [ ] Run focused and affected full suites, typechecks, production build, governance checks, dependency audit, strict review, protected publication, and exact deployment verification.

Acceptance: no human approval can race or bypass a delegated verifier that was requested; failed or indeterminate verification causes zero delivery authority; successful checks create exactly one durable cleanup handoff; and the eventual cleanup and trial assembler consume exact content-addressed authority rather than filesystem-only or caller-authored claims.

Review for the approval-gate slice: the verification request, exact verifier authority and policy snapshot, candidate-ready source result, and deterministic verification job are persisted in one completion transaction. Approval checks the authority before creating a seal and again under `BEGIN IMMEDIATE` before any review or delivery mutation. A completed job is accepted only after the Pipeline terminal reader recomputes its request digest and validates the promoted candidate, both verification artifacts, both evidence records, configured command digests, sandbox backend, execution authority, Mendpoint revision, hash-chained event, and active verifier principal. Jobs created by the previously deployed markerless producer reconstruct the same historical authority only from immutable content-addressed artifacts and unique evidence records, then pass through the identical terminal reader. RED evidence captured the original pending-approval bypass and the later synthetic job-plus-event authority bypass. The corrected focused matrix passes 49 of 49. Pipeline passes 152 of 152 and Worker passes 391 of 391. API reached 426 of 427 under a parallel machine-load run; the sole repository reconnect timeout passed alone in 645 milliseconds. Monorepo typecheck, the optimized 50-page production build, GA governance checks, dependency audit, and diff integrity pass. Independent strict review found no remaining P0 or P1.

Protected publication for the approval-gate slice: PR 273 merged as `e74e4e7fb9028d92354627d45e6d40812a27499d`. Protected PR workflow `32520692299` and exact post-merge main workflow `32521140732` passed tests, release gates, all container builds, deployment E2E, deployment, and production health. Fly reports one passing check on version 290; the home page, `/livez`, and `/healthz` return HTTP 200. In-app browser checks at 1440 by 900 and 375 by 812 verified the home page and canonical Fettler and Regauge documentation with zero horizontal overflow, zero broken images, and zero console warnings or errors.

Review for the cleanup-handoff slice before publication: the successful observation path reuses the full delegated-verification terminal authority reader rather than trusting a job row or adding a weaker duplicate parser. Only `required: true` creates a handoff; ordinary drafts, running checks, failed checks, and review feedback create none. The deterministic job ID binds tenant, cycle, exact head, and observation digest. Its immutable payload additionally binds schema, delivery, observation ID, head, and digest. Observation persistence, cycle transition, delegated authority recheck, handoff enqueue, and observation-job completion share one `BEGIN IMMEDIATE`; lease loss or invalid authority rolls back every database write. The worker does not claim the cleanup job type, so this slice cannot mutate GitHub or infer cleanup success. RED evidence captured the missing handoff. Focused observation and authority coverage passes 29 of 29, the complete Worker suite passes 395 of 395, Worker typecheck and diff integrity pass, and independent strict review found no P0 or P1.

Protected publication for the cleanup-handoff slice: PR 274 source commit `9ee6983a7c2ef96a3e1449bb6c6a4daf1de9f7a8` passed protected workflow `32523731662` and merged as `0e99277880fd1c25d635a54a9a81db030de435f1`. Exact main workflow `32524202030` passed deployment and production health. Fly version 291 reported one passing service check; the home page, `/livez`, and `/healthz` returned HTTP 200. In-app browser checks at 1440 by 900 and 375 by 812 verified the home page and canonical documentation with zero horizontal overflow, broken images, console warnings, or console errors.

Review for the exact-observation slice before publication: the production GitHub App runtime binds one installation and one numeric repository before observation. The observer then requires the exact open draft, base and head branches and revisions, complete current-head pull request enumeration, complete compare result, canonical changed paths, remote Git tree, required checks, reviews, and threads. A successful delegated observation is written as one content-addressed `delegated_pr_github_observation` artifact plus one candidate-bound passed evidence record in the same transaction as the durable CI observation, cycle transition, cleanup handoff, and observation-job completion. The stored-trial authority re-hashes the canonical bytes and independently binds the exact cycle, delivery, observation row, candidate artifact, producer principal and revision, observer tool, repository, installation, head, tree, paths, and checks before the evaluator can accept it. Focused coverage passes 86 of 86, GitHub passes 184 of 184, Worker passes 395 of 395, Eval passes 171 of 171, and the complete repository and script test command passes. Every workspace typechecks, the optimized 50-page production build passes, GA governance checks pass, the production dependency audit reports zero vulnerabilities, and diff integrity is clean. Independent strict review found no P0 or P1.

## ReGauge canary approval source binding: 2026-08-21

Objective: ensure the protected one-draft authority names the exact canary repository revision being modified, independently of the Mendpoint deployment revision.

- [x] Capture RED API tests for wrong tenant, campaign, repository, canary revision, and draft count even when the supplied gate contains the bad approval.
- [x] Capture RED worker and workflow tests proving the deployment SHA cannot substitute for the canary source SHA.
- [x] Derive the workflow approval from the validated `MENDPOINT_REGAUGE_CANARY_REVISION` while retaining `GITHUB_SHA` for deployment and evidence identity.
- [x] Require the worker production profile to validate the exact 40-character canary revision and bind the approval to it.
- [x] Make the API bootstrap independently validate the full tenant, campaign, remote repository, expected revision, one-draft, run, and attempt scope before any repository or Mission effect.
- [x] Run focused API, Worker, and workflow tests plus affected typechecks and diff integrity before rebasing onto current main.
- [x] Rebase onto current main, rerun verification, obtain strict review, and publish through protected CI.

Acceptance: changing only the Mendpoint release SHA never changes or satisfies canary repository authorization; any mismatch in the tenant, campaign, remote repository, exact source revision, draft count, run, or attempt fails before effects.

Review: merged as PR 270 at `0ba2d288bc03423dc0f37a9bc91cdf673661b38a`. The protected PR workflow `32515422020` and exact post-merge workflow `32515833890` passed tests, release gates, container builds, deployment E2E, and deployment. Focused API, Worker, and workflow coverage passed 34 of 34; monorepo typecheck, production build, GA checks, dependency audit, and diff integrity passed. Strict review found no P0 or P1 issue. Live `/livez` and `/healthz` returned HTTP 200. Browser checks at 1440 by 900 and 375 by 812 verified the homepage plus canonical Fettler and Regauge documentation with the approved names, zero horizontal overflow, no broken images, and no console errors. The live combined worker still reports Regauge disabled and inactive, so this closes the source authorization defect without claiming dedicated Regauge activation.

## ReGauge DeepSeek production shadow: 2026-08-21

Objective: run the existing DeepSeek V4 Flash verifier on exact durable ReGauge completions in the dedicated production coordinator, in shadow mode only, with explicit external-egress consent, bounded spend, replay-safe telemetry, and no decision or delivery authority.

- [x] Add RED coordinator tests proving only a durably completed checkpoint invokes the shadow observer, exact replay does not duplicate authority, and observer failure cannot change the completed campaign result.
- [x] Derive the verifier evidence pack only from the coordinator-owned completed campaign, unit, completion receipt, and immutable digests; do not trust worker-authored verifier evidence.
- [x] Reuse the existing governed completion observer so append-only tenant consent, operator governance, principal identity, pricing, request accounting, and telemetry remain authoritative.
- [x] Keep the first production rollout fixed to `shadow`, one incumbent candidate, one evaluation, zero retries, a short timeout, and a small per-observation cost cap; no score may alter deterministic verification, candidate state, draft delivery, or Mission state.
- [x] Add protected workflow and production-profile tests requiring the DeepSeek key plus exact nonsecret governance, pricing, and principal bindings without logging secret values.
- [ ] Stage the reviewed verifier configuration into the dedicated Fly app, deploy the exact commit through the protected environment, and prove coordinator and worker health at that revision.
- [ ] Verify an active append-only `verifier-external-model-egress` consent for `tenant_regauge_canary` before permitting external egress; if absent, deploy fail-closed and record the exact human OIDC action still required.
- [ ] Run focused suites, affected package suites, typechecks, production build, GA checks, dependency audit, strict diff review, protected PR CI, exact post-deploy health, and browser checks.

Acceptance: the dedicated production path may emit a content-addressed DeepSeek shadow observation only after exact deterministic success and current tenant egress consent. Missing, revoked, expired, ambiguous, or mismatched consent or governance causes zero provider calls. Provider failure, timeout, malformed output, or score can never change completion, delivery, or approval. Exact replay creates no duplicate request, charge, telemetry, or audit authority.

Review so far: RED tests failed at the missing coordinator adapter, callback, workflow bindings, and bounded production profile. The implemented path observes only the authoritative `completeWithHead` result and catches every shadow failure after durable completion. Focused verifier, API, worker, workflow, and Transformer suites passed 158 tests; the final focused matrix passed 44 of 44, including zero provider calls under the protected deny-all policy. All affected package typechecks, the full monorepo typecheck, production build, GA policy gates, workflow YAML parse, dependency audit, and diff integrity passed. The protected environment contains the key plus pricing, while operator governance is intentionally deny-all until separate destination-specific approval and durable tenant consent are proven.

## ReGauge coordinator volume recovery: 2026-08-21

Objective: recover the dedicated coordinator from the latest encrypted snapshot onto a schedulable Fly host without deleting or mutating the original rollback volume.

- [x] Capture a RED workflow contract requiring the exact restored volume ID and canonical mount name.
- [x] Make activation fail closed unless that one restored volume is encrypted, 20 GB, created, located in `sjc`, and either unattached or attached only to this app's coordinator process.
- [x] Point only the coordinator mount at the restored volume and remove automatic empty-volume creation.
- [x] Run the focused workflow test, YAML and Fly config validation, affected typecheck, governance checks, and diff integrity.
- [ ] Require and stage one dedicated 32-byte application-data encryption key after the first restored-volume startup exposed the missing authority.
- [ ] Prove the application key is protected, never logged, and carried into the Fly deployment without reading its value.
- [ ] Publish through protected pull request CI and verify exact post-merge main CI.
- [ ] Rerun the protected one-draft activation and verify exact revision, coordinator and worker health, containment, and zero DeepSeek provider calls under deny-all governance.
- [ ] Browser-check the live dedicated hostname in Chrome and preserve screenshots if activation succeeds.
- [ ] Keep `vol_4ojd7q87kdxy8xxr` intact until the restored volume and application data are independently verified and deletion is separately approved.

Acceptance: deployment can mount only restored volume `vol_4y83e8lm03q5x03r` as `mendpoint_transformer_data_v2`; a missing, duplicated, wrong-region, wrong-size, unencrypted, non-created, or foreign-process-attached volume stops before secret staging or deployment; the original volume remains recoverable.

Review before publication: the workflow now rejects every volume except restored encrypted volume `vol_4y83e8lm03q5x03r`, including mismatched name, state, size, region, zone, backup policy, or host health. An attachment is accepted only when its exact Machine belongs to the coordinator process in the same Fly app. Automatic empty-volume creation is removed. The coordinator mount uses only `mendpoint_transformer_data_v2`, while the original volume remains untouched. RED failed on the missing restored-volume authority. GREEN passes 25 focused tests, workflow YAML parsing, Fly profile validation, Worker typecheck, GA governance checks, the optimized 50-page production build, dependency audit with zero vulnerabilities, and diff integrity.

Activation evidence: protected run `32536362631` passed preflight, volume authority, storage authority, and secret staging, then mounted the restored volume and started coordinator Machine `d89323ea06d938`. Startup failed closed with `application_data_key_required` before worker deployment, model evaluation, draft creation, or DeepSeek observation. The failed Machine was destroyed, both volumes are unattached and healthy, and worker count remains zero. A source-level protected-secret binding is now under review, but the key value remains unset pending explicit compatibility authority.

## Seven day outstanding work closure: 2026-08-21

Objective: close every still-current implementation and live-evidence gap created or explicitly assigned from 2026-08-14 through 2026-08-21 without merging stale worktree residue, weakening existing authority boundaries, or representing simulated evidence as production proof.

Inventory verdict:

- Shipped foundations: Change Graph authority and publication, Muse production identity, DeepSeek shadow verifier, Fly sandbox containment, Mission records and context, delegated candidate promotion and independent verification, approval gating, exact GitHub observation, Regauge canary revision authority, restored coordinator volume binding, and protected application-key staging.
- Live activation gap: Regauge has not yet proven one healthy coordinator and worker, one bounded draft, restart recovery, the readiness soak, the dedicated browser surface, or a DeepSeek observation. The protected governance remains deny-all, so the first activation must produce zero DeepSeek calls.
- Delegated acceptance gap: cleanup handoff and exact observation authority exist, but the cleanup consumer, complete signed trial bundle assembler, protected three-trial producer, and persisted acceptance runner are not fully production-wired.
- Learning gap: the governed event, consent, corpus, trainer, evaluator, candidate, canary, registration, and rollback foundations exist, but automatic terminal-outcome capture, a real non-overlapping holdout, live provider authority, serving integration, next-generation feedback, and authenticated production proof remain unfinished.
- Graphify gap: the default-off structural boundary and hardened evidence schema exist, but no trusted Python process implementation, sealed hidden holdout, three-arm comparative benchmark, scale profile, or adoption decision exists.
- Repository hygiene gap: one stale open PR and many old or dirty worktrees remain. They are preservation evidence, not merge candidates. No worktree may be cleaned or deleted without separate approval; only unique, current invariants may be ported red first onto this branch.

Execution plan:

- [x] Inventory exact main, protected workflow status, open pull requests, current secret names, recent plans, and every registered worktree without mutating preserved work.
- [x] Generate a new dedicated 32-byte Regauge application-data key in memory and store it only in the protected `regauge-production` environment without exposing or persisting its value.
- [ ] Run the exact protected Regauge activation under deny-all DeepSeek governance; require one coordinator, one worker, exact revision health, one draft only, bounded model cost, readiness soak, containment, and rollback evidence.
- [ ] Browser-verify the dedicated Regauge hostname and draft review surface in Chrome; retain screenshots and console, accessibility, overflow, and request evidence.
- [ ] Close or supersede stale PR 237 only after proving every unique invariant is already on main; leave unrelated dirty worktrees untouched.
- [ ] Implement the first missing delegated cleanup consumer behind the inert durable handoff, hard-coded to safe `retain_exact`, exact installation and observation authority, retry-safe reconciliation, signed cleanup evidence, and no delete authority.
- [ ] Implement the authority-only trial assembler and persisted acceptance runner, then add a protected three-trial real-SCM workflow with exact budgets, cleanup, DSSE evidence, and fail-closed acceptance.
- [ ] Wire automatic governed learning producers for terminal Fettler and Regauge outcomes, preserving verified attribution and tenant consent; add a real split-group-bound holdout and evaluator non-overlap proof.
- [ ] Wire authenticated trainer, evaluator, serving, monitoring, and rollback adapters only where current provider and tenant authorities exist; otherwise ship the source fail-closed and record the exact external activation blocker.
- [ ] Implement a pinned, sandboxed Graphify process adapter with zero network and bounded resources; run the sealed A/B/C benchmark across direct, indirect, blind-spot, incremental, and scale cohorts before any adoption decision.
- [ ] Run focused tests red first, affected full suites, all workspace typechecks, production build, GA and governance checks, dependency audit, container and deployment E2E, exact live health probes, restart recovery, and Chrome verification.
- [ ] Commit by coherent slice, publish protected pull requests, merge only after green checks, verify exact post-merge revisions, and update product claims only from retained production evidence.

Review: in progress. Exact main `8c1a2c9c8f553af65dbe3677ef45aaa3616e3be6` passed workflow `32537238131`, including tests, release gates, container builds, deployment E2E, deploy, and production health. The protected Regauge application-data key name was verified after in-memory generation; its value was never displayed or written locally.

Activation checkpoint: protected workflow `32537897567` passed preflight, exact authority derivation, restored-volume verification, storage verification, and secret staging, then failed before worker activation, model evaluation, or GitHub delivery. The coordinator exposed `regauge_production_bootstrap_idempotency_conflict` because the v1 campaign receipt bound a prior workflow run's short-lived approval and evidence into the durable campaign replay digest. The failed Machine `d8d2e26c9eed78` was removed; both encrypted volumes remain intact. A red regression reproduced the conflict. The v2 receipt now separates immutable campaign authority from the per-run authorization.

Second activation checkpoint: protected workflow `32539804388` reached the legacy reauthorization path but failed because that path rematerialized the repository and compared the new snapshot identity with the durable v1 receipt. The two failed attempts created two newer snapshots with the same exact revision and manifest as the original. Machine `2869194b4eee68` and the bounded diagnostic Machines were removed; both encrypted volumes remain intact and unattached. The corrected replay is read-only: it checks the current GitHub installation grant, tenant-scoped SCM connection, exact connected repository, the receipt's exact snapshot ID and stored bytes, recipe scope, control-plane blueprint, and running execution. It never materializes or requires the revision to be globally unique. RED failed 2 of 12 on the old behavior. GREEN passes 14 of 14 focused bootstrap/runtime tests, including duplicate snapshots, API typecheck, and 434 of 434 API tests after the two full-suite timeout cases passed on isolated rerun.

## Why the self-serve slices reverted in #93 were not restored (2026-08-21)

This section records a completed assessment. It deliberately restores nothing:
no code, no schema, no route, no npm script. Its only purpose is so the same
investigation is not re-run in a fortnight at the same cost and reaching the
same conclusion.

### On the revert itself

Commit 6a7b2f6 (#93, 13 August, "Restore last known healthy production
source") cut 58 files and 7,670 lines "for isolated diagnosis and reintroduction
after production is healthy," reverting #86 (Fly token name + verify:config),
#87 (RBAC), #90 (connectors), #92 (model-tenant-routing) and #89 (console).
The diagnosis it deferred was never completed and no reintroduction commit was
ever made. Nine days of absent product surface therefore rests on an unexamined
guess about which of five batched merges broke production. That is the finding
here, more than any single line of the reverted code.

### On the crash-loop cause

The failure it was reacting to ("the Fly machine exits before binding") matches
a documented failure CLASS, but the specific 13 August culprit was never pinned.

- The class is recorded at tasks/lessons.md:7: a static-DDL statement referenced
  a column (agent_runs.job_id) that only arrives via a later additive migration.
  Fresh databases (all tests, CI deployment-e2e) build the full table and pass;
  the existing production volume lacked the column, raw.exec(DDL) threw
  "no such column" before migrations ran, the machine crash-looped to its
  restart cap, and production stayed down until a manual image rollback. See
  also the memory notes "ensureTables never alters" and "Fresh-DB CI masks
  upgrade breaks."
- The two reverted DB tables look schema-innocent. In the pre-revert
  packages/db/src/index.ts, tenant_member_scopes and connectors are each
  self-contained: every indexed column exists in the same CREATE TABLE, and
  explicit comments state that CREATE IF NOT EXISTS is idempotent on fresh and
  existing volumes and that "no additive migration column entry is needed." The
  same file had already moved the agent_runs job_id unique index out of the
  static DDL and into the migration, i.e. it had already absorbed the lesson.
- #92 (packages/agent/src/model-tenant-routing.ts) remains a plausible,
  unexamined non-schema culprit: it runs unconditionally on every model call,
  unlike the flag-gated self-serve routes. It is out of scope to restore
  (contributor tier and model-tenant-routing must not be touched), so it was not
  investigated further here.

### On each slice (supersession)

- Console views (runs route, runs-view, run-controls, run-detail-view, run-map,
  connections-panel, access-view): SUPERSEDED. The console was rebuilt around a
  changes/prs model; the runs nav id now redirects to /prs
  (apps/web/app/components/console/console-shell.tsx). fixtures.ts exists today
  at 288 lines against the reverted-era 422, so a restore would clobber live
  work. Do not restore; treat as rebuild if wanted.
- Self-serve API routes (self-serve-runs.ts, self-serve-admin.ts,
  connectors.ts): AUTH REGRESSION as-is. Their gate is presence-only
  (principal present plus non-empty tenantId). Today's write standard
  (apps/api/src/warden-campaign-enrollment.ts) requires OIDC, a non-revoked
  human trust principal, an active tenant membership, and evidence-id
  re-verification immediately before the write. Making them compliant is a
  rebuild, not a restore. The read side is also partly superseded by
  packages/db/src/self-serve-dashboard.ts, which survived the revert.
- Connectors and member-scopes DB layers (packages/connectors,
  packages/db/src/connectors.ts, member-scopes.ts, audit-query): safe to apply
  (convergence-aware, no table-name collisions on main), but would be DEAD CODE:
  @mendpoint/connectors is imported nowhere, and the only consumers were the
  superseded console and the auth-regressive routes. One of the two,
  connectors, is a credential-storing tenant table, so landing it with no
  compliant write path adds attack surface for no delivered feature. Held.

### On verify:config specifically

Not restored. packages/ops/src/env.ts (validateApiEnv, readiness) already owns
production environment validation, masks secrets, and is wired into
npm run ga:check via scripts/ga-check.ts. Restoring a hand-maintained second
list of environment-variable names would create a drifting second source of
truth, not a restoration. Beyond that, the August script cannot honestly assert
today, per capability:

- Billing: unassertable. MENDPOINT_BILLING_COLLECTION, STRIPE_SECRET_KEY and
  MENDPOINT_BILLING_ALLOW_LIVE appear only in packages/shared/src/error-guidance.ts
  guidance strings; no live parser or collector consumes them on main.
- Model tier: stale and out of scope. The script's "customer code must never run
  on a training tier" framing contradicts the approved default tier
  muse-spark-1.2-contributor (model-tenant-routing.ts), and the real vars have
  changed (MENDPOINT_TRAINING_TIER_MODELS and MENDPOINT_NON_TRAINING_MODEL_PROVIDER
  are new).
- Fly sandbox: incomplete. Today additionally requires the digest-pinned
  MENDPOINT_SANDBOX_FLY_IMAGE (fly-sandbox refuses host fallback without it),
  plus MENDPOINT_SANDBOX_FLY_MODE and MENDPOINT_SANDBOX_ALLOW_UNPINNED_IMAGE.
- GitHub App: dead variables. GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET
  are read nowhere; the real ones today are GITHUB_APP_ACCOUNT_TENANT_BINDINGS,
  GITHUB_APP_OWNER_TENANT_BINDINGS, and GITHUB_APP_PRIVATE_KEY or
  GITHUB_APP_PRIVATE_KEY_PATH.
- Self-serve flags: renamed. MENDPOINT_SELF_SERVE_WARDEN is now
  MENDPOINT_SELF_SERVE_FETTLER (old name kept as a legacy alias via RENAMED_ENV
  in packages/shared/src/renamed-env.ts); MENDPOINT_SELF_SERVE_ADMIN is read
  nowhere.
- Key shape: wrong. MENDPOINT_APPLICATION_DATA_KEY is accepted as 64 hex OR
  base64url (parseCustomerBackupKey), so the hex-64-only shape rule would flag a
  valid key as malformed.

A verifier asserting dead names, a false training-tier policy, a wrong key
shape, and unwired billing variables would report green against a configuration
nobody runs. If an operator setup checklist is wanted later, build it as a
secret-safe presentation layer over validateApiEnv (reusing RENAMED_ENV),
covering only the self-serve capabilities validateApiEnv does not, and excluding
billing and model tier. That is new work, scoped and titled as such, not a
restoration.
## 2026-08-21 ReGauge production draft handoff and activation

- [x] Confirm the protected activation reached an exact durable `executed` unit on current production authority.
- [x] Identify the first missing transition between verified execution and exact draft delivery.
- [x] Add red tests proving the production worker presents the canary-scoped one-draft approval and authorizes the completed wave before claiming delivery.
- [x] Make draft authorization replay-safe across worker restarts without widening merge or deploy authority.
- [x] Add the coordinator operation and production profile wiring with exact approval validation.
- [x] Run focused Transformer, worker, API, workflow, typecheck, build, GA, and dependency gates.
- [ ] Strictly review the diff, commit, push, open and merge the PR only after checks pass.
- [ ] Rerun the protected ReGauge activation, prove one real draft, readiness soak, containment, exact deployed revision, and evidence artifact.
- [ ] Resume the preserved broader inventory after ReGauge activation: DeepSeek governed activation, learning, Graphify, and delegated proof finalization.
- [x] Contain the post-claim production worker while preserving the coordinator and encrypted campaign state.
- [x] Reproduce the post-claim failure against the exact live checkpoint and trace it to an executor digest change across deployments.
- [x] Add a red regression proving an authenticated terminal checkpoint remains deliverable after the delivery worker deploys a newer executor revision.
- [x] Open terminal delivery checkpoints with exact authenticated binding checks while permitting only the executor revision to differ; keep execution resume strict.
- [ ] Run focused and full verification, review, merge, redeploy, and rerun the protected one-draft canary.

### Review

- RED: the existing store rejected exact draft-authorization replay, and the real multi-node worker returned idle because it never requested the transition.
- GREEN: 68 focused tests pass across ReGauge state, worker service/CLI, and the authenticated coordinator integration.
- Full ReGauge core package: 36 files, 442 tests pass. API and worker package timing failures reproduced only under concurrent full-suite load; every changed focused suite and the previously timed coordinator/preflight tests pass alone.
- Full monorepo test command passes every workspace and the 73 script tests. The three affected package typechecks, full production build, GA gate, and production dependency audit also pass.
- Strict review: no P0/P1. Server-owned authority binds the exact campaign, environment, one-unit limit, source revision, remote repository, protected approval, and expiry. Cross-workflow recovery reuses the exact pending draft read-only without rewriting its historical authorization; pause and lease races remain fenced.
- Live binding: installation 151614362 now has account ID 273115720, selected repository access, and no suspension/deletion. No App settings mutation was needed.
- Post-merge live activation reached `delivery.drafts_authorized` and two fenced `delivery.draft_claimed` events, proving the claim fix. Exact source and target recovery passed. The worker then failed before GitHub branch creation at `openTransformerAttemptCheckpoint` with `transformer_attempt_checkpoint_binding_mismatch`.
- Root cause: the checkpoint binding includes `executorDigest`, and the protected workflow derives that digest from `GITHUB_SHA`. The completed attempt was created by the prior deployed revision; delivery ran after #312 on a different revision. The integration test used one digest for both phases, so it did not exercise deployment-boundary recovery. Delivery only reads an already terminal, authenticated checkpoint; attempt execution and resume must retain exact executor matching.
- RED: the package regression failed because the delivery-only opener did not exist, and the authenticated coordinator regression failed at `transformer_attempt_checkpoint_binding_mismatch` when its replacement worker used a newer executor digest.
- GREEN: 13 checkpoint tests and 7 authenticated coordinator tests pass. Exact execution reopening still rejects the newer executor, delivery accepts only that field difference, and a changed constraint still fails closed.
- Full verification: the complete monorepo `npm test` command exited 0, including 443 Transformer tests, 462 API tests, 410 worker tests, and 161 script tests. Transformer, worker, and API typechecks, the production build, GA gate, and the production dependency audit all pass; the audit reports 0 vulnerabilities.
- Security review: the authenticated envelope, canonical state, envelope metadata, tenant, environment, campaign, unit, repository, snapshot, source and candidate manifests, recipe, constraint, verification plan, and candidate seal remain exact. Only `executorDigest` may differ in the delivery-only opener. The execution and resume opener is unchanged and still rejects that difference.

## 2026-08-24 Issue #349: tenant isolation review fixes

- [x] Record red regressions for identical run IDs across tenants, scoped lists, foreign reads, and foreign plan mutation.
- [x] Namespace harness run state by authenticated tenant while preserving explicitly unscoped CLI compatibility.
- [x] Persist tenant identity on run scores and propagate scope through API, worker, and SDK callers.
- [x] Scope alerts to their tenant and quarantine legacy unscoped alerts to system operators.
- [x] Require system catalog authority for top-level tenant creation and reject unknown billing plans.
- [x] Run focused tests, affected package typechecks, the full production build, and repository verification gates.
- [x] Review the final diff for compatibility and tenant-boundary regressions, then push one branch and open one PR for issue #349.
- [ ] Obtain passing CI and reciprocal Claude review before considering the PR merge-ready.

### Review

- RED: the pre-fix focused suite failed because two tenants resolved the same run ID to one path, blank scope was accepted, alerts were process-global, and the scoped route/service modules did not exist.
- GREEN: 58 focused regressions pass across harness, platform, API, worker, and SDK. Full repository typecheck passed before the final review adjustment; final harness and API typechecks also pass.
- Independent review moved scoped state outside the legacy run root and added direct foreign trajectory denial plus endpoint-level tenant-creation coverage. `git diff --check` is clean.
- Final quality review found one score-only trajectory visibility defect; the fix now recognizes a tenant-owned run directory without weakening the plan endpoint's `plan.json` requirement. The independent re-review reports no P0, P1, or P2 findings.
- Full monorepo tests, the production build, and `npm run ga:check` pass on the final tree. The GA gate still reports eight proven-unreachable citations and ten verified foundational requirements without live-path evidence; those pre-existing product-contract gaps are reported, do not involve this tenant-isolation slice, and remain outside issue #349.

## 2026-08-24 Issue #353: dedicated ReGauge production profile

- [x] Add red tests proving the dedicated manifest fails current API and worker boot validation.
- [x] Accept `regauge_production` in shared production-role validation and require it in the ReGauge worker profile.
- [x] Separate stable process boot authority from the expiring one-draft authorization without widening delivery, merge, or deployment authority.
- [x] Add the dedicated `mendpoint-regauge-production` Fly manifest and canonical hostname without editing primary deployment manifests.
- [x] Add a manifest-to-boot contract test that exercises the exact production environment in both API and worker validators.
- [x] Run focused tests, affected package typechecks, production build, and repository verification gates.
- [x] Complete independent specification and quality review, then publish one PR referencing #353 and parent issue #350.
- [ ] Obtain passing CI and reciprocal Claude review before considering the PR merge-ready.

### Review

- RED: the dedicated `regauge_production` role and manifest were rejected by the shared API and worker production validators.
- GREEN: the exact dedicated manifest boots both validators, while malformed or expired draft authorization blocks new draft authorization without taking the stable API or worker process down. Persisted, already-authorized draft state remains replayable under its original exact campaign, repository, revision, approval, and one-draft constraints.
- The first quality review found two P1s and one P2: it broke the legacy protected pilot workflow, could send the bearer token to an arbitrary HTTPS coordinator, and omitted CODEOWNERS coverage. The follow-up preserves the legacy profile, requires the exact canonical coordinator URL for each production role before token transport, and adds the dedicated manifest to CODEOWNERS.
- Final independent review reports no P0, P1, or P2 findings. The focused suite passes 79 of 79 tests; API, worker, and ops typechecks, the production build, `npm run ga:check`, and `git diff --check` pass on the final tree.
- Deliberate boundary: this slice defines the dedicated production profile. App and volume provisioning, encrypted state migration, protected-workflow cutover, secret staging, live revision and health proof, one-draft proof, and retirement of the old pilot app remain in parent issue #350 and must not occur through this PR.

## 2026-08-22 Sandbox egress renewal recovery

- [x] Diagnose the live crash loop and retain the exact expired-attestation evidence.
- [x] Restrict `sandbox-production-renewal` to the exact default branch before adding authority.
- [x] Reconcile the reviewed nonsecret image, policy, app, org, target, and freshness bindings across both renewal environments.
- [x] Make failure evidence and paging runnable even when protected-authority validation fails before dependency installation.
- [x] Run the focused workflow tests, workflow syntax checks, release gates, and strict diff review.
- [ ] Provision only approved secret authority, rerun the already-confirmed one-proof rotation, and require live health before merging unrelated PRs.

### Review

Production Machine `896427a6e67358` repeatedly reaches the web ready state, then the worker refuses `sandbox_egress_attestation_expired`; the shared launcher exits and Fly reaches its restart cap. Renewal runs fail before probing because their protected environments are incomplete. The manual environment is missing an org-scoped rotation token and paging sink. The scheduled environment originally had neither a default-branch restriction nor any bindings; it is now restricted to exact `main` and carries only the reviewed nonsecret bindings. No credential value was read.

RED: the workflow test could not find any runtime-preparation step before protected-authority validation. The retained failed runs corroborate the defect: validation exited, evidence upload found no files, and the failure page crashed because `tsx` had not been installed.

GREEN: a single preparation step now writes only run metadata to a retained artifact and installs the existing reporter before validation. The probe, signing, and rotation order is unchanged. Thirteen focused renewal and image-egress tests pass, both workflow files parse as YAML, every action remains commit-pinned, GA passes, the production dependency audit reports zero vulnerabilities, and `git diff --check` is clean.
## 2026-08-22 ReGauge activation resolution lessons

- [x] Reconstruct the last failed and first successful protected activation runs from GitHub evidence.
- [x] Compare the live failure boundary with the exact delivery-only code change that resolved it.
- [x] Record the correction as reusable operating rules in `tasks/lessons.md`.
- [x] Verify the documentation diff, commit it separately, and publish it for review.

### Review

- Protected run `32588203239` proved coordinator and worker health, completed execution, authorized delivery, and reached draft claiming before failing at the delivery-time checkpoint binding. The earlier gates were not the active problem.
- Commit `5b159d8` was authored 26 minutes after that failed run ended. Its production change was one call-site substitution plus a narrowly scoped authenticated checkpoint reader: delivery may retain the terminal artifact's historical `executorDigest`, while tenant, environment, campaign, source, candidate, recipe, constraints, verification, envelope, and seal remain exact. Execution and resume remain strict.
- Pull request `318` carried red deployment-boundary regressions at the Transformer package and authenticated coordinator seams. It did not rebuild the campaign, rematerialize the repository, weaken execution replay, or broaden delivery authority.
- Protected run `32592758400` then passed preflight, exact authority validation, coordinator and worker deployment, bounded live model evaluation, the exact real draft canary, a five-minute read-only readiness soak, containment, and evidence upload. It ran from `19:07:02Z` to `19:19:00Z` against exact revision `1c6c9e9`.
- The speed came from using the durable event trace as a debugging cursor. Once the first missing transition was isolated, the existing completed attempt, authorization, checkpoint, encrypted workspace, and production campaign were treated as valid evidence to replay, not work to recreate.

## 2026-08-25 Public readiness route

- [x] Add a public `/readyz` route that reuses the existing full deployment readiness contract.
- [x] Keep `/readyz` outside the operator access gate and cover the middleware boundary.
- [x] Run focused web tests, web typecheck, production build, GA checks, and diff integrity.
- [ ] Publish a narrow PR, require current-base CI, merge, and verify the exact deployed route.

Acceptance: `/readyz` returns the same fail-closed API, authentication, worker, feed, recovery, and ReGauge infrastructure readiness verdict as `/healthz`; it is publicly probeable and does not create a weaker duplicate readiness implementation.

### Review

RED: the public production probe surface had no `/readyz` route, so the Phase 1 readiness assertion redirected to the operator access page rather than returning machine-readable readiness evidence.

GREEN: `/readyz` now re-exports the established `/healthz` readiness handler and is explicitly public in middleware. The focused route and middleware suite passes 38 of 38 tests, the web typecheck passes, the optimized web build includes `/readyz`, `npm run ga:check` passes, and `git diff --check` is clean.
## 2026-08-22 Public documentation drift

- [x] Reproduce the exact generated-file drift without rewriting source content.
- [x] Regenerate only the stale website-upload artifacts from the canonical catalog.
- [x] Run documentation checks, names and claims gates, production build, and strict diff review.
- [ ] Publish a separate protected pull request and leave deployment gated on live health.

### Review

RED: `npm run docs:check` reported exactly `model-router.html`, `model-router.md`, `billing-usage.html`, and `billing-usage.md` as stale.

GREEN: the canonical generator changed only those four artifacts. It removed references to the absent billing and router-runtime test files and aligned the router upload copy with the immutable decision record in the source catalog. `docs:check`, `names:check`, `claims:check`, and the production build pass; strict diff review found no source-catalog rewrite.
## 2026-08-24 Issue #351: platform hardening and backup automation

- [x] Add red regressions for zero, negative, fractional, nonnumeric, and excessive audit-export limits plus spreadsheet-formula cells in CSV output.
- [x] Parse audit-export limits as positive bounded integers and encode every formula-capable CSV cell safely without changing tenant scope.
- [x] Extract one streaming byte-limit reader for public Next.js routes and add red regressions for undeclared oversized webhook, design-partner, signup, session, and SAML bodies.
- [x] Apply bounded streaming reads to those five public routes and bound every upstream response they buffer.
- [x] Add a default-branch-only customer backup workflow running every 30 minutes under a protected environment, using an app-scoped Fly token, an explicit app binding, concurrency fencing, a bounded remote command, retained evidence, and a deduplicated GitHub issue on failure.
- [x] Add workflow contract tests proving schedule, permissions, exact environment and secret bindings, command timeout, evidence upload, and failure alerting cannot silently drift.
- [x] Run focused tests red first, affected typechecks, full tests, production build, GA checks, dependency audit, and diff checks.
- [ ] Complete independent review, publish one PR for #351, and obtain passing CI plus reciprocal Claude review before merge-ready.

### Review

- RED: the audit parser module and backup workflow did not exist. Five public-route regressions proved undeclared oversized streams were either buffered, returned a later validation status, or were not cancelled.
- GREEN: audit limits are exact positive integers capped at 20,000 at both HTTP and database boundaries. CSV cells that can be interpreted as spreadsheet formulas are neutralized. One shared reader caps and cancels request and upstream streams for the webhook, design-partner, signup, session, SAML, and authenticated proxy paths.
- Backup automation: the default-branch schedule runs every 30 minutes under `customer-production-backup`, refuses any Fly token that can see more or less than the one bound app, keeps runs serialized, invokes the existing authenticated backup operation remotely, retains evidence for 90 days, and owns one deduplicated GitHub failure issue.
- Strict review found and fixed two pre-publication defects: the design-partner timeout originally stopped after upstream headers instead of covering its body, and the Fly inventory parser used `Name` instead of flyctl's lowercase `name`. Both have exact regressions.
- Verification before rebasing: all affected typechecks pass; the complete monorepo test command exits 0, including 205 Web, 469 API, 379 database, 438 worker, and 169 script tests. The optimized production build and GA gate pass. The production dependency audit reports 0 vulnerabilities, and `git diff --check` is clean.
- Post-rebase verification against tenant-isolated main: 76 focused regressions, all three affected typechecks, and the optimized production build pass. The rebase was conflict-free outside this append-only task ledger.
- Activation boundary: merging code does not enable backups. Production activation still requires the protected `customer-production-backup` environment, `MENDPOINT_CUSTOMER_FLY_APP` environment variable, and app-scoped `MENDPOINT_CUSTOMER_BACKUP_FLY_TOKEN` secret. Production recovery is complete; this PR does not mutate those bindings.

## 2026-08-24 Production closure control matrix

- [x] Add a machine-readable 101-requirement closure matrix sourced from every canonical register set.
- [x] Record the live release-train owner, dependency, disposition, check-state, and P1/P2 blocker snapshot without treating branch-prefix ownership as authoritative.
- [x] Add red tests for missing requirements, canonical status drift, invalid requirement or PR references, and evidence-free verified or GA promotion.
- [x] Implement the smallest validator and wire it into the specification and GA gates.
- [x] Run focused tests, scripts typecheck, full typecheck, GA checks, and strict diff review.
- [x] Commit the isolated branch without pushing, merging, closing PRs, or changing requirement status.

### Review

- The matrix covers all 101 canonical requirements across the foundational, v3-platform, and v4-platform register sets without copying acceptance prose. Each row retains the exact canonical status plus canonical test and live-evidence identifiers, while open issue and pull-request mappings remain independent release-control metadata.
- The live snapshot was refreshed after rebasing to `cc21717080a7c6a940ff7837d034ec45c0797a9b`: 35 open pull requests, provisional branch-prefix ownership, explicit dependencies and dispositions, and 25 retained P1/P2 findings. Newly merged pull requests are absent; pull requests #415 through #421 are included.
- RED proved the validator module was absent. GREEN is five focused tests plus the CLI check: missing rows, canonical status or evidence drift, malformed or unknown references, and verified or GA promotion without qualifying evidence all fail closed.
- `npm run typecheck` passes across every workspace and the root scripts project. The GA chain passed contract, closure, claims, action pins, architecture, model, naming, ADR, third-state, and evidence reachability. Its revert suite twice hit different five-second wall-clock timeouts under concurrent load without assertion failures; the unchanged 19-test suite passed with `--testTimeout 20000`, and both the revert CLI and final GA preflight passed.
- No requirement status, Claude branch, pull request, issue, or production surface was changed by this implementation.

## 2026-08-24 Issue #361: durable ReGauge DeepSeek advisory verification

- [x] RED: prove the workflow emits the exact protected repository and branch in the generated Policy Envelope.
- [x] RED: prove each provider request durably binds the exact consent record and temporal authority before egress, with historical proof surviving later revocation.
- [x] RED: prove replay after a completed provider response cannot call DeepSeek again, while a failure with no response remains retryable.
- [x] Implement the minimal durable request intent and response receipt protocol under the existing artifact and fenced job stores.
- [x] Rerun focused Mission, Policy, consent, advisory, workflow, proof, API, and worker tests plus affected typechecks and integrity checks.
- [x] Review and commit the second P1 closure without pushing or merging.
- [x] Add red regressions proving ReGauge completion currently calls DeepSeek synchronously, loses failed observations, accepts the `shadow` production mode, and dispatches without an inherited Mission Policy Envelope.
- [x] Define one immutable ReGauge verifier Policy Envelope binding from protected nonsecret configuration, bind it at launch, and reconcile the same exact binding before advisory dispatch for already-running Missions.
- [x] Persist a content-addressed advisory input plus an identifier-and-digest-only `verifier.advisory.verify` job in one idempotent transaction; keep repository content out of the job payload.
- [x] Process advisory jobs through the existing fenced worker queue, rehydrate and verify the content-addressed input, revalidate Mission, repository, snapshot, Policy Envelope, consent, provider, and principal authority, then persist telemetry before completing the job.
- [x] Drain the advisory queue from the volume-owning production coordinator, restricted to `verifier.advisory.verify`, because the execution worker intentionally has no coordinator volume.
- [x] Make retries consult verified durable telemetry rather than the pre-call dispatch intent, so a failed provider attempt remains retryable and an already-recorded result never repeats provider work.
- [x] Replace active production `shadow` wiring with exact `advisory` mode while preserving behavior-change denial and compatibility aliases only where required for already-built callers.
- [x] Update the protected ReGauge workflow and profile contracts for the Policy Envelope binding and advisory mode without granting candidate selection, execution, delivery, merge, or deployment authority.
- [x] Run red-first focused tests, affected typechecks, full tests, optimized production build, GA checks, dependency audit, and diff checks.
- [x] Complete strict local review with no remaining P0 or P1 findings.
- [ ] Publish one PR closing #361 under #350, then obtain passing CI plus reciprocal Claude review before merge-ready.

### 2026-08-24 Spec review closure: substantive evidence and retryable receipts

- [x] RED: prove the advisory provider receives bounded substantive evidence rehydrated from the exact tenant-bound durable snapshot and candidate artifacts.
- [x] RED: prove tenant, repository, snapshot, candidate, digest, and content mismatches fail closed before provider egress while the queue payload remains identifier and digest only.
- [x] RED: prove definitive retryable provider responses advance to a new durable provider operation, while ambiguous operations fail closed and completed success never repeats.
- [x] Implement the smallest exact-bound evidence rehydration and definitive retryable outcome protocol under the existing stores.
- [x] Run the focused advisory matrices, affected typechecks, YAML and diff integrity checks.
- [x] Review and commit the closure without rebasing, pushing, or merging.

#### Review

- RED: 8 of 14 focused tests passed. The provider prompt omitted the exact before and after content, the queue had no substantive artifact binding, and durable 429, 503, and malformed 200 receipts were replayed indefinitely.
- GREEN: 17 of 17 direct regressions pass. The coordinator reconstructs the exact deterministic candidate from the tenant-bound immutable snapshot, verifies source and candidate digests, and persists a separately bounded content-addressed evidence artifact only after Policy Envelope authorization. The queue retains identifiers and digests only; the worker revalidates scope and policy before rehydrating content and verifies every artifact and source digest before consent-gated egress.
- Replay: a definitive retryable response gets an append-only classification bound to its exact receipt digest. The next queue attempt revalidates current consent and creates a new uniquely numbered operation. An intent without a response remains outcome-unknown and fail closed; an unclassified completed response is recovered; durable success remains telemetry-terminal and is never reissued.
- Verification: the 10-file advisory, consent, workflow, and production-proof matrix passes 54 of 54 tests. The 19-file Mission, Policy, campaign, and advisory integration matrix passes 126 of 126 tests. Verifier, pipeline, worker, and API typechecks pass, and `git diff --check` is clean.

### Review

- RED: the original completion hook called the provider in process, treated dispatch intent as a replay terminal, accepted production `shadow`, had no inherited Policy Envelope, and left a coordinator-owned durable queue invisible to the volume-free execution worker.
- GREEN: exact completion now persists a content-addressed input and identifier-only job. The mounted coordinator drains only `verifier.advisory.verify`; an allowlist regression proves unrelated jobs remain pending. Provider telemetry is validated and durable before job completion, while transient provider failures remain retryable.
- Authority: the exact Mission, repository, snapshot, branch, immutable Policy Envelope, service principal, append-only tenant consent, governance entry, processing region, DeepSeek V4 Flash backend, and advisory-only no-behavior-change result are revalidated. Consent expires no later than 2026-11-20T23:59:59.000Z.
- Review fix: final architecture review caught the P1 volume boundary before push. The coordinator-side drain keeps the execution worker volume-free and uses the existing fenced job lifecycle without allowing the coordinator to claim pipeline, repair, delivery, learning, or campaign-execution jobs.
- Verification: the full repository suite passed before the final conflict-free main rebases, including 444 Transformer, 482 API, 460 worker, and 169 script tests. The exact current revision then passed the 174-test Mission-policy, renamed campaign-payload, and advisory integration matrix. Affected package typechecks, the 50-route optimized production build, GA checks, startup-script syntax, diff integrity, and the production audit with zero vulnerabilities also passed.
- P1 closure: the protected workflow now stages the worker's canonical `transformer/<tenant>/<campaign>` object prefix and rejects any tenant, campaign, owner, repository, or branch outside the one approved ReGauge canary scope before mutation.
- P1 closure: the durable consent purpose, immutable Policy Envelope, enqueue path, worker rehydration, and provider boundary all require `tenant_regauge_canary`, `campaign_regauge_canary_20260814`, `gondalaimafia/mendpoint-canary-drill-20260801`, branch `main`, and an expiry no later than 2026-11-20. An empty template cannot inherit runtime repository authority.
- P1 closure: production observations reconstruct the append-only consent record active at provider processing time and return its identifier, effective time, grant time, expiry, and digest. The production proof rejects missing, mismatched, late, expired, or post-deadline durable consent evidence instead of trusting telemetry alone.
- Fresh P1 verification: 181 Mission, Policy, campaign, workflow, proof, API, worker, and advisory tests pass across 19 files. Pipeline, API, worker, and scripts typechecks pass, and `git diff --check` is clean.
- Final launch-policy closure: the production bootstrap now retains and binds the exact restrictive DeepSeek verifier Policy Envelope before the ReGauge Mission enters execution. The later advisory reconciler reuses the same immutable tenant/version/content binding, so the tenant default envelope can no longer create a deterministic version conflict that prevents enqueue.
- Final workflow-source closure: the protected deploy job and its pre-mutation validation both require repository `gondalaimafia/mendpoint` and ref `refs/heads/main`; a manually dispatched feature-branch revision cannot reach Fly mutation even if environment branch protection drifts.
- Final focused verification: the two red regressions fail on the predecessor and pass on the repair. The exact 14-file ReGauge matrix passes 201 of 201 tests, Pipeline and API typechecks pass, and the review fixes remain within the existing Mission, Policy Envelope, and protected workflow contracts.
- Migrated-state closure: the restrictive production envelope is immutable version 2. A current-main Mission already pinned to the exact deterministic tenant default v1 advances through a revision-fenced `mission.policy_envelope_advanced` event; all other prior bindings fail closed. Existing bootstrap receipts invoke this reconciliation after revalidating repository, control, and execution state, without relaunching the campaign or replaying provider work.
- Second-review RED: 4 of 15 focused tests failed because the workflow generated empty scopes, no provider-operation store existed, and the provider-return crash seams completed without durable recovery state.
- Second-review GREEN: the generated Policy Envelope names the exact approved repository and `main`. Each DeepSeek request now inserts a content-addressed intent containing the exact canonical consent snapshot and request binding before egress; each returned HTTP response is durably receipted before verifier parsing. A receipt is replayed without another provider call, an unresolved intent fails closed, and only an explicit no-response failure may create a new attempt.
- Historical authority: production observations read the exact bound consent snapshot and provider request/processing times from the durable operation ledger, so later revocation does not erase valid historical proof. The current provider path still resolves active consent immediately before every new request, so revocation cannot authorize new processing.
- Second-review verification: 184 Mission, Policy, campaign, workflow, proof, API, worker, and advisory tests pass across 19 files. The narrower advisory matrix passes 68 tests across 10 files. Pipeline, API, worker, and scripts typechecks pass; the workflow parses as YAML and diff integrity is clean.

### 2026-08-24 Final spec review closure: completion outbox and revoked consent

- [x] RED: prove ReGauge completion acknowledges independently when advisory dispatch fails, while a tenant-bound identifier-and-digest-only outbox remains durable and retryable.
- [x] RED: prove outbox replay is idempotent and rejects tenant or completion-digest mismatches.
- [x] RED: prove coordinator bootstrap restarts after consent revocation without creating a replacement grant, while new verifier egress remains disabled.
- [x] Implement the smallest transactional completion outbox and asynchronous advisory drain through the existing verifier job lane.
- [x] Make revoked or otherwise inactive historical consent an explicit verifier-disabled bootstrap result that requires a new versioned operator grant before future egress.
- [x] Run the focused Mission, Policy, campaign, advisory, bootstrap, and coordinator matrices plus affected typechecks and diff integrity.
- [x] Review and commit the closure without rebasing, pushing, or merging.

#### Review

- RED: the transactional completion test had no outbox API, the coordinator returned an advisory queue failure after the terminal attempt was already committed, and bootstrap rejected a revoked consent replay with `regauge_verifier_consent_inactive`.
- GREEN: the exact configured coordinator lane now adds one tenant-bound identifier-and-digest-only outbox row in the same SQLite transaction as `attempt.completed_with_checkpoint`. Non-authorized tenant and campaign completions do not request an outbox row. Queue and evidence work runs asynchronously, records append-only failure or enqueued outcomes, and replays the existing identifier-only verifier job without changing execution or delivery.
- Consent: an existing revoked or inactive consent keeps ReGauge bootstrap available and emits a visible verifier-disabled event. Changing protected authority returns the exact next version and supersession requirement but never creates a grant; an explicitly recorded next-version grant re-enables the existing active-consent gate.
- Verification: 163 focused Transformer, Mission, Policy, consent, coordinator, advisory, worker, workflow, and production-proof tests pass across 11 files. Database, Transformer, and API typechecks pass, and diff integrity is clean.

### 2026-08-24 Exact-head closure: legacy backfill and fenced advisory claims

- [x] RED: preserve the pre-feature immutable completion request digest when the server requests an advisory outbox row.
- [x] RED: backfill one authenticated identifier-and-digest-only outbox row for an exact legacy terminal event without replaying completion, and reject a tampered event atomically.
- [x] RED: prove two concurrent drainers cannot claim the same dispatch, an expired claim can be fenced and taken over, and each claim has one terminal result.
- [x] RED: prove retryable failures honor bounded exponential backoff so repeated readiness polls do not append failure rows.
- [x] Remove advisory dispatch configuration from the historical completion request payload while retaining atomic event and outbox insertion for new completions.
- [x] Implement exact-scope authenticated outbox backfill and tenant-scoped fenced claims under append-only store invariants.
- [x] Drain claims asynchronously into the deterministic verifier job lane and preserve completion, execution, selection, and delivery independence.
- [x] Run the focused advisory matrix, affected typechecks, and diff integrity checks.
- [x] Review and commit without rebasing, pushing, or merging.

#### Review

- RED: the same historical checkpoint completion replayed with the server-only advisory flag failed with `transformer_pilot_idempotency_conflict`, and the asynchronous drain still consumed an unfenced pending list.
- GREEN: the immutable terminal request no longer contains advisory configuration. Existing authenticated terminal events are checked against their append-only idempotency digest, exact checkpoint, completion, authorization, tenant, campaign, unit, episode, and current durable campaign state before one deterministic identifier-and-digest-only outbox row is inserted or verified.
- Concurrency: append-only tenant-scoped claim and claim-result ledgers enforce one live lease, monotonic fencing, one terminal result per claim, takeover only after expiry, exponential retry backoff, and a terminal eight-failure ceiling. Two SQLite coordinator connections cannot claim the same dispatch.
- Isolation: readiness drains backfill only the configured exact ReGauge campaign, claim before loading evidence or enqueueing, and retain the deterministic verifier job identity. Completion, candidate selection, execution, delivery, merge, and deployment authority are unchanged.
- Verification: 56 direct store and drain regressions pass. The 11-file ReGauge advisory, consent, coordinator, worker, workflow, and proof matrix passes 163 tests. Transformer and API typechecks pass, and diff integrity is clean.

### 2026-08-24 Final reciprocal review closure: replay consent and canonical legacy policy

- [x] RED: prove an existing bootstrap receipt created before verifier activation has no consent, then gains the exact configured durable consent on replay without relaunching the campaign.
- [x] RED: prove a legacy v1 Policy Envelope with the deterministic default identifier but altered semantics cannot receive the privileged v2 advance.
- [x] Reconcile verifier consent on the validated existing-receipt path through the same grant-or-disabled authority used by fresh bootstrap.
- [x] Validate the full canonical default v1 body, digest, identifier, and exact v1-to-v2 transition before retaining any new Policy Envelope authority.
- [x] Run the focused bootstrap, policy, advisory, and workflow regressions plus affected typechecks and diff integrity.

#### Review

- Consent: an authenticated existing bootstrap receipt now reconciles the protected durable consent before Mission policy reconciliation. A missing historical grant is created once; an inactive or revoked version remains disabled and is never silently replaced.
- Policy: the privileged migrated-state path accepts only the byte-identical canonical tenant default v1 and exact restrictive v2 target. A forged but internally consistent default identifier fails before v2 is inserted.
- Verification: 20 focused bootstrap, Policy Envelope, advisory, and protected-workflow tests pass across 4 files. Diff integrity is clean.

### 2026-08-25 Exact-head production profile review closure

- [x] Align protected workflow Policy Envelope v2 with coordinator and worker boot validation.
- [x] Bind legacy default validation to default residency and the retained row creation time rather than trusting fields embedded in candidate JSON.
- [x] Pin production verifier egress to the authorized DeepSeek HTTPS origin.
- [x] Add workflow-to-profile, forged-residency, forged-time, and endpoint-redirection regressions.
- [x] Run the focused production profile, policy migration, and workflow matrix.

#### Review

- Boot contract: the exact workflow-staged Policy Envelope version now equals the only version accepted by the dedicated production profile.
- Historical authority: repository scope, residency, or embedded-time mutations under the deterministic default identifier all fail before restrictive v2 is retained.
- Egress: the dedicated production profile accepts only `https://api.deepseek.com`; plaintext, alternate-host, path, and whitespace variants fail before coordinator or worker startup.
- Verification: 39 focused tests pass across 3 files.

### 2026-08-25 Final MissionTask settlement review closure

- [x] RED: prove a successful advisory job cannot remain done while its bound MissionTask remains `agent_working`.
- [x] Couple fenced job completion and the review-first MissionTask handoff in one SQLite transaction.
- [x] Prove a crash before commit rolls back both lifecycle writes, then replay reuses durable verifier telemetry without another provider call.
- [x] Preserve current-main MissionTask claim bridging and refresh the same lease generation after synchronous preparation before a long attempt.
- [x] Run advisory settlement, MissionTask bridge, and worker lease regressions.

#### Review

- Settlement: successful and already-verified advisory jobs finish with their deterministic job MissionTask at `human_review_required`, never stranded in `agent_working`.
- Recovery: a simulated crash after handoff but before commit leaves the job running and the task agent-owned; replay performs no repeated provider work and commits both terminal records together.
- Fencing: the short-lease regression now refreshes the existing generation immediately before the long attempt boundary. Lease ownership and generation checks remain unchanged.
- Verification: the complete affected worker matrix passes 77 tests across 3 files, including the scheduler-resilient short-lease regression.

### 2026-08-25 PR 387 exact-head release qualification

- [x] Complete the 15-file ReGauge and DeepSeek matrix: 218 of 218 tests pass.
- [x] Complete full workspace typecheck on the reviewed head.
- [x] RED: reproduce the full-suite pipeline security-gate timeout at 5.359 seconds under repository-wide contention.
- [x] Trace the test and production path, confirm PR 387 does not alter it, and reproduce the same test at 617 ms alone and 831 ms under pipeline-workspace load.
- [x] Give only the two-run integration test a bounded 15-second deadline; do not change production behavior or the global test timeout.
- [x] Re-run the focused regression, all 200 pipeline tests, and the complete repository test suite successfully.
- [x] Complete optimized build, GA policy checks, production dependency audit, API startup, and diff-integrity gates.
- [ ] Complete protected CI container builds and deployment E2E; local Docker is unavailable.
- [ ] Refresh against current `origin/main`, obtain exact-head reciprocal review and Claude review, then merge only with current CI.

#### Review

- Root cause: the security-attestation integration test runs the full pipeline twice and inherited Vitest's 5-second unit-test default. Full-suite CPU and disk contention pushed one run to 5.359 seconds; isolated and workspace runs remained below one second.
- Repair: a test-local 15-second deadline matches other heavy integration tests and preserves both the fail-closed negative case and the attested positive control.
- Evidence: focused regression passed, pipeline workspace passed 200 of 200 tests, and the complete repository test command exited 0 after the repair.
- Current-main integration: main added an explicit `inconclusive` worker outcome. The coordinator-only advisory filter now asserts that counter remains zero; the final 15-file matrix passes 222 of 222 tests with the new main semantics retained.
- Claude exact-head review: removed the unused `getMission` import left after advisory dispatch moved to the coordinator. This changes no runtime behavior and removes a false dependency signal.

### 2026-08-25 DeepSeek transport outcome closure

- [x] RED: prove an Undici connection establishment timeout can advance to a new durable operation after an exact no-dispatch receipt.
- [x] RED: prove resets, generic timeouts, broken pipes, aborts, Undici socket, header, and body failures cannot be recorded as no-response evidence or repeat provider work.
- [x] RED: reproduce the production wrapper deadline leaving an intent without a terminal provider observation.
- [x] Propagate an unsettled durable request intent as `verifier_advisory_provider_outcome_unknown` on the first job attempt instead of consuming the retry budget as a generic API failure.
- [x] Expand automatic retries only to fixed pre-connect errors and keep all post-dispatch ambiguity fail closed.
- [x] Refuse a pre-aborted verifier request before invoking the transport.
- [x] Align the dedicated production timeout with the provider queue boundary while keeping it below the renewing job lease.
- [x] Bind retryable response classification to the latest attempted operation so a later no-dispatch failure cannot supersede an earlier successful receipt.
- [x] Bind classification to the current provider invocation so a later lease or authority failure before intent cannot supersede earlier paid work.
- [x] Refresh the same fenced lease before every provider request and reject worker lease configurations shorter than the provider deadline plus settlement margin.
- [x] Reject backend-local retries for the durable ReGauge transport; retries remain owned by the classified, fenced job lane.
- [x] Run the complete changed-area ReGauge and DeepSeek matrix plus affected typechecks and diff integrity.
- [x] Rebase onto current main while retaining the pinned Mission graph version and migrated verifier Policy Envelope authority.
- [x] Obtain exact-head reciprocal review with no P0, P1, or P2 findings.
- [ ] Obtain attributable Claude review, then require fresh protected CI before merge.

#### Review

- Retry safety: only `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`, `EADDRNOTAVAIL`, and `UND_ERR_CONNECT_TIMEOUT` can create the signed no-response path. Every reset, generic timeout, pipe, abort, socket, header, or body failure remains outcome unknown because provider work may have occurred.
- Lifecycle: the worker tracks request intents and durable response or no-dispatch settlements around the existing provider operation ledger. A retryable verifier result with any unsettled operation is promoted to the explicit nonretryable reconciliation error immediately; replay consults the retained intent and never reissues it.
- Operation binding: only the most recently attempted operation may receive a retryable-response classification, and only when that same operation has a durable response receipt. A later pre-connect failure cannot mark an earlier successful call retryable.
- Invocation binding: the durable transport clears its classification target before lease, consent, and intent gates. A later failure before creating an operation leaves an explicit no-operation outcome, so an earlier paid response remains recoverable and is never repeated.
- Lease safety: every long provider boundary refreshes the same job owner and generation before creating an intent. The worker rejects a configured lease that cannot cover the provider deadline plus a 60 second settlement margin; production retains 240 seconds of margin.
- Deadline: the dedicated production profile waits 660 seconds, covering DeepSeek's documented ten minute queue behavior while remaining below the default renewing 900 second job lease. The deadline still seals an ambiguous operation rather than pretending the provider did no work.
- Verification: the new multi-criterion lease-loss regression failed against the reviewed implementation, then all 27 advisory-job tests passed after current-invocation binding. On rebased head `88a01c0b`, the complete 17-file matrix passes 266 of 266 tests, full workspace typecheck passes, the optimized 50-route production build passes, GA policy checks pass while retaining the non-GA ReGauge disclosure, and the production dependency audit reports zero vulnerabilities.
- Reciprocal review: exact-head review against `edd22d0a` reports no P0, P1, or P2 findings and independently passes 61 focused verifier and profile tests.

### 2026-08-25 ReGauge production volume contract closure

- [x] Read the live dedicated-app volume metadata before changing the deployment contract.
- [x] Reproduce Fly's rejection of the manifest's overlength volume name.
- [x] Bind the workflow and manifest to the existing encrypted 20 GB `sjc` production volume.
- [x] Remove the opaque hardware-zone pin and require at least 14 days of scheduled snapshot retention.
- [x] Run the focused workflow regression, affected typechecks, YAML parsing, and diff integrity checks.
- [x] Obtain exact-head reciprocal review and current-base CI before merge.

#### Review

- RED: the protected workflow and Fly manifest required `mendpoint_regauge_production_data`, which exceeds Fly's 30-character volume-name limit. A direct creation attempt was rejected before mutation. The already provisioned `mendpoint_regauge_prod_data` volume is encrypted, 20 GB, in `sjc`, healthy, unattached, has scheduled backups, and retains snapshots for 30 days.
- The workflow also pinned opaque Fly hardware zone `b376`, while the healthy allocated volume is in zone `2618`. The production contract requires region, encryption, backups, and retention, not a hardware allocation identifier.
- GREEN: all 9 protected-workflow regressions pass, the scripts TypeScript project checks cleanly, the workflow parses as YAML, and diff integrity passes.
- Release: exact-head reciprocal review found no P0, P1, or P2 findings. PR #442 merged as `644488aa17114e3cfb3ada5e28e64d3afcac2dac`; current-main tests, release gates, container startup, deployment E2E, and deploy all passed. Production reports the exact revision and all four health endpoints return 200.

### 2026-08-25 ReGauge canary branch authority closure

- [x] Bind the approved DeepSeek scope to the exact canary branch that contains the pinned revision.
- [x] Derive the protected Policy Envelope branch scope from the protected environment binding while retaining an exact fail-closed branch assertion.
- [x] Update ReGauge production profile, verifier, and workflow regressions without changing repository, tenant, campaign, or advisory-only authority.
- [x] Run the focused ReGauge and DeepSeek matrix, affected typechecks, workflow parsing, build, and diff integrity.
- [ ] Obtain exact-head review and current-base CI before merge.

#### Review

- Root cause: the protected environment and pinned Git revision identify `codex/regauge-canary-baseline`, while the shared DeepSeek scope and workflow Policy Envelope required `main`; activation would fail before the dedicated coordinator could start.
- Authority: the approved scope now names the exact canary branch. The workflow derives the envelope branch from the protected binding and separately rejects every branch except that approved value. Tenant, campaign, repository, model class, external-processing consent, advisory-only behavior, and expiry are unchanged.
- Verification: 74 focused tests pass across the production workflow, shared advisory scope, worker profile, worker verifier job, coordinator dispatch, and bootstrap runtime. Full workspace typecheck, the optimized 50-route production build, and the complete GA policy and evidence gate pass; YAML parsing and diff integrity are clean. The register remains honest at 28 verified foundational requirements, with ReGauge still explicitly non-GA.
## 2026-08-22 Production-only product promotion

- [ ] Inventory every runtime, workflow, environment, route, worker, public claim, and release artifact that is pilot, shadow, demo, mock, default off, inactive, or evidence only.
- [ ] Classify each surface as promotion ready, code incomplete, evidence blocked, or authority blocked, with an exact source and production proof pointer.
- [ ] Restore the shared production foundation before merging any change that would trigger deployment.
- [ ] Promote eligible capabilities in dependency order without weakening tenant consent, source control authorization, sandbox egress, reviewer approval, or rollback controls.
- [ ] Run focused regressions, full tests, all workspace typechecks, production build, GA and governance checks, dependency audit, container startup, deployment E2E, exact live probes, restart recovery, and authenticated browser verification.
- [ ] Merge only green protected changes, verify the exact deployed revision, and remove pilot, shadow, demo, mock, and inactive claims only where production evidence exists.
- [ ] Record any remaining external authority or evidence blockers as blockers, not as production functionality.

### Review

In progress. The target state is production operation with retained safety controls, not global flag deletion or terminology-only renaming. A capability remains incomplete until its real production path, rollback, observability, and exact live evidence pass.

## 2026-08-22 Non-ReGauge outstanding inventory

Direction: park ReGauge activation and resume the remaining seven-day inventory. Preserve the coordinator, encrypted volumes, campaign state, and merged checkpoint fix. Do not approve or dispatch another ReGauge activation until Talal resumes that workstream.

- [x] Cancel waiting ReGauge production workflow `32592472552` before protected approval.
- [ ] Restore `mendpoint-talal` health by renewing the expired sandbox egress receipt without weakening the default-deny proof.
- [x] Reconcile live open pull requests, dirty worktrees, failed workflows, TODO markers, outstanding planning records, and external environment bindings.
- [ ] Review and finish eligible learning-flywheel work, beginning with PR 319, without overlapping Claude's active branch.
- [ ] Finish delegated cleanup and acceptance proof wiring that has current authority. The exact retain-only consumer is now production-wired and default off; protected signer provisioning and the three-trial producer remain.
- [x] Give the Fettler completion verifier bounded substantive repository evidence and add a one-request, synthetic-public DeepSeek shadow smoke runner.
- [ ] Finish Graphify implementation and comparative evidence that can run under current sandbox authority.
- [x] Close small code-quality gaps: pilot intake authorization parity, unlinked outcomes metrics, renamed environment coverage, dead adaptive router aggregation, and collision-proof ADR numbering.
- [ ] Run affected tests red first, full tests, workspace typechecks, production build, GA checks, dependency audit, container/deployment E2E, and live verification before merge.
- [ ] Record separately anything requiring a new credential, tenant consent, reviewer binding, or external target; do not simulate activation evidence.

### Review

In progress. ReGauge workflow `32592472552` is cancelled. Main production is independently unhealthy because `MENDPOINT_SANDBOX_EGRESS_ATTESTATION` expired; the reviewed renewal workflow fails closed because `ROTATION_FLY_API_TOKEN` and a paging sink are absent from `sandbox-production`.

DeepSeek review: the dedicated coordinator has the key and exact shadow configuration, while the main Fettler app does not yet have those bindings. The prior product pack carried only verification and owner references, so even a high score could not reach `ready_for_review`. Fettler now assembles a bounded excerpt from only exact changed files, rejects traversal, symlinks, binary data, oversized files, and non-file paths, and adds that substantive evidence to the shadow pack. The live provider exposed two protocol bugs hidden by mocks: the prompt's literal `[A-T]` placeholder was echoed, and V4 Flash fused the tag boundary with the score token (`>A`). RED regressions now require an explicit X substitution and contextual normalization that accepts only alternatives with the exact same token prefix and suffix. Focused verifier and worker suites plus affected typechecks pass. A synthetic-public live protocol proof returned model `deepseek-v4-flash`, nonthinking logprobs, candidate score `1`, recognized probability mass `1`, 288 total tokens, estimated cost `$0.0000060368`, latency `823 ms`, and response digest `sha256:c550da51589c3e28d91587d5af58b4655d9f6c1d17c84c6d08702d4d9604f4b3`. This is provider compatibility evidence, not ReGauge activation or a quality benchmark; no ReGauge worker was started.

Delegated cleanup review: the inert `warden.candidate.cleanup` handoff now has an exact consumer. It re-resolves the current service principal, verification, candidate, snapshot, delivery, observation, installation, repository, pull request, base and head authority; materializes content-addressed task and retain-only policy artifacts; runs the GitHub App cleanup port; signs the durable cleanup evidence; and completes the fenced lease. The branch disposition is hard-coded to `retain_exact`; delete, merge, and deploy authority are explicitly false. The dispatcher leaves cleanup jobs pending when disabled and validates a current matching Ed25519 key pair before it will claim them. It rechecks the key window at authority resolution and again at the signing instant, while job completion uses a fresh timestamp so an expired lease cannot be completed after a slow remote call. Twelve focused authority and job tests, 62 worker dispatcher tests, seven pipeline authority and attestation tests, and 50 GitHub runtime and exact cleanup tests pass. The complete monorepo test command, full workspace typecheck, production build, GA gate, dependency audit, and strict diff check also pass; the audit reports 0 vulnerabilities. The main Fly app has none of the `MENDPOINT_DELEGATED_PR_ATTESTATION_*` bindings or `MENDPOINT_DELEGATED_PR_CLEANUP_ENABLED`, so live activation remains correctly off and requires a dedicated protected key and nonsecret trust bindings. No secret value was read.

Small-gap reconciliation: outcomes navigation shipped in #317, the ReGauge live-eval alias retired in #308, adaptive routing now refuses activation while its sole aggregate producer remains intentionally unwired in #315, and dated ADR identifiers plus the collision check shipped in #311. The remaining Fettler pilot intake asymmetry is now closed: API keys, non-OIDC sessions, missing or mismatched membership evidence, offboarded memberships, cross-tenant trust, and revoked or expired human trust principals are refused before a job can be replayed or enqueued. The current trust and membership rows are rechecked immediately before the write. The red regression observed the old 202 and cross-tenant 404 behavior; all eight focused intake tests and API typecheck pass after the fix.

## 2026-08-22 Graphify pinned process and benchmark

Objective: finish only the internal evaluation lane authorized by ADR-0006. Build a pinned, killable, zero-network Graphify process over copied immutable bytes; measure it against the current extractor with sealed labels; and keep production selection impossible unless the evidence clears every adoption gate.

- [x] Re-read the checked-in Graphify authority, ADR, adapter contract, benchmark contract, and exact upstream `0.9.46` source at `558df6d57d61cb6ef79c740ec7473c6d953d79a7`.
- [x] Add red tests for process identity, private working directory, exact byte materialization, protocol bounds, output coverage, timeout termination, memory enforcement, and zero-network authority.
- [x] Implement the private Python process bridge and Node supervisor without exporting Graphify process types or adding a production environment selector.
- [x] Pin the evaluation dependency and retained license materials, then verify the installed artifact against the recorded digest before execution.
- [ ] Build the 18-case A/B/C cohort, stage predictions before labels, grade with a separately supplied sealed key, and measure direct, indirect, trap, incremental, and four size tiers.
- [x] Record the exact result and adoption blockers without converting internal evidence into a product claim.
- [ ] Run focused suites, workspace typechecks, production build, GA checks, dependency audit, container checks, and strict diff review before publishing a separate pull request.

### Review

- The official PyPI JSON record independently matches the compiled `graphifyy-0.9.46-py3-none-any.whl` SHA-256 pin.
- Red first process tests failed before the concrete supervisor existed. Seven supervisor regressions and the existing 49 contract and benchmark tests now pass.
- The bridge syntax check, full workspace typecheck, root script typecheck, workflow pin check, YAML parse, and strict diff whitespace check pass.
- The complete monorepo test command passes every workspace and all 164 root script tests. The production build, GA gate, and production dependency audit pass; the audit reports 0 vulnerabilities.
- Windows cannot prove the Linux network namespace boundary and this machine has no WSL or Docker. The pull-request workflow is therefore the first eligible real process smoke; no local execution is represented as containment evidence.
- Production selection remains impossible: the process factory is absent from the package root, there is no environment selector or caller, and the adoption decision remains internal only.
- Linux process proof: GitHub run `32600370037` passed on exact revision `557b3e4c47726f4858ab52c0764bbc61bfc5758f`. The two-file smoke produced 4 nodes and 5 edges in 220.901 ms at 33,460,224 peak RSS bytes. The evidence record explicitly denies sealed-holdout, four-tier, quality, economics, and production-adoption claims.

## 2026-08-22 Sandbox egress renewal recovery

- [x] Diagnose the live crash loop and retain the exact expired-attestation evidence.
- [x] Restrict `sandbox-production-renewal` to the exact default branch before adding authority.
- [x] Reconcile the reviewed nonsecret image, policy, app, org, target, and freshness bindings across both renewal environments.
- [x] Make failure evidence and paging runnable even when protected-authority validation fails before dependency installation.
- [x] Run the focused workflow tests, workflow syntax checks, release gates, and strict diff review.
- [ ] Provision only approved secret authority, rerun the already-confirmed one-proof rotation, and require live health before merging unrelated PRs.

### Review

Production Machine `896427a6e67358` repeatedly reaches the web ready state, then the worker refuses `sandbox_egress_attestation_expired`; the shared launcher exits and Fly reaches its restart cap. Renewal runs fail before probing because their protected environments are incomplete. The manual environment is missing an org-scoped rotation token and paging sink. The scheduled environment originally had neither a default-branch restriction nor any bindings; it is now restricted to exact `main` and carries only the reviewed nonsecret bindings. No credential value was read.

RED: the workflow test could not find any runtime-preparation step before protected-authority validation. The retained failed runs corroborate the defect: validation exited, evidence upload found no files, and the failure page crashed because `tsx` had not been installed.

GREEN: a single preparation step now writes only run metadata to a retained artifact and installs the existing reporter before validation. The probe, signing, and rotation order is unchanged. Thirteen focused renewal and image-egress tests pass, both workflow files parse as YAML, every action remains commit-pinned, GA passes, the production dependency audit reports zero vulnerabilities, and `git diff --check` is clean.

## 2026-08-22 Public documentation drift

- [x] Reproduce the exact generated-file drift without rewriting source content.
- [x] Regenerate only the stale website-upload artifacts from the canonical catalog.
- [x] Run documentation checks, names and claims gates, production build, and strict diff review.
- [ ] Publish a separate protected pull request and leave deployment gated on live health.

### Review

RED: `npm run docs:check` reported exactly `model-router.html`, `model-router.md`, `billing-usage.html`, and `billing-usage.md` as stale.

GREEN: the canonical generator changed only those four artifacts. It removed references to the absent billing and router-runtime test files and aligned the router upload copy with the immutable decision record in the source catalog. `docs:check`, `names:check`, `claims:check`, and the production build pass; strict diff review found no source-catalog rewrite.

### 2026-08-25 ReGauge authenticated state transfer

- [x] Define a versioned, authenticated, encrypted transfer manifest for the exact four live SQLite stores and immutable authority bindings.
- [x] Snapshot live WAL databases consistently under a persistent mutation fence and retain integrity, schema, row-count, foreign-key, and ledger-tip evidence.
- [x] Restore create-only into an empty target and verify exact evidence while rollback remains fail closed.
- [x] Add a bounded state-transfer CLI and reuse the immutable object-store publication contract without exposing secrets.
- [x] Configure both ReGauge manifests for cooperative fencing and require an authenticated restore receipt before target coordinator startup and credential staging.
- [x] Prove historical checkpoint delivery remains readable while execution and completed provider work cannot replay.
- [x] Run focused cutover, workflow, checkpoint, typecheck, build, GA, dependency-audit, and diff-integrity gates.
- [ ] Obtain exact-head review and current-base CI before merge. Do not activate production in this PR.

#### Review

- The transfer engine now uses the production mutation-admission `exclusive.json` marker plus an authenticated persistent cutover marker. New API and worker mutations are refused while either marker exists, and generic stale-marker recovery cannot remove the exclusive marker while the persistent cutover hold is active.
- The exact four live WAL databases are snapshot with `VACUUM INTO`, encrypted independently with AES-256-GCM, and bound by a canonical HMAC manifest to tenant, campaign, source app, source volume, source revision, target app, target volume, object prefix, and fingerprints of the application and checkpoint keys.
- The bounded state-transfer script publishes an immutable commit-last object bundle, verifies it after download, restores create-only, publishes a signed recovery receipt only after target verification, and refuses key reuse or binding drift. The production workflow now checks that durable receipt before it stages delivery or model credentials or starts either target process.
- Replay verification: 97 tests pass across checkpoint storage and readability, checkpoint lifecycle, crash resume without replay, pilot execution, adaptive draft delivery, and advisory-provider idempotency.
- Repository verification: the full test command passes every workspace and all 29 script suites, including 266 script tests. Full workspace typecheck, the optimized 50-route production build, workflow YAML parsing, GA policy checks, diff integrity, and the production dependency audit all pass; the audit reports zero vulnerabilities.
- The create-only restore now rejects a missing or filesystem-aliased target parent before writing decrypted state outside the intended mounted-volume path.
- Review repair: activation now creates an ephemeral console Machine on the exact unattached target volume and re-attests all four restored databases immediately before authority staging. The gate binds the live source image and revision, source and target volume IDs, transfer ID, target app, and a receipt no older than five minutes.
- Review repair: the CLI emits exactly one compact JSON record, so the live target-volume attestation can be parsed without discarding valid multiline output.
- Review repair: unsafe rollback proof and thaw commands were removed. The old source remains authenticated and fenced; a later two-volume rollback authority must prove fresh target quiescence before any source restart can be enabled.
- Exact-head review, current-base CI, and the live cutover remain pending. No production activation occurred in this PR.

### 2026-08-25 Repair merged closure authority root

- [x] Reproduce the merged `trustedReviewers.owner` configuration failure against the runtime parser.
- [x] Derive the installed App identity in memory from the authorized local private key without printing the key or JWT.
- [x] Bind the external check to App `4718395`, the controller check to GitHub Actions App `15368`, and the exact App bot reviewer identity.
- [x] Add a regression that loads and parses the checked-in policy instead of testing only synthetic fixtures.
- [x] Run the focused authority suites, script typecheck, and diff integrity.
- [ ] Obtain exact-head review and current-base CI.
- [ ] Configure both live required checks and merge only under explicit one-time bootstrap authority because the pre-bootstrap policy cannot authorize its own repair.

#### Review

Main revision `c8d51caa` merged a reviewer key that the runtime ignores and retained null App IDs. The repair uses the verified, nonsecret identity tuple for `mendpoint-closure-authority[bot]` and the observed GitHub Actions App ID. The bot is temporarily bound under `Claude`, which permits reciprocal review of the current Codex and Cursor queue; a second distinct reviewer identity is still required before Claude-owned pull requests can satisfy the same invariant. The 26 GitHub-authority tests, 30 matrix tests, and 12 proposal-authority tests pass, the scripts TypeScript project passes, and `git diff --check` is clean.

### 2026-08-27 Permit authenticated staged-successor replacement

- [ ] Add red-first rotation tests for an exact re-stage and every forbidden tuple mutation.
- [ ] Extend `stage_successor` only for an authenticated, still-staged, unactivated successor receipt.
- [ ] Preserve the active authority, current staged tuple, and both quiet-sweep YAML files in this runtime rotation.
- [ ] Append an exhaustive runtime rotation receipt and reseal the policy and closure matrix.
- [ ] Run focused rotation, proposal, matrix, and action checks, scripts typecheck, YAML parsing, and diff integrity.
- [ ] Inspect the exact diff, commit, push, and open a draft PR without merging.

#### Review

Pending implementation and verification.
