# Codex Master Prompt — Make the Mendpoint Change Graph the Intelligence Substrate

## Mission

You are responsible for turning Mendpoint's **Change Graph** from an important supporting component into the **canonical software-relationship representation layer** used by Fettler, ReGauge, the model router, verification, evaluation, and the learning flywheel.

This is an implementation task, not a strategy memo.

The primary external research input is:

`https://www.rox.com/articles/knowledge-graphs-vs-relational-schemas`

Read the full article before making architectural decisions.

The important lesson to test and apply is not "use a graph database."

It is:

> **When a task depends on relationships that are difficult or impossible to recover reliably at query time, resolve those relationships once, materialize them as durable graph edges with provenance, and let agents traverse the resulting representation instead of repeatedly reconstructing the world from raw records, files, schemas, search results, or prose.**

For Mendpoint, the hypothesis is:

> **Muse 1.2 should spend its reasoning budget on migration reasoning, not repeatedly rediscovering software relationships that Mendpoint can resolve, validate, version, and reuse in the Change Graph.**

The desired result is a representation-first Mendpoint architecture in which:

```text
raw software environment
        ↓
entity resolution
        ↓
relationship materialization
        ↓
versioned Change Graph
        ↓
small, evidence-backed task subgraph
        ↓
router
        ↓
deterministic recipe / owned intelligence / Muse 1.2
        ↓
DeepSeek V4 Flash verification when justified
        ↓
reviewable migration
        ↓
verified outcome
        ↓
graph learning + model/harness learning
        ↺
```

Do not merely document this architecture.

Inspect the existing repository, identify what already exists, implement the smallest high-value vertical slice, benchmark it against the existing retrieval approach, fix the gaps discovered, and leave the repository with a repeatable path for expanding graph intelligence.

---

# 1. Canonical Mendpoint Context

Mendpoint is building the migration layer for software.

## Fettler

Fettler handles **external change**:

```text
provider / API / SDK change
→ semantic change understanding
→ impact analysis
→ affected code
→ remediation
→ verification
→ reviewable PR
```

## ReGauge

ReGauge handles **internal and legacy modernization**:

```text
modernization objective
→ architecture reconstruction
→ dependency and risk analysis
→ phased migration plan
→ staged code changes
→ verification
→ reviewable PR campaign
```

They share the same core:

```text
Mission
Change Graph
evidence model
context assembly
policy/model router
tools
verification
migration history
evaluation
learning flywheel
```

Canonical product names are:

- **Fettler**
- **ReGauge**

Do not reintroduce Warden or Transformer as customer-facing names.

---

# 2. Current Model Roles

Treat the following as current architecture unless repository configuration proves otherwise.

## Muse 1.2

Muse 1.2 is Mendpoint's primary generation and reasoning model.

It should be used where genuine semantic reasoning, novel migration planning, code generation, or ambiguity remains after Mendpoint has assembled the best available structured context.

## DeepSeek V4 Flash

DeepSeek V4 Flash is the inexpensive independent verifier.

Its intended role includes:

- candidate ranking
- Best-of-N verification
- completion verification
- progress verification
- plan comparison
- detecting likely Muse mistakes
- calibration

It is a **soft verifier signal**, not ground truth.

## Deterministic systems

Prefer deterministic behavior where possible:

- parsers
- static analysis
- contract diffing
- graph traversal
- rules
- recipes
- compiler/build
- tests
- graph invariants
- schema validation

The Change Graph should reduce the amount of work delegated to probabilistic models when the required relationships are already knowable.

---

# 3. External Research Lessons to Validate

Read the Rox article directly and preserve its important distinctions.

Do not copy its CRM ontology into Mendpoint.

Translate the underlying representation principles into the software-migration domain.

Key hypotheses to test:

## 3.1 Representation can dominate model scale

Rox's experiment found a very large gap between relational/raw-table retrieval and graph-based retrieval on questions that depended on relationships not natively represented in the relational schema.

The lesson for Mendpoint is:

> Bigger models and more reasoning tokens cannot reliably recover relationships that the representation layer does not make reachable.

Test this with Mendpoint's own tasks.

Do not assume the result transfers automatically.

## 3.2 Direct/keyed and relationship/unkeyed tasks behave differently

Some questions are easy because the answer follows explicit keys or direct references.

Software equivalents include:

- Which package version is installed?
- Which file directly imports package X?
- Which function directly calls SDK method Y?
- Which OpenAPI endpoint changed?

Other tasks require materialized relationships:

- What is the complete blast radius of this API change through wrappers and service boundaries?
- Which seemingly unrelated services depend on a changed schema?
- Which test actually validates the runtime path affected by the change?
- Which modernization stage must occur first?
- Which code appears dead statically but still executes?
- Which SDK wrapper indirectly consumes a changed provider endpoint?

Build this distinction into Mendpoint's graph benchmark.

## 3.3 Resolve once, traverse many times

Expensive relationship inference should move from repeated online model calls into an offline/incremental graph-build process where results can be tested.

Mendpoint should prefer repeated query-time inference only when the relationship cannot yet be safely materialized.

## 3.4 Type-level knowledge and instance-level facts are different

A prompt can teach:

```text
Functions can call SDK methods.
Services can depend on other services.
Tests can cover runtime paths.
Migration stages can have ordering constraints.
```

That is ontology/type-level knowledge.

The graph must store:

```text
checkout.ts:createPayment
USES_SDK_METHOD
stripe.paymentIntents.create
```

and:

```text
paymentIntegrationTest
COVERS
checkout.ts:createPayment
```

Those are instance-level facts.

Do not try to stuff dynamic, high-cardinality instance facts into system prompts, `AGENTS.md`, skills, or model weights.

## 3.5 A graph is a semantic abstraction, not necessarily the primary database

Do not assume this initiative requires replacing Postgres or introducing Neo4j.

The Change Graph may be implemented as:

- graph-native storage
- relational edge tables
- materialized views
- an ontology/virtual graph over existing stores
- a combination

Choose based on existing architecture and measured performance.

The important requirement is a durable, typed, queryable relationship representation with provenance and versioning.

