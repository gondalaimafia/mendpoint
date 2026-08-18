import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendDomainEvent, createDb, insertArtifactManifest, insertPrincipal, type AppDb } from "@mendpoint/db";
import {
  postTrainedEvaluationResultDigest,
  runPostTrainedIndependentEvaluation,
  type PostTrainedEvaluationInput,
  type PostTrainedEvaluationResult,
} from "./post-trained-evaluation.js";

const roots: string[] = [];
const dbs: AppDb[] = [];
const NOW = "2026-08-14T21:00:00.000Z";
const CANDIDATE_BYTES = Buffer.from("candidate-adapter");
const CANDIDATE_DIGEST = `sha256:${createHash("sha256").update(CANDIDATE_BYTES).digest("hex")}`;
function corpusContent(split: "train" | "holdout", scenarioId: string | null): string {
  const isTrain = split === "train";
  return JSON.stringify({
    datasetSplit: split, splitManifestDigest: "a".repeat(64), examples: [{
      sourceEventId: isTrain ? "train-event" : "holdout-event",
      task: {
        repositoryId: "repository-a",
        scenarioId,
        sourceRevision: (isTrain ? "1" : "3").repeat(40),
        sourceDigest: `sha256:${(isTrain ? "2" : "4").repeat(64)}`,
      },
    }],
  });
}
const HOLDOUT_CONTENT = corpusContent("holdout", "scenario-holdout");
const HOLDOUT_SHA = createHash("sha256").update(HOLDOUT_CONTENT).digest("hex");
const PRODUCTION_HOLDOUT_CONTENT = corpusContent("holdout", null);
const PRODUCTION_HOLDOUT_SHA = createHash("sha256").update(PRODUCTION_HOLDOUT_CONTENT).digest("hex");
const VALIDATION_CONTENT = JSON.stringify({
  datasetSplit: "validation", splitManifestDigest: "a".repeat(64), examples: [],
});

