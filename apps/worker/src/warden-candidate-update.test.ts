import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimNextJob,
  createDb,
  enqueueWardenCiUpdate,
  getJob,
  getWardenCiCycle,
  insertAgentRun,
  pauseWardenCiCycle,
  type AppDb,
} from "@mendpoint/db";
import { runWardenCandidateUpdate } from "./warden-candidate-update.js";
import { wardenReviewFeedbackDigest } from "./warden-candidate-observation.js";
import type { ExactDraftObservation } from "@mendpoint/github";

const opened: Array<{ db: AppDb; root: string }> = [];
const sha = (value: string) => value.repeat(40);
const digest = (value: string) => `sha256:${value.repeat(64)}`;

function fixture(expectedFeedbackDigest: string | null = null) {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-warden-update-"));
  const db = createDb(join(root, "worker.sqlite"));
  opened.push({ db, root });
  db.raw.prepare(`INSERT INTO fettler_ci_cycles
    (id, tenant_id, delivery_id, observation_job_id, status, repository_id, remote_repository_id,
     installation_id, pull_request_number, base_branch, branch_name, base_revision, current_head_sha,
     required_checks_json, allowed_changed_paths_json, max_cycles, used_cycles, max_model_calls,
     maximum_cost_usd, current_observation_digest, repair_run_id, repair_job_id, created_at, updated_at)
    VALUES ('cycle-a', 'tenant-a', 'delivery-a', 'observe-old', 'repair_pending', 'repo-a', 101,
     202, 17, 'main', 'mendpoint/warden-a', ?, ?, '["check:77:unit"]', '["src/a.ts"]',
     3, 1, 6, 3, ?, 'repair-run-a', 'repair-agent-job-a', ?, ?)`)
    .run(sha("a"), sha("d"), digest("e"), "2026-08-13T12:00:00.000Z", "2026-08-13T12:03:00.000Z");
  const update = enqueueWardenCiUpdate(db, { tenantId: "tenant-a", cycleId: "cycle-a",
    repairRunId: "repair-run-a", expectedHeadSha: sha("d"), sealedPath: "sealed/approval.json",
    expectedFeedbackDigest,
    sealedSha256: digest("f"), reviewerPrincipalId: "principal-a", rationale: "Approve CI repair",
    observedAt: "2026-08-13T12:04:00.000Z" });
  insertAgentRun(db, { id: "repair-run-a", tenantId: "tenant-a", goal: "Repair CI", repoPath: root,
    status: "candidate_approved", ok: true, steps: 2, filesChanged: ["src/a.ts"], reportMd: null,
    resultJson: JSON.stringify({ source: { repositoryId: "repo-a", snapshotId: "snapshot-repair-a",
      revision: sha("d"), manifestSha256: "e".repeat(64) } }),
    createdAt: "2026-08-13T12:03:00.000Z", finishedAt: "2026-08-13T12:04:00.000Z" });
  const job = claimNextJob(db, ["warden.candidate.update"], { tenantId: "tenant-a", workerId: "worker-a",
    leaseMs: 60_000, now: "2026-08-13T12:04:30.000Z" })!;
  const afterSha256 = `sha256:${createHash("sha256").update("x").digest("hex")}`;
  const artifact = { tenantId: "tenant-a", repositoryId: "repo-a", snapshotId: "snapshot-repair-a",
    baseBranch: "main", expectedBaseRevision: sha("d"), reviewerPrincipalId: "principal-a",
    rationale: "Approve CI repair", candidate: { entries: [{ path: "src/a.ts", sha256: afterSha256,
      executable: false, size: 1 }] }, files: [{ path: "src/a.ts", after: Buffer.from("x").toString("base64"),
      afterSha256 }] };
  return { db, root, update, job, artifact };
}