---

# 4. Parallel-Agent Safety

Claude Code may be working in parallel.

Before writing code:

1. read `AGENTS.md`
2. read `docs/agents/OPERATING_PROTOCOL.md`
3. read `REVIEW.md`
4. read the canonical Mendpoint Product & Platform Specification
5. inspect `git status`
6. inspect worktrees
7. fetch the latest remote state
8. inspect open Claude issues and PRs
9. identify overlapping graph/eval/router files
10. claim the task in GitHub if the current workflow supports task claims

Use a Codex-owned isolated worktree.

Suggested branch:

```text
codex/change-graph-intelligence
```

Do not overwrite Claude-owned work.

If Claude is already modifying the synthetic evaluation harness, integrate through its interfaces instead of rebuilding it.

If another agent is changing core graph architecture, either sequence the changes or create an explicit dependent/stacked plan. Do not let Git conflict resolution decide architecture.

---

# 5. Product-Level Architectural Principle

Make this a first-class engineering principle:

> **The Change Graph is Mendpoint's canonical representation of software relationships.**

The graph should be the durable memory of:

- what software entities exist
- how they are connected
- what changed
- what depends on the changed entity
- what executes at runtime
- what tests provide coverage
- what migration order is safe
- which evidence supports each relationship
- how current each relationship is
- what is unknown or conflicting

Models should reason over **task-specific graph projections**, not an indiscriminate dump of the graph.

---

# 6. Target Architecture

Work toward this architecture:

```text
                         RAW INPUTS

        ┌──────────────────┼───────────────────┐
        │                  │                   │
   source code         provider data       runtime data
   AST/symbols         OpenAPI/specs        traces
   imports/calls       SDK releases         deployment
   configs             changelogs           telemetry
        │                  │                   │
        └──────────────────┼───────────────────┘
                           ▼
                  NORMALIZATION LAYER
                           │
                           ▼
                    ENTITY RESOLUTION
                           │
                           ▼
                RELATIONSHIP MATERIALIZATION
                           │
                           ▼
                   MENDPOINT CHANGE GRAPH
                     versioned + evidenced
                           │
                 ┌─────────┴─────────┐
                 │                   │
           GRAPH QUERY          COVERAGE MODEL
                 │                   │
                 └─────────┬─────────┘
                           ▼
                     CONTEXT COMPILER
                           │
                           ▼
                     POLICY ROUTER
                           │
          ┌────────────────┼─────────────────┐
          │                │                 │
   deterministic       owned/specialized    Muse 1.2
      recipe             intelligence          │
          │                │                   │
          │                │          uncertain/high risk
          │                │                   ▼
          │                │          DeepSeek V4 Flash
          └────────────────┴───────────────────┘
                           │
                           ▼
                      VERIFICATION
                           │
                           ▼
                    REVIEWABLE CHANGE
                           │
                           ▼
                     VERIFIED OUTCOME
                           │
             ┌─────────────┴──────────────┐
             │                            │
       GRAPH LEARNING              MODEL/HARNESS LEARNING
             │                            │
             └─────────────┬──────────────┘
                           ▼
                    BETTER MENDPOINT
```

---

# 7. Phase 0 — Repository Archaeology

Before designing new graph infrastructure, map what exists.

Search for:

```text
graph
change graph
dependency
entity
edge
node
symbol
AST
parser
call graph
import graph
repository snapshot
runtime
trace
coverage
impact
blast radius
evidence
confidence
mission
fettler
regauge
retrieval
context
router
learning
evaluation
```

Trace:

- graph storage
- graph-building pipelines
- snapshot/version semantics
- query APIs
- static-analysis support
- provider graph
- repository graph
- runtime evidence
- test graph
- evidence model
- confidence/coverage model
- impact analysis
- ReGauge dependency planning
- router graph inputs
- learning-event graph signals

Create:

`docs/graph/CURRENT_STATE.md`

Document:

### Existing entities
What node/entity types already exist?

### Existing relations
What edges/relationships already exist?

### Derivation
How is each relation produced?

### Persistence
Where is graph state stored?

### Versioning
How does graph state relate to immutable repository snapshots?

### Evidence
Can every edge be traced back to evidence?

### Coverage
Does Mendpoint know when the graph is incomplete?

### Querying
What graph queries are used by Fettler/ReGauge?

### Runtime
What runtime relationships can be captured?

### Learning
How do graph failures become lessons?

### Gaps
What prevents the graph from operating as the canonical representation layer today?

Do not create a second graph system if an existing one can be extended.

---

# 8. Phase 1 — Create or Refine the Change Graph Ontology

Define an explicit, versioned Mendpoint ontology.

The ontology describes **relationship types that can exist**.

It is not the instance graph itself.

Create or refine a canonical schema for graph entity and relationship types.

Potential entity classes include:

## External/provider

```text
Provider
ProviderVersion
ApiSpec
ApiVersion
Endpoint
Schema
SchemaField
Sdk
SdkVersion
SdkMethod
ProviderChange
Deprecation
```

## Repository/code

```text
Organization
Repository
RepositorySnapshot
Branch
Package
Module
File
Symbol
Function
Method
Class
Interface
Config
FeatureFlag
```

## Runtime/infrastructure

```text
Service
Runtime
Environment
Deployment
Database
Table
Queue
Topic
Job
Cron
RuntimePath
```

## Verification

```text
Test
TestSuite
CIJob
VerificationRun
PolicyCheck
```

## Ownership/workflow

```text
Owner
Team
Mission
MigrationTask
CandidateEdit
PullRequest
MigrationStage
ReviewDecision
```

Do not add entity types merely because they are imaginable.

Add them when they answer real Fettler/ReGauge questions.

---

# 9. Relationship Ontology

Potential edge types include:

## Structural

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

## Provider/API

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

## Runtime

```text
EXECUTES_AS
OBSERVED_CALLING
READS_FROM
WRITES_TO
PUBLISHES_TO
CONSUMES_FROM
DEPLOYED_WITH
OBSERVED_AT_RUNTIME
```

