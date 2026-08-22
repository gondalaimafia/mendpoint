import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimNextJob,
  createDb,
  enqueueJob,
  enqueueWardenCandidateDelivery,
  getLearningRecord,
  grantLearningConsent,
  insertAgentRun,
  insertPrincipal,
  recordWardenCandidateDeliveryOutcome,
  recordWardenCandidateDeliverySuccess,
  type AppDb,
  type JobRow,
  type WardenCandidateDeliveryOutcome,
} from "@mendpoint/db";
import { governedLearningAdmissionIds } from "@mendpoint/pipeline";
import { GOVERNED_LEARNING_PURPOSE } from "./governed-learning-producer.js";
import {
  LEARNING_OUTCOME_RESOLVE_JOB_TYPE,
  runOutcomeResolutionLearning,
} from "./outcome-resolution-learning.js";

const NOW = "2026-08-06T12:00:00.000Z";
const LATER = "2026-08-07T12:00:00.000Z";
const TENANT = "tenant-a";
const HUMAN = "human:reviewer@example.com";

const opened: Array<{ db: AppDb; directory: string }> = [];

afterEach(() => {
  while (opened.length) {
    const entry = opened.pop()!;
    entry.db.raw.close();
    rmSync(entry.directory, { recursive: true, force: true });
  }
});

/**
 * Seed a delivered Fettler candidate whose PR reached a terminal outcome, exactly
 * as production leaves it: a sealed approval artifact on disk, a candidate-approved
 * run, a delivered delivery row, active governed consent, and the observed outcome
 * recorded on the row (the webhook's write). Returns everything the resolution job
 * handler reads.
 */
