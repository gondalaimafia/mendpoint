import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimNextJob,
  createDb,
  enqueueJob,
  failJob,
  retryJob,
  type AppDb,
} from "@mendpoint/db";
import { createWardenCheckpointJobJournal } from "./warden-checkpoint-journal.js";

const roots: string[] = [];
const databases: AppDb[] = [];
const NOW = "2026-08-12T12:00:00.000Z";

afterEach(() => {
  while (databases.length) databases.pop()!.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(): Readonly<{
  dbPath: string;
  db: AppDb;
  jobId: string;
  workerId: string;
  leaseGeneration: number;
}> {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-warden-checkpoint-"));
  roots.push(root);
  const dbPath = join(root, "app.db");
  const db = createDb(dbPath);
  databases.push(db);
  const jobId = "job-warden-checkpoint";
  const workerId = "worker-a";
  enqueueJob(db, {
    id: jobId,
    tenantId: "tenant-a",
    type: "agent.run",
    payload: { goal: "repair the API client" },
    createdAt: NOW,
  });
  const job = claimNextJob(db, ["agent.run"], {
    tenantId: "tenant-a",
    workerId,
    leaseMs: 60_000,
    now: NOW,
  });
  if (!job) throw new Error("test_job_not_claimed");
  return { dbPath, db, jobId, workerId, leaseGeneration: job.lease_generation };
}

const binding = Object.freeze({
  schemaVersion: 1 as const,
  tenantId: "tenant-a",
  jobId: "job-warden-checkpoint",
  attemptId: "job-warden-checkpoint",
  repositoryId: "repository-a",
  snapshotId: "snapshot-a",
  revision: "a".repeat(40),
  sourceManifestSha256: `sha256:${"b".repeat(64)}`,
  allowedPathsDigest: `sha256:${"c".repeat(64)}`,
  verificationProfileDigest: `sha256:${"d".repeat(64)}`,
  modelPolicyDigest: `sha256:${"e".repeat(64)}`,
});

const nextEnvelope = Object.freeze({
  schemaVersion: 1 as const,
  algorithm: "HMAC-SHA256" as const,
  payload: Object.freeze({
    schemaVersion: 1 as const,
    binding,
    generation: 1,
    writerLeaseGeneration: 1,
    workspaceName: "job-warden-checkpoint-workspace",
    workspaceDigest: `sha256:${"f".repeat(64)}`,
    runtimeStateCommitment: `hmac-sha256:${"1".repeat(64)}`,
    phase: "agent_running" as const,
    nextStep: 0,
    steps: Object.freeze([]),
    sourceEvidence: Object.freeze([]),
    observedDirectories: Object.freeze([]),
    searchDigests: Object.freeze([]),
    changedFiles: Object.freeze([]),
    actionFingerprints: Object.freeze([]),
    counters: Object.freeze({
      mutationCount: 0,
      toolCalls: 0,
      verifierCalls: 0,
      modelCalls: 0,
      modelSuccessfulCalls: 0,
      modelFailedCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      observedBytes: 0,
      searchBytes: 0,
      changedBytes: 0,
      groundedMutations: 0,
      blockedMutations: 0,
    }),
    previousEnvelopeDigest: null,
    createdAt: NOW,
  }),
  payloadDigest: `hmac-sha256:${"2".repeat(64)}`,
  authenticationTag: "tag-a",
});

const nextSealedRuntimeState = Object.freeze({
  schemaVersion: 1 as const,
  algorithm: "AES-256-GCM" as const,
  runtimeSchemaVersion: 1 as const,
  codec: "opaque-bytes-v1" as const,
  keyId: `wdrt_${"3".repeat(24)}`,
  checkpointPayloadDigest: nextEnvelope.payloadDigest,
  runtimeStateCommitment: nextEnvelope.payload.runtimeStateCommitment,
  plaintextBytes: 64,
  nonce: "nonce-a",
  ciphertext: "ciphertext-a",
  authenticationTag: "tag-b",
});

const terminalEnvelope = Object.freeze({
  ...nextEnvelope,
  payload: Object.freeze({
    ...nextEnvelope.payload,
    generation: 2,
    phase: "terminal" as const,
    previousEnvelopeDigest: nextEnvelope.payloadDigest,
    runtimeStateCommitment: `hmac-sha256:${"4".repeat(64)}`,
  }),
  payloadDigest: `hmac-sha256:${"5".repeat(64)}`,
  authenticationTag: "tag-terminal",
});

const terminalSealedRuntimeState = Object.freeze({
  ...nextSealedRuntimeState,
  checkpointPayloadDigest: terminalEnvelope.payloadDigest,
  runtimeStateCommitment: terminalEnvelope.payload.runtimeStateCommitment,
  ciphertext: "ciphertext-terminal",
  authenticationTag: "tag-terminal-sealed",
});

describe("Warden checkpoint job journal", () => {
  it("persists the exact checkpoint head across a database reopen", async () => {
    const value = fixture();
    const journal = createWardenCheckpointJobJournal({
      db: value.db,
      tenantId: binding.tenantId,
      jobId: value.jobId,
      workerId: value.workerId,
      leaseGeneration: value.leaseGeneration,
      now: () => NOW,
    });

    expect(await journal.read(binding)).toEqual({
      envelope: null,
      sealedRuntimeState: null,
      activeWriterLeaseGeneration: 1,
    });
    expect(await journal.compareAndSwap({
      binding,
      expectedPayloadDigest: null,
      expectedActiveWriterLeaseGeneration: 1,
      nextEnvelope,
      nextSealedRuntimeState,
    })).toBe(true);

    value.db.raw.close();
    databases.pop();
    const reopened = createDb(value.dbPath);
    databases.push(reopened);
    const successor = createWardenCheckpointJobJournal({
      db: reopened,
      tenantId: binding.tenantId,
      jobId: value.jobId,
      workerId: value.workerId,
      leaseGeneration: value.leaseGeneration,
      now: () => NOW,
    });
    expect(await successor.read(binding)).toEqual({
      envelope: nextEnvelope,
      sealedRuntimeState: nextSealedRuntimeState,
      activeWriterLeaseGeneration: 1,
    });
  });

  it("allows exactly one writer to advance a shared expected head", async () => {
    const value = fixture();
    const left = createWardenCheckpointJobJournal({
      db: value.db,
      tenantId: binding.tenantId,
      jobId: value.jobId,
      workerId: value.workerId,
      leaseGeneration: value.leaseGeneration,
      now: () => NOW,
    });
    const right = createWardenCheckpointJobJournal({
      db: value.db,
      tenantId: binding.tenantId,
      jobId: value.jobId,
      workerId: value.workerId,
      leaseGeneration: value.leaseGeneration,
      now: () => NOW,
    });

    expect(await left.compareAndSwap({
      binding,
      expectedPayloadDigest: null,
      expectedActiveWriterLeaseGeneration: 1,
      nextEnvelope,
      nextSealedRuntimeState,
    })).toBe(true);
    expect(await right.compareAndSwap({
      binding,
      expectedPayloadDigest: null,
      expectedActiveWriterLeaseGeneration: 1,
      nextEnvelope,
      nextSealedRuntimeState,
    })).toBe(false);
  });

  it("lets a successor lease resume the prior head and fences the old writer", async () => {
    const value = fixture();
    const oldJournal = createWardenCheckpointJobJournal({
      db: value.db,
      tenantId: binding.tenantId,
      jobId: value.jobId,
      workerId: value.workerId,
      leaseGeneration: value.leaseGeneration,
      now: () => NOW,
    });
    expect(await oldJournal.compareAndSwap({
      binding,
      expectedPayloadDigest: null,
      expectedActiveWriterLeaseGeneration: 1,
      nextEnvelope,
      nextSealedRuntimeState,
    })).toBe(true);

    const failedAt = "2026-08-12T12:00:10.000Z";
    expect(failJob(value.db, value.jobId, "worker_crash", failedAt, {
      workerId: value.workerId,
      leaseGeneration: value.leaseGeneration,
      errorCode: "worker_crash",
      baseDelayMs: 1_000,
    }).applied).toBe(true);
    const successorJob = claimNextJob(value.db, ["agent.run"], {
      tenantId: binding.tenantId,
      workerId: "worker-b",
      leaseMs: 60_000,
      now: "2026-08-12T12:00:11.000Z",
    });
    expect(successorJob?.lease_generation).toBe(2);
    const successor = createWardenCheckpointJobJournal({
      db: value.db,
      tenantId: binding.tenantId,
      jobId: value.jobId,
      workerId: "worker-b",
      leaseGeneration: 2,
      now: () => "2026-08-12T12:00:11.000Z",
    });

    expect(await successor.read(binding)).toEqual({
      envelope: nextEnvelope,
      sealedRuntimeState: nextSealedRuntimeState,
      activeWriterLeaseGeneration: 2,
    });
    await expect(oldJournal.read(binding)).rejects.toThrow("warden_checkpoint_job_stale");
  });

  it("resumes the checkpoint after a dead-letter is retried (defect 3)", async () => {
    const value = fixture();
    const original = createWardenCheckpointJobJournal({
      db: value.db,
      tenantId: binding.tenantId,
      jobId: value.jobId,
      workerId: value.workerId,
      leaseGeneration: value.leaseGeneration,
      now: () => NOW,
    });
    expect(await original.compareAndSwap({
      binding,
      expectedPayloadDigest: null,
      expectedActiveWriterLeaseGeneration: 1,
      nextEnvelope,
      nextSealedRuntimeState,
    })).toBe(true);

    // Force a permanent dead-letter, then recover through the sole retry endpoint.
    expect(failJob(value.db, value.jobId, "model_rate_limited", "2026-08-12T12:00:10.000Z", {
      workerId: value.workerId,
      leaseGeneration: value.leaseGeneration,
      errorCode: "warden_model_transient_error",
      retryable: false,
    }).applied).toBe(true);
    expect(retryJob(value.db, value.jobId, {
      tenantId: binding.tenantId,
      now: "2026-08-12T12:00:11.000Z",
    })).toBe(true);

    // A re-claim bumps the lease generation and the resumed head is intact, so the
    // run continues from the checkpoint instead of restarting from zero.
    const successorJob = claimNextJob(value.db, ["agent.run"], {
      tenantId: binding.tenantId,
      workerId: "worker-b",
      leaseMs: 60_000,
      now: "2026-08-12T12:00:12.000Z",
    });
    expect(successorJob?.lease_generation).toBe(2);
    const successor = createWardenCheckpointJobJournal({
      db: value.db,
      tenantId: binding.tenantId,
      jobId: value.jobId,
      workerId: "worker-b",
      leaseGeneration: 2,
      now: () => "2026-08-12T12:00:12.000Z",
    });
    expect(await successor.read(binding)).toEqual({
      envelope: nextEnvelope,
      sealedRuntimeState: nextSealedRuntimeState,
      activeWriterLeaseGeneration: 2,
    });
  });

  it("still discards the checkpoint when retry is explicitly destructive (defect 3)", async () => {
    const value = fixture();
    const original = createWardenCheckpointJobJournal({
      db: value.db,
      tenantId: binding.tenantId,
      jobId: value.jobId,
      workerId: value.workerId,
      leaseGeneration: value.leaseGeneration,
      now: () => NOW,
    });
    expect(await original.compareAndSwap({
      binding,
      expectedPayloadDigest: null,
      expectedActiveWriterLeaseGeneration: 1,
      nextEnvelope,
      nextSealedRuntimeState,
    })).toBe(true);
    expect(failJob(value.db, value.jobId, "worker_crash", "2026-08-12T12:00:10.000Z", {
      workerId: value.workerId,
      leaseGeneration: value.leaseGeneration,
      errorCode: "warden_needs_human",
      retryable: false,
    }).applied).toBe(true);
    expect(retryJob(value.db, value.jobId, {
      tenantId: binding.tenantId,
      now: "2026-08-12T12:00:11.000Z",
      discardCheckpoint: true,
    })).toBe(true);
    const successorJob = claimNextJob(value.db, ["agent.run"], {
      tenantId: binding.tenantId,
      workerId: "worker-b",
      leaseMs: 60_000,
      now: "2026-08-12T12:00:12.000Z",
    });
    const successor = createWardenCheckpointJobJournal({
      db: value.db,
      tenantId: binding.tenantId,
      jobId: value.jobId,
      workerId: "worker-b",
      leaseGeneration: successorJob!.lease_generation,
      now: () => "2026-08-12T12:00:12.000Z",
    });
    expect(await successor.read(binding)).toEqual({
      envelope: null,
      sealedRuntimeState: null,
      activeWriterLeaseGeneration: 2,
    });
  });

  it("rejects foreign bindings and malformed stored heads", async () => {
    const value = fixture();
    const journal = createWardenCheckpointJobJournal({
      db: value.db,
      tenantId: binding.tenantId,
      jobId: value.jobId,
      workerId: value.workerId,
      leaseGeneration: value.leaseGeneration,
      now: () => NOW,
    });
    await expect(journal.read({ ...binding, tenantId: "tenant-b" }))
      .rejects.toThrow("warden_checkpoint_binding_mismatch");

    value.db.raw.prepare("UPDATE jobs SET result_json = ? WHERE id = ?")
      .run(JSON.stringify({ kind: "different_internal_result" }), value.jobId);
    await expect(journal.read(binding)).rejects.toThrow("warden_checkpoint_head_invalid");
  });

  it("fails closed before writing a checkpoint larger than the configured bound", async () => {
    const value = fixture();
    const journal = createWardenCheckpointJobJournal({
      db: value.db,
      tenantId: binding.tenantId,
      jobId: value.jobId,
      workerId: value.workerId,
      leaseGeneration: value.leaseGeneration,
      now: () => NOW,
      maxHeadBytes: 512,
    });
    await expect(journal.compareAndSwap({
      binding,
      expectedPayloadDigest: null,
      expectedActiveWriterLeaseGeneration: 1,
      nextEnvelope,
      nextSealedRuntimeState,
    })).rejects.toThrow("warden_checkpoint_storage_limit");
    expect(value.db.raw.prepare("SELECT result_json FROM jobs WHERE id = ?")
      .get(value.jobId)).toEqual({ result_json: null });
  });

  it("never acknowledges a checkpoint inside an ambient transaction", async () => {
    const value = fixture();
    const journal = createWardenCheckpointJobJournal({
      db: value.db,
      tenantId: binding.tenantId,
      jobId: value.jobId,
      workerId: value.workerId,
      leaseGeneration: value.leaseGeneration,
      now: () => NOW,
    });
    value.db.raw.exec("BEGIN IMMEDIATE");
    try {
      await expect(journal.compareAndSwap({
        binding,
        expectedPayloadDigest: null,
        expectedActiveWriterLeaseGeneration: 1,
        nextEnvelope,
        nextSealedRuntimeState,
      })).rejects.toThrow("warden_checkpoint_transaction_unsupported");
    } finally {
      value.db.raw.exec("ROLLBACK");
    }
    expect(value.db.raw.prepare("SELECT result_json FROM jobs WHERE id = ?")
      .get(value.jobId)).toEqual({ result_json: null });
  });

  it("lets only a terminal checkpoint join an ambient completion transaction", async () => {
    const value = fixture();
    const journal = createWardenCheckpointJobJournal({
      db: value.db,
      tenantId: binding.tenantId,
      jobId: value.jobId,
      workerId: value.workerId,
      leaseGeneration: value.leaseGeneration,
      now: () => NOW,
    });
    expect(await journal.compareAndSwap({
      binding,
      expectedPayloadDigest: null,
      expectedActiveWriterLeaseGeneration: 1,
      nextEnvelope,
      nextSealedRuntimeState,
    })).toBe(true);

    value.db.raw.exec("BEGIN IMMEDIATE");
    expect(await journal.compareAndSwap({
      binding,
      expectedPayloadDigest: nextEnvelope.payloadDigest,
      expectedActiveWriterLeaseGeneration: 1,
      nextEnvelope: terminalEnvelope,
      nextSealedRuntimeState: terminalSealedRuntimeState,
    })).toBe(true);
    value.db.raw.exec("ROLLBACK");

    expect(await journal.read(binding)).toEqual({
      envelope: nextEnvelope,
      sealedRuntimeState: nextSealedRuntimeState,
      activeWriterLeaseGeneration: 1,
    });
  });

  it("rejects malformed and regressing authority clocks", async () => {
    const value = fixture();
    let tick = 0;
    const journal = createWardenCheckpointJobJournal({
      db: value.db,
      tenantId: binding.tenantId,
      jobId: value.jobId,
      workerId: value.workerId,
      leaseGeneration: value.leaseGeneration,
      now: () => tick++ === 0 ? NOW : "2026-08-12T11:59:59.000Z",
    });
    expect(await journal.read(binding)).toMatchObject({ activeWriterLeaseGeneration: 1 });
    await expect(journal.compareAndSwap({
      binding,
      expectedPayloadDigest: null,
      expectedActiveWriterLeaseGeneration: 1,
      nextEnvelope,
      nextSealedRuntimeState,
    })).rejects.toThrow("warden_checkpoint_clock_regressed");

    const invalid = createWardenCheckpointJobJournal({
      db: value.db,
      tenantId: binding.tenantId,
      jobId: value.jobId,
      workerId: value.workerId,
      leaseGeneration: value.leaseGeneration,
      now: () => "not-a-time",
    });
    await expect(invalid.read(binding)).rejects.toThrow("warden_checkpoint_clock_invalid");
  });

  it("rechecks lease expiry at the final checkpoint write boundary", async () => {
    const value = fixture();
    const journal = createWardenCheckpointJobJournal({
      db: value.db,
      tenantId: binding.tenantId,
      jobId: value.jobId,
      workerId: value.workerId,
      leaseGeneration: value.leaseGeneration,
      now: (() => {
        const ticks = [
          "2026-08-12T12:00:10.000Z",
          "2026-08-12T12:01:01.000Z",
        ];
        return () => ticks.shift() ?? "2026-08-12T12:01:01.000Z";
      })(),
    });
    await expect(journal.compareAndSwap({
      binding,
      expectedPayloadDigest: null,
      expectedActiveWriterLeaseGeneration: 1,
      nextEnvelope,
      nextSealedRuntimeState,
    })).rejects.toThrow("warden_checkpoint_job_stale");
    expect(value.db.raw.prepare("SELECT result_json FROM jobs WHERE id = ?")
      .get(value.jobId)).toEqual({ result_json: null });
  });
});