## Testing/verification

```text
COVERED_BY_TEST
VERIFIED_BY
FAILED_VERIFICATION
PASSED_VERIFICATION
```

## Ownership

```text
OWNED_BY
REVIEWED_BY
```

## Migration

```text
MIGRATES_TO
MUST_PRECEDE
BLOCKS
REQUIRES_STAGE
PRESERVES_CONTRACT
REMEDIATED_BY
```

Do not use vague catch-all relation types when a stable semantic type exists.

The ontology should be extensible without requiring broad persistence migrations each time a new relation type is added.

---

# 10. Phase 2 — Separate Ontology From Instance Facts

Preserve this distinction in code and documentation.

## Type-level knowledge

Example:

```text
USES_ENDPOINT connects a code symbol/service to an API endpoint.
```

## Instance-level fact

Example:

```text
checkout.createPayment
USES_ENDPOINT
stripe:/v1/payment_intents
```

The first belongs in ontology/schema documentation.

The second belongs in the graph.

Never use system prompts as the primary store for instance relationships.

---

# 11. Phase 3 — Canonical Graph Entity Contract

Reuse existing domain types where possible.

Conceptually, every graph entity should support:

```json
{
  "entity_id": "",
  "tenant_id": "",
  "graph_version": "",
  "snapshot_id": "",
  "entity_type": "",
  "canonical_key": "",
  "attributes": {},
  "source_refs": [],
  "first_observed_at": "",
  "last_observed_at": "",
  "valid_from": "",
  "valid_to": null
}
```

Do not blindly implement this exact JSON if existing schemas are better.

Required properties:

- tenant scoped
- canonical identity
- repository/provider snapshot association where relevant
- temporal validity
- evidence/source reference
- deterministic serialization where possible

---

# 12. Phase 4 — Canonical Graph Edge Contract

Every materialized relationship should be an evidence-bearing object.

Conceptually:

```json
{
  "edge_id": "",
  "tenant_id": "",
  "graph_version": "",
  "source_entity_id": "",
  "target_entity_id": "",
  "relationship_type": "",
  "derivation": "",
  "evidence_refs": [],
  "confidence": null,
  "status": "",
  "extractor_version": "",
  "first_observed_at": "",
  "last_observed_at": "",
  "valid_from": "",
  "valid_to": null
}
```

Possible `derivation` values:

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

Possible status concepts:

```text
OBSERVED
INFERRED
VERIFIED
CONFLICTING
STALE
INVALIDATED
```

Reuse existing terminology if available.

Do not give every edge an arbitrary numeric confidence if no calibrated confidence exists.

---

# 13. Provenance Is Mandatory

A reviewer or model must be able to ask:

> Why does Mendpoint believe this edge exists?

For every non-trivial edge preserve enough provenance to trace it to:

- source file and location
- spec/version
- static analyzer result
- runtime trace
- test result
- migration outcome
- human decision
- model extraction event

For inferred edges, preserve:

- extractor/model version
- inputs/evidence refs
- verification state

Do not store hidden chain-of-thought.

---

# 14. Phase 5 — Entity Resolution

Implement or strengthen entity resolution.

Software has the same identity problem as enterprise data.

Examples:

```text
SDK alias
package alias
renamed service
repo/module rename
generated client vs canonical API
internal wrapper vs provider endpoint
multiple schemas referring to the same contract
runtime service name vs repository service name
```

The graph should resolve these into canonical entities when evidence permits.

Do not use brittle string matching as the final resolution method for ambiguous entities.

Use multiple signals where necessary:

- package metadata
- import path
- source location
- OpenAPI operation IDs
- SDK metadata
- repository configuration
- runtime telemetry
- build graph
- owner/team data
- historical migration evidence

Entity resolution should be testable independently.

---

# 15. Entity Resolution Confidence

For ambiguous mappings, preserve uncertainty.

Conceptually:

```text
RESOLVED
PROBABLE
AMBIGUOUS
UNRESOLVED
CONFLICTING
```

Do not force ambiguous entities into one canonical identity merely to simplify graph traversal.

High-risk missions should see ambiguity explicitly.

---

# 16. Phase 6 — Relationship Materialization

Move high-value repeated inference offline/incrementally.

Examples:

Instead of asking Muse on every task:

> Which functions indirectly consume this API through wrappers?

materialize:

```text
Function
→ WRAPS
→ InternalSDKMethod
→ USES_SDK_METHOD
→ ProviderSDKMethod
→ USES_ENDPOINT
→ Endpoint
```

Instead of repeatedly asking:

> Which test exercises this path?

materialize:

```text
Function
→ COVERED_BY_TEST
→ IntegrationTest
```

when supported by evidence.

Instead of asking ReGauge to reconstruct migration order every run, materialize stable constraints:

```text
Service A
→ DEPENDS_ON
→ Service B
```

and derive:

```text
MigrationStage B
→ MUST_PRECEDE
→ MigrationStage A
```

when the dependency semantics justify it.

---

# 17. Offline/Incremental Graph Build

Do not rebuild the entire graph on every event if incremental invalidation is safe.

Target:

```text
repository/provider change
        ↓
detect changed entities
        ↓
invalidate affected graph region
        ↓
re-resolve impacted entities
        ↓
re-materialize impacted edges
        ↓
verify invariants
        ↓
publish new graph version
```

Graph versions should be immutable enough for missions to reference a stable view.

A running mission should not silently change meaning because the graph updated underneath it.

---

# 18. Phase 7 — Temporal Graph Semantics

Mendpoint operates on software that changes over time.

The graph must answer not only:

> What depends on this?

but:

> What depended on this in the repository/provider state used by this mission?

Support temporal/version semantics for:

- repository snapshots
- provider API versions
- SDK versions
- migration stages
- runtime observations
- test coverage
- ownership
- graph derivations

Missions should reference explicit graph/snapshot versions.

---

# 19. Phase 8 — Graph Coverage and Completeness

Graph incompleteness must be first-class.

Do not let "we have a graph" imply "the graph is complete."

For each mission/subgraph, expose coverage state.

Potential concepts:

