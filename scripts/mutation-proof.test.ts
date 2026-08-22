import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateRequirement,
  applyMutant,
  type CitationResult,
  diffRequirements,
  generateMutants,
  proveCitation,
  resolveImplFiles,
  testCitations,
  type TestRunner,
} from "./mutation-proof.js";

// ---------------------------------------------------------------------------
// Mutation operators
// ---------------------------------------------------------------------------

describe("generateMutants", () => {
  it("emits a removal delete-if-guard (verdict-deciding) and a diagnostic invert-if for a returning guard", () => {
    const source = `export function f(n: number): string {
  if (n < 2) return "blocked";
  return "eligible";
}
`;
    const mutants = generateMutants("f.ts", source);
    const guardDelete = mutants.find((m) => m.operator === "delete-if-guard")!;
    const invert = mutants.find((m) => m.operator === "invert-if")!;
    expect(guardDelete.kind).toBe("removal");
    expect(invert.kind).toBe("diagnostic");
    // Guard-shaped removals lead so a genuine control is killed cheaply.
    expect(mutants[0]!.kind).toBe("removal");
    expect(guardDelete.priority).toBe(0);
  });

  it("emits strip-throw as removal and void-return as diagnostic", () => {
    const source = `export function g(x: unknown): number {
  if (!x) throw new Error("no");
  return compute(x);
}
`;
    const mutants = generateMutants("g.ts", source);
    const throwMutant = mutants.find((m) => m.operator === "strip-throw")!;
    const voidReturn = mutants.find((m) => m.operator === "void-return")!;
    expect(throwMutant.kind).toBe("removal");
    expect(voidReturn.kind).toBe("diagnostic");
  });

  it("does not treat a nested function's return as this guard's exit", () => {
    // The if-branch only declares a callback; deleting the if is not a guard
    // delete, so it must rank below a real guard.
    const source = `export function h(items: number[]): number[] {
  if (items.length) {
    const map = (v: number) => { return v * 2; };
    return items.map(map);
  }
  return [];
}
`;
    const mutants = generateMutants("h.ts", source);
    const guardDelete = mutants.find((m) => m.operator === "delete-if-guard")!;
    // This if DOES contain a top-level return (items.map), so it is a guard.
    expect(guardDelete.priority).toBe(0);
  });

  it("skips a bare `return undefined`", () => {
    const source = `export function n(): undefined { return undefined; }\n`;
    expect(generateMutants("n.ts", source).some((m) => m.operator === "void-return")).toBe(false);
  });
});

describe("applyMutant", () => {
  it("splices the replacement and preserves every other byte", () => {
    const source = `if (a) return 1;\nconst kept = "  spaced  ";\n`;
    const mutant = generateMutants("x.ts", source).find((m) => m.operator === "delete-if-guard")!;
    const mutated = applyMutant(source, mutant);
    expect(mutated).not.toContain("return 1");
    // Surrounding bytes, including the deliberately spaced literal, are intact.
    expect(mutated).toContain(`const kept = "  spaced  ";`);
    // Reconstructing the original from offsets is byte-exact.
    const restored = mutated.slice(0, mutant.start) + source.slice(mutant.start, mutant.end) + mutated.slice(mutant.start + mutant.replacement.length);
    expect(restored).toBe(source);
  });

  it("invert-if negates the condition text exactly", () => {
    const source = `if (observed === undefined || !known.has(observed)) return "not_verified";\n`;
    const mutant = generateMutants("x.ts", source).find((m) => m.operator === "invert-if")!;
    expect(applyMutant(source, mutant)).toContain("!(observed === undefined || !known.has(observed))");
  });
});

// ---------------------------------------------------------------------------
// Register parsing / diff gating
// ---------------------------------------------------------------------------

