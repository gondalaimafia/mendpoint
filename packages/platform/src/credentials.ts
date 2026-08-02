/** A locator for secret material. It never contains the secret value. */
export type SecretReference<Provider extends string = string> = Readonly<{
  provider: Provider;
  id: string;
  version?: string;
}>;

export type EnvSecretReference = SecretReference<"env">;
export type MemorySecretReference = SecretReference<"memory">;

export type CredentialRotationMetadata = Readonly<{
  generation: number;
  issuedAt: string;
  rotatedAt?: string;
  rotateAfter?: string;
  supersedesCredentialId?: string;
}>;

export type CredentialRevocation = Readonly<{
  revokedAt: string;
  reason?: string;
}>;

export type CredentialDescriptor = Readonly<{
  credentialId: string;
  secret: SecretReference;
  audiences: readonly string[];
  expiresAt?: string;
  revocation?: CredentialRevocation;
  rotation: CredentialRotationMetadata;
}>;

export interface SecretProvider {
  readonly provider: string;
  read(reference: SecretReference): Promise<string | undefined>;
}

export type CredentialAccessReason =
  | "granted"
  | "audience_denied"
  | "expired"
  | "revoked"
  | "invalid_metadata"
  | "provider_not_found"
  | "provider_error"
  | "secret_not_found";

export type CredentialAccessAuditEvent = Readonly<{
  credentialId: string;
  reference: SecretReference;
  actorId: string;
  audience: string;
  purpose: string;
  requestId?: string;
  occurredAt: string;
  outcome: "granted" | "denied";
  reason: CredentialAccessReason;
  rotation: Readonly<{
    generation: number;
    due: boolean;
  }>;
}>;

export type CredentialAccessAudit = (
  event: CredentialAccessAuditEvent,
) => void | Promise<void>;

export type CredentialAccessRequest = Readonly<{
  actorId: string;
  audience: string;
  purpose: string;
  requestId?: string;
  at?: Date;
}>;

export type CredentialAccessErrorCode = Exclude<
  CredentialAccessReason,
  "granted"
> | "audit_failed";

const ERROR_MESSAGES: Record<CredentialAccessErrorCode, string> = {
  audience_denied: "Credential audience denied",
  expired: "Credential expired",
  revoked: "Credential revoked",
  invalid_metadata: "Credential metadata is invalid",
  provider_not_found: "Secret provider not found",
  provider_error: "Secret provider failed",
  secret_not_found: "Secret material not found",
  audit_failed: "Credential access audit failed",
};

export class CredentialAccessError extends Error {
  constructor(readonly code: CredentialAccessErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CredentialAccessError";
  }
}

/** Secret material redacts itself from common string and JSON serialization. */
export class SecretMaterial {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
    Object.freeze(this);
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }
}

export type ResolvedCredential = Readonly<{
  credentialId: string;
  secret: SecretMaterial;
  rotation: Readonly<{
    generation: number;
    due: boolean;
    rotateAfter?: string;
  }>;
}>;

export class EnvSecretProvider implements SecretProvider {
  readonly provider = "env";

  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> =
      process.env,
  ) {}

  async read(reference: SecretReference): Promise<string | undefined> {
    if (reference.provider !== this.provider) return undefined;
    return this.env[reference.id];
  }
}

/** Volatile provider intended for tests and local development. */
export class MemorySecretProvider implements SecretProvider {
  readonly provider = "memory";
  readonly #values = new Map<string, string>();

  constructor(entries: Readonly<Record<string, string>> = {}) {
    for (const [id, value] of Object.entries(entries)) {
      this.#values.set(id, value);
    }
  }

  async read(reference: SecretReference): Promise<string | undefined> {
    if (reference.provider !== this.provider) return undefined;
    return this.#values.get(reference.id);
  }

  put(reference: MemorySecretReference, value: string): void {
    this.#values.set(reference.id, value);
  }

  remove(reference: MemorySecretReference): void {
    this.#values.delete(reference.id);
  }

  clear(): void {
    this.#values.clear();
  }
}

export type CredentialBrokerOptions = Readonly<{
  providers: readonly SecretProvider[];
  audit: CredentialAccessAudit;
  now?: () => Date;
}>;

export class CredentialBroker {
  readonly #providers: ReadonlyMap<string, SecretProvider>;
  readonly #audit: CredentialAccessAudit;
  readonly #now: () => Date;

  constructor(options: CredentialBrokerOptions) {
    const providers = new Map<string, SecretProvider>();
    for (const provider of options.providers) {
      if (providers.has(provider.provider)) {
        throw new Error("Duplicate secret provider");
      }
      providers.set(provider.provider, provider);
    }
    this.#providers = providers;
    this.#audit = options.audit;
    this.#now = options.now ?? (() => new Date());
  }

