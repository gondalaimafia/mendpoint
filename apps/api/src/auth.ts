/**
 * Light multi-tenant API key auth (Phase D).
 *
 * Modes (API_AUTH env):
 * - off (default): open access unless keys exist AND API_AUTH=auto with keys
 * - auto: require key only when ≥1 active key in DB
 * - required: always require Bearer me_...
 *
 * Exempt paths: /health, /webhooks/*
 */
import type { Context, Next } from "hono";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import {
  bindApiKeyAuthorityPrincipal,
  countActiveApiKeys,
  claimIdentitySession,
  claimDelegatedRequestNonce,
  findApiKeyByToken,
  getTenantMembership,
  getPrincipal,
  getPrincipalBySubject,
  insertPrincipal,
  migrateLegacySelfServeOwnerKeyAuthority,
  touchApiKey,
  type AppDb,
} from "@mendpoint/db";
import {
  can,
  isPublicRoute,
  parsePrincipalFromHeaders,
  permissionForRoute,
  permissionsFor,
  type Permission,
  type Principal,
  type Role,
} from "@mendpoint/platform";

export type AuthMode = "off" | "auto" | "required";
export type ApiVariables = {
  requestId: string;
  tenantId?: string;
  apiKeyId?: string;
  authScopes?: string[];
  principal?: Principal;
  trustPrincipalId?: string;
  authorityPrincipalId?: string;
  authorityRole?: Role;
  authMethod?: "oidc" | "api_key";
  membershipEvidenceId?: string;
  identitySessionId?: string;
  webhookDeliveryId?: string;
  secretBreakGlassAuditHandled?: boolean;
};
export type ApiEnv = { Variables: ApiVariables };

export type OidcIdentity = {
  issuer: string;
  subject: string;
  tenantId: string;
  session?: Readonly<{
    issuedAt: string;
    expiresAt: string;
    authStrength: string;
  }>;
};

export type OidcVerifier = {
  verify(token: string): Promise<OidcIdentity>;
};

export type OidcVerifierConfig = {
  issuer: string;
  audience: string;
  tenantClaim: string;
  requiredAmr: string[];
  allowedAcr: string[];
  maxTokenAgeSeconds: number;
  jwks?: JWTVerifyGetKey;
  jwksUri?: string;
};

function activeTrustPrincipal(
  principal: Readonly<{ created_at: string; expires_at: string | null; revoked_at: string | null }>,
  observedAtMs = Date.now(),
): boolean {
  const createdAtMs = Date.parse(principal.created_at);
  const expiresAtMs = principal.expires_at === null ? null : Date.parse(principal.expires_at);
  return Number.isFinite(createdAtMs) && createdAtMs <= observedAtMs && principal.revoked_at === null &&
    (expiresAtMs === null || (Number.isFinite(expiresAtMs) && expiresAtMs > observedAtMs));
}

function textClaim(name: string, value: unknown, max = 512): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new Error(`oidc_${name}_invalid`);
  }
  return value;
}

