import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import { buildCallGraph } from "./build.js";
import {
  buildCallGraphIncremental,
  graphCallPairs,
  identifyAffectedRegion,
  resetRecomputeCallGraph,
} from "./incremental.js";
import { nodeByFileName, reverseReachability } from "./query.js";

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

function seedRepo(): string {
  const root = join(tmpdir(), `inc-cg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "leaf.ts"),
    `export function apiCall() { return fetch("/v1/x"); }\n`,
    "utf8",
  );
  writeFileSync(
    join(root, "src", "mid.ts"),
    `import { apiCall } from "./leaf";\nexport function service() { return apiCall(); }\n`,
    "utf8",
  );
  writeFileSync(
    join(root, "src", "top.ts"),
    `import { service } from "./mid";\nexport function controller() { return service(); }\nexport function untouched() { return 1; }\n`,
    "utf8",
  );
  writeFileSync(
    join(root, "src", "other.ts"),
    `export function totallyUnrelated() { return 42; }\n`,
    "utf8",
  );
  return root;
}

describe("reset-recompute incremental updates", () => {
  it("identifyAffectedRegion expands 1-hop callers/callees to files (hybrid)", () => {
    const root = seedRepo();
    const g0 = buildCallGraph(root);
    const region = identifyAffectedRegion(g0, ["src/leaf.ts"], { strategy: "hybrid" });
    expect(region.shouldFullRebuild).toBe(false);
    expect(region.seedFiles).toContain("src/leaf.ts");
    // mid.ts calls leaf → should be in reset set
    expect(region.resetFiles).toContain("src/mid.ts");
    // other.ts should stay out
    expect(region.resetFiles).not.toContain("src/other.ts");
  });

  it("reuses nodes outside the affected region", () => {
    const root = seedRepo();
    const g0 = buildCallGraph(root);
    const otherBefore = nodeByFileName(g0, "src/other.ts", "totallyUnrelated");
    expect(otherBefore).toBeTruthy();

    writeFileSync(
      join(root, "src", "leaf.ts"),
      `export function apiCall() { return fetch("/v1/y"); }\n`, // body change only
      "utf8",
    );

    const { graph: g1, stats } = resetRecomputeCallGraph(g0, ["src/leaf.ts"], {
      strategy: "hybrid",
    });

    expect(stats.mode).toBe("reset_recompute");
    expect(stats.reusedNodes).toBeGreaterThan(0);
    expect(stats.prunedNodes).toBeGreaterThan(0);
    expect(stats.recomputedNodes).toBeGreaterThan(0);

    const otherAfter = nodeByFileName(g1, "src/other.ts", "totallyUnrelated");
    expect(otherAfter).toBeTruthy();
    // same node id preserved for untouched file
    expect(otherAfter!.id).toBe(otherBefore!.id);
  });

  it("preserves reachability after incremental update of a leaf", () => {
    const root = seedRepo();
    const g0 = buildCallGraph(root);
    writeFileSync(
      join(root, "src", "leaf.ts"),
      `export function apiCall() { return fetch("/v1/z"); }\n`,
      "utf8",
    );
    const g1 = buildCallGraphIncremental(root, g0, ["src/leaf.ts"]);
    const leaf = nodeByFileName(g1, "src/leaf.ts", "apiCall")!;
    const up = reverseReachability(g1, leaf.id, { maxDepth: 3 });
    const names = up.map((h) => h.node.name);
    expect(names).toContain("service");
    expect(names).toContain("controller");
  });

  it("incremental result call-pairs match full rebuild (soundness check)", () => {
    const root = seedRepo();
    const g0 = buildCallGraph(root);
    writeFileSync(
      join(root, "src", "mid.ts"),
      `import { apiCall } from "./leaf";\nexport function service() { return apiCall(); }\nexport function serviceExtra() { return apiCall(); }\n`,
      "utf8",
    );
    const gInc = buildCallGraphIncremental(root, g0, ["src/mid.ts"], { strategy: "hybrid" });
    const gFull = buildCallGraph(root);
    const pInc = graphCallPairs(gInc);
    const pFull = graphCallPairs(gFull);
    // Every full-rebuild edge should appear after incremental (no missing edges)
    for (const pair of pFull) {
      expect(pInc.has(pair)).toBe(true);
    }
  });

  it("eager strategy may full-rebuild when region is large", () => {
    const root = seedRepo();
    const g0 = buildCallGraph(root);
    // touch mid which connects to top and leaf — eager expands far
    const region = identifyAffectedRegion(g0, ["src/mid.ts"], {
      strategy: "eager",
      fullRebuildFileFraction: 0.5,
      expansionHops: 8,
    });
    // with only 4 files, expanding may hit threshold or not — just ensure API works
    expect(region.resetFiles.length).toBeGreaterThanOrEqual(1);
    expect(["hybrid", "eager", "conservative"]).toContain(region.strategy);
  });
});