function observedFeedback(body: string): ExactDraftObservation {
  return Object.freeze({ state: "draft", baseRevision: sha("a"), headRevision: sha("d"), checks: "success",
    checkRevision: sha("d"), approvals: 0, approvalRevision: null, conversationsResolved: false,
    failures: Object.freeze([]), checkIdentities: Object.freeze(["check:77:unit"]),
    checkResults: Object.freeze([{ identity: "check:77:unit", state: "success" as const }]),
    evidenceRefs: Object.freeze([]), reviewFeedback: Object.freeze({ verdict: "changes_requested" as const,
      changeRequests: Object.freeze([{ id: "7", reviewer: "reviewer", commitRevision: sha("d"), body,
        submittedAt: "2026-08-13T12:01:40.000Z" }]), comments: Object.freeze([]) }) });
}

afterEach(() => {
  for (const value of opened.splice(0)) {
    value.db.raw.close();
    rmSync(value.root, { recursive: true, force: true });
  }
});

describe("Warden candidate exact draft update", () => {
  it("updates the same draft once and atomically schedules the next CI observation", async () => {
    const { db, update, job, artifact } = fixture();
    const updateExactDraft = vi.fn(async () => ({ number: 17, url: "https://github.com/acme/service/pull/17",
      branch: "mendpoint/warden-a", previousHeadSha: sha("d"), commitSha: sha("f"), draft: true as const }));

    await expect(runWardenCandidateUpdate({ db, job, updateExactDraft,
      reconcileExactDraftUpdate: vi.fn(),
      readApprovalArtifact: () => artifact,
      resolveRepository: async () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:05:00.000Z" })).resolves.toMatchObject({
        status: "updated", updateId: update.id, commitSha: sha("f"),
      });

    expect(updateExactDraft).toHaveBeenCalledWith(expect.objectContaining({
      expectedRepositoryId: 101, pullRequestNumber: 17, baseBranch: "main",
      branch: "mendpoint/warden-a", expectedHeadSha: sha("d"),
      files: [{ path: "src/a.ts", content: "x", mode: "100644" }],
    }));
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("done");
    expect(getWardenCiCycle(db, "tenant-a", "cycle-a")).toMatchObject({
      status: "observation_pending", currentHeadSha: sha("f"),
    });
  });

  it("stops before GitHub when the cycle is paused after approval", async () => {
    const { db, job, artifact } = fixture();
    db.raw.prepare("UPDATE fettler_ci_cycles SET status = 'paused' WHERE id = 'cycle-a'").run();
    const updateExactDraft = vi.fn();
    await expect(runWardenCandidateUpdate({ db, job, updateExactDraft,
      reconcileExactDraftUpdate: vi.fn(),
      readApprovalArtifact: () => artifact,
      resolveRepository: async () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:05:00.000Z" })).rejects.toThrow("warden_ci_update_not_authorized");
    expect(updateExactDraft).not.toHaveBeenCalled();
  });

  it("reobserves and rejects edited or dismissed review feedback before the branch mutation", async () => {
    const approved = observedFeedback("Fix the nil response.");
    const expected = wardenReviewFeedbackDigest(approved)!;
    const { db, job, artifact } = fixture(expected);
    const updateExactDraft = vi.fn();
    const observeExactDraft = vi.fn(async () => observedFeedback("The request changed."));
    await expect(runWardenCandidateUpdate({ db, job, updateExactDraft, observeExactDraft,
      reconcileExactDraftUpdate: vi.fn(), readApprovalArtifact: () => artifact,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:05:00.000Z" })).rejects.toThrow("warden_ci_review_feedback_drift");
    expect(observeExactDraft).toHaveBeenCalledWith(expect.objectContaining({
      expectedHeadSha: sha("d"), expectedRepositoryId: 101, requireExactDraft: true,
    }));
    expect(updateExactDraft).not.toHaveBeenCalled();
  });

  it("updates once when the exact approved review feedback remains current", async () => {
    const approved = observedFeedback("Fix the nil response.");
    const { db, job, artifact } = fixture(wardenReviewFeedbackDigest(approved)!);
    const updateExactDraft = vi.fn(async () => ({ number: 17, url: "https://github.com/acme/service/pull/17",
      branch: "mendpoint/warden-a", previousHeadSha: sha("d"), commitSha: sha("f"), draft: true as const }));
    await expect(runWardenCandidateUpdate({ db, job, updateExactDraft,
      observeExactDraft: async () => approved, reconcileExactDraftUpdate: vi.fn(),
      readApprovalArtifact: () => artifact, resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:05:00.000Z" })).resolves.toMatchObject({ status: "updated" });
    expect(updateExactDraft).toHaveBeenCalledTimes(1);
  });

  it("serializes a one-use remote mutation permit against a later human pause", async () => {
    const { db, job, artifact } = fixture();
    const updateExactDraft = vi.fn(async () => {
      expect(() => pauseWardenCiCycle(db, { tenantId: "tenant-a", cycleId: "cycle-a",
        actorPrincipalId: "principal-b", reason: "pause after dispatch", observedAt: "2026-08-13T12:05:01.000Z" }))
        .toThrow("warden_ci_mutation_in_flight");
      return { number: 17, url: "https://github.com/acme/service/pull/17", branch: "mendpoint/warden-a",
        previousHeadSha: sha("d"), commitSha: sha("f"), draft: true as const };
    });
    await expect(runWardenCandidateUpdate({ db, job, updateExactDraft,
      reconcileExactDraftUpdate: vi.fn(),
      readApprovalArtifact: () => artifact, resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:05:00.000Z" })).resolves.toMatchObject({ status: "updated" });
  });

  it("releases an ambiguous mutation permit for pause and performs only read-only reconciliation", async () => {
    const { db, job, artifact } = fixture();
    const updateExactDraft = vi.fn()
      .mockRejectedValueOnce(new Error("socket closed"));
    const reconcileExactDraftUpdate = vi.fn(async () => ({ status: "not_applied" as const }));
    const args = { db, job, updateExactDraft, reconcileExactDraftUpdate,
      readApprovalArtifact: () => artifact, resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:05:00.000Z" };

    await expect(runWardenCandidateUpdate(args)).rejects.toThrow("socket closed");
    expect(db.raw.prepare("SELECT status FROM fettler_ci_updates WHERE cycle_id = 'cycle-a'").get())
      .toEqual({ status: "uncertain" });
    expect(() => pauseWardenCiCycle(db, { tenantId: "tenant-a", cycleId: "cycle-a",
      actorPrincipalId: "principal-b", reason: "pause during retry backoff",
      observedAt: "2026-08-13T12:05:01.000Z" })).not.toThrow();

    await expect(runWardenCandidateUpdate(args)).rejects.toThrow("warden_ci_update_not_authorized");
    expect(reconcileExactDraftUpdate).toHaveBeenCalledTimes(1);
    expect(updateExactDraft).toHaveBeenCalledTimes(1);
    expect(getWardenCiCycle(db, "tenant-a", "cycle-a")?.status).toBe("paused");
  });

  it("records an exact applied result discovered read-only after a human pause", async () => {
    const { db, job, artifact } = fixture();
    const updateExactDraft = vi.fn().mockRejectedValueOnce(new Error("response lost"));
    const base = { db, job, updateExactDraft, readApprovalArtifact: () => artifact,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:05:00.000Z" };
    await expect(runWardenCandidateUpdate({ ...base, reconcileExactDraftUpdate: vi.fn() }))
      .rejects.toThrow("response lost");
    pauseWardenCiCycle(db, { tenantId: "tenant-a", cycleId: "cycle-a", actorPrincipalId: "principal-b",
      reason: "pause during response recovery", observedAt: "2026-08-13T12:05:01.000Z" });
    const reconcileExactDraftUpdate = vi.fn(async () => ({ status: "applied" as const, result: {
      number: 17, url: "https://github.com/acme/service/pull/17", branch: "mendpoint/warden-a",
      previousHeadSha: sha("d"), commitSha: sha("f"), draft: true as const,
    } }));

    await expect(runWardenCandidateUpdate({ ...base, reconcileExactDraftUpdate }))
      .resolves.toMatchObject({ status: "updated", commitSha: sha("f") });
    expect(updateExactDraft).toHaveBeenCalledTimes(1);
    expect(getWardenCiCycle(db, "tenant-a", "cycle-a")).toMatchObject({
      status: "paused", currentHeadSha: sha("f"), pauseReason: "pause during response recovery",
    });
  });
});
