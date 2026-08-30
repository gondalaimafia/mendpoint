import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  getSecretLifecycleVersion,
  listSecretLifecycleVersions,
  recordAudit,
  type AppDb,
} from "@mendpoint/db";
import {
  DisabledExternalVaultProvider,
  LocalEnvelopeKeyProvider,
} from "@mendpoint/platform";
import { DurableSecretLifecycleService } from "./secret-lifecycle-service.js";

const open: AppDb[] = [];
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
  role?: "owner" | "admin" | "engineer";
  auditFailure?: boolean;
}) {
  return new DurableSecretLifecycleService({
    db,
    tenantId: options?.tenantId ?? "tenant-a",
    actorId: "operator-a",
    role: options?.role ?? "admin",
    providers: [provider],
    breakGlassEnabled: true,
    now: () => "2026-08-02T00:00:00.000Z",
    audit: (event) => {
      if (options?.auditFailure) throw new Error("audit unavailable");
      recordAudit(db, {
        id: event.id,
        tenantId: event.tenantId,
        actor: "operator",
        principalId: event.actorId,
        requestId: event.idempotencyKey,
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
    })).rejects.toThrow("audit unavailable");
    expect(getSecretLifecycleVersion(db, "tenant-a", "credential-a", 1)?.state).toBe("active");
    expect(listSecretLifecycleVersions(db, "tenant-a", "credential-a")).toHaveLength(1);
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
    await expect(service(db, provider).breakGlass({ credentialId: "credential-a", reason: "incident" }))
      .rejects.toThrow("secret_break_glass_owner_required");
    await expect(new DurableSecretLifecycleService({
      db,
      tenantId: "tenant-a",
      actorId: "operator-a",
      role: "owner",
      providers: [provider],
      breakGlassEnabled: false,
      audit: () => undefined,
    }).breakGlass({ credentialId: "credential-a", reason: "incident" }))
      .rejects.toThrow("secret_break_glass_disabled");
    await expect(service(db, provider, { role: "owner" }).breakGlass({
      credentialId: "credential-a",
      reason: "incident",
    })).resolves.toBe("customer-secret");
    expect(service(db, provider).revoke({
      credentialId: "credential-a",
      generation: 1,
      reason: "incident response",
    })).toMatchObject({ state: "revoked", generation: 1 });
  });
});
