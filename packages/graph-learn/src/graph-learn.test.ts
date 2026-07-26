import { describe, expect, it } from "vitest";
import {
  ingestControlPlane,
  ingestSpecDiff,
  labelPrOutcome,
  openGraphLearnMemory,
  runGraphQuery,
  formatQueryForPlanner,
  runGraphBenchmark,
} from "./index.js";
import type { StructuralDiff, ImpactableSurface } from "@mendpoint/shared";

describe("graph-learn substrate", () => {
  it("ingests control plane and answers who_consumes_provider", () => {
    const db = openGraphLearnMemory();
    ingestControlPlane(db, {
      provider: { id: "p1", slug: "acme", name: "Acme" },
      consumers: [
        { id: "c1", name: "Shop", githubOwner: "o", githubRepo: "shop" },
        { id: "c2", name: "Bill", githubOwner: "o", githubRepo: "bill" },
      ],
      monitors: [
        { consumerId: "c1", providerId: "p1" },
        { consumerId: "c2", providerId: "p1" },
      ],
    });
    const r = runGraphQuery(db, { op: "who_consumes_provider", providerSlug: "acme" });
    expect(r.rows?.length).toBe(2);
    expect(formatQueryForPlanner(r)).toContain("Graph-RAG");
  });

  it("ingests spec surfaces and blast radius", () => {
    const db = openGraphLearnMemory();
    const diff: StructuralDiff = {
      risk: "breaking",
      summary: "rename amount_cents",
      entries: [],
    };
    const surfaces: ImpactableSurface[] = [
      {
        id: "s1",
        canonicalId: "POST /v1/charges.request.amount_cents",
        kind: "request_field",
        op: "request_field_renamed",
        path: "/v1/charges",
        method: "post",
        field: "amount_cents",
        fromField: "amount_cents",
        toField: "amount",
        severity: "breaking",
        migrationStrategy: "rename field",
        explanation: "amount_cents -> amount",
        searchTokens: ["amount_cents", "charges"],
      },
    ];
    ingestSpecDiff(db, {
      providerSlug: "acme",
      changeId: "ch1",
      diff,
      surfaces,
    });
    const br = runGraphQuery(db, {
      op: "blast_radius",
      nodeId: "change:ch1",
      maxHops: 2,
    });
    expect(br.nodes.length).toBeGreaterThan(1);
  });

  it("labels PR outcomes for learning", () => {
    const db = openGraphLearnMemory();
    ingestControlPlane(db, {
      provider: { id: "p1", slug: "acme", name: "Acme" },
      consumers: [{ id: "c1", name: "Shop", githubOwner: "o", githubRepo: "s" }],
      monitors: [{ consumerId: "c1", providerId: "p1" }],
    });
    labelPrOutcome(db, {
      prId: "pr1",
      changeId: "ch1",
      consumerId: "c1",
      outcome: "merged",
      title: "fix amount",
    });
    const r = runGraphQuery(db, { op: "outcomes_for_pattern", pattern: "amount" });
    expect(r.summary).toMatch(/outcome/i);
  });

  it("benchmark pack hits ≥18/20", () => {
    const b = runGraphBenchmark();
    expect(b.total).toBe(20);
    expect(b.passed).toBeGreaterThanOrEqual(18);
  });
});
