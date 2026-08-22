# ADR-0006: Keep Graphify behind the Mendpoint structural extraction boundary

- **Status:** Accepted
- **Date:** 2026-08-19
- **Author:** OpenAI Codex
- **Decision owner:** Talal Gondal
- **Authority:** [`Codex_Master_Prompt_Integrate_Graphify_Into_the_Mendpoint_Change_Graph.md`](../authority/Codex_Master_Prompt_Integrate_Graphify_Into_the_Mendpoint_Change_Graph.md), repository SHA-256 `1d68a6a76bbed1bc1d92310e193b22505266aab58a73043e83917b8a12d53ba0`, source SHA-256 `083069e29c6711d309c6af2ed07ae1968a103f18374232a55a493d00ef7105b0`
- **Extends:** ADR-0005
- **Supersedes:** none
- **Superseded by:** none

## Context

Graphify can reduce work in commodity static extraction, particularly across languages and files. It does not provide Mendpoint's tenant, immutable snapshot, evidence, temporal, provider, migration, verification, or learning authority. Version `0.9.46` also defaults normal graph builds to undirected storage, has an incomplete diff, uneven extractors, mutable output, and developer-tool security assumptions.

## Decision

Mendpoint owns `StructuralGraphExtractor` and `mendpoint.structural-extraction.v1`. Graphify-specific raw types, IDs, process mechanics, NetworkX graph, storage, communities, and query APIs remain private. Accepted Graphify facts must bind an exact tenant repository snapshot manifest, pass Mendpoint validation and resource limits, retain upstream provenance, and project through existing call-graph and immutable software-graph seams.

Graphify `0.9.46` is **KEEP AS INTERNAL TOOL ONLY**. A private, pinned Linux process implementation exists for controlled evaluation, but there is no production dependency, feature activation, exported process factory, or runtime caller. The current extractor remains authoritative. A classified Graphify failure may fall back to it; unexpected failures remain visible.

## Alternatives considered

Directly adopting `graphify-out/graph.json` was rejected because it is mutable, underspecified, and not tenant or snapshot authority. Adopting the MCP server was rejected because it lacks graph-level tenant authorization and permits caller-selected project paths. Forking or vendoring was rejected before benchmark value is proven. Rebuilding every Graphify feature in TypeScript was rejected as speculative work.

## Consequences

The adapter and benchmark contracts can test Graphify without product leakage. The tradeoff is a future Python process and packaging obligation if Graphify qualifies. Mendpoint must continue to own diff, persistence, semantic promotion, provider join, evidence, coverage, and failure attribution.

## Security and rollback

Only a code-only, network-denied, killable child process over an immutable verified snapshot is eligible. File, byte, node, edge, output, memory, and time ceilings are mandatory. Rollback is removal or disabling of the private adapter; no persisted product contract depends on Graphify.

## Reconsideration

A successor ADR may adopt Graphify for specific languages only after the sealed hidden-holdout and performance gates in [GRAPHIFY_BENCHMARK.md](../graph/GRAPHIFY_BENCHMARK.md), license/SBOM packaging, and independent review pass.
