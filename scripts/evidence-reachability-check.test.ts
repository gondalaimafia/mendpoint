import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeCitation,
  buildRepoIndex,
  evaluateStrictGate,
  runReachabilityReport,
  type RepoIndex,
} from "./evidence-reachability-check.js";

// ---------------------------------------------------------------------------
// Fixture harness: a minimal on-disk repository we fully control.
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function makeRepo(files: Record<string, string>): RepoIndex {
  const root = mkdtempSync(join(tmpdir(), "reach-"));
  tempRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return buildRepoIndex(root);
}

const PKG = (name: string) => JSON.stringify({ name, main: "./src/index.ts" });

/** Baseline repo: one entry (server) that uses `liveThing`; `deadLeaf` used by no one. */
function baselineRepo(extra: Record<string, string> = {}): RepoIndex {
  return makeRepo({
    "package.json": JSON.stringify({ name: "fixture", scripts: {} }),
    "apps/api/package.json": JSON.stringify({ name: "@mendpoint/api" }),
    "apps/api/src/server.ts": `import { liveThing } from "@mendpoint/core";\nliveThing();\n`,
    "packages/core/package.json": PKG("@mendpoint/core"),
    "packages/core/src/index.ts":
      `export { liveThing } from "./live.js";\n` +
      `export { deadLeaf } from "./dead.js";\n`,
    "packages/core/src/live.ts": `export function liveThing(): number {\n  return 1;\n}\n`,
    "packages/core/src/dead.ts": `export function deadLeaf(): number {\n  return 2;\n}\n`,
    // orphan.ts calls deadViaOrphan, but orphan.ts itself is imported by nobody
    // (not even the barrel) — so it is never reached from an entry point.
    "packages/core/src/orphan.ts":
      `import { deadViaOrphan } from "./transitive.js";\n` +
      `export function orphanThing(): number {\n  return deadViaOrphan();\n}\n`,
    "packages/core/src/transitive.ts": `export function deadViaOrphan(): number {\n  return 3;\n}\n`,
    ...extra,
  });
}

const cite = (index: RepoIndex, locator: string, type = "unit") =>
  analyzeCitation(index, { source: "register", type, locator, requirementId: "R", evidenceId: "E" });

describe("evidence reachability — dead-leaf detection", () => {
  it("flags a symbol exercised only by its test and a barrel re-export as unreachable", () => {
    const index = baselineRepo({
      "packages/core/src/dead.test.ts":
        `import { deadLeaf } from "./index.js";\nconsole.log(deadLeaf);\n`,
    });
    const result = cite(index, "packages/core/src/dead.test.ts");
    expect(result.verdict).toBe("unreachable");
    expect(result.symbols.map((s) => s.name)).toContain("deadLeaf");
    expect(result.symbols.every((s) => !s.hasNonTestCaller)).toBe(true);
  });

  it("does NOT count a barrel re-export as a caller", () => {
    const index = baselineRepo({
      "packages/core/src/dead.test.ts": `import { deadLeaf } from "./index.js";\ndeadLeaf();\n`,
    });
    // The barrel index.ts re-exports deadLeaf; that must not rescue it.
    expect(cite(index, "packages/core/src/dead.test.ts").verdict).toBe("unreachable");
  });

  it("does NOT count the citing test itself as a caller", () => {
    const index = baselineRepo({
      "packages/core/src/dead.test.ts":
        `import { deadLeaf } from "./index.js";\ndeadLeaf(); deadLeaf(); deadLeaf();\n`,
    });
    expect(cite(index, "packages/core/src/dead.test.ts").verdict).toBe("unreachable");
  });
});

