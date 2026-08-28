import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tracking = vi.hoisted(() => ({
  reads: new Map<string, number>(),
}));

vi.mock("@mendpoint/call-graph", () => {
  const emptyGraph = (repoRoot: string) => ({
    repoRoot,
    builtAt: new Date(0).toISOString(),
    algorithm: "hybrid" as const,
    nodes: {},
    edges: [],
    outEdges: {},
    inEdges: {},
    byName: {},
    hierarchy: { parentsOf: {}, instantiated: [], methodsOfType: {} },
    stats: { nodeCount: 0, edgeCount: 0, directEdges: 0, approxEdges: 0 },
  });
  return {
    buildCallGraph: (repoRoot: string) => emptyGraph(repoRoot),
    buildCallGraphIncremental: (
      _repoRoot: string,
      previous: ReturnType<typeof emptyGraph>,
    ) => previous,
    reverseReachability: () => [],
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], ...args: unknown[]) => {
      if (typeof path === "string") {
        const normalized = resolve(path);
        tracking.reads.set(normalized, (tracking.reads.get(normalized) ?? 0) + 1);
      }
      return (actual.readFileSync as (...values: unknown[]) => unknown)(path, ...args);
    }) as typeof actual.readFileSync,
  };
});

import {
  CodebaseIndexSafetyError,
  buildIndex,
  buildIndexIncremental,
  defaultIndexPath,
  materializeCodebaseIndex,
} from "./index.js";

const roots: string[] = [];

function root(name: string): string {
  const value = mkdtempSync(join(tmpdir(), `mendpoint-codebase-index-${name}-`));
  roots.push(value);
  return value;
}

function expectSafetyError(
  operation: () => unknown,
  code: CodebaseIndexSafetyError["code"],
): CodebaseIndexSafetyError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CodebaseIndexSafetyError);
    expect(error).toMatchObject({ code });
    return error as CodebaseIndexSafetyError;
  }
  throw new Error(`expected_${code}`);
}

