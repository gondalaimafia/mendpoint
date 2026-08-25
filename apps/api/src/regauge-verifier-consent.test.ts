import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  findActiveLearningConsent,
  grantLearningConsent,
  insertPrincipal,
  insertTenant,
  revokeLearningConsent,
  type AppDb,
} from "@mendpoint/db";
import {
  REGAUGE_VERIFIER_CONSENT_PURPOSE,
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
    expect(ensureRegaugeVerifierConsent(db, input)).toMatchObject({
      status: "active",
      consent: { id: "consent_regauge_20260824" },
    });
    expect(ensureRegaugeVerifierConsent(db, { ...input, createdAt: "2026-08-25T12:00:00.000Z" }))
      .toMatchObject({ status: "active", consent: { id: "consent_regauge_20260824" } });
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

  it("keeps bootstrap available but verifier disabled after revocation until an explicit versioned grant", () => {
    const db = setup();
    const authority = regaugeVerifierConsentAuthorityFromEnvironment(environment(), "tenant_regauge_canary");
    const input = {
      tenantId: "tenant_regauge_canary",
      reviewerPrincipalId: "reviewer_a",
      authority,
      createdAt: "2026-08-24T12:00:00.000Z",
    };
    const granted = ensureRegaugeVerifierConsent(db, input);
    expect(granted).toMatchObject({ status: "active", consent: { consent_version: 1 } });
    revokeLearningConsent(db, {
      id: "consent_regauge_revoked_20260824",
      tenantId: "tenant_regauge_canary",
      consentId: authority.consentId,
      consentVersion: 2,
      authorizedByPrincipalId: "reviewer_a",
      reason: "Operator revoked external verifier processing.",
      idempotencyKey: "regauge-verifier-consent-revoke:v2",
      createdAt: "2026-08-24T12:01:00.000Z",
    });

    expect(ensureRegaugeVerifierConsent(db, {
      ...input,
      createdAt: "2026-08-24T12:02:00.000Z",
    })).toMatchObject({
      status: "disabled",
      reason: "historical_consent_inactive",
      latestConsentId: "consent_regauge_revoked_20260824",
      latestConsentVersion: 2,
    });
    expect(findActiveLearningConsent(db, {
      tenantId: "tenant_regauge_canary",
      purpose: REGAUGE_VERIFIER_CONSENT_PURPOSE,
      at: "2026-08-24T12:02:00.000Z",
    })).toBeUndefined();
    expect((db.raw.prepare("SELECT COUNT(*) count FROM learning_consents").get() as { count: number }).count)
      .toBe(2);

    const replacementAuthority = {
      ...authority,
      consentId: "consent_regauge_20260824_v3",
      evidenceRef: "approval:user:2026-08-24:v3",
    };
    grantLearningConsent(db, {
      id: replacementAuthority.consentId,
      tenantId: "tenant_regauge_canary",
      consentVersion: 3,
      purpose: REGAUGE_VERIFIER_CONSENT_PURPOSE,
      residencyRegion: replacementAuthority.residencyRegion,
      authorizedByPrincipalId: "reviewer_a",
      supersedesConsentId: "consent_regauge_revoked_20260824",
      effectiveAt: replacementAuthority.effectiveAt,
      expiresAt: replacementAuthority.expiresAt,
      reason: `Authorized DeepSeek advisory verification for campaign_regauge_canary_20260814 at gondalaimafia/mendpoint-canary-drill-20260801: ${replacementAuthority.evidenceRef}`,
      idempotencyKey: "regauge-verifier-consent:v3",
      createdAt: "2026-08-24T12:03:00.000Z",
    });
    expect(ensureRegaugeVerifierConsent(db, {
      ...input,
      authority: replacementAuthority,
      createdAt: "2026-08-24T12:04:00.000Z",
    })).toMatchObject({ status: "active", consent: { id: replacementAuthority.consentId, consent_version: 3 } });
  });
});
