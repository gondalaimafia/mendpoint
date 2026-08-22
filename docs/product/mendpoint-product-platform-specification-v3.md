# Mendpoint Product and Platform Specification

## Development foundation

**Product:** Mendpoint  
**Canonical products:** Fettler and ReGauge  
**Document type:** Product requirements document, platform specification, technical architecture baseline, and development contract  
**Version:** 3.0  
**Status:** Development foundation  
**Last updated:** 2026-08-17  
**Primary audience:** Founder, product, engineering, design, forward deployed engineering, security, GTM, design partners, and future technical diligence  
**Supersedes:** Mendpoint Product and Platform Specification v2.0 as the development baseline


---

## Version 3.0 architectural refinement

Version 3.0 preserves the v2 product boundaries and strengthens the architecture around five decisions that now form the development baseline:

1. **Representation-first intelligence.** The Mendpoint Change Graph is the canonical durable representation of software relationships. Models SHOULD reason over bounded graph projections rather than repeatedly reconstructing known relationships from raw files, schemas, search results, or long prompts.
2. **Resolve once, traverse many times.** High-value relationships SHOULD be entity-resolved and materialized during offline or incremental graph construction when they can be validated, versioned, and reused safely.
3. **Explicit epistemic state.** Graph edges, coverage, staleness, conflict, and provenance are first-class product data. `NO IMPACT FOUND` and `NO IMPACT FOUND WITH INSUFFICIENT COVERAGE` are different product outcomes.
4. **Selective intelligence ownership.** Mendpoint SHOULD own migration-specific intelligence where proprietary data, quality, latency, or economics justify it while retaining rented general reasoning where external models remain superior.
5. **Independent soft verification.** Deterministic verification remains authoritative. Probabilistic model-based verification MAY improve selection and calibration but MUST remain a soft signal beneath tests, graph invariants, runtime evidence, and human decisions.

These refinements are informed by external empirical work on graph-based agentic retrieval, but external benchmark results are not Mendpoint product claims. Mendpoint MUST validate the representation thesis on its own synthetic and production-like migration benchmarks before relying on it for support or economic claims.

---

# 0. How to use this document

This document is the canonical product and platform specification for future Mendpoint development unless superseded by an approved architecture decision record, product decision, or newer version of this specification.

The previous product specification established the core thesis, the Fettler/ReGauge product split, graph-scoped reasoning, review-first execution, hybrid model orchestration, migration data as a compounding asset, and the land-and-expand product strategy. Version 3.0 preserves those decisions and further formalizes the representation, graph epistemics, intelligence-ownership, and independent-verification contracts required to build, evaluate, operate, and evolve the platform coherently.

Where this document introduces detail that was not explicit in the previous draft, it should be treated as a **development baseline**, not as a claim about what is already implemented. Existing production behavior remains the implementation source of truth until intentionally migrated.

## 0.1 Normative language

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are used deliberately:

- **MUST / MUST NOT** define platform invariants or release-blocking behavior.
- **SHOULD / SHOULD NOT** define the preferred implementation unless evidence justifies an exception.
- **MAY** identifies optional or context-dependent behavior.

## 0.2 Canonical naming

The canonical product names are:

- **Fettler** — external-change detection, impact analysis, and remediation.
- **ReGauge** — internal modernization, legacy migration, and staged transformation campaigns.

Historical identifiers such as `Warden` or `Transformer` may still exist in code, schemas, migrations, telemetry, or APIs. They MUST NOT be blindly renamed where doing so would break persistence or compatibility. New customer-facing product language, new documentation, and new product-level abstractions MUST use Fettler and ReGauge.

## 0.3 Product invariants

These invariants define Mendpoint more strongly than any individual feature:

1. **Migration-specific, not general-purpose.** Mendpoint exists to understand, plan, execute, verify, and govern code change adoption and migration work.
2. **Graph-scoped.** Material recommendations MUST be grounded in an explicit representation of affected systems, code, dependencies, and evidence.
3. **Review-first.** Mendpoint MUST NOT silently merge or deploy production changes as the default product behavior.
4. **Evidence-backed.** Every material finding, recommendation, and edit SHOULD be traceable to source evidence and verification.
5. **Risk-aware.** Higher-blast-radius and lower-confidence work MUST receive stronger verification, model escalation, or human review.
6. **Model-neutral.** No product capability may depend conceptually on one model provider remaining best in class.
7. **Reproducible.** Important decisions, graph states, model selections, edits, and verification results MUST be replayable or reconstructable to a practical degree.
8. **Governed learning.** Customer and synthetic outcomes MAY improve Mendpoint, but learning MUST respect provenance, consent, tenant isolation, residency, evaluation holdouts, and promotion controls.
9. **No benchmark gaming.** Evaluation failures MUST drive generalized capability fixes rather than scenario-specific exceptions.
10. **Economic discipline.** Quality is the primary constraint, but latency, model cost, verification cost, and frontier-model escalation are first-class product metrics.
11. **Representation-first.** High-cardinality, dynamic instance relationships SHOULD live in the Change Graph or another governed data layer, not in prompts or model memory. Models MUST NOT be expected to infer missing instance relationships that the platform could resolve and materialize deterministically or evidentially.
12. **Selective intelligence ownership.** Mendpoint SHOULD own migration-specific intelligence when evals demonstrate a quality, latency, privacy, control, or economic advantage and SHOULD rent general intelligence when renting remains superior.

---

# 1. Executive summary

Mendpoint is an AI-native migration platform that turns software change into safe, reviewable migration work.

It has two tightly connected products:

## Fettler

Fettler monitors and interprets changes originating outside the customer's codebase, including API changes, SDK releases, contract changes, deprecations, release notes, and provider migration requirements. It maps those changes to affected customer code, determines blast radius, proposes precise remediation, verifies the remediation, and packages the result as reviewable engineering work.

Its core loop is:

```text
external change
→ normalize
→ understand semantic impact
→ map to customer code
→ generate remediation
→ verify
→ explain
→ open reviewable PR
→ learn from outcome
```

## ReGauge

ReGauge handles changes originating from the customer's modernization intent: framework upgrades, runtime migrations, SDK rewrites, internal standardization, architecture migrations, and legacy transformation programs. It reconstructs the relevant system, identifies constraints and dependencies, creates a staged plan, executes migration work incrementally, verifies each stage, and tracks exceptions and campaign progress.

Its core loop is:

```text
modernization objective
→ reconstruct system
→ identify constraints and dependencies
→ plan stages
→ execute bounded changes
→ verify
→ review
→ advance campaign
→ learn from outcome
```

## Shared platform

Fettler and ReGauge share one intelligence and execution platform:

```text
integrations
+ change normalization
+ Mendpoint Change Graph and entity-resolution layer
+ evidence, provenance, coverage, and temporal model
+ context compiler and task decomposition
+ model/router layer
+ deterministic tools and recipes
+ code execution and verification
+ review workflow
+ policy/governance
+ evaluation
+ learning flywheel
+ observability
```

The platform thesis is that migration should stop being ad hoc project work and become an operating capability: observable, scoped, explainable, repeatable, and increasingly automated without sacrificing review or trust.

---

# 2. Problem definition

Software changes continuously while the systems depending on it do not update themselves.

The failure appears in two directions.

## 2.1 External change debt

Providers change APIs, SDKs, contracts, authentication requirements, schemas, semantics, and supported versions. Customers often discover the consequences late because:

- release notes are not mapped to actual call sites;
- OpenAPI or SDK diffs do not express business impact by themselves;
- deprecations remain live long after notification;
- behavior changes may compile while still being operationally wrong;
- package upgrade tooling catches version changes but not provider semantics;
- platform teams cannot manually assess every repository every time a provider changes;
- general coding agents require humans to first discover, scope, and explain the migration.

Fettler addresses this problem.

## 2.2 Internal migration debt

Organizations also accumulate internal migration work:

- runtimes fall behind;
- frameworks become unsupported;
- internal SDKs evolve;
- architecture standards change;
- authentication and security conventions shift;
- business logic becomes entangled with infrastructure;
- monoliths and service ecosystems accumulate undocumented dependencies;
- modernization programs become too large to execute safely as one project.

ReGauge addresses this problem.

## 2.3 Why existing categories are incomplete

Mendpoint sits between several existing tool categories without reducing to any one of them:

- API management tools govern APIs but generally do not repair downstream customer code.
- Dependency bots update versions but generally do not understand semantic provider changes or organization-specific migration intent.
- Static analysis tools identify patterns but generally do not own migration planning and verified remediation.
- General coding agents can edit code but do not inherently provide migration-specific graph scoping, campaign semantics, evidence, risk controls, outcome learning, or provider change ingestion.
- Consulting and manual migration programs can handle complexity but do not compound software intelligence across repeated migrations.

Mendpoint's category is therefore best described as a **migration operating layer** or **migration platform**.

---

# 3. Product vision and north star

## 3.1 Vision

Mendpoint becomes the system of record and execution layer for code change adoption.

In the target state:

- Fettler is the trusted interface between external platform change and customer code.
- ReGauge is the trusted interface between modernization intent and large-scale internal code evolution.
- Every migration has an explicit scope, graph, evidence trail, plan, review path, verification history, and measurable outcome.
- Organizations can answer what must change, why, where, in what order, with what risk, and whether the change actually succeeded.
- Repeated migrations improve Mendpoint's graph intelligence, recipes, router policy, verification heuristics, and specialized models.
- Frontier models are used where their reasoning quality is justified, not as an undifferentiated default for every token.
- Migration knowledge becomes an institutional asset rather than disappearing into one-off project history.

## 3.2 North-star outcome

The north-star product outcome is:

> **A required software migration can move from detected or declared change to verified, reviewable, correctly scoped code updates with materially less human discovery, coordination, and implementation effort than the incumbent process.**

## 3.3 Product success is not code generation

Mendpoint is successful only when generated migration work is:

- correctly scoped;
- technically correct;
- verifiable;
- understandable to reviewers;
- safe relative to its blast radius;
- easy to accept or correct;
- operationally useful;
- cheaper and faster than the manual alternative;
- a source of reliable learning for the next migration.

Generating a patch is an intermediate step, not the end state.

---

# 4. Product boundaries

## 4.1 In scope

Mendpoint is in scope when the work can be represented as a migration or change-adoption problem.

Examples:

- third-party API changes;
- SDK and library migrations;
- API deprecations;
- provider capability adoption;
- runtime upgrades;
- framework upgrades;
- internal SDK migrations;
- organization-wide convention changes;
- authentication migrations;
- service boundary modernization;
- migration campaigns across many repositories;
- architecture transformations that can be decomposed into reviewable stages.

## 4.2 Explicit non-goals

Mendpoint is not intended to become:

- a full IDE replacement;
- a general-purpose autonomous software engineer;
- a generic issue-to-code agent for arbitrary feature development;
- an automatic production deployment system;
- a system that merges high-risk changes without review;
- a generic enterprise workflow automation platform;
- a proprietary GPU-training infrastructure company;
- a model lab dependent on training a frontier foundation model from scratch.

## 4.3 Scope test for new features

A proposed feature belongs in Mendpoint if it materially improves one or more of:

1. detecting a required migration;
2. understanding migration scope;
3. reconstructing dependencies or constraints;
4. planning migration sequence;
5. generating migration edits;
6. verifying migration correctness;
7. reviewing or governing migration work;
8. measuring migration progress or outcome;
9. learning reusable migration intelligence.

Features that do not satisfy this test require explicit product justification.

---

# 5. Users and jobs to be done

## 5.1 Primary users

### Engineering managers

Need to understand migration scope, staffing burden, risk, progress, and acceptance without manually coordinating every repository.

### Staff and senior engineers

Need accurate impact analysis, evidence, safe code changes, and clear exception handling.

### Platform and developer productivity teams

Need organization-wide migration visibility and a repeatable way to execute upgrades across many repositories.

### Security and compliance teams

Need auditable changes, policy enforcement, approval records, and evidence of verification.

### Forward deployed engineers and solution architects

Need to launch and manage high-value provider or enterprise migration campaigns without rebuilding the migration process per customer.

## 5.2 Secondary users

- API providers seeking faster customer adoption.
- CTOs and VP Engineering teams managing technical risk and modernization debt.
- Product and solution engineering teams coordinating migration programs.
- Reliability teams managing deprecations and operational risk.

## 5.3 Core jobs

Users hire Mendpoint to answer:

- What changed?
- Does this change affect us?
- Where does it affect us?
- What will break?
- What else depends on the affected code?
- What should be changed?
- Can Mendpoint make the change safely?
- How do we know the change is correct?
- In what order should a large migration happen?
- What remains unresolved?
- What evidence can a reviewer trust?
- What did we learn that should improve the next migration?

---

# 6. System mental model

## 6.1 Mission as the shared execution primitive

A **Mission** is the primary unit of Mendpoint work.

A Mission has:

