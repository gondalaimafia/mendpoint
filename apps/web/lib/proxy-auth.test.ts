import { describe, expect, it } from "vitest";
import {
  upstreamCredentialFor,
  type AuthenticatedWebCredential,
} from "./proxy-auth";

const deploymentKey = "me_deployment_tenant_A_credential";
const customerToken = "me_customer_tenant_B_credential";
const issuedAt = "2026-01-01T00:00:00.000Z";
const expiresAt = "2026-01-01T08:00:00.000Z";

function previewSession(): AuthenticatedWebCredential {
  return Object.freeze({
    subject: Object.freeze({ kind: "preview_access", issuedAt, expiresAt }),
    upstreamAccessToken: null,
  });
}

function selfServeSession(token = customerToken): AuthenticatedWebCredential {
  return Object.freeze({
    subject: Object.freeze({
      kind: "self_serve",
      tenantId: "tenant-b",
      subject: "customer-b",
      issuedAt,
      expiresAt,
    }),
    upstreamAccessToken: token,
  });
}

function oidcSession(token = customerToken): AuthenticatedWebCredential {
  return Object.freeze({
    subject: Object.freeze({ kind: "human_oidc", issuedAt, expiresAt }),
    upstreamAccessToken: token,
  });
}

describe("upstreamCredentialFor", () => {
  it("gives a verified preview session the deployment credential", () => {
    expect(upstreamCredentialFor(previewSession(), deploymentKey)).toEqual({
      ok: true,
      token: deploymentKey,
    });
  });

  it("gives a self-serve customer session its own token, never the deployment key", () => {
    // The deployment key is configured, yet a customer must never present it.
    const result = upstreamCredentialFor(selfServeSession(), deploymentKey);
    expect(result).toEqual({ ok: true, token: customerToken });
    if (result.ok) expect(result.token).not.toBe(deploymentKey);
  });

  it("gives a company-identity (OIDC) session its own token, never the deployment key", () => {
    const result = upstreamCredentialFor(oidcSession(), deploymentKey);
    expect(result).toEqual({ ok: true, token: customerToken });
    if (result.ok) expect(result.token).not.toBe(deploymentKey);
  });

  it("refuses a missing session before any credential is chosen", () => {
    // Absent, tampered, and expired cookies all resolve to a null credential.
    expect(upstreamCredentialFor(null, deploymentKey)).toEqual({
      ok: false,
      reason: "web_session_required",
      status: 401,
    });
  });

  it.each([undefined, ""])(
    "refuses a preview session when the deployment credential is unconfigured (%p)",
    (key) => {
      expect(upstreamCredentialFor(previewSession(), key)).toEqual({
        ok: false,
        reason: "proxy_api_key_not_configured",
        status: 503,
      });
    },
  );
});
