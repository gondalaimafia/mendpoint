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
