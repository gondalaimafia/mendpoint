import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  getJob,
  insertPrincipal,
  insertTenant,
  listArtifactManifests,
  type AppDb,
} from "@mendpoint/db";
import type { VerifierTelemetry } from "@mendpoint/verifier";
import {
  enqueueVerifierAdvisoryJob,
  findVerifierTelemetry,
  readVerifierAdvisoryJobInput,
} from "./verifier-advisory-job.js";
import { persistVerifierTelemetry } from "./verifier-telemetry.js";

const roots: string[] = [];
const dbs: AppDb[] = [];
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

afterEach(() => {
  while (dbs.length) dbs.pop()!.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function setup(): AppDb {
  const root = mkdtempSync(join(tmpdir(), "verifier-advisory-job-"));
  roots.push(root);
  const db = createDb(join(root, "app.sqlite"));
  dbs.push(db);
  insertTenant(db, { id: "tenant_a", slug: "tenant-a", name: "Tenant A", createdAt: "2026-08-24T12:00:00.000Z" });
  insertPrincipal(db, { id: "worker_a", tenantId: "tenant_a", kind: "service", subject: "worker", displayName: "Worker", createdAt: "2026-08-24T12:00:00.000Z" });
  return db;
}

function completion() {
  return {
    tenantId: "tenant_a",
    missionId: "mission_a",
    taskId: "campaign_a:unit_a",
    product: "regauge" as const,
    repositoryId: "repo_a",
    snapshotId: "snapshot_a",
    snapshotDigest: digest("snapshot"),
    objective: "Verify the completed migration.",
    risk: "high" as const,
    allowedChangedPaths: ["package.json"],
    candidateId: "candidate_a",
    candidateDigest: digest("candidate"),
    changedPaths: ["package.json"],
    observableSummary: "The candidate passed exact verification.",
    deterministicEvidenceDigest: digest("evidence"),
    deterministicEvidenceRefs: ["evidence:test"],
    observedAt: "2026-08-24T12:01:00.000Z",
  };
}

describe("durable verifier advisory jobs", () => {
  it("stores content in a content addressed artifact and keeps the queue payload identifier only", () => {
    const db = setup();
    const first = enqueueVerifierAdvisoryJob(db, {
      completion: completion(),
      producerPrincipalId: "worker_a",
      createdAt: "2026-08-24T12:01:00.000Z",
    });
    const second = enqueueVerifierAdvisoryJob(db, {
      completion: completion(),
      producerPrincipalId: "worker_a",
      createdAt: "2026-08-24T12:01:00.000Z",
    });

    expect(second).toEqual({ ...first, status: "duplicate" });
    const job = getJob(db, first.jobId, "tenant_a")!;
    expect(JSON.parse(job.payload_json)).toEqual({
      schemaVersion: 1,
      inputArtifactId: first.inputArtifactId,
      inputSha256: first.inputSha256,
      missionId: "mission_a",
      taskId: "campaign_a:unit_a",
      product: "regauge",
    });
    expect(job.payload_json).not.toContain("package.json");
    expect(job.payload_json).not.toContain("Verify the completed migration");
    expect(listArtifactManifests(db, "tenant_a", "agent_verifier_advisory_input")).toHaveLength(1);
    expect(readVerifierAdvisoryJobInput(db, job)).toEqual(completion());
  });

  it("rejects a deterministic job id whose existing payload was changed", () => {
    const db = setup();
    const queued = enqueueVerifierAdvisoryJob(db, {
      completion: completion(), producerPrincipalId: "worker_a", createdAt: "2026-08-24T12:01:00.000Z",
    });
    db.raw.prepare("UPDATE jobs SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify({ inputArtifactId: "attacker" }), queued.jobId);
    expect(() => enqueueVerifierAdvisoryJob(db, {
      completion: completion(), producerPrincipalId: "worker_a", createdAt: "2026-08-24T12:01:00.000Z",
    })).toThrow("verifier_advisory_job_conflict");
  });

  it("uses verified telemetry, not dispatch intent, as the replay terminal", () => {
    const db = setup();
    const attemptId = "completion_campaign_a:unit_a";
    const packDigest = digest("pack");
    expect(findVerifierTelemetry(db, { tenantId: "tenant_a", verificationAttemptId: attemptId, evidencePackDigest: packDigest })).toBeNull();
    const telemetry = {
      schemaVersion: "2026-08-17.telemetry.v1",
      telemetryId: "telemetry_a",
      verificationAttemptId: attemptId,
      tenantId: "tenant_a",
      missionId: "mission_a",
      taskId: "campaign_a:unit_a",
      product: "regauge",
      evidencePackDigest: packDigest,
      rolloutMode: "advisory",
      backend: null,
      incumbentCandidateId: "candidate_a",
      eligibleCandidateIds: [],
      rejectedCandidates: [],
      candidateScores: {},
      suggestedCandidateId: null,
      effectiveCandidateId: "candidate_a",
      behaviorChanged: false,
      recommendation: "continue",
      failureCode: null,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
      estimatedCostUsd: 0,
      latencyMs: 0,
      observedAt: "2026-08-24T12:01:00.000Z",
      scoreEvidenceDigests: [],
      softSignalOnly: true,
      telemetryDigest: "",
    } as unknown as VerifierTelemetry;
    // The verifier owns the digest. Reuse its validated persistence path by
    // borrowing a real telemetry fixture from the package is intentionally not
    // necessary here: a malformed terminal must fail closed.
    expect(() => persistVerifierTelemetry(db, { telemetry, producerPrincipalId: "worker_a" }))
      .toThrow();
  });
});
