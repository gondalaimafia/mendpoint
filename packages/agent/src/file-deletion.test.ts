import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeTool,
  rollbackToolWrites,
  type ToolContext,
  type ToolSourceContextState,
} from "./tools.js";

const roots: string[] = [];

function sourceContext(): ToolSourceContextState {
  return {
    requireObservation: true,
    budget: {
      maxFileBytes: 1024 * 1024,
      maxTotalReadBytes: 1024 * 1024,
      maxSearchFiles: 100,
      maxSearchBytes: 1024 * 1024,
      maxSearchHits: 20,
      maxPromptEvidenceBytes: 16 * 1024,
      maxChangedFiles: 10,
      maxChangedBytes: 1024 * 1024,
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

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Fettler exact file deletion", () => {
  it("requires a complete source observation and restores exact bytes and mode", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-delete-file-"));
    roots.push(root);
    const target = join(root, "src", "obsolete.ts");
    mkdirSync(join(root, "src"));
    writeFileSync(target, "export const obsolete = true;\n");
    if (process.platform !== "win32") chmodSync(target, 0o751);
    const ctx: ToolContext = {
      repoRoot: root,
      changedFiles: new Set(),
      sourceContext: sourceContext(),
    };

    expect(executeTool(ctx, {
      tool: "delete_file",
      args: { path: "src/obsolete.ts" },
    })).toMatchObject({ ok: false, error: "source_context_required" });

    expect(executeTool(ctx, {
      tool: "read_file",
      args: { path: "src/obsolete.ts", maxChars: 10_000 },
    })).toMatchObject({ ok: true });

    expect(executeTool(ctx, {
      tool: "delete_file",
      args: { path: "src/obsolete.ts" },
    })).toMatchObject({ ok: true, data: { path: "src/obsolete.ts", deleted: true } });
    expect(existsSync(target)).toBe(false);
    expect(ctx.changedFiles).toEqual(new Set(["src/obsolete.ts"]));

    expect(rollbackToolWrites(ctx)).toEqual({
      performed: true,
      restoredFiles: ["src/obsolete.ts"],
      failedFiles: [],
    });
    expect(readFileSync(target, "utf8")).toBe("export const obsolete = true;\n");
    if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o751);
  });

  it("rejects protected paths and missing or non-file targets", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-delete-file-policy-"));
    roots.push(root);
    writeFileSync(join(root, ".env"), "SECRET=unchanged\n");
    const ctx: ToolContext = { repoRoot: root, changedFiles: new Set() };

    expect(executeTool(ctx, {
      tool: "delete_file",
      args: { path: ".env" },
    })).toMatchObject({ ok: false, error: "policy" });
    expect(executeTool(ctx, {
      tool: "delete_file",
      args: { path: "missing.ts" },
    })).toMatchObject({ ok: false, error: "ENOENT" });
    expect(executeTool(ctx, {
      tool: "delete_file",
      args: { path: "." },
    })).toMatchObject({ ok: false });
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("SECRET=unchanged\n");
  });

  it("rejects deletion when the observed source digest becomes stale", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-delete-file-stale-"));
    roots.push(root);
    const target = join(root, "obsolete.ts");
    writeFileSync(target, "export const version = 1;\n");
    const ctx: ToolContext = { repoRoot: root, changedFiles: new Set(), sourceContext: sourceContext() };
    expect(executeTool(ctx, { tool: "read_file", args: { path: "obsolete.ts" } }))
      .toMatchObject({ ok: true });
    writeFileSync(target, "export const version = 2;\n");
    expect(executeTool(ctx, { tool: "delete_file", args: { path: "obsolete.ts" } }))
      .toMatchObject({ ok: false, error: "source_context_stale" });
    expect(readFileSync(target, "utf8")).toBe("export const version = 2;\n");
  });
});
