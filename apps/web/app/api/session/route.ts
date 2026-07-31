import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  WEB_SESSION_COOKIE,
  authenticatedWebSession,
  isAllowedMutationOrigin,
  secureEqual,
  webSessionValue,
} from "../../../lib/proxy-auth";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest): Response {
  return Response.json({ authenticated: authenticatedWebSession(request) });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAllowedMutationOrigin(request)) {
    return Response.json({ error: "cross_origin_request_rejected" }, { status: 403 });
  }
  const expected = process.env.MENDPOINT_WEB_ACCESS_TOKEN?.trim();
  if (!expected) {
    return Response.json({ error: "web_access_not_configured" }, { status: 503 });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > 8_192) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  const body = await request.json().catch(() => null) as { token?: string } | null;
  if (!body?.token || !secureEqual(body.token, expected)) {
    return Response.json({ error: "invalid_access_token" }, { status: 401 });
  }
  const response = NextResponse.json({ authenticated: true });
  response.cookies.set(WEB_SESSION_COOKIE, webSessionValue(expected), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  return response;
}

export function DELETE(request: NextRequest): Response {
  if (!isAllowedMutationOrigin(request)) {
    return Response.json({ error: "cross_origin_request_rejected" }, { status: 403 });
  }
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(WEB_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
