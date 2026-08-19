# Mission

You are responsible for evaluating and, if justified by benchmark evidence, integrating **Graphify** into Mendpoint as a structural code-graph extraction layer beneath the canonical Mendpoint Change Graph.

Upstream repository:

`https://github.com/Graphify-Labs/graphify`

This is an implementation task, not a research memo.

The objective is not to replace Mendpoint's Change Graph with Graphify.

The objective is:

> **Use Graphify to commoditize low-level source-code graph extraction while Mendpoint continues to own the higher-value semantic, temporal, migration, evidence, and learning layers.**

The target architecture is:

```text
source repository
      ↓
Graphify structural extraction
      ↓
Mendpoint normalization
      ↓
Mendpoint entity resolution
      ↓
semantic relationship materialization
      ↓
canonical Change Graph
      ↓
Fettler / ReGauge / router / verification / learning
```

Graphify may earn a production role only if it materially improves:

- structural extraction quality
- cross-file relationship resolution
- language coverage
- indirect dependency recall
- graph build efficiency
- engineering maintenance burden

without creating unacceptable regressions in:

- provenance
- tenant isolation
- temporal semantics
- graph correctness
- latency
- operational complexity

---

# Canonical Product Context

## Fettler

Fettler handles external change:

```text
provider/API/SDK change
→ impact graph
→ affected code
→ remediation
→ verification
→ reviewable PR
```

## ReGauge

ReGauge handles internal and legacy modernization:

```text
modernization objective
→ architecture/dependency graph
→ migration plan
→ staged transformations
→ verification
→ reviewable PR campaign
```

Canonical names:

- Fettler
- ReGauge

Do not use Warden or Transformer in new customer-facing code or docs.

---

# Current Model Roles

## Muse 1.2

Primary reasoning/generation model.

## DeepSeek V4 Flash

Independent soft verifier.

Neither model should be used to compensate for structural graph failures when deterministic extraction can solve the problem.

---

# Critical Architectural Boundary

Graphify should own, at most:

## Structural extraction

Examples:

```text
files
modules
functions
methods
classes
imports
calls
inheritance
references
basic communities
structural paths
```

Mendpoint continues to own:

## Semantic software graph

```text
service
endpoint
SDK mapping
schema
wrapper
runtime path
test relationship
ownership
```

## Change / migration graph

```text
AFFECTED_BY_CHANGE
USES_ENDPOINT
USES_SDK_METHOD
MIGRATES_TO
MUST_PRECEDE
BLOCKS
REMEDIATED_BY
VERIFIED_BY
```

## Experience graph

```text
migration outcome
review decision
failure
successful remediation
recipe
lesson
```

Do not let Graphify-specific storage or ontology become Mendpoint's canonical graph contract.

---

# Phase 0 — Parallel-Agent Safety

Claude Code may be working in parallel.

Before modifying code:

1. read `AGENTS.md`
2. read `docs/agents/OPERATING_PROTOCOL.md`
3. read `REVIEW.md`
4. read the canonical Mendpoint Product & Platform Specification
5. inspect `git status`
6. inspect worktrees
7. fetch remote changes
8. inspect active Claude PRs/issues
9. identify graph/eval overlap

Use a Codex-owned isolated worktree.

Suggested branch:

```text
codex/graphify-integration
```

Do not overwrite Claude-owned graph or eval changes.

---

# Phase 1 — Inspect Upstream Graphify

Read and understand:

```text
README.md
ARCHITECTURE.md
BENCHMARKS.md
SECURITY.md
LICENSE
```

Inspect the actual code paths for:

```text
detect
extract
build
cluster
analyze
graph_diff
cache
watch
validate
serve/query
language extractors
```

Pay special attention to:

- tree-sitter extraction
- cross-file call/import resolution
- confidence labels
- incremental rebuild behavior
- graph diff
- community detection
- path/explain/query logic
- security boundaries
- language coverage
- output schema

Do not rely only on README claims.

Create:

```text
docs/graph/GRAPHIFY_EVALUATION.md
```

Document:

```text
what Graphify does well
what Mendpoint already does better
what overlaps
what is missing
what must not be adopted
```

---

# Phase 2 — Licensing

Graphify is Apache-2.0 licensed.

