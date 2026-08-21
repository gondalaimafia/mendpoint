import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildIndex } from "@mendpoint/codebase-index";
import { openGraphLearnMemory, publishSoftwareGraphVersion, queryFettlerEndpointImpact } from "@mendpoint/graph-learn";
import { GRAPHIFY_EVALUATION_PIN, structuralContentDigest, structuralExtractionToCallGraph, structuralSnapshotManifestDigest, type StructuralExtractionV1 } from "@mendpoint/structural-graph";
import { sdkContextFromSurfaces } from "./index.js";
import { materializeFettlerSoftwareGraph } from "./software-graph-materializer.js";
import type { ImpactableSurface } from "@mendpoint/shared";

const directories: string[] = [];
afterAll(() => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const surface: ImpactableSurface = {
  id: "stripe-charge-source",
  canonicalId: "stripe.POST./v1/charges.request_field_replaced.source.payment_method",
  kind: "request_field", op: "request_field_renamed", path: "/v1/charges", method: "post",
  field: "source", fromField: "source", toField: "payment_method", severity: "breaking",
  migrationStrategy: "Use payment_method", explanation: "Stripe replaced source with payment_method",
  searchTokens: ["/v1/charges", "charges", "create", "source", "payment_method"],
};

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "graphify-stripe-vertical-")); directories.push(root);
  mkdirSync(join(root, "src"), { recursive: true }); mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "stripe-consumer", dependencies: { stripe: "11.0.0" } }));
  writeFileSync(join(root, "src", "client.ts"), ['import Stripe from "stripe";', "const stripe = new Stripe('test');", "export async function createCharge() {", "  return stripe.charges.create({ amount: 100, currency: 'usd', source: 'tok_test' });", "}"].join("\n"));
  writeFileSync(join(root, "src", "checkout.ts"), ['import { createCharge } from "./client";', "export async function checkout() {", "  return createCharge();", "}"].join("\n"));
  writeFileSync(join(root, "test", "checkout.test.ts"), ['import { checkout } from "../src/checkout";', "export async function testCheckout() {", "  return checkout();", "}"].join("\n"));
  return root;
}

function structural(): StructuralExtractionV1 {
  const extractor = { id: "graphify", version: "0.9.46", digest: GRAPHIFY_EVALUATION_PIN.implementationDigest };
  const provenance = (upstreamNodeId: string, sourceFile: string, sourceLocation: string, confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS") => ({
    engine: "graphify" as const, extractorVersion: "0.9.46", method: "tree-sitter" as const,
    upstreamNodeId, upstreamConfidence: confidence, sourceFile, sourceLocation,
    repositorySnapshotId: "snapshot-stripe", observedAt: "2026-08-19T00:00:00.000Z",
  });
  const node = (name: string, filePath: string, lineStart: number, lineEnd: number, isTest = false, epistemicState: "observed" | "inferred" | "ambiguous" = "observed") => ({
    id: digest(`tenant-a\0repo-a\0snapshot-stripe\0${filePath}::${isTest ? "test" : "function"}::${name}`), canonicalKey: `${filePath}::${isTest ? "test" : "function"}::${name}`,
    kind: isTest ? "test" as const : "function" as const, label: name, qualifiedName: name, filePath,
    language: "typescript", lineStart, lineEnd, isTest, epistemicState,
    provenance: provenance(name, filePath, `L${lineStart}-L${lineEnd}`, epistemicState === "observed" ? "EXTRACTED" : epistemicState === "inferred" ? "INFERRED" : "AMBIGUOUS"),
  });
  const createCharge = node("createCharge", "src/client.ts", 3, 5, false, "ambiguous");
  const checkout = node("checkout", "src/checkout.ts", 2, 4, false, "inferred");
  const testCheckout = node("testCheckout", "test/checkout.test.ts", 2, 4, true, "ambiguous");
  const edge = (source: typeof createCharge, target: typeof createCharge, filePath: string, line: number) => ({
    id: digest(`snapshot-stripe\0calls\0${source.id}\0${target.id}\0${filePath}\0${line}`), kind: "calls" as const, sourceId: source.id, targetId: target.id,
    sourceFile: filePath, lineStart: line, lineEnd: line, epistemicState: "observed" as const, confidence: 1,
    provenance: (() => {
      const { upstreamNodeId: _upstreamNodeId, ...shared } = provenance(`${source.label}->${target.label}`, filePath, `L${line}`, "EXTRACTED");
      return { ...shared, upstreamRelation: "calls" };
    })(),
  });
  const sourceFiles = [
    { path: "src/client.ts", contentDigest: digest("client"), byteLength: 1, mode: "100644", kind: "file" as const },
    { path: "src/checkout.ts", contentDigest: digest("checkout"), byteLength: 1, mode: "100644", kind: "file" as const },
    { path: "test/checkout.test.ts", contentDigest: digest("test"), byteLength: 1, mode: "100644", kind: "file" as const },
  ];
  const withoutDigest = {
    schemaVersion: "mendpoint.structural-extraction.v1" as const,
    tenantId: "tenant-a", repositoryId: "repo-a", snapshotId: "snapshot-stripe", revision: "a".repeat(40),
    manifestDigest: structuralSnapshotManifestDigest(sourceFiles), sourceFiles,
    observedAt: "2026-08-19T00:00:00.000Z", extractor, languages: ["typescript"],
    nodes: [createCharge, checkout, testCheckout],
    edges: [edge(checkout, createCharge, "src/checkout.ts", 3), edge(testCheckout, checkout, "test/checkout.test.ts", 3)],
    ambiguities: [], warnings: [],
    metrics: { elapsedMs: 1, normalizationMs: 1, peakMemoryBytes: 1_024, nodeCount: 3, edgeCount: 2, languageCount: 1, confidenceDistribution: { observed: 2, inferred: 1, ambiguous: 2 } },
  };
  return { ...withoutDigest, contentDigest: structuralContentDigest(withoutDigest) };
}

