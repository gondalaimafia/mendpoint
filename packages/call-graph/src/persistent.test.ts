import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildCallGraph } from "./build.js";
import { buildCallGraphIncremental } from "./incremental.js";
import {
  commitAfterIncremental,
  commitGraphVersion,
  createPersistentStore,
  diffVersions,
  latestSharingRatio,
  loadStoreFromDisk,
  materializeVersion,
  saveStoreToDisk,
  tagVersion,
  versionsEqual,
} from "./persistent.js";

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

function seed(): string {
  const root = join(tmpdir(), `pg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "a.ts"),
    `export function leaf() { return 1; }\nexport function mid() { return leaf(); }\n`,
    "utf8",
  );
  writeFileSync(
    join(root, "src", "b.ts"),
    `export function other() { return 99; }\n`,
    "utf8",
  );
  return root;
}

describe("persistent content-addressable graph store", () => {
  it("commits versions with structural sharing on small edits", () => {
    const root = seed();
    const store = createPersistentStore({ maxVersions: 5 });
    const g0 = buildCallGraph(root);
    const v0 = commitGraphVersion(store, g0, { label: "initial" });
    expect(v0.rootHash).toBeTruthy();
    expect(store.nodes.size).toBeGreaterThan(0);

    // Touch only leaf body
    writeFileSync(
      join(root, "src", "a.ts"),
      `export function leaf() { return 2; }\nexport function mid() { return leaf(); }\n`,
      "utf8",
    );
    const g1 = buildCallGraphIncremental(root, g0, ["src/a.ts"]);
    const v1 = commitAfterIncremental(store, g1, { label: "after-leaf" });

    expect(v1.parentVersionId).toBe(v0.versionId);
    expect(v1.sharing).toBeTruthy();
    // other() and possibly mid() may share depending on hashes
    expect(v1.sharing!.reusedNodes).toBeGreaterThan(0);
    expect(v1.rootHash).not.toBe(v0.rootHash);
    expect(versionsEqual(store, v0.versionId, v1.versionId)).toBe(false);

    const ratio = latestSharingRatio(store);
    expect(ratio).toBeGreaterThan(0);
  });

  it("materialize reconstructs a queryable CallGraph", () => {
    const root = seed();
    const store = createPersistentStore();
    const g0 = buildCallGraph(root);
    const v0 = commitGraphVersion(store, g0);
    const g = materializeVersion(store, v0.versionId);
    expect(Object.keys(g.nodes).length).toBe(g0.stats.nodeCount);
    expect(g.edges.length).toBe(g0.stats.edgeCount);
    expect(g.stats.nodeCount).toBe(g0.stats.nodeCount);
  });

  it("diffVersions reports added/removed hashes", () => {
    const root = seed();
    const store = createPersistentStore();
    const g0 = buildCallGraph(root);
    const v0 = commitGraphVersion(store, g0);
    writeFileSync(
      join(root, "src", "b.ts"),
      `export function other() { return 99; }\nexport function extra() { return 0; }\n`,
      "utf8",
    );
    const g1 = buildCallGraphIncremental(root, g0, ["src/b.ts"]);
    const v1 = commitAfterIncremental(store, g1);
    const d = diffVersions(store, v0.versionId, v1.versionId);
    expect(d.rootChanged).toBe(true);
    expect(d.addedNodes.length + d.removedNodes.length).toBeGreaterThan(0);
  });

  it("tags versions for PR audit and round-trips disk", () => {
    const root = seed();
    const store = createPersistentStore();
    const g0 = buildCallGraph(root);
    const v0 = commitGraphVersion(store, g0);
    tagVersion(store, v0.versionId, "pr:demo-1");

    const disk = join(root, ".mendpoint", "graph-store");
    saveStoreToDisk(store, disk);
    const loaded = loadStoreFromDisk(disk);
    expect(loaded.currentVersionId).toBe(store.currentVersionId);
    expect(loaded.versions.get(v0.versionId)?.tags).toContain("pr:demo-1");
    const g = materializeVersion(loaded, v0.versionId);
    expect(g.stats.nodeCount).toBeGreaterThan(0);
  });
});
