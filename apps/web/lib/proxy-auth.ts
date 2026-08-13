import type { NextRequest } from "next/server";

export const WEB_SESSION_COOKIE = "mendpoint_web_session";
export const WEB_SESSION_VERSION = 3 as const;
export const WEB_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
export const OIDC_SESSION_MAX_AGE_SECONDS = 60 * 60;
export const SELF_SERVE_SESSION_MAX_AGE_SECONDS = WEB_SESSION_MAX_AGE_SECONDS;

export type WebSessionSubject = Readonly<
  | {
      kind: "preview_access";
      issuedAt: string;
      expiresAt: string;
    }
  | {
      kind: "human_oidc";
      issuedAt: string;
      expiresAt: string;
    }
  | {
      kind: "self_serve";
      tenantId: string;
      subject: string;
      issuedAt: string;
      expiresAt: string;
    }
>;

export type AuthenticatedWebCredential = Readonly<{
  subject: WebSessionSubject;
  upstreamAccessToken: string | null;
}>;

type WebSessionPayloadV3 = {
  v: 3;
  kind: "preview_access";
  iat: number;
  exp: number;
};

const SESSION_PREFIX = "mendpoint-web-session-v3\n";
const OIDC_SESSION_PREFIX = "mendpoint-web-oidc-session-v1\n";
const SELF_SERVE_SESSION_PREFIX = "mendpoint-web-self-serve-session-v1\n";

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

async function aesKey(secret: string, usage: KeyUsage[], domain: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${domain}${secret}`),
  );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, usage);
}

export async function createOidcWebSession(input: {
  accessToken: string;
  sessionSecret: string;
  expiresInSeconds?: number;
  now?: Date;
}): Promise<string> {
  if (!input.accessToken) throw new Error("oidc_access_token_required");
  if (!input.sessionSecret) throw new Error("web_access_not_configured");
  const issuedAt = (input.now ?? new Date()).getTime();
  const requestedLifetime = Math.floor(input.expiresInSeconds ?? OIDC_SESSION_MAX_AGE_SECONDS);
  const lifetime = Math.max(1, Math.min(requestedLifetime, OIDC_SESSION_MAX_AGE_SECONDS));
  const payload = JSON.stringify({
    v: 1,
    kind: "human_oidc",
    iat: issuedAt,
    exp: issuedAt + lifetime * 1000,
    accessToken: input.accessToken,
  });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(OIDC_SESSION_PREFIX) },
    await aesKey(input.sessionSecret, ["encrypt"], OIDC_SESSION_PREFIX),
    new TextEncoder().encode(payload),
  );
  return `oidc1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

async function readOidcWebSession(input: {
  value: string;
  sessionSecret: string;
  now?: Date;
}): Promise<AuthenticatedWebCredential | null> {
  const parts = input.value.split(".");
  if (parts.length !== 3 || parts[0] !== "oidc1") return null;
  const iv = base64UrlToBytes(parts[1]!);
  const encrypted = base64UrlToBytes(parts[2]!);
  if (!iv || iv.length !== 12 || !encrypted) return null;
  let payload: {
    v?: number;
    kind?: string;
    iat?: number;
    exp?: number;
    accessToken?: string;
  };
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(iv), additionalData: new TextEncoder().encode(OIDC_SESSION_PREFIX) },
      await aesKey(input.sessionSecret, ["decrypt"], OIDC_SESSION_PREFIX),
      new Uint8Array(encrypted),
    );
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decrypted));
  } catch {
    return null;
  }
  if (
    payload.v !== 1 ||
    payload.kind !== "human_oidc" ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    typeof payload.accessToken !== "string" ||
    payload.accessToken.length < 20 ||
    payload.exp! <= payload.iat! ||
    payload.exp! - payload.iat! > OIDC_SESSION_MAX_AGE_SECONDS * 1000
  ) return null;
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(now) || now < payload.iat! || now >= payload.exp!) return null;
  return Object.freeze({
    subject: Object.freeze({
      kind: "human_oidc" as const,
      issuedAt: new Date(payload.iat!).toISOString(),
      expiresAt: new Date(payload.exp!).toISOString(),
    }),
    upstreamAccessToken: payload.accessToken,
  });
}

