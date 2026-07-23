# Graph-Based Call Graph Construction for API Impact Analysis

## Role in Mendpoint

A call graph is a directed graph in which **nodes are functions/methods** and **edges are possible call relationships**. It is the primary mechanism for expanding from a *direct* API usage site to the broader set of code that is transitively affected—wrappers, helpers, service layers, and controllers.

Without a call graph, impact analysis is limited to local pattern matching. With one, the system can answer: *If this Acme/Stripe method changes, which `PaymentService` methods and which controllers that call them are affected?*

## Algorithm posture

| Algorithm | Role in this repo |
|-----------|-------------------|
| Name-based (RA) | Fallback for dynamic languages — soundness-biased (keep all name matches at low confidence) |
| CHA-lite | Use declared type hierarchy when methods have enclosing types |
| RTA-lite | Prefer types that are actually instantiated (`new X`) |
| Hybrid (default) | Direct resolution first → RTA/CHA → name fallback |

**Soundness over precision** for impact: missing a usage is worse than a false positive later filtered by confirmation/LLM.

## Construction pipeline (implemented)

Package: `@mendpoint/call-graph`

1. **Parsing & symbol extraction** — defs, call sites, classes, instantiations (heuristic; tree-sitter-ready)
2. **Symbol table + hierarchy** — `byName`, `parentsOf`, `instantiated`
3. **Direct call resolution** — unique name or same-file → high confidence
4. **Indirect / virtual** — RTA/CHA-lite; residual → name_match low confidence
5. **Graph assembly** — edges with `resolution`, `confidence`, `virtual`, call-site location

## Query API (implemented)

| Query | Purpose |
|-------|---------|
| `reverseReachability(seed, { maxDepth: 1–3 })` | Upstream callers for impact expansion |
| `forwardReachability` | Callees |
| `findWrappers(seeds)` | Thin service-layer abstractions |
| `impactSubgraph(seeds)` | Compact subgraph for LLM context windows |
| `propagateConfidence` | Demote confidence by path depth / edge quality |
| `classifyChanges` | Method-level: body / signature / add / delete + structural flags |
| `buildCallGraphIncremental` | **Reset-recompute** (see `INCREMENTAL_GRAPH.md`) |
| `identifyAffectedRegion` | Hybrid expansion + method-kind seeding + full-rebuild gates |
| `resetRecomputeCallGraph` | Prune + reanalyze + merge with metrics |
| `demandImpactSlice` | Demand-driven subgraph for impact queries |
| `validateAgainstFullRebuild` | Periodic soundness check |
| `pushSnapshot` / `maybeRollback` | Short rollback window |
| `createPersistentStore` / `commitGraphVersion` | Content-addressable multi-version store (structural sharing) |
| `materializeVersion` / `diffVersions` | Working graph + cheap version diffs |
| `redGreenQuery` | Memoized green/red analysis queries |




## Integration

```
Candidate (direct API site)
    → seed = nodeAt(file, line)
    → reverseReachability(k=3)
    → ExpandedContext.graphCallers + wrappers
    → Deep confirmation + PR evidence
```

Index embed: `CodebaseIndex.callGraph` is built whenever the codebase index is built.

## Hard cases (roadmap)

| Case | Now | Later |
|------|-----|-------|
| Virtual methods | CHA/RTA-lite | Full points-to |
| Callbacks / HOFs | Name match low conf | Staged “cocktail” resolution + LLM prune |
| Cross-language | Per-language graphs | Boundary stitching |
| Monorepo scale | **Reset-recompute hybrid** (implemented) | Finer AST-diff method prune + SDK graph cache |

| Tree-sitter | Heuristic front-end | Drop-in parser |

## Tests

- `packages/call-graph` — PaymentService → chargeCustomer → handleCheckout fixture
- `packages/codebase-index` — index embeds hybrid graph
- `packages/code-impact` — expansion surfaces graph callers/wrappers
