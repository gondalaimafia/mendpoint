/**
 * HTTP route-level cross-tenant isolation (tenant-isolation audit fix).
 *
 * Drives the REAL app (middleware + handlers) through app.request with API_AUTH=required and
 * two real tenants created via createTenant (real owner API keys). Tenant B owns a PRIVATE
 * provider `b-private`; every request-path route that resolves a provider or change is asserted
 * to give tenant A a response IDENTICAL (status + body) to an unknown slug/id — no existence
 * oracle — with positive controls on A's own private provider and a shared provider.
 *
 * These tests fail if any route is reverted to the tenant-blind lookup (see the per-family
 * mutation notes in the PR). The api suite previously had no route-level tenancy coverage.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const NOW = "2026-09-23T12:00:00.000Z";

let app: { request: (input: string, init?: RequestInit) => Promise<Response> };
let db: import("@mendpoint/db").AppDb;
let tempDir: string;
let tokenA = "";
let tokenB = "";
// Seeded change ids (on providers of each visibility).
const changeId = { shared: "", aPrivate: "", bPrivate: "" };
let consumerAId = "";
let bPrivateProviderId = "";

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

const ENV_KEYS = [
  "MENDPOINT_DATA_DIR",
  "API_AUTH",
  "MENDPOINT_SELF_SERVE_FETTLER",
  "MENDPOINT_SELF_SERVE_WARDEN",
  "MENDPOINT_API_EMBED",
  "MENDPOINT_APPLICATION_DATA_KEY",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // These process-global env vars configure the imported server module; save and restore them
  // so they never leak into sibling api test files sharing this worker.
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tempDir = mkdtempSync(join(tmpdir(), "mendpoint-cross-tenant-http-"));
  process.env.MENDPOINT_DATA_DIR = tempDir;
  process.env.API_AUTH = "required";
  process.env.MENDPOINT_SELF_SERVE_FETTLER = "1";
  process.env.MENDPOINT_SELF_SERVE_WARDEN = "1";
  process.env.MENDPOINT_API_EMBED = "1";
  // Boot requires an application data key (design-partner store); a distinct 64-hex test value.
  process.env.MENDPOINT_APPLICATION_DATA_KEY ??= "a".repeat(64);

  const dbMod = await import("@mendpoint/db");
  const server = (await import("./server.js")) as unknown as {
    app: typeof app;
    db: typeof db;
  };
  app = server.app;
  db = server.db;

  const ownerToken = (result: ReturnType<typeof dbMod.createTenant>): string => {
    if (!result.apiKey) throw new Error("createTenant did not return an owner API key");
    return result.apiKey.token;
  };
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

  // A shared/system-catalog provider (tenant_id null) plus each tenant's own private provider.
  // The private providers are created THROUGH THE API by their owners (POST /providers stamps
  // tenant_id); their versions/change are seeded on the shared db handle (content is not the
  // subject of these isolation tests).
  dbMod.insertProvider(db, { id: "provider-shared", slug: "shared-vendor", name: "Shared Vendor", tenantId: null, createdAt: NOW });

  const mkPrivate = async (token: string, slug: string): Promise<string> => {
    const res = await app.request("/providers", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ slug, name: `Private ${slug}` }),
    });
    if (res.status !== 201) throw new Error(`create ${slug} failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { id: string }).id;
  };
  const aPrivateId = await mkPrivate(tokenA, "a-private");
  const bPrivateId = await mkPrivate(tokenB, "b-private");
  bPrivateProviderId = bPrivateId;

  const seedVersionsAndChange = (providerId: string, slug: string): string => {
    dbMod.insertApiVersion(db, {
      id: `${slug}-v1`,
      providerId,
      versionLabel: "1",
      openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: slug, version: "1" }, paths: {} }),
      publishedAt: NOW,
    });
    dbMod.insertApiVersion(db, {
      id: `${slug}-v2`,
      providerId,
      versionLabel: "2",
      openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: slug, version: "2" }, paths: {} }),
      publishedAt: NOW,
    });
    const id = `change-${slug}`;
    dbMod.insertApiChange(db, {
      id,
      providerId,
      fromVersionId: `${slug}-v1`,
      toVersionId: `${slug}-v2`,
      risk: "breaking",
      summary: `Change on ${slug}`,
      diffJson: "[]",
      createdAt: NOW,
    });
    return id;
  };
  changeId.shared = seedVersionsAndChange("provider-shared", "shared-vendor");
  changeId.aPrivate = seedVersionsAndChange(aPrivateId, "a-private");
  changeId.bPrivate = seedVersionsAndChange(bPrivateId, "b-private");
  // Give b-private a pollable feed URL so /feeds/poll would touch it if visibility failed.
  db.raw.prepare(`UPDATE providers SET openapi_url = ? WHERE id = ?`).run("file:/nonexistent/b.json", bPrivateId);

  consumerAId = "consumer-a";
  dbMod.insertConsumer(db, {
    id: consumerAId,
    name: "Consumer A",
    githubOwner: "acme",
    githubRepo: "app",
    tenantId: "tenant-a",
    createdAt: NOW,
  });
  // A stale/hostile monitored_apis row linking A's consumer to B's private provider — the kind
  // of row the (now scoped) monitor route can no longer create, seeded directly to prove the
  // exposure report still filters it out by tenant visibility.
  dbMod.insertMonitoredApi(db, { id: "mon-stale-b", consumerId: consumerAId, providerId: bPrivateProviderId });
}, 120_000);

afterAll(() => {
  try {
    db?.raw.close();
  } catch {
    /* */
  }
  // Best-effort: on Windows the durable stores may still hold WAL handles briefly.
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

