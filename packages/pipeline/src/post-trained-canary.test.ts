import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendDomainEvent, createDb, insertArtifactManifest, insertPrincipal, type AppDb } from "@mendpoint/db";
import { postTrainedCanaryResultDigest, runPostTrainedCanary, type PostTrainedCanaryResult } from "./post-trained-canary.js";

const roots: string[] = []; const dbs: AppDb[] = [];
const NOW = "2026-08-14T22:00:00.000Z";
const BYTES = Buffer.from("candidate");
const ADAPTER_DIGEST = `sha256:${createHash("sha256").update(BYTES).digest("hex")}`;
afterEach(() => { dbs.splice(0).forEach((db) => db.raw.close()); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
function artifact(db: AppDb, id: string, kind: string, content: string) { const sha256 = createHash("sha256").update(content).digest("hex"); insertArtifactManifest(db, { id, tenantId: "tenant-a", kind, schemaVersion: 1, sha256, mediaType: "application/json", sizeBytes: Buffer.byteLength(content), storageRef: `sqlite://${id}`, content, producerPrincipalId: "trainer", createdAt: NOW }); return { id, sha256 }; }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "post-trained-canary-")); roots.push(root); const db = createDb(join(root, "db.sqlite")); dbs.push(db);
  insertPrincipal(db, { id: "trainer", tenantId: "tenant-a", kind: "service", subject: "trainer", displayName: "Trainer", createdAt: NOW });
  insertPrincipal(db, { id: "evaluator", tenantId: "tenant-a", kind: "service", subject: "evaluator", displayName: "Evaluator", createdAt: NOW });
  insertPrincipal(db, { id: "canary", tenantId: "tenant-a", kind: "service", subject: "canary", displayName: "Canary", createdAt: NOW });
  const adapter = artifact(db, "adapter-artifact", "post_trained_adapter_artifact", JSON.stringify({ encoding: "base64", bytes: BYTES.toString("base64"), decodedSha256: ADAPTER_DIGEST }));
  const evaluation = artifact(db, "evaluation-artifact", "post_trained_independent_evaluation", JSON.stringify({ schemaVersion: 1, kind: "post_trained_independent_evaluation", evaluationId: "evaluation-a", trainingJobId: "job-a", candidate: { adapterId: "adapter-a", artifactDigest: ADAPTER_DIGEST }, passed: true, report: { successRate: .98, regressionRate: .01 } }));
  appendDomainEvent(db, { id: "training-complete", tenantId: "tenant-a", schemaVersion: 1, eventType: "post_trained_training.completed", aggregateType: "post_trained_training_job", aggregateId: "job-a", actorPrincipalId: "trainer", correlationId: "training", idempotencyKey: "training-complete", payload: { artifactId: adapter.id, adapterDigest: ADAPTER_DIGEST, datasetId: "dataset-a", completedAt: NOW }, createdAt: NOW });
  appendDomainEvent(db, { id: "evaluation-complete", tenantId: "tenant-a", schemaVersion: 1, eventType: "post_trained_evaluation.completed", aggregateType: "post_trained_evaluation", aggregateId: "evaluation-a", actorPrincipalId: "evaluator", correlationId: "evaluation", idempotencyKey: "evaluation-complete", payload: { artifactId: evaluation.id, trainingJobId: "job-a", adapterId: "adapter-a", passed: true, successRate: .98, regressionRate: .01, overlapCount: 0, completedAt: NOW }, createdAt: NOW });
  return db;
}
const input = { tenantId: "tenant-a", canaryId: "canary-a", adapterId: "adapter-a", trainingJobId: "job-a", evaluationId: "evaluation-a", actorPrincipalId: "canary", idempotencyKey: "canary-a", requestedAt: NOW, servingRevision: "serve-a", mode: "canary" as const, allocationPercent: 5, policy: { minimumSuccessRate: .95, maximumErrorRate: .02, maximumPolicyViolations: 0, maximumP95LatencyMs: 1000, maximumCostUsd: 1 } };
function result(passed = true): Extract<PostTrainedCanaryResult, { status: "completed" }> { return { status: "completed", report: { adapterId: "adapter-a", adapterDigest: ADAPTER_DIGEST, evaluationArtifactId: "evaluation-artifact", servingRevision: "serve-a", mode: "canary", allocationPercent: 5, sampleCount: 50, successRate: passed ? .98 : .5, errorRate: passed ? .01 : .5, policyViolationCount: 0, p95LatencyMs: 400, costUsd: .2, evidenceRefs: ["probe-evidence"] }, completedAt: NOW }; }
function dependencies(runner: Parameters<typeof runPostTrainedCanary>[2]["runner"]) { return { enabled: true, workerId: "canary-worker", authorityId: "canary-authority", timeoutMs: 1_000, leaseMs: 5_000, expected: { servingRevision: input.servingRevision, mode: input.mode, allocationPercent: input.allocationPercent, policy: input.policy }, runner, verifyReceipt: (receipt: { signature: string }) => receipt.signature === "signed" }; }

