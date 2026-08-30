import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOC_CATEGORIES,
  PRODUCT_DOCS,
  buildDocsManifest,
  renderProductDocMarkdown,
} from "./catalog.js";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const claimRegistry = JSON.parse(
  readFileSync(resolve(repoRoot, "docs/PUBLIC_CLAIMS.json"), "utf8"),
) as {
  claims: Array<{
    id: string;
    requirementIds: string[];
    state: string;
    wording: string;
    scope: string;
    limitations: string[];
  }>;
};
const requirementRegistry = JSON.parse(
  readFileSync(resolve(repoRoot, "docs/PRODUCT_REQUIREMENTS.json"), "utf8"),
) as {
  requirements: Array<{
    id: string;
    implementationStatus: string;
    availability: string;
  }>;
};

function claim(id: string) {
  const value = claimRegistry.claims.find((entry) => entry.id === id);
  if (!value) throw new Error(`Missing public claim ${id}`);
  return value;
}

const requiredSlugs = [
  "fettler",
  "regauge",
  "change-ingestion",
  "change-graph",
  "repository-connections",
  "draft-delivery",
  "verification-attestations",
  "model-router",
  "post-trained-models",
  "learning-system",
  "billing-usage",
  "security-governance",
  "deployment-operations",
  "authentication-tenancy",
  "mission-policy",
  "api-conventions",
  "webhooks-events",
  "audit-compliance",
  "recovery-reliability",
  "limits-errors",
] as const;