If using it as:

```text
dependency
wrapped library
vendored/forked code
```

preserve all applicable license and notice requirements.

Prefer dependency/wrapper integration before forking.

Do not copy upstream source without attribution/license handling.

---

# Phase 3 — Build a Structural Extractor Interface

Do not wire Graphify directly into Fettler/ReGauge.

Create or reuse an abstraction such as:

```text
StructuralGraphExtractor
```

Conceptually:

```python
class StructuralGraphExtractor:
    def extract(snapshot) -> StructuralExtraction:
        ...
```

Canonical output should be Mendpoint-owned.

Conceptually:

```json
{
  "snapshot_id": "",
  "extractor": "",
  "extractor_version": "",
  "nodes": [],
  "edges": [],
  "ambiguities": [],
  "warnings": [],
  "metrics": {}
}
```

Do not expose Graphify's internal NetworkX graph throughout Mendpoint.

---

# Phase 4 — Implement GraphifyStructuralExtractor

Create:

```text
GraphifyStructuralExtractor
```

behind the structural extractor interface.

Use Graphify's library API if practical.

Do not shell out to the CLI unless the library interface is materially worse or unstable.

Pass repository root explicitly so entity/source IDs remain stable.

Capture:

```text
Graphify version
repository snapshot
language set
extraction warnings
elapsed time
node count
edge count
confidence distribution
```

---

# Phase 5 — Normalize Graphify Nodes

Map Graphify nodes into Mendpoint structural entities.

Do not simply persist Graphify node IDs as canonical Mendpoint entity identities.

Example normalization:

```text
Graphify:
routing.py::APIRouter
```

may become:

```text
Mendpoint:
Symbol(
  repo_snapshot=...,
  file=...,
  qualified_name=...,
  symbol_kind=...
)
```

Preserve:

```text
source file
source location
Graphify node ID
extractor version
```

as provenance.

---

# Phase 6 — Normalize Graphify Edges

Map Graphify relations into Mendpoint structural relationships.

Examples:

```text
imports
calls
inherits
references
uses
```

Normalize into the existing Mendpoint ontology.

Do not collapse all relationships into generic `DEPENDS_ON`.

Preserve semantic specificity.

---

# Phase 7 — Epistemic-State Mapping

Graphify uses:

```text
EXTRACTED
INFERRED
AMBIGUOUS
```

Map these into Mendpoint's richer evidence model.

Suggested mapping:

```text
EXTRACTED
→ OBSERVED / DETERMINISTIC

INFERRED
→ INFERRED

AMBIGUOUS
→ AMBIGUOUS
```

Mendpoint may subsequently promote edges to:

```text
CORROBORATED
HUMAN_VERIFIED
```

or mark them:

```text
CONFLICTING
STALE
INVALIDATED
```

Do not discard Graphify's original confidence label.

Store it in provenance.

---

# Phase 8 — Provenance

Every imported edge must preserve:

```text
source file/location
Graphify extractor/version
original relation
original confidence
repository snapshot
timestamp
```

Conceptually:

```json
{
  "derivation": {
    "engine": "graphify",
    "version": "",
    "method": "tree-sitter",
    "upstream_relation": "calls",
    "upstream_confidence": "EXTRACTED"
  }
}
```

Do not lose the ability to answer:

> Why does Mendpoint believe this relationship exists?

---

# Phase 9 — Structural → Semantic Promotion

Graphify output is not yet migration intelligence.

Build or reuse a promotion pipeline:

```text
Graphify edge
↓
normalize
↓
entity resolve
↓
provider/runtime/schema corroboration
↓
semantic edge
```

Example:

```text
createPayment
CALLS
stripe.PaymentIntent.create
```

then resolve:

```text
stripe.PaymentIntent.create
IMPLEMENTS_ENDPOINT
POST /v1/payment_intents
```

then materialize:

```text
createPayment
USES_ENDPOINT
POST /v1/payment_intents
```

with provenance.

---

# Phase 10 — Provider Graph Join

Graphify understands source structure.

Mendpoint must join that to the global provider graph.

Implement or strengthen mappings across:

```text
package
SDK
SDK version
SDK method
provider
API version
endpoint
schema
```

Use:

