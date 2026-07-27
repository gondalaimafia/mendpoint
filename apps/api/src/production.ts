/**
 * Production middleware: security headers, rate limit, request id.
 */
import type { Context, Next } from "hono";
import {
  rateLimit,
  rateLimitKeyFromRequest,
  isProduction,
} from "@mendpoint/ops";

export function requestIdMiddleware() {
  return async (c: Context, next: Next) => {
    const id =
      c.req.header("x-request-id") ??
      `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    c.set("requestId", id);
    c.header("X-Request-Id", id);
    await next();
  };
}

export function securityHeadersMiddleware() {
  return async (c: Context, next: Next) => {
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

export function rateLimitMiddleware() {
  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname;
    if (
      path === "/health" ||
      path === "/ready" ||
      path === "/live" ||
      path === "/version"
    ) {
      return next();
    }
    const apiKeyId = c.get("apiKeyId") as string | undefined;
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      "local";
    const key = rateLimitKeyFromRequest({ apiKeyId, ip });
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

export function corsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS;
  if (raw) {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const web = process.env.WEB_URL ?? "http://localhost:3000";
  return [web, "http://localhost:3000", "http://127.0.0.1:3000"];
}
