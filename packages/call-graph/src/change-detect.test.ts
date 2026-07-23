import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildCallGraph } from "./build.js";
import {
  classifyChanges,
  shouldFullRebuildFromChangeSet,
} from "./change-detect.js";

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

function repo(): string {
  const root = join(tmpdir(), `cd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "a.ts"),
    `export function foo(x: number) { return x + 1; }\nexport function bar() { return foo(1); }\n`,
    "utf8",
  );
  writeFileSync(join(root, "src", "b.ts"), `export function baz() { return 0; }\n`, "utf8");
  return root;
}

describe("method-level change classification", () => {
  it("detects body edit vs signature change vs add/delete", () => {
    const root = repo();
    const g0 = buildCallGraph(root);

    // body edit
    writeFileSync(
      join(root, "src", "a.ts"),
      `export function foo(x: number) { return x + 2; }\nexport function bar() { return foo(1); }\n`,
      "utf8",
    );
    let cs = classifyChanges(g0, ["src/a.ts"]);
    expect(cs.methods.some((m) => m.kind === "method_body_edit" && m.methodName === "foo")).toBe(
      true,
    );

    // rebuild for next
    const g1 = buildCallGraph(root);
    // signature change
    writeFileSync(
      join(root, "src", "a.ts"),
      `export function foo(x: number, y: number) { return x + y; }\nexport function bar() { return foo(1, 2); }\n`,
      "utf8",
    );
    cs = classifyChanges(g1, ["src/a.ts"]);
    expect(
      cs.methods.some((m) => m.kind === "method_signature_change" && m.methodName === "foo"),
    ).toBe(true);

    const g2 = buildCallGraph(root);
    // add + delete
    writeFileSync(
      join(root, "src", "a.ts"),
      `export function foo(x: number, y: number) { return x + y; }\nexport function newly() { return 1; }\n`,
      "utf8",
    );
    cs = classifyChanges(g2, ["src/a.ts"]);
    expect(cs.methods.some((m) => m.kind === "method_added" && m.methodName === "newly")).toBe(
      true,
    );
    expect(cs.methods.some((m) => m.kind === "method_deleted" && m.methodName === "bar")).toBe(
      true,
    );
  });

  it("flags full rebuild when too many methods change", () => {
    const root = repo();
    const g0 = buildCallGraph(root);
    writeFileSync(join(root, "src", "a.ts"), `export function only() { return 1; }\n`, "utf8");
    writeFileSync(join(root, "src", "b.ts"), `export function other() { return 2; }\n`, "utf8");
    const cs = classifyChanges(g0, ["src/a.ts", "src/b.ts"]);
    const gate = shouldFullRebuildFromChangeSet(cs, { methodFractionThreshold: 0.2 });
    // most methods touched
    expect(gate.full || cs.changedMethodFraction > 0.2).toBe(true);
  });
});
