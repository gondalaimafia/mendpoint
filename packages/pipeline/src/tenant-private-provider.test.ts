/**
 * S1.1 pipeline compatibility for tenant-private providers.
 *
 * The Warden change pipeline resolves a provider by slug and runs the publish -> diff ->
 * change flow. This proves it works unchanged when the provider is a self-serve tenant-private
 * one (providers.tenant_id set), and that the produced change is visible only to the owning
 * tenant through the tenant-scoped change read (never to another tenant).
 */
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, insertApiVersion, insertProvider, listChanges, getProviderById } from "@mendpoint/db";
import { newId, nowIso } from "@mendpoint/shared";
import {
  openGraphLearnMemory,
  resetGraphLearnDbForTests,
  type GraphLearnDb,
} from "@mendpoint/graph-learn";
import { runChangePipeline } from "./index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const acme = join(root, "fixtures/providers/acme-payments");
const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];
const graphDbs: GraphLearnDb[] = [];

afterEach(() => {
  resetGraphLearnDbForTests();
  while (graphDbs.length) {
    try {
      graphDbs.pop()?.raw.close();
    } catch {
      /* ignore */
    }
  }
  while (dbs.length) {
    try {
      dbs.pop()?.raw.close?.();
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
        /* Windows may hold file locks briefly */
      }
    }
  }
});

function testGraphDb(): GraphLearnDb {
  const graphDb = openGraphLearnMemory();
  graphDbs.push(graphDb);
  return graphDb;
}

function seedPrivateProvider(tenantId: string) {
  const dir = join(tmpdir(), `mendpoint-tenant-provider-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const db = createDb(join(dir, "db.sqlite"));
  dbs.push(db);
  const providerId = newId();
  insertProvider(db, {
    id: providerId,
    slug: "tenant-a-payments",
    name: "Tenant A Payments",
    website: null,
    tenantId,
    createdAt: nowIso(),
  });
  for (const [versionLabel, file, publishedAt] of [
    ["1.0.0", "openapi-v1.json", "2026-01-01T00:00:00.000Z"],
    ["2.0.0", "openapi-v2.json", "2026-07-01T00:00:00.000Z"],
  ] as const) {
    insertApiVersion(db, {
      id: newId(),
      providerId,
      versionLabel,
      openapiJson: readFileSync(join(acme, file), "utf8"),
      changelogMd: null,
      publishedAt,
    });
  }
  return { db, providerId };
}

describe("pipeline against a tenant-private provider", () => {
  it("resolves a tenant-private provider, produces a change, and isolates it to the owner", async () => {
    const { db, providerId } = seedPrivateProvider("tenant-a");

    const report = await runChangePipeline({
      tenantId: "tenant-a",
      providerSlug: "tenant-a-payments",
      db,
      graphDb: testGraphDb(),
      persistIndex: false,
    });

    // A change was produced through the standard publish -> diff -> change flow.
    expect(report.changeId).toBeTruthy();
    expect(getProviderById(db, providerId)?.tenant_id).toBe("tenant-a");

    // The owning tenant sees its private change...
    const ownerChanges = listChanges(db, undefined, 0, "tenant-a").map((ch) => ch.id);
    expect(ownerChanges).toContain(report.changeId);

    // ...another tenant never does (isolation), while the shared/global read still includes it.
    const otherChanges = listChanges(db, undefined, 0, "tenant-b").map((ch) => ch.id);
    expect(otherChanges).not.toContain(report.changeId);
    expect(listChanges(db).map((ch) => ch.id)).toContain(report.changeId);
  });
});