describe("testCitations", () => {
  it("keeps only test-type evidence, dropping document/external/live", () => {
    const requirement = {
      id: "R",
      implementationStatus: "verified",
      acceptance: [
        {
          evidence: [
            { type: "unit", locator: "a.test.ts" },
            { type: "document", locator: "docs/x.md" },
            { type: "integration", locator: "b.test.ts" },
            { type: "external", locator: "external:creds" },
          ],
        },
      ],
    };
    expect(testCitations(requirement).map((e) => e.locator)).toEqual(["a.test.ts", "b.test.ts"]);
  });
});

describe("diffRequirements", () => {
  const req = (id: string, status: string, locator: string) => ({
    id,
    implementationStatus: status,
    acceptance: [{ evidence: [{ type: "unit", locator }] }],
  });
  const wrap = (rs: unknown[]) => JSON.stringify({ requirements: rs });

  it("selects a requirement newly moved to verified", () => {
    const base = wrap([req("A", "partial", "a.test.ts")]);
    const head = wrap([req("A", "verified", "a.test.ts")]);
    expect(diffRequirements(base, head)).toEqual(["A"]);
  });

  it("selects a verified requirement whose evidence changed", () => {
    const base = wrap([req("A", "verified", "a.test.ts")]);
    const head = wrap([req("A", "verified", "b.test.ts")]);
    expect(diffRequirements(base, head)).toEqual(["A"]);
  });

  it("ignores a verified requirement untouched by the diff (keeps it cheap)", () => {
    const base = wrap([req("A", "verified", "a.test.ts"), req("B", "verified", "b.test.ts")]);
    const head = wrap([req("A", "verified", "a.test.ts"), req("B", "verified", "b.test.ts (renamed title only, evidence same)".replace(/ .*/, ""))]);
    // B's locator token is unchanged ("b.test.ts"), A untouched -> nothing.
    expect(diffRequirements(base, head)).toEqual([]);
  });

  it("selects a brand-new verified requirement with no base entry", () => {
    const base = wrap([]);
    const head = wrap([req("A", "verified", "a.test.ts")]);
    expect(diffRequirements(base, head)).toEqual(["A"]);
  });
});

// ---------------------------------------------------------------------------
// Implementation resolution
// ---------------------------------------------------------------------------

