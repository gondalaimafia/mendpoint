// PR #712 re-review S1/B1: the enforcement-off delivery-replay finalization sweep
// (listUnfinalizedDeadLetteredReplayFallbacks) and the open-hold predicate it shares with
// listOpenReplayRunReservationIds.
//   - S1: OPEN_HOLD_PREDICATE aggregates on reservation_id ALONE, so the correlated
//     subquery seeks usage_ledger_reservation_idx instead of scanning the tenant's whole
//     ledger once per replay reservation (2.1 s -> ms at 40k rows). Asserted by
//     EXPLAIN QUERY PLAN over the exact exported predicate, so reverting it to the
//     `hold.id = r.id OR hold.reservation_id = r.id` form (which cannot use that index)
//     turns this red.
//   - B1: the second (generation-marker) branch lists a dead-lettered fallback that never
//     held a reservation (enforcement off, the production default) when the row is
//     undelivered, unstamped and on the fallback's own generation; a legacy payload with
//     no replayGeneration is left to the open-hold branch; a stamped or delivered row is
//     excluded.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb, OPEN_HOLD_PREDICATE, insertTenant, insertProvider, insertApiChange,
  insertConsumer, insertConsumerRepo, insertMigrationPr, enqueueOrResetJob,
  listUnfinalizedDeadLetteredReplayFallbacks, type AppDb,
} from "./index.js";
import { nowIso } from "@mendpoint/shared";

