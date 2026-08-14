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
    state: string;
    wording: string;
    scope: string;
    limitations: string[];
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
] as const;

describe("public product documentation catalog", () => {
  it("covers every major product component with canonical product slugs", () => {
    expect(PRODUCT_DOCS.map((page) => page.slug).sort()).toEqual([...requiredSlugs].sort());
    expect(new Set(PRODUCT_DOCS.map((page) => page.slug))).toHaveLength(PRODUCT_DOCS.length);
    expect(new Set(PRODUCT_DOCS.map((page) => page.category))).toEqual(new Set(DOC_CATEGORIES));
    expect(PRODUCT_DOCS.find((page) => page.slug === "fettler")?.title)
      .toBe("Fettler — the first AI API Engineer");
    expect(PRODUCT_DOCS.find((page) => page.slug === "regauge")?.title)
      .toBe("Regauge — the first AI Legacy Engineer");
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
    expect(regauge).toMatchObject({
      status: regaugeClaim.state,
      summary: regaugeClaim.wording,
    });
    expect(regauge?.availability).toContain(regaugeClaim.scope);
    expect(regauge?.limitations).toEqual(expect.arrayContaining(regaugeClaim.limitations));
    expect(repositoryConnections?.availability).toContain(gitLabClaim.wording);
    expect(draftDelivery?.availability).toContain(gitLabClaim.wording);
    expect(security?.status).not.toBe("production");
    expect(deployment?.availability).toContain(deploymentClaim.scope);
    expect(deployment?.limitations).toEqual(expect.arrayContaining(deploymentClaim.limitations));
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

  it("renders the complete machine-readable contract as Markdown", () => {
    for (const page of PRODUCT_DOCS) {
      const markdown = renderProductDocMarkdown(page);
      expect(markdown).toContain(`# ${page.title}`);
      expect(markdown).toContain(`Status: ${page.statusLabel}`);
      expect(markdown).toContain(`Availability: ${page.availability}`);
      expect(markdown).toContain(`Last verified: ${page.lastVerified}`);
      expect(markdown).toContain("## Start here");
      expect(markdown).toContain("## How it works");
      expect(markdown).toContain("## Interfaces");
      expect(markdown).toContain("## Evidence and verification");
      expect(markdown).toContain("## Safety model");
      expect(markdown).toContain("## Limitations");
      expect(markdown).toContain("## See also");
    }
  });

  it("builds a deterministic manifest without legacy docs slugs or secret material", () => {
    const first = buildDocsManifest();
    expect(first).toEqual(buildDocsManifest());
    expect(first.schemaVersion).toBe("2026-08-14.v1");
    expect(first.pages).toHaveLength(requiredSlugs.length);
    expect(first.pages.map((page) => page.webPath)).not.toEqual(
      expect.arrayContaining(["/docs/warden", "/docs/transformer"]),
    );
    expect(JSON.stringify(first)).not.toMatch(/BEGIN (?:RSA |EC )?PRIVATE KEY|me_[A-Za-z0-9_-]{32,}/);
  });
});
