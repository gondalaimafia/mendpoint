/**
 * Cross-tenant provider/change visibility (tenant-isolation audit fix).
 *
 * Every request-path provider lookup now goes through getVisibleProviderBySlug and every
 * request-path change-by-id read through getVisibleChange, so a tenant can never resolve
 * another tenant's PRIVATE provider (or a change on it) by its globally-unique slug/id. This
 * pins that contract at the accessor layer the routes delegate to:
 *
 *   - getVisibleProviderBySlug  → POST /fettler|/warden/{plans/from-spec,gates,review},
 *                                 POST /consumers/:id/monitor, POST /jobs/fanout,
 *                                 Warden pilot intake + campaign enroll-org, GET /graph/api.
 *   - getVisibleChange          → GET /changes/:id, GET /graph/changes|consumers.
 *   - buildExposureReport       → GET /consumers/:id/exposure(.md).
 *
 * For each, tenant A against tenant B's private provider must be INDISTINGUISHABLE from an
 * unknown slug/id (undefined / null / omitted), while A's own private provider and any shared
 * provider still resolve. Reverting these accessors to the tenant-blind lookups (the reported
 * defect) fails these tests.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExposureReport,
  createDb,
  createTenant,
  getProviderBySlugUnscopedForSystem,
  getVisibleChange,
  getVisibleProviderBySlug,
  insertApiChange,
  insertApiVersion,
  insertConsumer,
  insertMonitoredApi,
  insertProvider,
  type AppDb,
} from "./index.js";

const NOW = "2026-09-23T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];

afterEach(() => {
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTenant(db: AppDb, s: string): void {
  createTenant(db, {
    tenantId: `tenant-${s}`,
    slug: `tenant-${s}`,
    name: `Tenant ${s}`,
    owner: {
      issuer: "https://issuer.example",
      subject: `owner-${s}`,
      email: `owner-${s}@example.com`,
      displayName: `Owner ${s}`,
    },
    apiKeyId: `key-${s}`,
    createdAt: NOW,
  });
}

/** Create a provider (private when `tenantId` is set) with two versions and a change. */
function seedProvider(
  db: AppDb,
  slug: string,
  tenantId: string | null,
): { providerId: string; changeId: string } {
  const providerId = `provider-${slug}`;
  insertProvider(db, {
    id: providerId,
    slug,
    name: `Provider ${slug}`,
    tenantId,
    createdAt: NOW,
  });
  insertApiVersion(db, {
    id: `${slug}-v1`,
    providerId,
    versionLabel: "1",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: slug, version: "1" } }),
    publishedAt: NOW,
  });
  insertApiVersion(db, {
    id: `${slug}-v2`,
    providerId,
    versionLabel: "2",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: slug, version: "2" } }),
    publishedAt: NOW,
  });
  const changeId = `change-${slug}`;
  insertApiChange(db, {
    id: changeId,
    providerId,
    fromVersionId: `${slug}-v1`,
    toVersionId: `${slug}-v2`,
    risk: "breaking",
    summary: `Change on ${slug}`,
    diffJson: "[]",
    createdAt: NOW,
  });
  return { providerId, changeId };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-cross-tenant-provider-"));
  const db = createDb(join(directory, "vis.sqlite"));
  opened.push({ db, directory });
  makeTenant(db, "a");
  makeTenant(db, "b");
  const shared = seedProvider(db, "shared-vendor", null);
  const aPrivate = seedProvider(db, "a-private", "tenant-a");
  const bPrivate = seedProvider(db, "b-private", "tenant-b");
  return { db, shared, aPrivate, bPrivate };
}

describe("cross-tenant provider/change visibility", () => {
  it("getVisibleProviderBySlug: B's private provider is indistinguishable from an unknown slug for A", () => {
    const { db } = fixture();
    // The tenant-blind escape hatch still resolves it (this is how squatting is detected)…
    expect(getProviderBySlugUnscopedForSystem(db, "b-private")).toBeDefined();
    // …but A's tenant-scoped lookup returns undefined — exactly like a slug that does not exist.
    expect(getVisibleProviderBySlug(db, "tenant-a", "b-private")).toBeUndefined();
    expect(getVisibleProviderBySlug(db, "tenant-a", "does-not-exist")).toBeUndefined();
  });

  it("getVisibleProviderBySlug: positive controls — A's own private and any shared provider resolve", () => {
    const { db } = fixture();
    expect(getVisibleProviderBySlug(db, "tenant-a", "a-private")?.slug).toBe("a-private");
    expect(getVisibleProviderBySlug(db, "tenant-a", "shared-vendor")?.slug).toBe("shared-vendor");
    // And symmetrically B sees its own private one, never A's.
    expect(getVisibleProviderBySlug(db, "tenant-b", "b-private")?.slug).toBe("b-private");
    expect(getVisibleProviderBySlug(db, "tenant-b", "a-private")).toBeUndefined();
  });

  it("getVisibleProviderBySlug: undefined tenant is the open/system read, blank is a hard error", () => {
    const { db } = fixture();
    expect(getVisibleProviderBySlug(db, undefined, "b-private")?.slug).toBe("b-private");
    expect(() => getVisibleProviderBySlug(db, "", "b-private")).toThrow("tenant_scope_required");
  });

  it("getVisibleChange: a change on B's private provider is 404-equivalent (undefined) for A", () => {
    const { db, bPrivate, aPrivate, shared } = fixture();
    expect(getVisibleChange(db, "tenant-a", bPrivate.changeId)).toBeUndefined();
    expect(getVisibleChange(db, "tenant-a", "change-missing")).toBeUndefined();
    // Positive controls: A's own private change and a shared change still resolve.
    expect(getVisibleChange(db, "tenant-a", aPrivate.changeId)?.id).toBe(aPrivate.changeId);
    expect(getVisibleChange(db, "tenant-a", shared.changeId)?.id).toBe(shared.changeId);
    // System read resolves regardless; blank is a hard error.
    expect(getVisibleChange(db, undefined, bPrivate.changeId)?.id).toBe(bPrivate.changeId);
    expect(() => getVisibleChange(db, "", bPrivate.changeId)).toThrow("tenant_scope_required");
  });

  it("buildExposureReport: a stale monitored link to B's private provider never surfaces B's data to A", () => {
    const { db, bPrivate, shared } = fixture();
    insertConsumer(db, {
      id: "consumer-a",
      name: "Consumer A",
      githubOwner: "acme",
      githubRepo: "app",
      tenantId: "tenant-a",
      createdAt: NOW,
    });
    // A legitimate link to a shared provider (positive control) …
    insertMonitoredApi(db, { id: "mon-shared", consumerId: "consumer-a", providerId: shared.providerId });
    // … and a stale/hostile link to B's private provider that must be filtered out.
    insertMonitoredApi(db, { id: "mon-bprivate", consumerId: "consumer-a", providerId: bPrivate.providerId });

    const scoped = buildExposureReport(db, "consumer-a", "tenant-a")!;
    const slugs = scoped.monitoredApis.map((m) => m.providerSlug);
    expect(slugs).toContain("shared-vendor");
    expect(slugs).not.toContain("b-private");
    expect(JSON.stringify(scoped)).not.toContain("b-private");
    expect(JSON.stringify(scoped)).not.toContain("Provider b-private");

    // The unscoped/system report still shows everything (contrast, proves the filter is doing work).
    const unscoped = buildExposureReport(db, "consumer-a")!;
    expect(unscoped.monitoredApis.map((m) => m.providerSlug)).toContain("b-private");
  });
});
