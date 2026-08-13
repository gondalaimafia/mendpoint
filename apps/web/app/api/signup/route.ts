import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  SELF_SERVE_SESSION_MAX_AGE_SECONDS,
  WEB_SESSION_COOKIE,
  createSelfServeWebSession,
  isAllowedMutationOrigin,
  selfServeSignupEnabled,
} from "../../../lib/proxy-auth";

export const dynamic = "force-dynamic";

type SignupSuccess = {
  tenant: { id: string; slug: string; name: string; plan: string };
  owner: { issuer: string; subject: string; email: string | null; displayName: string; role: string };
  apiKey: { token: string; prefix: string };
};

export async function POST(request: NextRequest): Promise<Response> {
  if (!selfServeSignupEnabled()) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (!isAllowedMutationOrigin(request)) {
    return Response.json({ error: "cross_origin_request_rejected" }, { status: 403 });
  }
  const sessionSecret = process.env.MENDPOINT_WEB_ACCESS_TOKEN?.trim();
  if (!sessionSecret) {
    return Response.json({ error: "web_access_not_configured" }, { status: 503 });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > 8_192) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  const body = await request.json().catch(() => null) as {
    email?: string;
    workspaceName?: string;
  } | null;
  if (!body || typeof body.email !== "string") {
    return Response.json({ error: "signup_request_invalid" }, { status: 422 });
  }

  const apiBase = (
    process.env.MENDPOINT_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:3001"
  ).replace(/\/$/, "");

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: body.email,
        ...(typeof body.workspaceName === "string" ? { workspaceName: body.workspaceName } : {}),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    return Response.json({ error: "signup_upstream_unavailable" }, { status: 502 });
  }

  const payload = await upstream.json().catch(() => null) as SignupSuccess | { error?: string } | null;
  if (upstream.status !== 201 || !payload || !("apiKey" in payload) || !payload.apiKey?.token) {
    const error = payload && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : "signup_failed";
    return Response.json({ error }, { status: upstream.status === 201 ? 502 : upstream.status });
  }

  const success = payload as SignupSuccess;
  const session = await createSelfServeWebSession({
    apiKey: success.apiKey.token,
    tenantId: success.tenant.id,
    subject: success.owner.subject,
    sessionSecret,
  });
  // The plaintext API key is sealed into the httpOnly session cookie only; it is
  // never echoed back to the browser.
  const response = NextResponse.json({
    authenticated: true,
    tenant: success.tenant,
    owner: {
      subject: success.owner.subject,
      email: success.owner.email,
      displayName: success.owner.displayName,
      role: success.owner.role,
    },
  });
  response.cookies.set(WEB_SESSION_COOKIE, session, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SELF_SERVE_SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