describe("HTTP cross-tenant isolation — reads never disclose B's private provider to A", () => {
  it("POST /fettler/plans/from-spec: b-private is indistinguishable from an unknown slug", async () => {
    const unknown = await body(await app.request("/fettler/plans/from-spec", { method: "POST", headers: auth(tokenA), body: JSON.stringify({ providerSlug: "no-such-slug" }) }));
    const cross = await body(await app.request("/fettler/plans/from-spec", { method: "POST", headers: auth(tokenA), body: JSON.stringify({ providerSlug: "b-private" }) }));
    expect(cross).toEqual(unknown);
    expect(cross.status).toBe(404);
    // Positive controls: A's own private and a shared provider build a plan.
    expect((await app.request("/fettler/plans/from-spec", { method: "POST", headers: auth(tokenA), body: JSON.stringify({ providerSlug: "a-private" }) })).status).toBe(200);
    expect((await app.request("/fettler/plans/from-spec", { method: "POST", headers: auth(tokenA), body: JSON.stringify({ providerSlug: "shared-vendor" }) })).status).toBe(200);
  });

  it("POST /fettler/gates: b-private is indistinguishable from an unknown slug", async () => {
    const unknown = await body(await app.request("/fettler/gates", { method: "POST", headers: auth(tokenA), body: JSON.stringify({ providerSlug: "no-such-slug" }) }));
    const cross = await body(await app.request("/fettler/gates", { method: "POST", headers: auth(tokenA), body: JSON.stringify({ providerSlug: "b-private" }) }));
    expect(cross).toEqual(unknown);
    expect(cross.status).toBe(404);
    expect((await app.request("/fettler/gates", { method: "POST", headers: auth(tokenA), body: JSON.stringify({ providerSlug: "shared-vendor" }) })).status).toBe(200);
  });

  it("POST /fettler/review (and /warden alias): b-private is indistinguishable from an unknown slug", async () => {
    const unknown = await body(await app.request("/fettler/review", { method: "POST", headers: auth(tokenA), body: JSON.stringify({ providerSlug: "no-such-slug" }) }));
    const cross = await body(await app.request("/fettler/review", { method: "POST", headers: auth(tokenA), body: JSON.stringify({ providerSlug: "b-private" }) }));
    expect(cross).toEqual(unknown);
    expect(cross.status).toBe(404);
    // The /warden alias enforces the same isolation.
    const wardenCross = await body(await app.request("/warden/review", { method: "POST", headers: auth(tokenA), body: JSON.stringify({ providerSlug: "b-private" }) }));
    expect(wardenCross).toEqual(unknown);
    expect((await app.request("/fettler/review", { method: "POST", headers: auth(tokenA), body: JSON.stringify({ providerSlug: "a-private" }) })).status).toBe(200);
  });

  it("GET /changes/:id: a change on b-private is indistinguishable from an unknown id", async () => {
    const unknown = await body(await app.request("/changes/change-missing", { headers: auth(tokenA) }));
    const cross = await body(await app.request(`/changes/${changeId.bPrivate}`, { headers: auth(tokenA) }));
    expect(cross).toEqual(unknown);
    expect(cross.status).toBe(404);
    expect((await app.request(`/changes/${changeId.aPrivate}`, { headers: auth(tokenA) })).status).toBe(200);
    expect((await app.request(`/changes/${changeId.shared}`, { headers: auth(tokenA) })).status).toBe(200);
  });

  it("GET /graph/changes/:id: a change on b-private is indistinguishable from an unknown id", async () => {
    const unknown = await body(await app.request("/graph/changes/change-missing", { headers: auth(tokenA) }));
    const cross = await body(await app.request(`/graph/changes/${changeId.bPrivate}`, { headers: auth(tokenA) }));
    expect(cross).toEqual(unknown);
    expect(cross.status).toBe(404);
    expect((await app.request(`/graph/changes/${changeId.aPrivate}`, { headers: auth(tokenA) })).status).toBe(200);
  });

  it("GET /consumers/:id/exposure: a stale monitored link to b-private shows nothing of B", async () => {
    const res = await app.request(`/consumers/${consumerAId}/exposure`, { headers: auth(tokenA) });
    expect(res.status).toBe(200);
    const report = (await res.json()) as { monitoredApis: Array<{ providerSlug: string; providerName: string }> };
    // The exposure route passes the caller's tenant to buildExposureReport, so B's private
    // provider (linked by the stale monitored_apis row seeded in beforeAll) is filtered out.
    expect(report.monitoredApis.map((m) => m.providerSlug)).not.toContain("b-private");
    expect(JSON.stringify(report)).not.toContain("b-private");
  });
});