export function createOidcVerifier(config: OidcVerifierConfig): OidcVerifier {
  const issuer = textClaim("issuer", config.issuer);
  if (new URL(issuer).protocol !== "https:") throw new Error("oidc_issuer_https_required");
  const audience = textClaim("audience", config.audience);
  const tenantClaim = textClaim("tenant_claim", config.tenantClaim, 128);
  if (!Number.isSafeInteger(config.maxTokenAgeSeconds) || config.maxTokenAgeSeconds < 60) {
    throw new Error("oidc_max_token_age_invalid");
  }
  if (config.requiredAmr.length === 0 && config.allowedAcr.length === 0) {
    throw new Error("oidc_mfa_policy_required");
  }
  const jwksUrl = config.jwksUri ? new URL(config.jwksUri) : null;
  if (jwksUrl && jwksUrl.protocol !== "https:") {
    throw new Error("oidc_jwks_https_required");
  }
  const jwks = config.jwks ?? (jwksUrl ? createRemoteJWKSet(jwksUrl) : null);
  if (!jwks) throw new Error("oidc_jwks_required");

  return {
    async verify(token: string): Promise<OidcIdentity> {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience,
        algorithms: ["RS256", "ES256"],
        requiredClaims: ["sub", "iat", "exp", tenantClaim],
        maxTokenAge: `${config.maxTokenAgeSeconds}s`,
        clockTolerance: 5,
      });
      const amr = Array.isArray(payload.amr)
        ? payload.amr.filter((value): value is string => typeof value === "string")
        : [];
      const acr = typeof payload.acr === "string" ? payload.acr : null;
      const amrSatisfied = config.requiredAmr.length > 0 &&
        config.requiredAmr.every((required) => amr.includes(required));
      const acrSatisfied = acr !== null && config.allowedAcr.includes(acr);
      if (!amrSatisfied && !acrSatisfied) throw new Error("oidc_mfa_required");
      return {
        issuer,
        subject: textClaim("subject", payload.sub, 255),
        tenantId: textClaim("tenant", payload[tenantClaim], 255),
        session: {
          issuedAt: new Date(payload.iat! * 1_000).toISOString(),
          expiresAt: new Date(payload.exp! * 1_000).toISOString(),
          authStrength: amrSatisfied
            ? `amr:${[...amr].sort().join(",")}`
            : `acr:${acr!}`,
        },
      };
    },
  };
}