describe("resolveImplFiles", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("resolves the sibling source and local relative imports, excluding test files and workspace deps", () => {
    dir = mkdtempSync(join(tmpdir(), "mp-resolve-"));
    writeFileSync(join(dir, "widget.ts"), "export const w = 1;\n");
    writeFileSync(join(dir, "helper.ts"), "export const h = 2;\n");
    const testPath = join(dir, "widget.test.ts");
    const source = [
      `import { w } from "./widget.js";`,
      `import { h } from "./helper.js";`,
      `import { z } from "@mendpoint/platform";`,
      `import { describe } from "vitest";`,
    ].join("\n");
    writeFileSync(testPath, source);
    const resolved = resolveImplFiles(testPath, source).map((p) => p.split(/[\\/]/).pop());
    expect(resolved).toContain("widget.ts");
    expect(resolved).toContain("helper.ts");
    expect(resolved).not.toContain("widget.test.ts");
    expect(resolved.some((f) => f?.includes("platform"))).toBe(false);
  });

  it("ignores type-only imports (erased at runtime, never a mutation target)", () => {
    dir = mkdtempSync(join(tmpdir(), "mp-typeonly-"));
    writeFileSync(join(dir, "contract.ts"), "export type Contract = { ok: boolean };\nexport const guard = (c: Contract) => { if (!c.ok) return false; return true; };\n");
    const testPath = join(dir, "widget.test.ts");
    // The unit under test imports the contract ONLY as a type.
    const source = [
      `import type { Contract } from "./contract.js";`,
      `import { render } from "./widget.js";`,
    ].join("\n");
    writeFileSync(join(dir, "widget.ts"), "export const render = () => 1;\n");
    writeFileSync(testPath, source);
    const resolved = resolveImplFiles(testPath, source).map((p) => p.split(/[\\/]/).pop());
    expect(resolved).toContain("widget.ts");
    expect(resolved).not.toContain("contract.ts");
  });

  it("returns nothing when no sibling and no local import resolves (an undetermined signal)", () => {
    dir = mkdtempSync(join(tmpdir(), "mp-resolve2-"));
    const testPath = join(dir, "orphan.test.ts");
    const source = `import { x } from "@mendpoint/platform";\n`;
    writeFileSync(testPath, source);
    expect(resolveImplFiles(testPath, source)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The prove loop — real disk mutate/restore, fake (fast) test runner
// ---------------------------------------------------------------------------

/**
 * A runner whose verdict is decided by reading the CURRENT bytes of the impl
 * file on disk, so it exercises the real mutate-run-restore cycle without
 * shelling to vitest. It "passes" only while the named control string is
 * present — i.e. it behaves like a test that actually exercises the control.
 */
function controlSensingRunner(implAbs: string, control: string): TestRunner {
  return () => {
    const present = readFileSync(implAbs, "utf8").includes(control);
    return { ran: true, passed: present };
  };
}

describe("proveCitation", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("reports KILLED when mutating the implementation makes the cited test fail, and restores bytes exactly", () => {
    dir = mkdtempSync(join(tmpdir(), "mp-kill-"));
    const impl = `export function assess(distinct: number): string {
  if (distinct < 2) return "blocked";
  return "eligible";
}
`;
    const implAbs = join(dir, "gate.ts");
    writeFileSync(implAbs, impl);
    writeFileSync(join(dir, "gate.test.ts"), `import "./gate.js";\n`);

    const result = proveCitation({
      repoRoot: dir,
      testFileRel: "gate.test.ts",
      locator: "gate.test.ts",
      // Test "passes" only while the corroboration guard is present.
      runTest: controlSensingRunner(implAbs, `return "blocked"`),
    });

    expect(result.verdict).toBe("killed");
    expect(result.killedBy?.file).toBe("gate.ts");
    // Byte-for-byte restore: the file is exactly what we wrote.
    expect(readFileSync(implAbs, "utf8")).toBe(impl);
  });

  it("reports SURVIVED when the implementation can be neutered and the test still passes (the inert control)", () => {
    // Reconstruct the delegated-verifier shape: an identity comparison guard
    // that no test exercises. Deleting it changes nothing the test observes.
    dir = mkdtempSync(join(tmpdir(), "mp-survive-"));
    const impl = `export function verify(d: { authorityId: string; producerId: string }): boolean {
  if (d.authorityId === d.producerId) return false;
  return true;
}
`;
    const implAbs = join(dir, "verify.ts");
    writeFileSync(implAbs, impl);
    writeFileSync(join(dir, "verify.test.ts"), `import "./verify.js";\n`);

    const result = proveCitation({
      repoRoot: dir,
      testFileRel: "verify.test.ts",
      locator: "verify.test.ts",
      // A test that passes no matter what the implementation says: decoration.
      runTest: () => ({ ran: true, passed: true }),
    });

    expect(result.verdict).toBe("survived");
    expect(result.mutantsTried).toBeGreaterThan(0);
    expect(readFileSync(implAbs, "utf8")).toBe(impl); // restored
  });

  it("does not let an inverted condition manufacture a kill on an untested guard branch", () => {
    // Soundness regression: the guard's TRIGGERING branch (colluding actors) is
    // never tested; only the happy path (distinct actors -> ok:true) is. A
    // removal (delete-if-guard) leaves the happy path unchanged, so it must
    // SURVIVE. An invert-if would flip the happy path to ok:false and look like
    // a kill — it must not be allowed to decide the verdict.
    dir = mkdtempSync(join(tmpdir(), "mp-sound-"));
    const impl = `export function verify(d: { a: string; b: string }): { ok: boolean } {
  if (d.a === d.b) return { ok: false };
  return { ok: true };
}
`;
    const implAbs = join(dir, "verify.ts");
    writeFileSync(implAbs, impl);
    writeFileSync(join(dir, "verify.test.ts"), `import "./verify.js";\n`);

    // A runner standing in for a happy-path-only test: it passes as long as the
    // happy-path exit (`return { ok: true }`) is still present. Deleting the
    // guard leaves that exit intact, so the removal must survive. (A diagnostic
    // void-return would remove that literal, but a diagnostic can never flip the
    // verdict to killed.)
    const runner: TestRunner = () => ({
      ran: true,
      passed: /return \{ ok: true \}/.test(readFileSync(implAbs, "utf8")),
    });
    const result = proveCitation({ repoRoot: dir, testFileRel: "verify.test.ts", locator: "verify.test.ts", runTest: runner });
    expect(result.verdict).toBe("survived");
    expect(readFileSync(implAbs, "utf8")).toBe(impl);
  });

  it("reports UNDETERMINED when the implementation cannot be located", () => {
    dir = mkdtempSync(join(tmpdir(), "mp-undet-"));
    const testPath = "orphan.test.ts";
    writeFileSync(join(dir, testPath), `import { x } from "@mendpoint/platform";\n`);
    const result = proveCitation({
      repoRoot: dir,
      testFileRel: testPath,
      locator: testPath,
      runTest: () => ({ ran: true, passed: true }),
    });
    expect(result.verdict).toBe("undetermined");
    expect(result.reason).toMatch(/could not locate the implementation/i);
  });

  it("reports UNDETERMINED (never a kill) when the test is red at baseline", () => {
    dir = mkdtempSync(join(tmpdir(), "mp-red-"));
    writeFileSync(join(dir, "x.ts"), `export const x = 1;\n`);
    writeFileSync(join(dir, "x.test.ts"), `import "./x.js";\n`);
    const result = proveCitation({
      repoRoot: dir,
      testFileRel: "x.test.ts",
      locator: "x.test.ts",
      runTest: () => ({ ran: true, passed: false }),
    });
    expect(result.verdict).toBe("undetermined");
    expect(result.reason).toMatch(/red at baseline/i);
  });

  it("restores the file even if the runner throws mid-loop", () => {
    dir = mkdtempSync(join(tmpdir(), "mp-throw-"));
    const impl = `export function f(n: number): string {\n  if (n < 2) return "a";\n  return "b";\n}\n`;
    const implAbs = join(dir, "f.ts");
    writeFileSync(implAbs, impl);
    writeFileSync(join(dir, "f.test.ts"), `import "./f.js";\n`);
    let call = 0;
    const runner: TestRunner = () => {
      call += 1;
      if (call === 1) return { ran: true, passed: true }; // baseline
      throw new Error("runner exploded");
    };
    expect(() =>
      proveCitation({ repoRoot: dir, testFileRel: "f.test.ts", locator: "f.test.ts", runTest: runner }),
    ).toThrow(/exploded/);
    expect(readFileSync(implAbs, "utf8")).toBe(impl); // still restored
  });
});

// ---------------------------------------------------------------------------
// Requirement aggregation
// ---------------------------------------------------------------------------

describe("aggregateRequirement", () => {
  const cite = (verdict: CitationResult["verdict"], locator = "t.test.ts"): CitationResult => ({
    locator,
    verdict,
    reason: verdict,
    implFiles: [],
    mutantsTried: 0,
  });

  it("is survived if any citation survived", () => {
    expect(aggregateRequirement("R", [cite("killed"), cite("survived", "b.test.ts")]).verdict).toBe("survived");
  });

  it("is killed only when at least one citation is killed and none survived", () => {
    expect(aggregateRequirement("R", [cite("killed"), cite("undetermined")]).verdict).toBe("killed");
  });

  it("is undetermined when a verified requirement cites no test evidence at all", () => {
    const result = aggregateRequirement("R", []);
    expect(result.verdict).toBe("undetermined");
    expect(result.reason).toMatch(/no test-type evidence/i);
  });

  it("is undetermined when no citation could be evaluated", () => {
    expect(aggregateRequirement("R", [cite("undetermined")]).verdict).toBe("undetermined");
  });
});
