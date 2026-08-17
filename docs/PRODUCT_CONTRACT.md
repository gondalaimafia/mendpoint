# Mendpoint Product Contract

Version: 1.0  
Effective date: 2026-08-01  
Authority: `product/mendpoint-product-platform-specification.md` (v2.0, canonical as of 2026-08-17; see `adr/0001-canonical-product-specification.md`)

This contract resolves the foundational specification decisions that must be
stable before implementation can be treated as release evidence. The machine
checked register is `PRODUCT_REQUIREMENTS.json`; its validator is
`packages/contract/src/product-requirements.ts`.

## Release tiers

### Fettler pilot

GitHub is the only required source control system. A private canary must move
from an attributable tenant connection and exact commit snapshot to a verified
draft pull request. Every delivered change requires source evidence, policy,
baseline and post edit verification, an identified reviewer, rollback, and a
complete event history. Single node self hosted deployment is supported for the
pilot. Fixture evidence does not count as customer proof.

### Fettler GA

Adds reliable multi provider monitoring, durable campaigns, measured accuracy
and abstention, production availability and recovery objectives, repeatable
onboarding, and two external outcome cohorts. GitLab is a Fettler GA requirement
unless a signed design partner makes it a pilot dependency.

### Regauge pilot

Supports one declared migration class across two to five repositories. An
objective produces a durable reviewed blueprint and nonempty behavioral
specification graph before execution. At least three repositories receive
distinct verified draft pull requests in dependency order. Crash, CI failure,
branch drift, partial merge, restart, and rollback drills must pass.

### Regauge GA

Adds multiple executable recipe families, organization scale campaign control,
shared model routing, governed outcome data, measured migration quality,
repeatable recovery, and production cost controls. Customer data training is
not included until explicit consent, lineage, deletion, residency, data
sufficiency, held out evaluation, promotion, monitoring, and rollback gates
pass.

### Enterprise

Adds supported VPC deployment, private connectivity, SSO, SCIM, customer
managed keys, residency, horizontal reliability, enterprise disaster recovery,
customer log export, compliance evidence, and security review support. VPC is
not a Fettler pilot or GA claim.

## Scope decisions

1. GitHub is the Fettler pilot source control system. GitLab belongs to Fettler
   GA unless a signed pilot contract requires it sooner.
2. Regauge pilot and Regauge GA are independent release gates. A
   validated planner is not an executable campaign.
3. Routing contracts and telemetry may ship before model adapters. Training on
   customer data may not start until the Gate 8 data prerequisites pass.
4. Single node self hosted operation is a pilot deployment mode. VPC is an
   enterprise tier with separate acceptance evidence.
5. Every product requirement has exactly one release tier in the requirement
   register. Later tier assignment is an explicit product decision, not proof
   that the capability exists.

## State machines

All transitions require tenant, actor, correlation, causation, time, previous
version, new version, and evidence references. Terminal state changes append a
new event and never rewrite prior evidence.

| Object | States | Required transition rules |
|---|---|---|
| Source artifact | received, validating, accepted, rejected, superseded, deleted | Content hash is idempotent per tenant and source. Rejection records validation evidence. Deletion preserves a tombstone and retention decision. |
| Change | provisional, reviewed, approved, active, superseded, withdrawn | Only accepted source artifacts may create a change. Manual and incident derived changes require an identified reviewer before fanout. |
| Repository snapshot | requested, fetching, ready, failed, expired, deleted | Ready snapshots are immutable and identify SCM, repository, branch, exact commit, fetch policy, and content hash. Execution cannot use expired or drifting snapshots. |
| Impact | proposed, confirmed, rejected, superseded | Every finding identifies source evidence, snapshot, file, symbol when available, method, confidence, and reviewer outcome. |
| Candidate edit | proposed, verifying, verified, failed, superseded, waived | Candidate content is immutable. Regeneration creates a successor. Delivery requires verified or a scoped unexpired waiver. |
| Verification | queued, running, passed, failed, cancelled, waived | Baseline and post edit runs are distinct. Commands, environment, artifacts, duration, exit status, and introduced failures are retained. |
| Pull request | planned, delivering, draft, review, approved, changes requested, merged, closed, failed | Delivery references one immutable candidate and verification package. SCM webhooks reconcile state idempotently. |
| Review | assigned, in review, approved, rejected, changes requested, waived, expired | Actor identity, comment, target version, reason, scope, and expiry are required where applicable. |
| Job | queued, leased, running, succeeded, failed, retry scheduled, cancelled, dead letter | Lease generation fences stale workers. Idempotency and retry budget are mandatory. |
| Campaign | draft, blueprint review, approved, running, paused, blocked, rolling back, completed, failed, cancelled | Units advance by dependency and approval policy. Exceptions name an owner and due action. Rollback runs in reverse dependency order. |
| Usage | reserved, settled, adjusted, credited, voided | Entries are append only, idempotent, price versioned, attributable to a task, and independently reconcilable. |

