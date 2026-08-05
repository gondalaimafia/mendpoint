import type { NextRequest } from "next/server";
import { safeLocalReturn } from "./safe-return";

export const OIDC_FLOW_COOKIE = "mendpoint_oidc_flow";
export const OIDC_FLOW_MAX_AGE_SECONDS = 10 * 60;

type OidcDiscovery = {
  authorization_endpoint: string;
  token_endpoint: string;
};

type OidcFlow = {
  state: string;
  verifier: string;
  redirectUri: string;
  returnTo: string;
  issuedAt: number;
  expiresAt: number;
};

const FLOW_CONTEXT = "mendpoint-oidc-flow-v1\n";

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
      Math.ceil(value.length / 4) * 4,
      "=",
    ));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function flowKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${FLOW_CONTEXT}${secret}`),
  );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, usage);
}

export function safeReturnTo(value: string | null): string {
  return safeLocalReturn(value);
}

export function oidcRedirectUri(request: NextRequest): string {
  const configured = process.env.OIDC_REDIRECT_URI?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") throw new Error("oidc_redirect_uri_required");
  return new URL("/api/oidc/callback", request.url).toString();
}

export function oidcClientConfig(): { issuer: string; clientId: string; audience: string } {
  const issuer = process.env.OIDC_ISSUER?.trim().replace(/\/$/, "");
  const clientId = process.env.OIDC_CLIENT_ID?.trim();
  const audience = process.env.OIDC_AUDIENCE?.trim();
  if (!issuer || !clientId || !audience) throw new Error("oidc_browser_configuration_incomplete");
  if (new URL(issuer).protocol !== "https:") throw new Error("oidc_issuer_https_required");
  return { issuer, clientId, audience };
}

export async function discoverOidc(issuer: string): Promise<OidcDiscovery> {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("oidc_discovery_failed");
  const body = await response.json() as Partial<OidcDiscovery>;
  for (const endpoint of [body.authorization_endpoint, body.token_endpoint]) {
    if (!endpoint || new URL(endpoint).protocol !== "https:") {
      throw new Error("oidc_discovery_invalid");
    }
  }
  return body as OidcDiscovery;
}

export async function createOidcFlow(input: {
  secret: string;
  redirectUri: string;
  returnTo: string;
  now?: Date;
}): Promise<{ cookie: string; state: string; verifier: string; challenge: string }> {
  const now = (input.now ?? new Date()).getTime();
  const state = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const verifier = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = bytesToBase64Url(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  )));
  const flow: OidcFlow = {
    state,
    verifier,
    redirectUri: input.redirectUri,
    returnTo: safeReturnTo(input.returnTo),
    issuedAt: now,
    expiresAt: now + OIDC_FLOW_MAX_AGE_SECONDS * 1000,
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(FLOW_CONTEXT) },
    await flowKey(input.secret, ["encrypt"]),
    new TextEncoder().encode(JSON.stringify(flow)),
  );
  return {
    cookie: `flow1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`,
    state,
    verifier,
    challenge,
  };
}

export async function readOidcFlow(input: {
  cookie: string;
  secret: string;
  state: string;
  now?: Date;
}): Promise<OidcFlow | null> {
  const parts = input.cookie.split(".");
  if (parts.length !== 3 || parts[0] !== "flow1") return null;
  const iv = base64UrlToBytes(parts[1]!);
  const encrypted = base64UrlToBytes(parts[2]!);
  if (!iv || iv.length !== 12 || !encrypted) return null;
  let flow: OidcFlow;
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(iv), additionalData: new TextEncoder().encode(FLOW_CONTEXT) },
      await flowKey(input.secret, ["decrypt"]),
      new Uint8Array(encrypted),
    );
    flow = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decrypted)) as OidcFlow;
  } catch {
    return null;
  }
  const now = (input.now ?? new Date()).getTime();
  if (
    !flow ||
    typeof flow.state !== "string" ||
    flow.state !== input.state ||
    typeof flow.verifier !== "string" ||
    flow.verifier.length < 43 ||
    typeof flow.redirectUri !== "string" ||
    typeof flow.returnTo !== "string" ||
    !Number.isSafeInteger(flow.issuedAt) ||
    !Number.isSafeInteger(flow.expiresAt) ||
    flow.expiresAt <= flow.issuedAt ||
    flow.expiresAt - flow.issuedAt !== OIDC_FLOW_MAX_AGE_SECONDS * 1000 ||
    now < flow.issuedAt ||
    now >= flow.expiresAt
  ) return null;
  return flow;
}
