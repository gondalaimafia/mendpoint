import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024 * 1024;
const FORWARDED_HEADERS = [
  "content-type",
  "x-github-event",
  "x-github-delivery",
  "x-hub-signature-256",
] as const;

export async function POST(request: NextRequest): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
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
  try {
    const upstream = await fetch(`${apiBase}/webhooks/github`, {
      method: "POST",
      headers,
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json({ error: "webhook_upstream_unavailable" }, { status: 502 });
  }
}
