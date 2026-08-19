import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  GRAPHIFY_EVALUATION_PIN, GraphifyStructuralExtractor, diffStructuralExtractions, extractWithFallback,
  attributeStructuralFailure, classifyStructuralBlindSpot, normalizeGraphifyExtraction,
  structuralContentDigest, structuralExtractionToCallGraph, structuralFailure, structuralSnapshotManifestDigest,
  type GraphifyProcessPort, type StructuralExtractionRequest, type StructuralExtractionV1,
} from "./index.js";

const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);
const observedAt = "2026-08-18T12:00:00.000Z";
const temporaryRoots: string[] = [];
afterAll(() => temporaryRoots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const file = (path: string, contentDigest: string, byteLength = 100) => ({ path, contentDigest, byteLength, mode: "100644", kind: "file" as const });
const files = [
  file("src/client.ts", `sha256:${"a".repeat(64)}`),
  file("src/wrapper.ts", `sha256:${"b".repeat(64)}`),
  file("test/client.test.ts", `sha256:${"c".repeat(64)}`),
];
function request(overrides: Partial<StructuralExtractionRequest> = {}): StructuralExtractionRequest {
  return {
    tenantId: "tenant-a", repositoryId: "repo-a", snapshotId: "snapshot-a", revision: revisionA,
    manifestDigest: structuralSnapshotManifestDigest(files), verifiedSnapshotRoot: "C:/safe/immutable-snapshot",
    observedAt, files,
    limits: { maxFiles: 100, maxInputBytes: 1_000_000, maxNodes: 1_000, maxEdges: 4_000, maxOutputBytes: 2_000_000, maxMemoryBytes: 256_000_000, timeoutMs: 2_000 },
    ...overrides,
  };
}
function raw() {
  return {
    nodes: [
      { id: "client", label: "client.ts", file_type: "code", source_file: "src/client.ts", source_location: "L1", confidence: "EXTRACTED" },
      { id: "create_payment", label: "createPayment", file_type: "function", source_file: "src/client.ts", source_location: "L3-L5", confidence: "EXTRACTED" },
      { id: "wrapper", label: "pay", file_type: "method", source_file: "src/wrapper.ts", source_location: "L7", confidence: "INFERRED" },
      { id: "test_pay", label: "test pay", file_type: "test", source_file: "test/client.test.ts", source_location: "L4", confidence: "EXTRACTED" },
    ],
    edges: [
      { source: "wrapper", target: "create_payment", relation: "calls", confidence: "INFERRED", source_file: "src/wrapper.ts", source_location: "L8", weight: 0.8 },
      { source: "test_pay", target: "wrapper", relation: "references", confidence: "AMBIGUOUS", source_file: "test/client.test.ts", source_location: "L5", weight: 0.5 },
      { source: "client", target: "create_payment", relation: "contains", confidence: "EXTRACTED", source_file: "src/client.ts", source_location: "L3", weight: 1 },
    ], warnings: ["one parse recovery"], failed_sources: [], unsupported_languages: [],
  };
}
const observedFiles = () => files.map((entry) => ({ ...entry }));
const metadata = (elapsedMs = 12) => ({ version: "0.9.46", digest: GRAPHIFY_EVALUATION_PIN.implementationDigest, elapsedMs, peakMemoryBytes: 2_048, observedFiles: observedFiles() });
function realRequest(): StructuralExtractionRequest {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-structural-snapshot-"));
  temporaryRoots.push(root);
  const boundFiles = files.map((entry) => {
    const content = Buffer.from(`content:${entry.path}`, "utf8");
    const absolute = join(root, ...entry.path.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
    return {
      ...entry,
      contentDigest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      byteLength: content.byteLength,
    };
  });
  return request({
    verifiedSnapshotRoot: root,
    files: boundFiles,
    manifestDigest: structuralSnapshotManifestDigest(boundFiles),
  });
}

describe("Mendpoint structural extraction contract", () => {
  it("rejects malformed manifest entries before hashing them", () => {
    expect(() => structuralSnapshotManifestDigest([{ ...files[0], contentDigest: "sha256:bad" }])).toThrow("GRAPHIFY_IDENTITY_INSTABILITY");
  });

  it("normalizes nodes and relations without exposing upstream identity", () => {
    const result = normalizeGraphifyExtraction(request(), raw(), metadata());
    expect(result.schemaVersion).toBe("mendpoint.structural-extraction.v1");
    expect(result.nodes.map((node) => node.kind)).toEqual(["file", "function", "method", "test"]);
    expect(result.nodes[1].id).not.toContain("create_payment");
    expect(result.nodes[1].provenance.upstreamNodeId).toBe("create_payment");
    expect(result.edges.map((edge) => edge.kind)).toEqual(["calls", "contains", "references"]);
    expect(result.edges.find((edge) => edge.kind === "calls")).toMatchObject({ epistemicState: "inferred", provenance: { upstreamRelation: "calls", upstreamConfidence: "INFERRED" } });
    expect(result.edges.find((edge) => edge.kind === "references")?.epistemicState).toBe("ambiguous");
    expect(Object.isFrozen(result)).toBe(true);
  });
  it("binds the exact immutable snapshot manifest and rejects observed-byte drift", () => {
    const changed = observedFiles(); changed[1] = { ...changed[1], contentDigest: `sha256:${"d".repeat(64)}` };
    expect(() => normalizeGraphifyExtraction(request(), raw(), { ...metadata(), observedFiles: changed })).toThrow("GRAPHIFY_IDENTITY_INSTABILITY");
    expect(() => normalizeGraphifyExtraction({ ...request(), manifestDigest: `sha256:${"e".repeat(64)}` }, raw(), metadata())).toThrow("GRAPHIFY_IDENTITY_INSTABILITY");
  });
  it("keeps semantic identity deterministic despite ordering, runtime, and observation-time changes", () => {
    const first = normalizeGraphifyExtraction(request(), raw(), metadata(1));
    const permuted = normalizeGraphifyExtraction(request({ observedAt: "2026-08-18T12:01:00.000Z" }), { ...raw(), nodes: [...raw().nodes].reverse(), edges: [...raw().edges].reverse() }, metadata(999));
    const next = normalizeGraphifyExtraction(request({ snapshotId: "snapshot-b", revision: revisionB }), raw(), metadata(1));
    expect(first.contentDigest).toBe(permuted.contentDigest);
    expect(first.nodes.map((node) => node.id)).toEqual(permuted.nodes.map((node) => node.id));
    expect(first.nodes.map((node) => node.id)).not.toEqual(next.nodes.map((node) => node.id));
    expect(first.nodes.map((node) => node.canonicalKey)).toEqual(next.nodes.map((node) => node.canonicalKey));
  });
  it("preserves alias imports and treats renamed symbols as new canonical keys", () => {
    const alias = raw(); alias.edges.push({ source: "wrapper", target: "client", relation: "imports", confidence: "EXTRACTED", source_file: "src/wrapper.ts", source_location: "L1", weight: 1 });
    const first = normalizeGraphifyExtraction(request(), alias, metadata());
    const renamed = raw(); renamed.nodes[2] = { ...renamed.nodes[2], label: "submitPayment" };
    const second = normalizeGraphifyExtraction(request({ snapshotId: "snapshot-b", revision: revisionB }), renamed, metadata());
    expect(first.edges.some((edge) => edge.kind === "imports")).toBe(true);
    expect(first.nodes.find((node) => node.provenance.upstreamNodeId === "wrapper")?.canonicalKey).not.toBe(second.nodes.find((node) => node.provenance.upstreamNodeId === "wrapper")?.canonicalKey);
  });
  it.each([
    ["malformed output", { nodes: "wrong", edges: [] }, "GRAPHIFY_EXTRACTION_FAILURE"],
    ["dangling edge", { ...raw(), edges: [{ source: "missing", target: "wrapper", relation: "calls", confidence: "EXTRACTED" }] }, "GRAPHIFY_EDGE_MISS"],
    ["unknown confidence", { ...raw(), edges: [{ source: "wrapper", target: "create_payment", relation: "calls", confidence: "CERTAIN" }] }, "GRAPHIFY_AMBIGUITY"],
    ["partial extraction", { ...raw(), failed_sources: ["src/client.ts"] }, "GRAPHIFY_EXTRACTION_FAILURE"],
    ["unsupported language", { ...raw(), unsupported_languages: [{ language: "r", files: ["analysis.R"] }] }, "GRAPHIFY_LANGUAGE_GAP"],
  ])("fails closed for %s", (_name, value, code) => expect(() => normalizeGraphifyExtraction(request(), value, metadata())).toThrow(code));

  it("rejects missing confidence and missing coverage evidence instead of upgrading them", () => {
    const missingNodeConfidence = raw();
    delete (missingNodeConfidence.nodes[0] as { confidence?: string }).confidence;
    expect(() => normalizeGraphifyExtraction(request(), missingNodeConfidence, metadata())).toThrow("GRAPHIFY_AMBIGUITY");

    const missingEdgeConfidence = raw();
    delete (missingEdgeConfidence.edges[0] as { confidence?: string }).confidence;
    expect(() => normalizeGraphifyExtraction(request(), missingEdgeConfidence, metadata())).toThrow("GRAPHIFY_AMBIGUITY");

    const missingCoverage = structuredClone(raw()) as unknown as Record<string, unknown>;
    delete missingCoverage.unsupported_languages;
    expect(() => normalizeGraphifyExtraction(request(), missingCoverage, metadata())).toThrow("GRAPHIFY_EXTRACTION_FAILURE");
  });

  it("preserves classified, manifest-bound warning provenance", () => {
    const input = structuredClone(raw()) as unknown as Record<string, unknown>;
    input.warnings = [{ detail: "one parse recovery", source_file: "src/client.ts" }];
    const result = normalizeGraphifyExtraction(request(), input, metadata());
    expect(result.warnings).toEqual([{
      code: "GRAPHIFY_EXTRACTION_FAILURE",
      detail: "one parse recovery",
      sourceFile: "src/client.ts",
    }]);
  });

  it("does not fabricate complete call-graph diagnostics and never projects indirect calls as direct", () => {
    const input = raw();
    input.edges[0] = { ...input.edges[0], relation: "indirect_call", confidence: "EXTRACTED" };
    const graph = structuralExtractionToCallGraph(normalizeGraphifyExtraction(request(), input, metadata()));
    expect(graph.diagnostics).toBeUndefined();
    expect(graph.edges[0]).toMatchObject({ resolution: "import_context", confidence: "medium", virtual: true });
  });

  it("never upgrades an ambiguous indirect call above low confidence", () => {
    const input = raw();
    input.edges[0] = { ...input.edges[0], relation: "indirect_call", confidence: "AMBIGUOUS", weight: 0.2 };
    const graph = structuralExtractionToCallGraph(normalizeGraphifyExtraction(request(), input, metadata()));
    expect(graph.edges[0]).toMatchObject({ resolution: "import_context", confidence: "low", virtual: true });
  });

  it("rejects a recomputed digest when public evidence violates normalized provenance invariants", () => {
    const accepted = normalizeGraphifyExtraction(request(), raw(), metadata());
    const forged = structuredClone(accepted);
    forged.edges[0].epistemicState = "observed";
    forged.edges[0].provenance.upstreamConfidence = "AMBIGUOUS";
    forged.contentDigest = structuralContentDigest(forged);
    expect(() => structuralExtractionToCallGraph(forged)).toThrow("GRAPHIFY_IDENTITY_INSTABILITY");

    const forgedTestRole = structuredClone(accepted);
    forgedTestRole.nodes[0].isTest = true;
    forgedTestRole.contentDigest = structuralContentDigest(forgedTestRole);
    expect(() => structuralExtractionToCallGraph(forgedTestRole)).toThrow("GRAPHIFY_IDENTITY_INSTABILITY");
  });
});

describe("killable Graphify adapter and fallback", () => {
  it("requires a separately pinned implementation digest instead of accepting a port assertion", () => {
    const port: GraphifyProcessPort = {
      version: "0.9.46",
      digest: `sha256:${"2".repeat(64)}`,
      start: () => ({ terminate: async () => undefined, result: new Promise(() => undefined) }),
    };
    expect(() => new GraphifyStructuralExtractor(port)).toThrow("GRAPHIFY_IDENTITY_INSTABILITY");

    const matchingForgery: GraphifyProcessPort = {
      version: "0.9.46",
      digest: `sha256:${"f".repeat(64)}`,
      start: () => ({ terminate: async () => undefined, result: new Promise(() => undefined) }),
    };
    expect(() => new GraphifyStructuralExtractor(matchingForgery)).toThrow("GRAPHIFY_IDENTITY_INSTABILITY");
  });

  it("snapshots process identity and fallback callables before external work", async () => {
    let versionReads = 0;
    let digestReads = 0;
    const port = {
      get version() { versionReads += 1; return "0.9.46"; },
      get digest() { digestReads += 1; return GRAPHIFY_EVALUATION_PIN.implementationDigest; },
      start: vi.fn(() => ({
        result: Promise.resolve({ exitConfirmed: true as const, output: raw(), observedFiles: observedFiles(), peakMemoryBytes: 1 }),
        terminate: vi.fn(async () => undefined),
      })),
    };
    const exactRequest = realRequest();
    const originalStart = port.start;
    port.start = vi.fn(() => ({
      result: Promise.resolve({ exitConfirmed: true as const, output: raw(), observedFiles: exactRequest.files, peakMemoryBytes: 1 }),
      terminate: vi.fn(async () => undefined),
    }));
    const extractor = new GraphifyStructuralExtractor(port);
    await extractor.extract(exactRequest);
    port.start = originalStart;
    expect(versionReads).toBe(1);
    expect(digestReads).toBe(1);

    const descriptor = { id: "test", version: "1", implementationDigest: `sha256:${"2".repeat(64)}` as const };
    const original = { descriptor, extract: vi.fn(async () => "baseline") };
    const fallback = {
      enabled: true as const,
      request: request(),
      current: original,
      persistFallbackOutcome: vi.fn(async () => undefined),
      graphify: { descriptor, extract: vi.fn(async (received: StructuralExtractionRequest) => {
        try { received.tenantId = "tenant-b"; } catch { /* immutable execution plan */ }
        fallback.current = { descriptor, extract: vi.fn(async () => "mutated") };
        throw structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", "expected");
      }) },
    };
    await expect(extractWithFallback(fallback)).resolves.toBe("baseline");
    expect(original.extract).toHaveBeenCalledOnce();
    expect(original.extract).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-a" }));
  });

  it("passes only a manifest-bound plan to an isolated process port", async () => {
    const terminate = vi.fn(async () => undefined);
    const exactRequest = realRequest();
    const port: GraphifyProcessPort = { version: "0.9.46", digest: GRAPHIFY_EVALUATION_PIN.implementationDigest, start: vi.fn(() => ({ terminate, result: Promise.resolve({ exitConfirmed: true as const, output: raw(), observedFiles: exactRequest.files, peakMemoryBytes: 2_048 }) })) };
    const result = await new GraphifyStructuralExtractor(port).extract(exactRequest);
    expect(port.start).toHaveBeenCalledWith(expect.objectContaining({
      snapshotId: "snapshot-a",
      manifestDigest: exactRequest.manifestDigest,
      sources: expect.arrayContaining([expect.objectContaining({ path: "src/client.ts", bytes: expect.any(Uint8Array) })]),
    }));
    expect(result.extractor.id).toBe("graphify"); expect(terminate).not.toHaveBeenCalled();
  });

  it("materializes exact manifest bytes once and never gives the process a mutable repository root", async () => {
    const exactRequest = realRequest();
    const absolute = join(exactRequest.verifiedSnapshotRoot, "src", "client.ts");
    const authorized = readFileSync(absolute);
    const port: GraphifyProcessPort = {
      version: "0.9.46",
      digest: GRAPHIFY_EVALUATION_PIN.implementationDigest,
      start: vi.fn((received) => {
        expect(received).not.toHaveProperty("verifiedSnapshotRoot");
        expect(Buffer.from(received.sources[0].bytes)).toEqual(authorized);
        writeFileSync(absolute, "TRANSIENT SECRET", "utf8");
        writeFileSync(absolute, authorized);
        return {
          terminate: async () => undefined,
          result: Promise.resolve({ exitConfirmed: true as const, output: raw(), observedFiles: exactRequest.files, peakMemoryBytes: 2_048 }),
        };
      }),
    };
    await expect(new GraphifyStructuralExtractor(port).extract(exactRequest)).resolves.toMatchObject({ snapshotId: "snapshot-a" });
  });

  it("independently verifies the snapshot bytes instead of trusting echoed observed-file claims", async () => {
    const exactRequest = realRequest();
    const absolute = join(exactRequest.verifiedSnapshotRoot, "src", "client.ts");
    writeFileSync(absolute, "mutated after manifest admission", "utf8");
    const port: GraphifyProcessPort = {
      version: "0.9.46",
      digest: GRAPHIFY_EVALUATION_PIN.implementationDigest,
      start: vi.fn(() => ({
        terminate: vi.fn(async () => undefined),
        result: Promise.resolve({ exitConfirmed: true as const, output: raw(), observedFiles: exactRequest.files, peakMemoryBytes: 2_048 }),
      })),
    };
    await expect(new GraphifyStructuralExtractor(port).extract(exactRequest)).rejects.toThrow("GRAPHIFY_SECURITY_FAILURE");
    expect(port.start).not.toHaveBeenCalled();
  });

  it("rejects an oversized on-disk file before invoking the process port", async () => {
    const exactRequest = realRequest();
    writeFileSync(join(exactRequest.verifiedSnapshotRoot, "src", "client.ts"), Buffer.alloc(2_000_000, 65));
    const port: GraphifyProcessPort = {
      version: "0.9.46",
      digest: GRAPHIFY_EVALUATION_PIN.implementationDigest,
      start: vi.fn(() => ({
        terminate: async () => undefined,
        result: Promise.resolve({ exitConfirmed: true as const, output: raw(), observedFiles: exactRequest.files, peakMemoryBytes: 2_048 }),
      })),
    };
    await expect(new GraphifyStructuralExtractor(port).extract(exactRequest)).rejects.toThrow("GRAPHIFY_SECURITY_FAILURE");
    expect(port.start).not.toHaveBeenCalled();
  });
  it("does not report a clean timeout until isolated-process termination is acknowledged", async () => {
    let acknowledgeTermination!: () => void;
    let signalTerminate!: () => void;
    const terminateCalled = new Promise<void>((resolve) => { signalTerminate = resolve; });
    const terminate = vi.fn(() => {
      signalTerminate();
      return new Promise<void>((resolve) => { acknowledgeTermination = resolve; });
    });
    const exactRequest = realRequest();
    const port: GraphifyProcessPort = { version: "0.9.46", digest: GRAPHIFY_EVALUATION_PIN.implementationDigest, start: () => ({ terminate, result: new Promise(() => undefined) }) };
    const extraction = new GraphifyStructuralExtractor(port).extract({ ...exactRequest, limits: { ...exactRequest.limits, timeoutMs: 5 } });
    let settled = false;
    void extraction.finally(() => { settled = true; }).catch(() => undefined);
    await terminateCalled;
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    acknowledgeTermination();
    await expect(extraction).rejects.toThrow("GRAPHIFY_PERFORMANCE_FAILURE");
  });

  it("bounds missing termination acknowledgement and fails it as a security error", async () => {
    const exactRequest = realRequest();
    const port: GraphifyProcessPort = {
      version: "0.9.46",
      digest: GRAPHIFY_EVALUATION_PIN.implementationDigest,
      start: () => ({ terminate: () => new Promise(() => undefined), result: new Promise(() => undefined) }),
    };
    const extraction = new GraphifyStructuralExtractor(port).extract({
      ...exactRequest,
      limits: { ...exactRequest.limits, timeoutMs: 5, terminationTimeoutMs: 5 },
    } as StructuralExtractionRequest);
    const outcome = await Promise.race([
      extraction.then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error)),
      new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 50)),
    ]);
    expect(outcome).toContain("GRAPHIFY_SECURITY_FAILURE");
  });

  it("keeps the termination grace bound when a late result wins the outer race", async () => {
    let resolveResult!: (value: { exitConfirmed: true; output: unknown; observedFiles: StructuralExtractionRequest["files"]; peakMemoryBytes: number }) => void;
    let signalTerminate!: () => void;
    const terminateCalled = new Promise<void>((resolve) => { signalTerminate = resolve; });
    const result = new Promise<{ exitConfirmed: true; output: unknown; observedFiles: StructuralExtractionRequest["files"]; peakMemoryBytes: number }>((resolve) => { resolveResult = resolve; });
    const exactRequest = realRequest();
    const port: GraphifyProcessPort = {
      version: "0.9.46",
      digest: GRAPHIFY_EVALUATION_PIN.implementationDigest,
      start: () => ({
        result,
        terminate: () => {
          signalTerminate();
          return new Promise(() => undefined);
        },
      }),
    };
    const extraction = new GraphifyStructuralExtractor(port).extract({
      ...exactRequest,
      limits: { ...exactRequest.limits, timeoutMs: 5, terminationTimeoutMs: 5 },
    });
    await terminateCalled;
    resolveResult({ exitConfirmed: true, output: raw(), observedFiles: exactRequest.files, peakMemoryBytes: 1 });
    await expect(extraction).rejects.toThrow("GRAPHIFY_SECURITY_FAILURE");
  });

  it("contains synchronous supervisor termination errors inside the extraction promise", async () => {
    const exactRequest = realRequest();
    const port: GraphifyProcessPort = {
      version: "0.9.46",
      digest: GRAPHIFY_EVALUATION_PIN.implementationDigest,
      start: () => ({
        terminate: () => { throw new Error("supervisor unavailable"); },
        result: new Promise(() => undefined),
      }),
    };
    await expect(new GraphifyStructuralExtractor(port).extract({
      ...exactRequest,
      limits: { ...exactRequest.limits, timeoutMs: 5, terminationTimeoutMs: 5 },
    })).rejects.toThrow("GRAPHIFY_SECURITY_FAILURE");
  });

  it("does not misclassify a child rejection that races timeout termination", async () => {
    let rejectResult!: (reason: Error) => void;
    let acknowledgeTermination!: () => void;
    let signalTerminate!: () => void;
    const terminateCalled = new Promise<void>((resolve) => { signalTerminate = resolve; });
    const result = new Promise<never>((_resolve, reject) => { rejectResult = reject; });
    const exactRequest = realRequest();
    const port: GraphifyProcessPort = {
      version: "0.9.46",
      digest: GRAPHIFY_EVALUATION_PIN.implementationDigest,
      start: () => ({
        result,
        terminate: () => {
          signalTerminate();
          return new Promise<void>((resolve) => { acknowledgeTermination = resolve; });
        },
      }),
    };
    const extraction = new GraphifyStructuralExtractor(port).extract({
      ...exactRequest,
      limits: { ...exactRequest.limits, timeoutMs: 5, terminationTimeoutMs: 50 },
    });
    await terminateCalled;
    rejectResult(new Error("late child failure"));
    let settled = false;
    void extraction.finally(() => { settled = true; }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    acknowledgeTermination();
    await expect(extraction).rejects.toThrow("GRAPHIFY_PERFORMANCE_FAILURE");
  });

  it("terminates and awaits the supervisor when the child rejects before the deadline", async () => {
    const terminate = vi.fn(async () => undefined);
    const exactRequest = realRequest();
    const port: GraphifyProcessPort = {
      version: "0.9.46",
      digest: GRAPHIFY_EVALUATION_PIN.implementationDigest,
      start: () => ({
        result: Promise.reject(new Error("child protocol failed")),
        terminate,
      }),
    };
    await expect(new GraphifyStructuralExtractor(port).extract(exactRequest)).rejects.toThrow("GRAPHIFY_EXTRACTION_FAILURE");
    expect(terminate).toHaveBeenCalledWith({ forceAfterMs: 1_000 });
  });

  it("fails closed and terminates when a fulfilled result does not confirm process exit", async () => {
    const terminate = vi.fn(async () => undefined);
    const exactRequest = realRequest();
    const port: GraphifyProcessPort = {
      version: "0.9.46",
      digest: GRAPHIFY_EVALUATION_PIN.implementationDigest,
      start: () => ({
        result: Promise.resolve({
          exitConfirmed: false as unknown as true,
          output: raw(),
          observedFiles: exactRequest.files,
          peakMemoryBytes: 1,
        }),
        terminate,
      }),
    };
    await expect(new GraphifyStructuralExtractor(port).extract(exactRequest)).rejects.toThrow("GRAPHIFY_SECURITY_FAILURE");
    expect(terminate).toHaveBeenCalledWith({ forceAfterMs: 1_000 });
  });

  it("never publishes a late process result after the deadline has started termination", async () => {
    let resolveResult!: (value: { exitConfirmed: true; output: unknown; observedFiles: typeof files; peakMemoryBytes: number }) => void;
    let acknowledgeTermination!: () => void;
    let signalTerminate!: () => void;
    const terminateCalled = new Promise<void>((resolve) => { signalTerminate = resolve; });
    const terminate = vi.fn(() => {
      signalTerminate();
      return new Promise<void>((resolve) => { acknowledgeTermination = resolve; });
    });
    const result = new Promise<{ exitConfirmed: true; output: unknown; observedFiles: typeof files; peakMemoryBytes: number }>((resolve) => {
      resolveResult = resolve;
    });
    const exactRequest = realRequest();
    const port: GraphifyProcessPort = {
      version: "0.9.46",
      digest: GRAPHIFY_EVALUATION_PIN.implementationDigest,
      start: () => ({ terminate, result }),
    };
    const extraction = new GraphifyStructuralExtractor(port).extract({
      ...exactRequest,
      limits: { ...exactRequest.limits, timeoutMs: 5 },
    });
    await terminateCalled;
    resolveResult({ exitConfirmed: true, output: raw(), observedFiles: exactRequest.files, peakMemoryBytes: 1 });
    let settled = false;
    void extraction.finally(() => { settled = true; }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    acknowledgeTermination();
    await expect(extraction).rejects.toThrow("GRAPHIFY_PERFORMANCE_FAILURE");
  });
  it("uses the current extractor when disabled and falls back after a classified failure", async () => {
    const current = { descriptor: { id: "mendpoint-current", version: "1", implementationDigest: `sha256:${"2".repeat(64)}` as const }, extract: vi.fn(async () => ({ source: "current" })) };
    const graphify = { descriptor: { id: "graphify", version: "0.9.46", implementationDigest: GRAPHIFY_EVALUATION_PIN.implementationDigest }, extract: vi.fn(async () => { throw structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", "failed"); }) };
    const persistFallbackOutcome = vi.fn(async () => undefined);
    await expect(extractWithFallback({ enabled: false, request: request(), current, graphify })).resolves.toEqual({ source: "current" });
    await expect(extractWithFallback({ enabled: true, request: request(), current, graphify, persistFallbackOutcome })).resolves.toEqual({ source: "current" });
    expect(graphify.extract).toHaveBeenCalledTimes(1); expect(current.extract).toHaveBeenCalledTimes(2);
    expect(persistFallbackOutcome).toHaveBeenCalledWith(expect.objectContaining({ failureCode: "GRAPHIFY_EXTRACTION_FAILURE" }));
  });

  it("fails closed on Graphify security and identity failures instead of silently falling back", async () => {
    const descriptor = { id: "test", version: "1", implementationDigest: `sha256:${"2".repeat(64)}` as const };
    const current = { descriptor, extract: vi.fn(async () => ({ source: "current" })) };
    for (const code of ["GRAPHIFY_SECURITY_FAILURE", "GRAPHIFY_IDENTITY_INSTABILITY"] as const) {
      const graphify = { descriptor, extract: vi.fn(async () => { throw structuralFailure(code, "unsafe"); }) };
      await expect(extractWithFallback({ enabled: true, request: request(), current, graphify, persistFallbackOutcome: vi.fn(async () => undefined) })).rejects.toThrow(code);
    }
    expect(current.extract).not.toHaveBeenCalled();
  });

  it("does not persist a successful fallback outcome when the current extractor also fails", async () => {
    const descriptor = { id: "test", version: "1", implementationDigest: `sha256:${"2".repeat(64)}` as const };
    const persistFallbackOutcome = vi.fn(async () => undefined);
    const current = { descriptor, extract: vi.fn(async () => { throw new Error("baseline failed"); }) };
    const graphify = { descriptor, extract: vi.fn(async () => { throw structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", "failed"); }) };
    await expect(extractWithFallback({ enabled: true, request: request(), current, graphify, persistFallbackOutcome })).rejects.toThrow("baseline failed");
    expect(persistFallbackOutcome).not.toHaveBeenCalled();
  });
});

describe("tenant scope and incremental semantics", () => {
  it("binds every identity to tenant and repository scope", () => {
    const a = normalizeGraphifyExtraction(request(), raw(), metadata());
    const b = normalizeGraphifyExtraction(request({ tenantId: "tenant-b" }), raw(), metadata());
    expect(a.nodes.map((node) => node.id)).not.toEqual(b.nodes.map((node) => node.id)); expect(a.tenantId).toBe("tenant-a");
  });
  it("diffs immutable snapshots and invalidates changed neighborhoods", () => {
    const first = normalizeGraphifyExtraction(request(), raw(), metadata());
    const changed = raw(); changed.nodes.splice(2, 1); changed.edges = changed.edges.filter((edge) => edge.source !== "wrapper" && edge.target !== "wrapper");
    const second = normalizeGraphifyExtraction(request({ snapshotId: "snapshot-b", revision: revisionB }), changed, metadata());
    const diff = diffStructuralExtractions(first, second);
    expect(diff.removedCanonicalKeys).toContain("src/wrapper.ts::method::pay");
    expect(diff.invalidatedCanonicalKeys).toEqual(expect.arrayContaining(["src/client.ts::function::createPayment"]));
  });

  it("invalidates both endpoints for added edges and confidence-only changes", () => {
    const first = normalizeGraphifyExtraction(request(), raw(), metadata());

    const addedRaw = raw();
    addedRaw.edges.push({
      source: "create_payment", target: "test_pay", relation: "calls", confidence: "INFERRED",
      source_file: "src/client.ts", source_location: "L4", weight: 0.6,
    });
    const added = normalizeGraphifyExtraction(request({ snapshotId: "snapshot-b", revision: revisionB }), addedRaw, metadata());
    expect(diffStructuralExtractions(first, added).invalidatedCanonicalKeys).toEqual(expect.arrayContaining([
      "src/client.ts::function::createPayment",
      "test/client.test.ts::test::test pay",
    ]));

    const downgradedRaw = raw();
    downgradedRaw.edges[0] = { ...downgradedRaw.edges[0], confidence: "AMBIGUOUS", weight: 0.2 };
    const downgraded = normalizeGraphifyExtraction(request({ snapshotId: "snapshot-c", revision: "c".repeat(40) }), downgradedRaw, metadata());
    expect(diffStructuralExtractions(first, downgraded).invalidatedCanonicalKeys).toEqual(expect.arrayContaining([
      "src/wrapper.ts::method::pay",
      "src/client.ts::function::createPayment",
    ]));
  });

  it("rejects path aliases and non-regular Git modes in snapshot authority", () => {
    expect(() => structuralSnapshotManifestDigest([{ ...files[0], path: "src/./client.ts" }])).toThrow("GRAPHIFY_SECURITY_FAILURE");
    expect(() => structuralSnapshotManifestDigest([{ ...files[0], mode: "120000" }])).toThrow("GRAPHIFY_IDENTITY_INSTABILITY");
  });

  it("rejects malformed scope, warning, ambiguity, and upstream identity evidence after digest recomputation", () => {
    const accepted = normalizeGraphifyExtraction(request(), raw(), metadata());
    const variants: StructuralExtractionV1[] = [
      { ...structuredClone(accepted), tenantId: "" },
      { ...structuredClone(accepted), warnings: [{ code: "GRAPHIFY_EXTRACTION_FAILURE" as const, detail: "x", sourceFile: "missing.ts" }] },
      { ...structuredClone(accepted), ambiguities: [{ kind: "edge", subjectId: accepted.edges[0].id, candidates: [accepted.edges[0].sourceId], reason: "ambiguous upstream relationship" }] },
      (() => { const value = structuredClone(accepted); value.nodes[0].provenance.upstreamNodeId = ""; return value; })(),
      (() => { const value = structuredClone(accepted); value.sourceFiles[0].contentDigest = `sha256:${"f".repeat(64)}`; return value; })(),
    ];
    for (const value of variants) {
      value.contentDigest = structuralContentDigest(value);
      expect(() => structuralExtractionToCallGraph(value)).toThrow("GRAPHIFY_IDENTITY_INSTABILITY");
    }
  });
});

describe("blind spots and learning attribution", () => {
  it("separates static, semantic, and runtime gaps", () => {
    expect(classifyStructuralBlindSpot({ supportedLanguage: true, structuralFactPresent: false, runtimeOnly: false })).toBe("STRUCTURAL_STATIC_GAP");
    expect(classifyStructuralBlindSpot({ supportedLanguage: true, structuralFactPresent: true, runtimeOnly: false })).toBe("SEMANTIC_RESOLUTION_REQUIRED");
    expect(classifyStructuralBlindSpot({ supportedLanguage: true, structuralFactPresent: false, runtimeOnly: true })).toBe("RUNTIME_EVIDENCE_REQUIRED");
  });
  it("routes extractor misses away from model-weight learning", () => {
    expect(attributeStructuralFailure({ extracted: false, normalized: false, entityResolved: false, providerMapped: false, runtimeOnly: false, queryIncluded: false, modelObserved: false })).toBe("structural_extractor");
    expect(attributeStructuralFailure({ extracted: true, normalized: true, entityResolved: true, providerMapped: true, runtimeOnly: false, queryIncluded: true, modelObserved: false })).toBe("model");
  });
});