afterEach(() => {
  while (dbs.length) dbs.pop()!.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifact(db: AppDb, id: string, kind: string, content: string) {
  return insertArtifactManifest(db, {
    id, tenantId: "tenant-a", kind, schemaVersion: 1, sha256: digest(content),
    mediaType: "application/json", sizeBytes: Buffer.byteLength(content),
    storageRef: `sqlite://${id}`, content, producerPrincipalId: "actor", createdAt: NOW,
  }).row;
}

function fixture(production = false) {
  const root = mkdtempSync(join(tmpdir(), "post-trained-independent-eval-"));
  roots.push(root);
  const db = createDb(join(root, "app.sqlite"));
  dbs.push(db);
  insertPrincipal(db, { id: "actor", tenantId: "tenant-a", kind: "service", subject: "eval", displayName: "Evaluator", createdAt: NOW });
  insertPrincipal(db, { id: "evaluator", tenantId: "tenant-a", kind: "service", subject: "independent-eval", displayName: "Independent Evaluator", createdAt: NOW });
  const adapter = artifact(db, "adapter-artifact", "post_trained_adapter_artifact", JSON.stringify({ encoding: "base64", bytes: CANDIDATE_BYTES.toString("base64"), decodedSha256: CANDIDATE_DIGEST }));
  const train = artifact(db, "train-artifact", "learning_dataset_corpus", corpusContent("train", production ? null : "scenario-train"));
  const validation = artifact(db, "validation-artifact", "learning_dataset_validation", VALIDATION_CONTENT);
  const holdout = artifact(db, "holdout-artifact", "learning_dataset_holdout", production ? PRODUCTION_HOLDOUT_CONTENT : HOLDOUT_CONTENT);
  appendDomainEvent(db, {
    id: "training-submitted", tenantId: "tenant-a", schemaVersion: 1,
    eventType: "post_trained_training.submitted", aggregateType: "post_trained_training_job", aggregateId: "job-a",
    actorPrincipalId: "actor", correlationId: "training-a", idempotencyKey: "training-a:submitted",
    payload: { requestDigest: "5".repeat(64), authorityId: "trainer-authority", adapterId: "adapter-a", baseModelId: "base-a", datasetId: "dataset-a", purpose: "adapter_training", residencyRegion: "local", splitManifestDigest: "a".repeat(64), trainingCorpus: [{ artifactId: train.id, sha256: train.sha256 }], validation: { artifactId: validation.id, sha256: validation.sha256 }, holdout: { artifactId: holdout.id, sha256: holdout.sha256 } },
    createdAt: NOW,
  });
  appendDomainEvent(db, {
    id: "training-completed", tenantId: "tenant-a", schemaVersion: 1,
    eventType: "post_trained_training.completed", aggregateType: "post_trained_training_job", aggregateId: "job-a",
    actorPrincipalId: "actor", correlationId: "training-a", idempotencyKey: "training-a:completed",
    payload: { requestDigest: "5".repeat(64), authorityId: "trainer-authority", artifactId: adapter.id, adapterDigest: CANDIDATE_DIGEST, datasetId: "dataset-a", completedAt: NOW },
    createdAt: NOW,
  });
  return db;
}

const input: PostTrainedEvaluationInput = {
  tenantId: "tenant-a", evaluationId: "evaluation-a", trainingJobId: "job-a", adapterId: "adapter-a",
  actorPrincipalId: "evaluator", idempotencyKey: "evaluation-a", requestedAt: NOW,
  baseline: { executorId: "baseline-a", revision: "7".repeat(40) },
  evaluator: { harnessVersion: "harness-v1", graderVersion: "grader-v1" },
  policy: { minimumSuccessRate: 0.9, maximumRegressionRate: 0.02, maximumSecurityRegressions: 0 },
};

function result(overlapCount = 0, holdoutSha = HOLDOUT_SHA): Extract<PostTrainedEvaluationResult, { status: "completed" }> {
  return {
    status: "completed",
    report: {
      candidateAdapterId: "adapter-a", candidateArtifactDigest: CANDIDATE_DIGEST,
      baselineExecutorId: "baseline-a", baselineRevision: "7".repeat(40),
      cohortId: "holdout-artifact", cohortRevision: holdoutSha.slice(0, 40), cohortDigest: `sha256:${holdoutSha}`,
      split: "holdout", harnessVersion: "harness-v1", graderVersion: "grader-v1",
      trainingDatasetId: "dataset-a", trainingSplitManifestDigest: "a".repeat(64),
      taskCount: 1, successRate: 1, regressionRate: 0, securityRegressionCount: 0,
      overlapCheck: { comparedScenarioCount: 2, overlapCount },
      evidenceRefs: ["eval-evidence-a"],
    },
    completedAt: NOW,
  };
}

function dependencies(evaluator: {
  evaluate: Parameters<typeof runPostTrainedIndependentEvaluation>[2]["evaluator"]["evaluate"];
  reconcile: Parameters<typeof runPostTrainedIndependentEvaluation>[2]["evaluator"]["reconcile"];
}) {
  return {
    enabled: true,
    timeoutMs: 1_000,
    leaseMs: 5_000,
    workerId: "evaluation-worker",
    authorityId: "evaluation-authority",
    processingBoundary: "tenant_local" as const,
    expected: { baseline: input.baseline, evaluator: input.evaluator, policy: input.policy },
    evaluator,
    verifyReceipt: (receipt: { signature: string }) => receipt.signature === "signed",
    authorizeDataset: () => true,
  };
}

describe("independent post trained evaluation", () => {
  it("seals an independently produced zero overlap holdout report", async () => {
    const db = fixture();
    let calls = 0;
    const output = await runPostTrainedIndependentEvaluation(db, input, dependencies({ evaluate: async (request) => {
          calls++;
          expect(request.authorityId).toBe("evaluation-authority");
          expect(request.candidate.contentBase64).toBe(CANDIDATE_BYTES.toString("base64"));
          expect(request.holdout.content).toContain("scenario-holdout");
          expect(request.training.some((item) => item.content.includes("scenario-holdout"))).toBe(false);
          const value = result();
          return { result: value, receipt: { evaluationId: request.evaluationId, authorityId: request.authorityId, requestDigest: request.requestDigest, outcome: value.status, resultDigest: postTrainedEvaluationResultDigest(value), observedAt: NOW, signature: "signed" } };
        }, reconcile: async () => { throw new Error("unexpected_reconcile"); } }));
    expect(output).toMatchObject({ status: "passed", successRate: 1, regressionRate: 0, overlapCount: 0 });
    expect(calls).toBe(1);
    expect((await runPostTrainedIndependentEvaluation(db, input, dependencies({ evaluate: async () => { throw new Error("duplicate"); }, reconcile: async () => { throw new Error("duplicate"); } })))).toEqual(output);
  });

  it("evaluates production verified corpus examples without synthetic scenario identifiers", async () => {
    const db = fixture(true);
    let calls = 0;
    await expect(runPostTrainedIndependentEvaluation(db, {
      ...input,
      evaluationId: "evaluation-production",
      idempotencyKey: "evaluation-production",
    }, dependencies({
      evaluate: async (request) => {
        calls++;
        const value = result(0, PRODUCTION_HOLDOUT_SHA);
        return {
          result: value,
          receipt: {
            evaluationId: request.evaluationId,
            authorityId: request.authorityId,
            requestDigest: request.requestDigest,
            outcome: value.status,
            resultDigest: postTrainedEvaluationResultDigest(value),
            observedAt: NOW,
            signature: "signed",
          },
        };
      },
      reconcile: async () => { throw new Error("unexpected_reconcile"); },
    }))).resolves.toMatchObject({ status: "passed" });
    expect(calls).toBe(1);
  });

  it("rejects trainer overlap and forged candidate bindings before lifecycle admission", async () => {
    const db = fixture();
    const run = (value: PostTrainedEvaluationResult, selectedInput = input) => runPostTrainedIndependentEvaluation(db, selectedInput, dependencies({
      evaluate: async (request) => ({ result: value, receipt: { evaluationId: request.evaluationId, authorityId: request.authorityId, requestDigest: request.requestDigest, outcome: value.status, resultDigest: postTrainedEvaluationResultDigest(value), observedAt: NOW, signature: "signed" } }),
      reconcile: async () => { throw new Error("unexpected_reconcile"); },
    }));
    await expect(run(result(1))).rejects.toThrow("post_trained_evaluation_overlap_detected");
    const valid = result();
    const forged = { ...valid, report: { ...valid.report, candidateAdapterId: "adapter-other" } };
    await expect(run(forged, { ...input, evaluationId: "evaluation-forged", idempotencyKey: "evaluation-forged" }))
      .rejects.toThrow("post_trained_evaluation_binding_mismatch");
  });

  it("reconciles an exact evaluator result after response loss without a second evaluation", async () => {
    const db = fixture(); let evaluations = 0; let reconciliations = 0;
    const evaluatorDependencies = dependencies({
        evaluate: async () => { evaluations++; throw new Error("response_lost"); },
        reconcile: async (request) => { reconciliations++; const value = result(); return { result: value, receipt: { evaluationId: request.evaluationId, authorityId: request.authorityId, requestDigest: request.requestDigest, outcome: value.status, resultDigest: postTrainedEvaluationResultDigest(value), observedAt: NOW, signature: "signed" } }; },
    });
    await expect(runPostTrainedIndependentEvaluation(db, input, evaluatorDependencies)).rejects.toThrow("response_lost");
    const completed = await runPostTrainedIndependentEvaluation(db, input, evaluatorDependencies);
    expect(completed.status).toBe("passed"); expect(evaluations).toBe(1); expect(reconciliations).toBe(1);
  });

  it("redispatches only after a signed safe to run reconciliation receipt", async () => {
    const db = fixture(); let evaluations = 0; let reconciliations = 0;
    const safe = { status: "safe_to_run" as const };
    const evaluatorDependencies = dependencies({
      evaluate: async (request) => {
        evaluations++;
        if (evaluations === 1) throw new Error("crash_before_send");
        const value = result();
        return { result: value, receipt: { evaluationId: request.evaluationId, authorityId: request.authorityId, requestDigest: request.requestDigest, outcome: value.status, resultDigest: postTrainedEvaluationResultDigest(value), observedAt: NOW, signature: "signed" } };
      },
      reconcile: async (request) => {
        reconciliations++;
        return { result: safe, receipt: { evaluationId: request.evaluationId, authorityId: request.authorityId, requestDigest: request.requestDigest, outcome: safe.status, resultDigest: postTrainedEvaluationResultDigest(safe), observedAt: NOW, signature: "signed" } };
      },
    });
    await expect(runPostTrainedIndependentEvaluation(db, input, evaluatorDependencies)).rejects.toThrow("crash_before_send");
    await expect(runPostTrainedIndependentEvaluation(db, input, evaluatorDependencies)).resolves.toMatchObject({ status: "passed" });
    expect({ evaluations, reconciliations }).toEqual({ evaluations: 2, reconciliations: 1 });
  });

  it("settles signed evaluator failures and blocks an unauthorized processing boundary", async () => {
    const db = fixture(); let calls = 0;
    const failed = { status: "failed" as const, code: "grader_failed", evidenceRefs: ["evaluation://failure"], completedAt: NOW };
    const failedDependencies = dependencies({
      evaluate: async (request) => { calls++; return { result: failed, receipt: { evaluationId: request.evaluationId, authorityId: request.authorityId, requestDigest: request.requestDigest, outcome: failed.status, resultDigest: postTrainedEvaluationResultDigest(failed), observedAt: NOW, signature: "signed" } }; },
      reconcile: async () => { throw new Error("unexpected_reconcile"); },
    });
    await expect(runPostTrainedIndependentEvaluation(db, input, failedDependencies)).resolves.toMatchObject({ status: "failed", successRate: 0, regressionRate: 1 });
    expect(calls).toBe(1);

    const deniedInput = { ...input, evaluationId: "evaluation-denied", idempotencyKey: "evaluation-denied" };
    const deniedDependencies = { ...dependencies({ evaluate: async () => { calls++; throw new Error("must_not_run"); }, reconcile: async () => { throw new Error("must_not_run"); } }), processingBoundary: "external" as const, authorizeDataset: () => false };
    await expect(runPostTrainedIndependentEvaluation(db, deniedInput, deniedDependencies)).rejects.toThrow("post_trained_evaluation_dataset_unauthorized");
    expect(calls).toBe(1);
  });

  it("rejects malformed signed evaluation failures before settlement", async () => {
    const db = fixture();
    const malformed = { status: "failed" as const, code: "", evidenceRefs: [], completedAt: "2026-08-14T21:00:00Z" };
    await expect(runPostTrainedIndependentEvaluation(db, { ...input, evaluationId: "evaluation-malformed", idempotencyKey: "evaluation-malformed" }, dependencies({
      evaluate: async (request) => ({ result: malformed, receipt: { evaluationId: request.evaluationId, authorityId: request.authorityId, requestDigest: request.requestDigest, outcome: malformed.status, resultDigest: postTrainedEvaluationResultDigest(malformed), observedAt: NOW, signature: "signed" } }),
      reconcile: async () => { throw new Error("unexpected"); },
    }))).rejects.toThrow("post_trained_evaluation_result_invalid");
  });
});
