# Warden and Transformer capability taxonomy

Researched 2026-08-06 from provider changelogs, migration guides, incident postmortems, and
large-scale-change engineering literature. This document is the source of record for expanding
the specialist eval corpus. Every category below is frequency-ranked and carries at least one
cited real-world example plus the eval scenario it becomes.

Research method: three parallel research passes, 12 or more distinct searches each, with full
deep reads of primary sources. Claims resting on a single low-authority source are marked
`[unverified]` and must not be used to justify a capability claim.

## How to read this document

Each category states what the agent must detect and change, then the eval scenario derived from
it. Difficulty ordering matters more than category count: mechanical categories are cheap
coverage, and the hard categories are where specialist capability is actually decided.

Three findings shape every scenario derived from this taxonomy:

1. **The green-test trap.** For several edge cases the naive fix passes the obvious test while
   destroying a safety property: duplicate charges, broken deduplication, disabled signature
   verification, revoked token families. Scenarios in those families must grade invariants
   (created-resource counts, verification soundness, token validity), not response success.
2. **Retry is the default wrong answer.** Reflexive retry is actively harmful in the
   non-idempotent-timeout, idempotency-semantics, rate-limit, OAuth-rotation, and
   SDK-error-wrapping families, and merely useless in the gradual-rollout and partial-outage
   families. Scenarios must penalize retry-as-repair where it is wrong.
3. **Attribution before modification.** For lying status codes, gradual rollouts, partial
   provider outages, and sandbox divergence the correct outcome is to change no client logic and
   produce evidence instead. The corpus needs scenarios whose passing answer is a diagnosis, not
   a diff.

---

## Warden: common API integration failure and breaking-change categories

### W-C1. Schema and field removals, renames, and type changes

