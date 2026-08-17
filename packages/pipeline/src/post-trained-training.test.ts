import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, insertArtifactManifest, insertPrincipal } from "@mendpoint/db";
import { getPostTrainedTrainingJob, postTrainedReconciliationResultDigest, runPostTrainedTrainingJob, type PostTrainedReconciliation, type PostTrainedTrainerResolution } from "./post-trained-training.js";

const dirs: string[] = []; const dbs: ReturnType<typeof createDb>[] = [];
afterEach(() => { dbs.splice(0).forEach((db) => db.raw.close()); dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
function fixture() { const dir = mkdtempSync(join(tmpdir(), "post-trained-training-")); dirs.push(dir); const path = join(dir, "db.sqlite"); const db = createDb(path); dbs.push(db); insertPrincipal(db, { id: "actor", tenantId: "tenant", kind: "service", subject: "trainer", displayName: "Trainer", createdAt: "2026-08-12T12:00:00.000Z" }); const add = (id: string, kind: string, split: string) => { const content = JSON.stringify({ tenantId: "tenant", datasetVersionId: "dataset", datasetSplit: split, splitManifestDigest: "a".repeat(64), examples: [{ sourceEventId: `${split}-event`, sourceEventDigest: "b".repeat(64), specialization: { splitGroupId: `${split}-group` }, datasetSplit: split }] }); const sha256 = createHash("sha256").update(content).digest("hex"); insertArtifactManifest(db, { id, tenantId: "tenant", kind, schemaVersion: 1, sha256, mediaType: "application/json", sizeBytes: Buffer.byteLength(content), storageRef: `sqlite://${id}`, content, producerPrincipalId: "actor", createdAt: "2026-08-12T12:00:00.000Z" }); }; add("corpus", "learning_dataset_corpus", "train"); add("validation", "learning_dataset_validation", "validation"); add("holdout", "learning_dataset_holdout", "holdout"); return { db, path }; }
const input = { tenantId: "tenant", jobId: "job-1", adapterId: "adapter-1", actorPrincipalId: "actor", idempotencyKey: "train-1", submittedAt: "2026-08-12T12:00:01.000Z", baseModelId: "base-1", datasetId: "dataset", purpose: "adapter_training", residencyRegion: "local", trainingCorpusArtifactIds: ["corpus"], validationArtifactId: "validation", holdoutArtifactId: "holdout", splitManifestDigest: "a".repeat(64), recipe: { epochs: 1, maximumExamples: 10, seed: 7 } } as const;
const completion = { status: "completed", adapterBase64: Buffer.from("local-adapter-weights").toString("base64"), evidenceRefs: ["training://job-1"], completedAt: "2026-08-12T12:00:02.000Z" } as const;
function exchange(request: { tenantId: string; jobId: string; requestDigest: string; leaseGeneration: number; authorityId?: string }, result: PostTrainedTrainerResolution = completion): PostTrainedReconciliation { return { result, receipt: { tenantId: request.tenantId, jobId: request.jobId, requestDigest: request.requestDigest, leaseGeneration: request.leaseGeneration, authorityId: request.authorityId ?? "trainer-authority", outcome: result.status, resultDigest: postTrainedReconciliationResultDigest(result), observedAt: "2026-08-12T12:00:03.000Z", signature: "test-signature" } }; }
function deps(trainer: any, workerId = "worker-1") { return { enabled: true as const, timeoutMs: 1000, leaseMs: 5000, workerId, processingBoundary: "tenant_local" as const, authorityId: "trainer-authority", authorizeDataset: () => true, verifyReconciliation: (receipt: { signature: string }) => receipt.signature === "test-signature", trainer }; }

describe("post trained training workflow", () => {
  it("selects authoritative corpus, invokes the trainer once, and persists canonical decoded adapter bytes", async () => {
    const { db } = fixture(); let calls = 0;
    const runtime = deps({ train: async (request: any) => { calls++; expect(request.corpus).toHaveLength(1); expect(request.corpus[0].artifactId).toBe("corpus"); expect(request.corpus[0].content).not.toContain("holdout-event"); return exchange(request); }, reconcile: async () => { throw new Error("unexpected_reconcile"); } });
    const result = await runPostTrainedTrainingJob(db, input, runtime);
    expect(result.status).toBe("completed"); expect(result).not.toHaveProperty("evaluation"); expect(result).not.toHaveProperty("canary"); expect(calls).toBe(1);
    expect(await runPostTrainedTrainingJob(db, input, runtime)).toEqual(result); expect(calls).toBe(1);
    const artifact = db.raw.prepare("SELECT content_text, media_type FROM artifact_manifests WHERE id = ?").get(result.adapterArtifactId!) as { content_text: string; media_type: string };
    const stored = JSON.parse(artifact.content_text); expect(Buffer.from(stored.bytes, "base64").toString()).toBe("local-adapter-weights"); expect(stored.decodedSha256).toBe(result.adapterDigest); expect(artifact.media_type).toContain("adapter-bytes");
  });

  it("requires distinct nonempty validation and holdout authority", async () => {
    const { db } = fixture();
    const trainer = { train: async () => { throw new Error("unexpected"); }, reconcile: async () => { throw new Error("unexpected"); } };
    await expect(runPostTrainedTrainingJob(db, { ...input, holdoutArtifactId: "corpus" }, deps(trainer)))
      .rejects.toThrow("post_trained_training_input_invalid");
    await expect(runPostTrainedTrainingJob(db, { ...input, holdoutArtifactId: "missing" }, deps(trainer)))
      .rejects.toThrow("post_trained_training_holdout_not_authoritative");
  });

  it("is default off and rejects noncanonical adapter base64 before settlement", async () => {
    const { db } = fixture();
    await expect(runPostTrainedTrainingJob(db, input, { ...deps({}), enabled: false })).rejects.toThrow("post_trained_training_disabled");
    const bad = { ...completion, adapterBase64: "d2VpZ2h0cw" };
    await expect(runPostTrainedTrainingJob(db, input, deps({ train: async (request: any) => exchange(request, bad), reconcile: async () => { throw new Error("unexpected"); } }))).rejects.toThrow("post_trained_training_result_invalid");
    expect(getPostTrainedTrainingJob(db, "tenant", "job-1")?.status).toBe("submitted");
  });

  it("reconciles an authenticated lost response without dispatching twice, including after database reopen", async () => {
    const { db, path } = fixture(); let runs = 0;
    await expect(runPostTrainedTrainingJob(db, input, deps({ train: async () => { runs++; throw new Error("lost_response"); }, reconcile: async (request: any) => exchange(request) }))).rejects.toThrow("lost_response");
    db.raw.close(); dbs.splice(dbs.indexOf(db), 1); const reopened = createDb(path); dbs.push(reopened);
    const result = await runPostTrainedTrainingJob(reopened, input, deps({ train: async () => { runs++; throw new Error("duplicate"); }, reconcile: async (request: any) => exchange(request) }));
    expect(result.status).toBe("completed"); expect(runs).toBe(1);
  });

  it("rejects unauthenticated or incorrectly bound reconciliation claims", async () => {
    const { db } = fixture();
    await expect(runPostTrainedTrainingJob(db, input, deps({ train: async (request: any) => ({ ...exchange(request), receipt: { ...exchange(request).receipt, requestDigest: "wrong" } }), reconcile: async () => { throw new Error("unexpected"); } }))).rejects.toThrow("post_trained_training_receipt_invalid");
    expect(getPostTrainedTrainingJob(db, "tenant", "job-1")?.status).toBe("submitted");
  });

  it("allows only one dispatcher across two database handles", async () => {
    const { db, path } = fixture(); const second = createDb(path); dbs.push(second); let release!: (value: PostTrainedReconciliation) => void; let calls = 0;
    const held = new Promise<PostTrainedReconciliation>((resolve) => { release = resolve; });
    const first = runPostTrainedTrainingJob(db, input, deps({ train: async () => { calls++; return held; }, reconcile: async () => { throw new Error("unexpected"); } }, "worker-a"));
    await Promise.resolve();
    await expect(runPostTrainedTrainingJob(second, input, deps({ train: async () => { calls++; return exchange({ tenantId: "tenant", jobId: "job-1", requestDigest: "unused", leaseGeneration: 1 }); }, reconcile: async () => { throw new Error("unexpected"); } }, "worker-b"))).rejects.toThrow("post_trained_training_lease_held");
    const row = db.raw.prepare("SELECT request_digest, lease_generation FROM post_trained_training_effects WHERE tenant_id = 'tenant' AND job_id = 'job-1'").get() as { request_digest: string; lease_generation: number };
    release(exchange({ tenantId: "tenant", jobId: "job-1", requestDigest: row.request_digest, leaseGeneration: row.lease_generation }));
    expect((await first).status).toBe("completed"); expect(calls).toBe(1);
  });

  it("allows only one dispatcher for concurrent requests sharing one worker id", async () => {
    const { db, path } = fixture(); const second = createDb(path); dbs.push(second); let release!: (value: PostTrainedReconciliation) => void; let calls = 0;
    const held = new Promise<PostTrainedReconciliation>((resolve) => { release = resolve; });
    const first = runPostTrainedTrainingJob(db, input, deps({ train: async () => { calls++; return held; }, reconcile: async () => exchange({ tenantId: "tenant", jobId: "job-1", requestDigest: "unused", leaseGeneration: 1 }, { status: "safe_to_run" }) }, "worker-shared"));
    await Promise.resolve();
    await expect(runPostTrainedTrainingJob(second, input, deps({ train: async () => { calls++; return exchange({ tenantId: "tenant", jobId: "job-1", requestDigest: "unused", leaseGeneration: 1 }); }, reconcile: async () => exchange({ tenantId: "tenant", jobId: "job-1", requestDigest: "unused", leaseGeneration: 1 }, { status: "safe_to_run" }) }, "worker-shared"))).rejects.toThrow("post_trained_training_lease_held");
    const row = db.raw.prepare("SELECT request_digest, lease_generation FROM post_trained_training_effects WHERE tenant_id = 'tenant' AND job_id = 'job-1'").get() as { request_digest: string; lease_generation: number };
    release(exchange({ tenantId: "tenant", jobId: "job-1", requestDigest: row.request_digest, leaseGeneration: row.lease_generation }));
    expect((await first).status).toBe("completed"); expect(calls).toBe(1);
  });

  it("fences a stale terminal writer after database-time takeover", async () => {
    const { db, path } = fixture(); const second = createDb(path); dbs.push(second); let release!: (value: PostTrainedReconciliation) => void;
    const held = new Promise<PostTrainedReconciliation>((resolve) => { release = resolve; });
    const stale = runPostTrainedTrainingJob(db, input, deps({ train: async () => held, reconcile: async () => { throw new Error("unexpected"); } }, "worker-a"));
    await Promise.resolve();
    const row = db.raw.prepare("SELECT request_digest FROM post_trained_training_effects WHERE tenant_id = 'tenant' AND job_id = 'job-1'").get() as { request_digest: string };
    db.raw.prepare("UPDATE post_trained_training_effects SET lease_expires_at_ms = 0").run();
    const winner = await runPostTrainedTrainingJob(second, input, deps({ train: async () => { throw new Error("duplicate"); }, reconcile: async (request: any) => exchange(request) }, "worker-b"));
    expect(winner.status).toBe("completed");
    release(exchange({ tenantId: "tenant", jobId: "job-1", requestDigest: row.request_digest, leaseGeneration: 1 }));
    await expect(stale).rejects.toThrow("post_trained_training_lease_lost");
    expect(getPostTrainedTrainingJob(db, "tenant", "job-1")?.adapterDigest).toBe(winner.adapterDigest);
  });
});