- OpenAPI
- SDK metadata
- provider docs
- package metadata
- static imports
- runtime evidence where available

Do not rely solely on symbol-name similarity.

---

# Phase 11 — First Fettler Vertical Slice

Use one bounded provider-change scenario.

Preferred:

```text
Stripe/OpenAPI/SDK change
```

or another provider already well-supported in the repo.

Test repos should include:

```text
direct SDK call
internal wrapper
cross-file call
cross-module call
alias import
generated client
false-positive trap
relevant test
```

Pipeline:

```text
repo snapshot
↓
Graphify structural extraction
↓
Mendpoint normalization
↓
SDK method resolution
↓
endpoint mapping
↓
impact path materialization
↓
Fettler impact analysis
```

---

# Phase 12 — Graphify Path as Evidence Path

Graphify path traversal can inspire but must not define Mendpoint's user-facing evidence path.

Convert structural paths into Mendpoint semantic evidence paths.

Example:

```text
ProviderChange
→ Endpoint
→ SDKMethod
→ InternalWrapper
→ Function
→ Service
→ Test
```

Each hop must be backed by the relevant structural/provider/runtime evidence.

---

# Phase 13 — Benchmark Existing vs Graphify

Do not replace current extraction before measuring.

Run:

## A — Current Mendpoint extraction

```text
current structural graph
→ current semantic resolution
```

## B — Graphify structural graph only

```text
Graphify extraction
→ Mendpoint normalization
```

## C — Graphify + semantic resolution

```text
Graphify
→ Mendpoint entity resolution
→ provider mapping
→ Change Graph
```

## D — Graphify + Change Graph + Muse 1.2

Full Fettler reasoning path.

## E — Graphify + Change Graph + Muse 1.2 + DeepSeek V4 Flash

High-risk/verification path.

---

# Phase 14 — Benchmark Metrics

Measure:

## Structural

```text
node recall
edge recall
edge precision
cross-file call resolution
alias handling
inheritance resolution
language coverage
```

## Fettler

```text
impact recall
impact precision
indirect dependency recall
false positives
root-cause correctness
patch correctness
verification success
```

## Operational

```text
graph build time
incremental update time
memory
storage
query latency
```

## Model

```text
context tokens
tool calls
Muse calls
DeepSeek calls
latency
cost
```

---

# Phase 15 — Direct vs Indirect Cases

At least half the benchmark should require non-trivial relationships.

Include:

```text
direct import
wrapper
wrapper of wrapper
cross-module
cross-service
generated client
alias/rename
dynamic dispatch where feasible
runtime-only dependency where Graphify should fail
```

The purpose is to discover both strengths and limits.

---

# Phase 16 — Detect Graphify Blind Spots

Explicitly test likely weak areas:

```text
reflection
dynamic imports
dependency injection
ORM indirection
generated code
macros
stored procedures
shell scripts
cron
runtime plugin loading
feature flags
message queues
shared databases
```

Do not penalize Graphify for problems outside static extraction if Mendpoint's runtime layer can compensate.

Instead classify:

```text
STRUCTURAL_STATIC_GAP
RUNTIME_EVIDENCE_REQUIRED
SEMANTIC_RESOLUTION_REQUIRED
```

---

# Phase 17 — Incremental Graph Update

Inspect Graphify's:

```text
graph_diff
cache
watch
```

mechanisms.

Determine whether Mendpoint can reuse them directly or only borrow the approach.

Target:

```text
commit
↓
changed files
↓
re-extract changed structural region
↓
diff old/new
↓
invalidate affected semantic edges
↓
re-resolve neighborhood
↓
publish new ChangeGraphVersion
```

Do not mutate the currently referenced mission graph version in place.

---

# Phase 18 — Stable Snapshot Semantics

Every structural extraction must bind to:

```text
tenant
repository
snapshot/commit
extractor version
```

A mission must be able to reproduce the graph used for its decision.

Do not use an always-changing `graph.json` as mission truth.

---

# Phase 19 — Community Detection for ReGauge

Evaluate Graphify's community detection as a **candidate subsystem discovery signal**.

Do not treat communities as truth.

Pipeline:

```text
Graphify community
↓
candidate subsystem
↓
corroborate with:
  package structure
  runtime calls
  ownership
  deployment
  DB usage
↓
ReGauge architecture entity
```

