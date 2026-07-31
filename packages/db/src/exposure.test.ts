import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  insertApiChange,
  insertApiVersion,
  insertConsumer,
  insertImpactFinding,
  insertMigrationPr,
  insertMonitoredApi,
  insertProvider,
} from "./index.js";
import { buildExposureReport } from "./exposure.js";
import { newId, nowIso } from "@mendpoint/shared";

const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];

afterEach(() => {
  while (dbs.length) {
    const db = dbs.pop();
    try {
      db?.raw.close?.();
    } catch {
      /* ignore */
    }
  }
  while (dirs.length) {
    const d = dirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore lock races on Windows */
      }
    }
  }
});

describe("buildExposureReport", () => {
  it("returns null for unknown consumer", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-exp-"));
    dirs.push(dir);
    const db = createDb(join(dir, "e.sqlite"));
    dbs.push(db);
    expect(buildExposureReport(db, "missing")).toBeNull();
  });

  it("builds json + markdown for seeded consumer", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-exp-"));
    dirs.push(dir);
    const db = createDb(join(dir, "e.sqlite"));
    dbs.push(db);
    const t0 = nowIso();

    const providerId = newId();
    insertProvider(db, {
      id: providerId,
      slug: "acme-payments",
      name: "Acme Payments",
      website: null,
      createdAt: t0,
    });

    const v1 = newId();
    const v2 = newId();
    insertApiVersion(db, {
      id: v1,
      providerId,
      versionLabel: "1.0.0",
      openapiJson: "{}",
      publishedAt: t0,
    });
    insertApiVersion(db, {
      id: v2,
      providerId,
      versionLabel: "2.0.0",
      openapiJson: "{\"openapi\":\"3.1.0\"}",
      publishedAt: t0,
    });

    const changeId = newId();
    insertApiChange(db, {
      id: changeId,
      providerId,
      fromVersionId: v1,
      toVersionId: v2,
      risk: "breaking",
      summary: "amount_cents renamed to amount",
      diffJson: "[]",
      createdAt: t0,
    });

    const consumerId = newId();
    insertConsumer(db, {
      id: consumerId,
      name: "Shop App",
      githubOwner: "acme",
      githubRepo: "shop",
      tenantId: "tenant_default",
      createdAt: t0,
    });
    insertMonitoredApi(db, {
      id: newId(),
      consumerId,
      providerId,
      detectionSource: "manual",
    });
    insertImpactFinding(db, {
      id: newId(),
      changeId,
      consumerId,
      filePath: "src/pay.ts",
      lineStart: 10,
      lineEnd: 12,
      symbol: "amount_cents",
      confidence: "high",
      evidenceJson: "[]",
    });
    insertMigrationPr(db, {
      id: newId(),
      changeId,
      consumerId,
      title: "Migrate amount_cents",
      body: "body",
      branchName: "mendpoint/acme",
      status: "open",
      risk: "breaking",
      patchUnified: "",
      createdAt: t0,
    });

    const report = buildExposureReport(db, consumerId);
    expect(report).not.toBeNull();
    expect(report!.consumerId).toBe(consumerId);
    expect(report!.consumerName).toBe("Shop App");
    expect(report!.monitoredApis).toEqual([
      { providerSlug: "acme-payments", providerName: "Acme Payments" },
    ]);
    expect(report!.openChanges).toBe(1);
    expect(report!.findingsCount).toBe(1);
    expect(report!.prsOpen).toBe(1);
    expect(report!.prsMerged).toBe(0);
    expect(report!.topRisks).toHaveLength(1);
    expect(report!.topRisks[0]!.risk).toBe("breaking");
    expect(report!.markdown).toContain("## Exposure report (Warden)");
    expect(report!.markdown).toContain("Acme Payments");
    expect(report!.markdown).toContain("Open changes");
  });

  it("counts merged PRs and excludes those changes from open", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-exp-"));
    dirs.push(dir);
    const db = createDb(join(dir, "e.sqlite"));
    dbs.push(db);
    const t0 = nowIso();
    const providerId = newId();
    insertProvider(db, {
      id: providerId,
      slug: "stripe",
      name: "Stripe",
      website: null,
      createdAt: t0,
    });
    const v1 = newId();
    const v2 = newId();
    insertApiVersion(db, {
      id: v1,
      providerId,
      versionLabel: "1",
      openapiJson: "{}",
      publishedAt: t0,
    });
    insertApiVersion(db, {
      id: v2,
      providerId,
      versionLabel: "2",
      openapiJson: "{\"openapi\":\"3.1.0\"}",
      publishedAt: t0,
    });
    const changeId = newId();
    insertApiChange(db, {
      id: changeId,
      providerId,
      fromVersionId: v1,
      toVersionId: v2,
      risk: "low",
      summary: "docs only",
      diffJson: "[]",
      createdAt: t0,
    });
    const consumerId = newId();
    insertConsumer(db, {
      id: consumerId,
      name: "Pay",
      githubOwner: "o",
      githubRepo: "r",
      tenantId: "tenant_default",
      createdAt: t0,
    });
    insertMonitoredApi(db, {
      id: newId(),
      consumerId,
      providerId,
    });
    insertMigrationPr(db, {
      id: newId(),
      changeId,
      consumerId,
      title: "done",
      body: "b",
      branchName: "b",
      status: "merged",
      risk: "low",
      patchUnified: "",
      createdAt: t0,
      resolvedAt: t0,
    });

    const report = buildExposureReport(db, consumerId)!;
    expect(report.openChanges).toBe(0);
    expect(report.prsMerged).toBe(1);
    expect(report.topRisks).toHaveLength(0);
  });
});
