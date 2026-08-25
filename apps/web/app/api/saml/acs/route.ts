import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  WEB_SESSION_COOKIE,
  createOidcWebSession,
} from "../../../../lib/proxy-auth";
import {
  SAML_FLOW_COOKIE,
  mintBridgeToken,
  readSamlFlow,
  samlBridgeConfig,
  samlSpConfig,
  validateSamlResponse,
} from "../../../../lib/saml-auth";
import {
  BodyLimitExceededError,
  InvalidContentLengthError,
  readRequestBodyWithinLimit,
} from "../../../../lib/bounded-body";

export const dynamic = "force-dynamic";
const MAX_SAML_BODY_BYTES = 1024 * 1024;

function clearFlow(response: NextResponse): void {
  const production = process.env.NODE_ENV === "production";
  response.cookies.set(SAML_FLOW_COOKIE, "", {
    httpOnly: true,
    secure: production,
    sameSite: production ? "none" : "lax",
    path: "/api/saml/acs",
    maxAge: 0,
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const secret = process.env.MENDPOINT_WEB_ACCESS_TOKEN?.trim();
  if (!secret) return Response.json({ error: "web_access_not_configured" }, { status: 503 });
  let config: ReturnType<typeof samlSpConfig>;
  try {
    config = samlSpConfig();
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "saml_not_configured",
    }, { status: 503 });
  }
  if (!config) return Response.json({ error: "saml_not_configured" }, { status: 503 });

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return Response.json({ error: "saml_callback_invalid" }, { status: 400 });
  }
  let raw: Uint8Array<ArrayBuffer> | null;
  try {
    raw = await readRequestBodyWithinLimit(request, MAX_SAML_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyLimitExceededError) {
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    }
    if (error instanceof InvalidContentLengthError) {
      return Response.json({ error: "invalid_content_length" }, { status: 400 });
    }
    throw error;
  }
  const form = new URLSearchParams(Buffer.from(raw ?? []).toString("utf8"));
  const samlResponse = form.get("SAMLResponse");
  const relayState = form.get("RelayState");
  const flowCookie = request.cookies.get(SAML_FLOW_COOKIE)?.value ?? "";
  if (
    typeof samlResponse !== "string" ||
    typeof relayState !== "string" ||
    !flowCookie
  ) {
    return Response.json({ error: "saml_callback_invalid" }, { status: 400 });
  }

  const flow = await readSamlFlow({ cookie: flowCookie, secret });
  if (!flow) return Response.json({ error: "saml_flow_invalid" }, { status: 400 });

  try {
    const bridge = samlBridgeConfig();
    const identity = await validateSamlResponse({
      config,
      bridge,
      flow,
      samlResponse,
      relayState,
    });
    const { token, expiresInSeconds } = await mintBridgeToken({ bridge, identity });
    const response = NextResponse.redirect(new URL(flow.returnTo, config.acsUrl));
    clearFlow(response);
    response.cookies.set(WEB_SESSION_COOKIE, await createOidcWebSession({
      accessToken: token,
      sessionSecret: secret,
      expiresInSeconds,
    }), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: expiresInSeconds,
    });
    return response;
  } catch (error) {
    const response = NextResponse.json({
      error: error instanceof Error ? error.message : "saml_callback_failed",
    }, { status: 400 });
    clearFlow(response);
    return response;
  }
}
