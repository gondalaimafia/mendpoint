import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiKey, createDb, type AppDb } from "@mendpoint/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthMiddleware, type ApiEnv } from "./auth.js";
import { createGraphQLSchemaIngestionRoutes, graphqlSchemaIngestionEnabled } from "./graphql-schema-ingestion.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];
const originalAuth = process.env.API_AUTH;

afterEach(() => {
  if (originalAuth === undefined) delete process.env.API_AUTH;
  else process.env.API_AUTH = originalAuth;
  while (dbs.length) dbs.pop()?.raw.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fixture(enabled = true) {
  process.env.API_AUTH = "required";
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-graphql-api-"));
  dirs.push(dir);
  const db = createDb(join(dir, "app.sqlite"));
  dbs.push(db);
  const tenantA = createApiKey(db, { id: `key-a-${dirs.length}`, name: "A", tenantId: "tenant-a", scopes: ["*"], createdAt: "2026-08-12T12:00:00.000Z" });
  const tenantB = createApiKey(db, { id: `key-b-${dirs.length}`, name: "B", tenantId: "tenant-b", scopes: ["*"], createdAt: "2026-08-12T12:00:00.000Z" });
  const app = new Hono<ApiEnv>();
  app.use("*", createAuthMiddleware(db));
  app.route("/graphql/schemas", createGraphQLSchemaIngestionRoutes({ db, enabled, now: (() => { let n = 0; return () => `2026-08-12T12:0${n++}:00.000Z`; })() }));
  return { app, tenantA: tenantA.token, tenantB: tenantB.token };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" });

describe("GraphQL schema ingestion API", () => {
  it("is unavailable by default and only enables on the exact flag", async () => {
    expect(graphqlSchemaIngestionEnabled({})).toBe(false);
    expect(graphqlSchemaIngestionEnabled({ MENDPOINT_GRAPHQL_INGESTION_ENABLED: "true" })).toBe(false);
    expect(graphqlSchemaIngestionEnabled({ MENDPOINT_GRAPHQL_INGESTION_ENABLED: "1" })).toBe(true);
    const { app, tenantA } = fixture(false);
    const response = await app.request("/graphql/schemas/payments/versions", { method: "POST", headers: auth(tenantA), body: JSON.stringify({ versionLabel: "v1", format: "sdl", schema: "type Query { ok: Boolean! }" }) });
    expect(response.status).toBe(404);
  });

  it("requires authenticated tenant identity and rejects caller tenant fields", async () => {
    const { app, tenantA } = fixture();
    expect((await app.request("/graphql/schemas/payments/versions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ versionLabel: "v1", format: "sdl", schema: "type Query { ok: Boolean! }" }) })).status).toBe(401);
    const injected = await app.request("/graphql/schemas/payments/versions", { method: "POST", headers: auth(tenantA), body: JSON.stringify({ tenantId: "tenant-b", versionLabel: "v1", format: "sdl", schema: "type Query { ok: Boolean! }" }) });
    expect(injected.status).toBe(400);
    expect(await injected.json()).toMatchObject({ error: "graphql_request_keys_invalid" });
  });

  it("ingests SDL, selects the latest baseline, and returns structured breaking evidence", async () => {
    const { app, tenantA } = fixture();
    const first = await app.request("/graphql/schemas/payments/versions", { method: "POST", headers: auth(tenantA), body: JSON.stringify({ versionLabel: "v1", format: "sdl", schema: "type Query { charge(id: ID!): String! }" }) });
    expect(first.status).toBe(201);
    expect(first.headers.get("location")).toMatch(/^\/graphql\/schemas\/payments\/versions\//);
    const v1 = await first.json() as { id: string; evidenceId: string; baselineVersionId: null; classification: string };
    expect(v1).toMatchObject({ baselineVersionId: null, classification: "non_breaking" });
    expect(v1.evidenceId).toMatch(/^graphql-evidence-/);

    const second = await app.request("/graphql/schemas/payments/versions", { method: "POST", headers: auth(tenantA), body: JSON.stringify({ versionLabel: "v2", format: "sdl", schema: "type Query { charge(id: ID!): Int! }" }) });
    expect(second.status).toBe(201);
    const v2 = await second.json() as { id: string; baselineVersionId: string; classification: string; changes: Array<{ coordinate: string; classification: string; migrationHint: string; oldLocation: unknown; newLocation: unknown }> };
    expect(v2.baselineVersionId).toBe(v1.id);
    expect(v2.classification).toBe("breaking");
    expect(v2.changes).toEqual(expect.arrayContaining([expect.objectContaining({ coordinate: "Query.charge", classification: "breaking", migrationHint: expect.any(String), oldLocation: expect.any(Object), newLocation: expect.any(Object) })]));

    const list = await app.request("/graphql/schemas/payments/versions", { headers: auth(tenantA) });
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect((await list.json() as { versions: Array<{ id: string }> }).versions.map((item) => item.id)).toEqual([v2.id, v1.id]);
    const get = await app.request(`/graphql/schemas/payments/versions/${v2.id}`, { headers: auth(tenantA) });
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ id: v2.id, schema: { sourceFormat: "sdl", digest: expect.stringMatching(/^sha256:/) } });

    const additive = await app.request("/graphql/schemas/payments/versions", { method: "POST", headers: auth(tenantA), body: JSON.stringify({ versionLabel: "v3-from-v1", format: "sdl", baselineVersionId: v1.id, schema: "type Query { charge(id: ID!): String! refund: Boolean }" }) });
    expect(additive.status).toBe(201);
    expect(await additive.json()).toMatchObject({ baselineVersionId: v1.id, classification: "additive", changes: expect.arrayContaining([expect.objectContaining({ coordinate: "Query.refund", classification: "additive" })]) });
  });

  it("accepts introspection JSON, explicit baselines, exact replay, and rejects conflicting labels", async () => {
    const { app, tenantA } = fixture();
    const introspection = { __schema: { queryType: { name: "Query" }, mutationType: null, subscriptionType: null, types: [
      { kind: "OBJECT", name: "Query", description: null, fields: [{ name: "ok", description: null, args: [], type: { kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "Boolean", ofType: null } }, isDeprecated: false, deprecationReason: null }], inputFields: null, interfaces: [], enumValues: null, possibleTypes: null },
      { kind: "SCALAR", name: "Boolean", description: null, fields: null, inputFields: null, interfaces: null, enumValues: null, possibleTypes: null },
      { kind: "SCALAR", name: "String", description: null, fields: null, inputFields: null, interfaces: null, enumValues: null, possibleTypes: null },
    ], directives: [] } };
    const body = { versionLabel: "intro-v1", format: "introspection", schema: introspection };
    const first = await app.request("/graphql/schemas/catalog/versions", { method: "POST", headers: auth(tenantA), body: JSON.stringify(body) });
    expect(first.status).toBe(201);
    const record = await first.json() as { id: string; schema: { sourceFormat: string } };
    expect(record.schema.sourceFormat).toBe("introspection");
    const replay = await app.request("/graphql/schemas/catalog/versions", { method: "POST", headers: auth(tenantA), body: JSON.stringify(body) });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: record.id, replayed: true });
    const conflict = await app.request("/graphql/schemas/catalog/versions", { method: "POST", headers: auth(tenantA), body: JSON.stringify({ ...body, schema: { ...introspection, extra: true } }) });
    expect(conflict.status).toBe(409);
    const changedBaseline = await app.request("/graphql/schemas/catalog/versions", { method: "POST", headers: auth(tenantA), body: JSON.stringify({ ...body, baselineVersionId: "missing-version" }) });
    expect(changedBaseline.status).toBe(404);
  });

  it("keeps retrieval and explicit baselines tenant and source scoped", async () => {
    const { app, tenantA, tenantB } = fixture();
    const created = await app.request("/graphql/schemas/payments/versions", { method: "POST", headers: auth(tenantA), body: JSON.stringify({ versionLabel: "v1", format: "sdl", schema: "type Query { ok: Boolean! }" }) });
    const record = await created.json() as { id: string };
    expect((await app.request(`/graphql/schemas/payments/versions/${record.id}`, { headers: auth(tenantB) })).status).toBe(404);
    const deniedBaseline = await app.request("/graphql/schemas/payments/versions", { method: "POST", headers: auth(tenantB), body: JSON.stringify({ versionLabel: "v2", format: "sdl", schema: "type Query { ok: Boolean }", baselineVersionId: record.id }) });
    expect(deniedBaseline.status).toBe(404);
  });

  it("rejects malformed, mismatched, and oversized requests without durable writes", async () => {
    const { app, tenantA } = fixture();
    const malformed = await app.request("/graphql/schemas/payments/versions", { method: "POST", headers: auth(tenantA), body: "{" });
    expect(malformed.status).toBe(400);
    const mismatch = await app.request("/graphql/schemas/payments/versions", { method: "POST", headers: auth(tenantA), body: JSON.stringify({ versionLabel: "v1", format: "sdl", schema: { __schema: {} } }) });
    expect(mismatch.status).toBe(400);
    const oversized = await app.request("/graphql/schemas/payments/versions", { method: "POST", headers: auth(tenantA), body: JSON.stringify({ versionLabel: "huge", format: "sdl", schema: `type Query { value: String }${" ".repeat(2_100_000)}` }) });
    expect(oversized.status).toBe(413);
    const list = await app.request("/graphql/schemas/payments/versions", { headers: auth(tenantA) });
    expect(await list.json()).toEqual({ versions: [] });
  });

  it("is mounted into the application behind the exact default-off flag", () => {
    const server = readFileSync(join(import.meta.dirname, "server.ts"), "utf8");
    expect(server).toContain("graphqlSchemaIngestionEnabled(process.env)");
    expect(server).toContain('app.route("/graphql/schemas"');
  });
});
