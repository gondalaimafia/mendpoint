import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { isAllowedMutationOrigin } from "../../../lib/proxy-auth";
import {
  BodyLimitExceededError,
  InvalidContentLengthError,
  cancelBody,
  readBodyWithinLimit,
  readRequestBodyWithinLimit,
} from "../../../lib/bounded-body";

export const dynamic = "force-dynamic";

const MAX_APPLICATION_BYTES = 16 * 1_024;
const MAX_UPSTREAM_RESPONSE_BYTES = 16 * 1_024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function boundedHeader(request: NextRequest, name: string, max: number): string | null {
  const value = request.headers.get(name)?.trim();
  if (!value || value.length > max || /[\r\n\0]/.test(value)) return null;
  return value;
}
function safeReferrerPath(request: NextRequest): string | null {
  const value = boundedHeader(request, "referer", 1_024);
  if (!value) return null;
  try {
    const referrer = new URL(value);
    const origin = request.headers.get("origin");
    if (!origin || referrer.origin !== origin) return null;
    const path = `${referrer.pathname}${referrer.search}`;
    return path.length <= 512 ? path : null;
  } catch {
    return null;
  }
}

function publicError(status: number): { status: number; error: string } {
  if (status === 429) return { status, error: "rate_limited" };
  if (status === 413) return { status, error: "payload_too_large" };
  if (status === 409) return { status, error: "application_already_submitted" };
  if (status >= 400 && status < 500) return { status, error: "invalid_application" };
  return { status: 502, error: "application_service_unavailable" };
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAllowedMutationOrigin(request)) {
    return Response.json({ error: "cross_origin_request_rejected" }, { status: 403 });
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return Response.json({ error: "invalid_content_type" }, { status: 415 });
  }
  let requestBody: Uint8Array<ArrayBuffer> | null;
  try {
    requestBody = await readRequestBodyWithinLimit(request, MAX_APPLICATION_BYTES);
  } catch (error) {
    if (error instanceof BodyLimitExceededError) {
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    }
    if (error instanceof InvalidContentLengthError) {
      return Response.json({ error: "invalid_content_length" }, { status: 400 });
    }
    throw error;
  }
  const apiKey = process.env.MENDPOINT_API_KEY?.trim();
  if (!apiKey) {
    return Response.json({ error: "application_service_not_configured" }, { status: 503 });
  }
  const apiBase = (
    process.env.MENDPOINT_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:3001"
  ).replace(/\/$/, "");
  const upstreamUrl = `${apiBase}/design-partner-applications`;
  const incomingRequestId = request.headers.get("x-request-id");
  const requestId = incomingRequestId && REQUEST_ID_PATTERN.test(incomingRequestId)
    ? incomingRequestId
    : randomUUID();
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "X-Request-Id": requestId,
    "X-Mendpoint-Application-Bridge": "public-design-partner-v1",
  });
  const origin = boundedHeader(request, "origin", 256);
  if (origin) headers.set("X-Mendpoint-Application-Origin", origin);
  const referrerPath = safeReferrerPath(request);
  if (referrerPath) headers.set("X-Mendpoint-Application-Referrer-Path", referrerPath);
  const userAgent = boundedHeader(request, "user-agent", 256);
  if (userAgent) headers.set("User-Agent", userAgent);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: requestBody,
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    const declaredResponseLength = Number(upstream.headers.get("content-length") ?? 0);
    if (declaredResponseLength > MAX_UPSTREAM_RESPONSE_BYTES) {
      cancelBody(upstream.body, () => controller.abort());
      return Response.json({ error: "application_service_unavailable" }, { status: 502 });
    }
    const responseBytes = await readBodyWithinLimit(
      upstream.body,
      MAX_UPSTREAM_RESPONSE_BYTES,
      () => controller.abort(),
    );
    if (!upstream.ok) {
      const safe = publicError(upstream.status);
      const response = Response.json({ error: safe.error }, { status: safe.status });
      const retryAfter = upstream.headers.get("retry-after");
      if (safe.status === 429 && retryAfter && /^\d{1,8}$/.test(retryAfter)) {
        response.headers.set("Retry-After", retryAfter);
      }
      return response;
    }
    try {
      const parsed = JSON.parse(Buffer.from(responseBytes ?? []).toString("utf8")) as {
        data?: { applicationId?: unknown };
      };
      const applicationId = parsed.data?.applicationId;
      if (typeof applicationId !== "string" || !REQUEST_ID_PATTERN.test(applicationId)) {
        throw new Error("invalid_application_reference");
      }
      return Response.json({ applicationId }, { status: 201 });
    } catch {
      return Response.json({ error: "application_service_unavailable" }, { status: 502 });
    }
  } catch (error) {
    const status = error instanceof Error && error.name === "AbortError" ? 504 : 502;
    return Response.json({ error: "application_service_unavailable" }, { status });
  } finally {
    clearTimeout(timeout);
  }
}
