# Structural extractor contract

## Boundary

The package root exports only Mendpoint types. A `StructuralGraphExtractor` has a content-addressed descriptor and accepts an exact `StructuralExtractionRequest`. Graphify raw types and process mechanics stay private.

The request binds:

- tenant and repository;
- immutable repository snapshot and 40 or 64 character revision;
- canonical manifest SHA-256;
- every file path, SHA-256, byte length, mode, and kind;
- a verified snapshot root;
- file, input-byte, node, edge, output-byte, memory, and time limits;
- canonical observation time.

The adapter must prove that the files it actually observed reproduce the authorized manifest. Any mismatch fails with `GRAPHIFY_IDENTITY_INSTABILITY`; a partial extraction cannot be published.

## Canonical output

`mendpoint.structural-extraction.v1` contains tenant, repository, snapshot, revision, extractor identity, languages, nodes, edges, ambiguities, warnings, operational metrics, and a semantic content digest.

Canonical node identity is derived from tenant, repository, snapshot, repository-relative file, Mendpoint node kind, and qualified name. Upstream IDs are provenance only. Canonical keys omit snapshot so successor versions can be diffed. Runtime duration, memory, and observation time do not change the semantic content digest.

Canonical edge kinds remain specific: `imports`, `calls`, `inherits`, `implements`, `references`, `contains`, `defines`, `tests`, `uses`, `re_exports`, and `method`. Unknown relations fail closed rather than becoming a generic dependency.

## Epistemic mapping

| Graphify | Mendpoint structural state |
|---|---|
| `EXTRACTED` | `observed` |
| `INFERRED` | `inferred` |
| `AMBIGUOUS` | `ambiguous` plus an explicit ambiguity record |

The original confidence label, relation, source file, location, Graphify version, snapshot, and observation time remain in provenance. Structural state cannot be promoted to deterministic provider truth without separate corroboration.

## Security and failure behavior

Absolute, empty, aliased, duplicate, and parent-traversal paths reject. Nodes and edges may cite only files in the authorized manifest. Dangling endpoints, duplicate facts, unknown confidence, skipped files, unsupported languages, excessive output, and memory breaches reject.

The Graphify adapter accepts a killable isolated process operation, not an in-process callback. On deadline it invokes termination and returns `GRAPHIFY_PERFORMANCE_FAILURE`. Fallback is allowed only for classified structural failures. The current extractor remains byte-compatible when Graphify is disabled.

## Persistence

The package does not create a second canonical graph store. Normalized structural facts project into the existing call-graph seam, and semantic facts publish through graph-learn's immutable software-graph versions. Tenant isolation and historical reads remain graph-learn responsibilities.
