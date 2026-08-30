import { describe, expect, it } from "vitest";
import {
  ConfiguredEnvelopeKeyProvider,
  DisabledExternalVaultProvider,
  DurableEnvelopeSecretProvider,
  EnvelopeKeyLifecycleRegistry,
  EnvelopeSecretVault,
  LocalEnvelopeKeyProvider,
  envelopeKeyProvidersFromEnvironment,
  type EnvelopeAccessAuditEvent,
  type EnvelopeKeyLifecycle,
  type EnvelopeKeyReference,
  type DurableEnvelopeSecretVersion,
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
  it("persists provider attestation in outer AAD and rejects authority drift after restart", async () => {
    const configured = (attestation: string) => ConfiguredEnvelopeKeyProvider.fromJson(JSON.stringify({
      schemaVersion: 1,
      keys: [{
        tenantId: "tenant-a",
        provider: "external-vault",
        keyId: "tenant-key",
        version: "1",
        customerManaged: true,
        attestation,
        materialBase64: Buffer.alloc(32, 7).toString("base64"),
      }],
    }));
    const key = {
      provider: "external-vault",
      keyId: "tenant-key",
      version: "1",
      customerManaged: true,
    } as const;
    const registry = new EnvelopeKeyLifecycleRegistry();
    registry.register(lifecycle(key, 1));
    const original = configured("kms:key/tenant-key:attestation-one");
    const envelope = await new EnvelopeSecretVault(registry, [original], () => undefined)
      .encrypt("github-token", "customer-secret", key, context);
    expect(envelope.keyAttestationSha256).toMatch(/^[a-f0-9]{64}$/);

    const restarted = new EnvelopeSecretVault(registry, [configured(
      "kms:key/tenant-key:attestation-two",
    )], () => undefined);
    await expect(restarted.decrypt(envelope, context)).rejects.toThrow("vault_decrypt_denied");
    await expect(new EnvelopeSecretVault(registry, [original], () => undefined).decrypt({
      ...envelope,
      keyAttestationSha256: "f".repeat(64),
    }, context)).rejects.toThrow("vault_decrypt_denied");
  });

  it("derives customer managed classification from provider attestation", async () => {
    const provider = ConfiguredEnvelopeKeyProvider.fromJson(JSON.stringify({
      schemaVersion: 1,
      keys: [{
        tenantId: "tenant-a",
        provider: "external-vault",
        keyId: "tenant-key",
        version: "1",
        customerManaged: true,
        attestation: "kms:key/tenant-key:1",
        materialBase64: Buffer.alloc(32, 7).toString("base64"),
      }],
    }));

    await expect(provider.attestKey({
      provider: "external-vault",
      keyId: "tenant-key",
      version: "1",
    }, "tenant-a")).resolves.toMatchObject({ customerManaged: true });
    await expect(provider.wrapDataKey({
      provider: "external-vault",
      keyId: "tenant-key",
      version: "1",
      customerManaged: false,
    }, "tenant-a", Buffer.alloc(32, 1))).rejects.toThrow("vault_key_attestation_mismatch");
  });

  it("keeps production provider wiring disabled when configuration is absent or invalid", () => {
    expect(envelopeKeyProvidersFromEnvironment(undefined)[0]).toBeInstanceOf(
      DisabledExternalVaultProvider,
    );
    expect(() => envelopeKeyProvidersFromEnvironment("{not-json"))
      .toThrow("external_vault_configuration_invalid");
  });

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

  it.each([
    [false, true],
    [true, false],
  ] as const)(
    "rejects customer-managed relabeling from %s to %s",
    async (customerManaged, relabeled) => {
      const key = { ...key1, customerManaged };
      const material = Buffer.alloc(32, 1);
      const registry = new EnvelopeKeyLifecycleRegistry();
      registry.register(lifecycle(key, 1));
      const provider = new LocalEnvelopeKeyProvider();
      provider.putKey("tenant-a", key, material);
      const vault = new EnvelopeSecretVault(registry, [provider], () => undefined);
      const envelope = await vault.encrypt("github-token", "customer-secret", key, context);

      const relabeledKey = { ...key, customerManaged: relabeled };
      const relabeledRegistry = new EnvelopeKeyLifecycleRegistry();
      relabeledRegistry.register(lifecycle(relabeledKey, 1));
      const relabeledProvider = new LocalEnvelopeKeyProvider();
      relabeledProvider.putKey("tenant-a", relabeledKey, material);
      const relabeledVault = new EnvelopeSecretVault(
        relabeledRegistry,
        [relabeledProvider],
        () => undefined,
      );

      await expect(relabeledVault.decrypt({
        ...envelope,
        key: relabeledKey,
      }, context)).rejects.toThrow("vault_decrypt_denied");
    },
  );

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

  it("does not publish lifecycle rotation until replacement audit succeeds", async () => {
    const registry = new EnvelopeKeyLifecycleRegistry();
    registry.register(lifecycle(key1, 1));
    const provider = new LocalEnvelopeKeyProvider();
    provider.putKey("tenant-a", key1, Buffer.alloc(32, 1));
    provider.putKey("tenant-a", key2, Buffer.alloc(32, 2));
    const vault = new EnvelopeSecretVault(registry, [provider], (event) => {
      if (event.operation === "rotate") throw new Error("audit offline");
    });
    const envelope = await vault.encrypt("github-token", "customer-secret", key1, context);

    await expect(vault.rotate(envelope, lifecycle(key2, 2), {
      ...context,
      at: "2026-08-03T00:00:00.000Z",
    })).rejects.toThrow("vault_access_audit_failed");

    expect(registry.get("tenant-a", key1)?.state).toBe("active");
    expect(registry.get("tenant-a", key2)).toBeUndefined();
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

describe("durable envelope secret provider", () => {
  it("rejects generation-one ciphertext transplanted into generation two", async () => {
    const { vault, provider } = setup();
    const generationOneEnvelope = await vault.encrypt(
      "scm-credential-a",
      "generation-one-secret",
      key1,
      context,
    );
    let stored: DurableEnvelopeSecretVersion = {
      credentialId: "scm-credential-a",
      generation: 2,
      state: "active",
      key: key1,
      envelope: { ...generationOneEnvelope, generation: 2 },
      issuedAt: at,
    };
    const durable = new DurableEnvelopeSecretProvider({
      tenantId: "tenant-a",
      actorId: "service:api",
      correlationId: "request-1",
      purpose: "materialize_read_only_repository_snapshot",
      at: () => at,
      keyProviders: [provider],
      resolve: async () => stored,
      audit: () => undefined,
    });

    await expect(durable.read({
      provider: "durable-envelope",
      id: "scm-credential-a",
      version: "2",
    })).rejects.toThrow("vault_decrypt_denied");

    stored = { ...stored, envelope: generationOneEnvelope };
    await expect(durable.read({
      provider: "durable-envelope",
      id: "scm-credential-a",
      version: "2",
    })).rejects.toThrow("vault_secret_binding_invalid");
  });

  it.each([
    [false, true],
    [true, false],
  ] as const)(
    "rejects durable metadata relabeled from customerManaged %s to %s",
    async (customerManaged, relabeled) => {
      const key = { ...key1, customerManaged };
      const registry = new EnvelopeKeyLifecycleRegistry();
      registry.register(lifecycle(key, 1));
      const provider = new LocalEnvelopeKeyProvider();
      provider.putKey("tenant-a", key, Buffer.alloc(32, 1));
      const vault = new EnvelopeSecretVault(registry, [provider], () => undefined);
      const envelope = await vault.encrypt(
        "scm-credential-a",
        "customer-secret",
        key,
        context,
      );
      const stored: DurableEnvelopeSecretVersion = {
        credentialId: "scm-credential-a",
        generation: 1,
        state: "active",
        key: { ...key, customerManaged: relabeled },
        envelope,
        issuedAt: at,
      };
      const durable = new DurableEnvelopeSecretProvider({
        tenantId: "tenant-a",
        actorId: "service:api",
        correlationId: "request-1",
        purpose: "materialize_read_only_repository_snapshot",
        at: () => at,
        keyProviders: [provider],
        resolve: async () => stored,
        audit: () => undefined,
      });

      await expect(durable.read({
        provider: "durable-envelope",
        id: "scm-credential-a",
        version: "1",
      })).rejects.toThrow("vault_secret_binding_invalid");
    },
  );

  it("reloads lifecycle state for every read so rotation and revocation invalidate material", async () => {
    const { vault, provider } = setup();
    const envelope = await vault.encrypt("scm-credential-a", "customer-secret", key1, context);
    let stored: DurableEnvelopeSecretVersion = {
      credentialId: "scm-credential-a",
      generation: 1,
      state: "active",
      key: key1,
      envelope,
      issuedAt: at,
    };
    const durable = new DurableEnvelopeSecretProvider({
      tenantId: "tenant-a",
      actorId: "service:api",
      correlationId: "request-1",
      purpose: "materialize_read_only_repository_snapshot",
      at: () => at,
      keyProviders: [provider],
      resolve: async () => stored,
      audit: () => undefined,
    });

    await expect(durable.read({
      provider: "durable-envelope",
      id: "scm-credential-a",
      version: "1",
    })).resolves.toBe("customer-secret");

    stored = { ...stored, state: "revoked", revokedAt: at, revocationReason: "incident" };
    await expect(durable.read({
      provider: "durable-envelope",
      id: "scm-credential-a",
      version: "1",
    })).rejects.toThrow("vault_secret_generation_inactive");
  });

  it("fails closed when the configured provider is absent, disabled, wrong-version, or unauditable", async () => {
    const { vault } = setup();
    const envelope = await vault.encrypt("scm-credential-a", "customer-secret", key1, context);
    const stored: DurableEnvelopeSecretVersion = {
      credentialId: "scm-credential-a",
      generation: 1,
      state: "active",
      key: key1,
      envelope,
      issuedAt: at,
    };
    const options = {
      tenantId: "tenant-a",
      actorId: "service:api",
      correlationId: "request-1",
      purpose: "materialize_read_only_repository_snapshot",
      at: () => at,
      resolve: async () => stored,
    };

    await expect(new DurableEnvelopeSecretProvider({
      ...options,
      keyProviders: [],
      audit: () => undefined,
    }).read({ provider: "durable-envelope", id: "scm-credential-a", version: "1" }))
      .rejects.toThrow("vault_decrypt_denied");

    await expect(new DurableEnvelopeSecretProvider({
      ...options,
      keyProviders: [new DisabledExternalVaultProvider("local-envelope")],
      audit: () => undefined,
    }).read({ provider: "durable-envelope", id: "scm-credential-a", version: "1" }))
      .rejects.toThrow("vault_decrypt_denied");

    const wrongVersion = new LocalEnvelopeKeyProvider();
    wrongVersion.putKey("tenant-a", { ...key1, version: "2" }, Buffer.alloc(32, 2));
    await expect(new DurableEnvelopeSecretProvider({
      ...options,
      keyProviders: [wrongVersion],
      audit: () => undefined,
    }).read({ provider: "durable-envelope", id: "scm-credential-a", version: "1" }))
      .rejects.toThrow("vault_decrypt_denied");

    const configured = new LocalEnvelopeKeyProvider();
    configured.putKey("tenant-a", key1, Buffer.alloc(32, 1));
    await expect(new DurableEnvelopeSecretProvider({
      ...options,
      keyProviders: [configured],
      audit: () => {
        throw new Error("audit unavailable");
      },
    }).read({ provider: "durable-envelope", id: "scm-credential-a", version: "1" }))
      .rejects.toThrow("vault_access_audit_failed");
  });
});
