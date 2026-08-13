import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  getConnector,
  listConnectors,
  registerConnector,
  revokeConnector,
  setConnectorHealth,
} from "./index.js";

const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];
const at = "2026-08-13T12:00:00.000Z";

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close?.();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-connectors-"));
  dirs.push(dir);
  const db = createDb(join(dir, "connectors.sqlite"));
  dbs.push(db);
  return db;
}

describe("connectors storage", () => {
  it("registers and reads a connector, tenant-scoped", () => {
    const db = setup();
    const row = registerConnector(db, {
      id: "conn-1",
      tenantId: "tenant-a",
      kind: "ci",
      provider: "github_actions",
      displayName: "Acme GitHub Actions",
      mode: "mock",
      createdAt: at,
      updatedAt: at,
    });
    expect(row.health_status).toBe("unverified");
    expect(row.verified).toBe(0);
    expect(listConnectors(db, "tenant-a")).toHaveLength(1);
    expect(listConnectors(db, "tenant-a", "ci")).toHaveLength(1);
    expect(listConnectors(db, "tenant-a", "ticketing")).toHaveLength(0);
    // Another tenant sees nothing.
    expect(listConnectors(db, "tenant-b")).toHaveLength(0);
    expect(getConnector(db, "conn-1", "tenant-b")).toBeUndefined();
  });

  it("stores the credential envelope JSON, never plaintext", () => {
    const db = setup();
    const envelope = JSON.stringify({ ciphertext: "abc==", algorithm: "AES-256-GCM" });
    registerConnector(db, {
      id: "conn-2",
      tenantId: "tenant-a",
      kind: "ticketing",
      provider: "jira",
      displayName: "Acme Jira",
      mode: "real",
      credentialEnvelope: envelope,
      configJson: JSON.stringify({ apiBaseUrl: "https://acme.atlassian.net" }),
      createdAt: at,
      updatedAt: at,
    });
    const row = getConnector(db, "conn-2", "tenant-a")!;
    expect(row.credential_envelope).toBe(envelope);
    expect(row.config_json).toContain("acme.atlassian.net");
  });

  it("refuses cross-tenant id reuse", () => {
    const db = setup();
    registerConnector(db, {
      id: "conn-3",
      tenantId: "tenant-a",
      kind: "docs",
      provider: "notion",
      displayName: "Acme Notion",
      mode: "mock",
      createdAt: at,
      updatedAt: at,
    });
    expect(() =>
      registerConnector(db, {
        id: "conn-3",
        tenantId: "tenant-b",
        kind: "docs",
        provider: "notion",
        displayName: "Beta Notion",
        mode: "mock",
        createdAt: at,
        updatedAt: at,
      }),
    ).toThrow("connector_tenant_mismatch");
  });

  it("records verification health and re-arms on re-register", () => {
    const db = setup();
    registerConnector(db, {
      id: "conn-4",
      tenantId: "tenant-a",
      kind: "ci",
      provider: "gitlab_ci",
      displayName: "Acme GitLab",
      mode: "mock",
      createdAt: at,
      updatedAt: at,
    });
    const verified = setConnectorHealth(db, {
      id: "conn-4",
      tenantId: "tenant-a",
      healthStatus: "verified",
      verified: true,
      lastVerifiedAt: at,
      updatedAt: at,
    });
    expect(verified.health_status).toBe("verified");
    expect(verified.verified).toBe(1);
    // Re-registering resets verification (must re-verify before use).
    const rearmed = registerConnector(db, {
      id: "conn-4",
      tenantId: "tenant-a",
      kind: "ci",
      provider: "gitlab_ci",
      displayName: "Acme GitLab",
      mode: "mock",
      createdAt: at,
      updatedAt: at,
    });
    expect(rearmed.health_status).toBe("unverified");
    expect(rearmed.verified).toBe(0);
  });

  it("cannot set health on another tenant's connector", () => {
    const db = setup();
    registerConnector(db, {
      id: "conn-5",
      tenantId: "tenant-a",
      kind: "ci",
      provider: "github_actions",
      displayName: "Acme",
      mode: "mock",
      createdAt: at,
      updatedAt: at,
    });
    expect(() =>
      setConnectorHealth(db, {
        id: "conn-5",
        tenantId: "tenant-b",
        healthStatus: "verified",
        verified: true,
        updatedAt: at,
      }),
    ).toThrow("connector_tenant_mismatch");
  });

  it("revokes idempotently and blocks further writes", () => {
    const db = setup();
    registerConnector(db, {
      id: "conn-6",
      tenantId: "tenant-a",
      kind: "ci",
      provider: "github_actions",
      displayName: "Acme",
      mode: "mock",
      createdAt: at,
      updatedAt: at,
    });
    const revoked = revokeConnector(db, { id: "conn-6", tenantId: "tenant-a", revokedAt: at });
    expect(revoked.health_status).toBe("revoked");
    expect(revoked.revoked_at).toBe(at);
    // Revoked-at is immutable on a second revoke.
    const again = revokeConnector(db, { id: "conn-6", tenantId: "tenant-a", revokedAt: "2027-01-01T00:00:00.000Z" });
    expect(again.revoked_at).toBe(at);
    // Re-registering a revoked connector fails closed.
    expect(() =>
      registerConnector(db, {
        id: "conn-6",
        tenantId: "tenant-a",
        kind: "ci",
        provider: "github_actions",
        displayName: "Acme",
        mode: "mock",
        createdAt: at,
        updatedAt: at,
      }),
    ).toThrow("connector_revoked");
  });

  it("boots on a pre-connectors schema and converges to the fresh shape", () => {
    // Pre-change production shape: a database created before the connectors table
    // existed. createDb runs the static DDL (CREATE TABLE IF NOT EXISTS) before
    // migrations, so booting must add the new table + index and never throw.
    const legacyDir = mkdtempSync(join(tmpdir(), "mendpoint-connectors-legacy-"));
    dirs.push(legacyDir);
    const legacyPath = join(legacyDir, "legacy.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        error TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
    `);
    legacy.close();

    const migrated = createDb(legacyPath);
    dbs.push(migrated);
    const freshDir = mkdtempSync(join(tmpdir(), "mendpoint-connectors-fresh-"));
    dirs.push(freshDir);
    const fresh = createDb(join(freshDir, "fresh.sqlite"));
    dbs.push(fresh);

    const columnsOf = (db: { raw: DatabaseSync }, table: string) =>
      (db.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((c) => c.name)
        .sort();
    const indexesOf = (db: { raw: DatabaseSync }, table: string) =>
      (db.raw.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>)
        .map((i) => i.name)
        .sort();

    expect(columnsOf(migrated, "connectors")).toEqual(columnsOf(fresh, "connectors"));
    expect(indexesOf(migrated, "connectors")).toEqual(indexesOf(fresh, "connectors"));
    expect(columnsOf(migrated, "connectors")).toContain("credential_envelope");
    // The migrated database is writable through the new connectors path.
    expect(() =>
      registerConnector(migrated, {
        id: "conn-boot",
        tenantId: "tenant_default",
        kind: "ci",
        provider: "github_actions",
        displayName: "Boot",
        mode: "mock",
        createdAt: at,
        updatedAt: at,
      }),
    ).not.toThrow();
  });

  it("is idempotent across a double boot on the same path", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-connectors-double-"));
    dirs.push(dir);
    const path = join(dir, "twice.sqlite");
    const first = createDb(path);
    registerConnector(first, {
      id: "conn-persist",
      tenantId: "tenant-a",
      kind: "docs",
      provider: "markdown_repo",
      displayName: "Repo docs",
      mode: "mock",
      createdAt: at,
      updatedAt: at,
    });
    first.raw.close?.();
    // Second boot on the same file must not throw and must preserve the row.
    const second = createDb(path);
    dbs.push(second);
    expect(getConnector(second, "conn-persist", "tenant-a")?.provider).toBe("markdown_repo");
  });
});
