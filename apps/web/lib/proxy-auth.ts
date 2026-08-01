import type { NextRequest } from "next/server";

export const WEB_SESSION_COOKIE = "mendpoint_web_session";
export const WEB_SESSION_VERSION = 2 as const;
export const WEB_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export type WebSessionSubject = Readonly<{
  operatorId: string;
  issuedAt: string;
  expiresAt: string;
}>;

type WebSessionPayloadV2 = {
  v: 2;
  operatorId: string;
  iat: number;
  exp: number;
};

const OPERATOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/;
const SESSION_PREFIX = "mendpoint-web-session-v2\n";

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index % left.length] ?? 0) ^ (right[index % right.length] ?? 0);
  }
  return difference === 0;
}

export function validOperatorId(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && OPERATOR_ID.test(value);
}

export async function secureEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return constantTimeEqual(new Uint8Array(leftDigest), new Uint8Array(rightDigest));
}

export async function createWebSessionV2(input: {
  operatorId: string;
  accessToken: string;
  now?: Date;
}): Promise<string> {
  if (!validOperatorId(input.operatorId)) throw new Error("invalid_operator_id");
  if (!input.accessToken) throw new Error("web_access_not_configured");
  const issuedAt = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(issuedAt)) throw new Error("invalid_session_time");
  const payload: WebSessionPayloadV2 = {
    v: WEB_SESSION_VERSION,
    operatorId: input.operatorId,
    iat: issuedAt,
    exp: issuedAt + WEB_SESSION_MAX_AGE_SECONDS * 1000,
  };
  const encodedPayload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await hmac(`${SESSION_PREFIX}${encodedPayload}`, input.accessToken);
  return `v2.${encodedPayload}.${bytesToBase64Url(signature)}`;
}

export async function readWebSessionV2(input: {
  value: string;
  accessToken: string;
  now?: Date;
}): Promise<WebSessionSubject | null> {
  const parts = input.value.split(".");
  if (parts.length !== 3 || parts[0] !== "v2") return null;
  const payloadBytes = base64UrlToBytes(parts[1]!);
  const suppliedSignature = base64UrlToBytes(parts[2]!);
  if (!payloadBytes || !suppliedSignature) return null;
  const expectedSignature = await hmac(`${SESSION_PREFIX}${parts[1]!}`, input.accessToken);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) return null;

  let payload: WebSessionPayloadV2;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes)) as WebSessionPayloadV2;
  } catch {
    return null;
  }
  if (
    !payload ||
    payload.v !== WEB_SESSION_VERSION ||
    !validOperatorId(payload.operatorId) ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat !== WEB_SESSION_MAX_AGE_SECONDS * 1000
  ) {
    return null;
  }
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(now) || now < payload.iat || now >= payload.exp) return null;
  return Object.freeze({
    operatorId: payload.operatorId,
    issuedAt: new Date(payload.iat).toISOString(),
    expiresAt: new Date(payload.exp).toISOString(),
  });
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

export async function authenticatedWebSubject(
  request: NextRequest,
  now = new Date(),
): Promise<WebSessionSubject | null> {
  const accessToken = process.env.MENDPOINT_WEB_ACCESS_TOKEN?.trim();
  if (!accessToken) return null;
  const cookie = request.cookies.get(WEB_SESSION_COOKIE)?.value;
  if (!cookie) return null;
  return readWebSessionV2({ value: cookie, accessToken, now });
}

export async function authenticatedWebSession(request: NextRequest): Promise<boolean> {
  return Boolean(await authenticatedWebSubject(request));
}
