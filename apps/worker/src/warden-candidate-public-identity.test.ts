/**
 * Fettler candidate PR body: public-identity projection (#704 / #713).
 *
 * The Fettler candidate delivery renders `Provider: <slug>` from the stored fan-out slug, which
 * is kept tenant-namespaced (`<tenantId>~<requested>`) for lineage/binding validation. That
 * stored value must never reach the customer repo: the rendered line must carry only the public
 * slug. A shared provider's slug has no namespace and must render byte-identical.
 */
import { describe, expect, it } from "vitest";
import { providerChangeBody } from "./warden-candidate-delivery.js";

function artifactWith(providerSlug: string): Record<string, unknown> {
  return {
    fettlerProviderChange: {
      schemaVersion: 1,
      providerSlug,
      changeId: "change-1",
      pipelineJobId: "pipeline-job-1",
      contentHash: "0123456789abcdef",
      fromVersionId: "version-1",
      fromVersionLabel: "2025-01",
      toVersionId: "version-2",
      toVersionLabel: "2026-08",
      repositoryId: "repo-1",
      snapshotId: "snapshot-1",
      revision: "a".repeat(40),
      graphVersionId: "graph-version-1",
      graphContextArtifactId: "graph-context-1",
      impactEvidenceDigest: `sha256:${"f".repeat(64)}`,
      overallConfidence: "high",
      whatChanged: "The provider removed the legacy request field.",
      knownFacts: ["The removed field is used in src/client.ts."],
      unknowns: ["Runtime-only callers were not observed."],
      whyAffected: "src/client.ts sends the removed field at the confirmed call site.",
    },
  };
}

describe("Fettler candidate body public identity", () => {
  it("renders the public slug for a tenant-private provider — no tenant id or `~`", () => {
    // A distinct 64-hex tenant id (not equal to, or a substring of, any digest in the artifact).
    const tenantId = "deadbeefcafef00d".repeat(4);
    const body = providerChangeBody(artifactWith(`${tenantId}~acme-payments`)).join("\n");
    expect(body).toContain("Provider: acme-payments");
    expect(body.includes(tenantId)).toBe(false);
    expect(body.includes("~")).toBe(false);
  });

  it("renders a shared provider slug unchanged", () => {
    const body = providerChangeBody(artifactWith("stripe")).join("\n");
    expect(body).toContain("Provider: stripe");
  });
});
