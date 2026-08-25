import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("surfaces raw_retrieval if any matching consumer event is stamped", () => {
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

  it("creates the tenant+action audit index used by the targeted lookup", () => {
    const db = openDb();
    const indexes = db.raw
      .prepare(`PRAGMA index_list(audit_events)`)
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toContain(
      "audit_events_tenant_action_created_idx",
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