describe("evidence reachability — live tracing", () => {
  it("marks a symbol used by a reachable entry point as live", () => {
    const index = baselineRepo({
      "packages/core/src/live.test.ts": `import { liveThing } from "./index.js";\nliveThing();\n`,
    });
    const result = cite(index, "packages/core/src/live.test.ts");
    expect(result.verdict).toBe("live");
    expect(result.symbols.find((s) => s.name === "liveThing")?.entryTraced).toBe(true);
  });

  it("traces a symbol used only by a package.json script entry", () => {
    const index = makeRepo({
      "package.json": JSON.stringify({ name: "fixture", scripts: { job: "tsx scripts/job.ts" } }),
      "scripts/job.ts": `import { scriptOnly } from "@mendpoint/core";\nscriptOnly();\n`,
      "packages/core/package.json": PKG("@mendpoint/core"),
      "packages/core/src/index.ts": `export { scriptOnly } from "./s.js";\n`,
      "packages/core/src/s.ts": `export function scriptOnly(): number {\n  return 9;\n}\n`,
      "packages/core/src/s.test.ts": `import { scriptOnly } from "./index.js";\nscriptOnly();\n`,
    });
    expect(cite(index, "packages/core/src/s.test.ts").verdict).toBe("live");
  });

  it("treats a symbol defined in a Next.js page (an entry) as live even with no in-code caller", () => {
    const index = makeRepo({
      "package.json": JSON.stringify({ name: "fixture", scripts: {} }),
      "apps/web/package.json": JSON.stringify({ name: "@mendpoint/web" }),
      "apps/web/app/thing/page.tsx": `export default function ThingPage(): null {\n  return null;\n}\n`,
      "apps/web/app/thing/page.test.tsx":
        `import ThingPage from "./page.js";\nconsole.log(ThingPage);\n`,
    });
    expect(cite(index, "apps/web/app/thing/page.test.tsx", "unit").verdict).toBe("live");
  });
});

describe("evidence reachability — the third state is visible", () => {
  it("reports not_determined (not unreachable) when a caller exists but is not entry-traced", () => {
    // deadViaOrphan is called by orphanThing (a real non-test caller), but
    // orphan.ts is imported by nobody, so no entry reaches it. We must NOT claim
    // it unreachable, and we must NOT claim it live — it is the third state.
    const index = baselineRepo({
      "packages/core/src/transitive.test.ts":
        `import { deadViaOrphan } from "./transitive.js";\ndeadViaOrphan();\n`,
    });
    const result = cite(index, "packages/core/src/transitive.test.ts");
    expect(result.verdict).toBe("not_determined");
    expect(result.symbols.find((s) => s.name === "deadViaOrphan")?.hasNonTestCaller).toBe(true);
    expect(result.symbols.find((s) => s.name === "deadViaOrphan")?.entryTraced).toBe(false);
  });

  it("reports not_determined when the test imports first-party code only as types", () => {
    const index = baselineRepo({
      "packages/core/src/t.test.ts": `import type { liveThing } from "./index.js";\n`,
    });
    expect(cite(index, "packages/core/src/t.test.ts").verdict).toBe("not_determined");
  });

  it("reports not_determined for a namespace-only first-party import", () => {
    const index = baselineRepo({
      "packages/core/src/n.test.ts": `import * as core from "./index.js";\ncore.liveThing();\n`,
    });
    const result = cite(index, "packages/core/src/n.test.ts");
    expect(result.verdict).toBe("not_determined");
    expect(result.reason).toContain("namespace");
  });

  it("reports not_determined for document and external evidence types", () => {
    const index = baselineRepo();
    expect(cite(index, "docs/X.md", "document").verdict).toBe("not_determined");
    expect(cite(index, "external:something", "external").verdict).toBe("not_determined");
  });

  it("reports not_determined for an e2e spec that drives the running app", () => {
    const index = baselineRepo({
      "tests/e2e/deployment.spec.ts": `import { test } from "@playwright/test";\n`,
    });
    expect(cite(index, "tests/e2e/deployment.spec.ts", "e2e").verdict).toBe("not_determined");
  });
});

