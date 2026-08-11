import { samlConfigured } from "../../../../lib/saml-auth";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ enabled: samlConfigured() }, {
    headers: { "Cache-Control": "no-store" },
  });
}
