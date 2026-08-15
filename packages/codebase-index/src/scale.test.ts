import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildIndex, getCallers } from "./index.js";

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

describe("codebase-index scale", () => {
  it("records a wide fan-in completely and without duplicates within budget", () => {
    // Many callers of one symbol. The previous adjacency build rebuilt a fresh
    // Set/array per caller (O(K^2) for K callers); this proves it is complete,
    // deduplicated, and fast.
    const root = join(tmpdir(), `idx-fanin-${Date.now()}`);
    dirs.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    const callers = 1000;
    let src = `export function target() { return 1; }\n`;
    for (let i = 0; i < callers; i++) src += `export function caller${i}() { return target(); }\n`;
    writeFileSync(join(root, "src", "fan.js"), src);

    const start = performance.now();
    const index = buildIndex(root);
    const elapsed = performance.now() - start;

    const upstream = getCallers(index, "target", 1);
    expect(upstream.length).toBe(callers);
    expect(new Set(upstream).size).toBe(callers); // no duplicates
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);

  it("indexes a large synthetic tree within a stated budget", () => {
    const count = 1500;
    const root = join(tmpdir(), `idx-scale-${Date.now()}`);
    dirs.push(root);
    for (let i = 0; i < count; i++) {
      const dir = join(root, "packages", `pkg${i}`, "src");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "mod.js"),
        `export function entry${i}(req) { return { source: req.source, id: ${i} }; }\n`,
      );
    }
    const budgetMs = 45_000;
    const start = performance.now();
    const index = buildIndex(root);
    const elapsed = performance.now() - start;
    expect(index.files.length).toBe(count);
    expect(elapsed).toBeLessThan(budgetMs);
  }, 90_000);
});
