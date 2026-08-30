import {
  createApiKeyFromToken,
  findApiKeyByToken,
  getPrincipal,
  insertPrincipal,
  listApiKeys,
  recordAudit,
  type AppDb,
} from "@mendpoint/db";
import { scimBindingsFromEnv } from "@mendpoint/platform";
import { createHash } from "node:crypto";
import { validateScimBindings } from "./scim.js";

const TOKEN = /^me_[A-Za-z0-9_-]{32,}$/;

type BootstrapAuthority = Readonly<{
  tenantId: string;
  principalId: string;
  keyId: string;
  subject: string;
  displayName: string;
  expiresAt: string;
  token: string;
}>;

function requiredText(value: unknown, code: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new Error(code);
  }
  return value.trim();
}

function parseAuthorities(
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<string, BootstrapAuthority> {
  const raw = env.MENDPOINT_SCIM_BOOTSTRAP_AUTHORITIES_JSON?.trim();
  if (!raw) throw new Error("scim_bootstrap_authorities_required");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("scim_bootstrap_authorities_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("scim_bootstrap_authorities_invalid");
  }
  const document = value as { schemaVersion?: unknown; authorities?: unknown };
  if (document.schemaVersion !== 1 || !Array.isArray(document.authorities)) {
    throw new Error("scim_bootstrap_authorities_invalid");
  }
  const authorities = new Map<string, BootstrapAuthority>();
  for (const item of document.authorities) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("scim_bootstrap_authorities_invalid");
    }
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some((key) => ![
      "tenantId", "principalId", "keyId", "subject", "displayName", "expiresAt", "token",
    ].includes(key))) throw new Error("scim_bootstrap_authorities_invalid");
    const authority = Object.freeze({
      tenantId: requiredText(row.tenantId, "scim_bootstrap_authorities_invalid", 255),
      principalId: requiredText(row.principalId, "scim_bootstrap_authorities_invalid", 128),
      keyId: requiredText(row.keyId, "scim_bootstrap_authorities_invalid", 128),
      subject: requiredText(row.subject, "scim_bootstrap_authorities_invalid", 128),
      displayName: requiredText(row.displayName, "scim_bootstrap_authorities_invalid", 200),
      expiresAt: requiredText(row.expiresAt, "scim_bootstrap_authorities_invalid", 64),
      token: requiredText(row.token, "scim_bootstrap_authorities_invalid", 512),
    });
    if (!TOKEN.test(authority.token) || authorities.has(authority.tenantId)) {
      throw new Error("scim_bootstrap_authorities_invalid");
    }
    authorities.set(authority.tenantId, authority);
  }
  return authorities;
}

function exactPrincipal(
  principal: NonNullable<ReturnType<typeof getPrincipal>>,
  authority: BootstrapAuthority,
  observedAt: string,
): boolean {
  return principal.id === authority.principalId &&
    principal.kind === "service" &&
    principal.subject === authority.subject &&
    principal.display_name === authority.displayName &&
    principal.audience === "mendpoint-scim" &&
    principal.expires_at === authority.expiresAt &&
    principal.revoked_at === null &&
    principal.created_at <= observedAt;
}

/**
 * Materialize the exact protected SCIM binding before the API process starts.
 * The caller must remove MENDPOINT_SCIM_BOOTSTRAP_AUTHORITIES_JSON from every
 * long-lived child environment after this operation returns.
 */
export function bootstrapScimAuthorities(
  db: AppDb,
  env: Readonly<Record<string, string | undefined>>,
  observedAt = new Date().toISOString(),
): void {
  if (!Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) {
    throw new Error("scim_bootstrap_observed_at_invalid");
  }
  const bindings = scimBindingsFromEnv(env);
  if (bindings.size === 0) return;
  const authorities = parseAuthorities(env);
  if (
    authorities.size !== bindings.size ||
    [...bindings.keys()].some((tenantId) => !authorities.has(tenantId))
  ) throw new Error("scim_bootstrap_binding_set_mismatch");

  db.raw.exec("BEGIN IMMEDIATE");
  try {
    for (const binding of bindings.values()) {
      const authority = authorities.get(binding.tenantId)!;
      if (
        authority.principalId !== binding.principalId ||
        !Number.isFinite(Date.parse(authority.expiresAt)) ||
        new Date(authority.expiresAt).toISOString() !== authority.expiresAt ||
        authority.expiresAt <= observedAt
      ) throw new Error("scim_bootstrap_authority_mismatch");

      let principal = getPrincipal(db, binding.tenantId, binding.principalId);
      let created = false;
      if (!principal) {
        principal = insertPrincipal(db, {
          id: authority.principalId,
          tenantId: binding.tenantId,
          kind: "service",
          subject: authority.subject,
          displayName: authority.displayName,
          audience: "mendpoint-scim",
          expiresAt: authority.expiresAt,
          createdAt: observedAt,
        });
        created = true;
      }
      if (!exactPrincipal(principal, authority, observedAt)) {
        throw new Error("scim_bootstrap_principal_conflict");
      }

      const keys = listApiKeys(db, binding.tenantId);
      const keyById = keys.find((key) => key.id === authority.keyId);
      const keyByToken = findApiKeyByToken(db, authority.token);
      if (!keyById && !keyByToken) {
        createApiKeyFromToken(db, {
          id: authority.keyId,
          name: `${authority.displayName} credential`,
          tenantId: binding.tenantId,
          principalId: binding.principalId,
          token: authority.token,
          scopes: ["identity:provision"],
          createdAt: observedAt,
        });
        created = true;
      } else if (
        !keyById || !keyByToken || keyById.id !== keyByToken.id ||
        keyById.tenant_id !== binding.tenantId ||
        keyById.principal_id !== binding.principalId ||
        keyById.revoked_at !== null ||
        keyById.created_at > observedAt ||
        keyById.scopes_json !== JSON.stringify(["identity:provision"])
      ) {
        throw new Error("scim_bootstrap_credential_conflict");
      }

      if (created) {
        recordAudit(db, {
          id: `audit-scim-bootstrap-${createHash("sha256")
            .update(`${binding.tenantId}\n${binding.principalId}\n${authority.keyId}`, "utf8")
            .digest("hex").slice(0, 32)}`,
          tenantId: binding.tenantId,
          actor: "system:scim-bootstrap",
          principalId: binding.principalId,
          apiKeyId: authority.keyId,
          action: "scim.authority.bootstrap",
          resourceType: "service_principal",
          resourceId: binding.principalId,
          metadata: { keyId: authority.keyId, issuer: binding.issuer, expiresAt: authority.expiresAt },
        });
      }
    }
    validateScimBindings(db, bindings, observedAt);
    db.raw.exec("COMMIT");
  } catch (error) {
    if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}
