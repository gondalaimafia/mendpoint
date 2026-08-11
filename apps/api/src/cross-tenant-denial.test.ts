/**
 * Route-level cross-tenant denial matrix (Wave 3a tenancy hardening).
 *
 * Drives the migration-PR review routes — which read PRs through the now-mandatory
 * tenant-scoped getPr(db, id, principal.tenantId) — with two tenants and asserts that a
 * principal from tenant B can never read or mutate tenant A's PR by id. It also pins the
 * fail-open closure at the route boundary: a principal carrying a blank tenantId is denied
 * (never served another tenant's row).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDb,
  insertApiChange,
  insertApiVersion,
  insertConsumer,
  insertMigrationPr,
  insertProvider,
  type AppDb,
} from "@mendpoint/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiEnv } from "./auth.js";
import { createMigrationPrReviewRoutes } from "./review-routes.js";

const NOW = "2026-08-02T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];

afterEach(() => {
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function seedPr(db: AppDb, tenantId: string, s: string): string {
  const providerId = `provider-${s}`;
  insertProvider(db, { id: providerId, slug: `provider-${s}`, name: `Provider ${s}`, createdAt: NOW });
  insertApiVersion(db, {
    id: `version-${s}-1`,
    providerId,
    versionLabel: "1",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: s, version: "1" } }),
    publishedAt: NOW,
  });
  insertApiVersion(db, {
    id: `version-${s}-2`,
    providerId,
    versionLabel: "2",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: s, version: "2" } }),
    publishedAt: NOW,
  });
  insertApiChange(db, {
    id: `change-${s}`,
    providerId,
    fromVersionId: `version-${s}-1`,
    toVersionId: `version-${s}-2`,
    risk: "breaking",
    summary: `Change ${s}`,
    diffJson: "[]",
    createdAt: NOW,
  });
  insertConsumer(db, {
    id: `consumer-${s}`,
    name: `Consumer ${s}`,
    githubOwner: "customer",
    githubRepo: `repo-${s}`,
    tenantId,
    createdAt: NOW,
  });
  insertMigrationPr(db, {
    id: `pr-${s}`,
    changeId: `change-${s}`,
    consumerId: `consumer-${s}`,
    title: `Migration ${s}`,
    body: "Candidate ready.",
    branchName: `mendpoint/${s}`,
    status: "draft",
    risk: "breaking",
    patchUnified: "",
    createdAt: NOW,
  });
  return `pr-${s}`;
}

const identities = {
  "owner-a": { id: "human:owner-a@example.com", tenantId: "tenant-a", role: "owner" as const },
  "owner-b": { id: "human:owner-b@example.com", tenantId: "tenant-b", role: "owner" as const },
  "blank-tenant": { id: "human:blank@example.com", tenantId: "", role: "owner" as const },
} as const;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-cross-tenant-api-"));
  const db = createDb(join(directory, "api.sqlite"));
  opened.push({ db, directory });
  const prA = seedPr(db, "tenant-a", "a");
  const prB = seedPr(db, "tenant-b", "b");
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "") as
      | keyof typeof identities
      | undefined;
    const principal = token ? identities[token] : undefined;
    if (principal) {
      c.set("principal", principal);
      c.set("requestId", `request-${token}`);
    }
    return next();
  });
  app.route("/prs", createMigrationPrReviewRoutes({ db, createId: () => "id", now: () => NOW }));
  return { app, prA, prB };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("route-level cross-tenant denial", () => {
  it("serves a PR only to its owning tenant", async () => {
    const { app, prA } = fixture();
    const own = await app.request(`/prs/${prA}/reviews`, { headers: auth("owner-a") });
    expect(own.status).toBe(200);
  });

  it("denies reading another tenant's PR by id (404, never the row)", async () => {
    const { app, prA, prB } = fixture();
    const crossRead = await app.request(`/prs/${prA}/reviews`, { headers: auth("owner-b") });
    expect(crossRead.status).toBe(404);
    await expect(crossRead.json()).resolves.toEqual({ error: "not found" });

    const reverse = await app.request(`/prs/${prB}/reviews`, { headers: auth("owner-a") });
    expect(reverse.status).toBe(404);
  });

  it("denies mutating another tenant's PR by id (404 before any write)", async () => {
    const { app, prA } = fixture();
    const crossWrite = await app.request(`/prs/${prA}/reviews`, {
      method: "POST",
      headers: auth("owner-b"),
      body: JSON.stringify({ decision: "approve", rationale: "Looks fine" }),
    });
    expect(crossWrite.status).toBe(404);
  });

  it("rejects unauthenticated access", async () => {
    const { app, prA } = fixture();
    const anon = await app.request(`/prs/${prA}/reviews`);
    expect(anon.status).toBe(401);
  });

  it("denies a principal carrying a blank tenantId rather than leaking a row", async () => {
    const { app, prA } = fixture();
    const blank = await app.request(`/prs/${prA}/reviews`, { headers: auth("blank-tenant") });
    // The mandatory tenant scope throws tenant_scope_required, so the row is never served.
    expect(blank.status).not.toBe(200);
    const text = await blank.text();
    expect(text).not.toContain("reviews");
  });
});
