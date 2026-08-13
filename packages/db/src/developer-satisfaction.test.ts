import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  recordDeveloperSatisfaction,
  listDeveloperSatisfaction,
  summarizeDeveloperSatisfaction,
  type AppDb,
} from "./index.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];
const TENANT = "tenant-sat";

afterEach(() => {
  for (const db of dbs.splice(0)) db.raw.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDb(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-sat-"));
  dirs.push(dir);
  const db = createDb(join(dir, "sat.sqlite"));
  dbs.push(db);
  return db;
}

describe("developer satisfaction capture", () => {
  it("records signals and summarizes only real rows", () => {
    const db = freshDb();
    recordDeveloperSatisfaction(db, { id: "s1", tenantId: TENANT, rating: 5, runId: "r1", createdAt: "2026-08-01T00:00:00.000Z" });
    recordDeveloperSatisfaction(db, { id: "s2", tenantId: TENANT, rating: 4, prId: "p1", createdAt: "2026-08-02T00:00:00.000Z" });
    recordDeveloperSatisfaction(db, { id: "s3", tenantId: TENANT, rating: 1, comment: "  broke my build  ", createdAt: "2026-08-03T00:00:00.000Z" });

    const summary = summarizeDeveloperSatisfaction(db, { tenantId: TENANT });
    expect(summary.basis).toBe("measured");
    expect(summary.responses).toBe(3);
    expect(summary.averageRating).toBeCloseTo((5 + 4 + 1) / 3, 10);
    expect(summary.positive).toBe(2); // 5 and 4
    expect(summary.negative).toBe(1); // 1
    expect(summary.neutral).toBe(0);

    const listed = listDeveloperSatisfaction(db, TENANT);
    expect(listed).toHaveLength(3);
    expect(listed[0]!.comment).toBe("broke my build"); // trimmed
  });

  it("is honestly unavailable (never zero-as-real) when no signals exist", () => {
    const db = freshDb();
    const summary = summarizeDeveloperSatisfaction(db, { tenantId: TENANT });
    expect(summary.basis).toBe("unavailable");
    expect(summary.averageRating).toBeNull();
    expect(summary.responses).toBe(0);
    expect(summary.reason).toContain("No developer-satisfaction signals");
  });

  it("rejects out-of-range ratings rather than clamping", () => {
    const db = freshDb();
    expect(() =>
      recordDeveloperSatisfaction(db, { id: "s1", tenantId: TENANT, rating: 6, createdAt: "2026-08-01T00:00:00.000Z" }),
    ).toThrow("developer_satisfaction_rating_invalid");
    expect(() =>
      recordDeveloperSatisfaction(db, { id: "s2", tenantId: TENANT, rating: 0, createdAt: "2026-08-01T00:00:00.000Z" }),
    ).toThrow("developer_satisfaction_rating_invalid");
    expect(() =>
      recordDeveloperSatisfaction(db, { id: "s3", tenantId: TENANT, rating: 3.5, createdAt: "2026-08-01T00:00:00.000Z" }),
    ).toThrow("developer_satisfaction_rating_invalid");
  });

  it("scopes to the tenant and honors the window", () => {
    const db = freshDb();
    recordDeveloperSatisfaction(db, { id: "s1", tenantId: TENANT, rating: 5, createdAt: "2026-08-01T00:00:00.000Z" });
    recordDeveloperSatisfaction(db, { id: "s2", tenantId: TENANT, rating: 3, createdAt: "2026-08-10T00:00:00.000Z" });
    recordDeveloperSatisfaction(db, { id: "x1", tenantId: "other", rating: 1, createdAt: "2026-08-01T00:00:00.000Z" });

    expect(summarizeDeveloperSatisfaction(db, { tenantId: TENANT }).responses).toBe(2);
    expect(summarizeDeveloperSatisfaction(db, { tenantId: "other" }).responses).toBe(1);

    const windowed = summarizeDeveloperSatisfaction(db, { tenantId: TENANT, since: "2026-08-05T00:00:00.000Z" });
    expect(windowed.responses).toBe(1);
    expect(windowed.averageRating).toBe(3);
  });
});