  async access(
    credential: CredentialDescriptor,
    request: CredentialAccessRequest,
  ): Promise<ResolvedCredential> {
    const at = request.at ?? this.#now();
    const atMs = at.getTime();
    const metadata = validateMetadata(credential);
    const rotationDue = metadata.rotateAfterMs != null && atMs >= metadata.rotateAfterMs;

    if (!Number.isFinite(atMs)) {
      return this.#deny(credential, request, new Date(0), false, "invalid_metadata");
    }
    if (!metadata.valid) {
      return this.#deny(credential, request, at, false, "invalid_metadata");
    }
    if (credential.revocation) {
      return this.#deny(credential, request, at, rotationDue, "revoked");
    }
    if (metadata.expiresAtMs != null && atMs >= metadata.expiresAtMs) {
      return this.#deny(credential, request, at, rotationDue, "expired");
    }
    if (!credential.audiences.includes(request.audience)) {
      return this.#deny(
        credential,
        request,
        at,
        rotationDue,
        "audience_denied",
      );
    }

    const provider = this.#providers.get(credential.secret.provider);
    if (!provider) {
      return this.#deny(
        credential,
        request,
        at,
        rotationDue,
        "provider_not_found",
      );
    }

    let value: string | undefined;
    try {
      value = await provider.read(credential.secret);
    } catch {
      return this.#deny(
        credential,
        request,
        at,
        rotationDue,
        "provider_error",
      );
    }
    if (value === undefined || value.length === 0) {
      return this.#deny(
        credential,
        request,
        at,
        rotationDue,
        "secret_not_found",
      );
    }

    await this.#emitAudit(
      auditEvent(credential, request, at, rotationDue, "granted", "granted"),
    );

    return Object.freeze({
      credentialId: credential.credentialId,
      secret: new SecretMaterial(value),
      rotation: Object.freeze({
        generation: credential.rotation.generation,
        due: rotationDue,
        rotateAfter: credential.rotation.rotateAfter,
      }),
    });
  }

  async #deny(
    credential: CredentialDescriptor,
    request: CredentialAccessRequest,
    at: Date,
    rotationDue: boolean,
    reason: CredentialAccessErrorCode,
  ): Promise<never> {
    if (reason === "audit_failed") throw new CredentialAccessError(reason);
    await this.#emitAudit(
      auditEvent(credential, request, at, rotationDue, "denied", reason),
    );
    throw new CredentialAccessError(reason);
  }

  async #emitAudit(event: CredentialAccessAuditEvent): Promise<void> {
    try {
      await this.#audit(event);
    } catch {
      throw new CredentialAccessError("audit_failed");
    }
  }
}

function validateMetadata(credential: CredentialDescriptor): {
  valid: boolean;
  expiresAtMs?: number;
  rotateAfterMs?: number;
} {
  const issuedAtMs = Date.parse(credential.rotation.issuedAt);
  const rotatedAtMs = parseOptionalDate(credential.rotation.rotatedAt);
  const rotateAfterMs = parseOptionalDate(credential.rotation.rotateAfter);
  const expiresAtMs = parseOptionalDate(credential.expiresAt);
  const revokedAtMs = parseOptionalDate(credential.revocation?.revokedAt);
  const valid =
    Number.isInteger(credential.rotation.generation) &&
    credential.rotation.generation >= 1 &&
    Number.isFinite(issuedAtMs) &&
    rotatedAtMs.valid &&
    rotateAfterMs.valid &&
    expiresAtMs.valid &&
    revokedAtMs.valid;
  return {
    valid,
    expiresAtMs: expiresAtMs.value,
    rotateAfterMs: rotateAfterMs.value,
  };
}

function parseOptionalDate(value: string | undefined): {
  valid: boolean;
  value?: number;
} {
  if (value === undefined) return { valid: true };
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? { valid: true, value: parsed }
    : { valid: false };
}

function auditEvent(
  credential: CredentialDescriptor,
  request: CredentialAccessRequest,
  at: Date,
  rotationDue: boolean,
  outcome: CredentialAccessAuditEvent["outcome"],
  reason: CredentialAccessReason,
): CredentialAccessAuditEvent {
  return Object.freeze({
    credentialId: credential.credentialId,
    reference: Object.freeze({ ...credential.secret }),
    actorId: request.actorId,
    audience: request.audience,
    purpose: request.purpose,
    requestId: request.requestId,
    occurredAt: at.toISOString(),
    outcome,
    reason,
    rotation: Object.freeze({
      generation: credential.rotation.generation,
      due: rotationDue,
    }),
  });
}
