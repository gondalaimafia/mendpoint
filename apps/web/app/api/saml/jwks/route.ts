import { bridgeJwks, samlBridgeConfig, samlSpConfig } from "../../../../lib/saml-auth";

export const dynamic = "force-dynamic";

/**
 * JWKS for the SAML bridge signing key. The API's OIDC_JWKS_URI points here so
 * it can verify the bridge JWT minted after a SAML assertion is validated.
 */
export async function GET(): Promise<Response> {
  try {
    if (!samlSpConfig()) return Response.json({ error: "saml_not_configured" }, { status: 503 });
    const bridge = samlBridgeConfig();
    return Response.json(await bridgeJwks(bridge), {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "saml_jwks_failed",
    }, { status: 503 });
  }
}
