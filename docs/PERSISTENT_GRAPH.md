# Persistent Graph Data Structures

In Mendpoint, **persistent** graph data structures represent call graphs (and related program graphs) so that:

- New versions after code changes do **not** require full copying
- Unchanged subgraphs are **structurally shared** across versions
- Current and historical states remain **queryable**
- Graphs scale toward large programs via content-addressable object stores

These properties directly support **reset-recompute**: the previous version stays intact and shareable while only the affected region is rewritten as new content-addressed objects.

## 1. Core concepts

| Mode | Meaning | Our default |
|------|---------|-------------|
| Partial persistence | Query all versions; update latest → new version | **Yes** |
| Full persistence | Update any historical version (branch) | Supported via `parentVersionId` |
| Confluent merge | Merge version DAGs | Roadmap |
| Purely functional | Updates produce new roots; maximize sharing | Content-addressable blobs |

**Techniques used:**

- **Content-addressable / Merkle-style hashing** — node/edge identity is a hash of payload (+ endpoint hashes for edges). Unchanged subgraphs share identity automatically.
- **Structural sharing** — object store `Map<hash, payload>`; versions are lists of hashes + a **root hash**.
- **Path-local rewrite** — reset-recompute only inserts hashes for the rewritten region; survivors are reused by reference.
- **Short version window + GC** — keep recent roots; drop unreferenced blobs.

We use **fast structural hashes** (FNV-1a + short SHA for roots), not security-grade crypto, to keep analysis cheap.

## 2. Architecture (hybrid)

```
┌─────────────────────────────────────────────────────────┐
│  Working CallGraph (mutable adjacency for queries)        │
│  reverseReachability / impactSubgraph / demand slices     │
└──────────────────────────▲──────────────────────────────┘
                           │ materializeVersion
                           │ commitGraphVersion
┌──────────────────────────┴──────────────────────────────┐
│  PersistentGraphStore (content-addressable object store)  │
│  nodes/ edges/ hierarchies  keyed by ContentHash          │
│  versions[] → rootHash, nodeHashes, edgeHashes, tags      │
└──────────────────────────▲──────────────────────────────┘
                           │ saveStoreToDisk / loadStoreFromDisk
┌──────────────────────────┴──────────────────────────────┐
│  Disk layout (Git-like)                                   │
│  nodes/{hash}.json  edges/{hash}.json  versions/{id}.json │
│  HEAD.json  libraries.json                                │
└─────────────────────────────────────────────────────────┘
```

1. **Working representation** — standard `CallGraph` for fast reachability (impact analysis).  
2. **Long-term multi-version store** — content-addressable snapshots with structural sharing.  
3. **Incrementality** — method/file reset-recompute → `commitAfterIncremental` produces a new root that shares most blobs with the parent.  
4. **Library layer** — `registerLibrary` for precomputed SDK roots (stitch later).  
5. **Versioning policy** — short window (`maxVersions`), tag versions used for production PRs (`pr:…`).

## 3. How persistence helps incremental updates

| Benefit | Mechanism |
|---------|-----------|
| Cheap new versions | Only new/changed node & edge hashes are interned; rest shared |
| Safe concurrent reads | Old versions remain materializable while a new one is built |
| Efficient change detection | `rootHash` equality ⇒ entire version identical; `diffVersions` for set diffs |
| Auditing & reproducibility | Tag graph version on generated PRs |
| Library sharing | Common SDK subgraphs registered once |
| Rollback / A/B | Multiple version roots; compare roots or materialize both |

In reset-recompute terms: **reset** drops runtime nodes; **recompute** builds a new working graph; **commit** turns that into a new persistent root that maximally shares with the parent.

## 4. API (`@mendpoint/call-graph`)

```ts
const store = createPersistentStore({ maxVersions: 8 });

const g0 = buildCallGraph(repoRoot);
const v0 = commitGraphVersion(store, g0, { label: "initial" });

const g1 = buildCallGraphIncremental(repoRoot, g0, changedFiles);
const v1 = commitAfterIncremental(store, g1, { tags: ["pr:42"] });

versionsEqual(store, v0.versionId, v1.versionId); // false if anything changed
diffVersions(store, v0.versionId, v1.versionId);   // added/removed hashes
latestSharingRatio(store);                          // reused/(reused+new)

const working = materializeVersion(store, v1.versionId);
saveStoreToDisk(store, ".mendpoint/graph-store");
```

### Key types

- `StoredNodePayload` / `StoredEdgePayload` — immutable blobs  
- `GraphVersionMeta` — `rootHash`, parent, hash lists, `sharing` stats, tags  
- `PersistentGraphStore` — object maps + version index + libraries  

## 5. Trade-offs

| Choice | Rationale |
|--------|-----------|
| Structural hash for nodes/edges | Cheap identity; not for security |
| Short SHA for roots | Stronger collision resistance for equality |
| Hybrid mutable working + immutable history | Best query perf + history |
| Method/file versioning granularity | Matches reset-recompute; avoids metadata explosion |
| Interning by hash | Automatic dedup of library-identical methods across commits |

## 6. Related designs (lineage)

- **Merkle DAGs** (Git, IPFS) — content identity + cheap equality  
- **Stack Graphs** — file-isolated subgraphs, incremental by compilation unit  
- **Temporal / MVCC graph stores** — long history; we approximate with version list + GC  
- **Lossless library summaries** — `libraries` map for future SDK stitching  

## 7. Fit summary

Persistent structures turn “mutate a giant mutable graph carefully” into “produce a new version that maximally shares structure with the old one.” Combined with method-level reset-recompute and change classification, they deliver:

- Large reductions in update cost for typical commits (sharing stats prove reuse)
- Auditing, reproducibility, multi-version experimentation
- A clean path to cross-customer library analysis reuse

**Highest-leverage default for Mendpoint:** structurally shared in-memory object store for the active working set, content-addressable disk snapshots for history and audit tags, working `CallGraph` materialized for impact queries.