```text
KNOWN_COMPLETE
HIGH_COVERAGE
PARTIAL
UNKNOWN
CONFLICTING
STALE
```

Only use numeric completeness/confidence if it is empirically calibrated.

Coverage should consider relevant sources:

- static analysis
- dynamic/runtime evidence
- generated code
- reflection/dynamic dispatch
- configuration
- shell/cron jobs
- database procedures
- tests
- external services

---

# 20. Graph Coverage Should Affect Product Behavior

Examples:

```text
high graph coverage + deterministic migration
→ recipe / cheap specialized path
```

```text
partial coverage + medium risk
→ Muse 1.2 + explicit uncertainty
```

```text
partial/unknown coverage + high blast radius
→ Muse 1.2 + DeepSeek verification + required human review
```

```text
conflicting graph evidence
→ stop or escalate
```

Do not allow the system to claim precise blast radius from low-coverage evidence.

---

# 21. Phase 9 — Graph Query Layer

Create or strengthen a graph query abstraction.

Fettler and ReGauge should not hand-roll unrelated graph traversal logic across product modules.

The query layer should support product questions such as:

## Fettler

```text
provider change
→ directly affected endpoints/schemas/SDK methods
→ consuming symbols
→ wrapper/indirect consumers
→ dependent modules/services
→ relevant tests
→ owners
```

## ReGauge

```text
migration target
→ dependent components
→ runtime dependencies
→ shared state/data stores
→ stage ordering constraints
→ tests
→ rollout boundaries
→ exceptions
```

Keep queries bounded and task-specific.

---

# 22. Context Compiler

Do not pass the entire graph to Muse.

Build a **Context Compiler** that converts a graph query into a compact evidence pack.

Output should favor typed structure over prose.

Conceptually:

```json
{
  "mission": {},
  "changed_entities": [],
  "impact_paths": [],
  "relevant_edges": [],
  "coverage": {},
  "conflicts": [],
  "stale_edges": [],
  "recommended_tests": [],
  "evidence_refs": []
}
```

The objective is:

> minimum sufficient structured context.

Measure context-token reduction as a first-class metric.

---

# 23. Phase 10 — Representation Benchmark

Before making the graph mandatory for every task, prove its value.

Create a benchmark comparing at least:

## A — Existing/raw retrieval

```text
Muse 1.2
+ current repository retrieval/search
+ current relational/metadata access
```

## B — Graph representation

```text
Muse 1.2
+ Change Graph traversal
+ compact graph evidence pack
```

## C — Graph + independent verification

```text
Muse 1.2
+ Change Graph
+ DeepSeek V4 Flash verification
```

Where possible, keep:

- model
- task
- acceptance criteria
- test environment
- grader

identical.

Change only the representation/context strategy.

---

# 24. Direct vs Relationship Task Families

Explicitly split benchmark tasks.

## Direct/reference tasks

Examples:

```text
Which version of SDK X is installed?
Which file directly imports Y?
Which endpoint changed?
Which function calls SDK method Z directly?
```

These establish the baseline cost/overhead of graph abstraction.

## Relationship tasks

Examples:

```text
What is the full blast radius of this API change?
Which indirect wrappers ultimately consume this endpoint?
Which services break if this schema changes?
Which tests actually cover the affected runtime path?
Which migration stage must occur first?
Which legacy component appears unused statically but executes at runtime?
Which modules share state that prevents independent migration?
```

The graph must prove itself primarily on relationship tasks.

---

# 25. Benchmark Metrics

Measure:

## Correctness

```text
impact recall
impact precision
root-cause correctness
dependency correctness
migration ordering correctness
test/verification selection correctness
false positives
false negatives
```

## Retrieval efficiency

```text
number of retrieval/tool calls
repeated searches
graph queries
files/context items examined
```

## Model efficiency

```text
input tokens
output tokens
latency
cost
```

## Product safety

```text
overconfident wrong answers
correct abstentions
coverage gaps surfaced
stale-edge failures
incorrect graph-edge failures
```

Do not use only aggregate accuracy.

---

# 26. Holdout Discipline

Maintain:

```text
development
validation
hidden holdout
```

Do not let graph extraction rules, prompts, or model logic see hidden holdout answers.

Synthetic repository generators should produce unseen variants.

The question is:

> Did the representation improve the capability?

not:

> Did we tune the graph to the benchmark?

---

# 27. Phase 11 — Graph Failure Taxonomy

Every graph-related failure should be classified.

Start with:

```text
ENTITY_RESOLUTION_MISS
ENTITY_RESOLUTION_COLLISION
MISSING_ENTITY
MISSING_EDGE
INCORRECT_EDGE
STALE_EDGE
CONFLICTING_EDGE
WRONG_RELATION_TYPE
ONTOLOGY_GAP
STATIC_ANALYSIS_GAP
RUNTIME_EVIDENCE_GAP
TEST_COVERAGE_EDGE_GAP
QUERY_PLANNER_FAILURE
CONTEXT_COMPILER_FAILURE
COVERAGE_ESTIMATION_FAILURE
TEMPORAL_VERSION_FAILURE
PROVENANCE_FAILURE
GRAPH_INDUCED_FALSE_POSITIVE
GRAPH_INDUCED_FALSE_NEGATIVE
```

Expand based on evidence.

---

# 28. Phase 12 — Failure Destination Classification

Do not automatically train Muse when graph-based reasoning fails.

Route failures correctly.

Examples:

```text
missing import relation
→ parser/static analyzer
```

```text
wrapper not resolved to provider SDK
→ entity resolution / relationship materialization
```

```text
runtime-only dependency missing
→ runtime evidence ingestion
```

```text
correct edge exists but not retrieved
→ graph query/context compiler
```

```text
correct subgraph supplied but Muse still reasons incorrectly
→ model/harness candidate
```

```text
Muse output plausible but verifier misses defect
→ verifier criteria/calibration
```

This must integrate with the existing Mendpoint lesson-classification system.

---

# 29. Critical Rule — Do Not Train Around Representation Failures

Institutionalize:

