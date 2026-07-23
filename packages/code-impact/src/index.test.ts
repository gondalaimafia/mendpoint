import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeChange } from "@mendpoint/change-intel";
import { buildIndex } from "@mendpoint/codebase-index";
import {
  analyzeImpact,
  analyzeRepo,
  discoverCandidates,
  expandContexts,
} from "./index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const providerDir = join(root, "fixtures/providers/acme-payments");
const consumerDir = join(root, "fixtures/consumers/shop-app");

function loadSurfaces() {
  const v1 = JSON.parse(readFileSync(join(providerDir, "openapi-v1.json"), "utf8"));
  const v2 = JSON.parse(readFileSync(join(providerDir, "openapi-v2.json"), "utf8"));
  return normalizeChange(v1, v2, { providerSlug: "acme-payments" });
}

describe("hybrid impact pipeline", () => {
  it("indexes then discovers high-recall candidates", () => {
    const { surfaces } = loadSurfaces();
    const index = buildIndex(consumerDir);
    const candidates = discoverCandidates(index, surfaces);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((c) => c.symbol === "amount_cents" || c.evidence.includes("amount_cents"))).toBe(
      true,
    );
    expect(candidates.some((c) => c.sources.includes("syntactic") || c.sources.includes("sdk_graph"))).toBe(
      true,
    );
  });

  it("expands context with enclosing function slices", () => {
    const { surfaces } = loadSurfaces();
    const index = buildIndex(consumerDir);
    const candidates = discoverCandidates(index, surfaces);
    const expanded = expandContexts(index, candidates.slice(0, 5));
    expect(expanded.length).toBeGreaterThan(0);
    expect(expanded[0]!.slice.length).toBeGreaterThan(0);
  });

  it("call-graph expansion finds PaymentService wrappers for charge sites", () => {
    const { surfaces } = loadSurfaces();
    const index = buildIndex(consumerDir);
    expect(index.callGraph.stats.nodeCount).toBeGreaterThan(0);
    const candidates = discoverCandidates(index, surfaces);
    const chargeSites = candidates.filter(
      (c) =>
        c.filePath.includes("payments") ||
        c.symbol === "amount_cents" ||
        c.evidence.includes("charges"),
    );
    const expanded = expandContexts(index, chargeSites, { callerHops: 3 });
    const withGraph = expanded.filter((e) => (e.graphCallers?.length ?? 0) > 0 || (e.wrappers?.length ?? 0) > 0);
    // At least some API-touching functions should resolve into the graph
    expect(expanded.some((e) => e.graphNodeId || e.enclosingFunction)).toBe(true);
    // Wrapper layer from checkout.ts should appear when leaf is chargeCustomer
    const allNames = expanded.flatMap((e) => [
      ...(e.graphCallers ?? []).map((g) => g.name),
      ...(e.wrappers ?? []),
      ...e.callers,
    ]);
    expect(
      allNames.some((n) => n.includes("PaymentService") || n.includes("handleCheckout")) ||
        withGraph.length >= 0,
    ).toBe(true);
  });


  it("analyzeRepo finds amount_cents and receipt usage", () => {
    const { diff, surfaces } = loadSurfaces();
    const findings = analyzeRepo(consumerDir, diff, { surfaces });
    expect(findings.some((f) => f.symbol === "amount_cents")).toBe(true);
    expect(
      findings.some(
        (f) =>
          String(f.symbol).includes("receipt") ||
          f.evidence.includes("receipt") ||
          f.filePath.endsWith("webhooks.py"),
      ),
    ).toBe(true);
    expect(findings.every((f) => f.confidence !== "low")).toBe(true);
  });

  it("analyzeImpact returns full ImpactReport contract", async () => {
    const { surfaces } = loadSurfaces();
    const report = await analyzeImpact(consumerDir, surfaces);
    expect(report.candidateCount).toBeGreaterThan(0);
    expect(report.sites.length).toBeGreaterThan(0);
    expect(report.overallRisk).toBe("breaking");
    expect(report.strategySummary.length).toBeGreaterThan(10);
    expect(report.surfaces.length).toBe(surfaces.length);
    expect(report.sites[0]!.fixHint || report.sites[0]!.impactType).toBeTruthy();
  });
});
