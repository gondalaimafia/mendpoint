import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  getSecretLifecycleOperation,
  getSecretLifecycleVersion,
  listSecretLifecycleVersions,
  listAudit,
  recordAudit,
  type AppDb,
} from "@mendpoint/db";
import {
  DisabledExternalVaultProvider,
  LocalEnvelopeKeyProvider,
} from "@mendpoint/platform";
import {
  DurableSecretLifecycleService,
  secretLifecycleRequestCommitmentFromEnvironment,
} from "./secret-lifecycle-service.js";

const open: AppDb[] = [];
const COMMITMENT_KEY_ID = "secret-request-v1";
const COMMITMENT_KEY = Buffer.alloc(32, 9);
afterEach(() => {
  while (open.length) open.pop()?.raw.close();
});

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), "mp-secret-service-")), "db.sqlite");
  const db = createDb(path);
  open.push(db);
  const provider = new LocalEnvelopeKeyProvider();
  provider.putKey("tenant-a", {
    provider: "local-envelope",
    keyId: "tenant-key",
    version: "1",
    customerManaged: true,
  }, Buffer.alloc(32, 1));
  provider.putKey("tenant-a", {
    provider: "local-envelope",
    keyId: "tenant-key",
    version: "2",
    customerManaged: true,
  }, Buffer.alloc(32, 2));
  return { db, path, provider };
}

function service(db: AppDb, provider: LocalEnvelopeKeyProvider | DisabledExternalVaultProvider, options?: {
  tenantId?: string;
  actorId?: string;
  role?: "owner" | "admin" | "engineer";
  requestId?: string;
  breakGlassEnabled?: boolean;
  auditFailure?: boolean;
  commitmentKey?: Buffer;
  commitmentKeyId?: string;
  commitmentConfigured?: boolean;
}) {
  return new DurableSecretLifecycleService({
    db,
    tenantId: options?.tenantId ?? "tenant-a",
    actorId: options?.actorId ?? "operator-a",
    role: options?.role ?? "admin",
    providers: [provider],
    breakGlassEnabled: options?.breakGlassEnabled ?? true,
    requestId: options?.requestId ?? "secret-service-request",
    apiKeyId: null,
    requestCommitment: options?.commitmentConfigured === false ? undefined : {
      keyId: options?.commitmentKeyId ?? COMMITMENT_KEY_ID,
      key: options?.commitmentKey ?? COMMITMENT_KEY,
    },
    now: () => "2026-08-02T00:00:00.000Z",
    audit: (event) => {
      if (options?.auditFailure) throw new Error("audit unavailable");
      recordAudit(db, {
        id: event.id,
        tenantId: event.tenantId,
        actor: "operator",
        principalId: event.actorId,
        apiKeyId: event.apiKeyId,
        requestId: event.requestId,
        action: event.action,
        resourceType: "secret_lifecycle",
        resourceId: event.credentialId,
        metadata: event.metadata,
      });
    },
  });
}

const createInput = {
  idempotencyKey: "create-one",
  credentialId: "credential-a",
  sourceRef: "vault://github/installations/12345",
  plaintext: "customer-secret",
  audiences: ["github:installation:12345"],
  key: { provider: "local-envelope", keyId: "tenant-key", version: "1" },
};

