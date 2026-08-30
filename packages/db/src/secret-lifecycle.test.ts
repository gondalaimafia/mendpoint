import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type AppDb } from "./index.js";
import {
  createSecretLifecycle,
  getActiveSecretLifecycleByReference,
  getSecretLifecycleVersion,
  listSecretLifecycleVersions,
  revokeSecretLifecycle,
  rotateSecretLifecycle,
} from "./secret-lifecycle.js";

const open: AppDb[] = [];

afterEach(() => {
  while (open.length) open.pop()?.raw.close();
});

function freshDb(): AppDb {
  const db = createDb(join(mkdtempSync(join(tmpdir(), "mp-secret-fresh-")), "db.sqlite"));
  open.push(db);
  return db;
}

function agedDb(): AppDb {
  const path = join(mkdtempSync(join(tmpdir(), "mp-secret-aged-")), "db.sqlite");
  const aged = new DatabaseSync(path);
  aged.exec("CREATE TABLE legacy_marker (id TEXT PRIMARY KEY)");
  aged.close();
  const db = createDb(path);
  open.push(db);
  return db;
}

function version(generation: number, ciphertext = `ciphertext-${generation}`) {
  return {
    tenantId: "tenant-a",
    credentialId: "scm-credential-a",
    sourceRef: "vault://github/installations/12345",
    generation,
    audiences: ["github:installation:12345"],
    expiresAt: "2026-09-01T00:00:00.000Z",
    issuedAt: `2026-08-0${generation}T00:00:00.000Z`,
    rotateAfter: "2026-08-20T00:00:00.000Z",
    key: {
      provider: "external-vault",
      keyId: "tenant-cmk",
      version: String(generation),
      customerManaged: true,
    },
    envelope: {
      schemaVersion: 1 as const,
      algorithm: "AES-256-GCM" as const,
      wrappedDataKey: `wrapped-${generation}`,
      iv: `iv-${generation}`,
      authTag: `tag-${generation}`,
      ciphertext,
      createdAt: `2026-08-0${generation}T00:00:00.000Z`,
    },
  };
}

describe.each([
  ["fresh", freshDb],
  ["aged", agedDb],
] as const)("secret lifecycle on a %s database", (_kind, fixture) => {
  it("persists tenant scoped encrypted metadata without a plaintext column", () => {
    const db = fixture();
    const created = createSecretLifecycle(db, version(1));

    expect(created).toMatchObject({
      tenant_id: "tenant-a",
      credential_id: "scm-credential-a",
      generation: 1,
      state: "active",
      key_provider: "external-vault",
      key_version: "1",
      customer_managed: 1,
    });
    expect(getActiveSecretLifecycleByReference(
      db,
      "tenant-a",
      "vault://github/installations/12345",
    )).toEqual(created);
    expect(getActiveSecretLifecycleByReference(
      db,
      "tenant-b",
      "vault://github/installations/12345",
    )).toBeUndefined();

    const columns = db.raw.prepare("PRAGMA table_info(secret_lifecycle_versions)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).not.toContain("plaintext");
    expect(JSON.stringify(created)).not.toContain("customer-secret");
  });
});

describe("secret lifecycle transitions", () => {
  it("rotates atomically with one active monotonic generation", () => {
    const db = freshDb();
    createSecretLifecycle(db, version(1));

    const rotated = rotateSecretLifecycle(db, {
      expectedGeneration: 1,
      rotatedAt: "2026-08-02T01:00:00.000Z",
      next: version(2),
    });

    expect(rotated.state).toBe("active");
    expect(rotated.generation).toBe(2);
    expect(getSecretLifecycleVersion(db, "tenant-a", "scm-credential-a", 1)).toMatchObject({
      state: "retired",
      retired_at: "2026-08-02T01:00:00.000Z",
    });
    expect(listSecretLifecycleVersions(db, "tenant-a", "scm-credential-a").map((row) => [
      row.generation,
      row.state,
    ])).toEqual([[1, "retired"], [2, "active"]]);

    expect(() => rotateSecretLifecycle(db, {
      expectedGeneration: 1,
      rotatedAt: "2026-08-03T00:00:00.000Z",
      next: version(3),
    })).toThrow("secret_rotation_generation_conflict");
    expect(listSecretLifecycleVersions(db, "tenant-a", "scm-credential-a")).toHaveLength(2);
  });

  it("allows only one active credential for a tenant source reference", () => {
    const db = freshDb();
    createSecretLifecycle(db, version(1));
    rotateSecretLifecycle(db, {
      expectedGeneration: 1,
      rotatedAt: "2026-08-02T01:00:00.000Z",
      next: version(2),
    });

    expect(() => createSecretLifecycle(db, {
      ...version(1),
      credentialId: "scm-credential-b",
    })).toThrow();
    expect(getActiveSecretLifecycleByReference(
      db,
      "tenant-a",
      "vault://github/installations/12345",
    )).toMatchObject({ credential_id: "scm-credential-a", generation: 2 });
  });

  it("keeps retirement distinct from immutable incident revocation", () => {
    const db = freshDb();
    createSecretLifecycle(db, version(1));
    rotateSecretLifecycle(db, {
      expectedGeneration: 1,
      rotatedAt: "2026-08-02T01:00:00.000Z",
      next: version(2),
    });

    const revoked = revokeSecretLifecycle(db, {
      tenantId: "tenant-a",
      credentialId: "scm-credential-a",
      generation: 2,
      revokedAt: "2026-08-02T02:00:00.000Z",
      reason: "installation token exposure",
    });
    expect(revoked).toMatchObject({
      state: "revoked",
      revoked_at: "2026-08-02T02:00:00.000Z",
      revocation_reason: "installation token exposure",
    });
    expect(revokeSecretLifecycle(db, {
      tenantId: "tenant-a",
      credentialId: "scm-credential-a",
      generation: 2,
      revokedAt: "2026-08-03T00:00:00.000Z",
      reason: "different reason",
    })).toEqual(revoked);
    expect(() => db.raw.prepare(
      "UPDATE secret_lifecycle_versions SET revocation_reason = 'rewritten' " +
      "WHERE tenant_id = 'tenant-a' AND credential_id = 'scm-credential-a' AND generation = 2",
    ).run()).toThrow("secret_lifecycle_transition_invalid");
    expect(getActiveSecretLifecycleByReference(
      db,
      "tenant-a",
      "vault://github/installations/12345",
    )).toBeUndefined();
  });
});
