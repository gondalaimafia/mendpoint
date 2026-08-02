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
  countActiveApiKeys,
  claimDelegatedRequestNonce,
  findApiKeyByToken,
  getPrincipalBySubject,
  insertPrincipal,
  touchApiKey,
  type AppDb,
} from "@mendpoint/db";
import { nowIso } from "@mendpoint/shared";
import {
  isPublicRoute,
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
  webhookDeliveryId?: string;
};
export type ApiEnv = { Variables: ApiVariables };

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
  return scopes.includes("*") || scopes.includes(permission);
}

const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const SIGNATURE = /^[a-f0-9]{64}$/;
const DELEGATION_MAX_SKEW_MS = 5 * 60 * 1000;

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

export function createAuthMiddleware(db: AppDb) {
  return async (c: Context<ApiEnv>, next: Next) => {
    const path = new URL(c.req.url).pathname;
    if (isExemptPath(path, c.req.method)) {
      return next();
    }

    const mode = effectiveAuthMode();
    const active = countActiveApiKeys(db);
    const needAuth =
      mode === "required" || (mode === "auto" && active > 0);

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

    const key = findApiKeyByToken(db, raw);
    if (!key) {
      return c.json({ error: "unauthorized", message: "invalid API key" }, 401);
    }

    touchApiKey(db, key.id, nowIso());
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
      return c.json(
        {
          error: "unauthorized",
          message: error instanceof Error ? error.message : "delegated_actor_invalid",
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
          createdAt: nowIso(),
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
    const principal: Principal = {
      id: delegatedActor ? `human:${delegatedActor}` : `api-key:${key.id}`,
      tenantId: key.tenant_id,
      role: roleFromApiKeyScopes(scopes),
    };
    const trustKind = delegatedActor ? "human" : "api_key";
    const trustSubject = delegatedActor ?? key.id;
    const trustPrincipal =
      getPrincipalBySubject(db, key.tenant_id, trustKind, trustSubject) ??
      insertPrincipal(db, {
        id: `principal-${createHash("sha256")
          .update(`${key.tenant_id}\n${trustKind}\n${trustSubject}`)
          .digest("hex")
          .slice(0, 32)}`,
        tenantId: key.tenant_id,
        kind: trustKind,
        subject: trustSubject,
        displayName: delegatedActor ?? key.name,
        audience: delegatedActor ? "operator-session" : "mendpoint-api",
        createdAt: nowIso(),
      });
    c.set("tenantId", key.tenant_id);
    c.set("apiKeyId", key.id);
    c.set("authScopes", scopes);
    c.set("principal", principal);
    c.set("trustPrincipalId", trustPrincipal.id);
    return next();
  };
}