afterEach(() => {
  tracking.reads.clear();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("codebase index traversal safety", () => {
  it("fails closed before traversing a symlink outside the repository", () => {
    const repository = root("symlink-repository");
    const outside = root("symlink-outside");
    const outsideFile = join(outside, "outside.ts");
    writeFileSync(outsideFile, "export const escaped = true;\n", "utf8");
    symlinkSync(outside, join(repository, "escape"), "junction");

    const error = expectSafetyError(
      () => buildIndex(repository),
      "codebase_index_symlink_not_allowed",
    );
    expect(error.diagnostic.path).toBe("escape");
    expect(tracking.reads.get(resolve(outsideFile)) ?? 0).toBe(0);
  });

  it("enforces file count, total byte, per file byte, and traversal depth ceilings", () => {
    const countRoot = root("file-count");
    writeFileSync(join(countRoot, "a.ts"), "a", "utf8");
    writeFileSync(join(countRoot, "b.ts"), "b", "utf8");
    expectSafetyError(
      () => buildIndex(countRoot, { limits: { maxFiles: 1 } }),
      "codebase_index_file_count_limit",
    );

    const totalRoot = root("total-bytes");
    writeFileSync(join(totalRoot, "a.ts"), "1234", "utf8");
    writeFileSync(join(totalRoot, "b.ts"), "5678", "utf8");
    expectSafetyError(
      () => buildIndex(totalRoot, { limits: { maxFileBytes: 10, maxTotalBytes: 7 } }),
      "codebase_index_total_bytes_limit",
    );

    const fileRoot = root("file-bytes");
    writeFileSync(join(fileRoot, "large.ts"), "12345", "utf8");
    expectSafetyError(
      () => buildIndex(fileRoot, { limits: { maxFileBytes: 4 } }),
      "codebase_index_file_bytes_limit",
    );

    const depthRoot = root("depth");
    mkdirSync(join(depthRoot, "one", "two"), { recursive: true });
    writeFileSync(join(depthRoot, "one", "two", "deep.ts"), "export {};\n", "utf8");
    expectSafetyError(
      () => buildIndex(depthRoot, { limits: { maxTraversalDepth: 1 } }),
      "codebase_index_traversal_depth_limit",
    );
  });

  it("reuses hash probe content instead of reading unchanged files twice", () => {
    const repository = root("incremental");
    const unchanged = join(repository, "unchanged.ts");
    const changed = join(repository, "changed.ts");
    writeFileSync(unchanged, "export function stable() { return 1; }\n", "utf8");
    writeFileSync(changed, "export function value() { return 1; }\n", "utf8");
    const previous = buildIndex(repository);

    tracking.reads.clear();
    writeFileSync(changed, "export function value() { return 2; }\n", "utf8");
    const next = buildIndexIncremental(repository, previous);

    expect(next).not.toBe(previous);
    expect(next.files.find((file) => file.path === "changed.ts")?.contentHash)
      .not.toBe(previous.files.find((file) => file.path === "changed.ts")?.contentHash);
    expect(tracking.reads.get(resolve(unchanged))).toBe(1);
  });

  it("persists one authority-bound envelope and classifies exact, incremental, and rebuilt reuse", () => {
    const repository = root("persisted-authority");
    const source = join(repository, "source.ts");
    writeFileSync(source, "export function value() { return 1; }\n", "utf8");
    const options = {
      authority: { tenantId: "tenant-a", repositoryId: "repo-a" },
      sdkContext: {
        receivers: ["Example"],
        methodPaths: ["values.get"],
        methods: ["get"],
        fields: ["value"],
        importHints: ["Example"],
      },
    };

    const rebuilt = materializeCodebaseIndex(repository, options);
    const exact = materializeCodebaseIndex(repository, {
      ...options,
      sdkContext: {
        ...options.sdkContext,
        receivers: ["example"],
        importHints: ["example", "EXAMPLE"],
      },
    });
    writeFileSync(source, "export function value() { return 2; }\n", "utf8");
    const incremental = materializeCodebaseIndex(repository, options);

    expect(rebuilt.evidence).toMatchObject({ classification: "rebuilt", rejectedReason: "missing" });
    expect(exact.evidence.classification).toBe("exact");
    expect(exact.evidence.indexContentDigest).toBe(rebuilt.evidence.indexContentDigest);
    expect(incremental.evidence.classification).toBe("incremental");
    expect(incremental.evidence.previousIndexContentDigest).toBe(exact.evidence.indexContentDigest);
    expect(incremental.evidence.indexContentDigest).not.toBe(exact.evidence.indexContentDigest);
    expect(incremental.index.files.some((file) => file.path.startsWith(".mendpoint/"))).toBe(false);
    expect(readdirSync(dirname(defaultIndexPath(repository))).filter((name) => name.endsWith(".tmp")))
      .toEqual([]);
  });

  it("rejects foreign, corrupt, malformed, and symlinked persisted authority before reuse", () => {
    const repository = root("persisted-rejection");
    writeFileSync(join(repository, "source.ts"), "export const value = 1;\n", "utf8");
    const authority = { tenantId: "tenant-a", repositoryId: "repo-a" };
    materializeCodebaseIndex(repository, { authority });
    const path = defaultIndexPath(repository);

    const foreign = materializeCodebaseIndex(repository, {
      authority: { tenantId: "tenant-b", repositoryId: "repo-a" },
    });
    expect(foreign.evidence).toMatchObject({
      classification: "rebuilt",
      rejectedReason: "codebase_index_persisted_authority_mismatch",
    });

    const envelope = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    envelope.indexContentDigest = "0".repeat(64);
    writeFileSync(path, `\uFEFF${JSON.stringify(envelope, null, 2).replace(/\n/g, "\r\n")}`, "utf8");
    const corrupt = materializeCodebaseIndex(repository, {
      authority: { tenantId: "tenant-b", repositoryId: "repo-a" },
    });
    expect(corrupt.evidence.rejectedReason).toBe("codebase_index_persisted_digest_mismatch");

    writeFileSync(path, JSON.stringify({ schemaVersion: 1, index: [] }), "utf8");
    const malformed = materializeCodebaseIndex(repository, {
      authority: { tenantId: "tenant-b", repositoryId: "repo-a" },
    });
    expect(malformed.evidence.rejectedReason).toBe("codebase_index_persisted_shape_invalid");

    rmSync(dirname(path), { recursive: true, force: true });
    const outside = root("persisted-symlink-outside");
    symlinkSync(outside, dirname(path), "junction");
    expectSafetyError(
      () => materializeCodebaseIndex(repository, { authority }),
      "codebase_index_symlink_not_allowed",
    );
  });
});
