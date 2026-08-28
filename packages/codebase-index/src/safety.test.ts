import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
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
  persistedIndexPath,
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

function canonicalDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record).sort().map((key) => [key, canonical(record[key])]),
      );
    }
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
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
    const storageRoot = root("persisted-authority-storage");
    const source = join(repository, "source.ts");
    writeFileSync(source, "export function value() { return 1; }\n", "utf8");
    const options = {
      authority: { tenantId: "tenant-a", repositoryId: "repo-a" },
      storageRoot,
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
    expect(rebuilt.evidence.generation).toBe(1);
    expect(exact.evidence.classification).toBe("exact");
    expect(exact.evidence.generation).toBe(1);
    expect(exact.evidence.indexContentDigest).toBe(rebuilt.evidence.indexContentDigest);
    expect(incremental.evidence.classification).toBe("incremental");
    expect(incremental.evidence.generation).toBe(2);
    expect(incremental.evidence.previousIndexContentDigest).toBe(exact.evidence.indexContentDigest);
    expect(incremental.evidence.indexContentDigest).not.toBe(exact.evidence.indexContentDigest);
    expect(incremental.index.files.some((file) => file.path.startsWith(".mendpoint/"))).toBe(false);
    const path = persistedIndexPath(storageRoot, options.authority, options.sdkContext);
    expect(resolve(path).startsWith(resolve(repository))).toBe(false);
    expect(existsSync(defaultIndexPath(repository))).toBe(false);
    expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp")))
      .toEqual([]);
  });

  it("ignores a fully self-consistent repository-supplied envelope", () => {
    const repository = root("persisted-forgery");
    const firstStorage = root("persisted-forgery-first-storage");
    const nextStorage = root("persisted-forgery-next-storage");
    const authority = { tenantId: "tenant-a", repositoryId: "repo-a" };
    writeFileSync(join(repository, "source.ts"), "export const value = 1;\n", "utf8");
    materializeCodebaseIndex(repository, { authority, storageRoot: firstStorage });
    const authenticPath = persistedIndexPath(firstStorage, authority);
    const forged = JSON.parse(readFileSync(authenticPath, "utf8")) as {
      index: { builtAt: string };
      indexContentDigest: string;
    };
    forged.index.builtAt = "2099-01-01T00:00:00.000Z";
    forged.indexContentDigest = canonicalDigest(forged.index);
    const proofStorage = root("persisted-forgery-proof-storage");
    const proofPath = persistedIndexPath(proofStorage, authority);
    mkdirSync(dirname(proofPath), { recursive: true });
    writeFileSync(proofPath, JSON.stringify(forged, null, 2), "utf8");
    const selfConsistent = materializeCodebaseIndex(repository, {
      authority,
      storageRoot: proofStorage,
    });
    expect(selfConsistent.evidence.classification).toBe("exact");
    expect(selfConsistent.index.builtAt).toBe("2099-01-01T00:00:00.000Z");
    const repositorySuppliedPath = defaultIndexPath(repository);
    mkdirSync(dirname(repositorySuppliedPath), { recursive: true });
    writeFileSync(repositorySuppliedPath, JSON.stringify(forged, null, 2), "utf8");

    const rebuilt = materializeCodebaseIndex(repository, {
      authority,
      storageRoot: nextStorage,
    });

    expect(rebuilt.evidence).toMatchObject({
      classification: "rebuilt",
      rejectedReason: "missing",
      generation: 1,
    });
    expect(rebuilt.index.builtAt).not.toBe("2099-01-01T00:00:00.000Z");
    expect(readFileSync(repositorySuppliedPath, "utf8")).toBe(JSON.stringify(forged, null, 2));
  });

  it("rejects foreign, corrupt, malformed, and symlinked persisted authority before reuse", () => {
    const repository = root("persisted-rejection");
    const storageRoot = root("persisted-rejection-storage");
    writeFileSync(join(repository, "source.ts"), "export const value = 1;\n", "utf8");
    const authority = { tenantId: "tenant-a", repositoryId: "repo-a" };
    materializeCodebaseIndex(repository, { authority, storageRoot });
    const path = persistedIndexPath(storageRoot, authority);

    const foreign = materializeCodebaseIndex(repository, {
      authority: { tenantId: "tenant-b", repositoryId: "repo-a" },
      storageRoot,
    });
    expect(foreign.evidence).toMatchObject({
      classification: "rebuilt",
      rejectedReason: "missing",
    });

    const envelope = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    envelope.indexContentDigest = "0".repeat(64);
    writeFileSync(path, `\uFEFF${JSON.stringify(envelope, null, 2).replace(/\n/g, "\r\n")}`, "utf8");
    const corrupt = materializeCodebaseIndex(repository, {
      authority,
      storageRoot,
    });
    expect(corrupt.evidence.rejectedReason).toBe("codebase_index_persisted_digest_mismatch");

    writeFileSync(path, JSON.stringify({ schemaVersion: 1, index: [] }), "utf8");
    const malformed = materializeCodebaseIndex(repository, {
      authority,
      storageRoot,
    });
    expect(malformed.evidence.rejectedReason).toBe("codebase_index_persisted_shape_invalid");

    const inCheckout = join(repository, ".owned-index");
    expectSafetyError(
      () => materializeCodebaseIndex(repository, { authority, storageRoot: inCheckout }),
      "codebase_index_persisted_path_invalid",
    );
    expect(existsSync(inCheckout)).toBe(false);

    rmSync(dirname(path), { recursive: true, force: true });
    const outside = root("persisted-symlink-outside");
    symlinkSync(outside, dirname(path), "junction");
    expectSafetyError(
      () => materializeCodebaseIndex(repository, { authority, storageRoot }),
      "codebase_index_symlink_not_allowed",
    );
  });

  it("keys owned storage by tenant, repository, and canonical SDK context without thrashing", () => {
    const repository = root("persisted-keying");
    const storageRoot = root("persisted-keying-storage");
    writeFileSync(join(repository, "source.ts"), "export const value = 1;\n", "utf8");
    const tenantA = { tenantId: "tenant-a", repositoryId: "shared-repo" };
    const tenantB = { tenantId: "tenant-b", repositoryId: "shared-repo" };
    const providerA = {
      receivers: ["twilio"],
      methodPaths: ["messages.create"],
      methods: ["create"],
      fields: ["body"],
      importHints: ["twilio"],
    };
    const providerB = {
      receivers: ["stripe"],
      methodPaths: ["customers.retrieve"],
      methods: ["retrieve"],
      fields: ["id"],
      importHints: ["stripe"],
    };

    const first = [
      materializeCodebaseIndex(repository, {
        authority: tenantA,
        storageRoot,
        sdkContext: providerA,
      }),
      materializeCodebaseIndex(repository, {
        authority: tenantB,
        storageRoot,
        sdkContext: providerA,
      }),
      materializeCodebaseIndex(repository, {
        authority: tenantA,
        storageRoot,
        sdkContext: providerB,
      }),
    ];
    const alternating = [
      materializeCodebaseIndex(repository, {
        authority: tenantB,
        storageRoot,
        sdkContext: providerA,
      }),
      materializeCodebaseIndex(repository, {
        authority: tenantA,
        storageRoot,
        sdkContext: providerB,
      }),
      materializeCodebaseIndex(repository, {
        authority: tenantA,
        storageRoot,
        sdkContext: providerA,
      }),
    ];

    expect(first.map((item) => item.evidence.classification))
      .toEqual(["rebuilt", "rebuilt", "rebuilt"]);
    expect(alternating.map((item) => item.evidence.classification))
      .toEqual(["exact", "exact", "exact"]);
    const paths = [
      persistedIndexPath(storageRoot, tenantA, providerA),
      persistedIndexPath(storageRoot, tenantB, providerA),
      persistedIndexPath(storageRoot, tenantA, providerB),
    ];
    expect(new Set(paths).size).toBe(3);
    expect(paths.every((path) => existsSync(path))).toBe(true);
  });

  it("serializes one authority and retries a fenced publication after an interleaved writer", () => {
    const repository = root("persisted-fence");
    const storageRoot = root("persisted-fence-storage");
    const source = join(repository, "source.ts");
    const authority = { tenantId: "tenant-a", repositoryId: "repo-a" };
    const options = { authority, storageRoot };
    writeFileSync(source, "export const value = 1;\n", "utf8");
    const initial = materializeCodebaseIndex(repository, options);
    const path = persistedIndexPath(storageRoot, authority);

    writeFileSync(source, "export const value = 2;\n", "utf8");
    expectSafetyError(
      () => materializeCodebaseIndex(repository, {
        ...options,
        persistenceHooks: {
          beforePublish: () => {
            materializeCodebaseIndex(repository, options);
          },
        },
      }),
      "codebase_index_persisted_lock_conflict",
    );
    expect(JSON.parse(readFileSync(path, "utf8")).generation).toBe(1);
    expect(materializeCodebaseIndex(repository, options).evidence.generation).toBe(2);

    writeFileSync(source, "export const value = 3;\n", "utf8");
    let interleaved = false;
    const committed = materializeCodebaseIndex(repository, {
      ...options,
      persistenceHooks: {
        beforePublish: ({ path, nextGeneration }) => {
          if (interleaved) return;
          interleaved = true;
          const competing = JSON.parse(readFileSync(path, "utf8")) as { generation: number };
          competing.generation = nextGeneration;
          writeFileSync(path, JSON.stringify(competing, null, 2), "utf8");
        },
      },
    });
    expect(initial.evidence.generation).toBe(1);
    expect(committed.evidence).toMatchObject({
      classification: "incremental",
      generation: 4,
    });
    expect(JSON.parse(readFileSync(path, "utf8")).generation).toBe(4);
  });

  it("recovers deterministically from crashes immediately before and after publish", () => {
    const repository = root("persisted-crash");
    const storageRoot = root("persisted-crash-storage");
    const source = join(repository, "source.ts");
    const authority = { tenantId: "tenant-a", repositoryId: "repo-a" };
    const options = { authority, storageRoot };
    writeFileSync(source, "export const value = 1;\n", "utf8");
    materializeCodebaseIndex(repository, options);
    const path = persistedIndexPath(storageRoot, authority);

    writeFileSync(source, "export const value = 2;\n", "utf8");
    expect(() => materializeCodebaseIndex(repository, {
      ...options,
      persistenceHooks: { beforePublish: () => { throw new Error("crash_before_publish"); } },
    })).toThrow("crash_before_publish");
    expect(JSON.parse(readFileSync(path, "utf8")).generation).toBe(1);
    expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(materializeCodebaseIndex(repository, options).evidence.generation).toBe(2);

    writeFileSync(source, "export const value = 3;\n", "utf8");
    expect(() => materializeCodebaseIndex(repository, {
      ...options,
      persistenceHooks: { afterPublish: () => { throw new Error("crash_after_publish"); } },
    })).toThrow("crash_after_publish");
    expect(JSON.parse(readFileSync(path, "utf8")).generation).toBe(3);
    expect(materializeCodebaseIndex(repository, options).evidence).toMatchObject({
      classification: "exact",
      generation: 3,
    });
  });
});
