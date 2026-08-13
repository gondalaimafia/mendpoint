/**
 * Connector credential handling.
 *
 * Connector secrets (CI tokens, Jira API keys, Notion integration tokens) are
 * NEVER stored in plaintext and NEVER logged. This wraps the existing
 * AES-256-GCM envelope vault (`packages/platform/src/vault-envelope.ts`): a
 * random per-secret data key encrypts the token, and that data key is wrapped by
 * a key-encryption-key (KEK). The stored artifact is an `EnvelopeSecret` — a JSON
 * object whose ciphertext contains the token; the plaintext never appears in the
 * serialized form. Decryption returns a `SecretMaterial` (from
 * `packages/platform/src/credentials.ts`) which redacts itself in `toString`/
 * `toJSON`, so a token can never leak through logging or `JSON.stringify`.
 *
 * The envelope binds the tenantId into the AES AAD, so a credential sealed for
 * tenant A cannot be opened under tenant B — cross-tenant reads fail closed with
 * `tenant_mismatch`.
 */
import { createHash } from "node:crypto";
import {
  EnvelopeKeyLifecycleRegistry,
  EnvelopeSecretVault,
  LocalEnvelopeKeyProvider,
  SecretMaterial,
  type EnvelopeKeyReference,
  type EnvelopeSecret,
  type SecretAccessContext,
} from "@mendpoint/platform";

/** The stored, at-rest credential shape. Ciphertext only — no plaintext. */
export type SealedCredential = EnvelopeSecret;

/** The env var holding the base64-encoded 32-byte key-encryption-key. */
export const CONNECTOR_KEK_ENV = "MENDPOINT_CONNECTOR_KEK" as const;

const CONNECTOR_KEY_REFERENCE: EnvelopeKeyReference = Object.freeze({
  provider: "local-envelope",
  keyId: "connector-kek",
  version: "1",
  customerManaged: false,
});

const KEK_CREATED_AT = "2026-01-01T00:00:00.000Z";

export type ConnectorCredentialContextInput = Readonly<{
  actorId?: string;
  correlationId?: string;
  purpose?: string;
  at?: string;
}>;

/**
 * Envelope-backed credential store for connectors. One 32-byte KEK protects
 * every tenant's connector secrets; the tenant is bound into the envelope AAD so
 * secrets remain tenant-isolated even under a shared KEK.
 */
export class ConnectorCredentialVault {
  readonly #vault: EnvelopeSecretVault;
  readonly #provider: LocalEnvelopeKeyProvider;
  readonly #registry: EnvelopeKeyLifecycleRegistry;
  readonly #material: Buffer;
  readonly #tenants = new Set<string>();

  constructor(keyMaterial: Uint8Array) {
    if (keyMaterial.byteLength !== 32) {
      throw new Error("connector_kek_invalid_length");
    }
    this.#material = Buffer.from(keyMaterial);
    this.#registry = new EnvelopeKeyLifecycleRegistry();
    this.#provider = new LocalEnvelopeKeyProvider();
    // Audit is a required sink; connectors have their own route-level audit, so
    // this envelope-level sink is intentionally inert (must never throw).
    this.#vault = new EnvelopeSecretVault(this.#registry, [this.#provider], () => {});
  }

  #ensureTenant(tenantId: string): void {
    if (this.#tenants.has(tenantId)) return;
    this.#registry.register({
      tenantId,
      key: CONNECTOR_KEY_REFERENCE,
      generation: 1,
      state: "active",
      createdAt: KEK_CREATED_AT,
    });
    this.#provider.putKey(tenantId, CONNECTOR_KEY_REFERENCE, this.#material);
    this.#tenants.add(tenantId);
  }

  #context(
    tenantId: string,
    purpose: string,
    input?: ConnectorCredentialContextInput,
  ): SecretAccessContext {
    return {
      tenantId,
      actorId: input?.actorId ?? "service:connectors",
      correlationId: input?.correlationId ?? "connector-credential",
      purpose: input?.purpose ?? purpose,
      at: input?.at ?? KEK_CREATED_AT,
    };
  }

  /** Encrypt a connector secret at rest. Returns the JSON-serializable envelope. */
  async seal(
    tenantId: string,
    secretId: string,
    plaintext: string,
    context?: ConnectorCredentialContextInput,
  ): Promise<SealedCredential> {
    this.#ensureTenant(tenantId);
    return this.#vault.encrypt(
      secretId,
      plaintext,
      CONNECTOR_KEY_REFERENCE,
      this.#context(tenantId, "seal connector credential", context),
    );
  }

  /**
   * Decrypt a sealed credential, tenant-scoped. Returns a redacting
   * `SecretMaterial`; call `.reveal()` only at the moment of use. Opening a
   * credential under the wrong tenant throws `tenant_mismatch`.
   */
  async open(
    sealed: SealedCredential,
    tenantId: string,
    context?: ConnectorCredentialContextInput,
  ): Promise<SecretMaterial> {
    this.#ensureTenant(tenantId);
    const plaintext = await this.#vault.decrypt(
      sealed,
      this.#context(tenantId, "open connector credential", context),
    );
    return new SecretMaterial(plaintext);
  }
}

/**
 * Build a `ConnectorCredentialVault` from the environment. The KEK is read from
 * `MENDPOINT_CONNECTOR_KEK` (base64, 32 bytes). When unset — local development
 * and the mock default — a deterministic dev KEK is derived so the flow works
 * without provisioning a key. Production real-mode deployments MUST set the env
 * var; the derived dev key is not a secret.
 */
export function connectorCredentialVaultFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ConnectorCredentialVault {
  const configured = env[CONNECTOR_KEK_ENV];
  if (configured && configured.trim() !== "") {
    const material = Buffer.from(configured, "base64");
    if (material.byteLength !== 32) throw new Error("connector_kek_invalid_length");
    return new ConnectorCredentialVault(material);
  }
  const devMaterial = createHash("sha256")
    .update("mendpoint-connector-dev-kek")
    .digest();
  return new ConnectorCredentialVault(devMaterial);
}