- a trigger or objective;
- tenant and repository scope;
- source evidence;
- current graph snapshot references;
- one or more migration tasks;
- risk and confidence context;
- execution history;
- verification results;
- review state;
- final outcome;
- learning provenance.

Fettler and ReGauge use the same Mission abstraction but create missions differently.

### Fettler mission

Created from an external change event or campaign.

```text
ProviderChange
→ FettlerMission
→ ImpactFindings
→ MigrationTasks
→ CandidateEdits
→ Verification
→ Reviewable PR(s)
```

### ReGauge mission

Created from an internal migration objective.

```text
MigrationObjective
→ ReGaugeMission
→ Discovery
→ MigrationGraph
→ MigrationPlan
→ Stages
→ MigrationTasks
→ PR batches
→ Verification
```

## 6.2 Campaign

A **Campaign** coordinates multiple related Missions or stages.

Examples:

- a provider-wide migration across 200 repositories;
- a Python runtime upgrade across 40 services;
- an internal authentication standard migration;
- a multi-stage monolith modernization.

Campaigns MUST support:

- explicit scope;
- stage/dependency ordering;
- status roll-up;
- exceptions;
- pause and resume;
- cancellation;
- retry;
- audit history;
- partial success;
- rollback guidance;
- ownership.

## 6.3 Evidence

An **Evidence** object is a first-class platform primitive representing why Mendpoint believes something.

Evidence MAY originate from:

- provider specifications;
- release notes;
- changelogs;
- SDK diffs;
- repository code;
- dependency manifests;
- static analysis;
- runtime metadata;
- tests;
- CI results;
- historical migrations;
- human review;
- deterministic tool output.

Material findings MUST reference their supporting evidence.

## 6.4 Verification

A **Verification Result** is an observed result of testing or validating a proposed migration.

Verification is separate from model confidence. A model may be confident and wrong; a low-confidence change may verify successfully. The product MUST preserve this distinction.

---

# 7. Reference architecture

Mendpoint is organized into eight logical layers. Physical services may combine layers where appropriate; the logical boundaries remain useful for design and testing.

## 7.1 Layer A — Integration and ingestion

Responsibilities:

- GitHub and GitLab connectivity;
- repository metadata and branch access;
- provider source ingestion;
- OpenAPI/spec retrieval;
- changelog and release-note ingestion;
- SDK release metadata;
- internal migration objective intake;
- CI/test system integration;
- optional runtime metadata ingestion.

Key requirements:

- idempotent ingestion;
- source provenance;
- source versioning;
- tenant scoping;
- least privilege;
- replayable raw input references.

## 7.2 Layer B — Change normalization

Responsibilities:

- convert external change sources into structured change objects;
- classify changes as additive, breaking, behavioral, deprecation, security, auth, schema, version, or unknown;
- preserve raw source evidence;
- deduplicate equivalent change signals;
- identify confidence and ambiguity.

The normalization layer MUST NOT discard raw source evidence needed for later review.

## 7.3 Layer C — Mendpoint Change Graph and representation layer

Responsibilities:

- normalize canonical software/provider entities across heterogeneous sources;
- entity-resolve aliases, wrappers, generated clients, service names, provider objects, and runtime identities where evidence permits;
- materialize high-value software relationships as typed edges;
- represent providers, contracts, repositories, code structures, dependencies, runtime relationships, tests, owners, migrations, and verification;
- version entities and edges over time and by repository/provider snapshot;
- preserve provenance, derivation method, freshness, and epistemic status on material relationships;
- expose graph coverage, ambiguity, conflict, and staleness;
- support bounded blast-radius, dependency-order, verification-coverage, ownership, and migration-path queries;
- generate compact mission-specific graph projections for downstream reasoning.

The Change Graph is the primary shared intelligence substrate for Fettler and ReGauge and the durable memory of software relationships across missions.

The graph layer SHOULD distinguish three logical partitions even if they share physical storage:

```text
Global Provider Graph
+ Tenant Software Graph
→ Mission Graph Projection
```

The representation layer MUST NOT imply a particular database technology. A relational edge store, graph database, virtual ontology, materialized view layer, or hybrid implementation is acceptable if it satisfies the semantic, temporal, provenance, isolation, and query contracts in Section 11.

## 7.4 Layer D — Mission orchestration and routing

Responsibilities:

- decompose missions into structured tasks;
- query the Change Graph and compile bounded evidence/context packs;
- choose deterministic tools, recipes, owned/specialized models, rented general models, or verification paths;
- enforce policy;
- manage retries and fallbacks;
- track task-level cost, latency, confidence, and outcome.

Models receive structured task specifications where practical, not unbounded raw prompts.

## 7.5 Layer E — Execution and verification

Responsibilities:

- scan and analyze code;
- generate candidate edits;
- apply edits in isolated workspaces;
- generate or select tests;
- run compile, lint, unit, integration, contract, and policy checks as available;
- distinguish pre-existing failures from introduced failures where possible;
- package candidate changes for review.

## 7.6 Layer F — Review and delivery

Responsibilities:

- evidence-backed explanations;
- semantic diff review;
- risk and confidence presentation;
- approvals and rejections;
- reviewer corrections;
- draft PR creation;
- campaign and exception management;
- retry and rollback controls.

## 7.7 Layer G — Evaluation and learning

Responsibilities:

- capture outcomes;
- generate learning events;
- classify lessons;
- maintain synthetic and production evaluation datasets;
- manage train/validation/holdout boundaries;
- generate corpora;
- integrate external trainers;
- register candidate adapters/models;
- run held-out evaluation and canaries;
- feed verified outcomes into router policy, graph improvements, recipes, prompts, tooling, or model training.

## 7.8 Layer H — Platform, security, governance, and observability

Responsibilities:

- tenant isolation;
- authorization;
- encryption;
- secret redaction;
- audit logging;
- residency controls;
- consent and training eligibility;
- trace storage;
- cost accounting;
- health monitoring;
- incident response;
- feature flags;
- release controls.

---

# 8. Canonical domain model

The names below are logical contracts. Existing implementation names MAY differ. New implementations SHOULD map to these concepts.

## 8.1 Tenant

Represents an organization boundary.

Required properties:

```text
tenant_id
name
policy_profile
residency_policy
learning_consent_policy
retention_policy
created_at
```

## 8.2 Integration

Represents an authenticated connection to GitHub, GitLab, CI, a provider source, or another supported system.

Required properties:

```text
integration_id
tenant_id
type
scope
auth_reference
permissions
health
created_at
updated_at
```

Credentials MUST NOT be embedded in normal trace payloads.

## 8.3 ProviderChange

Structured external change consumed by Fettler.

Suggested shape:

```json
{
  "change_id": "chg_...",
  "provider": "example-provider",
  "source_type": "openapi_diff",
  "source_versions": {"from": "v1", "to": "v2"},
  "change_class": "breaking",
  "affected_objects": [],
  "summary": "",
  "raw_evidence_refs": [],
  "confidence": 0.0,
  "detected_at": ""
}
```

## 8.4 MigrationObjective

Structured modernization intent consumed by ReGauge.

Suggested shape:

```json
{
  "objective_id": "obj_...",
  "tenant_id": "t_...",
  "title": "",
  "target_state": "",
  "repository_scope": [],
  "constraints": [],
  "success_conditions": [],
  "risk_tolerance": "",
  "requested_by": "",
  "created_at": ""
}
```

## 8.5 RepositorySnapshot

Represents the repository state against which analysis and edits were produced.

A snapshot MUST be immutable by reference and SHOULD include:

```text
repository_id
branch
commit_sha
captured_at
language/runtime metadata
manifest references
index version
graph version
```

## 8.6 Mission

Suggested state model:

```text
CREATED
→ DISCOVERING
→ SCOPED
→ PLANNING
→ EXECUTING
→ VERIFYING
→ AWAITING_REVIEW
→ ACCEPTED / REJECTED / PARTIAL / FAILED / CANCELLED
```

Fettler MAY skip explicit planning for small changes. ReGauge generally SHOULD retain explicit planning.

## 8.7 MigrationTask

The structured work unit sent to tools/models.

Required fields SHOULD include:

```text
task_id
mission_id
task_type
product
repository_snapshot
graph_context
evidence_refs
constraints
risk_class
verification_requirements
cost/latency policy
allowed_tools
expected_output_schema
```

## 8.8 ImpactFinding

Represents an identified affected object or code path.

Required fields:

```text
finding_id
change_or_objective_ref
repository
location
affected_entity
impact_type
evidence_refs
graph_path
risk
confidence
status
```

## 8.9 CandidateEdit

Represents a proposed code change before review.

Required fields:

```text
candidate_id
task_id
base_snapshot
patch_ref
changed_files
rationale
evidence_refs
risk
model_or_recipe
verification_state
```

## 8.10 VerificationResult

Required fields:

```text
verification_id
candidate_id
check_type
command_or_test_ref
environment_ref
status
baseline_status
introduced_failure
output_ref
duration
created_at
```

## 8.11 ReviewDecision

Required fields:

```text
review_id
candidate_or_pr_ref
reviewer
decision
comments
substantive_edits
policy_overrides
created_at
```

## 8.12 LearningEvent

A governed representation of a verified lesson-producing outcome.

Suggested shape:

```json
{
  "event_id": "learn_...",
  "product": "fettler",
  "mission_id": "",
  "task_type": "",
  "capability": "",
  "model": "",
  "adapter": "",
  "router_decision": {},
  "input_refs": [],
  "prediction": {},
  "observed_outcome": {},
  "verification": {},
  "reviewer_decision": {},
  "correction": {},
  "confidence": null,
  "cost": {},
  "latency": {},
  "provenance": {},
  "consent": {},
  "tenant": {},
  "residency": {},
  "source_class": "SYNTHETIC_GROUND_TRUTH",
  "created_at": ""
}
```

Private chain-of-thought MUST NOT be stored as learning data.


## 8.13 GraphEntity

A canonical typed entity in the Change Graph.

Required logical fields:

```text
entity_id
tenant/global scope
entity_type
canonical_key
attributes
snapshot/version context
source references
temporal validity
```

An entity MAY represent a provider-global object, such as an endpoint, or a tenant-private object, such as a repository symbol. Canonical identity MUST NOT collapse unrelated tenant entities.

## 8.14 GraphEdge

A typed relationship between graph entities.

Required logical fields:

```text
edge_id
source entity
target entity
relationship type
derivation method
evidence references
epistemic status
freshness/version context
temporal validity
tenant/global scope
```

A graph edge is a product artifact, not merely an implementation detail. Material migration decisions SHOULD be explainable through the edges that support them.

## 8.15 GraphCoverage

A structured description of what the current graph projection knows and does not know for a mission.

Coverage SHOULD capture, where relevant:

```text
static-analysis coverage
runtime-evidence availability
dynamic/reflection risk
test-coverage availability
staleness
conflicts
unresolved entities
known unsupported constructs
```

Coverage MUST remain distinct from model confidence.

## 8.16 MissionGraphProjection

A bounded, versioned subgraph compiled for one Mission or MigrationTask.

It SHOULD include:

- changed/target entities;
- relevant impact/dependency paths;
- evidence-bearing edges;
- coverage state;
- conflicts and stale facts;
- relevant tests and owners;
- explicit graph version and repository/provider snapshots.

Models SHOULD receive a MissionGraphProjection or equivalent structured context rather than an unbounded dump of the tenant graph.

---

# 9. Fettler product specification

## 9.1 Purpose

Fettler detects external software change, determines whether and where it affects connected codebases, generates safe remediation, verifies the remediation, and produces reviewable migration work.

## 9.2 Fettler triggers

Fettler MUST support an extensible trigger model. Initial trigger classes include:

- OpenAPI diff;
- SDK release or changelog;
- release note;
- deprecation notice;
- provider security/authentication change;
- manual provider announcement;
- customer-reported incident linked to provider behavior;
- scheduled provider migration campaign.

## 9.3 Change taxonomy

Fettler SHOULD normalize external changes into one or more of:

```text
ADDITIVE
BREAKING_CONTRACT
BEHAVIORAL
DEPRECATION
AUTHENTICATION
AUTHORIZATION
SCHEMA
ENUM
PAGINATION
RATE_LIMIT
WEBHOOK
SDK_SURFACE
VERSION_REQUIREMENT
SECURITY
END_OF_LIFE
UNKNOWN
```

Classification MUST preserve ambiguity. Unknown or conflicting evidence SHOULD be represented rather than forced into a known category.

## 9.4 Fettler workflow

### Stage F1 — Ingest

- retrieve or receive source;
- verify source identity where possible;
- store immutable evidence reference;
- deduplicate;
- establish source version boundary.

### Stage F2 — Normalize

- identify changed provider objects;
- classify semantic change;
- extract migration guidance if present;
- assign preliminary severity/confidence;
- create ProviderChange.

### Stage F3 — Candidate impact discovery