Measure whether communities help architecture reconstruction.

---

# Phase 20 — Centrality as Risk Features

Evaluate graph metrics such as:

```text
degree
betweenness
fan-in
fan-out
community-boundary crossing
```

Use them only as features for:

```text
blast-radius risk
migration sequencing
router risk
```

Do not treat "god node" status as automatically dangerous.

---

# Phase 21 — Test Coverage Graph

If Graphify can help associate tests/source structurally, use that as one input.

Mendpoint should ultimately materialize:

```text
Test
COVERS
Symbol / Endpoint / RuntimePath
```

but only when evidence supports it.

Do not infer coverage solely because test files import source files.

---

# Phase 22 — Docs and ADR Graph

Evaluate Graphify's ability to ingest:

```text
ADR
RFC
docs
README
design docs
```

Use these as candidate evidence for:

```text
GOVERNED_BY
EXPLAINED_BY
RATIONALE_FOR
```

Do not automatically trust model-derived doc relationships.

Keep semantic/doc inference epistemically distinct from deterministic code edges.

---

# Phase 23 — Internal Claude/Codex Experiment

Before production dependency, test Graphify on Mendpoint itself.

Run controlled engineering tasks:

```text
Claude/Codex without Graphify
vs
Claude/Codex with Graphify
```

Measure:

```text
files read
grep/search calls
tokens
task time
wrong architecture assumptions
review defects
task success
```

This is optional for production integration but useful evidence.

---

# Phase 24 — Local-First Enterprise Path

Preserve Graphify's local/static extraction advantage.

Design so:

```text
customer source
↓
local/VPC structural extraction
↓
Mendpoint normalized graph
↓
policy-scoped task subgraph
↓
model reasoning
```

Do not require external LLM calls to build the base structural graph.

---

# Phase 25 — Security

Validate Graphify's security model before integration.

Do not assume upstream defaults satisfy Mendpoint requirements.

Verify:

```text
path handling
URL handling
resource limits
malformed source
oversized repo
symlink behavior
untrusted filenames
HTML/report escaping
```

All imported graph data must still pass Mendpoint tenant/security validation.

---

# Phase 26 — Tenant Isolation

Graphify extraction output must never become cross-tenant shared state.

Attach tenant context at Mendpoint ingestion.

Global shared graph should contain only explicitly public/provider-global entities.

Repository structural graphs remain tenant-private.

---

# Phase 27 — Failure Taxonomy

Add Graphify-specific failure classes:

```text
GRAPHIFY_EXTRACTION_FAILURE
GRAPHIFY_LANGUAGE_GAP
GRAPHIFY_EDGE_MISS
GRAPHIFY_FALSE_EDGE
GRAPHIFY_AMBIGUITY
GRAPHIFY_IDENTITY_INSTABILITY
GRAPHIFY_INCREMENTAL_DIFF_FAILURE
GRAPHIFY_PERFORMANCE_FAILURE
GRAPHIFY_SECURITY_FAILURE
```

Do not collapse these into generic model errors.

---

# Phase 28 — Learning Integration

When Fettler/ReGauge finds a missed relationship, determine:

```text
Graphify failed to extract?
Mendpoint normalization failed?
entity resolution failed?
provider mapping failed?
runtime evidence missing?
query omitted edge?
Muse ignored correct edge?
```

Route lessons accordingly.

Do not train Muse around Graphify extraction failures.

---

# Phase 29 — Decision Gate

After benchmarking, explicitly decide one of:

```text
ADOPT
ADOPT FOR SELECT LANGUAGES
ADOPT AS FALLBACK
KEEP AS INTERNAL TOOL ONLY
DO NOT ADOPT
```

Document:

```text
docs/graph/GRAPHIFY_DECISION.md
```

Include:

```text
quality delta
engineering-effort delta
operational cost
license implications
security implications
performance
known blind spots
```

---

# Phase 30 — If Adopted

If Graphify earns production use:

1. pin a tested upstream version
2. wrap it behind Mendpoint interfaces
3. add license/NOTICE compliance
4. add compatibility tests
5. add extractor-version telemetry
6. add fallback behavior
7. add feature flag
8. support rollback to existing extractor
9. avoid Graphify-specific types in product APIs
10. document upgrade procedure

