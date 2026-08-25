import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  loadChangeImpactCoverage,
  lookupChangeImpactAudit,
  recordAudit,
  type AppDb,
} from "./index.js";
import { summarizeChangeImpactCoverage } from "./change-impact-coverage.js";

const NOW = "2026-08-25T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    try {
      db.raw.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function openDb(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-change-impact-audit-"));
  const db = createDb(join(dir, "app.sqlite"));
  opened.push({ db, dir });
  return db;
}

function openPreProjectionDb(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-change-impact-audit-upgrade-"));
  const path = join(dir, "app.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      event_sequence INTEGER,
      schema_version INTEGER NOT NULL DEFAULT 1,
      prev_hash TEXT,
      event_hash TEXT,
      metadata_sha256 TEXT,
      actor TEXT NOT NULL,
      principal_id TEXT,
      api_key_id TEXT,
      request_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO audit_events (
      id, tenant_id, event_sequence, schema_version, event_hash, metadata_sha256,
      actor, action, resource_type, resource_id, metadata_json, created_at
    ) VALUES (
      'legacy-raw', 'tenant-a', 1, 1, 'legacy-hash', 'legacy-metadata-hash',
      'pipeline', 'impact.analyzed', 'consumer', 'consumer-a',
      '{"changeId":"chg-legacy","fallback":"raw_retrieval"}',
      '2026-08-24T00:00:00.000Z'
    );
    INSERT INTO audit_events (
      id, tenant_id, event_sequence, schema_version, event_hash, metadata_sha256,
      actor, action, resource_type, resource_id, metadata_json, created_at
    ) VALUES (
      'legacy-malformed', 'tenant-a', 2, 1, 'legacy-hash-2', 'legacy-metadata-hash-2',
      'pipeline', 'impact.analyzed', 'consumer', 'consumer-b', 'not-json',
      '2026-08-24T00:01:00.000Z'
    );
  `);
  legacy.close();
  const db = createDb(path);
  opened.push({ db, dir });
  return db;
}

function stamp(
  db: AppDb,
  input: {
    id?: string;
    tenantId: string;
    changeId: string;
    fallback?: "raw_retrieval";
    action?: string;
  },
) {
  recordAudit(db, {
    id: input.id,
    tenantId: input.tenantId,
    actor: "pipeline",
    action: input.action ?? "impact.analyzed",
    resourceType: "consumer",
    resourceId: `consumer-${input.tenantId}`,
    metadata: {
      changeId: input.changeId,
      findings: 0,
      ...(input.fallback ? { fallback: input.fallback } : {}),
    },
  });
}

describe("lookupChangeImpactAudit", () => {
  it("returns raw_retrieval when the tenant's impact.analyzed event is stamped", () => {
    const db = openDb();
    stamp(db, { tenantId: "tenant-a", changeId: "chg-1", fallback: "raw_retrieval" });
    expect(lookupChangeImpactAudit(db, "tenant-a", "chg-1")).toEqual({
      fallback: "raw_retrieval",
    });
  });

  it("returns null for an unlabeled graph-authoritative impact.analyzed event", () => {
    const db = openDb();
    stamp(db, { tenantId: "tenant-a", changeId: "chg-1" });
    expect(lookupChangeImpactAudit(db, "tenant-a", "chg-1")).toEqual({ fallback: null });
  });

  it("returns null when no impact.analyzed event exists for the change", () => {
    const db = openDb();
    stamp(db, { tenantId: "tenant-a", changeId: "chg-other", fallback: "raw_retrieval" });
    expect(lookupChangeImpactAudit(db, "tenant-a", "chg-1")).toEqual({ fallback: null });
  });

  it("ignores non-impact.analyzed actions even when metadata carries changeId", () => {
    const db = openDb();
    stamp(db, {
      tenantId: "tenant-a",
      changeId: "chg-1",
      fallback: "raw_retrieval",
      action: "graph.software_version_published",
    });
    expect(lookupChangeImpactAudit(db, "tenant-a", "chg-1")).toEqual({ fallback: null });
  });

  it("uses the latest analysis for each consumer when graph analysis becomes current", () => {
    const db = openDb();
    stamp(db, {
      id: "audit-raw",
      tenantId: "tenant-a",
      changeId: "chg-1",
      fallback: "raw_retrieval",
    });
    stamp(db, { id: "audit-graph", tenantId: "tenant-a", changeId: "chg-1" });
    expect(lookupChangeImpactAudit(db, "tenant-a", "chg-1")).toEqual({
      fallback: null,
    });
  });

  it("uses the latest analysis for each consumer when raw retrieval becomes current", () => {
    const db = openDb();
    stamp(db, { id: "audit-graph", tenantId: "tenant-a", changeId: "chg-1" });
    stamp(db, {
      id: "audit-raw",
      tenantId: "tenant-a",
      changeId: "chg-1",
      fallback: "raw_retrieval",
    });
    expect(lookupChangeImpactAudit(db, "tenant-a", "chg-1")).toEqual({
      fallback: "raw_retrieval",
    });
  });

  it("does not leak another tenant's stamp for the same shared change id", () => {
    const db = openDb();
    stamp(db, { tenantId: "tenant-a", changeId: "chg-shared", fallback: "raw_retrieval" });
    stamp(db, { tenantId: "tenant-b", changeId: "chg-shared" });
    expect(lookupChangeImpactAudit(db, "tenant-a", "chg-shared")).toEqual({
      fallback: "raw_retrieval",
    });
    expect(lookupChangeImpactAudit(db, "tenant-b", "chg-shared")).toEqual({
      fallback: null,
    });
  });

  it("refuses a blank or missing tenant rather than scanning globally", () => {
    const db = openDb();
    stamp(db, { tenantId: "tenant-a", changeId: "chg-1", fallback: "raw_retrieval" });
    expect(() => lookupChangeImpactAudit(db, "", "chg-1")).toThrow("tenant_scope_required");
    expect(() => lookupChangeImpactAudit(db, "   ", "chg-1")).toThrow("tenant_scope_required");
    expect(() =>
      lookupChangeImpactAudit(db, undefined as unknown as string, "chg-1"),
    ).toThrow("tenant_scope_required");
  });

  it("refuses a blank change id", () => {
    const db = openDb();
    expect(() => lookupChangeImpactAudit(db, "tenant-a", "")).toThrow("change_id_required");
  });

  it("treats an unrecognised fallback value as unlabeled", () => {
    const db = openDb();
    recordAudit(db, {
      tenantId: "tenant-a",
      actor: "pipeline",
      action: "impact.analyzed",
      resourceType: "consumer",
      resourceId: "consumer-a",
      metadata: { changeId: "chg-1", fallback: "invented" },
    });
    expect(lookupChangeImpactAudit(db, "tenant-a", "chg-1")).toEqual({ fallback: null });
  });

  it("creates normalized indexed projections for the bounded current-analysis lookup", () => {
    const db = openDb();
    const columns = db.raw
      .prepare(`PRAGMA table_xinfo(audit_events)`)
      .all() as Array<{ name: string }>;
    const indexes = db.raw
      .prepare(`PRAGMA index_list(audit_events)`)
      .all() as Array<{ name: string }>;
    expect(columns.map((row) => row.name)).toEqual(
      expect.arrayContaining(["impact_change_id", "impact_fallback"]),
    );
    expect(indexes.map((row) => row.name)).toContain(
      "audit_events_impact_current_idx",
    );
  });

  it("upgrades a pre-projection audit ledger without rewriting historical metadata", () => {
    const db = openPreProjectionDb();
    const historical = db.raw
      .prepare(
        `SELECT metadata_json AS metadataJson,
                impact_change_id AS changeId,
                impact_fallback AS fallback
         FROM audit_events WHERE id = 'legacy-raw'`,
      )
      .get() as { metadataJson: string; changeId: string; fallback: string };

    expect(historical).toEqual({
      metadataJson: '{"changeId":"chg-legacy","fallback":"raw_retrieval"}',
      changeId: "chg-legacy",
      fallback: "raw_retrieval",
    });
    expect(lookupChangeImpactAudit(db, "tenant-a", "chg-legacy")).toEqual({
      fallback: "raw_retrieval",
    });
    expect(
      db.raw
        .prepare(
          `SELECT impact_change_id AS changeId, impact_fallback AS fallback
           FROM audit_events WHERE id = 'legacy-malformed'`,
        )
        .get(),
    ).toEqual({ changeId: null, fallback: null });
  });

  it("keeps lookup work scoped to the requested change in a large tenant ledger", () => {
    const db = openDb();
    for (let index = 0; index < 500; index += 1) {
      stamp(db, {
        id: `irrelevant-${index}`,
        tenantId: "tenant-a",
        changeId: `chg-other-${index}`,
        fallback: "raw_retrieval",
      });
    }
    stamp(db, {
      id: "target-raw",
      tenantId: "tenant-a",
      changeId: "chg-target",
      fallback: "raw_retrieval",
    });
    stamp(db, {
      id: "target-graph",
      tenantId: "tenant-a",
      changeId: "chg-target",
    });

    expect(lookupChangeImpactAudit(db, "tenant-a", "chg-target")).toEqual({
      fallback: null,
    });

    const plan = db.raw
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT 1
         FROM audit_events AS current
         WHERE current.tenant_id = ?
           AND current.action = 'impact.analyzed'
           AND current.impact_change_id = ?
           AND current.impact_fallback = 'raw_retrieval'
           AND NOT EXISTS (
             SELECT 1
             FROM audit_events AS later
             WHERE later.tenant_id = current.tenant_id
               AND later.action = current.action
               AND later.impact_change_id = current.impact_change_id
               AND later.resource_type = current.resource_type
               AND later.resource_id IS current.resource_id
               AND later.event_sequence > current.event_sequence
           )
         LIMIT 1`,
      )
      .all("tenant-a", "chg-target") as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "audit_events_impact_current_idx",
    );
  });
});

describe("loadChangeImpactCoverage", () => {
  it("does not rewrite FET-017 no_impact when a raw_retrieval stamp is present", () => {
    const db = openDb();
    stamp(db, { tenantId: "tenant-a", changeId: "chg-1", fallback: "raw_retrieval" });
    const input = {
      findingCount: 0,
      prs: [{ coverage: { basis: "analyzed" as const } }],
    };
    const coverage = summarizeChangeImpactCoverage(input);
    expect(coverage.impact).toBe("no_impact");
    expect(
      loadChangeImpactCoverage(db, "tenant-a", "chg-1", input),
    ).toEqual({
      ...coverage,
      fallback: "raw_retrieval",
    });
  });

  it("keeps impact when findings exist and still reports the fallback stamp", () => {
    const db = openDb();
    stamp(db, { tenantId: "tenant-a", changeId: "chg-1", fallback: "raw_retrieval" });
    const composed = loadChangeImpactCoverage(db, "tenant-a", "chg-1", {
      findingCount: 2,
      prs: [{ coverage: { basis: "analyzed" } }],
    });
    expect(composed.impact).toBe("impact");
    expect(composed.fallback).toBe("raw_retrieval");
  });
});
