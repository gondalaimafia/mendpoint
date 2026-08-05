import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function setup(): { root: string; context: ToolContext; source: ToolSourceContextState } {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-source-grounding-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "client.ts"), "export const path = '/v1/old';\n");
  const source: ToolSourceContextState = {
    requireObservation: true,
    budget: {
      maxFileBytes: 4_096,
      maxTotalReadBytes: 16_384,
      maxSearchFiles: 20,
      maxSearchBytes: 32_768,
      maxSearchHits: 10,
      maxPromptEvidenceBytes: 8_192,
      maxChangedFiles: 2,
      maxChangedBytes: 8_192,
    },
    sourceEvidenceFiles: new Map(),
    observedFiles: new Map(),
    observedDirectories: new Set(),
    searches: new Set(),
    observedBytes: 0,
    searchBytes: 0,
    truncatedObservations: 0,
    groundedMutations: 0,
    blockedMutations: 0,
    changedBytes: 0,
  };
  return {
    root,
    source,
    context: { repoRoot: root, changedFiles: new Set(), sourceContext: source },
  };
}

describe("Warden source grounded mutation fences", () => {
  it("rejects an existing file mutation without a prior read", () => {
    const { root, context, source } = setup();
    const result = executeTool(context, {
      tool: "replace_in_file",
      args: { path: "src/client.ts", from: "/v1/old", to: "/v2/new" },
    });

    expect(result).toMatchObject({ ok: false, error: "source_context_required" });
    expect(readFileSync(join(root, "src", "client.ts"), "utf8")).toContain("/v1/old");
    expect(source.blockedMutations).toBe(1);
  });

  it("rejects a file whose contents changed after observation", () => {
    const { root, context, source } = setup();
    expect(executeTool(context, {
      tool: "read_file",
      args: { path: "src/client.ts" },
    }).ok).toBe(true);
    writeFileSync(join(root, "src", "client.ts"), "export const path = '/external/change';\n");

    const result = executeTool(context, {
      tool: "replace_in_file",
      args: { path: "src/client.ts", from: "/v1/old", to: "/v2/new" },
    });

    expect(result).toMatchObject({ ok: false, error: "source_context_stale" });
    expect(source.blockedMutations).toBe(1);
  });

  it("records an exact grounded mutation after a matching read", () => {
    const { root, context, source } = setup();
    const initial = readFileSync(join(root, "src", "client.ts"), "utf8");
    expect(executeTool(context, {
      tool: "read_file",
      args: { path: "src/client.ts" },
    }).ok).toBe(true);

    const result = executeTool(context, {
      tool: "replace_in_file",
      args: { path: "src/client.ts", from: "/v1/old", to: "/v2/new" },
    });
    const updated = readFileSync(join(root, "src", "client.ts"), "utf8");

    expect(result.ok).toBe(true);
    expect(updated).toContain("/v2/new");
    expect(source.groundedMutations).toBe(1);
    expect(source.observedFiles.get("src/client.ts")?.digest).toBe(digest(updated));
    expect(source.sourceEvidenceFiles.get("src/client.ts")?.digest).toBe(digest(initial));
  });

  it("requires the exact parent directory to be observed before creating a file", () => {
    const { root, context, source } = setup();
    const blocked = executeTool(context, {
      tool: "write_file",
      args: { path: "src/idempotency.ts", content: "export const key = 'stable';\n" },
    });
    expect(blocked).toMatchObject({ ok: false, error: "source_context_required" });

    expect(executeTool(context, { tool: "list_dir", args: { path: "src" } }).ok).toBe(true);
    const created = executeTool(context, {
      tool: "write_file",
      args: { path: "src/idempotency.ts", content: "export const key = 'stable';\n" },
    });

    expect(created.ok).toBe(true);
    expect(source.observedDirectories).toContain("src");
    expect(readFileSync(join(root, "src", "idempotency.ts"), "utf8")).toContain("stable");
  });
});
