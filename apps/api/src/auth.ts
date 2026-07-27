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
import {
  countActiveApiKeys,
  findApiKeyByToken,
  touchApiKey,
  type AppDb,
} from "@mendpoint/db";
import { nowIso } from "@mendpoint/shared";

export type AuthMode = "off" | "auto" | "required";

export function authMode(): AuthMode {
  const m = (process.env.API_AUTH ?? "off").toLowerCase();
  if (m === "required" || m === "on" || m === "true") return "required";
  if (m === "auto") return "auto";
  return "off";
}

export function isExemptPath(path: string): boolean {
  if (
    path === "/health" ||
    path === "/ready" ||
    path === "/live" ||
    path === "/version" ||
    path === "/status" ||
    path === "/"
  )
    return true;
  if (path.startsWith("/webhooks/")) return true;
  // GitHub App install wizard (public entry + mock callback)
  if (path.startsWith("/github/app/")) return true;
  if (path === "/billing/plans") return true;
  if (path === "/brands") return true;
  return false;
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

export function createAuthMiddleware(db: AppDb) {
  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname;
    if (isExemptPath(path)) {
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
    c.set("tenantId", key.tenant_id);
    c.set("apiKeyId", key.id);
    return next();
  };
}
