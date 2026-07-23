import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  insertProvider,
  recordAudit,
  listProviders,
  listAudit,
  createApiKey,
  findApiKeyByToken,
  revokeApiKey,
  countActiveApiKeys,
  insertFeedPoll,
  listFeedPolls,
  latestSuccessfulHash,
  insertTenant,
  listTenants,
  updateTenantPlan,
  upsertGitHubInstallation,
  listGitHubInstallations,
} from "./index.js";
import { newId, nowIso } from "@mendpoint/shared";

const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];

afterEach(() => {
  while (dbs.length) {
    const db = dbs.pop();
    try {
      db?.raw.close?.();
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
        /* ignore lock races on Windows */
      }
    }
  }
});

describe("db", () => {
  it("creates tables and records audit", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-db-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    insertProvider(db, {
      id: newId(),
      slug: "x",
      name: "X",
      website: null,
      createdAt: nowIso(),
    });
    recordAudit(db, {
      actor: "test",
      action: "ping",
      resourceType: "system",
    });
    expect(listProviders(db)).toHaveLength(1);
    expect(listAudit(db).some((a) => a.action === "ping")).toBe(true);
  });

  it("api keys hash and revoke", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-keys-"));
    dirs.push(dir);
    const db = createDb(join(dir, "k.sqlite"));
    dbs.push(db);
    const created = createApiKey(db, {
      id: newId(),
      name: "ci",
      tenantId: "t1",
      createdAt: nowIso(),
    });
    expect(created.token.startsWith("me_")).toBe(true);
    expect(findApiKeyByToken(db, created.token)?.tenant_id).toBe("t1");
    expect(findApiKeyByToken(db, "me_nope")).toBeUndefined();
    expect(countActiveApiKeys(db)).toBe(1);
    revokeApiKey(db, created.id, nowIso());
    expect(findApiKeyByToken(db, created.token)).toBeUndefined();
    expect(countActiveApiKeys(db)).toBe(0);
  });

  it("feed poll ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-feed-"));
    dirs.push(dir);
    const db = createDb(join(dir, "f.sqlite"));
    dbs.push(db);
    insertFeedPoll(db, {
      id: newId(),
      providerSlug: "acme-payments",
      openapiUrl: "file:x.json",
      contentHash: "abc123",
      versionLabel: "2.0.0",
      status: "new_version",
      polledAt: nowIso(),
    });
    expect(listFeedPolls(db)).toHaveLength(1);
    expect(latestSuccessfulHash(db, "acme-payments")).toBe("abc123");
  });

  it("tenants and github installations", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-tenant-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    // default tenant seeded by migrate
    expect(listTenants(db).some((t) => t.slug === "default")).toBe(true);
    const id = newId();
    insertTenant(db, {
      id,
      slug: "acme-co",
      name: "Acme Co",
      plan: "free",
      createdAt: nowIso(),
    });
    updateTenantPlan(db, id, "pro");
    expect(listTenants(db).find((t) => t.id === id)?.plan).toBe("pro");
    upsertGitHubInstallation(db, {
      id: newId(),
      installationId: "42",
      accountLogin: "acme-co",
      tenantId: id,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    expect(listGitHubInstallations(db)).toHaveLength(1);
  });
});