## Metric dictionary

| Metric | Start | End | Denominator and exclusions | Window and attribution |
|---|---|---|---|---|
| Fettler change to first verified pull request | Earliest accepted trusted source observation | First delivered draft pull request with passing post edit verification | One value per change and tenant cohort. Exclude rejected and duplicate sources. | Event time, reported daily and by 30 day cohort. |
| Fettler impact precision | Reviewed confirmed impact | Reviewed proposed impact | Confirmed divided by all reviewed findings. Exclude unresolved findings. | By provider, change class, language, repository size, and 30 day cohort. |
| Fettler impact recall | Reviewed confirmed affected sites found | All reviewed known affected sites | Found confirmed sites divided by the reviewed gold set. | Same cohort dimensions as precision. |
| Pull request acceptance | Approved or merged delivered pull requests | Reviewed delivered pull requests | Exclude unresolved review. Closed without review is not automatically a false positive. | 30 and 90 day cohorts by provider and recipe. |
| Reviewer edit delta | Delivered candidate | Accepted patch | Semantic changed operations divided by delivered operations. Text formatting only changes are excluded. | Per pull request and aggregated by recipe and route. |
| Regression rate | Accepted Mendpoint change | Introduced CI failure, rollback, or attributed incident | Accepted changes with a regression divided by accepted changes. | 30 days after merge, with explicit attribution evidence. |
| Hours saved | Agreed manual baseline | Observed review and exception time | Baseline minus observed time. Never infer a baseline without customer agreement. | Per pilot and campaign. |
| Regauge campaign completion | Approved units | Units satisfying terminal success policy | Successful approved units divided by all approved units. Cancelled scope changes are reported separately. | Per campaign and migration class. |
| Regauge batch acceptance | Approved or merged pull requests | Reviewed pull requests | Exclude unresolved reviews. | Per wave, recipe, and 30 day cohort. |
| Time to first accepted Regauge pull request | Blueprint approval | First campaign pull request approved or merged | One value per campaign. | Event time. |
| Recovery effectiveness | Recorded interruption | Resumed progress without duplicate mutation | Successful recoveries divided by injected and observed recoverable interruptions. | Per release and rolling 30 days. |
| Router verified quality | Routed task start | Passing verification plus accepted human outcome | Accepted verified outcomes divided by completed routed tasks. Infrastructure failures are separate. | By task class, route, executor, model, and price version. |
| Router accepted output cost | First route attempt | Accepted verified outcome | All actual attempts, retries, and fallbacks divided by accepted outcomes. | By route and 30 day cohort. |
| MCU consumption | Usage reservation | Final settlement and adjustments | Sum of settled units. Credits and voids are separate ledger entries. | By tenant, campaign, task, invoice, and price version. |
| Gross margin | Recognized migration revenue | Reconciled execution cost | Revenue minus model, compute, graph, sandbox, storage, and verification cost. | By customer, campaign, task class, and month. |

Every metric event must include a schema version, tenant, actor or service
principal, correlation ID, source object, event time, ingestion time, and data
quality status. A metric with missing boundaries or unresolved attribution is
reported as incomplete rather than estimated.

