/**
 * Red-green dependency tracking (incremental-compiler style).
 *
 * Analysis queries are pure functions of graph inputs. Mark "red" when inputs
 * change; reuse "green" memoized results. Used for reverse-reachability and
 * impact-subgraph queries that dominate impact analysis latency.
 */
import type { CallGraph } from "./types.js";

export type QueryColor = "red" | "green";

export type MemoEntry<T> = {
  color: QueryColor;
  /** Fingerprint of inputs (graph version + args) */
  inputKey: string;
  value: T;
  computedAt: string;
};

export type RedGreenCache = {
  graphVersion: string;
  entries: Map<string, MemoEntry<unknown>>;
};

export function graphVersion(g: CallGraph): string {
  return `${g.builtAt}:${g.stats.nodeCount}:${g.stats.edgeCount}:${g.lastIncremental?.mode ?? "full"}`;
}

export function createRedGreenCache(g: CallGraph): RedGreenCache {
  return { graphVersion: graphVersion(g), entries: new Map() };
}

/** Invalidate all entries when the graph version changes. */
export function syncCacheToGraph(cache: RedGreenCache, g: CallGraph): void {
  const v = graphVersion(g);
  if (v !== cache.graphVersion) {
    cache.graphVersion = v;
    // mark all red by clearing — green only after recompute
    cache.entries.clear();
  }
}

export function queryKey(name: string, args: unknown): string {
  return `${name}:${JSON.stringify(args)}`;
}

/**
 * Run a memoized query: return green hit or recompute and store green.
 */
export function redGreenQuery<T>(
  cache: RedGreenCache,
  g: CallGraph,
  name: string,
  args: unknown,
  compute: () => T,
): { value: T; color: QueryColor } {
  syncCacheToGraph(cache, g);
  const key = queryKey(name, args);
  const hit = cache.entries.get(key) as MemoEntry<T> | undefined;
  if (hit && hit.color === "green" && hit.inputKey === `${cache.graphVersion}:${key}`) {
    return { value: hit.value, color: "green" };
  }
  const value = compute();
  cache.entries.set(key, {
    color: "green",
    inputKey: `${cache.graphVersion}:${key}`,
    value,
    computedAt: new Date().toISOString(),
  });
  return { value, color: "red" }; // was recomputed (was red)
}

/** Mark a specific query dirty (red). */
export function markRed(cache: RedGreenCache, name: string, args?: unknown): void {
  if (args === undefined) {
    for (const k of cache.entries.keys()) {
      if (k.startsWith(name + ":")) cache.entries.delete(k);
    }
  } else {
    cache.entries.delete(queryKey(name, args));
  }
}
