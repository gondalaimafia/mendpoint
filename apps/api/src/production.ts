/**
 * Production middleware: security headers, rate limit, request id.
 */
import type { Context, Next } from "hono";
import {
  rateLimit,
  rateLimitKeyFromRequest,
  tenantQuota,
  isProduction,
  resolveMutationFenceRoot,
  tryAcquireMutationLease,
  initializeWithMutationLease,
} from "@mendpoint/ops";
import type { ApiEnv } from "./auth.js";

export function initializeApiDurableState<T>(
  initialize: () => T,
  env: Readonly<Record<string, string | undefined>> = process.env,
): T {
  return initializeWithMutationLease(initialize, env);
}

export function requestIdMiddleware() {
  return async (c: Context<ApiEnv>, next: Next) => {
    const id =
      c.req.header("x-request-id") ??
      `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    c.set("requestId", id);
    c.header("X-Request-Id", id);
    await next();
  };
}

export function securityHeadersMiddleware() {
  return async (c: Context<ApiEnv>, next: Next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-XSS-Protection", "0");
    if (isProduction()) {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  };
}

function isTrustedProxy(c: Context<ApiEnv>): boolean {
  const proxySecret = process.env.TRUST_PROXY_SECRET;
  return (
    process.env.TRUST_PROXY === "1" &&
    Boolean(proxySecret) &&
    c.req.header("x-mendpoint-proxy-secret") === proxySecret
  );
}

function trustedClientIp(c: Context<ApiEnv>): string {
  if (!isTrustedProxy(c)) return "direct";
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "proxy-unknown"
  );
}

function trustedWebSession(c: Context<ApiEnv>): string | undefined {
  if (!isTrustedProxy(c)) return undefined;
  const session = c.req.header("x-mendpoint-web-session")?.trim();
  return session && /^[a-f0-9]{64}$/.test(session) ? session : undefined;
}

export function rateLimitMiddleware(
  opts: { identity?: "network" | "principal" } = {},
) {
  return async (c: Context<ApiEnv>, next: Next) => {
    const path = new URL(c.req.url).pathname;
    if (
      path === "/health" ||
      path === "/ready" ||
      path === "/live" ||
      path === "/version"
    ) {
      return next();
    }
    const identity = opts.identity ?? "network";
    const apiKeyId = c.get("apiKeyId");
    const principalId = c.get("principal")?.id;
    const principalIdentity =
      trustedWebSession(c) ?? principalId ?? apiKeyId;
    if (identity === "principal" && !principalIdentity) {
      return next();
    }
    // Preauthentication buckets never depend on unverified credentials.
    const key =
      identity === "principal"
        ? `principal:${principalIdentity}`
        : `preauth:${rateLimitKeyFromRequest({ ip: trustedClientIp(c) })}`;
    const r = rateLimit(key);
    c.header("X-RateLimit-Limit", String(r.limit));
    c.header("X-RateLimit-Remaining", String(r.remaining));
    c.header("X-RateLimit-Reset", String(Math.ceil(r.resetMs / 1000)));
    if (!r.allowed) {
      return c.json(
        {
          error: "rate_limited",
          message: "Too many requests — retry after reset",
          retryAfterSec: Math.ceil(r.resetMs / 1000),
        },
        429,
      );
    }
    return next();
  };
}

/**
 * Per-tenant quota, enforced after authentication so a real tenant is known.
 *
 * Runs alongside the per-IP / per-key rate limiter but budgets by tenant, so one tenant
 * cannot exhaust shared node capacity across many keys or IPs. Disabled and fully permissive
 * unless `TENANT_QUOTA_MAX` is configured (see tenant-quota.ts), so existing behavior is
 * unchanged by default. Exceeding the budget denies with 429 `tenant_quota_exceeded`; there
 * is no fail-open path.
 */
export function tenantQuotaMiddleware() {
  return async (c: Context<ApiEnv>, next: Next) => {
    const path = new URL(c.req.url).pathname;
    if (
      path === "/health" ||
      path === "/ready" ||
      path === "/live" ||
      path === "/version"
    ) {
      return next();
    }
    const tenantId = c.get("principal")?.tenantId;
    // No authenticated tenant (public/unauthenticated route or open auth mode) → nothing to
    // budget per tenant; the per-IP/per-key limiter still applies.
    if (!tenantId || tenantId.trim() === "") {
      return next();
    }
    const r = tenantQuota(tenantId);
    if (!r.enabled) {
      return next();
    }
    c.header("X-Tenant-Quota-Limit", String(r.limit));
    c.header("X-Tenant-Quota-Remaining", String(r.remaining));
    c.header("X-Tenant-Quota-Reset", String(Math.ceil(r.resetMs / 1000)));
    if (!r.allowed) {
      return c.json(
        {
          error: "tenant_quota_exceeded",
          message: "Tenant quota exhausted — retry after reset",
          retryAfterSec: Math.ceil(r.resetMs / 1000),
        },
        429,
      );
    }
    return next();
  };
}

export function mutationAdmissionMiddleware(
  options: { enabled?: boolean; fenceRoot?: string } = {},
) {
  const enabled = options.enabled ?? (
    process.env.MENDPOINT_DEPLOYMENT_PROFILE === "customer" ||
    Boolean(process.env.MENDPOINT_BACKUP_FENCE_ROOT?.trim())
  );
  const fenceRoot = options.fenceRoot ?? resolveMutationFenceRoot();
  return async (c: Context<ApiEnv>, next: Next) => {
    if (!enabled) return next();
    const path = new URL(c.req.url).pathname;
    if (
      c.req.method === "OPTIONS" ||
      path === "/health" ||
      path === "/live" ||
      path === "/ready" ||
      path === "/version"
    ) {
      return next();
    }
    const lease = tryAcquireMutationLease(fenceRoot);
    if (!lease) {
      c.header("Retry-After", "1");
      return c.json({ error: "backup_in_progress" }, 503);
    }
    try {
      return await next();
    } finally {
      lease.release();
    }
  };
}

export function corsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS;
  if (raw) {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const web = process.env.WEB_URL ?? "http://localhost:3000";
  return [web, "http://localhost:3000", "http://127.0.0.1:3000"];
}