Highest-volume category in every provider changelog reviewed. GitHub's `2026-03-10` version
removes singular `assignee` in favor of `assignees[]`, removes `merge_commit_sha` from pull
request responses, and merges `javascript` and `typescript` enum values into
`javascript-typescript`
([GitHub breaking changes](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes)).
Stripe Basil moves subscription `current_period_start` and `current_period_end` onto subscription
items ([Stripe Basil changelog](https://docs.stripe.com/changelog/basil)). Stripe SDKs changed
`decimal_string` fields from `string` to a decimal type
([stripe-node changelog](https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md)).

Agent must locate property accesses on removed or renamed fields, rewrite to the new location and
shape, update type declarations and deserializers, and handle merged enum values in branch
chains. The silent failure mode is `undefined` propagating instead of raising, so detection needs
response-shape comparison rather than error logs alone.

Scenario: repo reads `pr.merge_commit_sha` and `issue.assignee.login` pinned to an older API
version; upgrade the version header; agent must rewrite both accesses and the type interface and
pass tests against a new-shape fixture.

### W-C2. Endpoint and product sunsets

Highest severity, usually well announced. Shopify made its REST Admin API legacy as of
2024-10-01 in favor of GraphQL
([Shopify](https://shopify.dev/docs/api/admin-rest/2025-01/resources/deprecated-api-calls)).
Twilio ran concurrent end-of-life tracks for Programmable Chat and Notify with repeatedly
extended dates ([Twilio](https://www.twilio.com/en-us/changelog/programmable-chat-end-of-life-notice)).
GitHub publishes a 24-month version window and emits a `Deprecation` response header
([GitHub](https://docs.github.com/rest/overview/api-versions)).

Agent must detect base URLs, endpoints, and SDK classes belonging to a sunset product and map to
the successor, which is rarely a mechanical rename because resource models differ. `Deprecation`
and `Sunset` headers are the strongest detection signal.

Scenario: repo calls a sunset Shopify REST products endpoint; agent must produce the equivalent
GraphQL query and adapt response unwrapping.

### W-C3. Auth scheme migrations

Lower frequency, near-total blast radius. GitHub's 2021 token format change introduced prefixes
and variable length up to 255 characters, breaking fixed-length validators
([GitHub](https://github.blog/changelog/2021-03-04-authentication-token-format-updates/)).
Google blocked then removed the OAuth out-of-band flow, breaking desktop and CLI tools
([Google](https://developers.google.com/identity/protocols/oauth2/resources/oob-migration)).
Stripe explicitly reserves the right to change opaque ID formats as backward compatible, which
makes any client-side format regex a latent bug ([Stripe](https://docs.stripe.com/upgrades)).

Agent must find token-format regexes, fixed-width storage columns, out-of-band redirect URIs, and
keyless request URLs, then replace with prefix-agnostic length-tolerant handling without
weakening secret hygiene.

Scenario: repo validates tokens with a 40-hex-character regex and stores them in a fixed-width
column; agent must relax validation and widen storage while keeping redaction intact.

### W-C4. Pagination model changes

One-time but industry-wide. Shopify removed the `page` parameter across REST endpoints in favor
of `Link` header cursors, returning HTTP 400 for continued `page` use
([Shopify](https://shopify.dev/changelog/page-based-pagination-replaced-by-cursor-based-pagination-across-multiple-rest-endpoints)).
Stripe removed `total_count` expansion on list APIs, breaking clients that computed offsets from
totals ([Stripe Basil](https://docs.stripe.com/changelog/basil)).

Agent must detect page-index loops and total-over-page-size arithmetic, rewrite to cursor
iteration driven by the next link, remove parallel page fetching because cursors are serial, and
remove jump-to-page logic.

Scenario: repo loops `while (page <= totalPages)`; provider now rejects `page`; agent must convert
to cursor iteration with identical aggregate output.

### W-C5. Rate-limit behavior changes

Increasingly common as providers gate data access. Slack cut non-Marketplace app limits for
conversation history to roughly one request per minute with at most 15 objects per request
([Slack](https://api.slack.com/changelog/2025-05-terms-rate-limit-update-and-faq)).

Agent must find unguarded fetch loops, add `Retry-After`-aware backoff, comply with new page-size
ceilings, and restructure burst sync jobs into trickle jobs.

Scenario: repo backfills channel history in a tight loop with no 429 handling under an enforced
one-request-per-minute limit; agent must add correct backoff and page size while preserving
backfill completeness.

### W-C6. Error contract changes

Common as a rider on other changes and rarely announced prominently. GitHub's versioned release
changed installation deletion from 204 to 202, repository creation from 422 to 451, and workflow
dispatch from 204 to a 200 with a body
([GitHub](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes)). Stripe Basil
returns 402 on upstream timeout for the Vault and Forward API
([Stripe](https://docs.stripe.com/changelog/basil)).

Agent must find exact-status assertions and error-code branches, broaden to range checks, add new
codes, and recognize when a synchronous 204 became an asynchronous 202 requiring polling.

Scenario: repo treats success as exactly 204 and retries otherwise; provider now returns 202;
agent must fix the predicate and remove the spurious retry.

### W-C7. Transport and infrastructure requirement changes

Rare per provider, fleet-wide when it lands, and invisible to application-level monitoring
because it breaks below the application layer. AWS disabled TLS 1.0 and 1.1 across service
endpoints, breaking old .NET and JDK runtimes
([AWS](https://aws.amazon.com/blogs/security/tls-1-2-required-for-aws-endpoints/)). Twilio
deprecated region-specific API domains, breaking allowlists and SDK initialization
([Twilio](https://www.twilio.com/docs/global-infrastructure/api-domain-migration-guide)).

Agent must find pinned protocol configuration, outdated runtime targets, and hardcoded regional
hostnames, then raise the TLS floor and swap hostnames, flagging operational allowlist changes it
cannot make itself.

Scenario: project pins an obsolete TLS version and targets an old framework; provider requires
TLS 1.2; agent must retarget and prove a successful handshake.

### W-C8. Required parameter additions and request semantics changes

Providers avoid these inside a version, so they arrive bundled with regulatory or major-version
events, and then they are severe. Strong Customer Authentication forced European Stripe
integrations off the Charges API onto PaymentIntents with a mandatory client-side confirmation
step and new `requires_action` handling
([Stripe](https://docs.stripe.com/payments/payment-intents/migration)).

Agent must add required parameters and, in the hard case, restructure one-shot request code into
a multi-step state machine including new event handling.

Scenario: repo creates charges in a single server-side call; provider requires an intent flow with
an action-required branch; agent must produce the intent flow verified against fixture states.

### W-C9. Webhook and event payload version drift

A worse-detectability variant of W-C1: payload shape follows an account-level version, so
upgrading the account silently reshapes every webhook, and historical events replay in the shape
current at event time ([Stripe](https://docs.stripe.com/upgrades)).

Agent must locate handlers deserializing event payloads, pin endpoint versions explicitly,
tolerate both shapes during transition, and tolerate unknown event types, since providers class
new event types as backward compatible.

Scenario: handler reads invoice line pricing that moved in a newer version; agent must update the
handler and add unknown-event tolerance.

### W-C10. Behavioral changes with unchanged syntax

Least visible category: request and response both still work while side effects differ. Under
Stripe Basil, partially capturing a payment no longer creates a refund object, and Checkout
Sessions defer subscription creation until after payment, so code reading the subscription
immediately receives null ([Stripe Basil](https://docs.stripe.com/changelog/basil)).

This category cannot be solved by pattern search. Agent must trace downstream assumptions and
convert eager reads into event-driven reads.

Scenario: repo reads a subscription id immediately after session creation where it is now null
until completion; agent must move the read into the completion webhook and pass an end-to-end
fixture flow.

---

## Warden: edge cases, ranked by difficulty for an autonomous agent

### W-E1. Timeout on a non-idempotent operation

The operation succeeded server-side while the client saw a timeout. Naive retry converts one
invisible success into two real charges, and the agent's own verification confirms the wrong fix
because the request now returns 200
([idempotency failure analysis](https://medium.com/@harish852958/idempotency-explained-using-real-payment-system-failures-6dee7f2ff01a)).
Correct behavior queries the provider for the outcome of the ambiguous request before retrying,
classifies endpoints by retry safety, and keys idempotency per logical operation.

Adversarial scenario: mock times out on charge creation while the charge exists on read. Trap:
plain retry creates duplicates that a happy-path assertion never notices. Grade on created
resource count.

### W-E2. Idempotency key semantics changes

Key lifetime, payload fingerprinting, and whether error responses replay are all provider-defined
and mutable ([Idempotency-Key draft RFC](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)).
Naive repair regenerates the key per attempt, which makes the stale error disappear while
destroying deduplication and reintroducing W-E1.

Adversarial scenario: provider replays a cached failure for a key whose first attempt failed
transiently. Trap: randomizing the key per retry passes the test and breaks dedup. Grade on
resource count and key derivation.

### W-E3. Providers that report the wrong status code

Standard triage heuristics invert when a provider returns 200 with an error body or 500 for a
permanent client error. One router operator measured a 1 to 8 percent gap between HTTP success
and actual success across providers
([routing postmortem](https://dev.to/xujfcn/we-routed-10-million-api-calls-last-month-heres-what-broke-4i71)).
Correct behavior validates transport status, response structure, and content quality separately,
and never gates retry policy on status alone.

Adversarial scenario: provider returns 200 with an embedded rate-limit error. Trap: agent adds a
defensive null check for the missing field instead of detecting the embedded error and backing
off.

### W-E4. Webhook signature verification failures

One symptom, roughly eight root causes: body re-serialization, proxy re-encoding, wrong or stale
secret, environment mismatch, timestamp tolerance, or a real scheme change
([Svix failure modes](https://www.svix.com/blog/common-failure-modes-for-webhook-signatures/)).
Every naive repair is catastrophic but green: skip verification, widen the replay window to hours,
or sign re-serialized JSON. Correct behavior verifies raw bytes before parsing, identifies which
secret and environment the event came from, and decouples verification from slow processing rather
than widening tolerance.

Adversarial scenario: a JSON middleware change breaks verification. Trap: disabling verification
or setting a day-long tolerance passes the integration test. Grade on rejecting a replayed and a
forged event.

### W-E5. Rate-limit header format changes and retry storms

`Retry-After` legally carries either seconds or an HTTP date, proxies rename or truncate limit
headers, and parsers degrade silently
([Sentry header truncation](https://github.com/getsentry/sentry-rust/issues/1111)). Retrying
harder sustains overload; AWS documented retry amplification without jitter turning a dependency
failure into a storm
([DynamoDB postmortem](https://www.infoq.com/news/2025/11/aws-dynamodb-outage-postmortem)).
Correct behavior parses both formats, prefers server-provided delays, always adds jitter, and caps
a total retry budget.

Adversarial scenario: provider switches `Retry-After` from integer seconds to an HTTP date mid-run.
Trap: the parse yields not-a-number and the client retries with zero delay. Grade on the request
rate trace.

### W-E6. Changes behind gradual rollouts

The change reaches one cohort first, so the failure is intermittent and unreproducible from the
agent's environment, and a response-shape change never appears on a status page because it is not
an availability incident. Correct behavior correlates onset with cohort rather than deploy, diffs a
failing against a passing response, pins the API version, and writes shape-tolerant parsers.

Adversarial scenario: 10 percent of responses use a renamed field. Trap: classifying it as
flakiness and adding a retry that passes 90 percent of the time.

### W-E7. Partial provider outages that mimic client bugs

A component is degraded while the status page reads operational, so the agent searches the client
codebase for a bug that does not exist, and the incident self-resolves, reinforcing the wrong fix
([diagnosis guide](https://statusfield.com/blog/2026-06-23-how-to-diagnose-api-failures)).
Correct behavior reproduces from another network, checks component-level status, measures error
rate over time for a step-function onset, and changes no client logic.

Adversarial scenario: provider fails a quarter of requests from one region while reporting healthy.
Trap: modifying correct serialization code. Passing requires leaving client logic untouched and
producing attribution evidence plus failover.

### W-E8. Eventual consistency and read-after-write changes

A write succeeds and an immediate read misses, intermittently. Every naive repair is wrong
differently: fixed sleeps are flaky and mask the model, retry-until-found spins forever on
genuinely absent objects, and local caching diverges from truth. Consistency models also change
underneath: S3 became strongly read-after-write consistent in 2020 while cross-region replication
stayed eventual
([AWS](https://aws.amazon.com/about-aws/whats-new/2020/12/amazon-s3-now-delivers-strong-read-after-write-consistency-automatically-for-all-applications)).
Correct behavior uses the documented model for that endpoint, prefers versioned or conditional
reads, bounds polling with a deadline, and treats not-yet-visible as distinct from absent.

Adversarial scenario: reads miss for about two seconds after a successful write, plus a second case
where the object never exists. Trap: a fixed sleep passes the first case; an unbounded poll hangs on
the second.

### W-E9. Multi-step flows where an earlier step's contract changed

The error surfaces at a later step, far from the change. Refresh-token semantics diverge by
provider, and with rotation enabled, reusing an old refresh token revokes the whole token family
([token refresh at scale](https://www.useparagon.com/blog/oauth-token-refresh-expiry-at-scale)).
Naive retry is not merely useless, it locks the integration out. Correct behavior reconstructs the
flow as a state machine, inspects the earlier step's most recent response for drift, and stores
tokens atomically with single-flight refresh.

Adversarial scenario: provider switches to rotating refresh tokens mid-run. Trap: retrying refresh
with the stored token revokes the family and hard-fails the account.

### W-E10. Sandbox and production divergence

The only safe test environment differs from production by design: separate secrets and object ids,
identity checks that always pass, fraud rules that never fire, sensitive fields omitted
([Stripe testing](https://docs.stripe.com/testing-use-cases)). A fix verified green in sandbox can
be exactly what fails in production. Correct behavior inventories environment-scoped values and
treats sandbox green as strong evidence rather than proof for money and fraud paths.

Adversarial scenario: the bug reproduces only in the live-mode mock. Trap: iterating in sandbox and
declaring success while an environment-scoped secret or price id stays hardcoded.

### W-E11. Data-level encoding, timezone, and locale edges

Everything returns 200 while values are subtly wrong. Jira requires basic ISO-8601 offsets while
common standard-library serializers emit extended offsets, so every datetime write fails
([issue](https://github.com/sooperset/mcp-atlassian/issues/863)); three-byte UTF-8 columns silently
drop emoji-bearing rows. Correct behavior fixes the serialization boundary and adds round-trip
property tests rather than patching one observed character or call site.

Adversarial scenario: API rejects colon-bearing offsets. Trap: a string replacement at one call
site while other sites and daylight-saving boundaries stay broken.

### W-E12. Misleading SDK error wrapping

The SDK swallows, re-types, or mislabels the real failure, and may already be retrying internally
([AWS SDK swallowed exception](https://github.com/aws/aws-sdk-java-v2/issues/3652)). Correct
behavior drops below the SDK to the wire, extracts the original error and request id, and audits
built-in retry configuration before adding any application-level retry, since two retry layers
multiply side effects.

Adversarial scenario: SDK reports a retryable connection error for what is actually a validation
rejection whose body was discarded. Trap: adding backoff for a permanent error.

---

## Transformer: common migration campaign patterns

### T-C1. Major version upgrade that changes API shape

The AWS JavaScript SDK v2 to v3 upgrade is the archetype: method calls become command objects,
the error `code` property becomes `name`, multipart upload moves to a separate package
([lessons learned](https://cloudonaut.io/migrating-to-aws-sdk-js-v3-lessons-learned/)). Agent must
inventory call sites including indirect wrappers, map services to modular packages, transform call
shape, rewrite error branches that dynamic languages will not flag, and verify against integration
mocks rather than compilation alone.

Scenario: repo using streams, a document client, and error-code branching; end state has no old
dependency and passing tests; trap is an error-code branch that silently never fires.

### T-C2. Framework upgrade with official codemods plus manual residue

Next.js 15 made request APIs asynchronous with an official codemod, and separately flipped fetch
caching from on to off by default, which is a compile-clean performance and cost regression
([Next.js 15](https://nextjs.org/blog/next-15)). Agent must treat codemod output as a baseline,
chase async propagation up the call chain, and pin previously implicit defaults explicitly.

Scenario: sync request params destructured through two helper levels plus a page relying on default
caching; trap is that everything compiles while the page refetches every request.

### T-C3. Callback to promise modernization

Bundled into most SDK upgrades. The risk is behavioral: a callback branch that deliberately ignored
an error becomes a crashing rejection. Agent must preserve error-path side effects exactly and must
not reorder side-effecting sequential calls.

Scenario: callback code that intentionally swallows one error; trap is the migrated version throwing
where the original continued.

### T-C4. Import and namespace restructure into modular packages

Common across AWS v3, Firebase v9, and lodash-style splits, and mostly mechanical
([AWS migration guide](https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/migrate.html)).
Agent must build a symbol-to-package map, rewrite imports with manifest and lockfile atomically,
hunt barrel files and re-exports that keep the old dependency alive, and verify module-format
interoperation.

Scenario: an internal barrel module re-exports the whole old SDK to twenty consumers; trap is the
barrel keeping both SDKs installed and doubling bundle size.

### T-C5. Typed SDK upgrades with hidden API-version pinning

The compiler finds most sites, which is a large agent advantage, but pinning is invisible to it:
stripe-node v12 began sending a pinned version header, so a package upgrade silently changes which
REST version requests hit
([migration guide](https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v12)). Agent must
fix all type errors and separately audit the pinned-version delta for server-side payload changes.

Scenario: webhook handlers reading a field renamed in a later API version; trap is a clean
typecheck with production webhooks breaking.

### T-C6. Generated client regeneration and spec drift

Two drift axes, the spec and the generator, and generator majors restructure output
([OpenAPI Generator migration guide](https://github.com/OpenAPITools/openapi-generator/blob/master/docs/migration-guide.adoc)).
Agent must classify spec changes before regenerating, never hand-edit generated output, detect prior
hand-edits by regenerating the old spec and diffing, pin the generator version, and contract-test.

Scenario: someone hand-patched a retry wrapper into a generated file; trap is regeneration silently
deleting it.

### T-C7. Auth flow migration inside an SDK

High stakes and rarely a rename: replacement auth libraries ship side by side precisely because
in-place breaking changes were untenable, and serialized credential objects are format-incompatible
across libraries
([oauth2client deprecation](https://google-auth.readthedocs.io/en/latest/oauth2client-deprecation.html)).
Agent must inventory credential creation, storage, refresh, and injection, verify refresh under
expiry rather than first call, and escalate forced re-authentication as a product decision.

Scenario: app stores serialized credentials on disk; trap is clean code migration where every
existing user's stored credential fails to deserialize.

### T-C8. Peer dependency and lockfile conflict resolution

Near-universal since strict peer resolution. Individually easy, hard in aggregate because one
conflict cascades into a version family
([resolution strategies](https://oneuptime.com/blog/post/2026-01-22-nodejs-fix-npm-peer-dependency-conflicts/view)).
Agent must parse the full conflict chain, prefer upgrading the constraining package over legacy
peer flags, align the family in one commit, and verify no invalid nodes remain.

Scenario: three packages peer-pin differently across a framework major; trap is a legacy peer flag
making install succeed while leaving a runtime-incompatible library.

### T-C9. Deprecation-driven incremental migration with a backslide ratchet

The standard low-risk shape; the difficulty is preventing regression while the campaign runs.
Google flags new introductions of deprecated symbols at review time so completed changes do not
backslide ([Software Engineering at Google, chapter 22](https://abseil.io/resources/swe-book/html/ch22.html)).
Agent must land the ban on new usage before burning down old usage, then remove the shim at zero.

Scenario: forty existing uses with concurrent branches adding more; passing requires the ratchet,
not just the fixes.

### T-C10. Whole-codebase campaigns via pipeline and retry

The best-documented template for agent campaigns. Airbnb migrated thousands of test files in weeks
using a per-file state machine with objective validation gates, escalating retries with related-file
context, and structured markers for unfixable sites, handing humans the best failed attempt rather
than a blank file
([Airbnb test migration](https://medium.com/airbnb-engineering/accelerating-large-scale-test-migration-with-llms-9565c208023b),
[ts-migrate](https://medium.com/airbnb-engineering/ts-migrate-a-tool-for-migrating-to-typescript-at-scale-cd23bfeb5cc)).

Scenario: mixed-complexity files where two require imported-helper context; passing requires pulling
in related files rather than retrying blindly.

---

## Transformer: edge cases, ranked by likelihood of defeating an agent

### T-E1. Silent runtime behavior changes that compile clean

No compiler error and no test failure unless a test asserts the specific behavior, so the usual
compile-and-test loop reports false success. Examples include a caching default flip, a client
library's connection pool and retry revamp forcing version pins
([redis-py](https://github.com/redis/redis-py/issues/3008)), and date-format token differences where
a week-year token silently yields the wrong year. Agent must produce an old-versus-new defaults
table, pin previously implicit behavior, and add characterization tests before migrating.

Scenario: date formatting across a year boundary; trap is a token-for-token copy that renders the
wrong year with no error. `[unverified]` for the specific daylight-saving comparison source.

### T-E2. Static tooling missing dynamic usage

The site inventory itself is incomplete while the agent believes it is finished. Google's pointer
migration hit uses in generated code that tooling could not detect
([chapter 22](https://abseil.io/resources/swe-book/html/ch22.html)), and codemod families cannot
transform dynamically constructed imports. Agent must follow any syntax-tree transform with a
textual sweep across all file types including configuration and container files, grep reflection
idioms, and regenerate code generators' outputs. Completion means zero matches of the old idiom
everywhere, not a clean codemod run.

Scenario: a module builds an import path from a variable and the old package name appears in test
configuration; trap is passing tests with a runtime crash on the dynamic path.

### T-E3. Monorepo migration with mixed versions in transition

Atomic movement is impossible at scale, so the intermediate state must itself be legal with two
majors coexisting and shared internal libraries consumed by both sides. Agent must migrate
leaf-first along the dependency graph, decide whether the dual-version state is even installable
under peer constraints, shard so every intermediate commit is green, and use forwarding wrappers for
shared libraries.

Scenario: a shared library consumed by one migrated and one unmigrated app; trap is upgrading the
shared library first and breaking the unmigrated consumer.

### T-E4. Resumed partial migration

The agent inherits two idioms, half-dead compatibility layers, and no record of intent, and
file-level done markers lie. The documented strangler failure mode is that temporary adapters are
never deleted, leaving a permanent half-migrated border
([strangler fig](https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig)).
Agent must census both idioms, make transforms idempotent, keep a machine-readable progress ledger,
and schedule shim deletion with a no-importers verification.

Scenario: a repo majority-migrated with a legacy adapter still imported by files marked migrated;
the true completion check counts adapter importers.

### T-E5. Flaky tests masking migration regressions

The primary verification signal is corrupted in both directions, and retry-to-green launders real
failures ([flaky tests in CI](https://edgedelta.com/company/knowledge-center/flaky-tests-ci-cd-pipelines)).
Agent must baseline the flaky set on the untouched repo, count only new failures against the
migration, never raise retry counts to get green, and report a migration that turns a stable test
flaky as a real regression.

Scenario: one pre-existing flaky test plus a genuine intermittent regression from a changed default
timeout; trap is a single run plus retries shipping the regression.

### T-E6. Long campaign against an active repository

Textual conflicts are visible; semantic conflicts merge cleanly and break later, and cost grows
non-linearly with branch lifetime. Google regenerates stale shards rather than hand-rebasing them
([chapter 22](https://abseil.io/resources/swe-book/html/ch22.html)). Agent must shard into
independently landable changes, regenerate conflicted shards from fresh trunk, land the ratchet
early, and re-inventory after each shard.

Scenario: a concurrent commit renames a target file and adds a new old-idiom file mid-campaign;
trap is rebasing a stale long branch and missing the new site.

### T-E7. Vendored and patched dependencies

A patch encodes an undocumented local requirement, and upgrading invalidates it; package managers
have silently dropped patch declarations across versions
([pnpm issue](https://github.com/pnpm/pnpm/issues/9226)). Agent must find patch directories,
overrides, and vendored trees before upgrading, read each diff, determine whether the fix landed
upstream, re-port or delete with justification, and never leave a patch that fails to apply.

Scenario: a patch whose fix landed upstream under a different configuration name; deleting loses
behavior and blind re-porting fails to apply.

### T-E8. Transitive version traps and duplicate copies

The lockfile says one thing and the runtime module graph another, so failures such as identity
checks across two copies of a singleton appear far from the upgrade
([bundle duplicates](https://www.atlassian.com/blog/atlassian-engineering/performance-in-jira-front-end-solving-bundle-duplicates-with-webpack-and-yarn)).
Agent must assert exactly one copy of singleton packages after any upgrade, force transitive
alignment when a middle dependency pins old, and check bundle analysis rather than the manifest.

Scenario: a direct dependency transitively pins an older singleton; install succeeds and unit tests
pass while a runtime identity check fails.

### T-E9. Untested legacy modules

The blocker is missing safety infrastructure rather than the transform, and Google names these
haunted graveyards where the only cure is testing
([chapter 22](https://abseil.io/resources/swe-book/html/ch22.html)). Agent must map coverage before
sharding, write characterization tests for uncovered modules on the path, sequence covered modules
first, and escalate genuinely untestable modules with a risk note instead of migrating silently.

Scenario: one module with zero tests doing date arithmetic; the required end state includes new
characterization tests.

### T-E10. Generator drift compounding spec drift

Regeneration mixes spec changes, generator changes, and prior hand-edits into one unreviewable
blob. Agent must isolate the variables in three steps, old spec with old generator to detect
hand-edits, old spec with new generator for the generator delta, then the new spec, committing each
separately and adding a check that fails on hand-modified generated output.

Scenario: a hand-edited generated client plus both a spec and generator bump; trap is a single-shot
regeneration that destroys the edit and produces an unreviewable diff.

---

## Corpus implications

Priority order for scenario authoring, highest capability gain first:

1. Diagnosis-only scenarios where the passing answer changes no client logic. The corpus currently
   has none, and four Warden edge families require exactly this.
2. Invariant-graded scenarios for the green-test-trap families, graded on resource counts,
   verification soundness, and token validity rather than response success.
3. Retry-penalty scenarios across the five families where retry actively harms.
4. Silent-behavior scenarios for both agents, where compilation and tests pass while behavior
   changed, graded on characterization output.
5. Completion-criterion scenarios for Transformer, graded on inventory exhaustion including dynamic
   usage, adapter importers, and module-graph duplication rather than transform success.

Verification hierarchy to apply when grading: compilation is weakest, then unit tests, then
characterization and golden output, then a defaults diff audit. The hardest categories are only
caught at the last two levels.

Claims marked `[unverified]` in the research passes, including specific developer-survey
percentages, vendor-reported migration multipliers, and one date-library comparison, must not be
cited as evidence for any capability claim in product material.