> **Missing instance relationship ≠ model training problem.**

Before post-training, determine:

1. Did the relationship exist in the graph?
2. Was it current?
3. Was it supported by evidence?
4. Did the query retrieve it?
5. Did the context compiler include it?
6. Only then ask whether the model failed to use it.

This should become part of evaluation failure analysis.

---

# 30. Phase 13 — Runtime + Static Hybrid Graph

Static analysis alone is insufficient for some legacy systems.

Build toward hybrid evidence.

Potential sources:

```text
AST/import graph
symbol/call graph
build/dependency metadata
OpenAPI/SDK mappings
configuration
CI/test execution
runtime traces
APM
logs where permitted
deployment metadata
database access patterns
queue/topic usage
cron/jobs
```

Do not ingest broad production telemetry without governance.

Use only data permitted by customer/security policy.

---

# 31. Dynamic/Reflection Risks

Explicitly handle graph blind spots such as:

```text
reflection
dynamic imports
runtime plugin loading
generated code
ORM indirection
stored procedures
shell scripts
cron
feature flags
environment-specific routing
message buses
shared databases
```

These are especially important to ReGauge.

The graph should report known blind spots instead of silently pretending static analysis is exhaustive.

---

# 32. Phase 14 — Test and Verification Graph

Tests are not just files.

Materialize useful relationships when evidence supports them:

```text
Test
COVERS
Symbol / Endpoint / RuntimePath / MigrationInvariant
```

Distinguish:

```text
STATICALLY_ASSOCIATED
OBSERVED_COVERAGE
CONTRACT_TEST
INTEGRATION_TEST
SMOKE_TEST
```

The graph should help Fettler and ReGauge choose the most relevant verification work instead of running or reading everything.

---

# 33. Phase 15 — Migration Constraint Graph

ReGauge should gain a migration-constraint layer.

Potential relationships:

```text
MUST_PRECEDE
BLOCKS
SHARES_STATE_WITH
REQUIRES_COMPATIBILITY_WITH
CAN_MIGRATE_INDEPENDENTLY
REQUIRES_DUAL_WRITE
REQUIRES_BACKWARD_COMPATIBILITY
```

Only materialize semantics when evidence supports them.

Do not turn speculative planning into persistent "facts" without marking it inferred/provisional.

---

# 34. Phase 16 — Fettler Graph Intelligence

Optimize Fettler's hot path:

```text
ProviderChange
        ↓
resolve changed provider entities
        ↓
traverse affected endpoint/schema/SDK edges
        ↓
find direct + indirect consumers
        ↓
expand through dependency/runtime edges
        ↓
locate relevant tests + owners
        ↓
produce bounded impact subgraph
        ↓
Muse remediation
```

The graph should allow Fettler to answer:

- What exactly changed?
- Which code consumes the changed contract?
- Through what dependency path?
- Which impacts are direct vs indirect?
- Which findings are uncertain?
- What tests are relevant?
- Who owns the affected code?
- What is the smallest safe remediation scope?

---

# 35. Fettler Evidence UX Contract

Impact findings should be explainable as paths.

Example:

```text
ProviderChange
→ AFFECTS
→ Endpoint
→ USED_BY
→ SDKMethod
→ WRAPPED_BY
→ InternalClient
→ CALLED_BY
→ checkout.createPayment
→ COVERED_BY_TEST
→ checkoutIntegrationTest
```

A reviewer should be able to inspect the path and evidence.

Do not reduce the graph to an opaque confidence number.

---

# 36. Phase 17 — ReGauge Graph Intelligence

Optimize ReGauge's discovery/planning path:

```text
modernization objective
        ↓
select relevant graph scope
        ↓
reconstruct topology
        ↓
identify hidden/runtime relationships
        ↓
identify shared state and constraints
        ↓
derive migration boundaries
        ↓
derive safe sequencing candidates
        ↓
Muse plan reasoning
        ↓
verification
```

The graph should allow ReGauge to answer:

- What actually depends on the target?
- What runtime dependencies are absent from obvious imports?
- What business logic is hidden outside primary application code?
- What can migrate independently?
- What must remain compatible?
- Which stage must precede another?
- What is the rollback boundary?
- Where is graph coverage too weak to automate safely?

---

# 37. Phase 18 — Router Integration

Graph state should become a first-class router input.

Potential inputs:

```text
graph coverage
edge confidence
conflicts
staleness
impact-path length
number of affected services
runtime evidence availability
test coverage availability
relation types involved
dynamic-language/runtime risk
```

The router should eventually choose among:

```text
deterministic recipe
owned/specialized model
Muse 1.2
Muse Best-of-N
Muse + DeepSeek V4 Flash
human escalation
```

Do not implement arbitrary permanent thresholds without benchmark evidence.

Start with explicit configurable policy and telemetry.

---

# 38. Router Policy Hypothesis

Test:

```text
high coverage
+ low ambiguity
+ low risk
→ deterministic / owned / cheaper path
```

```text
medium coverage
or novel semantic task
→ Muse 1.2
```

```text
low/unknown coverage
+ high risk
→ Muse 1.2
+ DeepSeek verification
+ human review
```

```text
conflicting evidence
→ stop/escalate
```

---

# 39. Phase 19 — DeepSeek Verification With Graph Evidence

DeepSeek V4 Flash should receive:

- task
- candidate
- relevant graph paths
- evidence
- graph coverage/conflicts
- deterministic verification results

It should not receive an uncontrolled full graph dump.

Use it to evaluate criteria such as:

```text
semantic correctness
impact completeness
evidence support
migration safety
verification strength
```

Its judgment remains soft.

A high verifier score cannot override:

```text
failed tests
broken build
graph invariant violation
known contract mismatch
tenant/security violation
```

---

# 40. Phase 20 — Representation-Aware Verification

Capture whether a verifier failure originated from:

```text
wrong candidate reasoning
wrong graph
missing graph edge
stale graph
insufficient evidence pack
verifier error
```

Do not blame the model for an upstream representation defect.

---

# 41. Phase 21 — Graph Learning Flywheel

Verified outcomes should improve the graph.

