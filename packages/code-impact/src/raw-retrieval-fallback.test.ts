import { describe, expect, it } from "vitest";
import type { ImpactReport } from "@mendpoint/shared";
import type { FettlerEndpointImpactResult } from "@mendpoint/graph-learn";
import { resolveBoundedRawRetrievalFallback } from "./raw-retrieval-fallback.js";

const graphDigest = `sha256:${"a".repeat(64)}`;
const graphVersionId = `sgv1:${"a".repeat(64)}`;

function graphImpact(
  coverage: FettlerEndpointImpactResult["coverage"],
  impact: FettlerEndpointImpactResult["impact"] = "unknown_impact",
): FettlerEndpointImpactResult {
  return {
    schemaVersion: "mendpoint.fettler-impact-context.v1",
    tenantId: "tenant-a",
    repositoryId: "repo-a",
    graphVersionId,
    graphContentDigest: graphDigest,
    target: { status: "unresolved", candidates: [] },
    impact,
    entities: [],
    relationships: [],
    paths: [],
    coverage,
    resultDigest: `sha256:${"b".repeat(64)}`,
  };
}

function rawReport(withSite = true): ImpactReport {
  return {
    surfaces: [{
      id: "surface:charges-create",
      canonicalId: "stripe.charges.create",
      kind: "http_path",
      op: "path_removed",
      path: "/v1/charges",
      method: "POST",
      severity: "breaking",
      migrationStrategy: "migrate",
      explanation: "endpoint changed",
      searchTokens: ["charges.create"],
    }],
    sites: withSite ? [{
      filePath: "src/payments/client.ts",
      lineStart: 10,
      lineEnd: 10,
      symbol: "createCharge",
      confidence: "high",
      evidence: "source:src/payments/client.ts:10",
      impactType: "direct_call",
      surfaceIds: ["surface:charges-create"],
      relatedOps: ["path_removed"],
      confirmationPath: "static",
    }] : [],
    overallRisk: "breaking",
    overallConfidence: withSite ? "high" : "high",
    coverage: {
      basis: "analyzed",
      gaps: [],
      filesInspected: 4,
      filesInScope: 4,
      languagesPresent: ["typescript"],
    },
    strategySummary: withSite ? "one impact" : "no impact",
    candidateCount: withSite ? 1 : 0,
    confirmedCount: withSite ? 1 : 0,
    lowConfidenceNotifications: [],
  };
}

const authority = {
  tenantId: "tenant-a",
  repositoryId: "repo-a",
  repositorySnapshotId: "snapshot-a",
  repositoryRevision: "c".repeat(40),
  providerId: "provider-a",
  providerSnapshotId: "provider-snapshot-a",
  providerRevision: "2026-08-30",
  parentGraphVersionId: graphVersionId,
  parentGraphContentDigest: graphDigest,
};

const retrieval = {
  maxFiles: 100,
  maxBytes: 1_000_000,
  maxCandidates: 50,
  filesInspected: 4,
  bytesInspected: 4_096,
};

describe("bounded raw-retrieval fallback", () => {
  it("bypasses raw retrieval when graph coverage is complete", () => {
    const result = resolveBoundedRawRetrievalFallback({
      graphImpact: graphImpact({ basis: "complete", reasons: [], truncated: false }, "no_impact"),
      rawReport: rawReport(),
      authority,
      observedAt: "2026-08-30T12:00:00.000Z",
      retrieval: { ...retrieval, filesInspected: 1_000_000 },
    });

    expect(result.decision.outcome).toBe("not_required");
    expect(result.impactReport).toBeUndefined();
    expect(result.relationshipCandidates).toEqual([]);
  });

  it("adopts bounded findings under incomplete graph coverage as pending candidates", () => {
    const first = resolveBoundedRawRetrievalFallback({
      graphImpact: graphImpact({
        basis: "partial",
        reasons: ["language_parsing:partial"],
        truncated: false,
      }),
      rawReport: rawReport(),
      authority,
      observedAt: "2026-08-30T12:00:00.000Z",
      retrieval,
    });
    const second = resolveBoundedRawRetrievalFallback({
      graphImpact: graphImpact({
        basis: "partial",
        reasons: ["language_parsing:partial"],
        truncated: false,
      }),
      rawReport: rawReport(),
      authority,
      observedAt: "2026-08-30T12:00:00.000Z",
      retrieval,
    });

    expect(second).toEqual(first);
    expect(first.decision.outcome).toBe("completed");
    expect(first.decision.reasonCodes).toEqual(["language_parsing:partial"]);
    expect(first.impactReport?.sites).toHaveLength(1);
    expect(first.relationshipCandidates).toHaveLength(1);
    expect(first.relationshipCandidates[0]).toMatchObject({
      status: "pending_validation",
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      parentGraphVersionId: graphVersionId,
    });
  });

  it("keeps an empty fallback unknown while graph coverage is incomplete", () => {
    const result = resolveBoundedRawRetrievalFallback({
      graphImpact: graphImpact({
        basis: "target_absent",
        reasons: ["unresolved"],
        truncated: false,
      }),
      rawReport: rawReport(false),
      authority,
      observedAt: "2026-08-30T12:00:00.000Z",
      retrieval,
    });

    expect(result.decision.outcome).toBe("completed");
    expect(result.impactReport?.sites).toEqual([]);
    expect(result.impactReport?.overallConfidence).toBe("unknown");
    expect(result.impactReport?.coverage).toMatchObject({ basis: "partial" });
    expect(result.impactReport?.coverage?.gaps.map((gap) => gap.reason))
      .toContain("query_truncated");
  });

  it("abstains before admitting findings when any retrieval bound is exceeded", () => {
    const result = resolveBoundedRawRetrievalFallback({
      graphImpact: graphImpact({
        basis: "partial",
        reasons: ["query_truncated"],
        truncated: true,
      }),
      rawReport: { ...rawReport(), candidateCount: 51 },
      authority,
      observedAt: "2026-08-30T12:00:00.000Z",
      retrieval,
    });

    expect(result.decision).toMatchObject({
      outcome: "abstained",
      failureCode: "raw_retrieval_candidate_budget_exceeded",
    });
    expect(result.impactReport).toBeUndefined();
    expect(result.relationshipCandidates).toEqual([]);
  });

  it("rejects a graph observation outside the supplied authority", () => {
    expect(() => resolveBoundedRawRetrievalFallback({
      graphImpact: { ...graphImpact({ basis: "partial", reasons: ["unresolved"], truncated: false }), tenantId: "tenant-b" },
      rawReport: rawReport(),
      authority,
      observedAt: "2026-08-30T12:00:00.000Z",
      retrieval,
    })).toThrow("raw_retrieval_fallback_graph_scope_mismatch");
  });
});
