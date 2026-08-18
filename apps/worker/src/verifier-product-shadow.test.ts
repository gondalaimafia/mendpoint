import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, insertPrincipal, insertTenant, listArtifactManifests, type AppDb } from "@mendpoint/db";
import { observeProductCompletionInShadow } from "./verifier-product-shadow.js";

const roots: string[] = [];
const dbs: AppDb[] = [];
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
afterEach(() => { while (dbs.length) dbs.pop()!.raw.close(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function setup(): AppDb { const root = mkdtempSync(join(tmpdir(), "verifier-product-shadow-")); roots.push(root); const db = createDb(join(root, "app.sqlite")); dbs.push(db); insertTenant(db, { id: "tenant_a", slug: "tenant-a", name: "Tenant A", createdAt: "2026-08-17T12:00:00.000Z" }); insertPrincipal(db, { id: "worker_a", tenantId: "tenant_a", kind: "service", subject: "worker", displayName: "Worker", createdAt: "2026-08-17T12:00:00.000Z" }); return db; }
function completion() { return { tenantId: "tenant_a", missionId: "mission_a", taskId: "task_a", product: "fettler" as const, repositoryId: "repo_a", snapshotDigest: digest("snapshot"), objective: "Migrate the API.", risk: "medium" as const, allowedChangedPaths: ["src/api.ts"], candidateId: "candidate_a", candidateDigest: digest("candidate"), changedPaths: ["src/api.ts"], observableSummary: "The candidate passed exact verification.", deterministicEvidenceDigest: digest("evidence"), deterministicEvidenceRefs: ["tests"], observedAt: "2026-08-17T12:01:00.000Z" }; }

describe("product verifier shadow adapter", () => {
  it("is a no operation when the kill switch is off", async () => {
    const db = setup();
    expect(await observeProductCompletionInShadow({ db, env: {}, completion: completion() })).toBeNull();
    expect(listArtifactManifests(db, "tenant_a", "agent_verifier_telemetry")).toHaveLength(0);
  });

  it("binds exact tenant governance, verifies, audits, and persists unknown evidence", async () => {
    const db = setup();
    const env = {
      DEEPSEEK_VERIFIER_ENABLED: "true",
      MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE: "shadow",
      DEEPSEEK_API_KEY: "secret",
      MENDPOINT_AGENT_VERIFIER_PRINCIPAL_ID: "worker_a",
      MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON: JSON.stringify({ schemaVersion: "2026-08-17.v1", entries: [{ tenantId: "tenant_a", products: ["fettler"], dataClassification: "confidential", requiredRegion: "us", processingRegion: "us", consentId: "consent_a", evidenceRef: "approval:verifier-a" }] }),
      MENDPOINT_AGENT_VERIFIER_PRICING_JSON: JSON.stringify({ version: "deepseek-2026-08-17", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0.3, cachedInputPerMillion: 0.03, outputPerMillion: 2.5 }),
    };
    const transport = vi.fn(async () => ({ status: 200, headers: {}, body: { id: "response_a", model: "deepseek-v4-flash", system_fingerprint: "fp", choices: [{ finish_reason: "stop", message: { content: "<score>A</score>" }, logprobs: { content: [
      { token: "<score>", logprob: -0.1, top_logprobs: [{ token: "<score>", logprob: -0.1 }] },
      { token: "A", logprob: -0.1, top_logprobs: [{ token: "A", logprob: -0.1 }, { token: "T", logprob: -2 }] },
      { token: "</score>", logprob: -0.1, top_logprobs: [{ token: "</score>", logprob: -0.1 }] },
    ] } }], usage: { prompt_tokens: 10, completion_tokens: 1 } } }));
    const request = {
      db,
      env,
      completion: completion(),
      transport: { request: transport },
    } as const;
    const result = await observeProductCompletionInShadow(request);
    expect(result?.status).toBe("verified");
    expect(result?.behaviorChanged).toBe(false);
    expect(listArtifactManifests(db, "tenant_a", "agent_verifier_telemetry")).toHaveLength(1);
    const callCount = transport.mock.calls.length;
    expect(callCount).toBeGreaterThan(0);
    expect(await observeProductCompletionInShadow(request)).toBeNull();
    expect(transport).toHaveBeenCalledTimes(callCount);
    const audit = db.raw.prepare("SELECT action, metadata_json FROM audit_events WHERE tenant_id = ? AND action = ?").get("tenant_a", "verifier.credential_access") as { action: string; metadata_json: string };
    expect(audit.action).toBe("verifier.credential_access");
    expect(audit.metadata_json).not.toContain("secret");
  });

  it("fails closed before a request when tenant governance is absent", async () => {
    const db = setup();
    await expect(observeProductCompletionInShadow({ db, env: { DEEPSEEK_VERIFIER_ENABLED: "true", DEEPSEEK_API_KEY: "secret", MENDPOINT_AGENT_VERIFIER_PRICING_JSON: JSON.stringify({ version: "v", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 }) }, completion: completion() }))
      .rejects.toThrow("verifier_governance_configuration_required");
  });
});
