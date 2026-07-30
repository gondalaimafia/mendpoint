import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export const WEB_SESSION_COOKIE = "mendpoint_web_session";

export function secureEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

export function webSessionValue(accessToken: string): string {
  return createHash("sha256")
    .update(`mendpoint-web-session-v1:${accessToken}`)
    .digest("base64url");
}

export function allowedWebOrigins(): Set<string> {
  const raw =
    process.env.MENDPOINT_WEB_ALLOWED_ORIGINS ??
    process.env.WEB_URL ??
    (process.env.NODE_ENV === "production"
      ? ""
      : "http://localhost:3000,http://127.0.0.1:3000");
  return new Set(raw.split(",").map((value) => value.trim()).filter(Boolean));
}

export function isAllowedMutationOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return Boolean(
    origin &&
    allowedWebOrigins().has(origin) &&
    (!fetchSite || fetchSite === "same-origin"),
  );
}

export function authenticatedWebSession(request: NextRequest): boolean {
  const expected = process.env.MENDPOINT_WEB_ACCESS_TOKEN?.trim();
  if (!expected) return process.env.NODE_ENV !== "production";
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : undefined;
  const cookie = request.cookies.get(WEB_SESSION_COOKIE)?.value;
  return Boolean(
    (bearer && secureEqual(bearer, expected)) ||
    (cookie && secureEqual(cookie, webSessionValue(expected))),
  );
}
