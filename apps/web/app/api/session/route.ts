import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  WEB_SESSION_COOKIE,
  WEB_SESSION_MAX_AGE_SECONDS,
  authenticatedWebSubject,
  createWebSessionV3,
  isAllowedMutationOrigin,
  secureEqual,
} from "../../../lib/proxy-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const subject = await authenticatedWebSubject(request);
  return Response.json({ authenticated: Boolean(subject), subject });
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
  const body = await request.json().catch(() => null) as {
    token?: string;
  } | null;
  if (!body?.token || !(await secureEqual(body.token, expected))) {
    return Response.json({ error: "invalid_access_token" }, { status: 401 });
  }
  const response = NextResponse.json({ authenticated: true });
  response.cookies.set(
    WEB_SESSION_COOKIE,
    await createWebSessionV3({ accessToken: expected }),
    {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: WEB_SESSION_MAX_AGE_SECONDS,
    },
  );
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
