import { describe, expect, it } from "vitest";
import {
  DisabledExternalVaultProvider,
  EnvelopeKeyLifecycleRegistry,
  EnvelopeSecretVault,
  LocalEnvelopeKeyProvider,
  type EnvelopeAccessAuditEvent,
  type EnvelopeKeyLifecycle,
  type EnvelopeKeyReference,
} from "./vault-envelope.js";

const at = "2026-08-02T00:00:00.000Z";
const key1: EnvelopeKeyReference = {
  provider: "local-envelope",
  keyId: "tenant-key",
  version: "1",
  customerManaged: false,
};
const key2: EnvelopeKeyReference = { ...key1, version: "2" };
const context = {
  tenantId: "tenant-a",
  actorId: "service:api",
  correlationId: "trace-1",
  purpose: "read scm credential",
  at,
};

function lifecycle(key: EnvelopeKeyReference, generation: number): EnvelopeKeyLifecycle {
  return { tenantId: "tenant-a", key, generation, state: "active", createdAt: at };
}

function setup() {
  const registry = new EnvelopeKeyLifecycleRegistry();
  registry.register(lifecycle(key1, 1));
  const provider = new LocalEnvelopeKeyProvider();
  provider.putKey("tenant-a", key1, Buffer.alloc(32, 1));
  provider.putKey("tenant-a", key2, Buffer.alloc(32, 2));
  const events: EnvelopeAccessAuditEvent[] = [];
  const vault = new EnvelopeSecretVault(registry, [provider], (event) => {
    events.push(event);
  });
  return { registry, provider, events, vault };
}

describe("envelope secret lifecycle", () => {
  it("encrypts with a data key and audits metadata without exposing plaintext", async () => {
    const { vault, events } = setup();
    const envelope = await vault.encrypt("github-token", "customer-secret", key1, context);
    expect(envelope.ciphertext).not.toContain("customer-secret");
    expect(JSON.stringify(envelope)).not.toContain("customer-secret");
    expect(await vault.decrypt(envelope, context)).toBe("customer-secret");
    expect(JSON.stringify(events)).not.toContain("customer-secret");
    expect(events.map((event) => [event.operation, event.outcome])).toEqual([
      ["encrypt", "granted"],
      ["decrypt", "granted"],
    ]);
  });

  it("binds ciphertext and wrapped keys to the tenant and key version", async () => {
    const { vault } = setup();
    const envelope = await vault.encrypt("github-token", "customer-secret", key1, context);
    await expect(vault.decrypt(envelope, { ...context, tenantId: "tenant-b" })).rejects.toThrow(
      "tenant_mismatch",
    );
    await expect(vault.decrypt({ ...envelope, secretId: "other-secret" }, context)).rejects.toThrow(
      "vault_decrypt_denied",
    );
  });

  it("rotates to a versioned key and retains old decryptability", async () => {
    const { vault, registry } = setup();
    const envelope = await vault.encrypt("github-token", "customer-secret", key1, context);
    const rotated = await vault.rotate(envelope, lifecycle(key2, 2), {
      ...context,
      at: "2026-08-03T00:00:00.000Z",
    });
    expect(rotated.key).toEqual(key2);
    expect(registry.get("tenant-a", key1)?.state).toBe("retired");
    expect(registry.get("tenant-a", key2)?.state).toBe("active");
    expect(await vault.decrypt(envelope, context)).toBe("customer-secret");
    expect(await vault.decrypt(rotated, context)).toBe("customer-secret");
  });

  it("revokes compromised versions and denies incident access", async () => {
    const { vault, registry } = setup();
    const envelope = await vault.encrypt("github-token", "customer-secret", key1, context);
    registry.revoke("tenant-a", key1, {
      revokedAt: "2026-08-02T01:00:00.000Z",
      reason: "credential incident",
    });
    await expect(vault.decrypt(envelope, context)).rejects.toThrow("vault_key_revoked");
  });

  it("keeps the external vault disabled unless a real provider is configured", async () => {
    const registry = new EnvelopeKeyLifecycleRegistry();
    const externalKey: EnvelopeKeyReference = {
      provider: "external-vault",
      keyId: "cmk",
      version: "1",
      customerManaged: true,
    };
    registry.register(lifecycle(externalKey, 1));
    const vault = new EnvelopeSecretVault(registry, [new DisabledExternalVaultProvider()], () => undefined);
    await expect(vault.encrypt("github-token", "secret", externalKey, context)).rejects.toThrow(
      "vault_provider_disabled",
    );
  });

  it("fails closed when access audit persistence fails", async () => {
    const registry = new EnvelopeKeyLifecycleRegistry();
    registry.register(lifecycle(key1, 1));
    const provider = new LocalEnvelopeKeyProvider();
    provider.putKey("tenant-a", key1, Buffer.alloc(32, 1));
    const vault = new EnvelopeSecretVault(registry, [provider], () => {
      throw new Error("audit offline");
    });
    await expect(vault.encrypt("github-token", "secret", key1, context)).rejects.toThrow(
      "vault_access_audit_failed",
    );
  });
});
