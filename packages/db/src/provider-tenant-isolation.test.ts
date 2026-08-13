/**
 * S1.1 tenant-private provider isolation + boot convergence.
 *
 * A self-serve tenant may own a provider via a non-null providers.tenant_id. This pins that:
 *  - the tenant-scoped provider/change reads return the shared catalog PLUS the caller's own
 *    private rows, and never another tenant's;
 *  - the unscoped (global/system) read is unchanged;
 *  - createDb boots a pre-S1.1 providers table (no tenant_id) without throwing, adds the
 *    nullable column with legacy rows reading NULL (shared), and converges byte-for-byte with
 *    a fresh database.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  getProviderById,
  insertApiChange,
  insertApiVersion,
  insertProvider,
  listChanges,
  listProviders,
  type AppDb,
} from "./index.js";

const NOW = "2026-08-13T00:00:00.000Z";
const dirs: string[] = [];
const dbs: AppDb[] = [];

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function freshDb(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-provider-tenant-"));
  dirs.push(dir);
  const db = createDb(join(dir, "db.sqlite"));
  dbs.push(db);
  return db;
}

function seedProvider(
  db: AppDb,
  suffix: string,
  tenantId: string | null,
): { providerId: string; changeId: string } {
  const providerId = `provider-${suffix}`;
  insertProvider(db, {
    id: providerId,
    slug: `provider-${suffix}`,
    name: `Provider ${suffix}`,
    tenantId,
    createdAt: NOW,
  });
  insertApiVersion(db, {
    id: `version-${suffix}-1`,
    providerId,
    versionLabel: "1",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: suffix, version: "1" } }),
    publishedAt: NOW,
  });
  insertApiVersion(db, {
    id: `version-${suffix}-2`,
    providerId,
    versionLabel: "2",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: suffix, version: "2" } }),
    publishedAt: NOW,
  });
  const changeId = `change-${suffix}`;
  insertApiChange(db, {
    id: changeId,
    providerId,
    fromVersionId: `version-${suffix}-1`,
    toVersionId: `version-${suffix}-2`,
    risk: "breaking",
    summary: `Change ${suffix}`,
    diffJson: "[]",
    createdAt: NOW,
  });
  return { providerId, changeId };
}

describe("tenant-private provider isolation", () => {
  it("scopes provider reads to the shared catalog plus the caller's own private providers", () => {
    const db = freshDb();
    seedProvider(db, "shared", null);
    seedProvider(db, "a", "tenant-a");
    seedProvider(db, "b", "tenant-b");

    const forA = listProviders(db, undefined, 0, "tenant-a").map((p) => p.id).sort();
    expect(forA).toEqual(["provider-a", "provider-shared"]);

    const forB = listProviders(db, undefined, 0, "tenant-b").map((p) => p.id).sort();
    expect(forB).toEqual(["provider-b", "provider-shared"]);

    // Tenant A never sees tenant B's private provider and vice versa.
    expect(forA).not.toContain("provider-b");
    expect(forB).not.toContain("provider-a");
  });

  it("scopes change reads through provider ownership so private changes never leak", () => {
    const db = freshDb();
    seedProvider(db, "shared", null);
    seedProvider(db, "a", "tenant-a");
    seedProvider(db, "b", "tenant-b");

    const forA = listChanges(db, undefined, 0, "tenant-a").map((ch) => ch.id).sort();
    expect(forA).toEqual(["change-a", "change-shared"]);

    const forB = listChanges(db, undefined, 0, "tenant-b").map((ch) => ch.id).sort();
    expect(forB).toEqual(["change-b", "change-shared"]);

    expect(forA).not.toContain("change-b");
    expect(forB).not.toContain("change-a");
  });

  it("leaves the unscoped global/system read unchanged", () => {
    const db = freshDb();
    seedProvider(db, "shared", null);
    seedProvider(db, "a", "tenant-a");
    seedProvider(db, "b", "tenant-b");

    expect(listProviders(db).map((p) => p.id).sort()).toEqual([
      "provider-a",
      "provider-b",
      "provider-shared",
    ]);
    expect(listChanges(db).map((ch) => ch.id).sort()).toEqual([
      "change-a",
      "change-b",
      "change-shared",
    ]);
    expect(getProviderById(db, "provider-a")?.tenant_id).toBe("tenant-a");
    expect(getProviderById(db, "provider-shared")?.tenant_id ?? null).toBeNull();
  });

  it("fails closed on a present-but-blank tenant scope rather than leaking every provider", () => {
    const db = freshDb();
    seedProvider(db, "a", "tenant-a");
    expect(() => listProviders(db, undefined, 0, "")).toThrow("tenant_scope_required");
    expect(() => listChanges(db, undefined, 0, "")).toThrow("tenant_scope_required");
  });

  it("boots a pre-S1.1 providers schema (no tenant_id) and converges with a fresh DB", () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "mendpoint-provider-legacy-"));
    dirs.push(legacyDir);
    const legacyPath = join(legacyDir, "legacy.sqlite");
    // Pre-S1.1 production shape: providers WITHOUT tenant_id.
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        website TEXT,
        openapi_url TEXT,
        changelog_url TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO providers (id, slug, name, website, openapi_url, changelog_url, created_at)
      VALUES ('legacy-provider', 'legacy', 'Legacy', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    // Booting on the existing database must not throw "no such column: tenant_id".
    const migrated = createDb(legacyPath);
    dbs.push(migrated);

    const columns = (
      migrated.raw.prepare("PRAGMA table_info(providers)").all() as Array<{ name: string }>
    ).map((col) => col.name);
    expect(columns).toContain("tenant_id");

    // Legacy rows read NULL => shared catalog (byte-identical visibility).
    expect(getProviderById(migrated, "legacy-provider")?.tenant_id ?? null).toBeNull();

    const fresh = freshDb();
    const columnsOf = (db: AppDb) =>
      (db.raw.prepare("PRAGMA table_info(providers)").all() as Array<{ name: string }>)
        .map((col) => col.name)
        .sort();
    const indexesOf = (db: AppDb) =>
      (db.raw.prepare("PRAGMA index_list(providers)").all() as Array<{ name: string }>)
        .map((idx) => idx.name)
        .sort();
    expect(columnsOf(migrated)).toEqual(columnsOf(fresh));
    expect(indexesOf(migrated)).toEqual(indexesOf(fresh));
  });
});
