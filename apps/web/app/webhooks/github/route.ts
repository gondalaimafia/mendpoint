import type { NextRequest } from "next/server";
import {
  BodyLimitExceededError,
  InvalidContentLengthError,
  cancelBody,
  readBodyWithinLimit,
  readRequestBodyWithinLimit,
} from "../../../lib/bounded-body";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_UPSTREAM_RESPONSE_BYTES = 1024 * 1024;
const FORWARDED_HEADERS = [
  "content-type",
  "x-github-event",
  "x-github-delivery",
  "x-hub-signature-256",
] as const;

export async function POST(request: NextRequest): Promise<Response> {
  let body: Uint8Array<ArrayBuffer> | null;
  try {
    body = await readRequestBodyWithinLimit(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyLimitExceededError) {
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    }
    if (error instanceof InvalidContentLengthError) {
      return Response.json({ error: "invalid_content_length" }, { status: 400 });
    }
    throw error;
  }
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const apiBase = (process.env.MENDPOINT_API_URL ?? "http://127.0.0.1:3001").replace(
    /\/$/,
    "",
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const upstream = await fetch(`${apiBase}/webhooks/github`, {
      method: "POST",
      headers,
      body,
      cache: "no-store",
      signal: controller.signal,
    });
    const declaredResponse = Number(upstream.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredResponse) && declaredResponse > MAX_UPSTREAM_RESPONSE_BYTES) {
      cancelBody(upstream.body, () => controller.abort());
      return Response.json({ error: "webhook_upstream_unavailable" }, { status: 502 });
    }
    const responseBody = await readBodyWithinLimit(
      upstream.body,
      MAX_UPSTREAM_RESPONSE_BYTES,
      () => controller.abort(),
    );
    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof BodyLimitExceededError) {
      return Response.json({ error: "webhook_upstream_unavailable" }, { status: 502 });
    }
    return Response.json({ error: "webhook_upstream_unavailable" }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