Target:

```text
migration
↓
review/verification
↓
outcome
↓
graph lesson
↓
edge/entity/query improvement
↓
new graph version
↓
better future migrations
```

Examples:

```text
missed runtime dependency
→ new runtime evidence/edge rule
```

```text
reviewer corrects false impact
→ entity/edge resolution regression case
```

```text
successful migration verifies previously inferred dependency
→ edge verification state may improve
```

Do not automatically mutate persistent graph truth from one model output.

Require evidence and policy.

---

# 42. Graph Lessons as Training Data

Some graph tasks may eventually justify owned intelligence.

Examples:

- entity resolution
- provider SDK → endpoint mapping
- semantic wrapper classification
- runtime-path classification
- migration constraint extraction

Before training:

```text
eval exists?
ground truth exists?
provenance clean?
failure is actually model-semantic?
```

If yes, use the existing governed training pipeline.

If no, fix infrastructure first.

---

# 43. Phase 22 — Graph-Derived Recipes

Repeated verified patterns may become deterministic recipes.

Example:

```text
Provider endpoint renamed
+ known SDK mapping
+ exact wrapper path
→ deterministic impact scan + edit recipe
```

The graph should make recipes safer by constraining their scope.

Track:

```text
recipe applicability conditions
required relation types
required graph coverage
verification requirements
```

---

# 44. Phase 23 — Storage Decision

Do not select a graph database by fashion.

Create:

`docs/graph/STORAGE_DECISION.md`

Compare the existing architecture against realistic options:

```text
existing relational representation
edge tables
materialized graph views
graph database
virtual ontology
hybrid
```

Evaluate:

```text
query expressiveness
write/update cost
incremental graph rebuild
snapshot/version support
tenant isolation
operational complexity
latency
scale
migration cost
developer ergonomics
```

Prefer the smallest change that proves the representation thesis.

An initial vertical slice can live on the existing persistence stack if it supports the needed semantics.

---

# 45. Phase 24 — Graph Query Performance

Benchmark graph operations needed for:

```text
blast radius
transitive dependencies
shortest/meaningful evidence paths
test selection
migration order
service-level cut sets
runtime dependency expansion
```

Track:

```text
P50
P95
query count
result size
cache hit
```

Avoid unbounded traversals.

---

# 46. Phase 25 — Context Efficiency

A major goal is to reduce repeated online retrieval.

Track per mission:

```text
raw files examined
retrieval calls
graph queries
context tokens
requeries
model calls
```

Compare graph vs raw-retrieval modes.

The graph is not successful if it increases complexity without reducing uncertainty, cost, or retrieval burden.

---

# 47. Phase 26 — Edge Admission Policy

Not every inferred relation should immediately become trusted graph state.

Introduce an admission model.

Potential tiers:

```text
DETERMINISTIC
OBSERVED
INFERRED
CORROBORATED
HUMAN_VERIFIED
```

High-risk relationships may require multiple independent signals.

Example:

```text
static call edge
→ deterministic
```

```text
runtime service dependency
→ observed
```

```text
business semantic dependency inferred from code
→ inferred until corroborated
```

Do not pretend all graph edges have equal epistemic status.

---

# 48. Phase 27 — Conflict Resolution

Support cases where evidence disagrees.

Example:

```text
static graph says dependency absent
runtime trace shows dependency present
```

Do not discard one source silently.

Represent conflict and use policy.

Possible action:

```text
runtime observation wins for "executes in production"
static model remains accurate for "declared dependency"
```

Use semantically distinct relationships when that better expresses reality.

---

# 49. Phase 28 — Staleness and Freshness

Every graph edge that can become obsolete needs freshness semantics.

Potential triggers:

```text
repo commit changes
provider API version changes
SDK upgrade
deployment change
test suite change
runtime observation ages out
service renamed
ownership changes
```

Do not serve stale high-risk graph relationships without surfacing staleness.

---

# 50. Phase 29 — Graph Invariants

Create deterministic integrity checks.

Examples:

```text
edge endpoints exist
tenant IDs match
snapshot boundaries valid
no forbidden cross-tenant edge
temporal ranges sane
invalidated entities not returned as current
provider versions consistent
evidence refs resolvable
```

Add product-specific invariants where appropriate.

Run these during graph publication.

---

# 51. Phase 30 — Security and Governance

Graph data is sensitive customer architecture.

Protect:

```text
tenant isolation
repository permissions
residency
consent where relevant
retention
auditability
external model eligibility
```

No cross-tenant relationship should ever exist unless it references public/provider-global entities through an explicitly safe shared layer.

Design a clear distinction between:

```text
GLOBAL PROVIDER KNOWLEDGE
```

and:

```text
TENANT SOFTWARE GRAPH
```

---

# 52. Shared Provider Graph vs Tenant Graph

Potential architecture:

```text
Global Provider Graph
    providers
    API versions
    endpoints
    schemas
    SDK versions/methods
    deprecations
    migrations

Tenant Repository Graph
    repos
    files
    symbols
    services
    runtime
    tests
    ownership
    internal dependencies

Mission Graph Projection
    bounded combination of relevant global + tenant entities/edges
```

Do not duplicate public provider knowledge separately for every tenant if existing governance allows a shared layer.

Never merge tenant-private repository relationships across customers.

---

# 53. Phase 31 — Design Partner Readiness

Add a Change Graph readiness section to the existing design-partner scorecard.

Track:

```text
supported languages
supported analysis modes
supported relation types
runtime-data support
graph coverage class
entity-resolution quality
impact recall/precision
graph-induced false positive rate
stale-edge rate
known dynamic-language blind spots
query latency
last validated commit
hidden holdout result
```

Do not claim broad graph coverage from a narrow language/provider benchmark.

---

# 54. Phase 32 — Observability

Add graph telemetry.

We need to answer:

```text
How many entities/edges exist by type?
How many are deterministic vs inferred?
How many are stale/conflicting?
What % of Fettler findings came from graph traversal?
What % required raw fallback?
What % of ReGauge dependencies were graph-resolved?
How many model tokens did graph context save?
How often did missing edges cause failures?
How often did graph edges cause false positives?
Which relation types create the most value?
```

