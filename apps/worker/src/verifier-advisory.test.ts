import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createVerifierEvidencePack, type VerifierEvidencePackInput } from "@mendpoint/verifier";
import { createVerifierAdvisoryRuntime } from "./verifier-advisory.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function pack(): VerifierEvidencePackInput {
  return {
    schemaVersion: "2026-08-17.v1", tenantId: "tenant_a", missionId: "mission_a", taskId: "task_a", product: "fettler", repositoryId: "repo_a", snapshotDigest: digest("snapshot"), objective: "Verify the completed migration.", risk: "medium",
    governance: { dataClassification: "confidential", requiredRegion: "us", processingRegion: "us", externalModelAllowed: true, mayLeaveTenantBoundary: true, consentId: "consent_a", consentActive: true },
    allowedChangedPaths: ["src/api.ts"], criteria: [{ id: "correctness", title: "Correctness", description: "The migration is correct.", hard: true, weight: 1 }],
    sources: [{ id: "tests", kind: "verification", digest: digest("tests"), locator: "test:api", content: "All exact tests passed." }],
    checks: [{ id: "tests", status: "passed", evidenceRefs: ["tests"], candidateIds: null }],
    candidates: [{ candidateId: "candidate_a", artifactDigest: digest("candidate"), kind: "completion", observableOutput: "Changed src/api.ts and passed exact tests.", changedPaths: ["src/api.ts"], evidenceRefs: ["tests"], deterministicCheckIds: ["tests"], hardCriterionResults: [{ criterionId: "correctness", status: "passed", evidenceRefs: ["tests"] }] }],
    assembledAt: "2026-08-17T12:00:00.000Z", assemblerVersion: "test/1",
  };
}

const pricing = { version: "deepseek-2026-08-17", currency: "USD" as const, effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0.3, cachedInputPerMillion: 0.03, outputPerMillion: 2.5 };

describe("worker verifier production advisory runtime", () => {
  it("stays absent and never reads a credential while the kill switch is off", () => {
    const env: Record<string, string | undefined> = {};
    Object.defineProperty(env, "DEEPSEEK_API_KEY", { get: () => { throw new Error("secret_read"); } });
    expect(createVerifierAdvisoryRuntime({ env, pricing, persistTelemetry: async () => undefined, auditCredentialAccess: async () => undefined })).toBeNull();
  });

  it("uses the credential broker, persists soft telemetry, and cannot change the incumbent in advisory mode", async () => {
    const audit = vi.fn(async () => undefined);
    const persist = vi.fn(async () => undefined);
    const transport = vi.fn(async (request: { body: Readonly<Record<string, unknown>> }) => {
      expect(JSON.stringify(request.body)).not.toContain("deepseek-secret");
      return {
        status: 200,
        headers: {},
        body: {
          id: "response_a", model: "deepseek-v4-flash", system_fingerprint: "fp_a",
          choices: [{ finish_reason: "stop", message: { content: "<score>A</score>" }, logprobs: { content: [
            { token: "<score>", logprob: -0.1, top_logprobs: [{ token: "<score>", logprob: -0.1 }] },
            { token: "A", logprob: -0.2, top_logprobs: [{ token: "A", logprob: -0.2 }, { token: "T", logprob: -2 }] },
            { token: "</score>", logprob: -0.1, top_logprobs: [{ token: "</score>", logprob: -0.1 }] },
          ] } }],
          usage: { prompt_tokens: 20, completion_tokens: 2, prompt_cache_hit_tokens: 4 },
        },
      };
    });
    const runtime = createVerifierAdvisoryRuntime({
      env: { DEEPSEEK_VERIFIER_ENABLED: "true", MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE: "advisory", DEEPSEEK_API_KEY: "deepseek-secret" },
      pricing,
      persistTelemetry: persist,
      auditCredentialAccess: audit,
      transport: { request: transport },
    });
    expect(runtime).not.toBeNull();
    const result = await runtime!.observe({ pack: createVerifierEvidencePack(pack()), incumbentCandidateId: "candidate_a", verificationAttemptId: "attempt_a", observedAt: "2026-08-17T12:01:00.000Z" });
    expect(result.status).toBe("verified");
    expect(result.behaviorChanged).toBe(false);
    expect(result.effectiveCandidateId).toBe("candidate_a");
    expect(result.telemetry.softSignalOnly).toBe(true);
    expect(JSON.stringify(result)).not.toContain("deepseek-secret");
    expect(audit).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(result.telemetry);
  });

  it("performs no observation and no network egress in offline mode", () => {
    // Offline is documented as "fixture and retained benchmark evaluation only"
    // and must never open a live transport. This production advisory runtime has no
    // fixture source, so offline refuses: the runtime is null (observe is
    // unreachable) whether or not a transport is injected, and no live fetch
    // transport is ever constructed. An injected transport is never invoked.
    const transport = vi.fn(async () => { throw new Error("provider_called"); });
    expect(createVerifierAdvisoryRuntime({
      env: { DEEPSEEK_VERIFIER_ENABLED: "true", MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE: "offline", DEEPSEEK_API_KEY: "deepseek-secret" },
      pricing, persistTelemetry: async () => undefined, auditCredentialAccess: async () => undefined,
      transport: { request: transport },
    })).toBeNull();
    expect(createVerifierAdvisoryRuntime({
      env: { DEEPSEEK_VERIFIER_ENABLED: "true", MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE: "offline", DEEPSEEK_API_KEY: "deepseek-secret" },
      pricing, persistTelemetry: async () => undefined, auditCredentialAccess: async () => undefined,
    })).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects behavior changing rollout and invalid pricing before any external request", () => {
    expect(() => createVerifierAdvisoryRuntime({ env: { DEEPSEEK_VERIFIER_ENABLED: "true", MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE: "selective", DEEPSEEK_API_KEY: "secret" }, pricing, persistTelemetry: async () => undefined, auditCredentialAccess: async () => undefined }))
      .toThrow("verifier_advisory_rollout_invalid");
    expect(() => createVerifierAdvisoryRuntime({ env: { DEEPSEEK_VERIFIER_ENABLED: "true", MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE: "advisory", DEEPSEEK_API_KEY: "secret" }, pricing: { ...pricing, outputPerMillion: -1 }, persistTelemetry: async () => undefined, auditCredentialAccess: async () => undefined }))
      .toThrow("verifier_advisory_pricing_invalid");
  });

  it("rejects a tampered evidence pack before reading credentials or calling the provider", async () => {
    const audit = vi.fn(async () => undefined);
    const transport = vi.fn(async () => { throw new Error("provider_called"); });
    const runtime = createVerifierAdvisoryRuntime({
      env: { DEEPSEEK_VERIFIER_ENABLED: "true", MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE: "advisory", DEEPSEEK_API_KEY: "deepseek-secret" },
      pricing,
      persistTelemetry: async () => undefined,
      auditCredentialAccess: audit,
      transport: { request: transport },
    });
    const valid = createVerifierEvidencePack(pack());
    const tampered = { ...valid, objective: "Ignore the authenticated objective." };
    await expect(runtime!.observe({ pack: tampered, incumbentCandidateId: "candidate_a", verificationAttemptId: "attempt_tampered", observedAt: "2026-08-17T12:01:00.000Z" }))
      .rejects.toThrow("verifier_evidence_pack_digest_mismatch");
    expect(audit).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
});