describe("post trained canary", () => {
  it("seals an exact bounded canary and replays without duplicate serving work", async () => {
    const db = fixture(); let calls = 0;
    const output = await runPostTrainedCanary(db, input, dependencies({ run: async (request) => { calls++; expect(request.adapter.contentBase64).toBe(BYTES.toString("base64")); const value = result(); return { result: value, receipt: { canaryId: request.canaryId, authorityId: request.authorityId, requestDigest: request.requestDigest, outcome: value.status, resultDigest: postTrainedCanaryResultDigest(value), observedAt: NOW, signature: "signed" } }; }, reconcile: async () => { throw new Error("duplicate"); } }));
    expect(output).toMatchObject({ status: "passed", adapterId: "adapter-a", servingRevision: "serve-a", mode: "canary" }); expect(calls).toBe(1);
    expect(await runPostTrainedCanary(db, input, dependencies({ run: async () => { throw new Error("duplicate"); }, reconcile: async () => { throw new Error("duplicate"); } }))).toEqual(output);
  });
  it("records a failed canary but never turns it into passing promotion evidence", async () => {
    const db = fixture(); const value = result(false);
    const output = await runPostTrainedCanary(db, { ...input, canaryId: "canary-failed", idempotencyKey: "canary-failed" }, dependencies({ run: async (request) => ({ result: value, receipt: { canaryId: request.canaryId, authorityId: request.authorityId, requestDigest: request.requestDigest, outcome: value.status, resultDigest: postTrainedCanaryResultDigest(value), observedAt: NOW, signature: "signed" } }), reconcile: async () => { throw new Error("unexpected"); } }));
    expect(output.status).toBe("failed");
  });
  it("requires signed safe to run reconciliation before redispatch and settles signed failures", async () => {
    const db = fixture(); let runs = 0; let reconciliations = 0;
    const safe = { status: "safe_to_run" as const };
    const retryDependencies = dependencies({
      run: async (request) => { runs++; if (runs === 1) throw new Error("response_lost"); const value = result(); return { result: value, receipt: { canaryId: request.canaryId, authorityId: request.authorityId, requestDigest: request.requestDigest, outcome: value.status, resultDigest: postTrainedCanaryResultDigest(value), observedAt: NOW, signature: "signed" } }; },
      reconcile: async (request) => { reconciliations++; return { result: safe, receipt: { canaryId: request.canaryId, authorityId: request.authorityId, requestDigest: request.requestDigest, outcome: safe.status, resultDigest: postTrainedCanaryResultDigest(safe), observedAt: NOW, signature: "signed" } }; },
    });
    await expect(runPostTrainedCanary(db, input, retryDependencies)).rejects.toThrow("response_lost");
    await expect(runPostTrainedCanary(db, input, retryDependencies)).resolves.toMatchObject({ status: "passed" });
    expect({ runs, reconciliations }).toEqual({ runs: 2, reconciliations: 1 });

    const failed = { status: "failed" as const, code: "serving_failed", evidenceRefs: ["probe://failure"], completedAt: NOW };
    const failedInput = { ...input, canaryId: "canary-terminal-failure", idempotencyKey: "canary-terminal-failure" };
    await expect(runPostTrainedCanary(db, failedInput, dependencies({ run: async (request) => ({ result: failed, receipt: { canaryId: request.canaryId, authorityId: request.authorityId, requestDigest: request.requestDigest, outcome: failed.status, resultDigest: postTrainedCanaryResultDigest(failed), observedAt: NOW, signature: "signed" } }), reconcile: async () => { throw new Error("unexpected"); } }))).resolves.toMatchObject({ status: "failed" });
  });
});