---

# 55. Phase 33 — Graph Value Metrics

Track:

## Quality

```text
relationship-task accuracy
impact recall
impact precision
dependency correctness
migration-order correctness
```

## Efficiency

```text
tokens per successful task
queries per successful task
latency
cost
```

## Trust

```text
evidence-path availability
coverage disclosed
correct abstention
false-confidence rate
```

## Learning

```text
new graph regressions
new edge extractors
new relation types
new verified relationships
```

---

# 56. Core Business Metric

Add:

```text
Graph-Assisted Intelligence Cost per Verified Migration
```

Compare to raw/retrieval mode.

Do not optimize graph token reduction at the expense of correctness.

---

# 57. Phase 34 — Research Artifact

Create:

`docs/research/MENDPOINT_CHANGE_GRAPH_BENCHMARK.md`

It should eventually contain:

```text
task taxonomy
direct vs relationship tasks
dataset construction
grader methodology
raw retrieval baseline
graph baseline
graph + verifier
Muse configuration
graph coverage
quality
tokens
latency
cost
failure analysis
limitations
```

Do not publish external claims until results are reproducible.

---

# 58. Phase 35 — Required Initial Experiment

Choose a bounded Fettler capability first if current repository maturity supports it.

Recommended experiment shape:

```text
provider API/SDK change
↓
synthetic repos with:
    direct usage
    wrapper usage
    cross-module usage
    generated SDK layer
    false-positive trap
    test coverage
↓
known ground-truth impact set
```

Run:

```text
A: existing raw/retrieval path + Muse 1.2
B: Change Graph path + Muse 1.2
C: Change Graph path + Muse 1.2 + DeepSeek V4 Flash
```

Measure:

```text
impact recall
impact precision
patch correctness
verification success
context tokens
tool calls
latency
cost
```

Do not use only happy-path direct imports.

At least half the initial benchmark should require indirect relationships.

---

# 59. ReGauge Follow-Up Experiment

Once the Fettler representation slice is proven, create a ReGauge experiment around:

```text
legacy service modernization
```

Include:

```text
static dependency
runtime-only dependency
shared database
cron/background job
test dependency
apparently dead but runtime-live code
migration sequencing
```

Compare raw reconstruction with graph-assisted planning.

---

# 60. Phase 36 — Query-Time Fallback

The graph will never be perfect.

Support a controlled fallback:

```text
graph answer
↓
coverage sufficient?
    yes → continue
    no  → targeted raw retrieval / Muse exploration
```

If fallback discovers a stable relationship:

```text
candidate relationship
↓
evidence/validation
↓
future materialization
```

This turns query-time exploration into graph improvement.

Do not run unlimited retrieval loops.

---

# 61. Phase 37 — Graph-Aware Abstention

Teach product logic to distinguish:

```text
NO IMPACT FOUND
```

from:

```text
NO IMPACT FOUND WITH INSUFFICIENT GRAPH COVERAGE
```

Those are not the same outcome.

Similarly:

```text
NO DEPENDENCY
```

must not be returned when the system actually means:

```text
DEPENDENCY UNKNOWN
```

This distinction is critical to customer trust.

---

# 62. Phase 38 — Product UX Implications

Do not make the graph visible merely as a giant node visualization.

Expose it when it improves decision quality.

Useful surfaces may include:

- impact path
- dependency path
- coverage state
- conflicting evidence
- stale evidence
- why this file/service was included
- which tests validate the path
- migration-stage dependencies

Reviewers should be able to understand:

> Why is Mendpoint changing this?

---

# 63. Phase 39 — Change Graph as Persistent Memory

Adopt the mental model:

> **Models are ephemeral reasoning engines. The Change Graph is Mendpoint's durable memory of software relationships.**

Do not use long prompt histories as the primary persistence mechanism for software structure.

Repository changes should update the graph.

Migrations should update graph/history evidence.

New sessions should inherit the graph rather than rediscovering the repository from zero.

---

# 64. Phase 40 — Change Graph and Owned Intelligence

Connect this initiative to the "Own Mendpoint's Intelligence" program.

The intelligence moat is not only model weights.

It includes:

```text
Change Graph
entity resolution
relationship materialization
graph extractors
migration benchmark
verified trajectories
recipes
router outcomes
specialized weights/adapters
verification calibration
```

The graph may allow smaller/owned models to outperform a stronger general model on narrow relationship-heavy tasks.

Test that later with the same benchmark.

Do not assume it.

---

# 65. Phase 41 — Model Experiment After Representation Is Strong

Only after the graph benchmark is stable, compare:

```text
Muse 1.2 + raw retrieval
Muse 1.2 + graph
candidate smaller/owned model + graph
```

This isolates:

```text
representation improvement
```

from:

```text
model improvement
```

We want to know which layer created the gain.

---

# 66. Phase 42 — Avoid Benchmark Confounding

When comparing representations, keep fixed:

```text
task
ground truth
model
tool permissions
grader
temperature/seed where controllable
verification policy
```

Change only the context/representation path.

When comparing models, keep the graph/context path fixed.

---

# 67. Phase 43 — Required Documentation

Produce or update:

```text
docs/graph/CURRENT_STATE.md
docs/graph/ONTOLOGY.md
docs/graph/EDGE_PROVENANCE.md
docs/graph/COVERAGE_MODEL.md
docs/graph/STORAGE_DECISION.md
docs/graph/QUERY_CONTRACT.md
docs/graph/INCREMENTAL_BUILD.md
docs/research/MENDPOINT_CHANGE_GRAPH_BENCHMARK.md
```

If equivalent documents already exist, improve them rather than create duplicates.

Add ADRs for significant architecture decisions.

---

# 68. Phase 44 — Required Tests

At minimum add coverage for:

## Entity resolution

```text
exact identity
aliases
renames
ambiguous identity
collision
unresolved
```

## Edge materialization

```text
static edge
provider mapping
wrapper chain
runtime edge
test coverage edge
migration dependency
```