Fettler SHOULD resolve changed provider entities into the Global Provider Graph, traverse direct and indirect usage relationships into the tenant software graph, and surface unresolved mappings rather than relying on repeated raw-code inference.

- query provider-to-code graph relationships;
- search repository references;
- inspect SDK usage;
- inspect wrappers and internal abstractions;
- identify dynamic or ambiguous paths requiring deeper analysis.

### Stage F4 — Blast-radius analysis

Blast radius SHOULD be expressed as evidence-backed graph paths and SHOULD distinguish direct, transitive, runtime-observed, inferred, stale, and unresolved impact.

For every candidate finding, determine:

- direct call sites;
- wrapper or abstraction layers;
- dependent services/modules;
- tests touching the path;
- ownership where available;
- runtime or environment relevance;
- likely migration order.

### Stage F5 — Task decomposition

Create bounded MigrationTasks for:

- evidence confirmation;
- code transformation;
- test generation;
- verification;
- explanation;
- campaign sequencing.

### Stage F6 — Remediation generation

Prefer, in order where appropriate:

1. deterministic transformation recipe;
2. specialized adapter/model;
3. general code model;
4. frontier model escalation.

Generated edits MUST respect forbidden zones, repository policy, and scoped files.

### Stage F7 — Verification

Run the strongest available verification appropriate to risk and repository support.

### Stage F8 — Review packaging

Produce:

- impact summary;
- changed files;
- semantic change explanation;
- evidence;
- risk;
- confidence;
- verification result;
- unresolved uncertainty;
- rollback guidance if material;
- draft PR.

### Stage F9 — Outcome capture

Record:

- accepted/rejected;
- reviewer corrections;
- merge outcome;
- verification after correction;
- later failure signals where available;
- learning eligibility.

## 9.5 Fettler functional requirements

### FET-001 — Source provenance

Every ProviderChange MUST retain references to source evidence.

### FET-002 — Semantic classification

Fettler MUST distinguish syntactic version change from semantic migration significance.

### FET-003 — Repository precision

Impact findings MUST identify repository and concrete code location when available.

### FET-004 — Graph path

Material impact findings SHOULD expose the dependency path explaining why the change matters.

### FET-005 — False-positive control

Fettler MUST support explicit dismissal of false impact findings and capture them as learning signals when eligible.

### FET-006 — Hidden usage

Fettler SHOULD detect provider usage through wrappers, generated clients, shared libraries, and common indirection patterns where graph/index support exists.

### FET-007 — Edit generation

Fettler SHOULD generate precise candidate edits rather than only prose recommendations for supported migration classes.

### FET-008 — Verification

Candidate edits MUST expose verification status before review.

### FET-009 — Baseline failures

Where feasible, verification SHOULD distinguish pre-existing failures from failures introduced by the candidate edit.

### FET-010 — Review

A reviewer MUST be able to accept, reject, request regeneration, or modify a candidate.

### FET-011 — PR packaging

Supported repositories SHOULD receive draft PRs with rationale, evidence, risk, and verification summary.

### FET-012 — Campaign mode

Fettler MUST support one provider change affecting many repositories without requiring each repository to be operated as an unrelated workflow.

### FET-013 — Partial coverage

Fettler MUST surface graph or repository coverage gaps rather than reporting complete safety when evidence is incomplete.

### FET-014 — Audit

Every material inference, model/tool execution, edit, verification action, and review decision MUST be auditable.

### FET-015 — Relationship materialization

For supported providers/stacks, Fettler SHOULD materialize stable provider-to-code relationships that are repeatedly useful for impact analysis rather than asking the reasoning model to rediscover them per mission.

### FET-016 — Impact-path explainability

Every material impact finding SHOULD be able to expose a path from the provider change to the affected code and relevant verification evidence.

### FET-017 — Coverage-aware no-impact result

Fettler MUST distinguish a verified no-impact result from a no-known-impact result produced under partial or unknown graph coverage.

### FET-018 — Raw-retrieval fallback

When graph coverage is insufficient, Fettler MAY perform targeted raw retrieval or model exploration. Stable relationships discovered through fallback SHOULD be eligible for validated graph materialization in a subsequent graph version.

## 9.6 Fettler user experience

Primary screens:

- provider/change event feed;
- change event detail;
- affected repository list;
- impact graph;
- impact finding detail;
- candidate edit/PR review;
- campaign status;
- audit trail.

The UI SHOULD make the sequence obvious:

```text
what changed
→ where we found impact
→ why we believe it
→ what we changed
→ how we verified it
→ what still needs attention
```

## 9.7 Fettler failure behavior

Fettler SHOULD fail safely.

Examples:

- incomplete graph → lower confidence and explicit coverage warning;
- unavailable CI → PR may be generated but verification marked incomplete;
- ambiguous migration guidance → escalate to stronger reasoning or human review;
- conflicting provider evidence → block high-confidence remediation until resolved;
- repository permission loss → stop affected tasks, preserve campaign state, surface integration error;
- model failure → retry/fallback according to policy, never silently claim success.

---

# 10. ReGauge product specification

## 10.1 Purpose

ReGauge turns internal modernization intent into an evidence-backed, dependency-aware, staged migration program.

It is optimized for migrations that are larger, more ambiguous, and more structurally coupled than the typical Fettler event.

## 10.2 ReGauge objective classes

Initial objective classes include:

```text
FRAMEWORK_UPGRADE
RUNTIME_UPGRADE
INTERNAL_SDK_MIGRATION
EXTERNAL_SDK_MIGRATION
AUTH_STANDARDIZATION
CODEBASE_STANDARDIZATION
INFRASTRUCTURE_MIGRATION
SERVICE_BOUNDARY_CHANGE
ARCHITECTURE_TRANSFORMATION
LEGACY_DECOMPOSITION
VENDOR_EXIT
CUSTOM_MIGRATION
```

## 10.3 ReGauge workflow

### Stage R1 — Objective intake

Capture:

- desired target state;
- repository scope;
- business/technical constraints;
- deadlines if material;
- forbidden zones;
- risk tolerance;
- success conditions.

### Stage R2 — Discovery

ReGauge SHOULD combine static structure with available runtime, configuration, database, job, deployment, and test evidence to reconstruct relationships that are not visible from imports alone. The discovery result MUST expose coverage and blind spots.

Build or refresh:

- repository topology;
- module/service relationships;
- dependency graph;
- runtime/version inventory;
- test coverage relationships;
- ownership;
- configuration and deployment boundaries;
- architecture conventions;
- known exceptions.

### Stage R3 — Constraint analysis

Identify:

- hard blockers;
- incompatible dependencies;
- cycles;
- shared state;
- database coupling;
- undocumented runtime dependencies;
- feature flags;
- sequencing constraints;
- unsupported components;
- ambiguous areas requiring human confirmation.

### Stage R4 — Migration graph

The migration graph SHOULD distinguish observed software dependencies from proposed migration constraints. Stable software facts belong in the Change Graph; planning hypotheses MUST remain provisional until supported by evidence or approval.

Create a graph of migration units and ordering constraints.

A migration unit SHOULD be independently reviewable where possible.

### Stage R5 — Plan

Produce:

- target architecture or target state;
- stages;
- dependencies;
- expected PR batches;
- validation strategy;
- rollback/escape plan;
- exceptions requiring manual handling.

### Stage R6 — Execute stage

For each stage:

- create bounded tasks;
- generate edits;
- run verification;
- produce PR batch;
- collect review;
- update campaign state.

### Stage R7 — Re-plan as evidence changes

ReGauge MUST support plan revision when:

- hidden dependencies emerge;
- verification contradicts assumptions;
- reviewers change constraints;
- a migration stage fails;
- architecture drift is discovered.

### Stage R8 — Complete campaign

Produce:

- completed stages;
- unresolved exceptions;
- residual legacy surface;
- verification status;
- migration history;
- executive modernization summary.

## 10.4 ReGauge functional requirements

### REG-001 — Objective structure

Migration intent MUST be converted from free-form request into a structured objective before high-impact execution.

### REG-002 — Topology discovery

ReGauge MUST establish a versioned repository/system snapshot before planning.

### REG-003 — Constraint visibility

Material assumptions and unresolved constraints MUST be visible to reviewers.

### REG-004 — Dependency ordering

Migration stages MUST preserve known dependency constraints.

### REG-005 — Incremental execution

ReGauge SHOULD prefer bounded, incremental PRs over monolithic rewrites.

### REG-006 — Plan/edit separation

For high-complexity migrations, plan approval SHOULD be separable from code generation.

### REG-007 — Organization conventions

ReGauge SHOULD preserve organization-specific code, architecture, and policy conventions where they are available and allowed.

### REG-008 — Exceptions

Unsupported or unsafe areas MUST become explicit exceptions, not silently omitted work.

### REG-009 — Graph incompleteness

When the graph is incomplete, ReGauge MUST surface uncertainty and SHOULD reduce automation level.

### REG-010 — Campaign state

Campaigns MUST support pause, resume, retry, cancellation, partial completion, and exception tracking.

### REG-011 — Stage verification

A stage SHOULD NOT advance automatically when required verification has failed.

### REG-012 — Rollback guidance

High-risk stages MUST include rollback or recovery guidance before approval.

### REG-013 — Drift

ReGauge SHOULD detect when the codebase changes materially relative to the snapshot used for planning and require revalidation.

### REG-014 — Executive reporting

Large campaigns SHOULD produce a concise status view for engineering leadership in addition to developer-level detail.

### REG-015 — Hybrid relationship discovery

ReGauge SHOULD support relationship evidence from static analysis, runtime observation, configuration, database logic, background jobs, messaging, and tests where available and permitted.

### REG-016 — Migration-constraint provenance

Ordering relationships such as `MUST_PRECEDE`, `BLOCKS`, or `REQUIRES_COMPATIBILITY_WITH` MUST distinguish deterministic/observed constraints from model-inferred planning hypotheses.

### REG-017 — Unknown vs absent dependency

ReGauge MUST NOT represent an unobserved dependency as absent when graph coverage is insufficient to support that conclusion.

### REG-018 — Graph-backed planning

Supported ReGauge planning flows SHOULD consume a MissionGraphProjection containing topology, runtime dependencies, shared state, tests, conflicts, and coverage before broad raw-code exploration.

## 10.5 ReGauge user experience

Primary surfaces:

- migration objective intake;
- discovery status;
- system topology;
- migration blueprint;
- stage/dependency graph;
- PR batch queue;
- exceptions register;
- campaign progress;
- verification history;
- executive modernization report.

The main UX question is:

> What is the safest next migration step, and what evidence supports it?

---

# 11. Mendpoint Change Graph

## 11.1 Purpose

The Change Graph is Mendpoint's canonical durable representation of software relationships.

It connects:

```text
provider change
→ provider entity
→ API/SDK/schema relationship
→ tenant code
→ dependency/runtime path
→ test
→ owner
→ migration task
→ verification
→ outcome
```

The graph is not only a code graph. It is a **migration knowledge graph and relationship memory** shared by Fettler, ReGauge, routing, verification, evaluation, and learning.

The design principle is:

> **Do not pay a model to rediscover a relationship on every mission when Mendpoint can resolve that relationship once, preserve its evidence, version it, test it, and traverse it safely thereafter.**

## 11.2 Representation-first intelligence

Mendpoint MUST treat data representation as an independent source of product quality.

A model can reason only over relationships that are either:

1. explicitly represented and retrieved;
2. inferable from the supplied context;
3. discovered through tools during the mission.

More model compute MUST NOT be treated as a substitute for missing instance-level relationships.

For relationship-heavy tasks, Mendpoint SHOULD prefer:

```text
raw data
→ entity resolution
→ relationship materialization
→ bounded graph traversal
→ model reasoning
```

over:

```text
raw data
→ repeated broad retrieval
→ model repeatedly reconstructs relationships
```

The second path remains a fallback for novel, ambiguous, or not-yet-materialized relationships.

## 11.3 Ontology vs instance facts

The graph architecture MUST distinguish type-level knowledge from instance-level facts.

### Type-level knowledge

The ontology defines what kinds of things and relationships can exist.

Examples:

```text
Function can USES_SDK_METHOD SdkMethod
Service can DEPENDS_ON Service
Test can COVERED_BY_TEST RuntimePath
MigrationStage can MUST_PRECEDE MigrationStage
```

### Instance-level knowledge

The graph stores which relationship actually exists in a specific provider/repository/snapshot.

Example:

```text
checkout.createPayment
USES_SDK_METHOD
stripe.paymentIntents.create
```

High-cardinality, dynamic instance facts MUST NOT use system prompts, agent instruction files, or model weights as their primary source of truth.

## 11.4 Logical graph partitions

The Change Graph SHOULD distinguish three logical layers.

### Global Provider Graph

May contain non-tenant-specific provider intelligence such as:

