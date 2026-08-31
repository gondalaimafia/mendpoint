import { describe, expect, it } from "vitest";
import type { FettlerEndpointImpactResult } from "@mendpoint/graph-learn";
import {
  flaggedFilesFromGraphImpact,
  graphImpactMeasured,
} from "./fettler-graph-runner.js";

/** Minimal repository/provider graph entity — only the fields the pure
 * extraction reads (`scope`, `canonicalKey`) are meaningful; the rest are filled
 * to satisfy the type. */
function entity(scope: "repository" | "provider", canonicalKey: string) {
  return {
    id: `id:${canonicalKey}`, kind: "function", canonicalKey, aliases: [], label: canonicalKey,
    scope, evidenceRefs: [], extractor: { id: "graphify", version: "1", implementationDigest: "sha256:x" },
    derivation: "call_graph", confidenceBasis: "static_analysis_medium", status: "active",
    validFrom: "2026-01-01T00:00:00.000Z",
  } as unknown as FettlerEndpointImpactResult["entities"][number];
}

function impact(overrides: Partial<FettlerEndpointImpactResult>): FettlerEndpointImpactResult {
  return {
    schemaVersion: "mendpoint.fettler-impact-context.v1",
    tenantId: "t", repositoryId: "r",
    repositorySnapshotId: "repository-snapshot-1", repositoryRevision: "revision-1",
    providerId: "provider", providerSnapshotId: "provider-snapshot-1", providerRevision: "provider-revision-1",
    graphVersionId: "sgv1:x", graphContentDigest: "d",
    target: { status: "exact", entity: entity("provider", "POST /v1/charges::endpoint::e") } as FettlerEndpointImpactResult["target"],
    impact: "impact",
    entities: [], relationships: [], paths: [],
    coverage: { basis: "complete", reasons: [], truncated: false },
    resultDigest: "rd",
    ...overrides,
  };
}

describe("flaggedFilesFromGraphImpact", () => {
  it("extracts repo-relative files from repository entity canonicalKeys, excluding provider entities", () => {
    const result = impact({
      entities: [
        entity("repository", "src/checkout.ts::function::createCharge"),
        entity("repository", "src/checkout.ts::test::testCheckout"),
        entity("repository", "app/pay.ts::function::pay"),
        entity("provider", "POST /v1/charges::endpoint::charges"),
        entity("provider", "charges.create::sdk_method::create"),
      ],
    });
    expect(flaggedFilesFromGraphImpact(result)).toEqual(["app/pay.ts", "src/checkout.ts"]);
  });

  it("returns an empty set when no repository entities are present", () => {
    expect(flaggedFilesFromGraphImpact(impact({ entities: [entity("provider", "POST /x::endpoint::x")] }))).toEqual([]);
  });

  it("ignores a repository entity whose canonicalKey has no path segment", () => {
    expect(flaggedFilesFromGraphImpact(impact({ entities: [entity("repository", "::function::orphan")] }))).toEqual([]);
  });
});

describe("graphImpactMeasured", () => {
  it("is measured when the endpoint resolved and coverage is not target-absent", () => {
    expect(graphImpactMeasured(impact({ coverage: { basis: "complete", reasons: [], truncated: false } })).measured).toBe(true);
    expect(graphImpactMeasured(impact({ coverage: { basis: "partial", reasons: [], truncated: false } })).measured).toBe(true);
  });

  it("is NOT measured (with a reason) when the endpoint target is absent", () => {
    const decision = graphImpactMeasured(impact({ coverage: { basis: "target_absent", reasons: [], truncated: false } }));
    expect(decision.measured).toBe(false);
    expect(decision.reason).toMatch(/no coverage/);
  });

  it("is NOT measured when the changed endpoint could not be resolved", () => {
    const decision = graphImpactMeasured(impact({
      target: { status: "unresolved", candidates: [] } as FettlerEndpointImpactResult["target"],
    }));
    expect(decision.measured).toBe(false);
    expect(decision.reason).toMatch(/could not resolve/);
  });
});