describe("Graphify normalized structure to Stripe Fettler impact", () => {
  it("promotes an exact Stripe SDK use through an indirect wrapper and test into one immutable Change Graph version", () => {
    const root = repository();
    const extraction = structural();
    const index = buildIndex(root, { callGraph: structuralExtractionToCallGraph(extraction), sdkContext: sdkContextFromSurfaces([surface]) });
    const publication = materializeFettlerSoftwareGraph({
      index, tenantId: "tenant-a", repositoryId: "repo-a", repositorySnapshotId: "snapshot-stripe",
      repositoryRevision: "a".repeat(40), providerId: "stripe", providerSnapshotId: "stripe-openapi-v2",
      providerRevision: "2026-08-19", providerSdkPackage: "stripe", providerSdkVersion: "11.0.0",
      providerEndpointSurfaceCount: 1,
      endpoint: { canonicalKey: "POST /v1/charges", method: "POST", path: "/v1/charges", sdkMethodPaths: ["charges.create"], evidenceRefs: ["artifact:stripe-openapi-v2"] },
      observedAt: "2026-08-19T00:00:00.000Z", maxCallerHops: 4,
    });
    const db = openGraphLearnMemory();
    const version = publishSoftwareGraphVersion(db, publication);
    const impact = queryFettlerEndpointImpact(db, { tenantId: "tenant-a", repositoryId: "repo-a", graphVersionId: version.versionId, endpointKey: "POST /v1/charges", maxHops: 6, maxEntities: 50, maxRelationships: 100 });
    expect(impact.impact).toBe("impact");
    expect(impact.entities.map((entity) => entity.label)).toEqual(expect.arrayContaining(["createCharge", "checkout", "testCheckout"]));
    expect(impact.paths.some((path) => path.length === 5)).toBe(true);
    const structuralRelations = publication.relationships.filter((relationship) => ["wraps", "calls", "tests"].includes(relationship.kind));
    expect(structuralRelations.every((relationship) => relationship.extractor.id === "graphify")).toBe(true);
    expect(structuralRelations.every((relationship) => relationship.evidenceRefs.some((ref) => ref.startsWith("structural-extraction:sha256:")))).toBe(true);
    expect(publication.entities.find((entity) => entity.label === "checkout")?.confidenceBasis).toBe("static_analysis_medium");
    expect(publication.entities.find((entity) => entity.label === "testCheckout")?.confidenceBasis).toBe("static_analysis_low");
    expect(publication.entities.filter((entity) => ["checkout", "testCheckout"].includes(entity.label)).every(
      (entity) => entity.confidenceBasis !== "deterministic_exact",
    )).toBe(true);
    // The seed internal_sdk_method is the anchor of every impact path. Its
    // ambiguous structural source must be carried honestly, not stamped exact:
    // the confidence basis, the extractor attribution, and the evidence refs all
    // derive from the structural source, exactly as the caller entities above.
    const seedEntity = publication.entities.find((entity) => entity.kind === "internal_sdk_method" && entity.label === "createCharge");
    expect(seedEntity?.confidenceBasis).toBe("static_analysis_low");
    expect(seedEntity?.confidenceBasis).not.toBe("deterministic_exact");
    expect(seedEntity?.extractor.id).toBe("graphify");
    expect(seedEntity?.evidenceRefs.some((ref) => ref.startsWith("structural-extraction:sha256:"))).toBe(true);
    expect(publication.relationships.filter((relationship) => relationship.kind === "uses_sdk_method").every(
      (relationship) => relationship.confidenceBasis === "static_analysis_low",
    )).toBe(true);
    db.raw.close();
  });

  it("rejects publishing structurally sourced facts under a different tenant, repository, or snapshot", () => {
    const root = repository();
    const extraction = structural();
    const index = buildIndex(root, { callGraph: structuralExtractionToCallGraph(extraction), sdkContext: sdkContextFromSurfaces([surface]) });
    const base = {
      index, tenantId: "tenant-a", repositoryId: "repo-a", repositorySnapshotId: "snapshot-stripe",
      repositoryRevision: "a".repeat(40), providerId: "stripe", providerSnapshotId: "stripe-openapi-v2",
      providerRevision: "2026-08-19", providerSdkPackage: "stripe", providerSdkVersion: "11.0.0",
      providerEndpointSurfaceCount: 1,
      endpoint: { canonicalKey: "POST /v1/charges", method: "POST", path: "/v1/charges", sdkMethodPaths: ["charges.create"], evidenceRefs: ["artifact:stripe-openapi-v2"] },
      observedAt: "2026-08-19T00:00:00.000Z", maxCallerHops: 4,
    };
    for (const mismatch of [
      { tenantId: "tenant-b" },
      { repositoryId: "repo-b" },
      { repositorySnapshotId: "snapshot-other" },
      { repositoryRevision: "b".repeat(40) },
    ]) {
      expect(() => materializeFettlerSoftwareGraph({ ...base, ...mismatch })).toThrow("software_graph_structural_scope_mismatch");
    }
  });
});
