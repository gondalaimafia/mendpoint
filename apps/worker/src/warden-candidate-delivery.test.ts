import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimNextJob,
  createDb,
  enqueueWardenCandidateDelivery,
  getJob,
  getWardenCandidateDeliveryByRun,
  getWardenCiCycle,
  insertAgentRun,
  recoverExpiredJobs,
  type AppDb,
} from "@mendpoint/db";
import type { ExactDraftDeliveryInput, GitHubDelivery } from "@mendpoint/github";
import { runWardenCandidateDelivery } from "./warden-candidate-delivery.js";

const NOW = "2026-08-06T12:00:00.000Z";
const SNAPSHOT_EXPIRES_AT = "2035-08-06T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];

function fixture(preciseEvidence = false, deleted = false, providerChange = false) {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-warden-delivery-worker-"));
  const dataRoot = join(directory, "data");
  const approvalRoot = join(dataRoot, "warden-evidence", "tenant-a", "approvals");
  mkdirSync(approvalRoot, { recursive: true });
  const db = createDb(join(directory, "worker.sqlite"));
  opened.push({ db, directory });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?)`,
  ).run(NOW);
    const before = Buffer.from("export const old = 1;\n");
    const beforeSha = `sha256:${createHash("sha256").update(before).digest("hex")}`;
    const after = Buffer.from("export const fixed = 1;\n");
    const afterSha = `sha256:${createHash("sha256").update(after).digest("hex")}`;
    const artifact = {
    schemaVersion: providerChange ? (preciseEvidence ? 6 : 5) : preciseEvidence ? 4 : 3,
    tenantId: "tenant-a",
    repositoryId: "repo-1",
    snapshotId: "snapshot-1",
    baseBranch: "main",
    expectedBaseRevision: "a".repeat(40),
    reviewerPrincipalId: "human:reviewer@example.com",
    rationale: "The target and regression checks pass.",
    reviewEvidence: {
      schemaVersion: preciseEvidence ? 2 : 1,
      summary: "The exact candidate passed every configured check.",
      verification: {
        summary: "The target and regression checks passed.",
        commands: [{
          command: "npm test",
          ok: true,
          exitCode: 0,
          outputSha256: `sha256:${"e".repeat(64)}`,
        }],
      },
      edits: [{
        path: "src/client.ts",
        ...(preciseEvidence ? {
          hypothesis: "The observed legacy SDK call causes the failing request.",
          targetSymbol: "createCharge",
          sourceEvidence: [{ path: "src/client.ts", digest: `sha256:${"c".repeat(64)}` }],
          precondition: "The exact legacy SDK call is still present.",
          expectedObservation: "The call changes exactly once.",
          postcondition: "The approved SDK request and regression checks pass.",
          rollback: "Restore the exact observed source bytes.",
          stopCondition: "Stop if the source evidence digest changes.",
        } : {
          rationale: "This source change repairs the bounded SDK call.",
          category: "api_repair",
        }),
        risk: "medium",
        confidence: 1,
        assessmentSource: "planner",
        verification: {
          summary: "The target and regression checks passed.",
          commandOutputSha256: [`sha256:${"e".repeat(64)}`],
        },
      }],
    },
    ...(providerChange ? {
      fettlerProviderChange: {
        schemaVersion: 1,
        providerSlug: "stripe",
        changeId: "change-stripe-2026-08-31",
        pipelineJobId: "pipeline-job-1",
        contentHash: "0123456789abcdef",
        fromVersionId: "version-stripe-2025-01",
        fromVersionLabel: "2025-01",
        toVersionId: "version-stripe-2026-08",
        toVersionLabel: "2026-08",
        repositoryId: "repo-1",
        snapshotId: "snapshot-1",
        revision: "a".repeat(40),
        graphVersionId: "graph-version-1",
        graphContextArtifactId: "graph-context-1",
        impactEvidenceDigest: `sha256:${"f".repeat(64)}`,
        overallConfidence: "high",
        whatChanged: "The provider removed the legacy request field.",
        knownFacts: ["The removed field is used in src/client.ts."],
        unknowns: ["Runtime-only callers were not observed."],
        whyAffected: "src/client.ts sends the removed field at the confirmed call site.",
      },
    } : {}),
    changedPaths: ["src/client.ts"],
    sourceDigest: `sha256:${"c".repeat(64)}`,
    candidate: {
      digest: `sha256:${"d".repeat(64)}`,
      entries: deleted ? [] : [{ path: "src/client.ts", size: after.byteLength, sha256: afterSha, executable: false }],
    },
    files: [{
      path: "src/client.ts",
      before: before.toString("base64"),
      after: deleted ? null : after.toString("base64"),
      beforeSha256: beforeSha,
      afterSha256: deleted ? null : afterSha,
    }],
  };
  const bytes = Buffer.from(JSON.stringify(artifact));
  const sealSha = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const sealPath = join(approvalRoot, `${sealSha.slice(7)}.json`);
  writeFileSync(sealPath, bytes);
  insertAgentRun(db, {
    id: "warden-run-1", tenantId: "tenant-a", jobId: "source-job-1", goal: "Repair the SDK",
    repoPath: join(directory, "snapshot"), status: "candidate_approved", ok: true, steps: 3,
    filesChanged: ["src/client.ts"], reportMd: "Target and regression checks passed.",
    resultJson: JSON.stringify({ source: { repositoryId: "repo-1", snapshotId: "snapshot-1", revision: "a".repeat(40) },
      artifacts: { approval: { path: sealPath, sha256: sealSha } },
      review: { decision: "approve", reviewerPrincipalId: "human:reviewer@example.com",
        rationale: "The target and regression checks pass." } }),
    createdAt: NOW, finishedAt: NOW,
  });
  const delivery = enqueueWardenCandidateDelivery(db, {
    tenantId: "tenant-a", runId: "warden-run-1", repositoryId: "repo-1", snapshotId: "snapshot-1",
    baseBranch: "main", expectedBaseRevision: "a".repeat(40), sealedPath: sealPath, sealedSha256: sealSha,
    requesterPrincipalId: "human:reviewer@example.com", rationale: "The target and regression checks pass.", now: NOW,
  });
  const job = claimNextJob(db, ["warden.candidate.deliver"], {
    tenantId: "tenant-a", workerId: "worker-1", leaseMs: 60_000, now: NOW,
  })!;
  return { db, dataRoot, delivery, job };
}

afterEach(() => {
  while (opened.length) {
    const entry = opened.pop()!;
    entry.db.raw.close();
    rmSync(entry.directory, { recursive: true, force: true });
  }
});

describe("Warden exact candidate draft delivery", () => {
  it("reverifies the seal and creates a draft from the exact approved bytes", async () => {
    const { db, dataRoot, job } = fixture();
    const deliver = vi.fn(async (input: ExactDraftDeliveryInput) => ({
      branch: input.branch, title: input.title, baseBranch: input.baseBranch,
      baseSha: input.expectedBaseSha, commitSha: "b".repeat(40),
      draft: true as const, number: 17, url: "https://github.com/acme/sdk/pull/17",
    }));
    const github = { deliverExactDraft: deliver } as unknown as GitHubDelivery;
    const result = await runWardenCandidateDelivery({
      db, job, github, artifactEnv: { MENDPOINT_DATA_DIR: dataRoot },
      now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main",
        snapshotExpiresAt: SNAPSHOT_EXPIRES_AT, remoteRepositoryId: 101, installationId: 202 }),
      ciReentry: {
        requiredChecks: ["check:77:unit"],
        maxCycles: 3,
        maxModelCalls: 4,
        maximumCostUsd: 1.5,
      },
    });
    expect(result.status).toBe("delivered");
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      expectedBaseSha: "a".repeat(40),
      files: [{ path: "src/client.ts", content: "export const fixed = 1;\n", mode: "100644" }],
    }));
    const body = (deliver.mock.calls[0]![0] as ExactDraftDeliveryInput).body;
    expect(body).toContain("The target and regression checks pass.");
    expect(body).toContain("Change 1: src/client.ts");
    expect(body).toContain("Category: api_repair");
    expect(body).toContain("Rationale: This source change repairs the bounded SDK call.");
    expect(body).toContain("Risk: medium");
    expect(body).toContain("Confidence: 1.000");
    expect(body).toContain("Command 1: npm test");
    expect(body).toContain(`Output digest: sha256:${"e".repeat(64)}`);
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("done");
    expect(getWardenCandidateDeliveryByRun(db, "tenant-a", "warden-run-1")?.draftPrUrl)
      .toBe("https://github.com/acme/sdk/pull/17");
    const cycle = db.raw.prepare("SELECT id FROM fettler_ci_cycles WHERE tenant_id = 'tenant-a'").get() as { id: string };
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)).toMatchObject({
      status: "observation_pending",
      currentHeadSha: "b".repeat(40),
      allowedChangedPaths: ["src/client.ts"],
      requiredChecks: ["check:77:unit"],
    });
  });

  it("renders complete source-bound edit authority for a version four approval", async () => {
    const { db, dataRoot, job } = fixture(true);
    const deliver = vi.fn(async (input: ExactDraftDeliveryInput) => ({
      branch: input.branch, title: input.title, baseBranch: input.baseBranch,
      baseSha: input.expectedBaseSha, commitSha: "b".repeat(40),
      draft: true as const, number: 17, url: "https://github.com/acme/sdk/pull/17",
    }));
    await runWardenCandidateDelivery({
      db, job, github: { deliverExactDraft: deliver } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: dataRoot }, now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    });
    const body = (deliver.mock.calls[0]![0] as ExactDraftDeliveryInput).body;
    expect(body).toContain("Target symbol: createCharge");
    expect(body).toContain("Source evidence: src/client.ts");
    expect(body).toContain("Precondition: The exact legacy SDK call is still present.");
    expect(body).toContain("Postcondition: The approved SDK request and regression checks pass.");
    expect(body).toContain("Rollback: Restore the exact observed source bytes.");
  });

  it("renders sealed provider, graph, impact, verification, and uncertainty evidence", async () => {
    const { db, dataRoot, job } = fixture(true, false, true);
    const deliver = vi.fn(async (input: ExactDraftDeliveryInput) => ({
      branch: input.branch, title: input.title, baseBranch: input.baseBranch,
      baseSha: input.expectedBaseSha, commitSha: "b".repeat(40),
      draft: true as const, number: 17, url: "https://github.com/acme/sdk/pull/17",
    }));
    await runWardenCandidateDelivery({
      db, job, github: { deliverExactDraft: deliver } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: dataRoot }, now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    });
    const body = (deliver.mock.calls[0]![0] as ExactDraftDeliveryInput).body;
    expect(body).toContain("Provider change");
    expect(body).toContain("Provider: stripe");
    expect(body).toContain("Provider versions: 2025-01 (version-stripe-2025-01) to 2026-08 (version-stripe-2026-08)");
    expect(body).toContain("Provider content hash: 0123456789abcdef");
    expect(body).toContain("Graph version: graph-version-1");
    expect(body).toContain(`Impact evidence: sha256:${"f".repeat(64)}`);
    expect(body).toContain("What changed");
    expect(body).toContain("The provider removed the legacy request field.");
    expect(body).toContain("Why this code is affected");
    expect(body).toContain("Known: The removed field is used in src/client.ts.");
    expect(body).toContain("Unknown: Runtime-only callers were not observed.");
    expect(body).toContain("Objective verification");
    expect(body).toContain("Proposed migration");
    expect((deliver.mock.calls[0]![0] as ExactDraftDeliveryInput).branch).toMatch(/^mendpoint\/fettler-/);
  });

  it("does not call GitHub for a second approved run scoped to the same sealed provider change", async () => {
    const { db, dataRoot, delivery, job } = fixture(true, false, true);
    const firstDeliver = vi.fn(async (input: ExactDraftDeliveryInput) => ({
      branch: input.branch, title: input.title, baseBranch: input.baseBranch,
      baseSha: input.expectedBaseSha, commitSha: "b".repeat(40),
      draft: true as const, number: 17, url: "https://github.com/acme/sdk/pull/17",
    }));
    const first = await runWardenCandidateDelivery({
      db, job, github: { deliverExactDraft: firstDeliver } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: dataRoot }, now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    });
    expect(first.status).toBe("delivered");
    expect(firstDeliver).toHaveBeenCalledTimes(1);

    const firstRun = db.raw.prepare(
      "SELECT result_json FROM agent_runs WHERE id = ? AND tenant_id = ?",
    ).get("warden-run-1", "tenant-a") as { result_json: string };
    insertAgentRun(db, {
      id: "warden-run-2", tenantId: "tenant-a", jobId: "source-job-2", goal: "Repair the same SDK change",
      repoPath: join(dataRoot, "snapshot"), status: "candidate_approved", ok: true, steps: 3,
      filesChanged: ["src/client.ts"], reportMd: "Target and regression checks passed.",
      resultJson: firstRun.result_json, createdAt: NOW, finishedAt: NOW,
    });
    enqueueWardenCandidateDelivery(db, {
      tenantId: "tenant-a", runId: "warden-run-2", repositoryId: "repo-1", snapshotId: "snapshot-1",
      baseBranch: "main", expectedBaseRevision: "a".repeat(40), sealedPath: delivery.sealedPath,
      sealedSha256: delivery.sealedSha256, requesterPrincipalId: "human:reviewer@example.com",
      rationale: "The target and regression checks pass.", now: "2026-08-06T12:00:02.000Z",
    });
    const secondJob = claimNextJob(db, ["warden.candidate.deliver"], {
      tenantId: "tenant-a", workerId: "worker-2", leaseMs: 60_000,
      now: "2026-08-06T12:00:03.000Z",
    })!;
    const secondDeliver = vi.fn();
    const second = await runWardenCandidateDelivery({
      db, job: secondJob, github: { deliverExactDraft: secondDeliver } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: dataRoot }, now: () => "2026-08-06T12:00:04.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    });

    expect(second.status).toBe("delivery_failed");
    expect(secondDeliver).not.toHaveBeenCalled();
    expect(getWardenCandidateDeliveryByRun(db, "tenant-a", "warden-run-2")).toMatchObject({
      status: "delivery_failed",
      errorMessage: "warden_candidate_delivery_scope_conflict",
    });
  });

  it("delivers an approved deletion as an exact delete operation", async () => {
    const { db, dataRoot, job } = fixture(true, true);
    const deliver = vi.fn(async (input: ExactDraftDeliveryInput) => ({
      branch: input.branch, title: input.title, baseBranch: input.baseBranch,
      baseSha: input.expectedBaseSha, commitSha: "b".repeat(40),
      draft: true as const, number: 17, url: "https://github.com/acme/sdk/pull/17",
    }));

    await runWardenCandidateDelivery({
      db, job, github: { deliverExactDraft: deliver } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: dataRoot }, now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    });

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      files: [{ path: "src/client.ts", delete: true }],
    }));
  });

  it("fails closed before GitHub when the sealed bytes are changed", async () => {
    const { db, dataRoot, delivery, job } = fixture();
    writeFileSync(delivery.sealedPath, "{}", "utf8");
    const deliver = vi.fn();
    const github = { deliverExactDraft: deliver } as unknown as GitHubDelivery;
    const result = await runWardenCandidateDelivery({ db, job, github, artifactEnv: { MENDPOINT_DATA_DIR: dataRoot },
      now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }) });
    expect(result.status).toBe("delivery_failed");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("fails closed before GitHub when the bound snapshot expires before delivery", async () => {
    const { db, dataRoot, job } = fixture(true, false, true);
    const deliver = vi.fn();
    const result = await runWardenCandidateDelivery({
      db,
      job,
      github: { deliverExactDraft: deliver } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: dataRoot },
      now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({
        owner: "acme",
        repo: "sdk",
        baseBranch: "main",
        snapshotExpiresAt: "2026-08-06T12:00:00.500Z",
      }),
    });
    expect(result.status).toBe("delivery_failed");
    expect(deliver).not.toHaveBeenCalled();
    expect(getJob(db, job.id, "tenant-a")?.error).toContain(
      "warden_candidate_delivery_snapshot_expired",
    );
  });

  it("keeps a lost GitHub response pending past the ordinary attempt cap", async () => {
    const { db, dataRoot, delivery, job } = fixture();
    db.raw.prepare("UPDATE jobs SET attempts = max_attempts WHERE id = ?").run(job.id);
    const uncertain = Object.assign(new Error("request ended after GitHub accepted it"), {
      code: "GITHUB_EXACT_DRAFT_REMOTE_SIDE_EFFECT_UNCERTAIN",
      remoteSideEffectUncertain: true,
    });
    const github = { deliverExactDraft: vi.fn(async () => { throw uncertain; }) } as unknown as GitHubDelivery;

    const result = await runWardenCandidateDelivery({
      db, job, github, artifactEnv: { MENDPOINT_DATA_DIR: dataRoot },
      now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    });

    expect(result.status).toBe("retry_scheduled");
    expect(getJob(db, job.id, "tenant-a")).toMatchObject({
      status: "pending",
      error_code: "warden_candidate_delivery_remote_side_effect_uncertain",
    });
    expect(getWardenCandidateDeliveryByRun(db, "tenant-a", delivery.runId)).toMatchObject({
      status: "delivery_pending",
      errorCode: "warden_candidate_delivery_remote_side_effect_uncertain",
    });
  });

  it("keeps invalid returned GitHub evidence pending past the ordinary attempt cap", async () => {
    const { db, dataRoot, delivery, job } = fixture();
    db.raw.prepare("UPDATE jobs SET attempts = max_attempts WHERE id = ?").run(job.id);
    const github = {
      deliverExactDraft: vi.fn(async (input: ExactDraftDeliveryInput) => ({
        branch: input.branch,
        title: input.title,
        baseBranch: input.baseBranch,
        baseSha: input.expectedBaseSha,
        commitSha: "b".repeat(40),
        draft: false,
        number: 17,
        url: "https://github.com/acme/sdk/pull/17",
      })),
    } as unknown as GitHubDelivery;

    const result = await runWardenCandidateDelivery({
      db, job, github, artifactEnv: { MENDPOINT_DATA_DIR: dataRoot },
      now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    });

    expect(result.status).toBe("retry_scheduled");
    expect(getJob(db, job.id, "tenant-a")).toMatchObject({
      status: "pending",
      error_code: "warden_candidate_delivery_remote_side_effect_uncertain",
    });
    expect(getWardenCandidateDeliveryByRun(db, "tenant-a", delivery.runId)).toMatchObject({
      status: "delivery_pending",
      errorCode: "warden_candidate_delivery_remote_side_effect_uncertain",
    });
  });

  it("keeps transaction setup failure after GitHub success pending past the attempt cap", async () => {
    const { db, dataRoot, delivery, job } = fixture();
    db.raw.prepare("UPDATE jobs SET attempts = max_attempts WHERE id = ?").run(job.id);
    const originalExec = db.raw.exec.bind(db.raw);
    let remoteReturned = false;
    let injected = false;
    db.raw.exec = ((sql: string) => {
      if (remoteReturned && !injected && sql === "BEGIN IMMEDIATE") {
        injected = true;
        throw new Error("simulated_transaction_begin_failure");
      }
      return originalExec(sql);
    }) as typeof db.raw.exec;
    const github = {
      deliverExactDraft: vi.fn(async (input: ExactDraftDeliveryInput) => {
        remoteReturned = true;
        return {
          branch: input.branch,
          title: input.title,
          baseBranch: input.baseBranch,
          baseSha: input.expectedBaseSha,
          commitSha: "b".repeat(40),
          draft: true as const,
          number: 17,
          url: "https://github.com/acme/sdk/pull/17",
        };
      }),
    } as unknown as GitHubDelivery;

    const result = await runWardenCandidateDelivery({
      db, job, github, artifactEnv: { MENDPOINT_DATA_DIR: dataRoot },
      now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    });

    expect(injected).toBe(true);
    expect(result.status).toBe("retry_scheduled");
    expect(getJob(db, job.id, "tenant-a")).toMatchObject({
      status: "pending",
      error_code: "warden_candidate_delivery_remote_side_effect_uncertain",
    });
    expect(getWardenCandidateDeliveryByRun(db, "tenant-a", delivery.runId)).toMatchObject({
      status: "delivery_pending",
      errorCode: "warden_candidate_delivery_remote_side_effect_uncertain",
    });
  });

  it("reconciles an exhausted lease after GitHub succeeded but local finalization lost its fence", async () => {
    const { db, dataRoot, delivery, job } = fixture();
    db.raw.prepare("UPDATE jobs SET attempts = max_attempts WHERE id = ?").run(job.id);
    const exactResult = (input: ExactDraftDeliveryInput) => ({
      branch: input.branch,
      title: input.title,
      baseBranch: input.baseBranch,
      baseSha: input.expectedBaseSha,
      commitSha: "b".repeat(40),
      draft: true as const,
      number: 17,
      url: "https://github.com/acme/sdk/pull/17",
    });
    const firstGitHub = {
      deliverExactDraft: vi.fn(async (input: ExactDraftDeliveryInput) => {
        db.raw.prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?")
          .run("2026-08-06T12:00:00.500Z", job.id);
        return exactResult(input);
      }),
    } as unknown as GitHubDelivery;

    await expect(runWardenCandidateDelivery({
      db, job, github: firstGitHub, artifactEnv: { MENDPOINT_DATA_DIR: dataRoot },
      now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    })).rejects.toThrow("warden_candidate_delivery_lease_lost");
    expect(getWardenCandidateDeliveryByRun(db, "tenant-a", delivery.runId)).toMatchObject({
      status: "delivery_pending",
      intentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });

    expect(recoverExpiredJobs(db, "2026-08-06T12:00:02.000Z", "tenant-a")).toBe(1);
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("pending");
    const replay = claimNextJob(db, ["warden.candidate.deliver"], {
      tenantId: "tenant-a", workerId: "worker-2", leaseMs: 60_000,
      now: "2026-08-06T12:10:00.000Z",
    })!;
    const replayGitHub = {
      deliverExactDraft: vi.fn(async (input: ExactDraftDeliveryInput) => exactResult(input)),
    } as unknown as GitHubDelivery;
    const result = await runWardenCandidateDelivery({
      db, job: replay, github: replayGitHub, artifactEnv: { MENDPOINT_DATA_DIR: dataRoot },
      now: () => "2026-08-06T12:10:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    });
    expect(result.status).toBe("delivered");
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("done");
    expect(getWardenCandidateDeliveryByRun(db, "tenant-a", delivery.runId)?.status).toBe("delivered");
  });
});
