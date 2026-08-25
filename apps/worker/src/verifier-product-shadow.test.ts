import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, grantLearningConsent, insertPrincipal, insertTenant, listArtifactManifests, revokeLearningConsent, type AppDb } from "@mendpoint/db";
import { observeProductCompletionInAdvisory, VERIFIER_EXTERNAL_MODEL_CONSENT_PURPOSE } from "./verifier-product-shadow.js";

const roots: string[] = [];
const dbs: AppDb[] = [];
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
afterEach(() => { while (dbs.length) dbs.pop()!.raw.close(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function setup(): AppDb { const root = mkdtempSync(join(tmpdir(), "verifier-product-shadow-")); roots.push(root); const db = createDb(join(root, "app.sqlite")); dbs.push(db); insertTenant(db, { id: "tenant_a", slug: "tenant-a", name: "Tenant A", createdAt: "2026-08-17T12:00:00.000Z" }); insertPrincipal(db, { id: "worker_a", tenantId: "tenant_a", kind: "service", subject: "worker", displayName: "Worker", createdAt: "2026-08-17T12:00:00.000Z" }); insertPrincipal(db, { id: "human_a", tenantId: "tenant_a", kind: "human", subject: "human@example.com", displayName: "Human", createdAt: "2026-08-17T12:00:00.000Z" }); return db; }

// Grant an active external-model verifier consent for tenant_a in the append-only
// learning_consents table. effectiveAt/expiresAt bound the validity window; the
// completion's observedAt (2026-08-17T12:01:00.000Z) falls inside the defaults.
function grantVerifierConsent(db: AppDb, over: { id?: string; effectiveAt?: string; expiresAt?: string | null } = {}): string {
  const id = over.id ?? "consent_a";
  grantLearningConsent(db, {
    id, tenantId: "tenant_a", consentVersion: 1, purpose: VERIFIER_EXTERNAL_MODEL_CONSENT_PURPOSE,
    residencyRegion: "us", authorizedByPrincipalId: "human_a", supersedesConsentId: null,
    effectiveAt: over.effectiveAt ?? "2026-08-17T00:00:00.000Z", expiresAt: over.expiresAt ?? null,
    reason: "test grant", idempotencyKey: "grant_v1", createdAt: "2026-08-17T00:00:00.000Z",
  });
  return id;
}
function completion() { return { tenantId: "tenant_a", missionId: "mission_a", taskId: "task_a", product: "fettler" as const, repositoryId: "repo_a", snapshotId: "snapshot_a", snapshotDigest: digest("snapshot"), objective: "Migrate the API.", risk: "medium" as const, allowedChangedPaths: ["src/api.ts"], candidateId: "candidate_a", candidateDigest: digest("candidate"), changedPaths: ["src/api.ts"], observableSummary: "The candidate passed exact verification.", deterministicEvidenceDigest: digest("evidence"), deterministicEvidenceRefs: ["tests"], observedAt: "2026-08-17T12:01:00.000Z" }; }

describe("product verifier advisory adapter", () => {
  it("is a no operation when the kill switch is off", async () => {
    const db = setup();
    expect(await observeProductCompletionInAdvisory({ db, env: {}, completion: completion() })).toBeNull();
    expect(listArtifactManifests(db, "tenant_a", "agent_verifier_telemetry")).toHaveLength(0);
  });

  it("binds exact tenant governance, verifies, audits, and persists unknown evidence", async () => {
    const db = setup();
    grantVerifierConsent(db);
    const env = {
      DEEPSEEK_VERIFIER_ENABLED: "true",
      MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE: "advisory",
      DEEPSEEK_API_KEY: "secret",
      MENDPOINT_AGENT_VERIFIER_PRINCIPAL_ID: "worker_a",
      MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON: JSON.stringify({ schemaVersion: "2026-08-17.v1", entries: [{ tenantId: "tenant_a", products: ["fettler"], dataClassification: "confidential", requiredRegion: "us", processingRegion: "us", consentId: "consent_a", evidenceRef: "approval:verifier-a", externalModelAllowed: true, mayLeaveTenantBoundary: true, consentActive: true }] }),
      MENDPOINT_AGENT_VERIFIER_PRICING_JSON: JSON.stringify({ version: "deepseek-2026-08-17", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0.3, cachedInputPerMillion: 0.03, outputPerMillion: 2.5 }),
    };
    const transport = vi.fn(async () => ({ status: 200, headers: {}, body: { id: "response_a", model: "deepseek-v4-flash", system_fingerprint: "fp", choices: [{ finish_reason: "stop", message: { content: "<score>A</score>" }, logprobs: { content: [
      { token: "<score>", logprob: -0.1, top_logprobs: [{ token: "<score>", logprob: -0.1 }] },
      { token: "A", logprob: -0.2, top_logprobs: [{ token: "A", logprob: -0.2 }, { token: "T", logprob: -2 }] },
      { token: "</score>", logprob: -0.1, top_logprobs: [{ token: "</score>", logprob: -0.1 }] },
    ] } }], usage: { prompt_tokens: 10, completion_tokens: 1 } } }));
    const request = {
      db,
      env,
      completion: completion(),
      transport: { request: transport },
    } as const;
    const result = await observeProductCompletionInAdvisory(request);
    expect(result?.status).toBe("verified");
    expect(result?.behaviorChanged).toBe(false);
    expect(listArtifactManifests(db, "tenant_a", "agent_verifier_telemetry")).toHaveLength(1);
    const callCount = transport.mock.calls.length;
    expect(callCount).toBeGreaterThan(0);
    expect(await observeProductCompletionInAdvisory(request)).toBeNull();
    expect(transport).toHaveBeenCalledTimes(callCount);
    const audit = db.raw.prepare("SELECT action, metadata_json FROM audit_events WHERE tenant_id = ? AND action = ?").get("tenant_a", "verifier.credential_access") as { action: string; metadata_json: string };
    expect(audit.action).toBe("verifier.credential_access");
    expect(audit.metadata_json).not.toContain("secret");
  });

  it("fails closed before a request when tenant governance is absent", async () => {
    const db = setup();
    await expect(observeProductCompletionInAdvisory({ db, env: { DEEPSEEK_VERIFIER_ENABLED: "true", DEEPSEEK_API_KEY: "secret", MENDPOINT_AGENT_VERIFIER_PRICING_JSON: JSON.stringify({ version: "v", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 }) }, completion: completion() }))
      .rejects.toThrow("verifier_governance_configuration_required");
  });

  it("refuses external verification when tenant governance withholds the egress authority", async () => {
    const db = setup();
    const transport = vi.fn(async () => ({ status: 200, headers: {}, body: {} }));
    const env = {
      DEEPSEEK_VERIFIER_ENABLED: "true",
      MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE: "advisory",
      DEEPSEEK_API_KEY: "secret",
      MENDPOINT_AGENT_VERIFIER_PRINCIPAL_ID: "worker_a",
      MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON: JSON.stringify({ schemaVersion: "2026-08-17.v1", entries: [{ tenantId: "tenant_a", products: ["fettler"], dataClassification: "confidential", requiredRegion: "us", processingRegion: "us", consentId: "consent_a", evidenceRef: "approval:verifier-a", externalModelAllowed: false, mayLeaveTenantBoundary: true, consentActive: true }] }),
      MENDPOINT_AGENT_VERIFIER_PRICING_JSON: JSON.stringify({ version: "v", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 }),
    };
    await expect(observeProductCompletionInAdvisory({ db, env, completion: completion(), transport: { request: transport } }))
      .rejects.toThrow("verifier_governance_external_model_denied");
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses to externally verify restricted classification content on the egress path", async () => {
    const db = setup();
    grantVerifierConsent(db);
    const transport = vi.fn(async () => ({ status: 200, headers: {}, body: {} }));
    const env = {
      DEEPSEEK_VERIFIER_ENABLED: "true",
      MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE: "advisory",
      DEEPSEEK_API_KEY: "secret",
      MENDPOINT_AGENT_VERIFIER_PRINCIPAL_ID: "worker_a",
      MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON: JSON.stringify({ schemaVersion: "2026-08-17.v1", entries: [{ tenantId: "tenant_a", products: ["fettler"], dataClassification: "restricted", requiredRegion: "us", processingRegion: "us", consentId: "consent_a", evidenceRef: "approval:verifier-a", externalModelAllowed: true, mayLeaveTenantBoundary: true, consentActive: true }] }),
      MENDPOINT_AGENT_VERIFIER_PRICING_JSON: JSON.stringify({ version: "v", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 }),
    };
    await expect(observeProductCompletionInAdvisory({ db, env, completion: completion(), transport: { request: transport } }))
      .rejects.toThrow("verifier_governance_restricted_egress_denied");
    expect(transport).not.toHaveBeenCalled();
  });

  // Governance env that authorizes egress at the operator level (external model
  // allowed, operator consent switch on). Whether egress actually happens now
  // depends on an active tenant consent row in learning_consents.
  function grantedEnv(over: Record<string, unknown> = {}): Record<string, string> {
    return {
      DEEPSEEK_VERIFIER_ENABLED: "true",
      MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE: "advisory",
      DEEPSEEK_API_KEY: "secret",
      MENDPOINT_AGENT_VERIFIER_PRINCIPAL_ID: "worker_a",
      MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON: JSON.stringify({ schemaVersion: "2026-08-17.v1", entries: [{ tenantId: "tenant_a", products: ["fettler"], dataClassification: "confidential", requiredRegion: "us", processingRegion: "us", consentId: "consent_a", evidenceRef: "approval:verifier-a", externalModelAllowed: true, mayLeaveTenantBoundary: true, consentActive: true, ...over }] }),
      MENDPOINT_AGENT_VERIFIER_PRICING_JSON: JSON.stringify({ version: "v", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 }),
    };
  }

  it("refuses external egress when the tenant has no consent record", async () => {
    const db = setup();
    const transport = vi.fn(async () => ({ status: 200, headers: {}, body: {} }));
    await expect(observeProductCompletionInAdvisory({ db, env: grantedEnv(), completion: completion(), transport: { request: transport } }))
      .rejects.toThrow("verifier_governance_consent_inactive");
    expect(transport).not.toHaveBeenCalled();
  });

  it("stops egress the moment consent is revoked, with no redeploy", async () => {
    const db = setup();
    grantVerifierConsent(db);
    revokeLearningConsent(db, { id: "consent_v2", tenantId: "tenant_a", consentId: "consent_a", consentVersion: 2, authorizedByPrincipalId: "human_a", reason: "revoked", idempotencyKey: "revoke_v1", createdAt: "2026-08-17T00:30:00.000Z" });
    const transport = vi.fn(async () => ({ status: 200, headers: {}, body: {} }));
    await expect(observeProductCompletionInAdvisory({ db, env: grantedEnv(), completion: completion(), transport: { request: transport } }))
      .rejects.toThrow("verifier_governance_consent_inactive");
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses external egress when consent has expired", async () => {
    const db = setup();
    // Window closes at 11:00, before the completion's 12:01 observedAt.
    grantVerifierConsent(db, { expiresAt: "2026-08-17T11:00:00.000Z" });
    const transport = vi.fn(async () => ({ status: 200, headers: {}, body: {} }));
    await expect(observeProductCompletionInAdvisory({ db, env: grantedEnv(), completion: completion(), transport: { request: transport } }))
      .rejects.toThrow("verifier_governance_consent_inactive");
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses external egress when durable consent does not match protected governance", async () => {
    const db = setup();
    grantVerifierConsent(db, { id: "consent_unapproved" });
    const transport = vi.fn(async () => ({ status: 200, headers: {}, body: {} }));
    await expect(observeProductCompletionInAdvisory({ db, env: grantedEnv(), completion: completion(), transport: { request: transport } }))
      .rejects.toThrow("verifier_governance_consent_inactive");
    expect(transport).not.toHaveBeenCalled();
  });

  it("permits external egress for an active in-window consent", async () => {
    const db = setup();
    grantVerifierConsent(db);
    const transport = vi.fn(async () => ({ status: 200, headers: {}, body: { id: "response_a", model: "deepseek-v4-flash", system_fingerprint: "fp", choices: [{ finish_reason: "stop", message: { content: "<score>A</score>" }, logprobs: { content: [
      { token: "<score>", logprob: -0.1, top_logprobs: [{ token: "<score>", logprob: -0.1 }] },
      { token: "A", logprob: -0.2, top_logprobs: [{ token: "A", logprob: -0.2 }, { token: "T", logprob: -2 }] },
      { token: "</score>", logprob: -0.1, top_logprobs: [{ token: "</score>", logprob: -0.1 }] },
    ] } }], usage: { prompt_tokens: 10, completion_tokens: 1 } } }));
    const excerpt = "export const endpoint = '/v1/responses';\n";
    const result = await observeProductCompletionInAdvisory({
      db,
      env: grantedEnv(),
      completion: {
        ...completion(),
        repositoryExcerpt: {
          digest: digest(excerpt),
          locator: "src/api.ts",
          content: excerpt,
        },
      },
      transport: { request: transport },
    });
    expect(result?.status).toBe("verified");
    expect(result?.recommendation).toBe("ready_for_review");
    expect(transport.mock.calls.length).toBeGreaterThan(0);
  });

  it("lets the operator external-processing off switch win even for a consenting tenant", async () => {
    const db = setup();
    grantVerifierConsent(db);
    const transport = vi.fn(async () => ({ status: 200, headers: {}, body: {} }));
    // Tenant consent is active, but the operator has globally disabled external
    // processing: the operator switch is evaluated before consent and refuses.
    await expect(observeProductCompletionInAdvisory({ db, env: grantedEnv({ externalModelAllowed: false }), completion: completion(), transport: { request: transport } }))
      .rejects.toThrow("verifier_governance_external_model_denied");
    expect(transport).not.toHaveBeenCalled();
  });
});
