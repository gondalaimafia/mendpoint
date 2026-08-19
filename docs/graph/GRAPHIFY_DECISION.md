# Graphify decision

## Decision

**KEEP AS INTERNAL TOOL ONLY** for Graphify `0.9.46` at commit `558df6d57d61cb6ef79c740ec7473c6d953d79a7`.

This is not production adoption, fallback activation, or permission to install Graphify in customer workers. The Mendpoint-owned contract and adapter boundary remain available for a controlled offline benchmark.

## Basis

Quality potential is credible because Graphify has broad language extraction and substantial cross-file resolution. Quality evidence is insufficient because upstream benchmark harnesses/raw ledgers are absent and Mendpoint has not run the required hidden Stripe holdout.

Engineering effort is not yet lower. A Node/TypeScript product would add a separately locked Python runtime, grammar wheels, subprocess lifecycle, memory enforcement, SBOM/patching work, and compatibility tests.

Operational cost is unmeasured. Graphify's mutable output, undirected default, incomplete diff, Windows lock gap, and high graph-file ceiling cannot serve as mission authority.

License terms are acceptable for a wrapper, but no upstream dependency or code is distributed in this decision. Any later distribution must carry Apache-2.0 and retained MIT notices.

Security posture is acceptable only for an isolated, code-only, network-denied child process over an immutable snapshot. Graphify's MCP/HTTP server and mixed semantic ingestion are excluded.

Known blind spots include runtime dispatch, reflection, dependency injection, generated/runtime-only behavior, shared infrastructure, uneven language extractors, optional grammars, and uncalibrated confidence.

## What was built

- exact authority and ADR recording;
- Mendpoint structural extractor interface;
- Graphify normalization with manifest/byte binding;
- original confidence and provenance retention;
- hard process timeout/termination contract;
- classified Graphify failures and safe fallback;
- stable identity and Mendpoint-owned incremental diff;
- projection to the current call graph;
- a Stripe SDK to endpoint to wrapper to test semantic integration test;
- a label-free three-arm benchmark and sealed-key grader contract.

## What was deliberately not built or activated

- Graphify Python process implementation or dependency;
- Graphify MCP server, storage, graph database, communities, or query API;
- production environment flag or worker wiring;
- external model calls;
- claimed hidden-holdout/performance results;
- Graphify as delivery authority.

## Reconsideration gate

Reconsider only after the exact pinned process, network denial, immutable snapshot verification, 18-case sealed cohort, incremental equality, four-tier performance run, license/SBOM packaging, and independent review all pass. Any adoption decision must be per language and recorded in a successor ADR.