- providers;
- API versions;
- endpoints;
- schemas/fields;
- SDK versions/methods;
- changelog/deprecation events;
- provider migrations and replacements.

### Tenant Software Graph

Contains customer-private software facts such as:

- repositories/snapshots;
- files/symbols;
- services;
- internal wrappers;
- runtime dependencies;
- databases/queues/jobs;
- tests;
- owners;
- organization-specific conventions.

### Mission Graph Projection

A bounded, immutable-enough view joining only the relevant provider and tenant graph state for one mission/task.

Cross-tenant repository relationships are prohibited. Provider-global entities MAY be shared only through an explicit safe global layer.

## 11.5 Core entity classes

The graph SHOULD support entity classes based on real product questions rather than theoretical completeness.

### External/provider entities

- Provider;
- ProviderVersion;
- API/ApiSpec;
- ApiVersion;
- Endpoint;
- Schema;
- SchemaField;
- Webhook;
- SDK;
- SDKVersion;
- SDKMethod;
- ProviderChange;
- ChangelogItem;
- Deprecation.

### Repository/code entities

- Organization;
- Repository;
- RepositorySnapshot;
- Branch;
- Package;
- Module;
- File;
- Symbol;
- Function/Method;
- Class/Interface;
- Configuration;
- FeatureFlag.

### Runtime/infrastructure entities

- Service;
- Runtime;
- Environment;
- Deployment;
- Database;
- Table;
- Queue/Topic;
- Job/Cron;
- RuntimePath.

### Verification entities

- Test;
- TestSuite;
- CIJob;
- VerificationRun;
- PolicyCheck.

### Workflow/migration entities

- Team/Owner;
- Mission;
- MigrationTask;
- ImpactFinding;
- CandidateEdit;
- PullRequest;
- MigrationStage;
- ReviewDecision;
- LearningEvent;
- Recipe;
- Model/Adapter.

## 11.6 Relationship ontology

Stable relationship types SHOULD be semantically specific.

### Structural

```text
CONTAINS
DECLARES
IMPORTS
CALLS
IMPLEMENTS
EXTENDS
DEPENDS_ON
WRAPS
```

### Provider/API

```text
USES_PROVIDER
USES_API_VERSION
USES_ENDPOINT
USES_SDK
USES_SDK_METHOD
READS_SCHEMA
WRITES_SCHEMA
DEPRECATED_BY
REPLACED_BY
AFFECTED_BY_CHANGE
```

### Runtime/data

```text
EXECUTES_AS
OBSERVED_CALLING
OBSERVED_AT_RUNTIME
READS_FROM
WRITES_TO
PUBLISHES_TO
CONSUMES_FROM
DEPLOYED_WITH
SHARES_STATE_WITH
```

### Test/verification

```text
COVERED_BY_TEST
VERIFIED_BY
FAILED_VERIFICATION
PASSED_VERIFICATION
```

### Ownership/review

```text
OWNED_BY
REVIEWED_BY
```

### Migration

```text
MIGRATES_TO
MUST_PRECEDE
BLOCKS
REQUIRES_COMPATIBILITY_WITH
REQUIRES_STAGE
PRESERVES_CONTRACT
REMEDIATED_BY
```

The ontology MUST remain extensible without requiring broad schema redesign for every new relation type.

## 11.7 Entity resolution

Entity resolution is a first-class graph capability, distinct from retrieval and model reasoning.

Mendpoint SHOULD resolve identities such as:

- package aliases;
- renamed services;
- generated clients vs canonical provider APIs;
- internal SDK wrappers vs provider SDK methods;
- runtime service names vs repository modules;
- schemas/contracts represented differently across sources.

Resolution SHOULD use multiple signals when simple identifiers are insufficient, including static metadata, source location, package identity, OpenAPI operation IDs, SDK metadata, runtime telemetry, configuration, build graphs, and historical verified migration evidence.

Ambiguous mappings MUST remain ambiguous rather than being forced into one identity.

Suggested resolution states:

```text
RESOLVED
PROBABLE
AMBIGUOUS
UNRESOLVED
CONFLICTING
```

## 11.8 Relationship materialization

High-value relationships that are repeatedly useful SHOULD move from query-time inference into offline or incremental graph construction when they can be validated.

Examples:

```text
Function
→ WRAPS
→ InternalSdkMethod
→ USES_SDK_METHOD
→ ProviderSdkMethod
→ USES_ENDPOINT
→ Endpoint
```

and:

```text
Function
→ COVERED_BY_TEST
→ IntegrationTest
```

Materialization SHOULD reduce repeated model search/reconstruction while creating a persistent, testable artifact.

Query-time discovery remains necessary for novel relationships. Stable discoveries SHOULD be eligible for validated materialization in later graph versions.

## 11.9 Edge provenance and epistemic status

Every material edge SHOULD carry sufficient provenance to answer:

> Why does Mendpoint believe this relationship exists?

At minimum, important edges SHOULD preserve:

- evidence references;
- derivation method;
- source/snapshot/version;
- extractor or rule version;
- first/last observation;
- validity window where relevant;
- tenant/global scope;
- epistemic status.

Suggested derivation classes:

```text
STATIC_ANALYSIS
SPEC_ANALYSIS
RUNTIME_OBSERVATION
TEST_OBSERVATION
DETERMINISTIC_RULE
HUMAN_VERIFIED
MODEL_INFERRED
MIGRATION_OUTCOME
```

Suggested epistemic states:

```text
DETERMINISTIC
OBSERVED
INFERRED
CORROBORATED
HUMAN_VERIFIED
CONFLICTING
STALE
INVALIDATED
```

Numeric confidence MUST NOT be fabricated where no calibrated probability exists.

## 11.10 Temporal versioning

The graph MUST support reasoning about change over time.

Mendpoint MUST be able to distinguish:

- repository graph state by immutable repository snapshot;
- provider contract/API/SDK version before and after change;
- graph version when a mission was created;
- graph version when an edit was generated;
- graph version after repository/provider updates;
- runtime observations and test evidence by time/environment.

A running mission SHOULD reference explicit graph and repository/provider versions. A graph update MUST NOT silently change the semantics of an in-flight mission.

## 11.11 Incremental graph build and publication

Where safe, graph construction SHOULD be incremental:

```text
repository/provider event
→ determine affected entities
→ invalidate impacted graph region
→ re-resolve affected identities
→ re-materialize impacted edges
→ validate graph invariants
→ publish new graph version
```

If graph publication fails, the system SHOULD preserve the last valid graph version and surface staleness rather than publish partially corrupt state.

## 11.12 Graph completeness and coverage

Graph incompleteness is a first-class product state.

Mendpoint MUST distinguish:

```text
NO_IMPACT_VERIFIED
NO_KNOWN_IMPACT_PARTIAL_COVERAGE
IMPACT_FOUND
IMPACT_UNKNOWN
CONFLICTING_EVIDENCE
```

Coverage SHOULD consider the evidence sources relevant to the task, including:

- static analysis;
- dynamic/reflection risk;
- generated code;
- configuration/feature flags;
- runtime telemetry;
- database procedures;
- jobs/cron/shell scripts;
- messaging;
- tests;
- external services.

Coverage MUST remain separate from model confidence and migration risk.

## 11.13 Required query primitives

The graph layer SHOULD expose stable bounded query capabilities for:

### Blast radius

"What depends directly or transitively on X, and through what path?"

### Provider usage

"Where is provider object X used, including SDK wrappers and indirect consumers?"

### Verification coverage

"What tests/checks cover this affected path, and how strong is that relationship?"

### Migration order

"What must change before Y, and what evidence establishes that constraint?"

### Constraint discovery

"What cycles, shared state, runtime dependencies, or compatibility constraints block this migration?"

### Ownership

"Who owns affected components?"

### Coverage/conflict

"What important relationships are unresolved, stale, or conflicting?"

Queries MUST be bounded by tenant, repository/provider versions, and mission scope.

## 11.14 Context compiler

The graph SHOULD feed a Context Compiler that converts query results into a small, typed, evidence-bearing model input.

A MissionGraphProjection MAY contain:

```text
mission/task
changed or target entities
impact/dependency paths
relevant edges
evidence refs
coverage state
conflicts
stale facts
relevant tests
owners
snapshot/version identifiers
```

The objective is **minimum sufficient structured context**, not maximum retrieval volume.

The product SHOULD measure whether graph-backed context reduces:

- repeated retrieval calls;
- files examined;
- model input tokens;
- latency;
- inference cost;

without degrading quality.

## 11.15 Hybrid static and runtime evidence

Static analysis alone is insufficient for some software systems, especially ReGauge targets.

The graph SHOULD be able to combine permitted evidence from:

- AST/import/symbol/call analysis;
- build/dependency metadata;
- provider specs/SDK mappings;
- configuration;
- CI/test execution;
- runtime traces/APM;
- deployment metadata;
- database access;
- queues/topics;
- cron/jobs/shell scripts.

Dynamic imports, reflection, generated code, ORM indirection, stored procedures, shared databases, background jobs, and feature-flagged behavior SHOULD be treated as explicit coverage risks.

## 11.16 Test and verification graph

Mendpoint SHOULD model meaningful verification relationships rather than merely listing test files.

Examples:

```text
Test COVERED_BY_TEST Symbol
Test VERIFIED_BY RuntimePath
VerificationRun PASSED_VERIFICATION MigrationTask
```

Actual relation direction MAY differ by implementation, but the semantics MUST support selecting the smallest meaningful verification set for an affected path.

The graph SHOULD distinguish static test association from observed/runtime coverage where possible.

## 11.17 Migration constraint graph

ReGauge SHOULD represent migration constraints with explicit provenance.

Potential relationships include:

```text
MUST_PRECEDE
BLOCKS
SHARES_STATE_WITH
REQUIRES_COMPATIBILITY_WITH
REQUIRES_DUAL_WRITE
PRESERVES_CONTRACT
```

Observed/deterministic software facts MUST remain distinguishable from proposed planning constraints inferred by a model.

## 11.18 Conflict, staleness, and invalidation

When evidence sources disagree, the graph MUST preserve the disagreement or resolve it through explicit policy rather than silently discarding one source.

Example:

```text
static analysis: no declared service dependency
runtime observation: service A called service B
```

These facts may justify different relation types instead of one overriding the other.

Edges that can become obsolete MUST have freshness/invalidation semantics tied to relevant repository, provider, deployment, runtime, test, or ownership changes.

## 11.19 Graph invariants

Graph publication SHOULD enforce deterministic invariants such as:

- edge endpoints exist;
- tenant scopes are compatible;
- forbidden cross-tenant edges do not exist;
- snapshot/version boundaries are valid;
- temporal ranges are sane;
- invalidated entities are not returned as current;
- provider versions are coherent;
- evidence references are resolvable where required.

Violating an invariant MUST block publication of the affected graph version.

## 11.20 Storage abstraction

The Change Graph is a semantic representation requirement, not a mandate to use a graph-native database.

Architecture decisions SHOULD compare:

- existing relational representation;
- typed edge tables;
- materialized graph views;
- graph databases;
- virtual ontologies;
- hybrid approaches.

Selection criteria include query expressiveness, snapshot/version semantics, tenant isolation, incremental updates, operational burden, performance, scale, and migration cost.

## 11.21 Representation benchmark

Mendpoint MUST maintain an evaluation path that can compare representation strategies on the same task/model/harness.

At minimum, for selected task families compare:

```text
A. existing/raw retrieval + Muse
B. Change Graph projection + Muse
C. Change Graph projection + Muse + independent verifier where justified
```

Task families SHOULD distinguish:

### Direct/reference tasks

Questions answerable through explicit local references, such as direct imports or installed versions.

### Relationship-heavy tasks

Questions requiring indirect wrappers, transitive blast radius, hidden runtime dependencies, test-path relationships, shared state, or migration ordering.

The graph SHOULD earn its complexity through measurable quality, context, latency, cost, or trust improvements on Mendpoint tasks.

---

# 12. Evidence, confidence, risk, and uncertainty

These concepts MUST remain separate.

## 12.1 Evidence

Evidence answers:

> What supports the claim?

## 12.2 Confidence

Confidence answers:

> How strongly does Mendpoint believe the claim given available evidence?

Confidence SHOULD be calibrated by task family and model/tool history rather than treated as an arbitrary language-model self-score.

## 12.3 Risk

Risk answers:

> What is the consequence if this action or inference is wrong?

Risk SHOULD consider:

- blast radius;
- production criticality;
- security relevance;
- data sensitivity;
- rollback difficulty;
- number of repositories/services;
- runtime coupling;
- verification strength.

## 12.4 Coverage

Coverage answers:

> How much of the relevant system did Mendpoint actually inspect or understand?

A high-confidence result with low coverage MUST NOT be presented as equivalent to a fully scoped result.

## 12.4.1 Graph epistemic status

Graph edge status is distinct from model confidence.

