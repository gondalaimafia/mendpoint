import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeTool,
  type ToolContext,
  type ToolSourceContextState,
} from "./tools.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function context(repoRoot: string): ToolContext {
  return { repoRoot, changedFiles: new Set() };
}

function sourceState(): ToolSourceContextState {
  return {
    requireObservation: true,
    budget: {
      maxFileBytes: 100_000,
      maxTotalReadBytes: 4_000,
      maxSearchFiles: 100,
      maxSearchBytes: 100_000,
      maxSearchHits: 20,
      maxPromptEvidenceBytes: 4_000,
      maxChangedFiles: 10,
      maxChangedBytes: 100_000,
    },
    sourceEvidenceFiles: new Map(),
    observedFiles: new Map(),
    observedContents: new Map(),
    readCoverage: new Map(),
    observedDirectories: new Set(),
    searches: new Set(),
    observedBytes: 0,
    searchBytes: 0,
    truncatedObservations: 0,
    groundedMutations: 0,
    blockedMutations: 0,
    changedBytes: 0,
  };
}

describe("Warden investigative tools", () => {
  it("reads a bounded later window from a large source file", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mendpoint-warden-read-window-"));
    dirs.push(repoRoot);
    writeFileSync(
      join(repoRoot, "client.ts"),
      `${"const padding = 0;\n".repeat(900)}export const lateTarget = "found";\n`,
    );

    const result = executeTool(context(repoRoot), {
      tool: "read_file",
      args: { path: "client.ts", offset: 16_000, maxChars: 2_000 },
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      path: "client.ts",
      offset: 16_000,
      truncated: true,
    });
    expect((result.data as { content: string }).content).toContain("lateTarget");
    expect((result.data as { nextOffset: number }).nextOffset).toBeGreaterThan(16_000);
  });

  it("charges only the exposed source window against the cumulative context budget", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mendpoint-warden-window-budget-"));
    dirs.push(repoRoot);
    writeFileSync(join(repoRoot, "large.ts"), `${"x".repeat(20_000)}target\n`);
    const state = sourceState();
    const ctx = { ...context(repoRoot), sourceContext: state };

    const first = executeTool(ctx, {
      tool: "read_file",
      args: { path: "large.ts", offset: 19_500, maxChars: 1_000 },
    });
    const second = executeTool(ctx, {
      tool: "read_file",
      args: { path: "large.ts", offset: 18_500, maxChars: 1_000 },
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(state.observedBytes).toBe(1_507);
    expect(state.sourceEvidenceFiles.has("large.ts")).toBe(false);
    expect(state.observedFiles.has("large.ts")).toBe(false);
  });

  it("requires complete paginated observation before a whole-file mutation", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mendpoint-warden-window-grounding-"));
    dirs.push(repoRoot);
    writeFileSync(join(repoRoot, "client.ts"), "export const value = 'before';\n");
    const state = sourceState();
    const ctx = { ...context(repoRoot), sourceContext: state };

    expect(executeTool(ctx, {
      tool: "read_file",
      args: { path: "client.ts", offset: 0, maxChars: 1 },
    }).ok).toBe(true);
    expect(executeTool(ctx, {
      tool: "replace_in_file",
      args: { path: "client.ts", from: "before", to: "after" },
    })).toMatchObject({ ok: false, error: "source_context_required" });

    expect(executeTool(ctx, {
      tool: "read_file",
      args: { path: "client.ts", offset: 1, maxChars: 100 },
    }).ok).toBe(true);
    expect(executeTool(ctx, {
      tool: "replace_in_file",
      args: { path: "client.ts", from: "before", to: "after" },
    })).toMatchObject({ ok: true });
  });

  it("scopes literal search to one observed repository subtree", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mendpoint-warden-scoped-search-"));
    dirs.push(repoRoot);
    mkdirSync(join(repoRoot, "src", "payments"), { recursive: true });
    mkdirSync(join(repoRoot, "src", "analytics"), { recursive: true });
    writeFileSync(join(repoRoot, "src", "payments", "client.ts"), "export const duplicateSymbol = 1;\n");
    writeFileSync(join(repoRoot, "src", "analytics", "client.ts"), "export const duplicateSymbol = 2;\n");

    const result = executeTool(context(repoRoot), {
      tool: "search",
      args: { query: "duplicateSymbol", scopePath: "src/payments" },
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      scopePath: "src/payments",
      hits: [{ path: "src/payments/client.ts", line: 1, text: "export const duplicateSymbol = 1;" }],
      truncated: false,
      truncationReason: null,
    });
  });

  it("paginates directories larger than one model response without hiding later files", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mendpoint-warden-dir-pagination-"));
    dirs.push(repoRoot);
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    for (let index = 0; index < 2_050; index++) {
      writeFileSync(join(repoRoot, "src", `module-${String(index).padStart(5, "0")}.ts`), "export {};\n");
    }

    const first = executeTool(context(repoRoot), {
      tool: "list_dir",
      args: { path: "src", offset: 0, maxFiles: 200 },
    });
    const tail = executeTool(context(repoRoot), {
      tool: "list_dir",
      args: { path: "src", offset: 2_000, maxFiles: 200 },
    });

    expect(first.data).toMatchObject({
      offset: 0,
      nextOffset: 200,
      totalFiles: null,
      truncated: true,
    });
    expect((first.data as { files: string[] }).files).toHaveLength(200);
    expect(tail.data).toMatchObject({
      offset: 2_000,
      nextOffset: null,
      totalFiles: 2_050,
      truncated: false,
    });
    expect((tail.data as { files: string[] }).files).toHaveLength(50);
    expect((tail.data as { files: string[] }).files).toContain("src/module-02049.ts");
  }, 20_000);

  it("rejects search scopes outside the repository", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mendpoint-warden-search-policy-"));
    dirs.push(repoRoot);
    expect(executeTool(context(repoRoot), {
      tool: "search",
      args: { query: "secret", scopePath: "../" },
    })).toMatchObject({ ok: false, error: "policy" });
  });

  it("returns search hits in a deterministic sorted order across repeated runs", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mendpoint-warden-search-order-"));
    dirs.push(repoRoot);
    // Written in a non-sorted order and across a nested directory so an
    // unsorted readdir would surface them in filesystem order.
    writeFileSync(join(repoRoot, "zeta.ts"), "export const TARGET = 1;\n");
    writeFileSync(join(repoRoot, "alpha.ts"), "export const TARGET = 2;\n");
    mkdirSync(join(repoRoot, "mid"), { recursive: true });
    writeFileSync(join(repoRoot, "mid", "beta.ts"), "export const TARGET = 3;\n");
    writeFileSync(join(repoRoot, "gamma.ts"), "export const TARGET = 4;\n");

    const run = () => {
      const result = executeTool(context(repoRoot), {
        tool: "search",
        args: { query: "TARGET" },
      });
      return (result.data as { hits: Array<{ path: string }> }).hits.map((hit) => hit.path);
    };

    const expected = ["alpha.ts", "gamma.ts", "mid/beta.ts", "zeta.ts"];
    expect(run()).toEqual(expected);
    expect(run()).toEqual(expected);
  });

  it("marks a truncated search result so a partial search cannot read as complete", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mendpoint-warden-search-truncate-"));
    dirs.push(repoRoot);
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(repoRoot, `file-${index}.ts`), "export const TARGET = 1;\n");
    }
    const base = sourceState();
    const state = { ...base, budget: { ...base.budget, maxSearchHits: 2 } };
    const ctx = { ...context(repoRoot), sourceContext: state };

    const result = executeTool(ctx, { tool: "search", args: { query: "TARGET" } });

    expect(result.ok).toBe(true);
    expect((result.data as { truncated: boolean }).truncated).toBe(true);
    expect((result.data as { truncationReason: string }).truncationReason).toMatch(/hit limit/);
    expect(result.summary).toMatch(/truncated/);
    expect(state.truncatedObservations).toBe(1);
  });
});
