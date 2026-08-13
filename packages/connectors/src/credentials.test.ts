import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConnectorCredentialVault, connectorCredentialVaultFromEnv, CONNECTOR_KEK_ENV } from "./credentials.js";

const KEY = createHash("sha256").update("connector-test-kek").digest();
const TOKEN = "glpat-super-secret-token-value";

describe("ConnectorCredentialVault", () => {
  it("seals a secret so the stored envelope never contains the plaintext", async () => {
    const vault = new ConnectorCredentialVault(KEY);
    const sealed = await vault.seal("tenant-a", "connector-1", TOKEN);
    expect(sealed.ciphertext).not.toContain(TOKEN);
    expect(JSON.stringify(sealed)).not.toContain(TOKEN);
    expect(sealed.algorithm).toBe("AES-256-GCM");
    expect(sealed.tenantId).toBe("tenant-a");
  });

  it("opens a sealed secret back to the plaintext for the owning tenant", async () => {
    const vault = new ConnectorCredentialVault(KEY);
    const sealed = await vault.seal("tenant-a", "connector-1", TOKEN);
    const opened = await vault.open(sealed, "tenant-a");
    expect(opened.reveal()).toBe(TOKEN);
    // SecretMaterial redacts itself in logs/serialization.
    expect(String(opened)).toBe("[REDACTED]");
    expect(JSON.stringify({ secret: opened })).toBe('{"secret":"[REDACTED]"}');
  });

  it("fails closed when another tenant tries to open the credential", async () => {
    const vault = new ConnectorCredentialVault(KEY);
    const sealed = await vault.seal("tenant-a", "connector-1", TOKEN);
    await expect(vault.open(sealed, "tenant-b")).rejects.toThrow("tenant_mismatch");
  });

  it("rejects a KEK that is not 32 bytes", () => {
    expect(() => new ConnectorCredentialVault(Buffer.alloc(16))).toThrow("connector_kek_invalid_length");
  });

  it("reads a base64 KEK from the environment", async () => {
    const env = { [CONNECTOR_KEK_ENV]: KEY.toString("base64") } as NodeJS.ProcessEnv;
    const vault = connectorCredentialVaultFromEnv(env);
    const sealed = await vault.seal("tenant-a", "connector-1", TOKEN);
    expect(await (await vault.open(sealed, "tenant-a")).reveal()).toBe(TOKEN);
  });

  it("derives a deterministic dev KEK when the env var is unset", async () => {
    const vault = connectorCredentialVaultFromEnv({} as NodeJS.ProcessEnv);
    const sealed = await vault.seal("tenant-a", "connector-1", TOKEN);
    expect(sealed.ciphertext).not.toContain(TOKEN);
    expect(await (await vault.open(sealed, "tenant-a")).reveal()).toBe(TOKEN);
  });
});
