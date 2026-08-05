import type { NextRequest } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import {
  authenticatedWebCredential,
  isAllowedMutationOrigin,
} from "../../../lib/proxy-auth";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

const RESPONSE_HEADERS = [
  "cache-control",
  "content-type",
  "content-disposition",
  "location",
  "pragma",
  "retry-after",
  "server-timing",
  "x-request-id",
  "x-response-time",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
] as const;

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 12_000;

function matchesAllowedRoute(method: string, path: string): boolean {
  const rules: Array<[string, RegExp]> = [
    ["GET", /^status$/],
    ["GET", /^jobs$/],
    ["GET", /^jobs\/[^/]+$/],
    ["GET", /^recovery\/summary$/],
    ["GET", /^billing\/usage$/],
    ["GET", /^billing\/config$/],
    ["GET", /^audit\/export$/],
    ["GET", /^github\/app\/install-url$/],
    ["GET", /^design-partner-applications$/],
    ["GET", /^design-partner-applications\/[^/]+$/],
    ["GET", /^pilot-success-contracts$/],
    ["GET", /^pilot-success-contracts\/[^/]+$/],
    ["GET", /^graph\//],
    ["GET", /^prs\/[^/]+\/reviews$/],
    ["GET", /^transformer\/gate$/],
    ["GET", /^transformer\/control-plane\/campaigns\/[^/]+$/],
    ["GET", /^transformer\/control-plane\/campaigns\/[^/]+\/events$/],
    ["POST", /^tenants\/[^/]+\/plan$/],
    ["POST", /^brands\/[^/]+\/preview$/],
    ["POST", /^agent\/runs$/],
    ["POST", /^consumers$/],
    ["POST", /^consumers\/[^/]+\/detect$/],
    ["POST", /^feeds\/poll$/],
    ["POST", /^repair\/sessions$/],
    ["POST", /^jobs\/[^/]+\/retry$/],
    ["POST", /^jobs\/[^/]+\/cancel$/],
    ["POST", /^prs\/[^/]+\/feedback$/],
    ["POST", /^prs\/[^/]+\/reviews$/],
    ["POST", /^providers\/[^/]+\/publish-version$/],
    ["POST", /^github\/app\/callback$/],
    ["POST", /^changes\/[^/]+\/severity$/],
    ["POST", /^design-partner-applications\/[^/]+\/reveals$/],
    ["POST", /^design-partner-applications\/[^/]+\/erasures$/],
    ["POST", /^design-partner-applications\/retention-purges$/],
    ["POST", /^pilot-success-contracts$/],
    ["POST", /^pilot-success-contracts\/[^/]+\/revisions$/],
    ["POST", /^pilot-success-contracts\/[^/]+\/versions\/\d+\/approvals$/],
    ["POST", /^transformer\/control-plane\/campaigns$/],
    ["POST", /^transformer\/control-plane\/campaigns\/[^/]+\/(?:review|transitions|exceptions)$/],
    ["PATCH", /^platform\/plans\/[^/]+$/],
  ];
  return rules.some(([allowedMethod, pattern]) =>
    allowedMethod === method && pattern.test(path),
  );
}

async function proxy(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const decodedPath = path.join("/");
  if (!matchesAllowedRoute(request.method, decodedPath)) {
    return Response.json({ error: "proxy_route_not_allowed" }, { status: 404 });
  }
  const credential = await authenticatedWebCredential(request);
  if (!credential) {
    return Response.json({ error: "web_session_required" }, { status: 401 });
  }
  const mutation = request.method !== "GET" && request.method !== "HEAD";
  if (mutation && !isAllowedMutationOrigin(request)) {
    return Response.json({ error: "cross_origin_request_rejected" }, { status: 403 });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  const apiBase = (
    process.env.MENDPOINT_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:3001"
  ).replace(/\/$/, "");
  const encodedPath = path.map((segment) => encodeURIComponent(segment)).join("/");
  const upstreamUrl = new URL(`${apiBase}/${encodedPath}`);
  upstreamUrl.search = request.nextUrl.search;

  const headers = new Headers();
  for (const name of [
    "accept",
    "content-type",
    "if-match",
    "if-none-match",
    "idempotency-key",
    "x-mendpoint-evidence-refs",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const incomingRequestId = request.headers.get("x-request-id");
  const requestId =
    incomingRequestId &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(incomingRequestId)
      ? incomingRequestId
      : randomUUID();
  headers.set("X-Request-Id", requestId);
  const apiKey = process.env.MENDPOINT_API_KEY?.trim();
  if (!credential.upstreamAccessToken && !apiKey) {
    return Response.json({ error: "proxy_api_key_not_configured" }, { status: 503 });
  }
  headers.set("Authorization", `Bearer ${credential.upstreamAccessToken ?? apiKey}`);
  const proxySecret = process.env.TRUST_PROXY_SECRET?.trim();
  if (proxySecret) {
    const sessionCookie = request.cookies.get("mendpoint_web_session")?.value;
    if (sessionCookie) {
      headers.set(
        "X-Mendpoint-Web-Session",
        createHash("sha256").update(sessionCookie).digest("hex"),
      );
    }
    const clientIp =
      request.headers.get("fly-client-ip") ??
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip");
    if (clientIp && /^[A-Fa-f0-9:.]{2,64}$/.test(clientIp)) {
      headers.set("X-Forwarded-For", clientIp);
    }
    headers.set("X-Mendpoint-Proxy-Secret", proxySecret);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const requestBody = hasBody ? await request.arrayBuffer() : undefined;
  if (requestBody && requestBody.byteLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  let body: ArrayBuffer | null;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: requestBody,
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    const declaredResponseLength = Number(upstream.headers.get("content-length") ?? 0);
    if (declaredResponseLength > MAX_RESPONSE_BYTES) {
      return Response.json({ error: "upstream_response_too_large" }, { status: 502 });
    }
    const noBody =
      upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
    body = noBody ? null : await upstream.arrayBuffer();
    if (body && body.byteLength > MAX_RESPONSE_BYTES) {
      return Response.json({ error: "upstream_response_too_large" }, { status: 502 });
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return Response.json({ error: "upstream_timeout" }, { status: 504 });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const responseHeaders = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
