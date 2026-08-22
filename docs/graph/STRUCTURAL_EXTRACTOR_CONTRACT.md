# Structural extractor contract

## Boundary

The package root exports only Mendpoint types. A `StructuralGraphExtractor` has a content-addressed descriptor and accepts an exact `StructuralExtractionRequest`. Graphify raw types and process mechanics stay private.

The request binds:

- tenant and repository;
- immutable repository snapshot and 40 or 64 character revision;
- canonical manifest SHA-256;
- every file path, SHA-256, byte length, mode, and kind;
- a verified snapshot root used only by the trusted Mendpoint adapter to materialize exact bytes;
- file, input-byte, node, edge, output-byte, memory, and time limits;
- canonical observation time.

The adapter opens each regular file once, checks the opened handle's size before allocating, reads only the manifest-bound byte count, validates its digest, and passes a bounded byte copy to the isolated process. The process never receives the caller's mutable repository root. This removes the time-of-check to time-of-use gap that exists when a child reopens paths between preflight and postflight hashing. The private process bridge consumes only these materialized sources, reconstructs them under a fresh private root, and attests their exact bindings. Any mismatch fails closed and a partial extraction cannot be published.

## Canonical output

`mendpoint.structural-extraction.v1` contains tenant, repository, snapshot, revision, exact manifest digest and file bindings, extractor identity, languages, nodes, edges, ambiguities, warnings, operational metrics, and a semantic content digest. Reload validation rechecks those bindings before projection. The call-graph projection carries the same scope and manifest authority, and semantic publication rejects any tenant, repository, snapshot, revision, manifest, or content mismatch.

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

The Graphify adapter accepts a supervised isolated process operation, not an in-process callback. The pinned Linux launcher creates a new user and network namespace, passes the parent namespace identity to the bridge, and rejects a child that remains in the parent namespace. The bridge applies a hard address-space ceiling before importing Graphify, disables parallel extraction, and runs under a fresh private working directory. Every fulfilled result must attest that the child has exited; a missing exit confirmation triggers bounded termination and fails closed. The supervisor contract must escalate to process destruction within the bounded termination grace period and acknowledge process exit. Missing acknowledgement and supervisor errors are security failures. Operational extraction, language, and performance failures may fall back only after an injected authority durably records the exact fallback outcome. Security and identity failures never fall back. The current extractor remains byte-compatible when Graphify is disabled.

The repository compiles one evaluation pin for package `graphifyy` `0.9.46`, upstream revision `558df6d57d61cb6ef79c740ec7473c6d953d79a7`, and the official PyPI wheel `graphifyy-0.9.46-py3-none-any.whl` at SHA-256 `35d854d66884c623a8e25ca059b54744ade91ae17ffc0f79fd39e108a1666b5d`. The checked-in bridge has its own compiled digest, and the evaluation environment installs the direct wheel plus exact transitive versions from a private lock. Composition code cannot supply a replacement Graphify authority object. The process factory is not exported from the package root, no production selector or caller exists, and this pin authorizes only an internal Linux evaluation, not production activation.

## Persistence

The package does not create a second canonical graph store. Normalized structural facts project into the existing call-graph seam, and semantic facts publish through graph-learn's immutable software-graph versions. Tenant isolation and historical reads remain graph-learn responsibilities.
