import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildCallGraph, reverseReachability } from "./index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
});

/** Create a synthetic monorepo-like tree of `count` files with cross-file calls. */
function makeTree(count: number): { root: string; sources: Map<string, string> } {
  const root = join(tmpdir(), `cg-scale-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dirs.push(root);
  const sources = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const dir = join(root, "packages", `pkg${i}`, "src");
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, "mod.js");
    const text = `
function helper${i}(x) { return x + ${i}; }
export function entry${i}(x) {
  return helper${i}(x) + helper${(i + 1) % count}(x);
}
`;
    writeFileSync(abs, text);
    sources.set(abs, text);
  }
  return { root, sources };
}

describe("call-graph scale", () => {
  it("threading pre-read sources yields a byte-identical graph to reading from disk", () => {
    const { root, sources } = makeTree(40);
    const fromDisk = buildCallGraph(root, { algorithm: "hybrid" });
    const fromSources = buildCallGraph(root, { algorithm: "hybrid", sources });
    const strip = (g: ReturnType<typeof buildCallGraph>) =>
      JSON.stringify({ ...g, builtAt: "" });
    expect(strip(fromSources)).toBe(strip(fromDisk));
    expect(fromDisk.stats.nodeCount).toBeGreaterThan(0);
  });

  it("builds a large synthetic tree within a stated budget", () => {
    const count = 1500;
    const { root, sources } = makeTree(count);
    const budgetMs = 30_000;
    const start = performance.now();
    const graph = buildCallGraph(root, { algorithm: "hybrid", sources });
    const elapsed = performance.now() - start;
    // 2 functions per file (helperN + entryN)
    expect(graph.stats.nodeCount).toBe(count * 2);
    expect(elapsed).toBeLessThan(budgetMs);
  }, 60_000);

  it("reverse reachability over a wide fan-in stays within budget and finds every caller", () => {
    // One shared callee invoked by many callers — exercises the id->edge index
    // and the index-pointer BFS queue (previously O(E^2) / O(n^2)).
    const root = join(tmpdir(), `cg-fanin-${Date.now()}`);
    dirs.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    const callers = 1200;
    let src = `export function target() { return 1; }\n`;
    for (let i = 0; i < callers; i++) src += `export function caller${i}() { return target(); }\n`;
    writeFileSync(join(root, "src", "fan.js"), src);

    const graph = buildCallGraph(root, { algorithm: "hybrid" });
    const targetId = (graph.byName["target"] ?? [])[0]!;
    expect(targetId).toBeTruthy();

    const start = performance.now();
    const hits = reverseReachability(graph, targetId, { maxDepth: 3 });
    const elapsed = performance.now() - start;
    expect(hits.length).toBe(callers);
    expect(elapsed).toBeLessThan(5_000);
  }, 60_000);
});