## Performance workloads

| Tier | Repository workload | Concurrency | First result objective | Complete scan objective | Verification objective |
|---|---|---:|---:|---:|---:|
| Small | Up to 100 thousand source lines, one language, up to 2 thousand files | 2 jobs per tenant | p50 30 seconds, p95 90 seconds, p99 180 seconds | p50 2 minutes, p95 5 minutes, p99 8 minutes | p50 5 minutes, p95 15 minutes, p99 25 minutes |
| Medium | Up to 1 million source lines, up to three languages, up to 20 thousand files | 4 jobs per tenant | p50 90 seconds, p95 4 minutes, p99 8 minutes | p50 10 minutes, p95 25 minutes, p99 40 minutes | p50 15 minutes, p95 40 minutes, p99 60 minutes |
| Large | Up to 5 million source lines, up to six languages, up to 100 thousand files | 8 jobs per tenant | p50 4 minutes, p95 10 minutes, p99 20 minutes | p50 35 minutes, p95 75 minutes, p99 120 minutes | p50 45 minutes, p95 120 minutes, p99 180 minutes |

Objectives are measured on supported reference infrastructure with warm and
cold results reported separately. Queue time, source control transfer, graph
construction, model work, verification, and delivery are separate spans. A
release cannot claim a tier until load and soak evidence exists for it.

## Migration compute unit version 1

One MCU is a normalized accounting unit, not a token. Version 1 settles as:

`MCU = graph work + retrieval work + model work + sandbox work + verification work`

Component rules:

| Component | MCU rule |
|---|---:|
| Graph nodes and edges processed | 1 MCU per 10 thousand objects, rounded up per task |
| Retrieval bytes read | 1 MCU per 10 megabytes, rounded up per task |
| Model input | Actual provider cost converted at the active price version, with 1 MCU equal to USD 0.01 of reference cost |
| Model output | Same price conversion as model input |
| Sandbox execution | 1 MCU per vCPU minute plus 1 MCU per 2 GiB minute |
| Verification execution | Same compute rule as sandbox plus 1 MCU per retained 100 megabytes of artifacts |

Reservations use the maximum allowed task budget. Settlement records actual
component quantities and the exact formula and price version. Unused reserves
are released. Corrections, credits, and voids append new entries. No historical
entry is recalculated when weights or prices change. Invoice lines reference
settled entry IDs and can be independently reproduced.

This formula is an engineering accounting baseline. It is not customer pricing
until finance approves a price contract and reconciliation evidence.

## Learning and data governance

Learning is tenant isolated by default. Shared learning requires explicit opt
in from an authorized tenant actor and a recorded purpose, data classes,
retention period, allowed regions, allowed model families, and deletion terms.
Every training record retains source tenant, source object, consent version,
redaction result, provenance, license, dataset version, access history, and
deletion state. Secrets, credentials, personal data, customer proprietary text,
and disallowed licenses are rejected or redacted before dataset admission.

Dataset splits are temporal and tenant aware. Near duplicates and descendants
cannot cross train and held out boundaries. Deletion produces a tombstone,
removes future serving and training eligibility, and triggers artifact impact
review. Promotion requires held out execution verification, security evaluation,
shadow, canary, monitoring, and proven rollback. No production adapter claim is
allowed before these controls and the data sufficiency gate pass.

## Open product decisions

1. Which signed design partner, repository cohort, and supported payments
   change will satisfy the Fettler external proof gate.
2. Whether GitLab remains Fettler GA or moves earlier under a signed customer
   dependency.
3. Which two to five repositories and source to target range define the first
   Regauge migration class.
4. Which payment processor or invoice export path, tax policy, and finance
   owner will make MCU settlements billable.
5. Which identity provider tenant will prove OIDC, SAML, and SCIM acceptance.
6. Which cloud and region define the first VPC reference architecture.
7. Which independent assessor and scope define penetration and SOC 2 evidence.

These decisions are external gates. Fixture accounts and synthetic acceptance
records do not close them.
