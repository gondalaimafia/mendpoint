import { oidcClientConfig } from "../../../../lib/oidc-auth";

export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    oidcClientConfig();
    return Response.json({ enabled: true }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ enabled: false }, {
      headers: { "Cache-Control": "no-store" },
    });
  }
}
