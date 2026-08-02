import { describe, expect, it } from "vitest";
import { validateWebProductionEnv } from "./start-production.mjs";

const base = {
  MENDPOINT_API_URL: "http://api.internal:3001",
  MENDPOINT_API_KEY: "api-secret",
  MENDPOINT_WEB_ACCESS_TOKEN: "different-web-secret",
  MENDPOINT_WEB_ALLOWED_ORIGINS: "https://console.example",
};

describe("web production configuration", () => {
  it("fails customer ready mode without human identity and real delivery", () => {
    const report = validateWebProductionEnv({
      ...base,
      MENDPOINT_CUSTOMER_READY: "1",
      GITHUB_MODE: "mock",
    });
    expect(report.ok).toBe(false);
    expect(report.errors).toContain("Customer ready mode requires browser OIDC");
    expect(report.errors).toContain("Customer ready mode requires GITHUB_MODE=real");
  });

  it("accepts customer ready mode only with complete browser identity and real delivery", () => {
    const report = validateWebProductionEnv({
      ...base,
      MENDPOINT_CUSTOMER_READY: "1",
      GITHUB_MODE: "real",
      OIDC_ISSUER: "https://identity.example",
      OIDC_AUDIENCE: "mendpoint-api",
      OIDC_JWKS_URI: "https://identity.example/.well-known/jwks.json",
      OIDC_CLIENT_ID: "mendpoint-web",
      OIDC_REDIRECT_URI: "https://console.example/api/oidc/callback",
    });
    expect(report).toEqual({ ok: true, errors: [] });
  });
});
