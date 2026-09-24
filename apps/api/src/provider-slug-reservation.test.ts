/**
 * Provider slug reservation, private-slug namespacing, and the create-time slug oracle (#704).
 *
 * `providers.slug` is globally UNIQUE. Under self-serve Fettler/Warden a tenant could create a
 * PRIVATE provider under a real vendor slug (e.g. `stripe`), occupying that slug globally and
 * blocking every other tenant from the real vendor; a create colliding with a taken slug also
 * returned 500, a cross-tenant slug-existence oracle. This suite drives the REAL app through
 * app.request with API_AUTH=required and the self-serve flags on, and asserts:
 *   1. a tenant may not create a private provider under a reserved shared-catalog slug (409
 *      provider_slug_reserved);
 *   2. a private create is namespaced (the stored/returned slug differs from the requested one)
 *      and is addressable by its routes under the effective slug;
 *   3. a create colliding with ANY existing slug returns an ownership-agnostic 409
 *      provider_slug_unavailable (never 500, never an existence oracle);
 *   4. system-admin shared-catalog creation is unaffected (bare slug, no namespacing, no
 *      reservation).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const NOW = "2026-09-24T12:00:00.000Z";

let app: { request: (input: string, init?: RequestInit) => Promise<Response> };
let db: import("@mendpoint/db").AppDb;
let tempDir: string;
let systemToken = "";
let tokenA = "";
let tokenB = "";

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function body(res: Response): Promise<{ status: number; json: unknown }> {
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, json };
}

async function createProvider(
  token: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  return body(
    await app.request("/providers", { method: "POST", headers: auth(token), body: JSON.stringify(payload) }),
  );
}

const ENV_KEYS = [
  "MENDPOINT_DATA_DIR",
  "API_AUTH",
  "MENDPOINT_SELF_SERVE_FETTLER",
  "MENDPOINT_SELF_SERVE_WARDEN",
  "MENDPOINT_API_EMBED",
  "MENDPOINT_APPLICATION_DATA_KEY",
  "MENDPOINT_SYSTEM_TENANT_ID",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tempDir = mkdtempSync(join(tmpdir(), "mendpoint-provider-slug-reservation-"));
  process.env.MENDPOINT_DATA_DIR = tempDir;
  process.env.API_AUTH = "required";
  process.env.MENDPOINT_SELF_SERVE_FETTLER = "1";
  process.env.MENDPOINT_SELF_SERVE_WARDEN = "1";
  process.env.MENDPOINT_API_EMBED = "1";
  process.env.MENDPOINT_APPLICATION_DATA_KEY ??= "a".repeat(64);
  // The bootstrap DB already seeds `tenant_default`; point the system-catalog tenant at a
  // distinct id we own so we can mint its owner API key without colliding with the seed.
  process.env.MENDPOINT_SYSTEM_TENANT_ID = "tenant-sys";

  const dbMod = await import("@mendpoint/db");
  const server = (await import("./server.js")) as unknown as { app: typeof app; db: typeof db };
  app = server.app;
  db = server.db;

  const ownerToken = (result: ReturnType<typeof dbMod.createTenant>): string => {
    if (!result.apiKey) throw new Error("createTenant did not return an owner API key");
    return result.apiKey.token;
  };
  // The system-catalog admin lives in the system tenant (tenant_default); its owner may mutate
  // the shared catalog.
  systemToken = ownerToken(
    dbMod.createTenant(db, {
      tenantId: "tenant-sys",
      slug: "system",
      name: "System",
      owner: { issuer: "https://issuer.example", subject: "owner-sys", email: "sys@example.com", displayName: "Owner Sys" },
      apiKeyId: "key-sys",
      createdAt: NOW,
    }),
  );
  tokenA = ownerToken(
    dbMod.createTenant(db, {
      tenantId: "tenant-a",
      slug: "tenant-a",
      name: "Tenant A",
      owner: { issuer: "https://issuer.example", subject: "owner-a", email: "a@example.com", displayName: "Owner A" },
      apiKeyId: "key-a",
      createdAt: NOW,
    }),
  );
  tokenB = ownerToken(
    dbMod.createTenant(db, {
      tenantId: "tenant-b",
      slug: "tenant-b",
      name: "Tenant B",
      owner: { issuer: "https://issuer.example", subject: "owner-b", email: "b@example.com", displayName: "Owner B" },
      apiKeyId: "key-b",
      createdAt: NOW,
    }),
  );
}, 120_000);

afterAll(() => {
  try {
    db?.raw.close();
  } catch {
    /* */
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* */
  }
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("provider slug reservation — a tenant cannot squat a shared vendor slug", () => {
  it("refuses a private provider under a known vendor catalog slug (409 provider_slug_reserved)", async () => {
    const res = await createProvider(tokenA, { slug: "stripe", name: "Not Stripe" });
    expect(res.status).toBe(409);
    expect((res.json as { error?: string }).error).toBe("provider_slug_reserved");
    // Nothing was written under that slug.
    expect(db.raw.prepare(`SELECT COUNT(*) AS c FROM providers WHERE slug = 'stripe'`).get()).toEqual({ c: 0 });
  });

  it("refuses a private provider under an existing shared provider row's slug", async () => {
    db.raw
      .prepare(`INSERT INTO providers (id, slug, name, tenant_id, created_at) VALUES (?, ?, ?, NULL, ?)`)
      .run("prov-custom-shared", "custom-shared", "Custom Shared", NOW);
    const res = await createProvider(tokenA, { slug: "custom-shared", name: "Squat" });
    expect(res.status).toBe(409);
    expect((res.json as { error?: string }).error).toBe("provider_slug_reserved");
  });

  it("rejects a case-variant vendor slug at validation (uppercase is not a valid slug)", async () => {
    // `Stripe` is not a valid slug shape, so it is refused at validation (400) before the
    // reservation check ever runs — it still cannot squat the vendor.
    const res = await createProvider(tokenB, { slug: "Stripe", name: "Case Squat" });
    expect(res.status).toBe(400);
    expect((res.json as { error?: string }).error).toBe("invalid_provider_slug");
  });
});

