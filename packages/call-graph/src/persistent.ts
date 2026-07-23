/**
 * Persistent / content-addressable graph store for call graphs.
 *
 * Goals:
 * - New versions after code changes without full graph copying
 * - Structural sharing of unchanged nodes/edges across versions (by content hash)
 * - Fast equality / "has anything changed?" via root hashes
 * - Short history window + tags for audit / PR reproducibility
 * - Optional disk persistence (JSON object store, Git-like)
 *
 * Taxonomy fit:
 * - Partial persistence by default (query any version; update produces new current)
 * - Content-addressable (Merkle-style) node/edge identity with non-crypto structural hashes
 * - Working set = materialize(version) → CallGraph for fast reachability
 *
 * Combined with reset-recompute: only rewritten region inserts new hashes;
 * the bulk of the previous version is reused by reference in the object store.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  CallEdge,
  CallEdgeConfidence,
  CallGraph,
  CallResolution,
  FunctionNode,
  TypeHierarchy,
} from "./types.js";
import { rebuildAdjacency, emptyHierarchy } from "./build.js";

// ---------------------------------------------------------------------------
// Content-addressable payloads
// ---------------------------------------------------------------------------

export type ContentHash = string;

/** Node payload without ephemeral analysis ids (location may shift; stable key preferred). */
export type StoredNodePayload = {
  stableKey: string;
  name: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  language: FunctionNode["language"];
  enclosingType?: string;
  isExternalApi: boolean;
  isTest: boolean;
  signature?: string;
  bodyHash?: string;
  qualifiedName: string;
};

export type StoredEdgePayload = {
  callerHash: ContentHash;
  calleeHash: ContentHash;
  callSiteFile: string;
  callSiteLine: number;
  resolution: CallResolution;
  confidence: CallEdgeConfidence;
  virtual: boolean;
};

export type GraphVersionMeta = {
  versionId: string;
  /** Root content hash over sorted node+edge hashes + hierarchy fingerprint */
  rootHash: ContentHash;
  createdAt: string;
  parentVersionId?: string;
  nodeHashes: ContentHash[];
  edgeHashes: ContentHash[];
  hierarchyHash: ContentHash;
  algorithm: CallGraph["algorithm"];
  repoRoot: string;
  tags: string[];
  label?: string;
  /** Structural sharing stats vs parent */
  sharing?: {
    parentNodeCount: number;
    parentEdgeCount: number;
    reusedNodes: number;
    reusedEdges: number;
    newNodes: number;
    newEdges: number;
  };
};

export type LibraryRef = {
  /** e.g. stripe@14.0.0 */
  id: string;
  rootHash: ContentHash;
  label?: string;
};

/**
 * In-memory object store: maps content hash → immutable payload.
 * Multiple versions share the same map entries (structural sharing).
 */
export type PersistentGraphStore = {
  nodes: Map<ContentHash, StoredNodePayload>;
  edges: Map<ContentHash, StoredEdgePayload>;
  hierarchies: Map<ContentHash, TypeHierarchy>;
  versions: Map<string, GraphVersionMeta>;
  /** Newest last */
  versionOrder: string[];
  currentVersionId?: string;
  /** Max versions retained in the short window (older dropped from index; objects may GC) */
  maxVersions: number;
  /** Optional precomputed SDK/library subgraphs */
  libraries: Map<string, LibraryRef>;
};

// ---------------------------------------------------------------------------
// Hashing (structural, non-crypto-strength is fine for analysis graphs)
// ---------------------------------------------------------------------------

