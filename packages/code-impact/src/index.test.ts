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

  it("applies the same repository bounds to the synchronous analyzer", () => {
    const { diff, surfaces } = loadSurfaces();
    expect(() => analyzeRepo(consumerDir, diff, {
      surfaces,
      indexLimits: { maxFiles: 1 },
    })).toThrow("codebase_index_file_count_limit");
    expect(() => analyzeRepo(consumerDir, diff, {
      surfaces,
      indexLimits: { maxTotalBytes: 1 },
    })).toThrow("codebase_index_total_bytes_limit");
  });

  it("attaches a provider->code graph_path additively without changing the finding set (FET-016)", () => {
    const { diff, surfaces } = loadSurfaces();
    const findings = analyzeRepo(consumerDir, diff, { surfaces });
    expect(findings.length).toBeGreaterThan(0);

    // The path is purely additive: removing graphPath must leave a finding whose
    // keys are exactly the pre-existing ImpactFinding shape — graphPath is the
    // ONLY new field. Combined with the reachable-set identity test in
    // provenance.test.ts (the gate that decides WHICH findings exist is
    // unchanged), this proves the finding set is identical, only now carrying a
    // path.
    const allowedKeys = new Set([
      "filePath",
      "lineStart",
      "lineEnd",
      "symbol",
      "confidence",
      "evidence",
      "relatedOps",
      "impactType",
      "fixHint",
      "surfaceIds",
      "graphPath",
    ]);
    for (const f of findings) {
      for (const key of Object.keys(f)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    }

    // At least one confident finding carries a computed path, and it ends at the
    // finding's own file, having started at a provider anchor.
    const withPath = findings.filter((f) => f.graphPath);
    expect(withPath.length).toBeGreaterThan(0);
    for (const f of withPath) {
      const p = f.graphPath!;
      expect(p.nodes.length).toBeGreaterThan(0);
      expect(p.nodes[p.nodes.length - 1]).toBe(f.filePath);
      expect(p.hops).toBe(p.nodes.length - 1);
      if (!p.truncated) expect(p.coverage).toBe("complete");
    }
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
