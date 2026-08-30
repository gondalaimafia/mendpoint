import {
  createApiKey,
  createDb,
  getPrincipal,
  listApiKeys,
  listAudit,
  type AppDb,
} from "@mendpoint/db";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapScimAuthorities } from "./scim-bootstrap.js";
import { scimBindingsFromEnv, validateScimBindings } from "./scim.js";

const NOW = "2026-08-30T12:00:00.000Z";
const EXPIRES = "2026-11-28T12:00:00.000Z";
const TOKEN = `me_${"a".repeat(48)}`;
const opened: Array<{ db: AppDb; directory: string }> = [];

function open(name: string): { db: AppDb; path: string } {
  const directory = mkdtempSync(join(tmpdir(), `mendpoint-scim-bootstrap-${name}-`));
  const path = join(directory, "mendpoint.sqlite");
  const db = createDb(path);
  opened.push({ db, directory });
  return { db, path };
}

function env(tenantId = "tenant_default", token = TOKEN) {
  return {
    OIDC_ISSUER: "https://identity.example",
    MENDPOINT_SCIM_BINDINGS_JSON: JSON.stringify({
      schemaVersion: 1,
      bindings: [{ tenantId, principalId: `principal-scim-${tenantId}`, issuer: "https://identity.example" }],
    }),
    MENDPOINT_SCIM_BOOTSTRAP_AUTHORITIES_JSON: JSON.stringify({
      schemaVersion: 1,
      authorities: [{
        tenantId,
        principalId: `principal-scim-${tenantId}`,
        keyId: `key-scim-${tenantId}`,
        subject: `scim-directory-${tenantId}`,
        displayName: `SCIM directory ${tenantId}`,
        expiresAt: EXPIRES,
        token,
      }],
    }),
  };
}

afterEach(() => {
  for (const { db, directory } of opened.splice(0)) {
    try { db.raw.close(); } catch { /* already closed for reopen coverage */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("protected SCIM authority bootstrap", () => {
  it("atomically materializes and replays the exact authority on a fresh volume", () => {
    const { db } = open("fresh");
    const bindings = scimBindingsFromEnv(env());
    expect(() => validateScimBindings(db, bindings, NOW)).toThrow("scim_binding_principal_invalid");

    bootstrapScimAuthorities(db, env(), NOW);
    expect(() => validateScimBindings(db, bindings, NOW)).not.toThrow();
    expect(getPrincipal(db, "tenant_default", "principal-scim-tenant_default")).toMatchObject({
      kind: "service",
      audience: "mendpoint-scim",
      expires_at: EXPIRES,
    });
    expect(listApiKeys(db, "tenant_default").filter((key) => key.principal_id)).toHaveLength(1);
    const audit = listAudit(db, "tenant_default").filter((event) => event.action === "scim.authority.bootstrap");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(TOKEN);

    bootstrapScimAuthorities(db, env(), NOW);
    expect(listApiKeys(db, "tenant_default").filter((key) => key.principal_id)).toHaveLength(1);
    expect(listAudit(db, "tenant_default").filter((event) => event.action === "scim.authority.bootstrap"))
      .toHaveLength(1);
  });

  it("upgrades a current-schema populated volume without replacing existing authority", () => {
    const { db, path } = open("upgrade");
    db.raw.prepare(
      `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
       VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'enterprise', 'active', 20, ?)`,
    ).run(NOW);
    createApiKey(db, {
      id: "existing-owner-key",
      name: "Existing owner key",
      tenantId: "tenant-a",
      scopes: ["*"],
      createdAt: NOW,
    });
    db.raw.close();
    const reopened = createDb(path);
    opened[opened.length - 1]!.db = reopened;

    bootstrapScimAuthorities(reopened, env("tenant-a"), NOW);
    expect(() => validateScimBindings(reopened, scimBindingsFromEnv(env("tenant-a")), NOW)).not.toThrow();
    expect(listApiKeys(reopened, "tenant-a").map((key) => key.id).sort()).toEqual([
      "existing-owner-key",
      "key-scim-tenant-a",
    ]);
  });

  it("rolls the whole bootstrap back when protected credential material conflicts", () => {
    const { db } = open("conflict");
    createApiKey(db, {
      id: "key-conflict",
      name: "Conflicting key",
      tenantId: "tenant_default",
      scopes: ["graph:read"],
      createdAt: NOW,
    });
    const configured = env();
    const authority = JSON.parse(configured.MENDPOINT_SCIM_BOOTSTRAP_AUTHORITIES_JSON) as {
      schemaVersion: number;
      authorities: Array<Record<string, unknown>>;
    };
    authority.authorities[0]!.keyId = "key-conflict";

    expect(() => bootstrapScimAuthorities(db, {
      ...configured,
      MENDPOINT_SCIM_BOOTSTRAP_AUTHORITIES_JSON: JSON.stringify(authority),
    }, NOW)).toThrow("scim_bootstrap_credential_conflict");
    expect(getPrincipal(db, "tenant_default", "principal-scim-tenant_default")).toBeUndefined();
    expect(listAudit(db, "tenant_default").filter((event) => event.action === "scim.authority.bootstrap"))
      .toHaveLength(0);
  });

  it("rejects bootstrap authority outside the service-principal lifetime boundary", () => {
    const { db } = open("lifetime");
    const configured = env();
    const authority = JSON.parse(configured.MENDPOINT_SCIM_BOOTSTRAP_AUTHORITIES_JSON) as {
      schemaVersion: number;
      authorities: Array<Record<string, unknown>>;
    };
    authority.authorities[0]!.expiresAt = "2026-11-28T12:00:00.001Z";
    expect(() => bootstrapScimAuthorities(db, {
      ...configured,
      MENDPOINT_SCIM_BOOTSTRAP_AUTHORITIES_JSON: JSON.stringify(authority),
    }, NOW)).toThrow("scim_bootstrap_authority_mismatch");
    expect(getPrincipal(db, "tenant_default", "principal-scim-tenant_default")).toBeUndefined();
  });
});