A deterministic import edge, runtime-observed service call, stale model-inferred dependency, and unresolved mapping may all appear in one mission graph projection. The context compiler and UI SHOULD preserve those distinctions so that downstream reasoning can be risk-aware.

The platform MUST NOT compress graph uncertainty, model confidence, migration risk, and verification coverage into one universal score.

## 12.5 Suggested confidence object

```json
{
  "score": 0.86,
  "basis": [
    "deterministic_reference",
    "verified_graph_path",
    "passing_contract_test"
  ],
  "coverage": 0.72,
  "calibration_bucket": "task_family_x",
  "known_unknowns": []
}
```

The exact implementation may differ, but the semantic separation SHOULD remain.

---

# 13. Task orchestration and model router

## 13.1 Principle

Fettler and ReGauge are orchestrators over a shared migration intelligence stack. They SHOULD NOT directly hard-code one model for an entire mission.

## 13.2 Structured TaskSpec

The router SHOULD receive a TaskSpec containing:

```text
product
task_type
capability
repository context
provider/framework context
risk class
blast radius
graph confidence
required tools
verification requirements
latency target
cost ceiling
candidate execution paths
```

## 13.3 Execution paths

The router may choose:

1. deterministic rule;
2. migration recipe;
3. static/dynamic analysis tool;
4. specialized open model;
5. post-trained vendor/framework/general migration adapter;
6. stronger general model;
7. rented general reasoning model;
8. independent probabilistic verifier;
9. human escalation.

A task MAY use multiple paths sequentially.

## 13.4 Router objective

The router's optimization target is:

> **Select the lowest-cost execution path that reliably meets the task's risk-adjusted quality requirement, with escalation when evidence or confidence is insufficient.**

Quality gates override cost savings.

## 13.5 Router inputs

The router SHOULD learn from:

- task family;
- provider/framework;
- language/runtime;
- repository size;
- context size;
- graph complexity;
- graph coverage, staleness, conflict, and relation epistemic state;
- representation path (raw retrieval vs graph projection);
- risk;
- blast radius;
- historical model accuracy;
- historical verification success;
- reviewer acceptance;
- latency;
- token cost;
- inference cost;
- escalation history.

## 13.6 Router outputs

Every routing decision SHOULD produce:

```text
selected path
selected model/adapter/tool
fallback chain
policy rationale
expected quality threshold
cost/latency estimate where available
```

The rationale is a structured product decision record, not private chain-of-thought.

## 13.7 Escalation

Escalation SHOULD occur when:

- confidence falls below policy threshold;
- graph coverage is incomplete for high-risk work;
- verification repeatedly fails;
- the task is novel relative to known adapter coverage;
- repository context exceeds specialized model capability;
- risk policy requires frontier-level reasoning or human review.

## 13.8 Model neutrality

The product specification MUST NOT depend on specific model vendors or model names. Model choices are operational configuration governed by evaluation evidence, licensing, cost, latency, and capability.


## 13.9 Current operational model baseline

Model neutrality is a product invariant, but the current operating configuration MAY identify concrete defaults.

As of this specification version, the intended baseline is:

```text
Primary generation/reasoning: Muse 1.2
Independent low-cost verifier: DeepSeek V4 Flash
```

This is an operational baseline, not a permanent architectural dependency.

Muse 1.2 is the primary rented reasoning/generation path until owned/specialized intelligence demonstrates superior risk-adjusted performance on the same eval harness.

DeepSeek V4 Flash is an independent **soft verifier** for candidate ranking, completion/progress verification, and selective test-time scaling where benchmark evidence justifies the additional inference. Its judgment MUST NOT override deterministic tests, graph invariants, runtime evidence, policy, or human review.

## 13.10 Intelligence ownership strategy

The router SHOULD support execution strategies corresponding to:

```text
DETERMINISTIC
RECIPE
OWNED_INTELLIGENCE
RENTED_GENERAL_INTELLIGENCE
RENTED_BEST_OF_N
INDEPENDENT_VERIFICATION
HUMAN_ESCALATION
```

A migration capability SHOULD move toward owned intelligence only when evals show a meaningful advantage in quality, latency, privacy/control, or economics. Reducing external-model usage is not itself a success metric.

---

# 14. Deterministic recipes and migration playbooks

## 14.1 Purpose

Repeated migration patterns SHOULD become deterministic recipes when doing so is safer, cheaper, and more explainable than generative execution.

Examples:

- known API field rename;
- canonical SDK method replacement;
- framework configuration migration;
- mechanical import rewrite;
- organization-standard auth middleware transformation.

## 14.2 Recipe requirements

A production recipe SHOULD include:

```text
recipe_id
version
applicability predicate
required evidence
preconditions
transformation
verification requirements
rollback behavior
known limitations
source/provenance
approval status
```

## 14.3 Recipe selection

Recipes MUST NOT be applied merely because code text resembles a known pattern. Applicability SHOULD be established using graph/context evidence.

## 14.4 Learning recipes

Repeated verified migration outcomes MAY produce recipe candidates. Candidates require evaluation before normal router eligibility.

---

# 15. Verification engine

## 15.1 Purpose

Verification converts "the edit looks plausible" into observed evidence.

## 15.2 Verification classes

Mendpoint SHOULD support:

- syntax/parse;
- compile/build;
- lint/static checks;
- unit tests;
- integration tests;
- contract tests;
- provider-specific validation;
- schema validation;
- security/policy checks;
- smoke tests;
- generated tests;
- migration-specific assertions.

## 15.3 Baseline comparison

Where feasible, Mendpoint SHOULD run verification against both:

- the base repository snapshot;
- the candidate edit.

This enables classification of:

```text
PRE_EXISTING_FAILURE
INTRODUCED_FAILURE
RESOLVED_FAILURE
NEW_PASS
UNKNOWN
```

## 15.4 Risk-adaptive verification

Higher-risk tasks SHOULD require stronger verification. Verification policy SHOULD be configurable by:

- tenant;
- repository;
- risk class;
- migration type;
- provider/framework;
- campaign.

## 15.5 Verification gaps

Passing tests MUST NOT be presented as proof of semantic safety if meaningful verification coverage is absent.

The UI SHOULD show both:

- what passed;
- what could not be verified.

## 15.6 Isolated execution

Code execution SHOULD occur in isolated environments with:

- bounded permissions;
- secrets controls;
- network policy;
- resource limits;
- timeouts;
- captured logs;
- reproducible environment metadata where practical.


## 15.7 Independent probabilistic verification

Mendpoint MAY use a separate model-based verifier to rank plausible candidates or estimate progress/completion probability.

The verifier is a **soft signal** beneath deterministic evidence.

A safe candidate-selection pipeline is:

```text
candidate generation
→ deterministic eligibility filters
→ verifier ranks eligible candidates
→ selected candidate
→ final deterministic verification
→ review
```

A candidate that fails a required deterministic check MUST NOT win because a verifier assigns it a high score.

Verifier outputs SHOULD record:

- model/version;
- criteria/version;
- score/ranking;
- evidence supplied;
- cost/latency;
- later ground-truth or reviewer outcome where available.

The platform SHOULD measure verifier calibration and disagreement with Muse, deterministic graders, and human review.

## 15.8 Test-time scaling policy

Additional inference SHOULD be risk-adaptive.

Preferred order for expensive work is:

```text
single Muse attempt
→ optional alternative plans
→ deterministic filtering
→ independent ranking/verification
→ additional full patch candidates only when expected value justifies cost
```

Best-of-N plan selection SHOULD generally precede Best-of-N full implementations because plans are cheaper to generate and isolate.


---

# 16. Review-first execution and PR delivery

## 16.1 Review invariant

The default execution boundary is a reviewable artifact, not production.

## 16.2 Review package

Every material candidate SHOULD expose:

- what triggered the change;
- affected code;
- graph path;
- rationale;
- source evidence;
- patch;
- risk;
- confidence;
- coverage;
- verification;
- unresolved uncertainty;
- model/tool/recipe provenance;
- rollback note when relevant.

## 16.3 Semantic review

Review UI SHOULD organize changes by migration meaning where possible, not only file order.

Example categories:

```text
contract update
call-site adaptation
configuration change
test update
compatibility shim
cleanup
```

## 16.4 Review actions

Supported actions SHOULD include:

```text
approve
reject
edit
request regeneration
request stronger verification
request escalation
mark false positive
defer
```

Substantive reviewer edits SHOULD be retained as learning signals when eligible.

## 16.5 PR behavior

Mendpoint SHOULD:

- create a dedicated branch;
- preserve base commit identity;
- use deterministic, descriptive commit/PR metadata;
- include evidence and verification in PR body;
- link the PR to mission/campaign;
- update mission state from PR outcomes where integration permits.

---

# 17. Learning and improvement flywheel

## 17.1 Objective

Every verified migration outcome should be able to improve the next migration without turning production into an uncontrolled self-modifying system.

The learning flywheel is broader than model fine-tuning.

A lesson may improve:

```text
model weights
router policy
retrieval
Change Graph construction
parser/static analysis
tool selection
deterministic recipe
prompt/system policy
confidence calibration
product logic
```

## 17.2 LearningEvent

Learning events MUST preserve:

- provenance;
- product;
- task;
- model/tool/recipe;
- router decision;
- observable output;
- verification;
- reviewer action;
- correction;
- cost/latency;
- tenant/consent/residency eligibility.

## 17.3 Provenance classes

At minimum the platform SHOULD distinguish:

```text
SYNTHETIC_GROUND_TRUTH
DESIGN_PARTNER_VERIFIED
PRODUCTION_VERIFIED
HUMAN_CORRECTED
DETERMINISTICALLY_VERIFIED
```

These MUST NOT be silently treated as equivalent evidence classes.

## 17.4 Lesson destination classification

Validated lessons SHOULD be classified into one or more destinations:

```text
MODEL_WEIGHT
ROUTER_POLICY
RETRIEVAL
GRAPH
PARSER
TOOLING
DETERMINISTIC_RECIPE
PROMPT
PRODUCT_LOGIC
CALIBRATION
NO_ACTION
ORGANIZATION_MEMORY
```

`ORGANIZATION_MEMORY` names the destination for a tenant-specific convention (see §17.4.3). Naming it does not mean the classifier routes to it: no attribution value yet means "organizational convention," so nothing is classified there today.

Examples:

- missing import due to parser defect → `PARSER`;
- model never saw the required file → `RETRIEVAL`;
- cheap model fails task family while stronger model succeeds → `ROUTER_POLICY`;
- provider-specific remediation pattern repeatedly verifies → `MODEL_WEIGHT` and/or `DETERMINISTIC_RECIPE`.

Mendpoint SHOULD NOT fine-tune models to compensate for deterministic engineering defects.

## 17.4.1 Hard vs soft learning signals

Mendpoint MUST distinguish authoritative or high-confidence outcomes from probabilistic signals.

### Hard / higher-authority evidence

Examples:

```text
synthetic ground truth
compiler/build result
test result
contract/runtime verification
human substantive correction
merge outcome
post-merge health
```

### Soft evidence

Examples:

```text
Muse confidence
DeepSeek verifier score
model preference
progress estimate
model-inferred graph relation
```

Soft evidence MAY become a feature, ranking signal, curriculum signal, or preference candidate after validation. It MUST NOT silently become ground truth.

## 17.4.2 Graph learning

Graph failures are a first-class learning destination.

Examples:

```text
missed wrapper → entity-resolution or relationship-materialization lesson
runtime-only dependency missed → runtime evidence ingestion lesson
correct edge existed but context omitted it → graph query/context compiler lesson
stale edge caused false impact → freshness/invalidation lesson
```

A missing relationship SHOULD NOT be classified as a model-training problem until Mendpoint verifies that the relationship existed, was current, was retrievable, and was supplied to the model.

## 17.4.3 Experience decomposition

Production experience SHOULD be decomposed into the appropriate durable form:

```text
fact / relationship → graph or retrieval
repeated deterministic transformation → recipe
specialized behavioral skill → post-training
organization-specific convention → tenant-private graph/rules/context
routing evidence → router policy
verification disagreement → verifier calibration/eval
```

The tenant-private rules/context form named above is implemented by the Organization Memory store (ADR-0008), a governed, tenant-scoped, inspectable store for organizational conventions and preferences. Its taxonomy destination is `ORGANIZATION_MEMORY` (§17.4). This names where such a convention belongs; it is not a claim that the lesson pipeline routes to it yet. Routing requires an attribution value meaning "organizational convention" and a producer that emits it only on repeated reviewer correction of a non-defect, neither of which exists today.

## 17.5 Dataset lifecycle

Eligible model-learning events SHOULD move through a governed lifecycle:

```text
OPEN
→ COLLECTING
→ VALIDATING
→ SEALED
→ EXPORTED
→ TRAINING
→ ARCHIVED
```

Equivalent existing states are acceptable.

Sealed datasets MUST be immutable by identity.

## 17.6 Dataset splits

