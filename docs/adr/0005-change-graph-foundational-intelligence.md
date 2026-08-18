# ADR-0005: Change Graph is Mendpoint's foundational software intelligence architecture

- **Status:** Accepted
- **Date:** 2026-08-17
- **Author:** OpenAI Codex, approved by Talal Gondal
- **Supersedes:** none
- **Superseded by:** none

## Context

Issue [#185](https://github.com/gondalaimafia/mendpoint/issues/185) is governed by the owner supplied `Mendpoint_CODEX_Change_Graph_Intelligence_Prompt.md`, SHA-256 `5a37d827a4a1126ea1323d41bde8cbc5aa6b7ffca843b21895f5f942da8c58cc`. The owner explicitly designated that document as the authority for this initiative.

Mendpoint already has three useful graph layers, but they do not yet form one mission-bound intelligence architecture:

1. `@mendpoint/call-graph` builds and incrementally updates per-repository call graphs and can retain content-addressed versions.
2. `@mendpoint/code-impact` discovers provider usage and traverses callers during each Fettler run.
3. `@mendpoint/graph-learn` stores cross-repository facts and outcomes in SQLite and exposes bounded queries.

The production Fettler pipeline queries the durable graph before repository analysis, then runs code impact separately, and finally writes only coarse impact findings back. It does not publish the discovered endpoint, SDK, wrapper, caller, and test relationships as an immutable mission graph version. A later mission therefore repeats resolution and cannot cite the exact relationship version that justified its impact answer.

The external Rox article, [Knowledge Graphs vs Relational Schemas](https://www.rox.com/articles/knowledge-graphs-vs-relational-schemas), is a research hypothesis, not Mendpoint evidence. Its useful claim is that pre-resolved instance relationships can outperform repeated raw joins on unkeyed relationship tasks. Mendpoint must reproduce or reject that claim on software change tasks with its own benchmark.

## Decision

We will make the Change Graph the canonical, versioned, evidence-bearing representation of software relationships used by Fettler, Regauge, routing, verification, evaluation, and governed learning.

The first implementation will retain SQLite as the authoritative persistence substrate. A native graph database is not required for the proof. The architecture must provide:

- explicit tenant, repository, provider, snapshot, and graph-version scope;
- canonical entity identity and explicit exact, alias, ambiguous, unresolved, and collision outcomes;
- immutable graph publications with atomic head advancement and historical reads;
- evidence-bearing entities and relationships with extractor identity, confidence, validity, status, and conflict state;
- explicit coverage so an empty result cannot be confused with a complete no-impact result;
- bounded deterministic traversal and a compact context compiler;
- incremental publication that preserves the last valid graph when a new publication fails;
- mission binding to one immutable graph version;
- a first real Fettler chain from provider endpoint through provider SDK method, internal SDK method, wrapper or caller, and relevant tests;
- a controlled raw retrieval versus graph representation benchmark using the same task, generator, grader, and acceptance rules;
- DeepSeek verification only as an optional soft ranking signal, never as authority over deterministic evidence;
- failure attribution that sends missing or wrong relationships to graph, resolver, parser, runtime, query, or context work before model training eligibility.

The existing relational operational tables remain authoritative for operational state. The Change Graph is the canonical relationship memory, not a replacement for all relational data.

## Alternatives considered

### Keep per-run impact analysis only

Rejected. It already finds useful indirect relationships, but the evidence is recomputed and then collapsed into coarse findings. Missions cannot bind or replay the exact relationship state.

### Replace SQLite with Neo4j or another native graph database immediately

Rejected for the first proof. It adds operational complexity before Mendpoint has measured query shape, scale, and graph-specific value. A storage change requires benchmark evidence.

### Store only embeddings or model summaries

Rejected. They cannot provide deterministic identity, exact provenance, temporal validity, conflict handling, or auditable multi-hop paths.

### Keep separate product-specific graphs

Rejected as the canonical architecture. Product-specific projections may exist, but their claims must resolve to one versioned evidence model so Fettler, Regauge, routing, evaluation, and learning do not disagree.

## Security impact

The graph crosses tenant repository facts with shared provider facts, so tenant isolation is a primary trust boundary. Tenant facts must always carry an explicit tenant identifier. Shared provider facts may join a tenant graph only through an explicitly governed provider snapshot and relationship. Query entry points must require tenant scope and an exact graph version. Repository source is untrusted input and must be parsed under existing size, symlink, path, and non-execution limits. Evidence packs must redact secrets and may not contain chain of thought.

The graph does not grant mutation authority. A relationship path can inform a mission, but existing policy, human review, lease, verification, and source-control fences remain authoritative.

## Data and compatibility impact

The first implementation is additive. Existing `gl_nodes` and `gl_edges`, graph query contracts, impact reports, routes, environment variables, and persisted historical identifiers remain readable. New versioned publication tables and contracts use a distinct schema version. Existing mutable graph ingestion remains supported while callers migrate.

Graph identifiers and digests use deterministic code-unit ordering and SHA-256. Locale-dependent ordering is forbidden. Historical graph versions are immutable; correcting an error publishes a successor and records the relationship to the superseded version.

## Migration plan

1. Record current-state truth and the versioned ontology, evidence, coverage, storage, query, incremental, and benchmark contracts.
2. Add immutable graph publication and exact-version read contracts beside the v0 mutable graph.
3. Materialize one indirect Fettler endpoint-to-test chain from existing codebase-index and call-graph evidence.
4. Compile a bounded evidence pack and integrate it into Fettler impact analysis without weakening existing static verification.
5. Run raw versus graph representation benchmarks on development, validation, and hidden holdout tasks.
6. Add failure telemetry and governed learning references. Representation failures remain ineligible for model-weight training.
7. Shadow the graph-assisted path before making it required for high-risk work.

## Rollback

Before graph-assisted decisions are authoritative, rollback is stopping publication and use of the new graph version while retaining the additive tables for evidence. Existing code-impact behavior remains available. Historical graph versions are append-only and need not be deleted. After missions require a graph version, rollback must explicitly return those missions to an incomplete-coverage or human-review state; it must not silently substitute mutable v0 state.

## Evaluation plan

The acceptance suite must cover entity-resolution ambiguity, tenant isolation, exact historical reads, atomic publication failure, incremental invalidation, stale and conflicting evidence, bounded traversal, compact context, and no-impact versus unknown-impact. The benchmark must report correctness, precision, recall, abstention, retrieval calls, context bytes, model tokens, latency, cost, and failure destination for raw retrieval, graph representation, and graph plus optional verifier. At least half of validation and hidden-holdout tasks must require an indirect relationship. A representation failure cannot be admitted as model-weight training evidence.

## Initial activation decision

The live 2026-08-18 benchmark did not demonstrate graph-first value on its six tiny synthetic repositories. Both raw and optimized graph arms were correct on 6 of 6 tasks, while the graph arm used 72.6 percent more input tokens and cost 23.3 percent more. The Change Graph is accepted as the foundational relationship architecture and retained as immutable shadow evidence, but it is not the default retrieval representation until a larger relationship-heavy benchmark demonstrates a correctness or efficiency gain. This preserves the authority document's evidence threshold rather than treating architectural preference as product proof.
