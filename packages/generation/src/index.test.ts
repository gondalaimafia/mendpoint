import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ImpactFinding, StructuralDiff } from "@mendpoint/shared";
import { diffOpenApi } from "@mendpoint/change-intel";
import { analyzeRepo } from "@mendpoint/code-impact";
import { generateMigration, unifiedDiff } from "./index.js";

/** Parse `@@ -aStart,aLines +bStart,bLines @@` headers from a unified diff. */
function parseHunkHeaders(patch: string) {
  return patch
    .split("\n")
    .filter((l) => l.startsWith("@@"))
    .map((l) => {
      const m = l.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
      if (!m) throw new Error(`malformed hunk header: ${l}`);
      return {
        aStart: Number(m[1]),
        aLines: Number(m[2]),
        bStart: Number(m[3]),
        bLines: Number(m[4]),
      };
    });
}

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const providerDir = join(root, "fixtures/providers/acme-payments");
const consumerDir = join(root, "fixtures/consumers/shop-app");

describe("generation", () => {
  it("renames amount_cents to amount in patch", () => {
    const v1 = JSON.parse(readFileSync(join(providerDir, "openapi-v1.json"), "utf8"));
    const v2 = JSON.parse(readFileSync(join(providerDir, "openapi-v2.json"), "utf8"));
    const change = diffOpenApi(v1, v2);
    const findings = analyzeRepo(consumerDir, change);
    const draft = generateMigration({
      providerName: "Acme Payments",
      providerSlug: "acme-payments",
      change,
      findings,
      repoRoot: consumerDir,
    });

    expect(draft.patch).toContain("amount");
    expect(draft.fileEdits.some((e) => e.updated.includes("amount") && !e.updated.includes("amount_cents")) ||
      draft.fileEdits.some((e) => e.updated.includes("amount"))).toBe(true);
    const payments = draft.fileEdits.find((e) => e.path.includes("payments.ts"));
    expect(payments?.updated).toContain("amount:");
    expect(payments?.updated).not.toContain("amount_cents");
    expect(draft.body).toContain("never commits to protected branches");
    expect(draft.body).toMatch(/Fettler/);
    expect(draft.body).toMatch(/Mendpoint/);
    expect(draft.risk).toBe("breaking");
  });
});

