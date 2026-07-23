# Incremental Graph Update Strategies

Call graphs (and supporting program graphs) must stay current as customer repositories evolve. Full reconstruction on every push is too expensive at monorepo scale. Mendpoint uses **reset-recompute** as the dominant incremental paradigm, driven by **file- and method-level** change classification.

## 1. Primary strategy (recommended)

```
git / content-hash file list
        ↓
classifyChanges()  → body | signature | add | delete | hierarchy | import | structural
        ↓
identifyAffectedRegion()  → modest hop expansion on existing call graph
        ↓
[optional] pushSnapshot() for rollback window
        ↓
reset-recompute (prune + reanalyzeFiles + merge)
        ↓
metrics + residual uncertainties → impact / LLM stage
        ↓
periodic validateAgainstFullRebuild() on sample repos
```

**Start with** file- or method-level diffs, **expand a modest number of hops** via the existing graph, and **fall back to broader reset** when the change is structural (new packages, major refactoring, language-level shifts).

## 2. Core paradigm: reset-recompute

1. **Reset (invalidation)** — Identify the affected region; prune outdated nodes/edges.  
2. **Recompute (patch)** — Re-analyze only reset files + minimal context; insert nodes/edges into the surviving graph.

Industrial systems using this pattern report large speedups versus exhaustive reconstruction while preserving analysis correctness.

## 3. Handling specific kinds of changes

| Change type | Typical handling in this codebase |
|-------------|-----------------------------------|
| **Method body edit** (no signature change) | Seed = that method; re-analyze its file (outgoing CALLS edges refreshed); callers included only via soundness closure if needed. |
| **Signature / visibility change** | Seed = method **and its direct callers** (resolution may change); then hop expand + caller fixpoint. |
| **Add method** | File reparse; new node inserted; call sites re-resolved against survivors ∪ new. |
| **Delete method** | Node pruned; **all callers** must re-analyze (deletions retract edges carefully via caller fixpoint). |
| **Hierarchy / import change** | Broader reset: all virtual / CHA / RTA / import_context edge endpoints. |
| **Large structural** (manifests, new packages, many files) | **Full rebuild** (or package-level later). |

Deletions are harder than additions: information previously reachable through a node must be retracted. We do this by pruning the node **and** forcing caller recompute so edges are not silently dropped.

## 4. Region expansion & fallbacks

| Strategy | Behavior |
|----------|----------|
| `conservative` | 1 hop, prefer smaller regions |
| **`hybrid` (default)** | Method-classified seeds + 1 hop + hierarchy/import broadening + caller fixpoint |
| `eager` | Deep BFS (capped) when uncertain |

**Full rebuild when:**

- Changed method fraction ≥ **25%** (configurable; practical band **15–30%**)
- Dependency manifests change (`package.json`, `go.mod`, …)
- Large structural heuristics (many adds/deletes, new package roots)
- Reset **file** fraction ≥ **40%** and ≥ 5 files

## 5. Supporting techniques

| Technique | Module | Status |
|-----------|--------|--------|
| Reset-recompute | `incremental.ts` | **Primary, production path** |
| Method classification | `change-detect.ts` | **Implemented** |
| Snapshot / rollback window | `snapshot.ts` | **Implemented** (short ring buffer) |
| Red-green query memoization | `red-green.ts` | **Implemented** for pure graph queries |
| Demand-driven slices | `demand.ts` | **Implemented** (project subgraph for impact queries) |
| Soundness validation | `validate.ts` | **Implemented** (`validateAgainstFullRebuild`) |
| Library graph precompute + stitch | `registerLibrary` hooks | Stitch on materialize (roadmap) |
| Content-addressable / persistent store | `persistent.ts` | **Implemented** — see `PERSISTENT_GRAPH.md` |
| Parallel per-package recompute | — | Roadmap |


### Red-green (incremental compiler style)

`redGreenQuery(cache, graph, name, args, compute)` reuses **green** memoized reverse-reachability / impact results until the graph version changes, then marks them **red** and recomputes.

### Demand-driven

Impact analysis usually starts from known API surfaces and expands a few hops. `demandImpactSlice` + `residualUncertainties` feed the hybrid static + LLM confirmation stage without requiring a perfect whole-program graph.

### Snapshots

`pushSnapshot` before update; `maybeRollback` if incremental reuse is pathologically low.

## 6. Metrics (exposed on `CallGraph.lastIncremental`)

- `mode`: `reset_recompute` | `full_rebuild`
- `methodChanges`: body / signature / added / deleted counts  
- `changedMethodFraction`, `resetFiles`, pruned/reused/recomputed counts  
- `estimatedSpeedupVsFull`, `residualLowConfidenceEdges`, `durationMs`  
- `hierarchyDirty`, `importDirty`, `structuralFallback`

Also: `incrementalEfficiencyMetrics(previous, updated)` for dashboards.

## 7. Relationship to downstream impact analysis

Impact queries are localized (API surface → few hops). A conservatively over-approximated or slightly stale graph is often still useful. The updater keeps the **high-confidence core** fresh so most API-change queries stay fast and precise. Residual low-confidence / virtual edges become LLM confirmation candidates (`residualUncertainties`).

## 8. Multi-language monorepos

Today: one application-centered hybrid graph for TS/JS/Python.  
Next: **per-language graphs** + a thin **cross-language boundary layer** (HTTP/gRPC/queues) updated more conservatively than intra-language edges.

## 9. API surface

```ts
classifyChanges(previous, changedFiles)
identifyAffectedRegion(previous, changedFiles, opts)
buildCallGraphIncremental(repoRoot, previous, changedFiles, opts)
resetRecomputeCallGraph(previous, changedFiles, opts)

// supporting
pushSnapshot / maybeRollback
createRedGreenCache / redGreenQuery
demandImpactSlice / residualUncertainties
validateAgainstFullRebuild
```

## 10. Tests

- Method classification: body vs signature vs add/delete  
- Region expansion + caller fixpoint  
- Reuse of untouched nodes  
- Incremental call-pairs ⊇ full rebuild (soundness)  
- Reachability preserved after leaf edits  

In short: a **method-granularity reset-recompute pipeline**, driven by precise change detection and bounded expansion, delivers the efficiency needed to keep call graphs current while preserving the soundness required for reliable API impact analysis.
