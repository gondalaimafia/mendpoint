# Graphify evaluation

## Scope and authority

This evaluation implements issue [#238](https://github.com/gondalaimafia/mendpoint/issues/238) under the checked in [Graphify integration authority](../authority/Codex_Master_Prompt_Integrate_Graphify_Into_the_Mendpoint_Change_Graph.md). The source document SHA-256 is `083069e29c6711d309c6af2ed07ae1968a103f18374232a55a493d00ef7105b0`; the repository-normalized copy SHA-256 is `1d68a6a76bbed1bc1d92310e193b22505266aab58a73043e83917b8a12d53ba0`.

Graphify was inspected at `Graphify-Labs/graphify` commit `558df6d57d61cb6ef79c740ec7473c6d953d79a7`, package `graphifyy` `0.9.46`, tag `v0.9.46`. README claims were checked against `detect`, `extract`, `build`, `cluster`, `analyze`, `graph_diff`, cache, watch, validation, export, security, and MCP server code.

## What Graphify does well

- Its code-only path uses tree-sitter and covers substantially more languages than Mendpoint's current TypeScript, JavaScript, and Python call-graph front end.
- Its strongest resolvers handle cross-file imports, calls, inheritance, type references, aliases, and several language-specific dispatch patterns.
- Its per-file cache and changed-source replacement logic are useful implementation references for incremental extraction.
- It retains source file, source location, relation, and one of `EXTRACTED`, `INFERRED`, or `AMBIGUOUS` on most facts.
- It has meaningful path, symlink, atomic-write, SSRF, and response-size safeguards for its intended local developer-tool use.
- Apache-2.0 permits a wrapper integration if `LICENSE`, `NOTICE`, and the retained `LICENSE-MIT` attribution accompany any distributed dependency or copied source.

## Where Mendpoint is stronger

- Mendpoint binds tenant, repository, immutable snapshot, exact revision, provider snapshot, evidence, status, validity, conflicts, coverage, and graph version.
- Mendpoint keeps directed relationship semantics. Graphify's normal `build_from_json` and `build` default to an undirected NetworkX graph.
- Mendpoint's immutable software graph publishes successors atomically and supports historical exact-version queries. Graphify centers a mutable `graphify-out/graph.json`.
- Mendpoint owns provider SDK and endpoint resolution, impact semantics, evidence paths, review authority, verification, learning attribution, and model routing.
- Mendpoint failure taxonomy can distinguish structural misses from semantic, runtime, query, and model failures.

## Overlap

Both systems discover symbols, calls, imports, inheritance, references, structural paths, and partial incremental changes. The integration boundary therefore ends after normalized structural extraction. Graphify storage, IDs, NetworkX objects, communities, query server, and confidence conventions do not become canonical Mendpoint interfaces.

## Material gaps and blockers

| Finding | Consequence |
|---|---|
| No schema version, tenant, manifest digest, parser artifact identity, or mandatory snapshot binding in Graphify output | Raw output is untrusted candidate evidence only. |
| Missing confidence can be backfilled as `EXTRACTED`; numeric confidence and hyperedges are not fully validated | Mendpoint must validate every fact and retain the original label. |
| `graph_diff` compares IDs and relation endpoints but ignores attributes, confidence, locations, provenance, weights, and hyperedges | Mendpoint must own temporal diff and invalidation. |
| Windows watcher locking is a no-op because it depends on `fcntl` | Do not use watch as concurrent production authority. |
| Mixed document/media extraction and MCP PR tools can make network calls | Only isolated code-only extraction is eligible for the experiment. |
| MCP HTTP may bind broadly, uses one API key, and accepts caller-selected project paths | Do not adopt the MCP server for tenant production. |
| Graph JSON can reach 512 MiB before parsing and extraction lacks one universal file-size limit | Enforce Mendpoint file, byte, node, edge, output, memory, and time ceilings outside Graphify. |
| Published benchmark harnesses and raw result ledgers are absent | Upstream benchmark numbers are claims, not Mendpoint adoption evidence. |
| Language quality is uneven and several grammars are optional or regex fallbacks | Any future decision must be per language. |

## Implemented experiment boundary

`@mendpoint/structural-graph` now defines a Mendpoint-owned extraction contract, exact manifest binding, deterministic identity, Graphify normalization, provenance retention, a killable process-port boundary, classified failures, fallback, incremental diff, and a projection into the existing call graph. The Graphify process port remains private and has no production implementation. No Graphify dependency, wheel, MCP server, graph database, external model call, or runtime flag is activated.

## Conclusion

Graphify is promising as an offline structural extractor experiment, especially for selected languages and internal wrapper expansion. Version `0.9.46` has not earned production or default-extractor status. The current decision is **KEEP AS INTERNAL TOOL ONLY** until a real pinned, network-denied, hidden-holdout benchmark clears the gates in [GRAPHIFY_BENCHMARK.md](GRAPHIFY_BENCHMARK.md).
