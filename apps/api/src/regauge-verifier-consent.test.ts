import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, insertPrincipal, insertTenant, type AppDb } from "@mendpoint/db";
import {
  ensureRegaugeVerifierConsent,
  regaugeVerifierConsentAuthorityFromEnvironment,
} from "./regauge-verifier-consent.js";

const dbs: AppDb[] = [];
const roots: string[] = [];
afterEach(() => {
  while (dbs.length) dbs.pop()!.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function setup(): AppDb {
  const root = mkdtempSync(join(tmpdir(), "regauge-verifier-consent-"));
  roots.push(root);
  const db = createDb(join(root, "app.sqlite"));
  dbs.push(db);
  insertTenant(db, { id: "tenant_regauge_canary", slug: "tenant-regauge-canary", name: "ReGauge canary", createdAt: "2026-08-24T00:00:00.000Z" });
  insertPrincipal(db, { id: "reviewer_a", tenantId: "tenant_regauge_canary", kind: "human", subject: "issuer|subject", displayName: "Reviewer", createdAt: "2026-08-24T00:00:00.000Z" });
  return db;
}

function environment(over: Record<string, string> = {}): Record<string, string> {
  return {
    MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON: JSON.stringify({
      schemaVersion: "2026-08-17.v1",
      entries: [{ tenantId: "tenant_regauge_canary", products: ["regauge"], consentId: "consent_regauge_20260824", evidenceRef: "approval:user:2026-08-24", requiredRegion: "cn", processingRegion: "cn", externalModelAllowed: true, mayLeaveTenantBoundary: true, consentActive: true }],
    }),
    MENDPOINT_REGAUGE_VERIFIER_CONSENT_EFFECTIVE_AT: "2026-08-24T00:00:00.000Z",
    MENDPOINT_REGAUGE_VERIFIER_CONSENT_EXPIRES_AT: "2026-11-20T23:59:59.000Z",
    ...over,
  };
}

describe("ReGauge verifier consent bootstrap", () => {
  it("creates and replays the exact append-only consent", () => {
    const db = setup();
    const authority = regaugeVerifierConsentAuthorityFromEnvironment(environment(), "tenant_regauge_canary");
    const input = { tenantId: "tenant_regauge_canary", reviewerPrincipalId: "reviewer_a", authority, createdAt: "2026-08-24T12:00:00.000Z" };
    expect(ensureRegaugeVerifierConsent(db, input).id).toBe("consent_regauge_20260824");
    expect(ensureRegaugeVerifierConsent(db, { ...input, createdAt: "2026-08-25T12:00:00.000Z" }).id)
      .toBe("consent_regauge_20260824");
    expect((db.raw.prepare("SELECT COUNT(*) count FROM learning_consents").get() as { count: number }).count).toBe(1);
    expect((db.raw.prepare("SELECT purpose FROM learning_consents WHERE id = ?").get("consent_regauge_20260824") as { purpose: string }).purpose)
      .toBe("verifier-external-model-egress:regauge:campaign_regauge_canary_20260814:gondalaimafia/mendpoint-canary-drill-20260801");
  });

  it("rejects authority beyond the approved date and an active mismatched grant", () => {
    const db = setup();
    expect(() => regaugeVerifierConsentAuthorityFromEnvironment(environment({ MENDPOINT_REGAUGE_VERIFIER_CONSENT_EXPIRES_AT: "2026-11-21T00:00:00.000Z" }), "tenant_regauge_canary"))
      .toThrow("regauge_verifier_consent_window_invalid");
    expect(() => regaugeVerifierConsentAuthorityFromEnvironment(environment(), "tenant_other"))
      .toThrow("regauge_verifier_consent_scope_invalid");
    const first = regaugeVerifierConsentAuthorityFromEnvironment(environment(), "tenant_regauge_canary");
    ensureRegaugeVerifierConsent(db, { tenantId: "tenant_regauge_canary", reviewerPrincipalId: "reviewer_a", authority: first, createdAt: "2026-08-24T12:00:00.000Z" });
    const changed = { ...first, evidenceRef: "approval:changed" };
    expect(() => ensureRegaugeVerifierConsent(db, { tenantId: "tenant_regauge_canary", reviewerPrincipalId: "reviewer_a", authority: changed, createdAt: "2026-08-24T12:01:00.000Z" }))
      .toThrow("regauge_verifier_consent_drift");
  });
});