---

# Phase 31 — Kill Switch

Provide:

```text
GRAPHIFY_STRUCTURAL_EXTRACTOR_ENABLED=false
```

or equivalent configuration.

Disabling Graphify should restore the prior structural extraction path where one exists.

Do not make Mendpoint unbootable if Graphify fails.

---

# Phase 32 — Required Documentation

Create or update:

```text
docs/graph/GRAPHIFY_EVALUATION.md
docs/graph/STRUCTURAL_EXTRACTOR_CONTRACT.md
docs/graph/GRAPHIFY_ADAPTER.md
docs/graph/STRUCTURAL_TO_SEMANTIC_PROMOTION.md
docs/graph/GRAPHIFY_BENCHMARK.md
docs/graph/GRAPHIFY_DECISION.md
```

Add ADRs for material architecture changes.

---

# Phase 33 — Required Tests

At minimum:

## Adapter

```text
Graphify node normalization
Graphify edge normalization
confidence mapping
provenance retention
stable root handling
```

## Identity

```text
same snapshot deterministic IDs
new snapshot appropriate versioning
alias import
renamed symbol
```

## Semantic promotion

```text
SDK method → endpoint
wrapper → provider method
multi-hop indirect usage
```

## Isolation

```text
tenant A extraction inaccessible to tenant B
```

## Failure

```text
unsupported language
Graphify exception
malformed output
timeout
partial extraction
```

## Feature flag

```text
Graphify disabled
fallback works
```

## Benchmark

```text
current extractor
Graphify extractor
hidden holdout
```

---

# Phase 34 — Required Performance Tests

Run on:

```text
small repo
medium repo
large repo
monorepo
```

Measure:

```text
full extraction
incremental extraction
memory
graph size
normalization time
semantic promotion time
```

---

# Phase 35 — First Production-Worthy Milestone

The first major iteration is complete when:

1. Graphify is behind a Mendpoint-owned structural extractor interface.

2. Its nodes/edges are normalized into Mendpoint types.

3. Graphify confidence/provenance is preserved.

4. At least one provider SDK method can be promoted into a semantic endpoint relationship.

5. Fettler can traverse a Graphify-derived indirect usage path.

6. The benchmark compares current extraction vs Graphify on known ground truth.

7. At least one hidden holdout is included.

8. Graphify failure modes are separately classified.

9. Runtime-only/static blind spots are explicitly surfaced.

10. Incremental update behavior is tested.

11. Tenant isolation is proven.

12. Graphify can be disabled without breaking Mendpoint.

13. An explicit ADOPT/DO-NOT-ADOPT decision is documented.

14. If adopted, the upstream dependency is version-pinned and licensed correctly.

15. Claude Code performs independent peer review of the PR.

---

# Strategic Principle

Do not turn Mendpoint into a Graphify wrapper.

Use Graphify to solve the commodity structural layer:

```text
source code
→ symbols
→ imports
→ calls
→ inheritance
→ basic cross-file structure
```

Mendpoint must continue to own:

```text
provider/entity resolution
semantic software graph
temporal Change Graph
graph coverage
runtime corroboration
impact analysis
blast radius
migration constraints
evidence paths
Mission history
review outcomes
learning
specialized intelligence
```

The desired division is:

```text
Graphify
→ Layer 1 structural graph

Mendpoint
→ Layers 2–4 semantic + change + experience intelligence
```

---

# Execution Directive

Execute:

```text
inspect Graphify
→ inspect current Mendpoint extraction
→ build structural extractor abstraction
→ implement Graphify adapter
→ normalize nodes/edges
→ preserve provenance
→ implement first provider semantic promotion
→ run Fettler benchmark
→ test indirect relationships
→ test known blind spots
→ test incremental updates
→ compare economics/performance
→ document decision
→ integrate only if justified
→ open PR
→ request Claude peer review
```

Do not stop after research.

Do not replace Mendpoint's graph wholesale.

Do not adopt Graphify storage as canonical persistence by default.

Do not hide static-analysis blind spots.

Do not train models around structural extraction defects.

Do not let upstream abstractions leak through the product.

Start now.
