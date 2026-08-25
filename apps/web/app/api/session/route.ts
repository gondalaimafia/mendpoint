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
import {
  BodyLimitExceededError,
  InvalidContentLengthError,
  readRequestBodyWithinLimit,
} from "../../../lib/bounded-body";

export const dynamic = "force-dynamic";
const MAX_SESSION_BODY_BYTES = 8_192;

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
  let raw: Uint8Array<ArrayBuffer> | null;
  try {
    raw = await readRequestBodyWithinLimit(request, MAX_SESSION_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyLimitExceededError) {
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    }
    if (error instanceof InvalidContentLengthError) {
      return Response.json({ error: "invalid_content_length" }, { status: 400 });
    }
    throw error;
  }
  let body: { token?: string } | null = null;
  try {
    body = JSON.parse(Buffer.from(raw ?? []).toString("utf8"));
  } catch {
    body = null;
  }
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