function csv(value: string | undefined, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

export function oidcVerifierFromEnv(): OidcVerifier | null {
  const issuer = process.env.OIDC_ISSUER?.trim();
  const audience = process.env.OIDC_AUDIENCE?.trim();
  const jwksUri = process.env.OIDC_JWKS_URI?.trim();
  if (!issuer && !audience && !jwksUri) return null;
  if (!issuer || !audience || !jwksUri) throw new Error("oidc_configuration_incomplete");
  const maxTokenAgeSeconds = Number(process.env.OIDC_MAX_TOKEN_AGE_SECONDS ?? "3600");
  return createOidcVerifier({
    issuer,
    audience,
    jwksUri,
    tenantClaim: process.env.OIDC_TENANT_CLAIM?.trim() || "tenant_id",
    requiredAmr: csv(process.env.OIDC_REQUIRED_AMR, ["mfa"]),
    allowedAcr: csv(process.env.OIDC_ALLOWED_ACR),
    maxTokenAgeSeconds,
  });
}

export function authMode(): AuthMode {
  const m = (process.env.API_AUTH ?? "off").toLowerCase();
  if (m === "required" || m === "on" || m === "true") return "required";
  if (m === "auto") return "auto";
  return "off";
}

export function isExemptPath(path: string, method = "GET"): boolean {
  return isPublicRoute(method, path);
}

/** Production default: require API keys when NODE_ENV=production unless explicitly overridden. */
export function effectiveAuthMode(): AuthMode {
  const explicit = process.env.API_AUTH;
  if (explicit !== undefined && explicit !== "") return authMode();
  if ((process.env.NODE_ENV ?? "").toLowerCase() === "production") {
    return "required";
  }
  return authMode();
}

export function parseApiKeyScopes(scopesJson: string): string[] {
  try {
    const value = JSON.parse(scopesJson);
    return Array.isArray(value)
      ? value.filter((scope): scope is string => typeof scope === "string")
      : [];
  } catch {
    return [];
  }
}

export function roleFromApiKeyScopes(scopes: string[]): Role {
  if (scopes.includes("*")) return "owner";
  const declared = scopes
    .find((scope) => scope.startsWith("role:"))
    ?.slice("role:".length)
    .toLowerCase();
  return (["owner", "admin", "engineer", "viewer", "fde", "agent"] as Role[])
    .includes(declared as Role)
    ? (declared as Role)
    : "viewer";
}

export function scopeAllows(scopes: string[] | undefined, permission: Permission): boolean {
  if (!scopes) return false;
  if (permission === "identity:provision") return scopes.includes(permission);
  return scopes.includes("*") || scopes.includes(permission);
}

const API_KEY_ROLES = new Set<Role>(["owner", "admin", "engineer", "viewer", "fde", "agent"]);
const API_KEY_PERMISSIONS = new Set<Permission>([
  ...permissionsFor("owner"), ...permissionsFor("admin"), ...permissionsFor("engineer"),
  ...permissionsFor("viewer"), ...permissionsFor("fde"), ...permissionsFor("agent"),
]);

function roleWithinStableAuthority(role: Role, authorityRole: Role): boolean {
  if (role === "owner" && authorityRole !== "owner") return false;
  return permissionsFor(role).every((permission) =>
    permissionsFor(authorityRole).includes(permission)
  );
}

function humanMembershipForAuthority(
  db: AppDb,
  tenantId: string,
  principal: NonNullable<ReturnType<typeof getPrincipal>>,
) {
  if (principal.kind !== "human" || !principal.audience) return null;
  const prefix = `${principal.audience}|`;
  if (!principal.subject.startsWith(prefix)) return null;
  const subject = principal.subject.slice(prefix.length);
  if (!subject) return null;
  return getTenantMembership(db, tenantId, principal.audience, subject) ?? null;
}

function effectiveHumanAuthorityRole(stableRole: Role | null, currentRole: Role): Role | null {
  if (stableRole === null) return currentRole;
  if (roleWithinStableAuthority(stableRole, currentRole)) return stableRole;
  if (roleWithinStableAuthority(currentRole, stableRole)) return currentRole;
  return null;
}

export function attenuateApiKeyScopes(input: Readonly<{
  principalRole: Role;
  currentScopes: readonly string[];
  requestedScopes?: readonly string[];
}>): string[] {
  const requested = input.requestedScopes === undefined
    ? (input.currentScopes.includes("*")
        ? [`role:${input.principalRole}`, ...permissionsFor(input.principalRole)]
        : [...input.currentScopes])
    : [...input.requestedScopes];
  if (requested.length === 0 || requested.some((scope) => !scope.trim())) {
    throw new Error("api_key_scope_invalid");
  }
  if (requested.includes("*")) {
    if (requested.length !== 1 || input.principalRole !== "owner" || !input.currentScopes.includes("*")) {
      throw new Error("api_key_authority_amplification");
    }
    return ["*"];
  }
  const roleScopes = requested.filter((scope) => scope.startsWith("role:"));
  if (roleScopes.length !== 1) throw new Error("api_key_scope_role_required");
  const requestedRole = roleScopes[0]!.slice("role:".length) as Role;
  if (!API_KEY_ROLES.has(requestedRole)) throw new Error("api_key_scope_invalid");
  if (requestedRole === "owner" && input.principalRole !== "owner") {
    throw new Error("api_key_authority_amplification");
  }
  if (permissionsFor(requestedRole).some(
    (permission) => !permissionsFor(input.principalRole).includes(permission),
  )) throw new Error("api_key_authority_amplification");
  for (const scope of requested) {
    if (scope.startsWith("role:")) continue;
    if (!API_KEY_PERMISSIONS.has(scope as Permission)) throw new Error("api_key_scope_invalid");
    if (
      !permissionsFor(input.principalRole).includes(scope as Permission) ||
      (!input.currentScopes.includes("*") && !input.currentScopes.includes(scope))
    ) throw new Error("api_key_authority_amplification");
  }
  return [...new Set(requested)];
}

const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const SIGNATURE = /^[a-f0-9]{64}$/;
const DELEGATION_MAX_SKEW_MS = 5 * 60 * 1000;
const DELEGATED_ACTOR_PUBLIC_ERRORS = new Set([
  "delegated_actor_expired",
  "delegated_actor_invalid",
  "delegated_actor_signature_invalid",
]);

export function delegatedActorSignature(
  apiKey: string,
  input: {
    actor: string;
    timestamp: string;
    requestId: string;
    method: string;
    path: string;
  },
): string {
  const canonical = [
    input.actor,
    input.timestamp,
    input.requestId,
    input.method.toUpperCase(),
    input.path,
  ].join("\n");
  return createHmac("sha256", apiKey).update(canonical, "utf8").digest("hex");
}

export function verifyDelegatedActor(
  apiKey: string,
  input: {
    actor?: string;
    timestamp?: string;
    signature?: string;
    requestId: string;
    method: string;
    path: string;
    now?: Date;
  },
): string | null {
  const supplied = [input.actor, input.timestamp, input.signature];
  if (supplied.every((value) => value === undefined)) return null;
  if (
    !input.actor ||
    !ACTOR.test(input.actor) ||
    !input.timestamp ||
    !input.signature ||
    !SIGNATURE.test(input.signature)
  ) {
    throw new Error("delegated_actor_invalid");
  }
  const timestamp = Date.parse(input.timestamp);
  const now = (input.now ?? new Date()).getTime();
  if (
    !Number.isFinite(timestamp) ||
    !Number.isFinite(now) ||
    Math.abs(now - timestamp) > DELEGATION_MAX_SKEW_MS
  ) {
    throw new Error("delegated_actor_expired");
  }
  const expected = delegatedActorSignature(apiKey, {
    actor: input.actor,
    timestamp: input.timestamp,
    requestId: input.requestId,
    method: input.method,
    path: input.path,
  });
  const actualBytes = Buffer.from(input.signature, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    throw new Error("delegated_actor_signature_invalid");
  }
  return input.actor;
}

export function createAuthMiddleware(
  db: AppDb,
  options: { oidc?: OidcVerifier | null; now?: () => Date } = {},
) {
  const oidc = options.oidc === undefined ? oidcVerifierFromEnv() : options.oidc;
  const apiKeyTouchedAt = new Map<string, number>();
  return async (c: Context<ApiEnv>, next: Next) => {
    const observedAt = (options.now ?? (() => new Date()))();
    const observedAtMs = observedAt.getTime();
    if (!Number.isFinite(observedAtMs)) throw new Error("auth_observed_at_invalid");
    const path = new URL(c.req.url).pathname;
    if (isExemptPath(path, c.req.method)) {
      return next();
    }

    const mode = effectiveAuthMode();
    const needAuth =
      mode === "required" ||
      (mode === "auto" && (countActiveApiKeys(db) > 0 || oidc !== null));

    if (!needAuth) {
      return next();
    }

    const header = c.req.header("authorization") ?? c.req.header("Authorization");
    const raw =
      header?.startsWith("Bearer ")
        ? header.slice("Bearer ".length).trim()
        : c.req.header("x-api-key")?.trim();

    if (!raw) {
      return c.json({ error: "unauthorized", message: "API key required (Bearer or X-API-Key)" }, 401);
    }

    let key = findApiKeyByToken(db, raw);
    if (key?.id.startsWith("key_ss_") &&
        (key.authority_principal_id === null || key.authority_role === null)) {
      try {
        key = migrateLegacySelfServeOwnerKeyAuthority(db, key.id);
      } catch {
        return c.json({ error: "unauthorized", message: "api_key_authority_invalid" }, 401);
      }
    }
    if (!key) {
      if (raw.split(".").length !== 3) {
        return c.json({ error: "unauthorized", message: "invalid API key" }, 401);
      }
      if (!oidc) {
        return c.json({ error: "unauthorized", message: "oidc_not_configured" }, 401);
      }
      try {
        const identity = await oidc.verify(raw);
        const membership = getTenantMembership(
          db,
          identity.tenantId,
          identity.issuer,
          identity.subject,
        );
        if (!membership || membership.status !== "active") {
          return c.json({ error: "unauthorized", message: "oidc_membership_required" }, 401);
        }
        const trustSubject = `${identity.issuer}|${identity.subject}`;
        const trustPrincipal = getPrincipalBySubject(
          db,
          identity.tenantId,
          "human",
          trustSubject,
        ) ?? insertPrincipal(db, {
          id: `principal-human-${createHash("sha256")
            .update(`${identity.tenantId}\n${trustSubject}`)
            .digest("hex")
            .slice(0, 32)}`,
          tenantId: identity.tenantId,
          kind: "human",
          subject: trustSubject,
          displayName: membership.display_name,
          audience: identity.issuer,
          createdAt: observedAt.toISOString(),
        });
        if (!activeTrustPrincipal(trustPrincipal, observedAtMs)) {
          return c.json({ error: "unauthorized", message: "trust_principal_inactive" }, 401);
        }
        if (!identity.session && (process.env.NODE_ENV ?? "").toLowerCase() === "production") {
          return c.json({ error: "unauthorized", message: "oidc_session_authority_required" }, 401);
        }
        if (identity.session) {
          const session = claimIdentitySession(db, {
            tenantId: identity.tenantId,
            principalId: trustPrincipal.id,
            issuer: identity.issuer,
            subject: identity.subject,
            membershipUpdatedAt: membership.updated_at,
            authStrength: identity.session.authStrength,
            token: raw,
            issuedAt: identity.session.issuedAt,
            expiresAt: identity.session.expiresAt,
            observedAt: observedAt.toISOString(),
          });
          c.set("identitySessionId", session.id);
        }
        c.set("tenantId", identity.tenantId);
        c.set("principal", {
          id: `human:${trustSubject}`,
          tenantId: identity.tenantId,
          role: membership.role,
          ...(membership.email ? { email: membership.email } : {}),
        });
        // OIDC humans are authorized by their tenant membership role. API key
        // scope attenuation applies only when an API key authenticated the request.
        c.set("authScopes", ["*"]);
        c.set("trustPrincipalId", trustPrincipal.id);
        c.set("authorityPrincipalId", trustPrincipal.id);
        c.set("authorityRole", membership.role);
        c.set("authMethod", "oidc");
        c.set("membershipEvidenceId", `membership:${createHash("sha256")
          .update(`${identity.tenantId}\n${identity.issuer}\n${identity.subject}`, "utf8")
          .digest("hex")}`);
        return next();
      } catch (error) {
        return c.json({
          error: "unauthorized",
          message: error instanceof Error && (
            error.message === "oidc_mfa_required" ||
            error.message.startsWith("identity_session_")
          ) ? error.message : "oidc_token_invalid",
        }, 401);
      }
    }

    const touchedAt = observedAtMs;
    const previousTouch = apiKeyTouchedAt.get(key.id) ?? 0;
    if (touchedAt - previousTouch >= 60_000) {
      touchApiKey(db, key.id, new Date(touchedAt).toISOString());
      apiKeyTouchedAt.set(key.id, touchedAt);
      if (apiKeyTouchedAt.size > 10_000) apiKeyTouchedAt.clear();
    }
    const scopes = parseApiKeyScopes(key.scopes_json);
    let delegatedActor: string | null;
    try {
      delegatedActor = verifyDelegatedActor(raw, {
        actor: c.req.header("x-mendpoint-actor"),
        timestamp: c.req.header("x-mendpoint-actor-timestamp"),
        signature: c.req.header("x-mendpoint-actor-signature"),
        requestId: c.get("requestId") ?? c.req.header("x-request-id") ?? "",
        method: c.req.method,
        path,
      });
    } catch (error) {
      if (!(error instanceof Error) || !DELEGATED_ACTOR_PUBLIC_ERRORS.has(error.message)) {
        throw error;
      }
      return c.json(
        {
          error: "unauthorized",
          message: error.message,
        },
        401,
      );
    }
    if (delegatedActor) {
      try {
        const claimed = claimDelegatedRequestNonce(db, {
          apiKeyId: key.id,
          requestId: c.get("requestId") ?? c.req.header("x-request-id") ?? "",
          signatureSha256: createHmac("sha256", raw)
            .update(c.req.header("x-mendpoint-actor-signature") ?? "")
            .digest("hex"),
          createdAt: observedAt.toISOString(),
        });
        if (!claimed) {
          return c.json(
            { error: "unauthorized", message: "delegated_actor_replay_detected" },
            401,
          );
        }
      } catch {
        return c.json(
          { error: "unauthorized", message: "delegated_actor_request_invalid" },
          401,
        );
      }
    }
    let principal: Principal;
    let trustPrincipal;
    let authorityPrincipal;
    if (delegatedActor) {
      trustPrincipal = getPrincipal(db, key.tenant_id, delegatedActor);
      const issuer = trustPrincipal?.audience;
      const subjectPrefix = issuer ? `${issuer}|` : "";
      const subject = trustPrincipal?.subject.startsWith(subjectPrefix)
        ? trustPrincipal.subject.slice(subjectPrefix.length)
        : "";
      const membership = issuer && subject
        ? getTenantMembership(db, key.tenant_id, issuer, subject)
        : null;
      if (
        !trustPrincipal ||
        trustPrincipal.kind !== "human" ||
        !activeTrustPrincipal(trustPrincipal, observedAtMs) ||
        !issuer ||
        !subject ||
        !membership ||
        membership.status !== "active"
      ) {
        return c.json(
          { error: "unauthorized", message: "delegated_actor_membership_required" },
          401,
        );
      }
      if (
        key.authority_principal_id !== trustPrincipal.id ||
        key.authority_role === null ||
        !API_KEY_ROLES.has(key.authority_role)
      ) {
        return c.json(
          { error: "unauthorized", message: "delegated_actor_authority_unbound" },
          401,
        );
      }
      const effectiveRole = effectiveHumanAuthorityRole(key.authority_role, membership.role);
      if (!effectiveRole) {
        return c.json(
          { error: "unauthorized", message: "api_key_authority_amplification" },
          401,
        );
      }
      principal = {
        id: `human:${trustPrincipal.subject}`,
        tenantId: key.tenant_id,
        role: effectiveRole,
        ...(membership.email ? { email: membership.email } : {}),
      };
      authorityPrincipal = trustPrincipal;
    } else if (key.principal_id) {
      trustPrincipal = getPrincipal(db, key.tenant_id, key.principal_id);
      if (!trustPrincipal || trustPrincipal.kind !== "service") {
        return c.json({ error: "unauthorized", message: "service_principal_binding_invalid" }, 401);
      }
      principal = {
        id: `service:${trustPrincipal.subject}`,
        tenantId: key.tenant_id,
        role: "agent",
      };
      authorityPrincipal = key.authority_principal_id
        ? getPrincipal(db, key.tenant_id, key.authority_principal_id)
        : trustPrincipal;
    } else {
      principal = {
        id: `api-key:${key.id}`,
        tenantId: key.tenant_id,
        role: roleFromApiKeyScopes(scopes),
      };
      trustPrincipal =
        getPrincipalBySubject(db, key.tenant_id, "api_key", key.id) ??
        insertPrincipal(db, {
        id: `principal-${createHash("sha256")
          .update(`${key.tenant_id}\napi_key\n${key.id}`)
          .digest("hex")
          .slice(0, 32)}`,
        tenantId: key.tenant_id,
        kind: "api_key",
        subject: key.id,
        displayName: key.name,
        audience: "mendpoint-api",
        createdAt: observedAt.toISOString(),
      });
      if (key.authority_principal_id) {
        authorityPrincipal = getPrincipal(db, key.tenant_id, key.authority_principal_id);
      } else {
        authorityPrincipal = insertPrincipal(db, {
          id: `principal-service-${createHash("sha256")
            .update(`${key.tenant_id}\napi-key-authority\n${key.id}`)
            .digest("hex")
            .slice(0, 32)}`,
          tenantId: key.tenant_id,
          kind: "service",
          subject: `api-key-authority:${key.id}`,
          displayName: `${key.name} authority`,
          audience: "mendpoint-api",
          createdAt: observedAt.toISOString(),
        });
        try {
          bindApiKeyAuthorityPrincipal(db, {
            apiKeyId: key.id,
            tenantId: key.tenant_id,
            authorityPrincipalId: authorityPrincipal.id,
            observedAt: observedAt.toISOString(),
          });
        } catch {
          return c.json({ error: "unauthorized", message: "api_key_authority_invalid" }, 401);
        }
      }
    }
    if (!activeTrustPrincipal(trustPrincipal, observedAtMs)) {
      return c.json({ error: "unauthorized", message: "trust_principal_inactive" }, 401);
    }
    if (
      !authorityPrincipal ||
      (authorityPrincipal.kind !== "human" && authorityPrincipal.kind !== "service") ||
      !activeTrustPrincipal(authorityPrincipal, observedAtMs)
    ) {
      return c.json({ error: "unauthorized", message: "api_key_authority_invalid" }, 401);
    }
    let currentAuthorityRole = key.authority_role;
    if (authorityPrincipal.kind === "human") {
      const membership = humanMembershipForAuthority(db, key.tenant_id, authorityPrincipal);
      if (!membership || membership.status !== "active") {
        return c.json({ error: "unauthorized", message: "api_key_authority_membership_inactive" }, 401);
      }
      if (currentAuthorityRole === null || !API_KEY_ROLES.has(currentAuthorityRole)) {
        return c.json({ error: "unauthorized", message: "api_key_authority_invalid" }, 401);
      }
      currentAuthorityRole = effectiveHumanAuthorityRole(currentAuthorityRole, membership.role);
      if (!currentAuthorityRole) {
        return c.json({ error: "unauthorized", message: "api_key_authority_amplification" }, 401);
      }
    }
    c.set("tenantId", key.tenant_id);
    c.set("apiKeyId", key.id);
    c.set("authScopes", scopes);
    c.set("principal", principal);
    c.set("trustPrincipalId", trustPrincipal.id);
    c.set("authorityPrincipalId", authorityPrincipal.id);
    if (key.authority_role !== null && !API_KEY_ROLES.has(key.authority_role)) {
      return c.json({ error: "unauthorized", message: "api_key_authority_invalid" }, 401);
    }
    const authorityRole = delegatedActor
      ? principal.role
      : currentAuthorityRole ?? undefined;
    if (
      authorityRole !== undefined &&
      !roleWithinStableAuthority(principal.role, authorityRole)
    ) {
      return c.json({ error: "unauthorized", message: "api_key_authority_amplification" }, 401);
    }
    if (authorityRole !== undefined) c.set("authorityRole", authorityRole);
    c.set("authMethod", "api_key");
    return next();
  };
}

export function createRbacMiddleware() {
  return async (c: Context<ApiEnv>, next: Next) => {
    const path = new URL(c.req.url).pathname;
    const method = c.req.method;
    if (method === "OPTIONS") return next();
    const need = permissionForRoute(method, path);
    if (!need) return next();
    const mode = effectiveAuthMode();
    const authenticated = c.get("principal");
    const principal = authenticated ?? (mode === "off"
      ? parsePrincipalFromHeaders({
          "x-tenant-id": c.req.header("x-tenant-id") ?? undefined,
          "x-role": c.req.header("x-role") ?? undefined,
          "x-user-id": c.req.header("x-user-id") ?? undefined,
        })
      : undefined);
    if (!principal) {
      return c.json({ error: "unauthorized", message: "authenticated principal required" }, 401);
    }
    const scopes = c.get("authScopes");
    const scopeAllowed = mode === "off" || scopeAllows(scopes, need);
    if (!can(principal, need) || !scopeAllowed) {
      return c.json({
        error: "rbac_denied",
        need,
        role: principal.role,
        message: `role ${principal.role} or API key scope lacks ${need}`,
      }, 403);
    }
    c.set("principal", principal);
    return next();
  };
}