Every training program MUST preserve:

```text
TRAIN
VALIDATION
HOLDOUT
```

Holdout examples MUST NOT contribute to training.

Synthetic evaluation should further distinguish:

```text
synthetic-development
synthetic-regression
synthetic-hidden-holdout
```

## 17.7 Corpus families

Training data SHOULD be partitionable by capability:

```text
api_change_classification
impact_analysis
dependency_reasoning
root_cause_analysis
blast_radius
remediation_generation
migration_planning
migration_sequencing
verification_reasoning
tool_selection
confidence_calibration
abstention
router_policy
```

## 17.8 Adapter strategy

The target architecture supports:

### Vendor adapters

Provider-specific migration patterns, primarily useful to Fettler.

### Framework/runtime adapters

Framework, runtime, or migration-family specialization, primarily useful to ReGauge.

### General migration adapter

Cross-provider/framework migration primitives.

Adapter boundaries should be evidence-driven rather than created merely because a category exists.

## 17.9 Trainer abstraction

Mendpoint SHOULD remain trainer-neutral.

Logical trainer capabilities:

```text
submit
status
reconcile
fetch_artifacts
cancel
```

Mendpoint's strategic asset is migration intelligence, not proprietary training infrastructure.

## 17.10 Candidate lifecycle

Candidate models/adapters SHOULD move through a governed lifecycle:

```text
TRAINING
→ TRAINED
→ EVALUATING
→ EVALUATED
→ SHADOW_READY
→ SHADOW
→ CANARY_READY
→ CANARY
→ AWAITING_APPROVAL
→ APPROVED
→ ROUTER_ELIGIBLE
→ ACTIVE
```

Failure/terminal states SHOULD include:

```text
REJECTED
QUARANTINED
ROLLED_BACK
RETIRED
```

Production promotion MUST remain governed.

## 17.11 Promotion requirements

A candidate MUST NOT become normally router-eligible unless:

- required held-out evaluations pass;
- no unacceptable high-severity regression exists;
- artifact integrity is valid;
- consent/provenance requirements are valid;
- canary requirements are met where applicable;
- explicit promotion approval is recorded.

## 17.12 Router learning

Routing outcomes are themselves learning data.

Mendpoint SHOULD measure by task family:

```text
selected model/tool
success
verification
review acceptance
cost
latency
fallback
escalation
```

The router should improve from this evidence.

## 17.13 Own vs rent intelligence

Mendpoint SHOULD maintain an evidence-backed classification for important model-mediated capabilities:

```text
DETERMINISTIC
RECIPE
OWN_NOW
OWN_LATER
RENT
UNKNOWN
```

The decision SHOULD consider task volume, eval quality, proprietary-data advantage, latency sensitivity, Muse quality/cost, risk, label quality, and the potential for deterministic or specialized execution.

The first owned-intelligence slices SHOULD be narrow and measurable rather than an attempt to replace general reasoning across Fettler and ReGauge.

The Change Graph, entity-resolution system, evaluation benchmark, trajectories, migration recipes, router outcomes, and specialized weights together constitute Mendpoint's intelligence asset. Model weights alone are not the moat.

---

# 18. Synthetic evaluation and pre-design-partner hardening

## 18.1 Purpose

Before relying on customer repositories to reveal product gaps, Mendpoint SHOULD systematically create adversarial synthetic repositories and migrations designed to make Fettler and ReGauge fail.

The objective is not benchmark optics. It is early discovery of real capability gaps.

## 18.2 Synthetic repository corpus

The evaluation system SHOULD include:

- modern applications;
- monoliths;
- modular monoliths;
- monorepos;
- microservices;
- event-driven systems;
- integration-heavy repositories;
- legacy Java/.NET/Python/PHP patterns;
- mixed-generation architectures;
- AI-generated code failure patterns;
- database-coupled systems;
- dynamic/configuration-driven behavior.

## 18.3 Ground truth

Every synthetic scenario SHOULD have hidden machine-readable ground truth describing:

- intended fault/change;
- architecture truth;
- dependency truth;
- expected findings;
- acceptable variants;
- false-positive traps;
- blast-radius truth;
- preferred remediation;
- scenario tags and difficulty.

The evaluated product MUST NOT have access to the answer key.

## 18.4 Mutation engine

The system SHOULD programmatically generate controlled variants such as:

- API field removal/rename;
- enum semantic change;
- authentication changes;
- webhook changes;
- SDK breakage;
- dependency conflicts;
- runtime upgrades;
- race conditions;
- missing timeouts;
- hidden coupling;
- undocumented dependencies;
- dead-looking but live code;
- database-side business logic;
- insecure migrations.

## 18.5 Difficulty

Scenarios SHOULD span:

```text
L1 obvious
L2 realistic
L3 cross-cutting
L4 ambiguous
L5 adversarial
```

The corpus SHOULD NOT be dominated by easy tests.

## 18.6 Evaluation dimensions

### Fettler

Measure:

- change classification;
- impact recall;
- impact precision;
- root-cause correctness;
- blast-radius correctness;
- evidence quality;
- remediation correctness;
- verification quality;
- false positives;
- false negatives;
- confidence calibration;
- latency/cost.

### ReGauge

Measure:

- architecture reconstruction;
- dependency discovery;
- hidden-dependency recall;
- migration ordering;
- constraint discovery;
- blast-radius prediction;
- modernization plan quality;
- behavior preservation;
- verification;
- confidence calibration;
- latency/cost.

## 18.6.1 Representation benchmark

The synthetic evaluation system SHOULD explicitly compare raw/current retrieval against graph-backed context on identical tasks.

At minimum measure:

```text
A. Muse + current/raw retrieval
B. Muse + Change Graph MissionGraphProjection
C. Muse + Change Graph + DeepSeek verifier where appropriate
```

Use the same task, model, tools, grader, and acceptance criteria wherever possible so that the representation change is isolated.

Separate direct/reference tasks from relationship-heavy tasks. The graph is expected to create the most value on indirect wrappers, transitive impact, runtime dependencies, test-path relationships, shared state, and migration ordering; this MUST be proven rather than assumed.

Measure:

- correctness;
- impact/dependency precision and recall;
- model/tool calls;
- files/context items inspected;
- input/output tokens;
- latency;
- cost;
- false confidence;
- correct abstention/coverage disclosure.

## 18.7 Failure taxonomy

Evaluation failures SHOULD map into a reusable taxonomy such as:

```text
PARSING_FAILURE
LANGUAGE_SUPPORT_FAILURE
REPOSITORY_MAPPING_FAILURE
ARCHITECTURE_INFERENCE_FAILURE
GRAPH_CONSTRUCTION_FAILURE
ENTITY_RESOLUTION_FAILURE
MISSING_GRAPH_EDGE
INCORRECT_GRAPH_EDGE
STALE_GRAPH_EDGE
CONFLICTING_GRAPH_EVIDENCE
GRAPH_COVERAGE_FAILURE
GRAPH_QUERY_FAILURE
CONTEXT_COMPILER_FAILURE
DEPENDENCY_DISCOVERY_FAILURE
RETRIEVAL_FAILURE
CONTEXT_SELECTION_FAILURE
PROMPT_FAILURE
REASONING_FAILURE
TOOL_SELECTION_FAILURE
TOOL_EXECUTION_FAILURE
MODEL_ROUTING_FAILURE
MODEL_CAPABILITY_FAILURE
CONFIDENCE_CALIBRATION_FAILURE
ROOT_CAUSE_FAILURE
BLAST_RADIUS_FAILURE
REMEDIATION_FAILURE
PATCH_FAILURE
TEST_GENERATION_FAILURE
FALSE_POSITIVE
FALSE_NEGATIVE
PERFORMANCE_FAILURE
COST_FAILURE
UX_PRESENTATION_FAILURE
```

## 18.8 Fix loop

Every significant failure SHOULD follow:

```text
reproduce
→ diagnose root cause
→ choose generalized fix
→ implement
→ rerun failing scenario
→ run related regressions
→ run full relevant suite
→ validate hidden holdout
→ capture lesson
```

Scenario-specific hacks are prohibited.

## 18.9 Holdouts

Evaluation MUST distinguish:

- development scenarios visible during debugging;
- regression scenarios added after failures;
- hidden holdouts never used for direct fixing.

Product readiness is measured by generalization to holdouts, not only the development set.

## 18.10 Design-partner readiness gate

Before a new capability is pitched as reliable, the team SHOULD be able to answer:

- which repository/migration classes are well supported;
- which are partially supported;
- which are explicitly unsupported;
- what the largest unresolved P0/P1 risks are;
- whether holdout performance supports the claim;
- whether rollback and review controls work;
- what verification coverage is available.

---

# 19. Security, privacy, and governance

## 19.1 Tenant isolation

Tenant boundaries MUST be enforced across:

- repositories;
- graph data;
- traces;
- prompts/context;
- datasets;
- training corpora;
- model artifacts where private;
- analytics;
- exports.

A tenant-isolation failure is a release-blocking defect.


Provider-global graph knowledge and tenant-private software graphs MUST remain logically separated. A shared provider entity MAY be referenced from many tenants, but tenant-private code/dependency/ownership/runtime relationships MUST NOT be merged across customers.

## 19.2 Least privilege

Repository integrations SHOULD request only permissions required for configured capabilities.

Write permissions SHOULD be separable from read-only analysis when supported.

## 19.3 Secret handling

Mendpoint MUST minimize secret exposure to models and logs.

Controls SHOULD include:

- secret scanning/redaction;
- bounded context assembly;
- credential reference indirection;
- encrypted storage;
- log filtering.

## 19.4 Data residency

Residency policy MUST be enforced before data crosses storage, model, trainer, or analytics boundaries.

## 19.5 Learning consent

Training eligibility MUST be separate from operational processing permission.

A customer may permit Mendpoint to process code to deliver the product while withholding permission for shared model training.

## 19.6 Cross-account learning

Cross-account learning MUST only use data explicitly eligible for that purpose.

Private tenant patterns MAY be represented through tenant-local retrieval, private recipes, or private adapters where supported.

## 19.7 Deletion and revocation

The system MUST maintain enough lineage to identify which datasets and artifacts used a given learning event where policy requires future exclusion or remediation.

The exact legal retention behavior is policy/configuration dependent and should not be hard-coded into this specification.

## 19.8 Auditability

Security- and migration-critical actions MUST be auditable, including:

- source ingestion;
- repository access;
- graph updates;
- model/tool execution;
- edits;
- verification;
- approvals;
- overrides;
- training dataset inclusion;
- candidate promotion;
- rollback.

---

# 20. Reliability and operational behavior

## 20.1 Idempotency

The following operations SHOULD be idempotent by identity where feasible:

- change ingestion;
- repository indexing;
- mission creation from the same trigger;
- task dispatch;
- PR creation;
- training dispatch;
- adapter registration callbacks.

## 20.2 Durable state

Mission and campaign state MUST survive worker/process failure.

## 20.3 Retry policy

Retries SHOULD distinguish:

- transient infrastructure failure;
- deterministic product failure;
- provider/model rate limit;
- invalid input;
- policy rejection.

Deterministic failures SHOULD NOT retry indefinitely.

## 20.4 Reconciliation

Long-running external jobs such as CI, training, or remote repository operations SHOULD support reconciliation after lost callbacks or worker crashes.

## 20.5 Concurrency

The platform SHOULD protect against:

- duplicate task execution;
- conflicting PR creation;
- stale snapshot edits;
- concurrent campaign stage advancement;
- duplicate training.

## 20.6 Drift detection

If the target repository changes materially after analysis, Mendpoint SHOULD detect stale context and revalidate rather than applying old assumptions.

## 20.7 Graceful degradation

When a subsystem is unavailable:

- graph unavailable → do not claim scoped impact;
- model unavailable → use configured fallback or stop safely;
- CI unavailable → mark verification incomplete;
- provider source unavailable → preserve last known state and surface staleness;
- trainer unavailable → learning pipeline queues or fails without affecting core migration delivery.

## 20.8 Graph publication and rollback

Graph rebuilds and extractor changes MUST fail safely.

If a new graph version cannot satisfy required invariants, Mendpoint SHOULD preserve the last valid version and mark new evidence as pending/stale rather than publishing partial corrupt state.

Extractor/entity-resolution changes that cause quality regressions MUST be rollbackable. Mission traces MUST retain the graph version used so prior decisions remain reproducible.

---

# 21. Performance and scale

The previous specification establishes that small-repository Fettler analysis should complete in minutes rather than hours and that large campaigns should provide useful summary output before deep scans finish.

This revision formalizes the performance model without inventing hard thresholds that have not yet been product-approved.

## 21.1 Performance budgets

Every task family SHOULD have configurable budgets for:

```text
time to first useful result
time to complete
model latency
graph query latency
verification latency
token consumption
inference cost
```

## 21.2 Progressive results

