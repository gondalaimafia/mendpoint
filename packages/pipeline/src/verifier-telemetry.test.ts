import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, insertPrincipal, insertTenant, listArtifactManifests, listEvidenceRecords, type AppDb } from "@mendpoint/db";
import { createAgentVerifier, createVerifierEvidencePack, type VerifierBackend, type VerifierEvidencePackInput } from "@mendpoint/verifier";
import { claimVerifierShadowAttempt, persistVerifierTelemetry } from "./verifier-telemetry.js";

const roots: string[] = [];
const dbs: AppDb[] = [];
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
afterEach(() => { while (dbs.length) dbs.pop()!.raw.close(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function setup(): AppDb { const root = mkdtempSync(join(tmpdir(), "verifier-telemetry-")); roots.push(root); const db = createDb(join(root, "app.sqlite")); dbs.push(db); insertTenant(db, { id: "tenant_a", slug: "tenant-a", name: "Tenant A", createdAt: "2026-08-17T12:00:00.000Z" }); insertPrincipal(db, { id: "worker_a", tenantId: "tenant_a", kind: "service", subject: "verifier-worker", displayName: "Verifier worker", createdAt: "2026-08-17T12:00:00.000Z" }); return db; }
function pack(): VerifierEvidencePackInput { return { schemaVersion: "2026-08-17.v1", tenantId: "tenant_a", missionId: "mission_a", taskId: "task_a", product: "regauge", repositoryId: "repo_a", snapshotDigest: digest("snapshot"), objective: "Verify the migration plan.", risk: "medium", governance: { dataClassification: "internal", requiredRegion: "us", processingRegion: "us", externalModelAllowed: true, mayLeaveTenantBoundary: true, consentId: "consent_a", consentActive: true }, allowedChangedPaths: ["src/api.ts"], criteria: [{ id: "correctness", title: "Correctness", description: "Correct.", hard: true, weight: 1 }], sources: [{ id: "tests", kind: "verification", digest: digest("tests"), locator: "tests", content: "Tests passed." }], checks: [{ id: "tests", status: "passed", evidenceRefs: ["tests"], candidateIds: null }], candidates: [{ candidateId: "candidate_a", artifactDigest: digest("candidate"), kind: "completion", observableOutput: "Candidate completed.", changedPaths: ["src/api.ts"], evidenceRefs: ["tests"], deterministicCheckIds: ["tests"], hardCriterionResults: [{ criterionId: "correctness", status: "passed", evidenceRefs: ["tests"] }] }], assembledAt: "2026-08-17T12:00:00.000Z", assemblerVersion: "test/1" }; }
async function telemetry() { const backend: VerifierBackend = { descriptor: { backendId: "deepseek", provider: "deepseek", model: "deepseek-v4-flash", backendRevision: "test", mode: "nonthinking_logprobs" }, score: async (request) => ({ requestId: request.requestId, criterionId: request.criterion.id, scores: { candidate_a: 0.9 }, rawResponseDigest: digest("response"), recognizedProbabilityMass: 1, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningTokens: 0, totalTokens: 12 }, estimatedCostUsd: 0.001, latencyMs: 2 }) }; return (await createAgentVerifier({ enabled: true, rolloutMode: "shadow", backend, evaluations: 1, pivots: 1, seed: 0, maximumCandidates: 5 }).verify({ pack: createVerifierEvidencePack(pack()), incumbentCandidateId: "candidate_a", verificationAttemptId: "attempt_a", observedAt: "2026-08-17T12:01:00.000Z" })).telemetry; }

describe("verifier telemetry persistence", () => {
  it("claims one durable shadow dispatch and prevents replayed model spend", () => {
    const db = setup();
    const input = { tenantId: "tenant_a", verificationAttemptId: "attempt_a", evidencePackDigest: digest("pack"), observedAt: "2026-08-17T12:01:00.000Z" };
    expect(claimVerifierShadowAttempt(db, input)).toBe(true);
    expect(claimVerifierShadowAttempt(db, input)).toBe(false);
    expect(listArtifactManifests(db, "tenant_a", "agent_verifier_dispatch_intent")).toHaveLength(1);
  });
  it("persists immutable soft telemetry as unknown evidence and replays exactly", async () => {
    const db = setup();
    const value = await telemetry();
    const first = persistVerifierTelemetry(db, { telemetry: value, producerPrincipalId: "worker_a" });
    const second = persistVerifierTelemetry(db, { telemetry: value, producerPrincipalId: "worker_a" });
    expect(second).toEqual(first);
    expect(listArtifactManifests(db, "tenant_a", "agent_verifier_telemetry")).toHaveLength(1);
    const evidence = listEvidenceRecords(db, "tenant_a", "agent_verifier_task", "task_a");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.verdict).toBe("unknown");
  });

  it("rejects tampering before any durable write", async () => {
    const db = setup();
    const value = await telemetry();
    expect(() => persistVerifierTelemetry(db, { telemetry: { ...value, candidateScores: { candidate_a: 0 } }, producerPrincipalId: "worker_a" })).toThrow("verifier_telemetry_digest_mismatch");
    expect(listArtifactManifests(db, "tenant_a", "agent_verifier_telemetry")).toHaveLength(0);
  });
});