describe("generation — FET-016 provider path in PR body", () => {
  it("renders a compact provider->code path per finding and never claims 'no path' when absent", () => {
    const v1 = JSON.parse(readFileSync(join(providerDir, "openapi-v1.json"), "utf8"));
    const v2 = JSON.parse(readFileSync(join(providerDir, "openapi-v2.json"), "utf8"));
    const change = diffOpenApi(v1, v2);
    const findings = analyzeRepo(consumerDir, change);
    // The fixture consumer reaches the provider surface, so at least one finding
    // carries a computed path.
    expect(findings.some((f) => f.graphPath)).toBe(true);

    const draft = generateMigration({
      providerName: "Acme Payments",
      providerSlug: "acme-payments",
      change,
      findings,
      repoRoot: consumerDir,
    });

    // Compact, one-line-per-finding path rendered under the Evidence bullet.
    expect(draft.body).toMatch(/\n {2}- path: /);
    // Absence is never dressed up as an assertion that no path exists.
    expect(draft.body).not.toMatch(/no path/i);
  });

  it("renders a one-node no-anchor path as incomplete, not direct provider usage", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mendpoint-no-anchor-"));
    try {
      const change: StructuralDiff = {
        risk: "breaking",
        summary: "detached graph-path evidence",
        entries: [],
      };
      const findings: ImpactFinding[] = [
        {
          filePath: "src/detached.ts",
          symbol: "detached",
          lineStart: 1,
          lineEnd: 1,
          confidence: "low",
          evidence: "detached predecessor map",
          relatedOps: [],
          graphPath: {
            nodes: ["src/detached.ts"],
            hops: 0,
            terminal: "no_anchor",
            truncated: true,
            coverage: "partial",
          },
        },
      ];

      const draft = generateMigration({
        providerName: "Acme Payments",
        providerSlug: "acme-payments",
        change,
        findings,
        repoRoot,
      });

      expect(draft.body).toContain("incomplete: no provider anchor reached");
      expect(draft.body).not.toContain("direct provider usage");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("unifiedDiff", () => {
  it("emits a small hunk with correct line numbers for a one-line change in a large file", () => {
    const original = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join("\n");
    const updated = original.replace("line 1000", "line 1000 renamed");
    const patch = unifiedDiff("big.ts", original, updated);

    // Not a full-file rewrite: the diff must NOT contain every original line.
    const bodyLines = patch.split("\n").filter((l) => /^[ +-]/.test(l) && !l.startsWith("---") && !l.startsWith("+++"));
    expect(bodyLines.length).toBeLessThan(20);
    // Lines far from the single change never appear in the diff body.
    expect(patch).not.toContain("line 500");
    expect(patch).not.toContain("line 1999");

    const headers = parseHunkHeaders(patch);
    expect(headers).toHaveLength(1);
    const h = headers[0]!;
    // Change at line 1000, 3 lines of context => hunk starts at 997.
    expect(h.aStart).toBe(997);
    expect(h.bStart).toBe(997);
    expect(patch).toContain("-line 1000");
    expect(patch).toContain("+line 1000 renamed");
    expect(patch).toContain(" line 997");
    expect(patch).toContain(" line 1003");
  });

  it("produces multiple hunks for widely separated edits", () => {
    const original = Array.from({ length: 500 }, (_, i) => `x${i}`).join("\n");
    let updated = original.replace("x10", "x10_edit");
    updated = updated.replace("x400", "x400_edit");
    const patch = unifiedDiff("multi.ts", original, updated);

    const headers = parseHunkHeaders(patch);
    expect(headers).toHaveLength(2);
    expect(patch).toContain("-x10");
    expect(patch).toContain("+x10_edit");
    expect(patch).toContain("-x400");
    expect(patch).toContain("+x400_edit");
  });

  it("is structurally valid: hunk line counts match emitted body lines", () => {
    const original = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const updated = ["a", "b", "C", "d", "e", "f", "G", "h"].join("\n");
    const patch = unifiedDiff("s.ts", original, updated);
    const lines = patch.split("\n");
    expect(lines[0]).toBe("--- a/s.ts");
    expect(lines[1]).toBe("+++ b/s.ts");

    // Walk each hunk, count context/removed/added lines, compare to header.
    let i = 2;
    let sawHunk = false;
    while (i < lines.length) {
      const header = parseHunkHeaders(lines[i]!)[0]!;
      sawHunk = true;
      i += 1;
      let aCount = 0;
      let bCount = 0;
      while (i < lines.length && !lines[i]!.startsWith("@@")) {
        const ch = lines[i]![0];
        if (ch === " ") {
          aCount += 1;
          bCount += 1;
        } else if (ch === "-") {
          aCount += 1;
        } else if (ch === "+") {
          bCount += 1;
        }
        i += 1;
      }
      expect(aCount).toBe(header.aLines);
      expect(bCount).toBe(header.bLines);
    }
    expect(sawHunk).toBe(true);
  });

  it("produces a patch that `git apply` accepts", () => {
    const original = Array.from({ length: 300 }, (_, i) => `row ${i}`).join("\n") + "\n";
    const updated = original.replace("row 150", "row 150 changed");
    const patch = unifiedDiff("file.txt", original, updated) + "\n";

    const dir = mkdtempSync(join(tmpdir(), "mendpoint-diff-"));
    try {
      writeFileSync(join(dir, "file.txt"), original);
      writeFileSync(join(dir, "change.patch"), patch);
      // --check verifies the patch applies cleanly without modifying files.
      execFileSync("git", ["apply", "--check", "change.patch"], { cwd: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PR body bounds", () => {
  it("caps the edit-site list and states how many files were omitted", { timeout: 30_000 }, () => {
    const change: StructuralDiff = {
      risk: "breaking",
      summary: "field renamed across many consumers",
      entries: [
        {
          op: "request_field_renamed",
          fromField: "amount_cents",
          toField: "amount",
          breaking: true,
        },
      ],
    };
    const fileCount = 1000;
    const findings: ImpactFinding[] = Array.from({ length: fileCount }, (_, i) => ({
      filePath: `src/very/deep/path/to/consumer-file-number-${i}.ts`,
      symbol: `sym${i}`,
      lineStart: 1,
      lineEnd: 1,
      confidence: "high",
      evidence: `amount_cents used at call site ${i}`,
      relatedOps: [],
    }));

    const draft = generateMigration({
      providerName: "Acme Payments",
      providerSlug: "acme-payments",
      change,
      findings,
      // Files do not exist on disk; body still lists finding paths (capped).
      repoRoot: mkdtempSync(join(tmpdir(), "mendpoint-empty-")),
    });

    expect(draft.body.length).toBeLessThan(65_536);
    expect(draft.body).toMatch(/more file\(s\) omitted/);
    expect(draft.body).toContain(String(fileCount - 200));
  });
});