describe("HTTP cross-tenant isolation — links/jobs/polls never reach B's private provider", () => {
  it("POST /consumers/:id/monitor: b-private is indistinguishable from an unknown slug", async () => {
    const unknown = await body(await app.request(`/consumers/${consumerAId}/monitor`, { method: "POST", headers: auth(tokenA), body: JSON.stringify({ providerSlug: "no-such-slug" }) }));
    const cross = await body(await app.request(`/consumers/${consumerAId}/monitor`, { method: "POST", headers: auth(tokenA), body: JSON.stringify({ providerSlug: "b-private" }) }));
    expect(cross).toEqual(unknown);
    expect(cross.status).toBe(404);
    // Positive control: A can monitor a shared provider.
    expect((await app.request(`/consumers/${consumerAId}/monitor`, { method: "POST", headers: auth(tokenA), body: JSON.stringify({ providerSlug: "shared-vendor" }) })).status).toBe(201);
  });

  it("POST /jobs/fanout: b-private is indistinguishable from an unknown slug", async () => {
    const unknown = await body(await app.request("/jobs/fanout", { method: "POST", headers: auth(tokenA), body: JSON.stringify({ providerSlug: "no-such-slug" }) }));
    const cross = await body(await app.request("/jobs/fanout", { method: "POST", headers: auth(tokenA), body: JSON.stringify({ providerSlug: "b-private" }) }));
    expect(cross).toEqual(unknown);
    expect(cross.status).toBe(404);
    // Positive control: fanout over a shared provider is queued.
    expect((await app.request("/jobs/fanout", { method: "POST", headers: auth(tokenA), body: JSON.stringify({ providerSlug: "shared-vendor" }) })).status).toBe(201);
  });

  it("POST /feeds/poll: tenant A's poll writes nothing to B's private provider", async () => {
    const before = db.raw.prepare(`SELECT COUNT(*) AS c FROM api_versions WHERE provider_id = (SELECT id FROM providers WHERE slug = 'b-private')`).get() as { c: number };
    const res = await app.request("/feeds/poll", {
      method: "POST",
      headers: auth(tokenA),
      body: JSON.stringify({ localOnly: true, runPipeline: false, slugs: ["b-private"] }),
    });
    expect(res.status).toBe(200);
    const results = ((await res.json()) as { results: Array<{ slug: string }> }).results;
    expect(results.find((r) => r.slug === "b-private")).toBeUndefined();
    const after = db.raw.prepare(`SELECT COUNT(*) AS c FROM api_versions WHERE provider_id = (SELECT id FROM providers WHERE slug = 'b-private')`).get() as { c: number };
    expect(after.c).toBe(before.c);
  });
});

describe("HTTP cross-tenant isolation — provider mutation routes have no existence oracle", () => {
  const mutation = [
    { name: "PATCH /providers/:slug/feed", method: "PATCH", suffix: "/feed", payload: { openapiUrl: "file:/x.json" } },
    { name: "POST /providers/:slug/versions", method: "POST", suffix: "/versions", payload: { versionLabel: "9", openapi: { openapi: "3.0.0", info: { title: "x", version: "9" }, paths: {} } } },
    { name: "POST /providers/:slug/publish-version", method: "POST", suffix: "/publish-version", payload: { versionLabel: "9", openapi: { openapi: "3.0.0", info: { title: "x", version: "9" }, paths: {} } } },
    { name: "POST /providers/:slug/publish", method: "POST", suffix: "/publish", payload: {} },
  ] as const;

  for (const route of mutation) {
    it(`${route.name}: b-private returns the same 404 as an unknown slug (no oracle)`, async () => {
      const unknown = await body(await app.request(`/providers/no-such-slug${route.suffix}`, { method: route.method, headers: auth(tokenA), body: JSON.stringify(route.payload) }));
      const cross = await body(await app.request(`/providers/b-private${route.suffix}`, { method: route.method, headers: auth(tokenA), body: JSON.stringify(route.payload) }));
      expect(cross).toEqual(unknown);
      expect(cross.status).toBe(404);
      // A VISIBLE provider the caller may not mutate (the shared catalog, for a non-system-admin
      // tenant owner) stays a 403 — distinct from the 404 above.
      const shared = await app.request(`/providers/shared-vendor${route.suffix}`, { method: route.method, headers: auth(tokenA), body: JSON.stringify(route.payload) });
      expect(shared.status).toBe(403);
    });
  }

  it("POST /providers/:slug/versions: positive control — A mutates its own private provider", async () => {
    const res = await app.request("/providers/a-private/versions", {
      method: "POST",
      headers: auth(tokenA),
      body: JSON.stringify({ versionLabel: "3", openapi: { openapi: "3.0.0", info: { title: "a", version: "3" }, paths: {} } }),
    });
    expect(res.status).toBe(201);
  });

  it("requires authentication (no token → 401, never a leak)", async () => {
    const res = await app.request("/changes/change-b-private");
    expect(res.status).toBe(401);
  });
});