describe("public product documentation catalog", () => {
  it("covers every major product component with canonical product slugs", () => {
    expect(PRODUCT_DOCS.map((page) => page.slug).sort()).toEqual([...requiredSlugs].sort());
    expect(new Set(PRODUCT_DOCS.map((page) => page.slug))).toHaveLength(PRODUCT_DOCS.length);
    expect(new Set(PRODUCT_DOCS.map((page) => page.category))).toEqual(new Set(DOC_CATEGORIES));
    expect(PRODUCT_DOCS.find((page) => page.slug === "fettler")?.title)
      .toBe("Fettler — the first AI API Engineer");
    expect(PRODUCT_DOCS.find((page) => page.slug === "regauge")?.title)
      .toBe("ReGauge — the first AI Legacy Engineer");
    expect(JSON.stringify(PRODUCT_DOCS)).not.toMatch(/\bRegauge\b/);
    expect(PRODUCT_DOCS.map((page) => page.slug)).not.toEqual(
      expect.arrayContaining(["warden", "transformer"]),
    );
  });

  it("requires availability, evidence, interfaces, guardrails, and limitations", () => {
    for (const page of PRODUCT_DOCS) {
      expect(page.summary.length).toBeGreaterThan(20);
      expect(["production", "limited_availability", "preview", "internal"]).toContain(page.status);
      expect(page.availability.length).toBeGreaterThan(0);
      expect(page.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (page.publicationEvidence.state === "live") {
        expect(page.publicationEvidence.deployedRevision).toMatch(/^[0-9a-f]{40}$/);
        expect(page.publicationEvidence.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      } else {
        expect(page.publicationEvidence).toEqual({
          state: "not_live",
          deployedRevision: null,
          evidenceDigest: null,
        });
      }
      expect(page.startHere.steps.length).toBeGreaterThan(0);
      expect(page.howItWorks.length).toBeGreaterThan(1);
      expect(page.interfaces.length).toBeGreaterThan(0);
      expect(page.evidence.length).toBeGreaterThan(0);
      expect(page.guardrails.length).toBeGreaterThan(0);
      expect(page.limitations.length).toBeGreaterThan(0);
      expect(page.related.length).toBeGreaterThan(0);
    }
  });

  it("does not exceed the registered public availability posture", () => {
    const fettler = PRODUCT_DOCS.find((page) => page.slug === "fettler");
    const regauge = PRODUCT_DOCS.find((page) => page.slug === "regauge");
    const repositoryConnections = PRODUCT_DOCS.find((page) => page.slug === "repository-connections");
    const draftDelivery = PRODUCT_DOCS.find((page) => page.slug === "draft-delivery");
    const security = PRODUCT_DOCS.find((page) => page.slug === "security-governance");
    const deployment = PRODUCT_DOCS.find((page) => page.slug === "deployment-operations");
    const fettlerClaim = claim("CLM-002");
    const regaugeClaim = claim("CLM-007");
    const gitLabClaim = claim("CLM-008");
    const deploymentClaim = claim("CLM-009");

    expect(fettler).toMatchObject({
      status: fettlerClaim.state,
      summary: fettlerClaim.wording,
    });
    expect(fettler?.availability).toContain(fettlerClaim.scope);
    expect(regauge).toMatchObject({ status: regaugeClaim.state });
    expect(regauge?.summary).toBe(regaugeClaim.wording.replace(/^Regauge\b/, "ReGauge"));
    expect(regauge?.availability).toContain(regaugeClaim.scope);
    expect(regauge?.limitations).toEqual(expect.arrayContaining(regaugeClaim.limitations));
    expect(repositoryConnections?.availability).toContain(gitLabClaim.wording);
    expect(draftDelivery?.availability).toContain(gitLabClaim.wording);
    expect(security?.status).not.toBe("production");
    expect(deployment?.availability).toContain(deploymentClaim.scope);
    expect(deployment?.limitations).toEqual(expect.arrayContaining(deploymentClaim.limitations));
  });

  it("describes the bounded Fettler review-feedback path as implemented", () => {
    const fettler = PRODUCT_DOCS.find((page) => page.slug === "fettler");
    const delivery = PRODUCT_DOCS.find((page) => page.slug === "draft-delivery");
    const publicCopy = JSON.stringify([fettler, delivery]);

    expect(publicCopy).not.toMatch(/review.feedback.*not yet implemented|full requested.change feedback reentry is next work/i);
    expect(fettler?.capabilities).toEqual(expect.arrayContaining([
      expect.stringMatching(/requested.change feedback reentry/i),
    ]));
    expect(delivery?.guardrails).toEqual(expect.arrayContaining([
      expect.stringMatching(/comments.*do not authorize mutation/i),
      expect.stringMatching(/fresh.*human approval/i),
    ]));
  });

  it("points every public evidence item at an existing repository file", () => {
    for (const page of PRODUCT_DOCS) {
      for (const evidence of page.evidence) {
        expect(
          existsSync(resolve(repoRoot, evidence.locator)),
          `${page.slug}: ${evidence.locator}`,
        ).toBe(true);
      }
    }
  });

  it("binds every page to registered requirements, claims, and existing contract sources", () => {
    const requirements = new Map(requirementRegistry.requirements.map((entry) => [entry.id, entry]));
    const claims = new Map(claimRegistry.claims.map((entry) => [entry.id, entry]));
    for (const page of PRODUCT_DOCS) {
      expect(page.requirementIds.length, `${page.slug}: requirements`).toBeGreaterThan(0);
      expect(new Set(page.requirementIds).size, `${page.slug}: duplicate requirements`).toBe(page.requirementIds.length);
      expect(new Set(page.claimIds).size, `${page.slug}: duplicate claims`).toBe(page.claimIds.length);
      expect(page.sourceContracts.length, `${page.slug}: sources`).toBeGreaterThan(0);
      for (const id of page.requirementIds) expect(requirements.has(id), `${page.slug}: ${id}`).toBe(true);
      for (const id of page.claimIds) {
        const publicClaim = claims.get(id);
        expect(publicClaim, `${page.slug}: ${id}`).toBeDefined();
        for (const requirementId of publicClaim?.requirementIds ?? []) {
          expect(page.requirementIds, `${page.slug}: ${id} requires ${requirementId}`).toContain(requirementId);
        }
      }
      for (const locator of page.sourceContracts) {
        expect(existsSync(resolve(repoRoot, locator)), `${page.slug}: ${locator}`).toBe(true);
      }
      if (page.status === "production") {
        for (const id of page.requirementIds) {
          expect(requirements.get(id), `${page.slug}: ${id}`).toMatchObject({
            implementationStatus: "verified",
            availability: "ga",
          });
        }
      }
    }
  });

  it("binds the documented ReGauge campaign read route to the implemented control plane route", () => {
    const regauge = PRODUCT_DOCS.find((page) => page.slug === "regauge");
    expect(regauge?.interfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "GET /transformer/control-plane/campaigns/:campaignId", kind: "API" }),
    ]));
    expect(
      readFileSync(resolve(repoRoot, "apps/api/src/transformer-control-plane.ts"), "utf8"),
    ).toContain('app.get(`${base}/control-plane/campaigns/:campaignId`');
  });

  it("keeps related links closed over the catalog and examples free of credential values", () => {
    const slugs = new Set(PRODUCT_DOCS.map((page) => page.slug));
    for (const page of PRODUCT_DOCS) {
      for (const related of page.related) expect(slugs.has(related), `${page.slug}: ${related}`).toBe(true);
      expect(page.startHere.command ?? "").not.toMatch(/Bearer\s+(?!\$|<)[A-Za-z0-9._~-]{16,}|me_[A-Za-z0-9_-]{16,}|BEGIN (?:RSA |EC )?PRIVATE KEY/);
    }
  });

  it("renders the complete machine-readable contract as Markdown", () => {
    for (const page of PRODUCT_DOCS) {
      const markdown = renderProductDocMarkdown(page);
      expect(markdown).toContain(`# ${page.title}`);
      expect(markdown).toContain(`Status: ${page.statusLabel}`);
      expect(markdown).toContain(`Availability: ${page.availability}`);
      expect(markdown).toContain(`Last verified: ${page.lastVerified}`);
      expect(markdown).toContain("Publication evidence: ");
      expect(markdown).toContain(`Requirements: ${page.requirementIds.join(", ")}`);
      expect(markdown).toContain("## Start here");
      expect(markdown).toContain("## How it works");
      expect(markdown).toContain("## Interfaces");
      expect(markdown).toContain("## Evidence and verification");
      expect(markdown).toContain("## Contract sources");
      expect(markdown).toContain("## Safety model");
      expect(markdown).toContain("## Limitations");
      expect(markdown).toContain("## See also");
    }
  });

  it("builds a deterministic manifest without legacy docs slugs or secret material", () => {
    const first = buildDocsManifest();
    expect(first).toEqual(buildDocsManifest());
    expect(first.schemaVersion).toBe("2026-08-30.v3");
    expect(first.pages.every((page) => page.publicationEvidence.state === "not_live")).toBe(true);
    expect(first.pages).toHaveLength(requiredSlugs.length);
    expect(first.pages.map((page) => page.webPath)).not.toEqual(
      expect.arrayContaining(["/docs/warden", "/docs/transformer"]),
    );
    expect(JSON.stringify(first)).not.toMatch(/BEGIN (?:RSA |EC )?PRIVATE KEY|me_[A-Za-z0-9_-]{32,}/);
  });
});
