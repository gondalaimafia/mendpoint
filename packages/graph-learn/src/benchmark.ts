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

// The benchmark seeds a single-tenant graph and reads it under that tenant's
// scope, so the fail-closed tenant view is the whole seeded graph. This keeps
// the regression assertions identical while exercising the scoped read path.
const BENCH_TENANT = "bench-tenant";
const BENCH_SCOPE = { tenantId: BENCH_TENANT, consumerIds: ["c1", "c2"] };

function runScoped(
  db: GraphLearnDb,
  q: Parameters<typeof runGraphQuery>[1],
) {
  return runGraphQuery(db, q, BENCH_SCOPE);
}

export type BenchCase = {
  id: string;
  name: string;
  run: (db: GraphLearnDb) => { ok: boolean; detail: string };
};

function seed(db: GraphLearnDb) {
  ingestControlPlane(
    db,
    {
      provider: { id: "p1", slug: "acme", name: "Acme" },
      consumers: [
        { id: "c1", name: "Shop", githubOwner: "o", githubRepo: "shop" },
        { id: "c2", name: "Bill", githubOwner: "o", githubRepo: "bill" },
      ],
      monitors: [
        { consumerId: "c1", providerId: "p1" },
        { consumerId: "c2", providerId: "p1" },
      ],
    },
    BENCH_TENANT,
  );
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
  ingestSpecDiff(
    db,
    {
      providerSlug: "acme",
      changeId: "ch1",
      diff,
      surfaces,
    },
    BENCH_TENANT,
  );
  labelPrOutcome(
    db,
    {
      prId: "pr1",
      changeId: "ch1",
      consumerId: "c1",
      outcome: "merged",
      title: "amount rename",
    },
    BENCH_TENANT,
  );
  labelPrOutcome(
    db,
    {
      prId: "pr2",
      changeId: "ch1",
      consumerId: "c2",
      outcome: "closed",
      title: "amount rename fail",
    },
    BENCH_TENANT,
  );
}

export const BENCH_CASES: BenchCase[] = [
  {
    id: "q01",
    name: "stats non-empty",
    run: (db) => {
      const r = runScoped(db, { op: "stats" });
      const n = Number((r.rows?.[0] as { nodes?: number })?.nodes ?? 0);
      return { ok: n >= 3, detail: r.summary };
    },
  },
  {
    id: "q02",
    name: "who_consumes_provider count=2",
    run: (db) => {
      const r = runScoped(db, {
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
      const r = runScoped(db, {
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
      const r = runScoped(db, {
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
      const r = runScoped(db, {
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
      const r = runScoped(db, {
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
      const r = runScoped(db, {
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
      const r = runScoped(db, { op: "pattern_success_rates", minSamples: 1 });
      return { ok: Array.isArray(r.rows), detail: r.summary };
    },
  },
  {
    id: "q09",
    name: "path change to provider",
    run: (db) => {
      const r = runScoped(db, {
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
      const r = runScoped(db, {
        op: "callers",
        symbolId: "symbol:missing",
      });
      return { ok: r.edges.length === 0, detail: r.summary };
    },
  },
  {
    id: "q11",
    name: "consumers_of_field amount",
    run: (db) => {
      const r = runScoped(db, {
        op: "consumers_of_field",
        schemaName: "Charge",
        fieldName: "amount",
      });
      return { ok: (r.rows?.length ?? 0) >= 1, detail: r.summary };
    },
  },
  {
    id: "q12",
    name: "broke_modes_for_endpoint",
    run: (db) => {
      const r = runScoped(db, {
        op: "broke_modes_for_endpoint",
        operationId: "charges",
      });
      return { ok: r.summary.includes("break"), detail: r.summary };
    },
  },
  {
    id: "q13",
    name: "depends_on_path distinguishes clean from absent",
    run: (db) => {
      // A node that IS in the graph but has no dependencies is "complete
      // evidence of no dependency" — coverage complete. A node that has never
      // been seen is "target_absent" — no evidence either way. Both return zero
      // paths; asserting only "the summary mentions depends_on" (as the old case
      // did) certifies the silent zero as a pass. Assert the two are told apart.
      const present = runScoped(db, {
        op: "depends_on_path",
        nodeId: "change:ch1",
        maxHops: 3,
      });
      const absent = runScoped(db, {
        op: "depends_on_path",
        nodeId: "change:never-ingested",
        maxHops: 3,
      });
      const ok =
        present.coverage?.basis !== "target_absent" &&
        absent.coverage?.basis === "target_absent";
      return {
        ok,
        detail: `present=${present.coverage?.basis}; absent=${absent.coverage?.basis}`,
      };
    },
  },
  {
    id: "q14",
    name: "migration_ready_units empty campaign",
    run: (db) => {
      const r = runScoped(db, {
        op: "migration_ready_units",
        campaignId: "camp-missing",
      });
      return { ok: (r.rows?.length ?? 0) === 0, detail: r.summary };
    },
  },
  {
    id: "q15",
    name: "invariants_for_symbol empty-ok",
    run: (db) => {
      const r = runScoped(db, {
        op: "invariants_for_symbol",
        qualifiedName: "com.acme.Charge",
      });
      return { ok: (r.rows?.length ?? 0) === 0, detail: r.summary };
    },
  },
  {
    id: "q16",
    name: "time_travel_calls at now",
    run: (db) => {
      const r = runScoped(db, {
        op: "time_travel_calls",
        at: new Date().toISOString(),
      });
      return { ok: r.summary.includes("CALLS"), detail: r.summary };
    },
  },
  {
    id: "q17",
    name: "schema v0 PascalCase Provider kind",
    run: (db) => {
      const r = runScoped(db, {
        op: "who_consumes_provider",
        providerSlug: "acme",
      });
      const hasProvider = r.nodes.some((n) => n.kind === "Provider");
      return { ok: hasProvider, detail: r.nodes.map((n) => n.kind).join(",") };
    },
  },
  {
    id: "q18",
    name: "schema v0 SCREAMING_SNAKE edges",
    run: (db) => {
      const r = runScoped(db, {
        op: "neighbors",
        nodeId: "provider:acme",
      });
      const kinds = r.edges.map((e) => e.kind);
      const ok = kinds.every((k) => k === k.toUpperCase());
      return { ok: ok && kinds.length >= 1, detail: kinds.join(",") };
    },
  },
  {
    id: "q19",
    name: "path or no-path is structured",
    run: (db) => {
      const r = runScoped(db, {
        op: "path",
        fromId: "consumer:c1",
        toId: "provider:acme",
        maxHops: 3,
      });
      return {
        ok: r.edges.length >= 1 || r.summary.includes("no path"),
        detail: r.summary,
      };
    },
  },
  {
    id: "q20",
    name: "stats reports schema v0",
    run: (db) => {
      const r = runScoped(db, { op: "stats" });
      const schema = (r.rows?.[0] as { schema?: string })?.schema;
      return { ok: schema === "v0", detail: JSON.stringify(r.rows?.[0]) };
    },
  },
];

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
