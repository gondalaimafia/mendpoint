import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "mendpoint_web_session";

async function sessionValue(accessToken: string): Promise<string> {
  const bytes = new TextEncoder().encode(`mendpoint-web-session-v1:${accessToken}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function publicPath(pathname: string): boolean {
  return (
    pathname === "/access" ||
    pathname === "/api/session" ||
    pathname === "/livez" ||
    pathname === "/healthz" ||
    pathname === "/webhooks/github" ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico"
  );
}

export async function middleware(request: NextRequest) {
  if (publicPath(request.nextUrl.pathname)) return NextResponse.next();
  const accessToken = process.env.MENDPOINT_WEB_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    return new NextResponse("Web access is not configured", { status: 503 });
  }
  const expected = await sessionValue(accessToken);
  const actual = request.cookies.get(SESSION_COOKIE)?.value;
  if (actual === expected) return NextResponse.next();

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