Large scans and campaigns SHOULD stream useful partial results while preserving status semantics such as:

```text
partial
coverage percentage
remaining scope
known unknowns
```

## 21.2.1 Graph build and retrieval budgets

Mendpoint SHOULD measure separately:

```text
full graph build time
incremental graph update time
graph publication time
graph query P50/P95
context compilation time
mission subgraph size
raw retrieval fallback rate
```

Graph-backed execution SHOULD also track context-token and tool-call savings against raw/current retrieval on comparable tasks.

## 21.3 Repository scale

The evaluation program MUST measure degradation across:

- small repositories;
- medium repositories;
- large repositories;
- monorepos;
- multi-repository organizations.

Scale-related failures are product gaps, not merely infrastructure issues.

---

# 22. Observability

## 22.1 Trace model

A mission trace SHOULD make it possible to reconstruct:

```text
trigger
→ graph/context
→ task decomposition
→ router decision
→ tools/models
→ candidate
→ verification
→ review
→ outcome
```

## 22.2 Product metrics

### Fettler

- time from provider change to first useful impact;
- time to first PR;
- impact precision/recall where ground truth exists;
- PR acceptance;
- merge rate;
- reviewer correction rate;
- regression rate;
- incidents avoided/remediated where measurable.

### ReGauge

- time to migration blueprint;
- migration stage completion;
- PR batch acceptance;
- exception rate;
- re-plan rate;
- campaign duration;
- residual legacy surface;
- behavior-preservation failures.

## 22.3 Model/router metrics

Track:

- selected model/adapter/tool;
- task family;
- quality/evaluation result;
- verification result;
- reviewer outcome;
- latency;
- tokens;
- cost;
- fallback;
- escalation;
- confidence calibration.

## 22.4 Graph metrics

Track:

- entities/edges by type and epistemic state;
- graph/index freshness;
- graph coverage by task/repository class;
- entity-resolution failures and ambiguity;
- extraction/materialization failures;
- stale/conflicting edges;
- hidden-dependency discoveries;
- graph-induced false positives/false negatives;
- raw-retrieval fallback rate;
- graph query latency;
- context compilation latency;
- context tokens with/without graph representation;
- percentage of Fettler/ReGauge findings supported by explicit evidence paths;
- graph version used per mission.

## 22.5 Learning metrics

Track:

- learning events by provenance;
- eligible vs blocked events;
- destination classification;
- dataset volume and diversity;
- sealed datasets;
- training jobs;
- candidate pass/fail;
- holdout improvement;
- rollback;
- adapter usage.

## 22.6 Business metrics

Retain the existing business metrics:

- MCU consumption per customer;
- gross margin per migration class;
- expansion from Fettler to ReGauge;
- connected repositories;
- logo retention;
- net revenue retention.

---

# 23. User experience specification

## 23.1 Global principles

The product SHOULD:

- show evidence before asking users to trust automation;
- present affected code before proposed edits;
- distinguish confidence, risk, and verification;
- surface uncertainty instead of hiding it;
- organize migration work semantically;
- make the next action obvious;
- support progressive disclosure for deep technical detail;
- allow review without requiring users to understand model internals.

## 23.2 Main surfaces

### Shared

- organization/admin;
- integration management;
- repository inventory;
- audit;
- analytics;
- policy;
- model/automation settings where appropriate.

### Fettler

- change feed;
- provider change detail;
- impact view;
- candidate remediation;
- PR review;
- provider campaign dashboard.

### ReGauge

- modernization objective intake;
- system discovery;
- migration blueprint;
- dependency/stage map;
- PR campaign;
- exceptions;
- modernization report.

## 23.3 Evidence UI

Every finding SHOULD answer:

```text
Claim
Evidence
Graph path
Confidence
Coverage
Risk
Recommended action
Verification
```

## 23.3.1 Graph-path UX

When a material finding is graph-derived, the review experience SHOULD allow the user to inspect a concise evidence path such as:

```text
ProviderChange
→ AFFECTS Endpoint
→ USED_BY SdkMethod
→ WRAPPED_BY InternalClient
→ CALLED_BY checkout.createPayment
→ COVERED_BY_TEST checkoutIntegrationTest
```

The UI SHOULD distinguish deterministic/observed/inferred/stale/conflicting relationships and MUST disclose incomplete graph coverage for high-impact conclusions.

A giant graph visualization is not a product requirement. The graph should be surfaced when it improves a decision.

## 23.4 Confidence UI

Avoid presenting confidence as an unexplained percentage.

Where possible show:

- confidence level;
- evidence basis;
- coverage;
- reasons for escalation or uncertainty.

---

# 24. Integrations

## 24.1 Repository providers

### Required initial capabilities

- GitHub repository connection;
- organization/repository scoping;
- branch/commit checkout;
- draft PR creation;
- PR status/readback;
- CI status readback.

### Planned/extended

- GitLab equivalent capability.

## 24.2 Provider change sources

Support an extensible adapter interface for:

- OpenAPI;
- structured changelogs;
- release notes;
- SDK metadata;
- manual source upload;
- provider-specific feeds.

## 24.3 CI and verification

Integrations SHOULD support both:

- native Mendpoint sandbox verification;
- customer CI invocation/readback.

## 24.4 Runtime/observability data

Runtime metadata is optional but can materially improve hidden-dependency detection. It MUST remain subject to tenant security and scope controls.

---

# 25. Pricing and Migration Compute Units

The existing specification defines a consumption-oriented pricing model centered on a **Migration Compute Unit (MCU)**.

## 25.1 MCU purpose

MCUs provide a normalized unit for migration work that may include:

- graph analysis;
- retrieval/context construction;
- model inference;
- deterministic transformation;
- verification.

The commercial formula is separate from internal raw cost accounting.

## 25.2 Requirements

MCU accounting SHOULD be:

- deterministic enough to explain;
- observable per mission/campaign;
- independent of one model vendor's token pricing;
- compatible with both Fettler and ReGauge;
- capable of reflecting more expensive high-risk verification.

## 25.3 Additional commercial objects

The platform MAY support:

- campaign fees;
- firm-fixed-price migration engagements;
- enterprise minimums;
- provider-sponsored campaigns.

Pricing policy is business configuration, not a hard-coded product invariant.

---

# 26. Go-to-market and product sequencing

## 26.1 Land with Fettler

Fettler remains the preferred entry wedge because external changes are:

- time-sensitive;
- concrete;
- easier to scope;
- easier to demonstrate;
- naturally connected to measurable PR outcomes.

## 26.2 Expand with ReGauge

After Mendpoint earns trust on bounded migration work, ReGauge expands into:

- runtime upgrades;
- framework migrations;
- SDK migrations;
- internal standards;
- architecture modernization.

## 26.3 Initial vertical focus

The previous draft recommends a single-vertical-first launch, with payments/fintech APIs as the strongest default initial provider category, while preserving the option to expand cross-API after evidence accumulates.

For development, this should translate into:

- architecture that is provider-agnostic;
- initial evaluation depth on a small set of providers/migration classes;
- no core-system assumptions that payments is the only vertical;
- explicit measurement of whether the initial vertical produces stronger design-partner pull.

---

# 27. Roadmap and release gates

Roadmap phases are product gates, not merely dates.

## Phase 0 — Internal hardening foundation

Goal: prove the system can be evaluated and improved before customer exposure.

Required:

- shared Mission semantics;
- reliable repository snapshots;
- versioned, evidence-bearing Change Graph baseline;
- entity resolution and at least one materialized indirect relationship;
- raw-vs-graph representation benchmark;
- Fettler end-to-end path;
- ReGauge planning path;
- synthetic repo/evaluation harness;
- regression suite;
- learning-event capture;
- auditability.

Exit gate:

- no unresolved known P0 platform defect;
- repeatable internal E2E;
- hidden holdout evaluation exists;
- known support boundaries documented.

## Phase 1 — Fettler design-partner wedge

Goal: external API changes become useful, reviewable PRs.

Required:

- GitHub;
- OpenAPI/spec diff ingestion;
- impact analysis;
- selected migration classes;
- candidate PR;
- evidence;
- verification;
- review;
- outcome capture.

Exit gate:

- design-partner-ready support matrix;
- rollback and failure behavior proven;
- meaningful adversarial holdouts;
- product can state what it will and will not handle.

## Phase 2 — Fettler campaign scale

Goal: provider changes can be managed across multiple repositories.

Required:

- campaign orchestration;
- multi-provider adapter model;
- better confidence/coverage;
- GitLab if prioritized;
- performance at organization scale;
- richer analytics.

## Phase 3 — ReGauge execution

Goal: internal migration objective becomes staged, validated PR campaign.

Required:

- discovery/topology;
- migration graph;
- staged plan;
- selected migration class execution;
- exception handling;
- stage verification;
- campaign dashboard.

## Phase 4 — Compounding intelligence

Goal: verified outcomes improve cost and quality.

Required:

- governed datasets;
- trainer integration;
- post-trained candidates;
- holdout evaluation;
- router admission;
- shadow/canary;
- rollback;
- recipe extraction;
- router learning;
- own-vs-rent capability matrix;
- shadow evaluation of selected owned-intelligence candidates;
- graph-assisted intelligence cost measurement.

---

# 28. Acceptance criteria

## 28.1 Shared acceptance criteria

A production-grade mission MUST:

- be tenant scoped;
- reference an immutable repository snapshot;
- retain evidence;
- expose graph/context provenance;
- have risk and verification policy;
- produce an auditable trace;
- stop safely on policy failure;
- preserve review state;
- capture outcome.

## 28.1.1 Change Graph acceptance criteria

The Change Graph is production-grade for a supported capability when:

- entity identity is canonical within the declared scope;
- important edges have evidence/provenance;
- graph versions are tied to repository/provider snapshots;
- tenant boundaries are enforced;
- graph coverage/unknowns are explicit;
- stale/conflicting evidence is represented;
- required query primitives are bounded and reproducible;
- a MissionGraphProjection can be generated;
- invalid graph versions fail publication safely;
- hidden holdout evaluation supports claimed relationship coverage;
- graph-vs-raw benchmark results are available for the supported capability.

## 28.2 Fettler acceptance criteria

A supported Fettler migration class is design-partner ready when:

- a provider change can be ingested and semantically classified;
- impacted code is identified with useful precision;
- graph/coverage uncertainty is explicit;
- a reviewable candidate edit can be generated;
- verification status is visible;
- PR packaging works;
- reviewers can accept/reject/edit;
- false positives can be recorded;
- audit history persists;
- hidden holdout results support the claimed capability;
- failure and rollback paths are tested.

## 28.3 ReGauge acceptance criteria

A supported ReGauge migration class is design-partner ready when:

- a modernization objective becomes a structured objective;
- topology and constraints can be reconstructed to a declared coverage level;
- a dependency-aware staged plan is produced;
- at least one bounded stage can generate a validated PR batch;
- exceptions are explicit;
- stage advancement honors verification policy;
- repository drift can trigger revalidation;
- reviewers can change plan or execution;
- campaign progress is durable;
- hidden holdout results support the claimed capability.

## 28.4 Learning-system acceptance criteria

The learning system is production ready when:

- Fettler and ReGauge emit canonical learning events;
- provenance classes are preserved;
- tenant/consent/residency rules are enforced;
- lessons can be routed to the correct improvement destination;
- datasets are versioned and sealable;
- holdout leakage is prevented;
- corpora are deterministic by dataset version;
- external training can be safely dispatched/reconciled;
- candidate lineage is complete;
- candidate evaluation compares against baseline;
- bad candidates are rejected;
- approved candidates can be canaried;
- rollback works;
- production outcomes feed the next learning cycle.

---

# 29. Design-partner readiness scorecard

Every proposed design-partner capability SHOULD have a one-page scorecard containing:

```text
Capability
Supported languages/stacks
Supported repository patterns
Supported providers/frameworks
Known unsupported patterns
Supported graph relationship types
Graph coverage class and runtime-evidence availability
Known dynamic/reflection blind spots
Entity-resolution quality where measurable
Stale/conflicting edge rate where measurable
Evaluation scenario count
Hidden holdout status
Impact precision/recall where measurable
Patch verification rate
False-positive rate
Known P0/P1 issues
Latency range
Cost range
Required human review
Rollback behavior
Security limitations
Owner
Last validated commit/version
```

A capability MUST NOT be represented as broadly supported if the scorecard shows only narrow benchmark coverage.

---

# 30. Risk register