export async function createSelfServeWebSession(input: {
  apiKey: string;
  tenantId: string;
  subject: string;
  sessionSecret: string;
  expiresInSeconds?: number;
  now?: Date;
}): Promise<string> {
  if (!input.apiKey) throw new Error("self_serve_api_key_required");
  if (!input.tenantId) throw new Error("self_serve_tenant_required");
  if (!input.subject) throw new Error("self_serve_subject_required");
  if (!input.sessionSecret) throw new Error("web_access_not_configured");
  const issuedAt = (input.now ?? new Date()).getTime();
  const requestedLifetime = Math.floor(input.expiresInSeconds ?? SELF_SERVE_SESSION_MAX_AGE_SECONDS);
  const lifetime = Math.max(1, Math.min(requestedLifetime, SELF_SERVE_SESSION_MAX_AGE_SECONDS));
  const payload = JSON.stringify({
    v: 1,
    kind: "self_serve",
    iat: issuedAt,
    exp: issuedAt + lifetime * 1000,
    accessToken: input.apiKey,
    tenantId: input.tenantId,
    subject: input.subject,
  });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(SELF_SERVE_SESSION_PREFIX) },
    await aesKey(input.sessionSecret, ["encrypt"], SELF_SERVE_SESSION_PREFIX),
    new TextEncoder().encode(payload),
  );
  return `self1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

async function readSelfServeWebSession(input: {
  value: string;
  sessionSecret: string;
  now?: Date;
}): Promise<AuthenticatedWebCredential | null> {
  const parts = input.value.split(".");
  if (parts.length !== 3 || parts[0] !== "self1") return null;
  const iv = base64UrlToBytes(parts[1]!);
  const encrypted = base64UrlToBytes(parts[2]!);
  if (!iv || iv.length !== 12 || !encrypted) return null;
  let payload: {
    v?: number;
    kind?: string;
    iat?: number;
    exp?: number;
    accessToken?: string;
    tenantId?: string;
    subject?: string;
  };
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(iv), additionalData: new TextEncoder().encode(SELF_SERVE_SESSION_PREFIX) },
      await aesKey(input.sessionSecret, ["decrypt"], SELF_SERVE_SESSION_PREFIX),
      new Uint8Array(encrypted),
    );
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decrypted));
  } catch {
    return null;
  }
  if (
    payload.v !== 1 ||
    payload.kind !== "self_serve" ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    typeof payload.accessToken !== "string" ||
    payload.accessToken.length < 20 ||
    typeof payload.tenantId !== "string" ||
    payload.tenantId.length === 0 ||
    payload.tenantId.length > 255 ||
    typeof payload.subject !== "string" ||
    payload.subject.length === 0 ||
    payload.subject.length > 320 ||
    payload.exp! <= payload.iat! ||
    payload.exp! - payload.iat! > SELF_SERVE_SESSION_MAX_AGE_SECONDS * 1000
  ) return null;
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(now) || now < payload.iat! || now >= payload.exp!) return null;
  return Object.freeze({
    subject: Object.freeze({
      kind: "self_serve" as const,
      tenantId: payload.tenantId,
      subject: payload.subject,
      issuedAt: new Date(payload.iat!).toISOString(),
      expiresAt: new Date(payload.exp!).toISOString(),
    }),
    upstreamAccessToken: payload.accessToken,
  });
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

export async function secureEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return constantTimeEqual(new Uint8Array(leftDigest), new Uint8Array(rightDigest));
}

export async function createWebSessionV3(input: {
  accessToken: string;
  now?: Date;
}): Promise<string> {
  if (!input.accessToken) throw new Error("web_access_not_configured");
  const issuedAt = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(issuedAt)) throw new Error("invalid_session_time");
  const payload: WebSessionPayloadV3 = {
    v: WEB_SESSION_VERSION,
    kind: "preview_access",
    iat: issuedAt,
    exp: issuedAt + WEB_SESSION_MAX_AGE_SECONDS * 1000,
  };
  const encodedPayload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await hmac(`${SESSION_PREFIX}${encodedPayload}`, input.accessToken);
  return `v3.${encodedPayload}.${bytesToBase64Url(signature)}`;
}

export async function readWebSessionV3(input: {
  value: string;
  accessToken: string;
  now?: Date;
}): Promise<WebSessionSubject | null> {
  const parts = input.value.split(".");
  if (parts.length !== 3 || parts[0] !== "v3") return null;
  const payloadBytes = base64UrlToBytes(parts[1]!);
  const suppliedSignature = base64UrlToBytes(parts[2]!);
  if (!payloadBytes || !suppliedSignature) return null;
  const expectedSignature = await hmac(`${SESSION_PREFIX}${parts[1]!}`, input.accessToken);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) return null;

  let payload: WebSessionPayloadV3;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes)) as WebSessionPayloadV3;
  } catch {
    return null;
  }
  if (
    !payload ||
    payload.v !== WEB_SESSION_VERSION ||
    payload.kind !== "preview_access" ||
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
    kind: payload.kind,
    issuedAt: new Date(payload.iat).toISOString(),
    expiresAt: new Date(payload.exp).toISOString(),
  });
}

/** Self-serve signup is off unless MENDPOINT_SELF_SERVE_SIGNUP=1 (default preview safe). */
export function selfServeSignupEnabled(): boolean {
  return process.env.MENDPOINT_SELF_SERVE_SIGNUP === "1";
}

/** Self-serve Warden scan trigger is off unless MENDPOINT_SELF_SERVE_WARDEN=1 (default preview safe). */
export function selfServeWardenEnabled(): boolean {
  return process.env.MENDPOINT_SELF_SERVE_WARDEN === "1";
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
  return (await authenticatedWebCredential(request, now))?.subject ?? null;
}

export async function authenticatedWebCredential(
  request: NextRequest,
  now = new Date(),
): Promise<AuthenticatedWebCredential | null> {
  const accessToken = process.env.MENDPOINT_WEB_ACCESS_TOKEN?.trim();
  if (!accessToken) return null;
  const cookie = request.cookies.get(WEB_SESSION_COOKIE)?.value;
  if (!cookie) return null;
  const oidc = await readOidcWebSession({ value: cookie, sessionSecret: accessToken, now });
  if (oidc) return oidc;
  const selfServe = await readSelfServeWebSession({ value: cookie, sessionSecret: accessToken, now });
  if (selfServe) return selfServe;
  const preview = await readWebSessionV3({ value: cookie, accessToken, now });
  return preview
    ? Object.freeze({ subject: preview, upstreamAccessToken: null })
    : null;
}

export async function authenticatedWebSession(request: NextRequest): Promise<boolean> {
  return Boolean(await authenticatedWebSubject(request));
}