describe("durable secret lifecycle service", () => {
  it("replays a committed create after restart and rejects a mismatched replay", async () => {
    const { db, provider } = fixture();
    const created = await service(db, provider).create(createInput);
    expect((await service(db, provider).create(createInput)).generation).toBe(created.generation);
    await expect(service(db, provider).create({
      ...createInput,
      key: { version: "1", keyId: "tenant-key", provider: "local-envelope" },
    })).resolves.toMatchObject({ generation: 1 });
    await expect(service(db, provider).create({ ...createInput, plaintext: "different" }))
      .rejects.toThrow("secret_lifecycle_idempotency_conflict");
  });

  it("replays a committed rotation after process restart without reopening key access", async () => {
    const { db, path, provider } = fixture();
    await service(db, provider).create(createInput);
    const rotateInput = {
      idempotencyKey: "rotate-restart",
      credentialId: "credential-a",
      expectedGeneration: 1,
      key: { provider: "local-envelope", keyId: "tenant-key", version: "2" },
    };
    await expect(service(db, provider).rotate(rotateInput)).resolves.toMatchObject({ generation: 2 });
    db.raw.close();
    open.splice(open.indexOf(db), 1);
    const reopened = createDb(path);
    open.push(reopened);
    await expect(service(
      reopened,
      new DisabledExternalVaultProvider("local-envelope"),
    ).rotate(rotateInput)).resolves.toMatchObject({ generation: 2, state: "active" });
  });

  it("does not advance the visible generation when required audit fails", async () => {
    const { db, provider } = fixture();
    await service(db, provider).create(createInput);
    await expect(service(db, provider, { auditFailure: true }).rotate({
      idempotencyKey: "rotate-one",
      credentialId: "credential-a",
      expectedGeneration: 1,
      key: { provider: "local-envelope", keyId: "tenant-key", version: "2" },
    })).rejects.toThrow("vault_access_audit_failed");
    expect(getSecretLifecycleVersion(db, "tenant-a", "credential-a", 1)?.state).toBe("active");
    expect(listSecretLifecycleVersions(db, "tenant-a", "credential-a")).toHaveLength(1);
  });

  it("durably audits rotation source unwrap outcomes without publishing a denied rotation", async () => {
    const { db, provider } = fixture();
    await service(db, provider).create(createInput);
    await service(db, provider).rotate({
      idempotencyKey: "rotate-source-granted",
      credentialId: "credential-a",
      expectedGeneration: 1,
      key: { provider: "local-envelope", keyId: "tenant-key", version: "2" },
    });
    expect(listAudit(db, "tenant-a").map((event) => event.action))
      .toContain("secret.lifecycle.rotation_source.granted");

    const second = fixture();
    await service(second.db, second.provider).create(createInput);
    second.provider.removeKey("tenant-a", {
      provider: "local-envelope",
      keyId: "tenant-key",
      version: "1",
      customerManaged: true,
    });
    await expect(service(second.db, second.provider).rotate({
      idempotencyKey: "rotate-source-denied",
      credentialId: "credential-a",
      expectedGeneration: 1,
      key: { provider: "local-envelope", keyId: "tenant-key", version: "2" },
    })).rejects.toThrow("vault_decrypt_denied");
    expect(listAudit(second.db, "tenant-a").map((event) => event.action))
      .toContain("secret.lifecycle.rotation_source.denied");
    expect(listSecretLifecycleVersions(second.db, "tenant-a", "credential-a"))
      .toHaveLength(1);
  });

  it("retains a granted source-access audit when replacement attestation fails", async () => {
    const { db, provider } = fixture();
    await service(db, provider).create(createInput);
    provider.removeKey("tenant-a", {
      provider: "local-envelope",
      keyId: "tenant-key",
      version: "2",
      customerManaged: true,
    });
    await expect(service(db, provider).rotate({
      idempotencyKey: "rotate-replacement-denied",
      credentialId: "credential-a",
      expectedGeneration: 1,
      key: { provider: "local-envelope", keyId: "tenant-key", version: "2" },
    })).rejects.toThrow("local_envelope_key_missing");
    expect(listAudit(db, "tenant-a").map((event) => event.action))
      .toContain("secret.lifecycle.rotation_source.granted");
    expect(listSecretLifecycleVersions(db, "tenant-a", "credential-a"))
      .toHaveLength(1);
  });

  it("resumes rotation after a pre-publication failure without duplicating source audit", async () => {
    const { db, provider } = fixture();
    await service(db, provider).create(createInput);
    provider.removeKey("tenant-a", {
      provider: "local-envelope",
      keyId: "tenant-key",
      version: "2",
      customerManaged: true,
    });
    const request = {
      idempotencyKey: "rotate-resume",
      credentialId: "credential-a",
      expectedGeneration: 1,
      key: { provider: "local-envelope", keyId: "tenant-key", version: "2" },
    };
    await expect(service(db, provider, { requestId: "rotate-http-one" }).rotate(request))
      .rejects.toThrow("local_envelope_key_missing");
    provider.putKey("tenant-a", {
      provider: "local-envelope",
      keyId: "tenant-key",
      version: "2",
      customerManaged: true,
    }, Buffer.alloc(32, 2));
    await expect(service(db, provider, { requestId: "rotate-http-two" }).rotate(request))
      .resolves.toMatchObject({ generation: 2, state: "active" });
    expect(listAudit(db, "tenant-a").filter(
      (event) => event.action === "secret.lifecycle.rotation_source.granted",
    )).toHaveLength(1);
  });

  it("audits denied break glass and distinguishes new attempts from exact replay", async () => {
    const { db, provider } = fixture();
    await service(db, provider).create(createInput);
    provider.removeKey("tenant-a", {
      provider: "local-envelope",
      keyId: "tenant-key",
      version: "1",
      customerManaged: true,
    });
    await expect(service(db, provider, { role: "owner" }).breakGlass({
      credentialId: "credential-a",
      reason: "incident",
      idempotencyKey: "break-glass-denied-one",
    })).rejects.toThrow("vault_decrypt_denied");
    expect(listAudit(db, "tenant-a").map((event) => event.action))
      .toContain("secret.break_glass.denied");

    const successful = fixture();
    const owner = service(successful.db, successful.provider, { role: "owner" });
    await owner.create(createInput);
    const request = {
      credentialId: "credential-a",
      reason: "incident",
      idempotencyKey: "break-glass-attempt-one",
    };
    await owner.breakGlass(request);
    await owner.breakGlass(request);
    await owner.breakGlass({ ...request, idempotencyKey: "break-glass-attempt-two" });
    expect(listAudit(successful.db, "tenant-a").filter(
      (event) => event.action === "secret.break_glass.granted",
    )).toHaveLength(2);
  });

  it("replays break glass across transport request IDs and rejects a changed payload", async () => {
    const { db, provider } = fixture();
    await service(db, provider).create(createInput);
    const request = {
      credentialId: "credential-a",
      reason: "incident",
      idempotencyKey: "break-glass-http-replay",
    };
    await expect(service(db, provider, { role: "owner", requestId: "http-one" }).breakGlass(request))
      .resolves.toBe("customer-secret");
    await expect(service(db, provider, { role: "owner", requestId: "http-two" }).breakGlass(request))
      .resolves.toBe("customer-secret");
    await expect(service(db, provider, { role: "owner", requestId: "http-three" }).breakGlass({
      ...request,
      reason: "different incident",
    })).rejects.toThrow("secret_lifecycle_idempotency_conflict");
    expect(listAudit(db, "tenant-a").filter(
      (event) => event.action === "secret.break_glass.granted",
    )).toHaveLength(1);
  });

  it("audits every pre-decrypt break-glass denial with its principal and request context", async () => {
    const scenarios = [
      { name: "role", options: { role: "engineer" as const }, error: "secret_lifecycle_authority_required" },
      { name: "owner", options: { role: "admin" as const }, error: "secret_break_glass_owner_required" },
      { name: "flag", options: { role: "owner" as const, breakGlassEnabled: false }, error: "secret_break_glass_disabled" },
      { name: "reason", options: { role: "owner" as const }, reason: " ", error: "secret_break_glass_reason_required" },
      { name: "idempotency", options: { role: "owner" as const }, idempotencyKey: "", error: "secret_lifecycle_idempotency_key_invalid" },
      { name: "tenant", options: { role: "owner" as const, tenantId: "" }, error: "secret_lifecycle_authority_invalid" },
      { name: "actor", options: { role: "owner" as const, actorId: "" }, error: "secret_lifecycle_authority_invalid" },
      { name: "lookup", options: { role: "owner" as const, tenantId: "tenant-b" }, error: "secret_lifecycle_not_found" },
      { name: "commitment", options: { role: "owner" as const, commitmentConfigured: false }, error: "secret_lifecycle_commitment_unconfigured" },
    ];
    for (const scenario of scenarios) {
      const { db, provider } = fixture();
      await service(db, provider).create(createInput);
      const requestId = `denied-${scenario.name}`;
      await expect(service(db, provider, { ...scenario.options, requestId }).breakGlass({
        credentialId: "credential-a",
        reason: scenario.reason ?? "incident",
        idempotencyKey: scenario.idempotencyKey ?? `break-glass-${scenario.name}`,
      })).rejects.toThrow(scenario.error);
      const tenantId = scenario.options.tenantId === "" ? "tenant_unattributed" :
        scenario.options.tenantId ?? "tenant-a";
      const denied = listAudit(db, tenantId).filter(
        (event) => event.action === "secret.break_glass.denied",
      );
      expect(denied, scenario.name).toHaveLength(1);
      expect(denied[0], scenario.name).toMatchObject({
        principal_id: scenario.options.actorId === "" ? "principal_unattributed" :
          scenario.options.actorId ?? "operator-a",
        request_id: requestId,
      });
      expect(JSON.parse(denied[0]!.metadata_json!), scenario.name).toMatchObject({
        outcome: "denied",
        failure: scenario.error,
        role: scenario.options.role,
        tenantId: scenario.options.tenantId ?? "tenant-a",
        actorId: scenario.options.actorId ?? "operator-a",
      });
    }
  });

  it("fails closed when a pre-decrypt break-glass denial cannot be audited", async () => {
    const { db, provider } = fixture();
    await service(db, provider).create(createInput);
    await expect(service(db, provider, {
      role: "admin",
      requestId: "denied-audit-failure",
      auditFailure: true,
    }).breakGlass({
      credentialId: "credential-a",
      reason: "incident",
      idempotencyKey: "break-glass-audit-failure",
    })).rejects.toThrow("vault_access_audit_failed");
    expect(listAudit(db, "tenant-a").some(
      (event) => event.action === "secret.break_glass.granted",
    )).toBe(false);
  });

  it("stores a versioned keyed commitment and rejects offline guesses or wrong authority", async () => {
    const { db, provider } = fixture();
    await service(db, provider).create(createInput);
    const operation = getSecretLifecycleOperation(db, "tenant-a", createInput.idempotencyKey)!;
    const legacyDigest = createHash("sha256").update(JSON.stringify({
      operation: "create",
      tenantId: "tenant-a",
      actorId: "operator-a",
      credentialId: createInput.credentialId,
      sourceRef: createInput.sourceRef,
      plaintextSha256: createHash("sha256").update(createInput.plaintext).digest("hex"),
      audiences: [...createInput.audiences],
      expiresAt: null,
      rotateAfter: null,
      key: createInput.key,
    })).digest("hex");
    expect(operation.request_commitment_key_id).toBe(COMMITMENT_KEY_ID);
    expect(operation.request_digest).not.toBe(legacyDigest);
    await expect(service(db, provider, { commitmentKey: Buffer.alloc(32, 8) }).create(createInput))
      .rejects.toThrow("secret_lifecycle_idempotency_conflict");
    await expect(service(db, provider, { commitmentKeyId: "secret-request-v2" }).create(createInput))
      .rejects.toThrow("secret_lifecycle_idempotency_conflict");

    const variants = [
      { ...createInput, plaintext: "different" },
      { ...createInput, sourceRef: "vault://github/installations/67890" },
      { ...createInput, audiences: ["github:installation:67890"] },
      { ...createInput, expiresAt: "2026-09-01T00:00:00.000Z" },
      { ...createInput, rotateAfter: "2026-08-20T00:00:00.000Z" },
      { ...createInput, key: { ...createInput.key, version: "2" } },
    ];
    for (const variant of variants) {
      await expect(service(db, provider).create(variant))
        .rejects.toThrow("secret_lifecycle_idempotency_conflict");
    }
  });

  it("constructs request commitment authority only from a complete external key binding", () => {
    expect(secretLifecycleRequestCommitmentFromEnvironment({})).toBeUndefined();
    expect(() => secretLifecycleRequestCommitmentFromEnvironment({
      MENDPOINT_SECRET_IDEMPOTENCY_KEY_ID: COMMITMENT_KEY_ID,
    })).toThrow("secret_lifecycle_commitment_configuration_invalid");
    expect(() => secretLifecycleRequestCommitmentFromEnvironment({
      MENDPOINT_SECRET_IDEMPOTENCY_KEY_ID: COMMITMENT_KEY_ID,
      MENDPOINT_SECRET_IDEMPOTENCY_KEY_BASE64: Buffer.alloc(16, 1).toString("base64"),
    })).toThrow("secret_lifecycle_commitment_configuration_invalid");
    expect(secretLifecycleRequestCommitmentFromEnvironment({
      MENDPOINT_SECRET_IDEMPOTENCY_KEY_ID: COMMITMENT_KEY_ID,
      MENDPOINT_SECRET_IDEMPOTENCY_KEY_BASE64: COMMITMENT_KEY.toString("base64"),
    })).toMatchObject({ keyId: COMMITMENT_KEY_ID, key: COMMITMENT_KEY });
  });

  it("fails closed for disabled providers and unauthorized actors", async () => {
    const { db, provider } = fixture();
    await expect(service(db, new DisabledExternalVaultProvider("local-envelope")).create(createInput))
      .rejects.toThrow("vault_provider_disabled");
    await expect(service(db, provider, { role: "engineer" }).create(createInput))
      .rejects.toThrow("secret_lifecycle_authority_required");
  });

  it("cannot mutate another tenant's credential and gates break glass to owners", async () => {
    const { db, provider } = fixture();
    await service(db, provider).create(createInput);
    await expect(service(db, provider, { tenantId: "tenant-b" }).rotate({
      idempotencyKey: "rotate-cross-tenant",
      credentialId: "credential-a",
      expectedGeneration: 1,
      key: { provider: "local-envelope", keyId: "tenant-key", version: "2" },
    })).rejects.toThrow("secret_lifecycle_not_found");
    await expect(service(db, provider).breakGlass({
      credentialId: "credential-a", reason: "incident", idempotencyKey: "break-glass-admin",
    }))
      .rejects.toThrow("secret_break_glass_owner_required");
    await expect(new DurableSecretLifecycleService({
      db,
      tenantId: "tenant-a",
      actorId: "operator-a",
      role: "owner",
      providers: [provider],
      breakGlassEnabled: false,
      requestId: "break-glass-disabled-request",
      apiKeyId: null,
      requestCommitment: { keyId: COMMITMENT_KEY_ID, key: COMMITMENT_KEY },
      audit: () => undefined,
    }).breakGlass({
      credentialId: "credential-a", reason: "incident", idempotencyKey: "break-glass-disabled",
    }))
      .rejects.toThrow("secret_break_glass_disabled");
    await expect(service(db, provider, { role: "owner" }).breakGlass({
      credentialId: "credential-a",
      reason: "incident",
      idempotencyKey: "break-glass-owner",
    })).resolves.toBe("customer-secret");
    expect(service(db, provider).revoke({
      credentialId: "credential-a",
      generation: 1,
      reason: "incident response",
    })).toMatchObject({ state: "revoked", generation: 1 });
  });
});
