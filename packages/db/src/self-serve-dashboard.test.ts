import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  insertConsumer,
  insertMonitoredApi,
  insertMigrationPr,
  insertAgentRun,
  recordDeveloperSatisfaction,
  computeSelfServeDashboard,
  exportSelfServeDashboardCsv,
  type AppDb,
} from "./index.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];
const TENANT = "tenant-dash";
const OTHER = "tenant-other";
const T0 = "2026-08-01T00:00:00.000Z";

afterEach(() => {
  for (const db of dbs.splice(0)) db.raw.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDb(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-dash-"));
  dirs.push(dir);
  const db = createDb(join(dir, "dash.sqlite"));
  dbs.push(db);
  // Seed against arbitrary parent ids without walking the full FK chain.
  db.raw.exec("PRAGMA foreign_keys = OFF");
  return db;
}

function seedConsumer(db: AppDb, id: string, tenantId: string) {
  insertConsumer(db, {
    id,
    name: id,
    githubOwner: "acme",
    githubRepo: id,
    tenantId,
    createdAt: T0,
  });
}

function seedRun(db: AppDb, id: string, tenantId: string, status: string, ok: boolean, createdAt = T0) {
  insertAgentRun(db, {
    id,
    tenantId,
    goal: "fix",
    repoPath: "/repo",
    status,
    ok,
    steps: 1,
    createdAt,
    finishedAt: createdAt,
  });
}

function seedPr(db: AppDb, id: string, consumerId: string, status: string, createdAt = T0) {
  insertMigrationPr(db, {
    id,
    changeId: "chg",
    consumerId,
    title: id,
    body: "b",
    branchName: id,
    status,
    risk: "breaking",
    patchUnified: "",
    createdAt,
  });
}

function seedAudit(db: AppDb, id: string, tenantId: string, action: string, principalId: string | null, createdAt = T0) {
  db.raw
    .prepare(
      `INSERT INTO audit_events (id, tenant_id, schema_version, actor, principal_id, action, resource_type, created_at)
       VALUES (?, ?, 1, 'api', ?, ?, 'run', ?)`,
    )
    .run(id, tenantId, principalId, action, createdAt);
}

function seedJob(db: AppDb, id: string, tenantId: string, attempts: number, createdAt = T0) {
  db.raw
    .prepare(
      `INSERT INTO jobs (id, tenant_id, type, payload_json, status, attempts, created_at)
       VALUES (?, ?, 'agent.run', '{}', 'done', ?, ?)`,
    )
    .run(id, tenantId, attempts, createdAt);
}

function seedMeter(
  db: AppDb,
  runId: string,
  tenantId: string,
  costUsd: number | null,
  createdAt = T0,
) {
  db.raw
    .prepare(
      `INSERT INTO agent_run_meters
        (tenant_id, run_id, outcome, created_at, cost_usd, cost_measured, metered_at)
       VALUES (?, ?, 'candidate_ready', ?, ?, ?, ?)`,
    )
    .run(tenantId, runId, createdAt, costUsd, costUsd === null ? 0 : 1, createdAt);
}

function seedTenant(db: AppDb, tenantId: string) {
  seedConsumer(db, `${tenantId}-c1`, tenantId);
  seedConsumer(db, `${tenantId}-c2`, tenantId);
  insertMonitoredApi(db, { id: `${tenantId}-m1`, consumerId: `${tenantId}-c1`, providerId: "stripe" });
  insertMonitoredApi(db, { id: `${tenantId}-m2`, consumerId: `${tenantId}-c2`, providerId: "plaid" });
  insertMonitoredApi(db, { id: `${tenantId}-m3`, consumerId: `${tenantId}-c2`, providerId: "stripe" });

  seedPr(db, `${tenantId}-pr1`, `${tenantId}-c1`, "merged");
  seedPr(db, `${tenantId}-pr2`, `${tenantId}-c1`, "closed");
  seedPr(db, `${tenantId}-pr3`, `${tenantId}-c2`, "open");

  seedRun(db, `${tenantId}-r1`, tenantId, "candidate_approved", true);
  seedRun(db, `${tenantId}-r2`, tenantId, "candidate_rejected", false);
  seedRun(db, `${tenantId}-r3`, tenantId, "candidate_ready", true);
  seedRun(db, `${tenantId}-r4`, tenantId, "failed", false);
  seedRun(db, `${tenantId}-r5`, tenantId, "no_action", false);

  seedAudit(db, `${tenantId}-a1`, tenantId, "warden.pilot.abstained", "user-1");
  seedAudit(db, `${tenantId}-a2`, tenantId, "pr.opened.real", "user-1");
  seedAudit(db, `${tenantId}-a3`, tenantId, "run.started", "user-2");

  seedJob(db, `${tenantId}-j1`, tenantId, 1);
  seedJob(db, `${tenantId}-j2`, tenantId, 3); // retried

  seedMeter(db, `${tenantId}-r1`, tenantId, 0.05);
  seedMeter(db, `${tenantId}-r3`, tenantId, 0.15);
  seedMeter(db, `${tenantId}-r4`, tenantId, null); // unmeasured

  recordDeveloperSatisfaction(db, { id: `${tenantId}-s1`, tenantId, rating: 5, createdAt: T0 });
  recordDeveloperSatisfaction(db, { id: `${tenantId}-s2`, tenantId, rating: 3, createdAt: T0 });
}

describe("computeSelfServeDashboard", () => {
  it("computes real tenant-scoped numbers across every dimension", () => {
    const db = freshDb();
    seedTenant(db, TENANT);
    const d = computeSelfServeDashboard(db, { tenantId: TENANT });

    // Adoption
    expect(d.adoption.reposConnected).toBe(2);
    expect(d.adoption.providersMonitored).toBe(2); // stripe, plaid (distinct)
    expect(d.adoption.monitoredApis).toBe(3);
    expect(d.adoption.totalRuns).toBe(5);
    expect(d.adoption.activeUsers).toBe(2); // user-1, user-2
    expect(d.adoption.teams.basis).toBe("unavailable");

    // Outcomes
    expect(d.outcomes.prsOpened).toBe(3);
    expect(d.outcomes.prsMerged).toBe(1);
    expect(d.outcomes.prsClosed).toBe(1);
    expect(d.outcomes.prsOpen).toBe(1);
    expect(d.outcomes.mergeRate.value).toBeCloseTo(0.5, 10);
    expect(d.outcomes.candidatesApproved).toBe(1);
    expect(d.outcomes.candidatesRejected).toBe(1);
    expect(d.outcomes.candidateApprovalRate.value).toBeCloseTo(0.5, 10);
    expect(d.outcomes.abstainedRuns).toBe(1);
    expect(d.outcomes.outOfScopeRuns).toBe(1);

    // Reliability
    expect(d.reliability.runsSucceeded).toBe(2); // r1, r3 ok=1
    expect(d.reliability.runsFailed).toBe(1); // r4 failed
    expect(d.reliability.runSuccessRate.value).toBeCloseTo(2 / 3, 10);
    expect(d.reliability.retries).toBe(1); // j2 attempts>1
    expect(d.reliability.verificationPassRate.basis).toBe("unavailable");
    expect(d.reliability.introducedVsPreexistingFailures.basis).toBe("unavailable");

    // Cost — measured USD over the 2 metered-with-cost runs; unmeasured excluded, not zeroed.
    expect(d.cost.measuredUsd.totalUsd).toBeCloseTo(0.2, 10);
    expect(d.cost.measuredUsd.measuredRuns).toBe(2);
    expect(d.cost.measuredUsd.totalRuns).toBe(3);
    expect(d.cost.measuredUsd.perRunUsd).toBeCloseTo(0.1, 10);
    expect(d.cost.measuredUsd.note).toBeDefined();
    // No entitlement provisioned → MCU honestly unavailable, never a zero.
    expect(d.cost.mcu.basis).toBe("unavailable");

    // Satisfaction from real submitted rows.
    expect(d.developerSatisfaction.basis).toBe("measured");
    expect(d.developerSatisfaction.responses).toBe(2);
    expect(d.developerSatisfaction.averageRating).toBeCloseTo(4, 10);

    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.keys(d.provenance).length).toBeGreaterThan(0);
  });

  it("never leaks another tenant's data", () => {
    const db = freshDb();
    seedTenant(db, TENANT);
    seedTenant(db, OTHER);

    const d = computeSelfServeDashboard(db, { tenantId: TENANT });
    // Identical seed per tenant, so scoped numbers must match the single-tenant case,
    // not double. If any query dropped its tenant filter these would inflate.
    expect(d.adoption.reposConnected).toBe(2);
    expect(d.adoption.monitoredApis).toBe(3);
    expect(d.adoption.totalRuns).toBe(5);
    expect(d.outcomes.prsOpened).toBe(3);
    expect(d.reliability.retries).toBe(1);
    expect(d.cost.measuredUsd.measuredRuns).toBe(2);
    expect(d.developerSatisfaction.responses).toBe(2);
  });

  it("reports honest nulls (not zeros) for a tenant with no data", () => {
    const db = freshDb();
    const d = computeSelfServeDashboard(db, { tenantId: "empty" });
    expect(d.adoption.reposConnected).toBe(0);
    expect(d.adoption.totalRuns).toBe(0);
    expect(d.outcomes.mergeRate.value).toBeNull();
    expect(d.outcomes.mergeRate.reason).toContain("no resolved PRs");
    expect(d.reliability.runSuccessRate.value).toBeNull();
    expect(d.cost.measuredUsd.totalUsd).toBeNull();
    expect(d.cost.measuredUsd.reason).toContain("no metered runs");
    expect(d.cost.mcu.basis).toBe("unavailable");
    expect(d.developerSatisfaction.basis).toBe("unavailable");
  });

  it("honors the time window and rejects an invalid one", () => {
    const db = freshDb();
    seedConsumer(db, "c1", TENANT);
    seedRun(db, "old", TENANT, "candidate_approved", true, "2026-08-01T00:00:00.000Z");
    seedRun(db, "new", TENANT, "candidate_approved", true, "2026-08-10T00:00:00.000Z");

    const all = computeSelfServeDashboard(db, { tenantId: TENANT });
    expect(all.adoption.totalRuns).toBe(2);

    const windowed = computeSelfServeDashboard(db, { tenantId: TENANT, since: "2026-08-05T00:00:00.000Z" });
    expect(windowed.adoption.totalRuns).toBe(1);

    expect(() =>
      computeSelfServeDashboard(db, {
        tenantId: TENANT,
        since: "2026-08-10T00:00:00.000Z",
        until: "2026-08-01T00:00:00.000Z",
      }),
    ).toThrow("dashboard_window_invalid");
  });

  it("exports a provenance-annotated CSV whose values match the API object", () => {
    const db = freshDb();
    seedTenant(db, TENANT);
    const d = computeSelfServeDashboard(db, { tenantId: TENANT });
    const csv = exportSelfServeDashboardCsv(d);

    const lines = csv.split("\n");
    expect(lines[0]).toBe("dimension,metric,value,basis,source");
    const cells = new Map<string, { value: string; basis: string; source: string }>();
    for (const line of lines.slice(1)) {
      const parts = line.match(/"((?:[^"]|"")*)"/g)!.map((c) => c.slice(1, -1).replace(/""/g, '"'));
      cells.set(`${parts[0]}.${parts[1]}`, { value: parts[2]!, basis: parts[3]!, source: parts[4]! });
    }

    expect(cells.get("adoption.reposConnected")!.value).toBe("2");
    expect(cells.get("adoption.reposConnected")!.source).toContain("consumers");
    expect(cells.get("outcomes.mergeRate")!.value).toBe("0.5");
    expect(cells.get("cost.measuredTotalUsd")!.value).toBe(String(d.cost.measuredUsd.totalUsd));
    // Unavailable dimensions render empty value with their basis, never a fabricated number.
    expect(cells.get("cost.mcuConsumedMicros")!.value).toBe("");
    expect(cells.get("cost.mcuConsumedMicros")!.basis).toBe("unavailable");
    expect(cells.get("reliability.verificationPassRate")!.basis).toBe("unavailable");
    expect(cells.get("developerSatisfaction.averageRating")!.value).toBe(String(d.developerSatisfaction.averageRating));
  });
});