const dbs: AppDb[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function newDb(tag: string): AppDb {
  const dir = mkdtempSync(join(tmpdir(), `mp712-sweep-${tag}-`));
  dirs.push(dir);
  const db = createDb(join(dir, "db.sqlite"));
  dbs.push(db);
  return db;
}

const ORIGIN = JSON.stringify({ providerSlug: "acme-r", securityScanAttested: true });

function seed(db: AppDb, tenant = "tenant-a", suffix = "r"): void {
  insertTenant(db, { id: tenant, slug: tenant, name: tenant, createdAt: nowIso() });
  db.raw.exec("PRAGMA foreign_keys = OFF");
  insertProvider(db, { id: `prov-${suffix}`, slug: `acme-${suffix}`, name: "Acme", website: null, createdAt: nowIso() });
  insertApiChange(db, { id: `chg-${suffix}`, providerId: `prov-${suffix}`, fromVersionId: "va", toVersionId: "vb", risk: "breaking", summary: "s", diffJson: "{}", createdAt: nowIso() });
  insertConsumer(db, { id: `con-${suffix}`, name: "Shop", githubOwner: "org", githubRepo: `shop-${suffix}`, installationId: null, tenantId: tenant, createdAt: nowIso() });
  insertConsumerRepo(db, { id: `repo-${suffix}`, consumerId: `con-${suffix}`, localPath: join(tmpdir(), `seed-${suffix}`), defaultBranch: "main", createdAt: nowIso() });
  insertMigrationPr(db, {
    id: `pr-${suffix}`, changeId: `chg-${suffix}`, consumerId: `con-${suffix}`, title: "t", body: "b",
    branchName: `mendpoint/${suffix}`, status: "delivery_failed", risk: "low", patchUnified: "d",
    createdAt: nowIso(), originFanoutJson: ORIGIN,
  });
  db.raw.exec("PRAGMA foreign_keys = ON");
}

// Insert a dead-lettered replay fallback for pr-<suffix> with the given payload generation
// (undefined => a pre-#712 payload with no replayGeneration key), holding NO reservation
// (enforcement off). Mirrors what the worker leaves after a lease-expiry dead-letter.
function deadFallback(db: AppDb, gen: number | undefined, tenant = "tenant-a", suffix = "r"): void {
  const payload: Record<string, unknown> = { consumerIds: [`con-${suffix}`] };
  if (gen !== undefined) payload.replayGeneration = gen;
  enqueueOrResetJob(db, { id: `pipeline-delivery-fallback:pr-${suffix}`, tenantId: tenant, type: "pipeline.fanout", payload, maxAttempts: 50, createdAt: nowIso() });
  db.raw.prepare("UPDATE jobs SET status = 'dead_letter', dead_at = ? WHERE id = ?").run(nowIso(), `pipeline-delivery-fallback:pr-${suffix}`);
}
const ids = (db: AppDb, tenant?: string) => listUnfinalizedDeadLetteredReplayFallbacks(db, tenant).map((j) => j.id);

describe("delivery-replay sweep — S1 open-hold predicate uses the reservation index", () => {
  it("EXPLAIN QUERY PLAN seeks usage_ledger_reservation_idx, never scans the ledger", () => {
    const db = newDb("s1");
    const sql =
      `SELECT r.id FROM usage_ledger_entries r
       WHERE r.tenant_id = ? AND r.entry_type = 'reservation' AND r.task_id LIKE ?
         AND ${OPEN_HOLD_PREDICATE}`;
    const plan = (db.raw.prepare("EXPLAIN QUERY PLAN " + sql).all("tenant-a", "delivery-replay:%") as Array<{ detail: string }>)
      .map((row) => row.detail)
      .join(" | ");
    // The correlated open-hold subquery must resolve through the reservation index. The
    // reverted `hold.id = r.id OR hold.reservation_id = r.id` form cannot (an OR across two
    // columns forces a scan), so this line dies with it.
    expect(plan).toContain("usage_ledger_reservation_idx");
    expect(plan).not.toMatch(/SCAN .*\bhold\b/);
  });
});

describe("delivery-replay sweep — B1 generation-marker branch (enforcement off)", () => {
  it("lists a no-hold dead-letter that is undelivered, unstamped, and on its own generation", () => {
    const db = newDb("b1"); seed(db);
    deadFallback(db, 0);
    expect(ids(db, "tenant-a")).toEqual(["pipeline-delivery-fallback:pr-r"]);
  });

  it("excludes a legacy payload with no replayGeneration (left to the open-hold branch, keeps U2 safe)", () => {
    const db = newDb("legacy"); seed(db);
    deadFallback(db, undefined);
    expect(ids(db, "tenant-a")).toEqual([]);
  });

  it("excludes a stale-generation fallback (payload gen below the row's generation)", () => {
    const db = newDb("stale"); seed(db);
    deadFallback(db, 0);
    db.raw.prepare("UPDATE migration_prs SET replay_generation = 3 WHERE id = 'pr-r'").run();
    expect(ids(db, "tenant-a")).toEqual([]);
  });

  it("excludes an already-stamped row", () => {
    const db = newDb("stamped"); seed(db);
    deadFallback(db, 0);
    db.raw.prepare("UPDATE migration_prs SET delivery_error = 'github_delivery_replay_failed' WHERE id = 'pr-r'").run();
    expect(ids(db, "tenant-a")).toEqual([]);
  });

  it("excludes a delivered row (github_pr_number recorded)", () => {
    const db = newDb("delivered"); seed(db);
    deadFallback(db, 0);
    db.raw.prepare("UPDATE migration_prs SET github_pr_number = 7 WHERE id = 'pr-r'").run();
    expect(ids(db, "tenant-a")).toEqual([]);
  });

  it("is tenant-scoped across both branches", () => {
    const db = newDb("tenant"); seed(db, "tenant-a", "r"); seed(db, "tenant-b", "s");
    deadFallback(db, 0, "tenant-a", "r");
    deadFallback(db, 0, "tenant-b", "s");
    expect(ids(db, "tenant-a")).toEqual(["pipeline-delivery-fallback:pr-r"]);
    expect(ids(db, "tenant-b")).toEqual(["pipeline-delivery-fallback:pr-s"]);
  });
});

describe("delivery-replay sweep — S-a partial index is used in GLOBAL mode", () => {
  it("EXPLAIN QUERY PLAN of the real global-mode sweep, after ANALYZE on a populated table, uses jobs_dead_letter_fanout_idx", () => {
    const db = newDb("global-index");
    // Populate the jobs table so ANALYZE has real statistics: many pipeline.fanout jobs, of
    // which a minority are dead_letter. Production drains ALL tenants (allTenants), the mode
    // where the planner otherwise prefers the full jobs_type_idx and scans every fanout job.
    db.raw.exec("BEGIN");
    const ins = db.raw.prepare("INSERT INTO jobs (id, tenant_id, type, payload_json, status, created_at) VALUES (?,?,?,?,?,?)");
    for (let i = 0; i < 4000; i++) {
      ins.run(`pipeline-delivery-fallback:pr-live-${i}`, "tenant-a", "pipeline.fanout", "{}", i < 300 ? "dead_letter" : "done", nowIso());
    }
    for (let i = 0; i < 1000; i++) ins.run(`pipeline.delivery-retry:pr-o-${i}`, "tenant-a", "pipeline.delivery-retry", "{}", "pending", nowIso());
    db.raw.exec("COMMIT");
    db.raw.exec("ANALYZE");

    // Capture the EXACT SQL the sweep prepares in GLOBAL mode (tenantId undefined), so this
    // asserts the real query's plan, not a copy. Removing INDEXED BY from the sweep makes
    // the captured SQL lose the pin and this turns red.
    const captured: string[] = [];
    const realPrepare = db.raw.prepare.bind(db.raw);
    db.raw.prepare = ((sql: string) => { captured.push(sql); return realPrepare(sql); }) as typeof db.raw.prepare;
    try {
      listUnfinalizedDeadLetteredReplayFallbacks(db); // global mode
    } finally {
      db.raw.prepare = realPrepare;
    }
    const genSql = captured.find((s) => s.includes("json_extract(j.payload_json"));
    expect(genSql, "captured the global-mode sweep SQL").toBeTruthy();
    expect(genSql!).toContain("INDEXED BY jobs_dead_letter_fanout_idx");

    // The generation branch of the UNION binds 4 params in global mode
    // (fallback prefix for `?||pr.id`, the replay task_id LIKE, the substr offset, the job-id
    // LIKE). EXPLAIN needs the right arity; the plan is independent of the bound values.
    const plan = (db.raw.prepare("EXPLAIN QUERY PLAN " + genSql!)
      .all("pipeline-delivery-fallback:", "delivery-replay:%", 28, "pipeline-delivery-fallback:%") as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join(" | ");
    expect(plan, plan).toContain("jobs_dead_letter_fanout_idx");
    expect(plan, "the pin must keep the planner off the full jobs_type_idx scan").not.toContain("USING INDEX jobs_type_idx");
  });
});