## Provenance

```text
edge has evidence
evidence resolvable
inferred edge records extractor
```

## Temporal semantics

```text
new snapshot
invalidated edge
historical mission sees old graph version
```

## Coverage

```text
partial graph
unknown runtime data
conflicting evidence
stale edge
```

## Query

```text
bounded traversal
blast radius
indirect provider usage
test selection
dependency ordering
```

## Security

```text
cross-tenant traversal rejected
global provider + tenant graph allowed only through safe boundary
```

## Context compiler

```text
small task subgraph
evidence retained
irrelevant edges excluded
conflict surfaced
```

## Benchmark

```text
raw path
graph path
hidden holdout isolation
```

---

# 69. Phase 45 — Performance Tests

Test graph scale representative of:

```text
small repo
medium repo
large repo
monorepo
multi-repo tenant
```

Measure:

```text
graph-build time
incremental-update time
query P50/P95
context compilation time
storage growth
```

Do not optimize prematurely, but do not build an architecture that only works on toy repositories.

---

# 70. Phase 46 — Failure and Rollback

Graph publication must be safe.

If a new graph build fails:

```text
keep last valid graph version
record failure
do not silently publish partial corrupt state
```

If a new extractor creates regressions:

```text
rollback extractor/graph version
```

Mission reproducibility must remain possible.

---

# 71. Phase 47 — Definition of Done for the First Major Iteration

This initiative is not done because:

- a graph database exists
- more edges exist
- a graph visualization exists
- a design document exists

The first major iteration is complete when we can demonstrate:

1. A canonical graph entity/edge contract exists.
2. Important relationships carry evidence/provenance.
3. Missions reference versioned graph state.
4. Graph incompleteness/conflict/staleness is explicit.
5. Entity resolution is testable.
6. At least one high-value indirect relationship is materialized offline/incrementally.
7. Fettler can traverse from provider change to indirect affected code through the graph.
8. The context compiler can produce a compact evidence-backed impact pack.
9. The same Muse 1.2 model performs a controlled raw-vs-graph benchmark.
10. The benchmark includes direct and relationship-heavy tasks.
11. Graph-vs-raw results report correctness, tokens, latency, cost, and failure modes.
12. Graph failures are classified separately from model failures.
13. Missing relationships are routed to graph/entity/runtime fixes rather than model training by default.
14. Graph coverage affects routing or at least emits telemetry needed to do so.
15. DeepSeek V4 Flash can verify a graph-backed Muse candidate without overriding deterministic evidence.
16. Graph outcomes feed the existing Mendpoint learning-event system.
17. Cross-tenant graph isolation is proven.
18. Incremental rebuild/versioning works for the selected vertical slice.
19. A hidden holdout demonstrates whether the improvement generalizes.
20. Codex can state, with evidence, whether the representation-first hypothesis improved Mendpoint's selected capability.

---

# 72. Success Criteria

We should eventually be able to answer:

### Representation
What relationships does Mendpoint know explicitly?

### Evidence
Why does Mendpoint believe each high-value relationship?

### Coverage
What relationships might Mendpoint be missing?

### Fettler
Can a provider change traverse through SDKs, wrappers, services, tests, and owners without repeated raw-code inference?

### ReGauge
Can a modernization objective traverse topology, runtime dependencies, shared state, and ordering constraints?

### Economics
Does graph representation reduce repeated retrieval/model compute?

### Quality
Does graph representation improve impact/dependency accuracy?

### Router
Does graph coverage help choose cheaper vs stronger execution paths safely?

### Learning
Does every graph failure improve the representation system rather than being rediscovered?

### Owned intelligence
Can stronger representation make smaller/specialized models competitive on narrow migration tasks?

---

# 73. Strategic End State

The desired Mendpoint architecture is:

```text
                         SOFTWARE WORLD
                              │
                              ▼
                     RESOLUTION + INDEXING
                              │
                              ▼
                        CHANGE GRAPH
              typed + temporal + evidenced
                              │
                              ▼
                      MISSION SUBGRAPH
                              │
                              ▼
                       POLICY ROUTER
                              │
       ┌──────────────────────┼──────────────────────┐
       │                      │                      │
       ▼                      ▼                      ▼
DETERMINISTIC/RECIPE    OWNED INTELLIGENCE       MUSE 1.2
                                                       │
                                               high uncertainty?
                                                       │
                                                       ▼
                                              DeepSeek V4 Flash
                                                       │
       └──────────────────────┬────────────────────────┘
                              ▼
                          VERIFY
                              │
                              ▼
                       REVIEWABLE PR
                              │
                              ▼
                       REAL OUTCOME
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
          GRAPH LEARNING              MODEL LEARNING
                │                           │
                └─────────────┬─────────────┘
                              ▼
                       BETTER MENDPOINT
                              ↺
```

The durable design principle is:

> **Do not pay a model to rediscover a software relationship on every mission when Mendpoint can resolve that relationship once, preserve the evidence, version it, test it, and traverse it deterministically thereafter.**

---

# 74. Execution Directive

Execute in this order:

```text
inspect current graph
→ map current entities/edges/provenance
→ define the smallest ontology improvement
→ select one Fettler relationship-heavy vertical slice
→ implement entity resolution/materialization
→ add provenance and coverage
→ add graph query/context compiler
→ benchmark raw vs graph with Muse 1.2
→ integrate DeepSeek verification
→ analyze failures
→ fix representation gaps
→ run hidden holdout
→ connect lessons to learning system
→ document architecture
→ open PR
→ request Claude peer review
```

Do not stop after `CURRENT_STATE.md`.

Do not replace the existing persistence system without evidence.

Do not introduce a graph database merely because the project is called a Change Graph.

Do not train a model to compensate for missing relationships.

Do not hide graph uncertainty.

Do not leak tenant relationships.

Do not optimize benchmark optics.

The objective is to make the Change Graph a **tested, persistent, compounding software-intelligence layer** that improves Fettler and ReGauge on the kinds of relationship-heavy migration tasks that raw retrieval and additional model reasoning handle poorly.

Start now.
