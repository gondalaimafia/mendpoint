import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeGraphifyExtraction, structuralSnapshotManifestDigest, type StructuralExtractionRequest } from "./index.js";

const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const tiers = [["small", 10], ["medium", 100], ["large", 1_000], ["monorepo", 5_000]] as const;

describe("Graphify normalization size tiers", () => {
  it.each(tiers)("normalizes a bounded %s graph deterministically", (_tier, count) => {
    const files = Array.from({ length: count }, (_, index) => ({ path: `src/f${index}.ts`, contentDigest: sha(`file-${index}`), byteLength: 100, mode: "100644", kind: "file" as const }));
    const request: StructuralExtractionRequest = {
      tenantId: "tenant-perf", repositoryId: "repo-perf", snapshotId: "snapshot-perf", revision: "a".repeat(40),
      manifestDigest: structuralSnapshotManifestDigest(files), verifiedSnapshotRoot: "C:/safe/perf", observedAt: "2026-08-19T00:00:00.000Z", files,
      limits: { maxFiles: 10_000, maxInputBytes: 2_000_000, maxNodes: 10_000, maxEdges: 20_000, maxOutputBytes: 20_000_000, maxMemoryBytes: 512_000_000, timeoutMs: 30_000 },
    };
    const nodes = files.map((entry, index) => ({ id: `n${index}`, label: `f${index}`, file_type: "function", source_file: entry.path, source_location: "L1", confidence: "EXTRACTED" }));
    const edges = nodes.slice(1).map((node, index) => ({ source: node.id, target: nodes[index].id, relation: "calls", source_file: files[index + 1].path, source_location: "L1", confidence: "EXTRACTED", weight: 1 }));
    const first = normalizeGraphifyExtraction(request, { nodes, edges }, { version: "0.9.46", digest: `sha256:${"1".repeat(64)}`, elapsedMs: 1, peakMemoryBytes: 1, observedFiles: files });
    const second = normalizeGraphifyExtraction(request, { nodes: [...nodes].reverse(), edges: [...edges].reverse() }, { version: "0.9.46", digest: `sha256:${"1".repeat(64)}`, elapsedMs: 999, peakMemoryBytes: 2, observedFiles: files });
    expect(first.metrics.nodeCount).toBe(count);
    expect(first.metrics.edgeCount).toBe(Math.max(0, count - 1));
    expect(first.contentDigest).toBe(second.contentDigest);
  }, 30_000);
});