function fixture(outcome: WardenCandidateDeliveryOutcome) {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-outcome-resolution-"));
  const dataRoot = join(directory, "data");
  const approvalRoot = join(dataRoot, "warden-evidence", TENANT, "approvals");
  mkdirSync(approvalRoot, { recursive: true });
  const db = createDb(join(directory, "worker.sqlite"));
  opened.push({ db, directory });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES (?, ?, 'Tenant A', 'team', 'active', 10, ?)`,
  ).run(TENANT, TENANT, NOW);
  insertPrincipal(db, {
    id: HUMAN, tenantId: TENANT, kind: "human", subject: "reviewer",
    displayName: "Reviewer", createdAt: NOW,
  });
  grantLearningConsent(db, {
    id: "consent-governed", tenantId: TENANT, consentVersion: 1,
    purpose: GOVERNED_LEARNING_PURPOSE, residencyRegion: "us-east",
    authorizedByPrincipalId: HUMAN, effectiveAt: NOW, expiresAt: "2026-12-01T00:00:00.000Z",
    reason: "Authorized governed learning", idempotencyKey: "grant-governed", createdAt: NOW,
  });

  const before = Buffer.from("export const old = 1;\n");
  const beforeSha = `sha256:${createHash("sha256").update(before).digest("hex")}`;
  const after = Buffer.from("export const fixed = 1;\n");
  const afterSha = `sha256:${createHash("sha256").update(after).digest("hex")}`;
  const artifact = {
    schemaVersion: 3,
    tenantId: TENANT,
    repositoryId: "repo-1",
    snapshotId: "snapshot-1",
    baseBranch: "main",
    expectedBaseRevision: "a".repeat(40),
    reviewerPrincipalId: HUMAN,
    rationale: "The target and regression checks pass.",
    reviewEvidence: {
      schemaVersion: 1,
      summary: "The exact candidate passed every configured check.",
      verification: {
        summary: "The target and regression checks passed.",
        commands: [{ command: "npm test", ok: true, exitCode: 0, outputSha256: `sha256:${"e".repeat(64)}` }],
      },
      edits: [{
        path: "src/client.ts",
        rationale: "This source change repairs the bounded SDK call.",
        category: "api_repair",
        risk: "medium",
        confidence: 1,
        assessmentSource: "planner",
        verification: {
          summary: "The target and regression checks passed.",
          commandOutputSha256: [`sha256:${"e".repeat(64)}`],
        },
      }],
    },
    changedPaths: ["src/client.ts"],
    sourceDigest: `sha256:${"c".repeat(64)}`,
    candidate: {
      digest: `sha256:${"d".repeat(64)}`,
      entries: [{ path: "src/client.ts", size: after.byteLength, sha256: afterSha, executable: false }],
    },
    files: [{
      path: "src/client.ts",
      before: before.toString("base64"),
      after: after.toString("base64"),
      beforeSha256: beforeSha,
      afterSha256: afterSha,
    }],
  };
  const bytes = Buffer.from(JSON.stringify(artifact));
  const sealSha = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const sealPath = join(approvalRoot, `${sealSha.slice(7)}.json`);
  writeFileSync(sealPath, bytes);

  insertAgentRun(db, {
    id: "warden-run-1", tenantId: TENANT, jobId: "source-job-1", goal: "Repair the SDK",
    repoPath: join(directory, "snapshot"), status: "candidate_approved", ok: true, steps: 3,
    filesChanged: ["src/client.ts"], reportMd: "Target and regression checks passed.",
    resultJson: JSON.stringify({
      source: { repositoryId: "repo-1", snapshotId: "snapshot-1", revision: "a".repeat(40) },
      artifacts: { approval: { path: sealPath, sha256: sealSha } },
      review: { decision: "approve", reviewerPrincipalId: HUMAN, rationale: "The target and regression checks pass." },
    }),
    createdAt: NOW, finishedAt: NOW,
  });
  const delivery = enqueueWardenCandidateDelivery(db, {
    tenantId: TENANT, runId: "warden-run-1", repositoryId: "repo-1", snapshotId: "snapshot-1",
    baseBranch: "main", expectedBaseRevision: "a".repeat(40), sealedPath: sealPath, sealedSha256: sealSha,
    requesterPrincipalId: HUMAN, rationale: "The target and regression checks pass.", now: NOW,
  });
  // The delivery seam: the draft PR is opened and recorded. At this point the
  // outcome is still null (pending), so the producer admits nothing.
  recordWardenCandidateDeliverySuccess(db, {
    tenantId: TENANT, deliveryId: delivery.id, branchName: "fettler/repair",
    baseRevision: "a".repeat(40), commitSha: "b".repeat(40), draftPrNumber: 17,
    draftPrUrl: "https://github.com/acme/sdk/pull/17", observedAt: NOW,
  });
  // The outcome webhook: the PR's real fate is observed and recorded on the row.
  recordWardenCandidateDeliveryOutcome(db, {
    tenantId: TENANT, deliveryId: delivery.id, outcome, source: "github_webhook", observedAt: LATER,
  });

  const artifactEnv: NodeJS.ProcessEnv = {
    MENDPOINT_DATA_DIR: dataRoot,
    MENDPOINT_REGAUGE_LEARNING_ENABLED: "1",
  };
  return { db, deliveryId: delivery.id, artifactEnv };
}

function resolveJob(db: AppDb, deliveryId: string): JobRow {
  enqueueJob(db, {
    id: `learning-outcome-${deliveryId}`, tenantId: TENANT,
    type: LEARNING_OUTCOME_RESOLVE_JOB_TYPE,
    payload: { lane: "fettler", deliveryId }, createdAt: LATER,
  });
  return claimNextJob(db, [LEARNING_OUTCOME_RESOLVE_JOB_TYPE], {
    tenantId: TENANT, workerId: "worker-1", leaseMs: 60_000, now: LATER,
  })!;
}

/**
 * Read back the stored governed lesson document for an admitted event (the
 * redacted `{ event, lesson }` artifact), so a test can assert the observed outcome
 * and weight-training eligibility the producer derived. Mirrors the reader in
 * governed-learning-verdict.test.ts.
 */
function storedLesson(db: AppDb, eventId: string): {
  observedStatus: string;
  verdict: string;
  eligibleForModelTraining: boolean;
} {
  const ids = governedLearningAdmissionIds(TENANT, eventId);
  const row = db.raw
    .prepare("SELECT content_text FROM artifact_manifests WHERE id = ? AND tenant_id = ?")
    .get(ids.redactedArtifactId, TENANT) as { content_text: string | null } | undefined;
  if (!row?.content_text) throw new Error("lesson document not found");
  const doc = JSON.parse(row.content_text) as {
    event: { observedOutcome: { status: string }; verification: { verdict: string } };
    lesson: { eligibleForModelTraining: boolean };
  };
  return {
    observedStatus: doc.event.observedOutcome.status,
    verdict: doc.event.verification.verdict,
    eligibleForModelTraining: doc.lesson.eligibleForModelTraining,
  };
}

describe("outcome-resolution learning re-invocation", () => {
  it("admits a governed learning event once a delivered PR is observed merged", () => {
    const { db, deliveryId, artifactEnv } = fixture("merged");
    const job = resolveJob(db, deliveryId);

    const admission = runOutcomeResolutionLearning({ db, job, artifactEnv, now: () => LATER });

    // The assertion that dies if the invocation stops happening: a merged outcome
    // arrived and a durable governed learning record was produced. Removing the
    // producer call inside admitWardenLearningForResolvedOutcome (worker
    // warden-candidate-delivery.ts) makes admitted false and recordId undefined, so
    // both of these fail — verified by deletion.
    expect(admission.admitted).toBe(true);
    expect(admission.recordId).toBeTruthy();
    expect(getLearningRecord(db, TENANT, admission.recordId!)).toBeDefined();
  });

  it("is idempotent: a retried resolution job admits at most one record", () => {
    const { db, deliveryId, artifactEnv } = fixture("merged");

    const first = runOutcomeResolutionLearning({ db, job: resolveJob(db, deliveryId), artifactEnv, now: () => LATER });
    // A second delivery id for the same PR produces a second job; admission must
    // deduplicate on the run, not admit a twin record.
    enqueueJob(db, {
      id: `learning-outcome-${deliveryId}-retry`, tenantId: TENANT,
      type: LEARNING_OUTCOME_RESOLVE_JOB_TYPE, payload: { lane: "fettler", deliveryId }, createdAt: LATER,
    });
    const retryJob = claimNextJob(db, [LEARNING_OUTCOME_RESOLVE_JOB_TYPE], {
      tenantId: TENANT, workerId: "worker-1", leaseMs: 60_000, now: LATER,
    })!;
    const second = runOutcomeResolutionLearning({ db, job: retryJob, artifactEnv, now: () => LATER });

    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(true);
    expect(second.reason).toBe("already_admitted");
    expect(second.recordId).toBe(first.recordId);
  });

  it("records a PR observed closed without merge as a negative result that can never train weights", () => {
    const { db, deliveryId, artifactEnv } = fixture("closed_unmerged");
    const job = resolveJob(db, deliveryId);

    const admission = runOutcomeResolutionLearning({ db, job, artifactEnv, now: () => LATER });

    // Post-#324 the admission gate admits terminal non-merged outcomes so the
    // corpus carries real outcome variance. The record is admitted and routed, but
    // the failure is recorded honestly and is never a positive training signal.
    expect(admission.admitted).toBe(true);
    expect(admission.eventId).toBeTruthy();

    const doc = storedLesson(db, admission.eventId!);
    // The observed outcome is the failure member, never forced to a success value.
    expect(doc.observedStatus).toBe("failed");
    expect(doc.observedStatus).not.toBe("corrected");
    // The invariant #324 proved, asserted through the outcome-resolution path that
    // carries real production failures: a non-success outcome records no
    // verification authority, so its verdict is `inconclusive` and it can never
    // reach the model-weight corpus.
    expect(doc.verdict).toBe("inconclusive");
    expect(doc.eligibleForModelTraining).toBe(false);
  });

  it("no-ops honestly when the learning loop is disabled (default-off, mock mode)", () => {
    const { db, deliveryId, artifactEnv } = fixture("merged");
    const job = resolveJob(db, deliveryId);

    const admission = runOutcomeResolutionLearning({
      db, job, artifactEnv: { ...artifactEnv, MENDPOINT_REGAUGE_LEARNING_ENABLED: "0" }, now: () => LATER,
    });

    expect(admission.admitted).toBe(false);
    expect(admission.reason).toBe("disabled");
  });
});
