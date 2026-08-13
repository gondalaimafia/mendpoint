import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb, getConnector } from "@mendpoint/db";
import { createConnectorsRoutes } from "./connectors.js";
import type { ApiEnv } from "./auth.js";

const NOW = "2026-08-13T12:00:00.000Z";

const identities = {
  "owner-a": { id: "human:owner-a@example.com", tenantId: "tenant-a", role: "owner" as const },
  "owner-b": { id: "human:owner-b@example.com", tenantId: "tenant-b", role: "owner" as const },
} as const;

const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close?.();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-api-connectors-"));
  dirs.push(dir);
  const db = createDb(join(dir, "api.sqlite"));
  dbs.push(db);
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "") as keyof typeof identities | undefined;
    const principal = token ? identities[token] : undefined;
    if (principal) {
      c.set("principal", principal);
      c.set("requestId", `request-${token}`);
    }
    return next();
  });
  app.route("/self-serve/connectors", createConnectorsRoutes({ db, enabled, env: {}, now: () => NOW }));
  return { app, db };
}

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("connectors routes — flag gating", () => {
  it("404s on every route when the flag is off", async () => {
    const { app } = fixture(false);
    const list = await app.request("/self-serve/connectors", { headers: headers("owner-a") });
    expect(list.status).toBe(404);
    const catalog = await app.request("/self-serve/connectors/catalog", { headers: headers("owner-a") });
    expect(catalog.status).toBe(404);
    const connect = await app.request("/self-serve/connectors", {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify({ kind: "ci", provider: "github_actions", displayName: "Acme" }),
    });
    expect(connect.status).toBe(404);
  });

  it("serves the catalog when enabled", async () => {
    const { app } = fixture(true);
    const res = await app.request("/self-serve/connectors/catalog", { headers: headers("owner-a") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { families: Array<{ kind: string; provider: string }> };
    expect(body.families.some((f) => f.kind === "ci" && f.provider === "github_actions")).toBe(true);
  });
});

describe("connectors routes — connect + verify (mock)", () => {
  it("connects a mock CI connector and verifies it, tenant-scoped", async () => {
    const { app, db } = fixture(true);
    const connect = await app.request("/self-serve/connectors", {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify({ kind: "ci", provider: "github_actions", displayName: "Acme CI" }),
    });
    expect(connect.status).toBe(201);
    const created = (await connect.json()) as { connector: { id: string; available: boolean; healthStatus: string } };
    expect(created.connector.healthStatus).toBe("unverified");
    expect(created.connector.available).toBe(false);

    const verify = await app.request(`/self-serve/connectors/${created.connector.id}/verify`, {
      method: "POST",
      headers: headers("owner-a"),
    });
    expect(verify.status).toBe(200);
    const verified = (await verify.json()) as { connector: { available: boolean; verified: boolean }; health: { ok: boolean } };
    expect(verified.health.ok).toBe(true);
    expect(verified.connector.verified).toBe(true);
    expect(verified.connector.available).toBe(true);

    // Persisted, tenant-scoped.
    expect(getConnector(db, created.connector.id, "tenant-a")?.verified).toBe(1);
    expect(getConnector(db, created.connector.id, "tenant-b")).toBeUndefined();
  });

  it("never lets one tenant see or verify another tenant's connector", async () => {
    const { app } = fixture(true);
    const connect = await app.request("/self-serve/connectors", {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify({ kind: "ticketing", provider: "jira", displayName: "Acme Jira" }),
    });
    const created = (await connect.json()) as { connector: { id: string } };

    // Tenant B's list is empty.
    const listB = await app.request("/self-serve/connectors", { headers: headers("owner-b") });
    expect(((await listB.json()) as { connectors: unknown[] }).connectors).toHaveLength(0);

    // Tenant B cannot verify or disconnect tenant A's connector.
    const verifyB = await app.request(`/self-serve/connectors/${created.connector.id}/verify`, {
      method: "POST",
      headers: headers("owner-b"),
    });
    expect(verifyB.status).toBe(404);
    const deleteB = await app.request(`/self-serve/connectors/${created.connector.id}`, {
      method: "DELETE",
      headers: headers("owner-b"),
    });
    expect(deleteB.status).toBe(404);
  });
});

describe("connectors routes — credentials + fail-closed", () => {
  it("seals a submitted token as an envelope and never stores plaintext", async () => {
    const { app, db } = fixture(true);
    const token = "glpat-super-secret-token";
    const connect = await app.request("/self-serve/connectors", {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify({
        kind: "ci",
        provider: "gitlab_ci",
        displayName: "Acme GitLab",
        mode: "real",
        token,
        apiBaseUrl: "https://gitlab.com/api/v4",
      }),
    });
    expect(connect.status).toBe(201);
    const created = (await connect.json()) as { connector: { id: string; credentialConfigured: boolean } };
    expect(created.connector.credentialConfigured).toBe(true);

    const row = getConnector(db, created.connector.id, "tenant-a")!;
    expect(row.credential_envelope).toBeTruthy();
    // The stored row (envelope + config) must not contain the plaintext token.
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("fails closed when a real connector is verified without a credential", async () => {
    const { app, db } = fixture(true);
    // Connect real mode but submit no token.
    const connect = await app.request("/self-serve/connectors", {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify({ kind: "ci", provider: "github_actions", displayName: "No Creds", mode: "real" }),
    });
    const created = (await connect.json()) as { connector: { id: string } };
    const verify = await app.request(`/self-serve/connectors/${created.connector.id}/verify`, {
      method: "POST",
      headers: headers("owner-a"),
    });
    expect(verify.status).toBe(422);
    const body = (await verify.json()) as { connector: { available: boolean }; health: { ok: boolean; errorCode: string; errorHint: string } };
    expect(body.health.ok).toBe(false);
    expect(body.health.errorCode).toBe("github_actions_credential_required");
    expect(body.health.errorHint).toMatch(/credential/i);
    expect(body.connector.available).toBe(false);
    expect(getConnector(db, created.connector.id, "tenant-a")?.health_status).toBe("failed");
  });

  it("disconnects (revokes) a connector", async () => {
    const { app, db } = fixture(true);
    const connect = await app.request("/self-serve/connectors", {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify({ kind: "docs", provider: "markdown_repo", displayName: "Repo docs" }),
    });
    const created = (await connect.json()) as { connector: { id: string } };
    const del = await app.request(`/self-serve/connectors/${created.connector.id}`, {
      method: "DELETE",
      headers: headers("owner-a"),
    });
    expect(del.status).toBe(200);
    expect(getConnector(db, created.connector.id, "tenant-a")?.health_status).toBe("revoked");
  });

  it("rejects an unauthenticated caller", async () => {
    const { app } = fixture(true);
    const res = await app.request("/self-serve/connectors", { headers: { "content-type": "application/json" } });
    expect(res.status).toBe(401);
  });

  it("validates kind and provider", async () => {
    const { app } = fixture(true);
    const badKind = await app.request("/self-serve/connectors", {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify({ kind: "bogus", provider: "github_actions", displayName: "X" }),
    });
    expect(badKind.status).toBe(422);
    const badProvider = await app.request("/self-serve/connectors", {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify({ kind: "ci", provider: "jenkins", displayName: "X" }),
    });
    expect(badProvider.status).toBe(422);
  });
});
