import { NextRequest, NextResponse } from "next/server";
import { authenticatedWebSubject, selfServeSignupEnabled } from "./lib/proxy-auth";

/**
 * Self-serve signup surfaces are public only while the flag is on. When the flag
 * is unset (the default preview posture) this is inert, so the shared-token
 * `/access` gate for every existing path is byte-for-byte unchanged.
 */
function selfServeSignupPath(pathname: string): boolean {
  return pathname === "/signup" || pathname === "/api/signup";
}

function publicPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/access" ||
    pathname === "/contact" ||
    pathname === "/design-partners" ||
    pathname === "/docs" ||
    pathname === "/privacy" ||
    pathname === "/security" ||
    pathname === "/service-status" ||
    pathname === "/terms" ||
    pathname === "/api/design-partners" ||
    pathname === "/api/session" ||
    pathname === "/api/oidc/start" ||
    pathname === "/api/oidc/callback" ||
    pathname === "/api/oidc/config" ||
    pathname === "/api/saml/start" ||
    pathname === "/api/saml/acs" ||
    pathname === "/api/saml/config" ||
    pathname === "/api/saml/metadata" ||
    pathname === "/api/saml/jwks" ||
    pathname === "/livez" ||
    pathname === "/healthz" ||
    pathname === "/icon.svg" ||
    pathname === "/login" ||
    pathname === "/opengraph-image" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname === "/webhooks/github" ||
    pathname === "/github/setup" ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico"
  );
}

export async function middleware(request: NextRequest) {
  if (publicPath(request.nextUrl.pathname)) return NextResponse.next();
  if (selfServeSignupEnabled() && selfServeSignupPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }
  const accessToken = process.env.MENDPOINT_WEB_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    return new NextResponse("Web access is not configured", { status: 503 });
  }
  if (await authenticatedWebSubject(request)) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "web_session_required" }, { status: 401 });
  }
  const login = new URL("/access", request.url);
  login.searchParams.set(
    "next",
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
