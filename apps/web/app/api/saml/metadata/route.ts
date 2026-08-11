import { samlMetadata, samlSpConfig } from "../../../../lib/saml-auth";

export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    const config = samlSpConfig();
    if (!config) return Response.json({ error: "saml_not_configured" }, { status: 503 });
    return new Response(samlMetadata(config), {
      headers: {
        "Content-Type": "application/samlmetadata+xml",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "saml_metadata_failed",
    }, { status: 503 });
  }
}
