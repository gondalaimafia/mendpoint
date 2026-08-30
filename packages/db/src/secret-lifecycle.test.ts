import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type AppDb } from "./index.js";
import {
  createSecretLifecycle,
  getActiveSecretLifecycleByReference,
  getSecretLifecycleOperation,
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

function legacySecretDb(): AppDb {
  const path = join(mkdtempSync(join(tmpdir(), "mp-secret-legacy-")), "db.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE secret_lifecycle_versions (
      tenant_id TEXT NOT NULL, credential_id TEXT NOT NULL, source_ref TEXT NOT NULL,
      generation INTEGER NOT NULL, state TEXT NOT NULL, audiences_json TEXT NOT NULL,
      expires_at TEXT, issued_at TEXT NOT NULL, rotate_after TEXT, retired_at TEXT,
      revoked_at TEXT, revocation_reason TEXT, key_provider TEXT NOT NULL,
      key_id TEXT NOT NULL, key_version TEXT NOT NULL, customer_managed INTEGER NOT NULL,
      envelope_schema_version INTEGER NOT NULL, algorithm TEXT NOT NULL,
      wrapped_data_key TEXT NOT NULL, iv TEXT NOT NULL, auth_tag TEXT NOT NULL,
      ciphertext TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, credential_id, generation),
      UNIQUE (tenant_id, source_ref, generation)
    );
    CREATE TRIGGER secret_lifecycle_versions_guard_update
    BEFORE UPDATE ON secret_lifecycle_versions
    BEGIN SELECT RAISE(ABORT, 'secret_lifecycle_transition_invalid'); END;
    INSERT INTO secret_lifecycle_versions VALUES (
      'tenant-a', 'legacy-credential', 'vault://legacy/credential', 1, 'active',
      '["legacy"]', NULL, '2026-08-01T00:00:00.000Z', NULL, NULL, NULL, NULL,
      'external-vault', 'legacy-key', '1', 1, 1, 'AES-256-GCM', 'wrapped',
      'iv', 'tag', 'ciphertext', '2026-08-01T00:00:00.000Z'
    );
    CREATE TABLE secret_lifecycle_operations (
      tenant_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, operation TEXT NOT NULL,
      request_digest TEXT NOT NULL, actor_id TEXT NOT NULL, credential_id TEXT NOT NULL,
      result_generation INTEGER NOT NULL, completed_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, idempotency_key)
    );
    CREATE TRIGGER secret_lifecycle_operations_no_update
    BEFORE UPDATE ON secret_lifecycle_operations
    BEGIN SELECT RAISE(ABORT, 'secret_lifecycle_operation_immutable'); END;
    INSERT INTO secret_lifecycle_operations VALUES (
      'tenant-a', 'legacy-create', 'create', '${"a".repeat(64)}', 'operator-a',
      'legacy-credential', 1, '2026-08-01T00:00:00.000Z'
    );
  `);
  legacy.close();
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
    materialLineageId: "b".repeat(64),
    envelope: {
      schemaVersion: 1 as const,
      algorithm: "AES-256-GCM" as const,
      wrappedDataKey: `wrapped-${generation}`,
      iv: `iv-${generation}`,
      authTag: `tag-${generation}`,
      ciphertext,
      createdAt: `2026-08-0${generation}T00:00:00.000Z`,
      keyAttestationSha256: "f".repeat(64),
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
      key_attestation_sha256: "f".repeat(64),
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
    expect(columns.map((column) => column.name)).toContain("key_attestation_sha256");
    expect(JSON.stringify(created)).not.toContain("customer-secret");
  });
});

describe("secret lifecycle transitions", () => {
  it("adds nullable attestation evidence to legacy rows and keeps it immutable", () => {
    const db = legacySecretDb();
    const row = getSecretLifecycleVersion(db, "tenant-a", "legacy-credential", 1);
    expect(row?.key_attestation_sha256).toBeNull();
    expect(() => db.raw.prepare(`
      UPDATE secret_lifecycle_versions SET key_attestation_sha256 = ?
      WHERE tenant_id = 'tenant-a' AND credential_id = 'legacy-credential' AND generation = 1
    `).run("a".repeat(64))).toThrow("secret_lifecycle_transition_invalid");
    expect(getSecretLifecycleOperation(db, "tenant-a", "legacy-create"))
      .toMatchObject({ request_commitment_key_id: null });
    expect(() => createSecretLifecycle(db, {
      ...version(1),
      credentialId: "legacy-credential",
      sourceRef: "vault://legacy/credential",
    }, {
      operation: {
        idempotencyKey: "legacy-create",
        requestDigest: "a".repeat(64),
        requestCommitmentKeyId: "secret-request-v1",
        actorId: "operator-a",
      },
    })).toThrow("secret_lifecycle_idempotency_conflict");
  });

  it("replays completed create and rotate operations but rejects mismatched identities", () => {
    const db = freshDb();
    const created = createSecretLifecycle(db, version(1), {
      operation: {
        idempotencyKey: "create-one",
        requestDigest: "a".repeat(64),
        requestCommitmentKeyId: "secret-request-v1",
        actorId: "operator-a",
      },
    });
    expect(createSecretLifecycle(db, version(1), {
      operation: {
        idempotencyKey: "create-one",
        requestDigest: "a".repeat(64),
        requestCommitmentKeyId: "secret-request-v1",
        actorId: "operator-a",
      },
    })).toEqual(created);
    expect(() => createSecretLifecycle(db, version(1), {
      operation: {
        idempotencyKey: "create-one",
        requestDigest: "b".repeat(64),
        requestCommitmentKeyId: "secret-request-v1",
        actorId: "operator-a",
      },
    })).toThrow("secret_lifecycle_idempotency_conflict");

    const rotated = rotateSecretLifecycle(db, {
      expectedGeneration: 1,
      rotatedAt: "2026-08-02T01:00:00.000Z",
      next: version(2),
    }, {
      operation: {
        idempotencyKey: "rotate-one",
        requestDigest: "c".repeat(64),
        requestCommitmentKeyId: "secret-request-v1",
        actorId: "operator-a",
      },
    });
    expect(rotateSecretLifecycle(db, {
      expectedGeneration: 1,
      rotatedAt: "2026-08-02T01:00:00.000Z",
      next: version(2),
    }, {
      operation: {
        idempotencyKey: "rotate-one",
        requestDigest: "c".repeat(64),
        requestCommitmentKeyId: "secret-request-v1",
        actorId: "operator-a",
      },
    })).toEqual(rotated);
  });

  it("rolls back lifecycle publication when its required durable audit fails", () => {
    const db = freshDb();
    createSecretLifecycle(db, version(1));
    expect(() => rotateSecretLifecycle(db, {
      expectedGeneration: 1,
      rotatedAt: "2026-08-02T01:00:00.000Z",
      next: version(2),
    }, {
      operation: {
        idempotencyKey: "rotate-audit-failure",
        requestDigest: "d".repeat(64),
        requestCommitmentKeyId: "secret-request-v1",
        actorId: "operator-a",
      },
      audit: () => {
        throw new Error("audit unavailable");
      },
    })).toThrow("audit unavailable");
    expect(getSecretLifecycleVersion(db, "tenant-a", "scm-credential-a", 1)?.state).toBe("active");
    expect(getSecretLifecycleVersion(db, "tenant-a", "scm-credential-a", 2)).toBeUndefined();
  });

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
