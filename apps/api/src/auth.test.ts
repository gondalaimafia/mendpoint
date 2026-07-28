import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createApiKey, createDb } from "@mendpoint/db";
import {
  createAuthMiddleware,
  isExemptPath,
  roleFromApiKeyScopes,
  scopeAllows,
  type ApiEnv,
} from "./auth.js";

const dirs: string[] = [];
const dbs: Array<ReturnType<typeof createDb>> = [];
const originalAuth = process.env.API_AUTH;

afterEach(() => {
  if (originalAuth === undefined) delete process.env.API_AUTH;
  else process.env.API_AUTH = originalAuth;
  for (const db of dbs.splice(0)) {
    db.raw.close();
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may briefly retain SQLite handles after close.
    }
  }
});

function testDb() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-auth-"));
  dirs.push(dir);
  const db = createDb(join(dir, "test.sqlite"));
  dbs.push(db);
  return db;
}

describe("API authentication identity", () => {
  it("binds principal role and tenant to the API key instead of request headers", async () => {
    process.env.API_AUTH = "required";
    const db = testDb();
    const created = createApiKey(db, {
      id: "key-owner",
      name: "owner",
      tenantId: "tenant-a",
      scopes: ["*"],
      createdAt: new Date().toISOString(),
    });
    const app = new Hono<ApiEnv>();
    app.use("*", createAuthMiddleware(db));
    app.get("/private", (c) =>
      c.json({
        principal: c.get("principal"),
        scopes: c.get("authScopes"),
      }),
    );

    const response = await app.request("/private", {
      headers: {
        Authorization: `Bearer ${created.token}`,
        "X-Role": "viewer",
        "X-Tenant-Id": "tenant-victim",
        "X-User-Id": "spoofed",
      },
    });
    const body = (await response.json()) as {
      principal: { id: string; tenantId: string; role: string };
      scopes: string[];
    };

    expect(response.status).toBe(200);
    expect(body.principal).toEqual({
      id: "api-key:key-owner",
      tenantId: "tenant-a",
      role: "owner",
    });
    expect(body.scopes).toEqual(["*"]);
  });

  it("fails closed for malformed scopes and enforces explicit permissions", () => {
    expect(roleFromApiKeyScopes(["role:bogus"])).toBe("viewer");
    expect(scopeAllows(["role:engineer", "graph:read"], "graph:read")).toBe(true);
    expect(scopeAllows(["role:engineer", "graph:read"], "graph:write")).toBe(false);
  });

  it("does not exempt GitHub App inventory or callbacks", () => {
    expect(isExemptPath("/github/app/installations")).toBe(false);
    expect(isExemptPath("/github/app/callback")).toBe(false);
  });
});
