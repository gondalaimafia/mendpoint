import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono, type Context } from "hono";
import {
  createDb,
  exportAuditCsv,
  exportAuditJson,
  insertTenant,
  recordAudit,
  type AppDb,
} from "@mendpoint/db";
import type { ApiEnv } from "./auth.js";
import { parseAuditExportLimit } from "./audit-export.js";

const roots: string[] = [];
const dbs: AppDb[] = [];
const at = "2026-08-30T12:00:00.000Z";

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/**
 * Mirror of server.ts's `/audit/export` handler and its `requestTenantId` guard,
 * bound to a test db. It exercises the same production units the route composes;
 * the source assertion below is what pins server.ts to those units.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-audit-export-route-"));
  roots.push(root);
  const db = createDb(join(root, "app.sqlite"));
  dbs.push(db);
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    insertTenant(db, { id: tenantId, slug: tenantId, name: tenantId, createdAt: at });
    recordAudit(db, {
      id: `audit-${tenantId}`,
      tenantId,
      actor: "api",
      action: "repository.connected",
      resourceType: "repository",
      resourceId: `repo-${tenantId}`,
    });
  }
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    const tenantId = c.req.header("x-tenant");
    if (tenantId !== undefined) {
      c.set("principal", { id: `human:${tenantId}`, tenantId, role: "owner" });
    }
    await next();
  });
  app.onError((error, c) => c.json({ error: error.message }, 500));
  app.get("/audit/export", (c) => {
    const format = c.req.query("format") ?? "json";
    let limit: number;
    try {
      limit = parseAuditExportLimit(c.req.query("limit"));
    } catch {
      return c.json({ error: "audit_export_limit_invalid" }, 400);
    }
    if (format === "csv") {
      const csv = exportAuditCsv(db, limit, requestTenantId(c));
      return c.body(csv, 200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="mendpoint-audit.csv"',
      });
    }
    return c.json(exportAuditJson(db, limit, requestTenantId(c)));
  });
  return { app, db };
}

function requestTenantId(c: Context<ApiEnv>): string {
  const principal = c.get("principal");
  if (!principal) throw new Error("authenticated_principal_required");
  if (principal.tenantId.trim() === "") throw new Error("tenant_scope_required");
  return principal.tenantId;
}

describe("audit export hardening", () => {
  it("accepts only positive bounded integer limits", () => {
    expect(parseAuditExportLimit(undefined)).toBe(2_000);
    expect(parseAuditExportLimit("")).toBe(2_000);
    expect(parseAuditExportLimit("1")).toBe(1);
    expect(parseAuditExportLimit("20000")).toBe(20_000);
    for (const value of ["0", "-1", "1.5", "20001", "NaN", "Infinity", "1e3"]) {
      expect(() => parseAuditExportLimit(value), value).toThrow("audit_export_limit_invalid");
    }
  });

  it("serves the tenant's audit records as JSON and CSV over a real request", async () => {
    const { app } = fixture();

    const asJson = await app.request("/audit/export", { headers: { "x-tenant": "tenant-a" } });
    expect(asJson.status).toBe(200);
    const body = await asJson.json() as { count: number; events: Array<{ id: string }> };
    expect(body.count).toBe(1);
    expect(body.events.map((row) => row.id)).toEqual(["audit-tenant-a"]);

    const asCsv = await app.request("/audit/export?format=csv", {
      headers: { "x-tenant": "tenant-a" },
    });
    expect(asCsv.status).toBe(200);
    expect(asCsv.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(asCsv.headers.get("Content-Disposition"))
      .toBe('attachment; filename="mendpoint-audit.csv"');
    const csv = await asCsv.text();
    expect(csv).toContain("audit-tenant-a");
    expect(csv).not.toContain("audit-tenant-b");
  });

  it("rejects an unusable limit and never serves another tenant's records", async () => {
    const { app } = fixture();

    const badLimit = await app.request("/audit/export?limit=20001", {
      headers: { "x-tenant": "tenant-a" },
    });
    expect(badLimit.status).toBe(400);
    expect(await badLimit.json()).toEqual({ error: "audit_export_limit_invalid" });

    const other = await app.request("/audit/export", { headers: { "x-tenant": "tenant-b" } });
    const body = await other.json() as { events: Array<{ id: string }> };
    expect(body.events.map((row) => row.id)).toEqual(["audit-tenant-b"]);

    // A blank tenant must fail closed rather than drop the filter.
    const blank = await app.request("/audit/export", { headers: { "x-tenant": " " } });
    expect(blank.status).toBe(500);
    expect(await blank.json()).toEqual({ error: "tenant_scope_required" });
  });

  it("keeps the published /audit/export route served by the live exporters", () => {
    const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    const start = source.indexOf('app.get("/audit/export"');
    expect(start).toBeGreaterThan(-1);
    const handler = source.slice(start, source.indexOf("\napp.", start + 1));

    // `GET /audit/export` is in the public route contract and the docs catalog,
    // and assertPublicDocsApiRoutesMounted only proves a handler is mounted, not
    // that it answers. This pins the handler to the exporters it documents.
    expect(handler).toContain("parseAuditExportLimit(");
    expect(handler).toContain("exportAuditCsv(");
    expect(handler).toContain("exportAuditJson(");
    expect(handler).not.toMatch(/\b(?:410|gone|governed_audit_export_required)\b/i);
  });
});
