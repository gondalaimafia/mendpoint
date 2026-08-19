# Graphify adapter

## Pin

The experiment is designed against Graphify `0.9.46`, commit `558df6d57d61cb6ef79c740ec7473c6d953d79a7`. The adapter rejects any other declared version. No wheel or upstream source is currently distributed by Mendpoint, so no third-party code has been vendored and no production SBOM entry has been added.

If the experiment later installs Graphify, it must pin the exact wheel/source digest, Python runtime, tree-sitter versions, and minimal grammar set. Distribution must retain Graphify's Apache-2.0 `LICENSE`, `NOTICE`, and `LICENSE-MIT` attribution.

## Execution model

The safe design is a Mendpoint-owned child process that imports Graphify's Python library `extract(...)` with an explicit root, `parallel` policy, and code-only file list. It must not invoke the Graphify CLI, mixed document extraction, semantic model path, MCP server, graph database exporters, or mutable `graphify-out/graph.json` as mission authority.

The private process protocol must:

1. receive the exact manifest-bound plan;
2. hash each file actually read;
3. call the pinned Graphify library;
4. return raw extraction JSON, observed file bindings, peak memory, warnings, and failures;
5. support hard termination;
6. make no network calls;
7. write no repository state.

The current repository contains the process-port contract and adversarial tests, but intentionally no production process implementation or Graphify dependency. This keeps the experiment non-activatable while the adoption gate is negative.

## Normalization

The adapter maps accepted raw nodes and edges into `mendpoint.structural-extraction.v1`, preserves upstream provenance, rejects unknown relations and confidence, and derives Mendpoint IDs independently of Graphify IDs. It then projects function, method, test, and `calls` facts into the existing call graph. Graphify provenance travels as structural evidence references and extractor identity when those calls are promoted into the immutable software graph.

## Flag and rollback

`extractWithFallback` supplies the strict flag behavior expected for a future `GRAPHIFY_STRUCTURAL_EXTRACTOR_ENABLED` binding. Disabled calls use the current extractor. Classified Graphify failures call the current extractor. Unexpected programming failures do not silently disappear.

No environment variable is read today and no production caller selects Graphify. Rollback is therefore simply omission of the private adapter; the current extraction path remains unchanged.

## Upgrade procedure

For any new Graphify release: inspect source and license, pin exact artifacts, run schema compatibility tests, rerun all three benchmark arms and blind spots, compare incremental output with a full rebuild, repeat resource/security probes, obtain independent review, and record a new decision. A version string change alone is not sufficient.