describe("requested slug validation — named 400, no 500", () => {
  const invalid: Array<{ label: string; slug: unknown }> = [
    { label: "path separator", slug: "a/b" },
    { label: "uppercase", slug: "MyApi" },
    { label: "namespace separator", slug: "tenant-a~x" },
    { label: "empty", slug: "" },
    { label: "leading hyphen", slug: "-api" },
    { label: "too long", slug: "a".repeat(64) },
  ];
  for (const { label, slug } of invalid) {
    it(`rejects ${label} with 400 invalid_provider_slug`, async () => {
      const res = await createProvider(tokenA, { slug, name: "Bad" });
      expect(res.status).toBe(400);
      expect((res.json as { error?: string }).error).toBe("invalid_provider_slug");
    });
  }

  it("a missing slug field is a 400, not a 500", async () => {
    const res = await createProvider(tokenA, { name: "No Slug" });
    expect(res.status).toBe(400);
    expect((res.json as { error?: string }).error).toBe("invalid_provider_slug");
  });
});

describe("UNIQUE-constraint race path (pre-check bypassed) still returns 409, never 500", () => {
  it("maps a slug UNIQUE violation at insert to 409 provider_slug_unavailable", async () => {
    // Create the row so the effective slug genuinely exists.
    expect((await createProvider(tokenA, { slug: "race-me", name: "Race 1" })).status).toBe(201);
    // Simulate the TOCTOU window on a multi-instance deployment: force the pre-insert existence
    // check to miss once, so control reaches the INSERT, which hits the UNIQUE index. The catch
    // must turn that into the same 409 (a missing catch would surface a 500).
    const dbMod = await import("@mendpoint/db");
    const spy = vi
      .spyOn(dbMod, "getProviderBySlugUnscopedForSystem")
      .mockReturnValueOnce(undefined);
    try {
      const res = await createProvider(tokenA, { slug: "race-me", name: "Race 2" });
      expect(spy).toHaveBeenCalled();
      expect(res.status).toBe(409);
      expect((res.json as { error?: string }).error).toBe("provider_slug_unavailable");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("private provider slug namespacing — never collides with a future shared vendor", () => {
  it("stores and returns a tenant-namespaced slug and is addressable by its routes", async () => {
    const res = await createProvider(tokenA, { slug: "my-internal-api", name: "My Internal API" });
    expect(res.status).toBe(201);
    const created = res.json as { id: string; slug: string };
    // The effective slug differs from the requested one and carries the tenant namespace.
    expect(created.slug).not.toBe("my-internal-api");
    expect(created.slug).toBe("tenant-a~my-internal-api");

    // Addressable by the effective slug (owner mutates its own private provider).
    const versioned = await app.request(`/providers/${created.slug}/versions`, {
      method: "POST",
      headers: auth(tokenA),
      body: JSON.stringify({ versionLabel: "1", openapi: { openapi: "3.0.0", info: { title: "x", version: "1" }, paths: {} } }),
    });
    expect(versioned.status).toBe(201);
    expect((await app.request(`/providers/${created.slug}`, { headers: auth(tokenA) })).status).toBe(200);

    // The bare requested slug is nonexistent — namespacing makes bare-slug squatting impossible.
    expect((await app.request(`/providers/my-internal-api`, { headers: auth(tokenA) })).status).toBe(404);
  });

  it("lets two tenants use the same requested private slug without colliding", async () => {
    const a = await createProvider(tokenA, { slug: "shared-name", name: "A name" });
    const b = await createProvider(tokenB, { slug: "shared-name", name: "B name" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((a.json as { slug: string }).slug).toBe("tenant-a~shared-name");
    expect((b.json as { slug: string }).slug).toBe("tenant-b~shared-name");
  });
});

describe("no create-time slug oracle — collisions are an ownership-agnostic 409, never 500", () => {
  it("returns 409 provider_slug_unavailable (not 500) on a duplicate shared create", async () => {
    expect((await createProvider(systemToken, { slug: "dup-shared", name: "Dup Shared 1" })).status).toBe(201);
    const dup = await createProvider(systemToken, { slug: "dup-shared", name: "Dup Shared 2" });
    expect(dup.status).toBe(409);
    expect((dup.json as { error?: string }).error).toBe("provider_slug_unavailable");
  });

  it("returns 409 provider_slug_unavailable on a tenant's duplicate private create", async () => {
    expect((await createProvider(tokenA, { slug: "dup-private", name: "Dup 1" })).status).toBe(201);
    const dup = await createProvider(tokenA, { slug: "dup-private", name: "Dup 2" });
    expect(dup.status).toBe(409);
    expect((dup.json as { error?: string }).error).toBe("provider_slug_unavailable");
  });

  it("gives an IDENTICAL response for a shared collision and a collision with another tenant's private row (no ownership oracle)", async () => {
    // A legacy squatted private row (bare slug, another tenant) — the shape this PR prevents new
    // rows from taking, seeded directly to prove the create path never discloses its ownership.
    db.raw
      .prepare(`INSERT INTO providers (id, slug, name, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run("prov-legacy-squat", "legacy-squat", "Legacy Squat", "tenant-b", NOW);
    // A shared row occupying its own slug.
    db.raw
      .prepare(`INSERT INTO providers (id, slug, name, tenant_id, created_at) VALUES (?, ?, ?, NULL, ?)`)
      .run("prov-shared-taken", "shared-taken", "Shared Taken", NOW);

    // System admin creating a shared provider over each taken slug: both are 409
    // provider_slug_unavailable with a byte-identical body — the caller cannot tell whether the
    // slug is shared or privately owned by another tenant.
    const overShared = await createProvider(systemToken, { slug: "shared-taken", name: "Retry" });
    const overOtherPrivate = await createProvider(systemToken, { slug: "legacy-squat", name: "Retry" });
    expect(overShared.status).toBe(409);
    expect(overOtherPrivate).toEqual(overShared);
  });
});

describe("system-admin shared-catalog creation is unaffected", () => {
  it("lets the system admin create a shared provider under a bare (un-namespaced) slug", async () => {
    const res = await createProvider(systemToken, { slug: "acme-shared", name: "Acme Shared" });
    expect(res.status).toBe(201);
    expect((res.json as { slug: string }).slug).toBe("acme-shared");
    const row = db.raw.prepare(`SELECT tenant_id, slug FROM providers WHERE slug = 'acme-shared'`).get() as {
      tenant_id: string | null;
      slug: string;
    };
    expect(row.tenant_id).toBeNull();
    expect(row.slug).toBe("acme-shared");
  });

  it("reservation does not apply to the system admin: it may create a shared provider on a vendor slug", async () => {
    const res = await createProvider(systemToken, { slug: "twilio", name: "Twilio Shared" });
    expect(res.status).toBe(201);
    expect((res.json as { slug: string }).slug).toBe("twilio");
    expect((db.raw.prepare(`SELECT tenant_id FROM providers WHERE slug = 'twilio'`).get() as { tenant_id: string | null }).tenant_id).toBeNull();
  });
});