describe("evidence reachability — cited source files (code evidence)", () => {
  it("marks a source file whose exports are all dead as unreachable", () => {
    const index = baselineRepo();
    const result = cite(index, "packages/core/src/dead.ts", "code");
    expect(result.verdict).toBe("unreachable");
  });

  it("marks a source file with a live export as live", () => {
    const index = baselineRepo();
    expect(cite(index, "packages/core/src/live.ts", "code").verdict).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// Real-repository invariants — the ship-decider lives here.
// ---------------------------------------------------------------------------

describe("evidence reachability — real register invariants", () => {
  const repoRoot = resolve(import.meta.dirname, "..");
  const report = runReachabilityReport(repoRoot);

  it("classifies every citation into exactly one of the three states", () => {
    for (const result of report.results) {
      expect(["live", "unreachable", "not_determined"]).toContain(result.verdict);
    }
    const total = report.counts.live + report.counts.unreachable + report.counts.not_determined;
    expect(total).toBe(report.results.length);
  });

  it("SOUNDNESS: every unreachable verdict has zero non-test callers for every subject symbol", () => {
    // This is the property that makes the failing verdict a proof. If it ever
    // breaks, the check is producing false positives and must not block.
    for (const result of report.unreachable) {
      expect(result.symbols.length).toBeGreaterThan(0);
      for (const symbol of result.symbols) {
        expect(symbol.hasNonTestCaller).toBe(false);
        expect(symbol.entryTraced).toBe(false);
      }
    }
  });

  it("SOUNDNESS: every live verdict has at least one entry-traced subject symbol", () => {
    for (const result of report.results) {
      if (result.verdict !== "live") continue;
      expect(result.symbols.some((s) => s.entryTraced)).toBe(true);
    }
  });

  it("anchored fact: the live billing usage ledger citation is traced", () => {
    const usage = report.results.find(
      (r) => r.source === "register" && r.locator === "packages/db/src/usage.test.ts",
    );
    expect(usage?.verdict).toBe("live");
  });

  it("exposes both traceability deliverables without collapsing not-determined into fine", () => {
    // The ten document-only ME-FND requirements are now `documented`, not
    // `verified`, so the verified set is the 29 requirements that carry
    // code-verifiable evidence, and every one of them traces to a live path.
    expect(report.verifiedTotal).toBe(29);
    expect(report.verifiedWithoutLivePath).toEqual([]);
    // ME-SCM-006 and ME-GRF-006 were downgraded to partial and their
    // proven-dead citations removed, so no verified requirement now rests on a
    // proven-unreachable test.
    expect(report.verifiedCitingUnreachable).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The narrowing: --strict blocks on verified requirements only.
// ---------------------------------------------------------------------------

describe("evidence reachability — --strict narrows to verified requirements", () => {
  function writeRepoRoot(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "reach-strict-"));
    tempRoots.push(root);
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    }
    return root;
  }

  // One entry (server) uses liveThing; deadLeaf is exercised only by its test
  // and the barrel re-export — the same proven-dead shape the register hit.
  const baseFiles: Record<string, string> = {
    "package.json": JSON.stringify({ name: "fixture", scripts: {} }),
    "apps/api/package.json": JSON.stringify({ name: "@mendpoint/api" }),
    "apps/api/src/server.ts": `import { liveThing } from "@mendpoint/core";\nliveThing();\n`,
    "packages/core/package.json": JSON.stringify({ name: "@mendpoint/core", main: "./src/index.ts" }),
    "packages/core/src/index.ts":
      `export { liveThing } from "./live.js";\nexport { deadLeaf } from "./dead.js";\n`,
    "packages/core/src/live.ts": `export function liveThing(): number {\n  return 1;\n}\n`,
    "packages/core/src/dead.ts": `export function deadLeaf(): number {\n  return 2;\n}\n`,
    "packages/core/src/dead.test.ts": `import { deadLeaf } from "./index.js";\ndeadLeaf();\n`,
  };

  const manifest = (status: string): string =>
    JSON.stringify({
      requirements: [
        {
          id: "ME-TST-001",
          implementationStatus: status,
          acceptance: [
            {
              id: "ME-TST-001-AC01",
              evidence: [
                {
                  id: "ME-TST-001-AC01-EV01",
                  type: "unit",
                  locator: "packages/core/src/dead.test.ts",
                },
              ],
            },
          ],
        },
      ],
    });

  it("blocks a verified requirement whose only citation is proven unreachable", () => {
    const root = writeRepoRoot({
      ...baseFiles,
      "docs/PRODUCT_REQUIREMENTS.json": manifest("verified"),
    });
    const report = runReachabilityReport(root);
    // The citation is genuinely proven unreachable...
    expect(report.counts.unreachable).toBeGreaterThanOrEqual(1);
    // ...and because it belongs to a verified requirement, the gate must fail.
    const gate = evaluateStrictGate(report);
    expect(gate.failed).toBe(true);
    expect(gate.blockers).toContain("ME-TST-001");
  });

  it("does NOT block a partial requirement citing the identically dead test", () => {
    const root = writeRepoRoot({
      ...baseFiles,
      "docs/PRODUCT_REQUIREMENTS.json": manifest("partial"),
    });
    const report = runReachabilityReport(root);
    // Same proven-unreachable citation shape as the verified case...
    expect(report.counts.unreachable).toBeGreaterThanOrEqual(1);
    // ...but a partial requirement is honest about being incomplete, so the
    // gate stays green. Reverting the narrowing (blocking on counts.unreachable)
    // makes exactly this assertion die.
    expect(evaluateStrictGate(report).failed).toBe(false);
    expect(report.verifiedCitingUnreachable).toEqual([]);
  });
});
