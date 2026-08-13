import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createTenant,
  findApiKeyByToken,
  getTenantMembership,
  listApiKeys,
  listTenantMemberships,
  type AppDb,
} from "./index.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.raw.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testDb(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-tenant-"));
  dirs.push(dir);
  const db = createDb(join(dir, "tenant.sqlite"));
  dbs.push(db);
  return db;
}

const owner = {
  issuer: "https://self-serve.mendpoint.ai",
  subject: "founder@acme.test",
  email: "founder@acme.test",
  displayName: "Acme",
};

describe("createTenant self-serve provisioning", () => {
  it("creates the tenant, founding owner membership, and a scoped key in one call", () => {
    const db = testDb();
    const result = createTenant(db, {
      tenantId: "tenant-acme",
      slug: "acme",
      name: "Acme",
      owner,
      apiKeyId: "key-acme",
      createdAt: "2026-08-13T00:00:00.000Z",
    });

    expect(result.created).toBe(true);
    expect(result.tenant).toMatchObject({ id: "tenant-acme", slug: "acme", plan: "free" });
    expect(result.membership).toMatchObject({
      tenant_id: "tenant-acme",
      role: "owner",
      status: "active",
      email: "founder@acme.test",
    });
    expect(result.apiKey?.token).toMatch(/^me_/);

    // The issued key resolves to the new tenant.
    const resolved = findApiKeyByToken(db, result.apiKey!.token);
    expect(resolved?.tenant_id).toBe("tenant-acme");
    expect(getTenantMembership(db, "tenant-acme", owner.issuer, owner.subject)).toBeDefined();
  });

  it("is idempotent for the founding owner and never mints a second key", () => {
    const db = testDb();
    const input = {
      tenantId: "tenant-acme",
      slug: "acme",
      name: "Acme",
      owner,
      apiKeyId: "key-acme",
      createdAt: "2026-08-13T00:00:00.000Z",
    };
    const first = createTenant(db, input);
    const second = createTenant(db, { ...input, apiKeyId: "key-acme-2" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.apiKey).toBeNull();
    expect(second.tenant.id).toBe("tenant-acme");
    // Exactly one key and one membership exist.
    expect(listApiKeys(db, "tenant-acme")).toHaveLength(1);
    expect(listTenantMemberships(db, "tenant-acme")).toHaveLength(1);
  });

  it("refuses to attach a different owner to an existing slug", () => {
    const db = testDb();
    createTenant(db, {
      tenantId: "tenant-acme",
      slug: "acme",
      name: "Acme",
      owner,
      apiKeyId: "key-acme",
      createdAt: "2026-08-13T00:00:00.000Z",
    });
    expect(() =>
      createTenant(db, {
        tenantId: "tenant-acme-2",
        slug: "acme",
        name: "Acme Two",
        owner: { ...owner, subject: "stranger@evil.test", email: "stranger@evil.test" },
        apiKeyId: "key-acme-3",
        createdAt: "2026-08-13T00:00:01.000Z",
      }),
    ).toThrow(/tenant_slug_taken/);
  });

  it("isolates a self-serve tenant from another tenant's keys", () => {
    const db = testDb();
    const acme = createTenant(db, {
      tenantId: "tenant-acme",
      slug: "acme",
      name: "Acme",
      owner,
      apiKeyId: "key-acme",
      createdAt: "2026-08-13T00:00:00.000Z",
    });
    const globex = createTenant(db, {
      tenantId: "tenant-globex",
      slug: "globex",
      name: "Globex",
      owner: { ...owner, subject: "founder@globex.test", email: "founder@globex.test" },
      apiKeyId: "key-globex",
      createdAt: "2026-08-13T00:00:02.000Z",
    });

    // Each tenant only sees its own key; neither sees the other's.
    const acmeKeys = listApiKeys(db, "tenant-acme");
    const globexKeys = listApiKeys(db, "tenant-globex");
    expect(acmeKeys.map((k) => k.id)).toEqual(["key-acme"]);
    expect(globexKeys.map((k) => k.id)).toEqual(["key-globex"]);
    expect(findApiKeyByToken(db, acme.apiKey!.token)?.tenant_id).toBe("tenant-acme");
    expect(findApiKeyByToken(db, globex.apiKey!.token)?.tenant_id).toBe("tenant-globex");
    expect(getTenantMembership(db, "tenant-globex", owner.issuer, owner.subject)).toBeUndefined();
  });
});