export function structuralHash(input: string): ContentHash {
  // FNV-1a 32-bit — fast; sufficient for analysis identity (not security)
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function shaShort(input: string): ContentHash {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function nodeStableKey(n: Pick<FunctionNode, "filePath" | "name" | "enclosingType">): string {
  return `${n.filePath.replace(/\\/g, "/")}::${n.enclosingType ?? ""}::${n.name}`;
}

export function hashNodePayload(p: StoredNodePayload): ContentHash {
  // Identity ignores line numbers for sharing across whitespace-only shifts of body-identical methods
  // but includes bodyHash + signature so real edits get new identity
  return structuralHash(
    [
      p.stableKey,
      p.language,
      p.bodyHash ?? "",
      p.signature ?? "",
      p.isExternalApi ? "1" : "0",
      p.isTest ? "1" : "0",
    ].join("|"),
  );
}

export function hashEdgePayload(p: StoredEdgePayload): ContentHash {
  return structuralHash(
    [
      p.callerHash,
      p.calleeHash,
      p.callSiteFile,
      String(p.callSiteLine),
      p.resolution,
      p.confidence,
      p.virtual ? "1" : "0",
    ].join("|"),
  );
}

export function hashHierarchy(h: TypeHierarchy): ContentHash {
  return structuralHash(
    JSON.stringify({
      p: Object.keys(h.parentsOf)
        .sort()
        .map((k) => [k, [...(h.parentsOf[k] ?? [])].sort()]),
      i: [...h.instantiated].sort(),
      m: Object.keys(h.methodsOfType)
        .sort()
        .map((k) => [k, [...(h.methodsOfType[k] ?? [])].sort()]),
    }),
  );
}

export function hashRoot(
  nodeHashes: ContentHash[],
  edgeHashes: ContentHash[],
  hierarchyHash: ContentHash,
): ContentHash {
  const n = [...nodeHashes].sort().join(",");
  const e = [...edgeHashes].sort().join(",");
  return shaShort(`nodes:${n}|edges:${e}|hier:${hierarchyHash}`);
}

// ---------------------------------------------------------------------------
// Store lifecycle
// ---------------------------------------------------------------------------

export function createPersistentStore(opts?: { maxVersions?: number }): PersistentGraphStore {
  return {
    nodes: new Map(),
    edges: new Map(),
    hierarchies: new Map(),
    versions: new Map(),
    versionOrder: [],
    maxVersions: opts?.maxVersions ?? 8,
    libraries: new Map(),
  };
}

function internNode(store: PersistentGraphStore, p: StoredNodePayload): ContentHash {
  const h = hashNodePayload(p);
  if (!store.nodes.has(h)) store.nodes.set(h, p);
  return h;
}

function internEdge(store: PersistentGraphStore, p: StoredEdgePayload): ContentHash {
  const h = hashEdgePayload(p);
  if (!store.edges.has(h)) store.edges.set(h, p);
  return h;
}

function internHierarchy(store: PersistentGraphStore, hier: TypeHierarchy): ContentHash {
  const h = hashHierarchy(hier);
  if (!store.hierarchies.has(h)) {
    store.hierarchies.set(h, {
      parentsOf: { ...hier.parentsOf },
      instantiated: [...hier.instantiated],
      methodsOfType: { ...hier.methodsOfType },
    });
  }
  return h;
}

function functionNodeToPayload(n: FunctionNode): StoredNodePayload {
  return {
    stableKey: nodeStableKey(n),
    name: n.name,
    filePath: n.filePath.replace(/\\/g, "/"),
    lineStart: n.lineStart,
    lineEnd: n.lineEnd,
    language: n.language,
    enclosingType: n.enclosingType,
    isExternalApi: n.isExternalApi,
    isTest: n.isTest,
    signature: n.signature,
    bodyHash: n.bodyHash,
    qualifiedName: n.qualifiedName,
  };
}

/**
 * Commit a working CallGraph as a new immutable version.
 * Unchanged node/edge payloads are shared with prior versions via the object store.
 */
export function commitGraphVersion(
  store: PersistentGraphStore,
  graph: CallGraph,
  opts?: {
    parentVersionId?: string;
    label?: string;
    tags?: string[];
  },
): GraphVersionMeta {
  const parentId = opts?.parentVersionId ?? store.currentVersionId;
  const parent = parentId ? store.versions.get(parentId) : undefined;

  // Map runtime node id → content hash
  const idToHash = new Map<string, ContentHash>();
  const nodeHashes: ContentHash[] = [];
  for (const n of Object.values(graph.nodes)) {
    const h = internNode(store, functionNodeToPayload(n));
    idToHash.set(n.id, h);
    nodeHashes.push(h);
  }

  const edgeHashes: ContentHash[] = [];
  for (const e of graph.edges) {
    const ch = idToHash.get(e.callerId);
    const th = idToHash.get(e.calleeId);
    if (!ch || !th) continue;
    const eh = internEdge(store, {
      callerHash: ch,
      calleeHash: th,
      callSiteFile: e.callSiteFile.replace(/\\/g, "/"),
      callSiteLine: e.callSiteLine,
      resolution: e.resolution,
      confidence: e.confidence,
      virtual: e.virtual,
    });
    edgeHashes.push(eh);
  }

  const hierarchyHash = internHierarchy(store, graph.hierarchy);
  const uniqueNodes = [...new Set(nodeHashes)];
  const uniqueEdges = [...new Set(edgeHashes)];
  const rootHash = hashRoot(uniqueNodes, uniqueEdges, hierarchyHash);

  const parentNodeSet = new Set(parent?.nodeHashes ?? []);
  const parentEdgeSet = new Set(parent?.edgeHashes ?? []);
  let reusedNodes = 0;
  let newNodes = 0;
  for (const h of uniqueNodes) {
    if (parentNodeSet.has(h)) reusedNodes++;
    else newNodes++;
  }
  let reusedEdges = 0;
  let newEdges = 0;
  for (const h of uniqueEdges) {
    if (parentEdgeSet.has(h)) reusedEdges++;
    else newEdges++;
  }

  const versionId = `v-${Date.now().toString(36)}-${rootHash.slice(0, 8)}`;
  const meta: GraphVersionMeta = {
    versionId,
    rootHash,
    createdAt: new Date().toISOString(),
    parentVersionId: parentId,
    nodeHashes: uniqueNodes,
    edgeHashes: uniqueEdges,
    hierarchyHash,
    algorithm: graph.algorithm,
    repoRoot: graph.repoRoot,
    tags: opts?.tags ?? [],
    label: opts?.label,
    sharing: parent
      ? {
          parentNodeCount: parent.nodeHashes.length,
          parentEdgeCount: parent.edgeHashes.length,
          reusedNodes,
          reusedEdges,
          newNodes,
          newEdges,
        }
      : undefined,
  };

  store.versions.set(versionId, meta);
  store.versionOrder.push(versionId);
  store.currentVersionId = versionId;
  compactVersionIndex(store);
  return meta;
}

/** Drop old version index entries beyond maxVersions (object store keeps shared blobs). */
export function compactVersionIndex(store: PersistentGraphStore): void {
  while (store.versionOrder.length > store.maxVersions) {
    const old = store.versionOrder.shift();
    if (old && old !== store.currentVersionId) {
      store.versions.delete(old);
    }
  }
  // Optional GC of unreferenced objects
  gcUnreferenced(store);
}

export function gcUnreferenced(store: PersistentGraphStore): { nodes: number; edges: number } {
  const liveN = new Set<ContentHash>();
  const liveE = new Set<ContentHash>();
  const liveH = new Set<ContentHash>();
  for (const v of store.versions.values()) {
    v.nodeHashes.forEach((h) => liveN.add(h));
    v.edgeHashes.forEach((h) => liveE.add(h));
    liveH.add(v.hierarchyHash);
  }
  let droppedN = 0;
  let droppedE = 0;
  for (const h of store.nodes.keys()) {
    if (!liveN.has(h)) {
      store.nodes.delete(h);
      droppedN++;
    }
  }
  for (const h of store.edges.keys()) {
    if (!liveE.has(h)) {
      store.edges.delete(h);
      droppedE++;
    }
  }
  for (const h of store.hierarchies.keys()) {
    if (!liveH.has(h)) store.hierarchies.delete(h);
  }
  return { nodes: droppedN, edges: droppedE };
}

/**
 * Materialize a version into a working CallGraph (adjacency rebuilt).
 * Shared payloads are copied into a mutable analysis structure.
 */
export function materializeVersion(
  store: PersistentGraphStore,
  versionId?: string,
): CallGraph {
  const vid = versionId ?? store.currentVersionId;
  if (!vid) throw new Error("No graph version to materialize");
  const meta = store.versions.get(vid);
  if (!meta) throw new Error(`Unknown version ${vid}`);

  const nodes: Record<string, FunctionNode> = {};
  const hashToRuntimeId = new Map<ContentHash, string>();

  for (const nh of meta.nodeHashes) {
    const p = store.nodes.get(nh);
    if (!p) continue;
    // Runtime id: stableKey preferred for cross-version continuity of analysis
    const id = `${p.filePath}::${p.name}@${p.lineStart}`;
    hashToRuntimeId.set(nh, id);
    nodes[id] = {
      id,
      qualifiedName: p.qualifiedName,
      name: p.name,
      filePath: p.filePath,
      lineStart: p.lineStart,
      lineEnd: p.lineEnd,
      language: p.language,
      enclosingType: p.enclosingType,
      isExternalApi: p.isExternalApi,
      isTest: p.isTest,
      signature: p.signature,
      bodyHash: p.bodyHash,
    };
  }

  const edges: CallEdge[] = [];
  for (const eh of meta.edgeHashes) {
    const p = store.edges.get(eh);
    if (!p) continue;
    const callerId = hashToRuntimeId.get(p.callerHash);
    const calleeId = hashToRuntimeId.get(p.calleeHash);
    if (!callerId || !calleeId) continue;
    edges.push({
      id: `${callerId}->${calleeId}@${p.callSiteLine}`,
      callerId,
      calleeId,
      callSiteFile: p.callSiteFile,
      callSiteLine: p.callSiteLine,
      resolution: p.resolution,
      confidence: p.confidence,
      virtual: p.virtual,
    });
  }

  const hierarchy = store.hierarchies.get(meta.hierarchyHash) ?? emptyHierarchy();
  const graph: CallGraph = {
    repoRoot: meta.repoRoot,
    builtAt: meta.createdAt,
    algorithm: meta.algorithm,
    nodes,
    edges,
    outEdges: {},
    inEdges: {},
    byName: {},
    hierarchy: {
      parentsOf: { ...hierarchy.parentsOf },
      instantiated: [...hierarchy.instantiated],
      methodsOfType: { ...hierarchy.methodsOfType },
    },
    stats: { nodeCount: 0, edgeCount: 0, directEdges: 0, approxEdges: 0 },
  };
  rebuildAdjacency(graph);
  return graph;
}

/** O(1) equality of entire reachable version content. */
export function versionsEqual(
  store: PersistentGraphStore,
  a: string,
  b: string,
): boolean {
  const va = store.versions.get(a);
  const vb = store.versions.get(b);
  if (!va || !vb) return false;
  return va.rootHash === vb.rootHash;
}

/** Fast set-diff of two versions by content hash (unchanged subgraph detection). */
export function diffVersions(
  store: PersistentGraphStore,
  fromVersionId: string,
  toVersionId: string,
): {
  addedNodes: ContentHash[];
  removedNodes: ContentHash[];
  addedEdges: ContentHash[];
  removedEdges: ContentHash[];
  rootChanged: boolean;
} {
  const a = store.versions.get(fromVersionId);
  const b = store.versions.get(toVersionId);
  if (!a || !b) throw new Error("Unknown version in diff");
  const aN = new Set(a.nodeHashes);
  const bN = new Set(b.nodeHashes);
  const aE = new Set(a.edgeHashes);
  const bE = new Set(b.edgeHashes);
  return {
    addedNodes: [...bN].filter((h) => !aN.has(h)),
    removedNodes: [...aN].filter((h) => !bN.has(h)),
    addedEdges: [...bE].filter((h) => !aE.has(h)),
    removedEdges: [...aE].filter((h) => !bE.has(h)),
    rootChanged: a.rootHash !== b.rootHash,
  };
}

export function tagVersion(
  store: PersistentGraphStore,
  versionId: string,
  tag: string,
): void {
  const v = store.versions.get(versionId);
  if (!v) throw new Error(`Unknown version ${versionId}`);
  if (!v.tags.includes(tag)) v.tags.push(tag);
}

export function findVersionByTag(
  store: PersistentGraphStore,
  tag: string,
): GraphVersionMeta | undefined {
  for (let i = store.versionOrder.length - 1; i >= 0; i--) {
    const id = store.versionOrder[i]!;
    const v = store.versions.get(id);
    if (v?.tags.includes(tag)) return v;
  }
  return undefined;
}

/**
 * Register a precomputed library/SDK subgraph root for cross-repo sharing.
 * Customer graphs can reference library ids rather than re-deriving SDK nodes.
 */
export function registerLibrary(
  store: PersistentGraphStore,
  ref: LibraryRef,
): void {
  store.libraries.set(ref.id, ref);
}

// ---------------------------------------------------------------------------
// Disk persistence (content-addressable JSON object store)
// ---------------------------------------------------------------------------

export type DiskLayout = {
  dir: string;
};

/**
 * Persist store to disk:
 *   {dir}/nodes/{hash}.json
 *   {dir}/edges/{hash}.json
 *   {dir}/hierarchies/{hash}.json
 *   {dir}/versions/{versionId}.json
 *   {dir}/HEAD.json
 *   {dir}/libraries.json
 */
export function saveStoreToDisk(store: PersistentGraphStore, dir: string): void {
  mkdirSync(join(dir, "nodes"), { recursive: true });
  mkdirSync(join(dir, "edges"), { recursive: true });
  mkdirSync(join(dir, "hierarchies"), { recursive: true });
  mkdirSync(join(dir, "versions"), { recursive: true });

  for (const [h, p] of store.nodes) {
    writeFileSync(join(dir, "nodes", `${h}.json`), JSON.stringify(p), "utf8");
  }
  for (const [h, p] of store.edges) {
    writeFileSync(join(dir, "edges", `${h}.json`), JSON.stringify(p), "utf8");
  }
  for (const [h, p] of store.hierarchies) {
    writeFileSync(join(dir, "hierarchies", `${h}.json`), JSON.stringify(p), "utf8");
  }
  for (const [id, v] of store.versions) {
    writeFileSync(join(dir, "versions", `${id}.json`), JSON.stringify(v), "utf8");
  }
  writeFileSync(
    join(dir, "HEAD.json"),
    JSON.stringify({
      currentVersionId: store.currentVersionId,
      versionOrder: store.versionOrder,
      maxVersions: store.maxVersions,
    }),
    "utf8",
  );
  writeFileSync(
    join(dir, "libraries.json"),
    JSON.stringify([...store.libraries.entries()]),
    "utf8",
  );
}

export function loadStoreFromDisk(dir: string): PersistentGraphStore {
  const store = createPersistentStore();
  if (!existsSync(dir)) return store;

  const loadDir = (sub: string, into: Map<string, unknown>) => {
    const p = join(dir, sub);
    if (!existsSync(p)) return;
    for (const f of readdirSync(p)) {
      if (!f.endsWith(".json")) continue;
      const h = f.replace(/\.json$/, "");
      into.set(h, JSON.parse(readFileSync(join(p, f), "utf8")));
    }
  };

  loadDir("nodes", store.nodes as Map<string, StoredNodePayload>);
  loadDir("edges", store.edges as Map<string, StoredEdgePayload>);
  loadDir("hierarchies", store.hierarchies as Map<string, TypeHierarchy>);

  const vp = join(dir, "versions");
  if (existsSync(vp)) {
    for (const f of readdirSync(vp)) {
      if (!f.endsWith(".json")) continue;
      const v = JSON.parse(readFileSync(join(vp, f), "utf8")) as GraphVersionMeta;
      store.versions.set(v.versionId, v);
    }
  }

  const headPath = join(dir, "HEAD.json");
  if (existsSync(headPath)) {
    const head = JSON.parse(readFileSync(headPath, "utf8")) as {
      currentVersionId?: string;
      versionOrder?: string[];
      maxVersions?: number;
    };
    store.currentVersionId = head.currentVersionId;
    store.versionOrder = head.versionOrder ?? [...store.versions.keys()];
    store.maxVersions = head.maxVersions ?? store.maxVersions;
  }

  const libPath = join(dir, "libraries.json");
  if (existsSync(libPath)) {
    const entries = JSON.parse(readFileSync(libPath, "utf8")) as [string, LibraryRef][];
    store.libraries = new Map(entries);
  }

  return store;
}

/**
 * Convenience: commit incremental result and return sharing stats.
 * Turns reset-recompute into a new persistent root that shares blobs with parent.
 */
export function commitAfterIncremental(
  store: PersistentGraphStore,
  graph: CallGraph,
  opts?: { label?: string; tags?: string[] },
): GraphVersionMeta {
  return commitGraphVersion(store, graph, {
    parentVersionId: store.currentVersionId,
    label: opts?.label ?? "incremental",
    tags: opts?.tags,
  });
}

/** Share ratio for the latest commit vs its parent (1 = fully shared). */
export function latestSharingRatio(store: PersistentGraphStore): number {
  const cur = store.currentVersionId
    ? store.versions.get(store.currentVersionId)
    : undefined;
  if (!cur?.sharing) return 0;
  const total = cur.sharing.reusedNodes + cur.sharing.newNodes;
  if (!total) return 0;
  return cur.sharing.reusedNodes / total;
}
