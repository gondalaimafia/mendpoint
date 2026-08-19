import { describe, expect, it, vi } from "vitest";
import {
  GraphifyStructuralExtractor, diffStructuralExtractions, extractWithFallback,
  attributeStructuralFailure, classifyStructuralBlindSpot, normalizeGraphifyExtraction,
  structuralFailure, structuralSnapshotManifestDigest,
  type GraphifyProcessPort, type StructuralExtractionRequest,
} from "./index.js";

const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);
const observedAt = "2026-08-18T12:00:00.000Z";
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
      { id: "client", label: "client.ts", file_type: "code", source_file: "src/client.ts", source_location: "L1" },
      { id: "create_payment", label: "createPayment", file_type: "function", source_file: "src/client.ts", source_location: "L3-L5", confidence: "EXTRACTED" },
      { id: "wrapper", label: "pay", file_type: "method", source_file: "src/wrapper.ts", source_location: "L7", confidence: "INFERRED" },
      { id: "test_pay", label: "test pay", file_type: "test", source_file: "test/client.test.ts", source_location: "L4", confidence: "EXTRACTED" },
    ],
    edges: [
      { source: "wrapper", target: "create_payment", relation: "calls", confidence: "INFERRED", source_file: "src/wrapper.ts", source_location: "L8", weight: 0.8 },
      { source: "test_pay", target: "wrapper", relation: "references", confidence: "AMBIGUOUS", source_file: "test/client.test.ts", source_location: "L5", weight: 0.5 },
      { source: "client", target: "create_payment", relation: "contains", confidence: "EXTRACTED", source_file: "src/client.ts", source_location: "L3", weight: 1 },
    ], warnings: ["one parse recovery"], failed_sources: [],
  };
}
const observedFiles = () => files.map((entry) => ({ ...entry }));
const metadata = (elapsedMs = 12) => ({ version: "0.9.46", digest: `sha256:${"1".repeat(64)}`, elapsedMs, peakMemoryBytes: 2_048, observedFiles: observedFiles() });

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
    ["dangling edge", { nodes: raw().nodes, edges: [{ source: "missing", target: "wrapper", relation: "calls", confidence: "EXTRACTED" }] }, "GRAPHIFY_EDGE_MISS"],
    ["unknown confidence", { nodes: raw().nodes, edges: [{ source: "wrapper", target: "create_payment", relation: "calls", confidence: "CERTAIN" }] }, "GRAPHIFY_AMBIGUITY"],
    ["partial extraction", { ...raw(), failed_sources: ["src/client.ts"] }, "GRAPHIFY_EXTRACTION_FAILURE"],
    ["unsupported language", { ...raw(), unsupported_languages: [{ language: "r", files: ["analysis.R"] }] }, "GRAPHIFY_LANGUAGE_GAP"],
  ])("fails closed for %s", (_name, value, code) => expect(() => normalizeGraphifyExtraction(request(), value, metadata())).toThrow(code));
});

describe("killable Graphify adapter and fallback", () => {
  it("snapshots process identity and fallback callables before external work", async () => {
    let versionReads = 0;
    let digestReads = 0;
    const port = {
      get version() { versionReads += 1; return "0.9.46"; },
      get digest() { digestReads += 1; return `sha256:${"1".repeat(64)}`; },
      start: vi.fn(() => ({
        result: Promise.resolve({ output: raw(), observedFiles: observedFiles(), peakMemoryBytes: 1 }),
        terminate: vi.fn(async () => undefined),
      })),
    };
    const extractor = new GraphifyStructuralExtractor(port);
    await extractor.extract(request());
    expect(versionReads).toBe(1);
    expect(digestReads).toBe(1);

    const descriptor = { id: "test", version: "1", implementationDigest: `sha256:${"2".repeat(64)}` as const };
    const original = { descriptor, extract: vi.fn(async () => "baseline") };
    const fallback = {
      enabled: true,
      request: request(),
      current: original,
      graphify: { descriptor, extract: vi.fn(async () => {
        fallback.current = { descriptor, extract: vi.fn(async () => "mutated") };
        throw structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", "expected");
      }) },
    };
    await expect(extractWithFallback(fallback)).resolves.toBe("baseline");
    expect(original.extract).toHaveBeenCalledOnce();
  });

  it("passes only a manifest-bound plan to an isolated process port", async () => {
    const terminate = vi.fn(async () => undefined);
    const port: GraphifyProcessPort = { version: "0.9.46", digest: `sha256:${"1".repeat(64)}`, start: vi.fn(() => ({ terminate, result: Promise.resolve({ output: raw(), observedFiles: observedFiles(), peakMemoryBytes: 2_048 }) })) };
    const result = await new GraphifyStructuralExtractor(port).extract(request());
    expect(port.start).toHaveBeenCalledWith(expect.objectContaining({ verifiedSnapshotRoot: "C:/safe/immutable-snapshot", snapshotId: "snapshot-a", manifestDigest: request().manifestDigest, files: request().files }));
    expect(result.extractor.id).toBe("graphify"); expect(terminate).not.toHaveBeenCalled();
  });
  it("hard terminates an isolated process that exceeds the deadline", async () => {
    const terminate = vi.fn(() => new Promise<void>(() => undefined));
    const port: GraphifyProcessPort = { version: "0.9.46", digest: `sha256:${"1".repeat(64)}`, start: () => ({ terminate, result: new Promise(() => undefined) }) };
    await expect(new GraphifyStructuralExtractor(port).extract(request({ limits: { ...request().limits, timeoutMs: 5 } }))).rejects.toThrow("GRAPHIFY_PERFORMANCE_FAILURE");
    expect(terminate).toHaveBeenCalledTimes(1);
  });
  it("uses the current extractor when disabled and falls back after a classified failure", async () => {
    const current = { descriptor: { id: "mendpoint-current", version: "1", implementationDigest: `sha256:${"2".repeat(64)}` as const }, extract: vi.fn(async () => ({ source: "current" })) };
    const graphify = { descriptor: { id: "graphify", version: "0.9.46", implementationDigest: `sha256:${"1".repeat(64)}` as const }, extract: vi.fn(async () => { throw structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", "failed"); }) };
    await expect(extractWithFallback({ enabled: false, request: request(), current, graphify })).resolves.toEqual({ source: "current" });
    await expect(extractWithFallback({ enabled: true, request: request(), current, graphify })).resolves.toEqual({ source: "current" });
    expect(graphify.extract).toHaveBeenCalledTimes(1); expect(current.extract).toHaveBeenCalledTimes(2);
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