| Risk | Failure mode | Required mitigation |
|---|---|---|
| Incomplete graph | Hidden usage missed | Evidence-backed coverage, hybrid static/runtime data, uncertainty state, human escalation |
| Incorrect graph relationship | False impact or unsafe migration ordering | Provenance, edge epistemic state, deterministic invariants, regression evals, rollbackable graph versions |
| Entity resolution error | Wrong provider/code/runtime identity merged or missed | Multi-signal resolution, ambiguity states, collision tests, human verification for high-risk mappings |
| Stale graph state | Mission reasons over obsolete software/provider relationships | Snapshot/version pinning, invalidation, freshness policy, explicit staleness in UI/router |
| False confidence | Plausible but wrong migration | Calibration, verification, risk policy, holdouts |
| Low trust | Engineers refuse AI-generated PRs | Review-first UX, source evidence, small PRs, visible verification |
| Frontier cost | Poor gross margin | Router, recipes, specialized models, cost telemetry |
| Over-broad scope | Product drifts into generic coding | Migration scope test and product invariants |
| Verification gap | Tests pass but behavior is wrong | Contract/policy checks, coverage display, staged rollout |
| Benchmark overfit | Internal metrics look strong but customers fail | Hidden holdouts, mutation generation, design-partner verification |
| Tenant leakage | Cross-customer data exposure | Isolation, negative tests, lineage, least privilege |
| Training leakage | Holdout enters training | Immutable split identity and dataset lineage |
| Model regression | New adapter harms production | Baseline comparison, shadow/canary, approval, rollback |
| Stale analysis | Repository changes after planning | Snapshot pinning and drift detection |
| Provider ambiguity | Release notes insufficient | Source triangulation, lower confidence, escalation |
| Migration blast radius | Large PR destabilizes system | Staging, dependency ordering, bounded PRs |
| Legacy dynamic behavior | Static graph misses runtime dependency | Runtime evidence where available, explicit coverage gaps |
| Concurrent agents/dev changes | Automation overwrites active work | Worktrees/branches, deliberate merge, versioned evaluation |

---

# 31. Development principles

## 31.1 Fix root causes

When evaluation exposes failure, first determine whether the cause is:

```text
parser
graph
retrieval
context
tool
router
model
prompt
verification
product logic
UX
```

Do not automatically blame the model.

## 31.2 Prefer generalized capability

A fix is successful when it improves unseen related scenarios, not only the one that exposed the bug.

## 31.3 Prefer deterministic mechanisms when possible

If a deterministic parser, graph query, or recipe can solve a problem more reliably than a model, prefer it.

## 31.4 Preserve provenance

Every output worth trusting or learning from should retain enough provenance to understand how it was produced.

## 31.5 Make uncertainty inspectable

Do not hide coverage gaps behind prose confidence.

## 31.6 Keep long-running work resumable

Campaigns, repository analysis, training jobs, and external verification should be durable and reconcilable.

## 31.6.1 Prefer representation over repeated inference

If an important relationship is stable enough to resolve, validate, version, and reuse, Mendpoint SHOULD represent it explicitly rather than paying a model to rediscover it every mission.

Missing instance relationships SHOULD be fixed in entity resolution, graph construction, runtime evidence, or context compilation before model post-training is considered.

## 31.6.2 Keep ontology and instance knowledge separate

Prompts and instructions MAY define semantic types and operating rules. Dynamic tenant/provider instance relationships belong in governed data structures.

## 31.7 Avoid duplicate platforms

There should be one canonical implementation for:

- router;
- graph;
- learning-event schema;
- dataset lifecycle;
- evaluation framework;
- audit/trace model.

New modules should extend these rather than create parallel substitutes.

---

# 32. Architecture decision requirements

Changes to the following SHOULD require an ADR or equivalent explicit decision:

- canonical Mission state machine;
- Change Graph storage architecture or graph partitioning;
- Change Graph ontology compatibility contracts;
- entity-resolution identity rules with persistence implications;
- Change Graph schema primitives;
- tenant isolation model;
- evidence/confidence semantics;
- router policy architecture;
- repository sandbox model;
- learning provenance classes;
- dataset split/holdout guarantees;
- model artifact promotion lifecycle;
- customer-code training policy;
- persistent identifier renames;
- automatic merge/deployment policy.

An ADR SHOULD include:

```text
context
decision
alternatives considered
security impact
data/compatibility impact
migration plan
rollback
evaluation plan
```

---

# 33. Open product decisions

These questions are intentionally left open because the prior specification does not resolve them and they should be decided from implementation/design-partner evidence rather than silently assumed.

## 33.1 Initial provider coverage

Which providers and exact change classes are committed for the first Fettler design partners?

## 33.2 First ReGauge migration class

Which modernization class will be the first fully supported end-to-end ReGauge execution path?

## 33.3 Runtime metadata

How much runtime/observability data is required for initial graph completeness versus optional enhancement?

## 33.4 Enterprise deployment

At what stage are VPC/self-hosted deployment modes required versus roadmap?

## 33.5 Numeric quality gates

What exact precision, recall, verification, latency, and cost thresholds define design-partner and GA readiness by capability?

These SHOULD be configuration/versioned acceptance gates rather than scattered hard-coded constants.

## 33.6 Cross-account learning policy

What customer consent and contractual model will govern use of verified production outcomes for shared post-training?

## 33.7 Private adaptation

When should organization-specific behavior live in retrieval/recipes versus private adapters?

## 33.8 Change Graph storage architecture

Decide, based on measured requirements, whether the production representation should remain relational/virtual, move to a graph-native store, or use a hybrid. This MUST be an evidence-driven operational choice rather than a product-brand decision.

## 33.9 Runtime evidence depth

Determine which runtime sources are required for design-partner claims by language/architecture class and how long observations remain fresh enough to influence coverage.

## 33.10 Graph edge admission policy

Define which relation types may be published from deterministic analysis, runtime observation, model inference, corroboration, or human verification, and which high-risk relations require multiple signals.

## 33.11 Intelligence ownership threshold

Define the quantitative/qualitative gates for moving a capability from rented Muse reasoning to owned/specialized intelligence, including quality, latency, cost, data maturity, and rollback requirements.

## 33.12 Provider-side product

When should provider-sponsored migration campaigns become a first-class commercial product rather than an FDE workflow?

---

# 34. Glossary

**Adapter** — A specialized post-trained model artifact or equivalent specialization that can be selected by the router.

**Blast radius** — The set and severity of systems, code paths, repositories, or runtime behavior that may be affected by a change.

**Campaign** — A coordinated set of related missions or migration stages.

**Candidate Edit** — A proposed code change that has not yet been accepted.

**Change Graph** — Mendpoint's versioned, evidence-bearing representation of provider, code, runtime, verification, migration, and outcome relationships.

**Context Compiler** — The component that converts bounded Change Graph query results and supporting evidence into the minimum sufficient structured context for a Mission or MigrationTask.

**Coverage** — The degree to which Mendpoint has inspected and represented the relevant system scope.

**Entity Resolution** — Mapping heterogeneous aliases, wrappers, source objects, and runtime identities to canonical Change Graph entities using evidence.

**Epistemic Status** — How a graph fact is known or trusted, such as deterministic, observed, inferred, corroborated, stale, or conflicting.

**Evidence** — A source or observation supporting a finding, recommendation, graph edge, or verification result.

**Graph Coverage** — The declared completeness/unknown state of graph relationships relevant to a task; distinct from model confidence and migration risk.

**MissionGraphProjection** — A bounded, versioned, evidence-bearing Change Graph view compiled for one mission or task.

**Relationship Materialization** — Resolving and storing a useful relationship during graph build/update so future missions can traverse it instead of re-inferring it.

**Fettler** — Mendpoint's external-change remediation product.

**Holdout** — Evaluation data excluded from model or product-specific training/debugging and reserved for generalization measurement.

**Learning Event** — Governed structured outcome data that may create an improvement lesson.

**MCU** — Migration Compute Unit, Mendpoint's normalized consumption unit for migration work.

**Migration Objective** — Structured statement of desired internal modernization used by ReGauge.

**Migration Recipe** — Versioned deterministic transformation playbook for a known migration pattern.

**Migration Task** — Bounded structured work unit executed by tools, recipes, or models.

**Mission** — Primary execution unit representing a migration problem and its lifecycle.

**ProviderChange** — Structured representation of an external API/SDK/contract change.

**ReGauge** — Mendpoint's internal modernization and legacy migration product.

**Risk** — Expected consequence if an inference or action is wrong.

**Router** — Policy system selecting tools, recipes, models, or adapters for a task.

**Verification** — Observed test or validation evidence for a candidate migration.

---

# 35. Canonical end-to-end flows

## 35.1 Fettler

```text
Provider source
    ↓
Ingestion
    ↓
ProviderChange
    ↓
Semantic classification
    ↓
Change Graph query/index
    ↓
Impact findings
    ↓
Blast-radius + coverage assessment
    ↓
Migration tasks
    ↓
Router
    ├─ deterministic tool/recipe
    ├─ specialized adapter/model
    └─ frontier escalation
    ↓
Candidate edits
    ↓
Verification
    ↓
Review package
    ↓
Draft PR
    ↓
Reviewer outcome
    ↓
Learning event
    ↓
Graph / recipe / router / model / product improvement
```

## 35.2 ReGauge

```text
Migration objective
    ↓
Structured MigrationObjective
    ↓
Repository/system discovery
    ↓
Change Graph
    ↓
Constraints + dependencies
    ↓
Migration graph
    ↓
Staged plan
    ↓
Stage approval
    ↓
Migration tasks
    ↓
Router
    ↓
Candidate PR batch
    ↓
Verification
    ↓
Review
    ↓
Stage advance / re-plan / exception
    ↓
Campaign completion
    ↓
Learning events
    ↓
Graph / recipe / router / model / product improvement
```

## 35.3 Learning

```text
Synthetic ground truth
or
Design-partner verified outcome
or
Production verified outcome
    ↓
LearningEvent
    ↓
Eligibility + governance
    ↓
Lesson validation
    ↓
Destination classification
    ├─ parser/tool/product fix
    ├─ graph/retrieval fix
    ├─ recipe
    ├─ router policy
    ├─ calibration
    └─ model training
           ↓
        dataset
           ↓
        sealed corpus
           ↓
        external trainer
           ↓
        candidate adapter
           ↓
        hidden holdout evaluation
           ↓
        shadow/canary
           ↓
        human promotion
           ↓
        router eligibility
           ↓
        new outcomes
           ↺
```

---

# 36. Definition of product maturity

Mendpoint should not describe itself as mature because a demo generates plausible code.

Maturity increases through five levels:

## Level 1 — Demonstrable

A narrow migration can be completed end to end under controlled conditions.

## Level 2 — Evaluated

The capability has adversarial synthetic coverage, regression tests, and hidden holdouts.

## Level 3 — Design-partner ready

Known support boundaries are explicit, review/rollback works, security controls are in place, and the capability can withstand realistic customer variation.

At this level, supported graph relationship coverage, blind spots, hidden holdout performance, and evidence-path behavior are documented for the design-partner capability.

## Level 4 — Production reliable

The capability demonstrates durable verification, low severe-regression rates, operational observability, and safe failure behavior across real customer use.

At this level, graph versioning, invalidation, rollback, tenant isolation, and representation-aware routing are operationally reliable.

## Level 5 — Compounding

Verified outcomes measurably improve routing, recipes, graph intelligence, verification, or specialized models without degrading governance or generalization.

The long-term objective is not simply autonomous migration. It is **trusted, compounding migration intelligence**.

---


# 36.1 Research-informed representation validation

The representation-first architecture is informed in part by Rox's August 16, 2026 research article, *Empirical Analysis of Agentic Retrieval: Knowledge Graphs vs. Relational Schemas in CRM Workflows*, which compares agent retrieval over relational schemas with knowledge-graph representations. That research reported that direct/keyed questions can perform similarly while relationship-heavy questions can diverge sharply when the required instance relationships are absent from the raw schema; additional reasoning compute did not recover relationships that were not represented.

Mendpoint treats these results as a **hypothesis generator**, not proof that the same gains will occur in software migration.

Therefore Mendpoint MUST validate the thesis with its own controlled experiments on:

- direct vs relationship-heavy migration tasks;
- identical Muse 1.2 baselines under raw vs graph context;
- hidden holdouts;
- graph-induced false positives/negatives;
- context/token/tool-call efficiency;
- latency and cost;
- static-only vs hybrid static/runtime coverage;
- effect of independent DeepSeek V4 Flash verification.

No external benchmark result SHOULD be used as a Mendpoint customer or investor performance claim without Mendpoint-specific evidence.

---

# 37. Final product statement

Mendpoint is building the migration layer for software, with the Change Graph as its durable relationship memory and representation substrate.

**Fettler** turns external provider change into graph-scoped, evidence-backed, verified, reviewable remediation.

**ReGauge** turns internal modernization intent into dependency-aware, staged, verified migration campaigns.

They share the same Change Graph, router, execution system, verification layer, governance model, evaluation framework, and learning flywheel.

The product advantage compounds when every migration leaves behind more than a merged PR: it leaves behind structured evidence about what changed, what depended on it, what remediation worked, what verification mattered, what model or recipe was sufficient, what reviewers corrected, and how the system should behave the next time.

That is the foundation Mendpoint should build against.
