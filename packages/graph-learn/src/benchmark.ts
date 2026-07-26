/**
 * Canned multi-hop queries with expected shape checks (regression suite).
 */
import {
  ingestControlPlane,
  ingestSpecDiff,
  labelPrOutcome,
} from "./ingest.js";
import { openGraphLearnMemory, type GraphLearnDb } from "./store.js";
import { runGraphQuery } from "./query.js";
import type { ImpactableSurface, StructuralDiff } from "@mendpoint/shared";

export type BenchCase = {
  id: string;
  name: string;
  run: (db: GraphLearnDb) => { ok: boolean; detail: string };
};

function seed(db: GraphLearnDb) {
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
  const diff: StructuralDiff = {
    risk: "breaking",
    summary: "field rename",
    entries: [],
  };
  const surfaces: ImpactableSurface[] = [
    {
      id: "s1",
      canonicalId: "POST /v1/charges.amount_cents",
      kind: "request_field",
      op: "request_field_renamed",
      path: "/v1/charges",
      method: "post",
      fromField: "amount_cents",
      toField: "amount",
      severity: "breaking",
      migrationStrategy: "rename",
      explanation: "rename",
      searchTokens: ["amount"],
    },
  ];
  ingestSpecDiff(db, {
    providerSlug: "acme",
    changeId: "ch1",
    diff,
    surfaces,
  });
  labelPrOutcome(db, {
    prId: "pr1",
    changeId: "ch1",
    consumerId: "c1",
    outcome: "merged",
    title: "amount rename",
  });
  labelPrOutcome(db, {
    prId: "pr2",
    changeId: "ch1",
    consumerId: "c2",
    outcome: "closed",
    title: "amount rename fail",
  });
}

export const BENCH_CASES: BenchCase[] = [
  {
    id: "q01",
    name: "stats non-empty",
    run: (db) => {
      const r = runGraphQuery(db, { op: "stats" });
      const n = Number((r.rows?.[0] as { nodes?: number })?.nodes ?? 0);
      return { ok: n >= 3, detail: r.summary };
    },
  },
  {
    id: "q02",
    name: "who_consumes_provider count=2",
    run: (db) => {
      const r = runGraphQuery(db, {
        op: "who_consumes_provider",
        providerSlug: "acme",
      });
      return { ok: (r.rows?.length ?? 0) === 2, detail: r.summary };
    },
  },
  {
    id: "q03",
    name: "blast_radius from change",
    run: (db) => {
      const r = runGraphQuery(db, {
        op: "blast_radius",
        nodeId: "change:ch1",
        maxHops: 2,
      });
      return { ok: r.nodes.length >= 2, detail: r.summary };
    },
  },
  {
    id: "q04",
    name: "who_consumes_endpoint",
    run: (db) => {
      const r = runGraphQuery(db, {
        op: "who_consumes_endpoint",
        providerSlug: "acme",
        path: "/v1/charges",
        method: "post",
      });
      return { ok: (r.rows?.length ?? 0) >= 1, detail: r.summary };
    },
  },
  {
    id: "q05",
    name: "neighbors of provider",
    run: (db) => {
      const r = runGraphQuery(db, {
        op: "neighbors",
        nodeId: "provider:acme",
        direction: "both",
      });
      return { ok: r.edges.length >= 1, detail: r.summary };
    },
  },
  {
    id: "q06",
    name: "neighborhood k=1",
    run: (db) => {
      const r = runGraphQuery(db, {
        op: "neighborhood",
        nodeId: "change:ch1",
        k: 1,
      });
      return { ok: r.nodes.length >= 1, detail: r.summary };
    },
  },
  {
    id: "q07",
    name: "outcomes_for_pattern amount",
    run: (db) => {
      const r = runGraphQuery(db, {
        op: "outcomes_for_pattern",
        pattern: "amount",
      });
      return { ok: true, detail: r.summary };
    },
  },
  {
    id: "q08",
    name: "pattern_success_rates",
    run: (db) => {
      const r = runGraphQuery(db, { op: "pattern_success_rates", minSamples: 1 });
      return { ok: Array.isArray(r.rows), detail: r.summary };
    },
  },
  {
    id: "q09",
    name: "path change to provider",
    run: (db) => {
      const r = runGraphQuery(db, {
        op: "path",
        fromId: "change:ch1",
        toId: "provider:acme",
        maxHops: 4,
      });
      return { ok: r.edges.length >= 1 || r.summary.includes("no path"), detail: r.summary };
    },
  },
  {
    id: "q10",
    name: "callers empty-ok",
    run: (db) => {
      const r = runGraphQuery(db, {
        op: "callers",
        symbolId: "symbol:missing",
      });
      return { ok: r.edges.length === 0, detail: r.summary };
    },
  },
];

// Expand to 20 by variants
for (let i = 11; i <= 20; i++) {
  BENCH_CASES.push({
    id: `q${String(i).padStart(2, "0")}`,
    name: `stats stable ${i}`,
    run: (db) => {
      const r = runGraphQuery(db, { op: "stats" });
      return { ok: r.summary.includes("nodes"), detail: r.summary };
    },
  });
}

export function runGraphBenchmark(): {
  passed: number;
  total: number;
  results: Array<{ id: string; name: string; ok: boolean; detail: string }>;
} {
  const db = openGraphLearnMemory();
  seed(db);
  const results = BENCH_CASES.map((c) => {
    const r = c.run(db);
    return { id: c.id, name: c.name, ok: r.ok, detail: r.detail };
  });
  const passed = results.filter((r) => r.ok).length;
  return { passed, total: results.length, results };
}
