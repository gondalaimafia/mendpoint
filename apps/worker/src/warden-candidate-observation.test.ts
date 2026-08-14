import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimNextJob,
  createDb,
  enqueueWardenCiCycle,
  getJob,
  getWardenCiCycle,
  listWardenCiObservations,
  type AppDb,
} from "@mendpoint/db";
import type { ExactDraftObservation } from "@mendpoint/github";
import { runWardenCandidateObservation } from "./warden-candidate-observation.js";

const opened: Array<{ db: AppDb; root: string }> = [];
const sha = (value: string) => value.repeat(40);
const digest = (value: string) => `sha256:${value.repeat(64)}`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-warden-observe-"));
  const db = createDb(join(root, "worker.sqlite"));
  opened.push({ db, root });
  db.raw.prepare(`INSERT INTO fettler_candidate_deliveries
    (id, tenant_id, run_id, job_id, status, repository_id, snapshot_id, base_branch,
     expected_base_revision, sealed_path, sealed_sha256, requester_principal_id, rationale,
     intent_digest, branch_name, base_revision, commit_sha, draft_pr, draft_pr_number,
     draft_pr_url, requested_at, delivered_at, updated_at)
    VALUES ('delivery-a', 'tenant-a', 'run-a', 'delivery-job-a', 'delivered', 'repo-a', 'snapshot-a',
     'main', ?, 'sealed', ?, 'principal-a', 'approved', ?, 'mendpoint/warden-a', ?, ?, 1, 17,
     'https://github.com/acme/service/pull/17', ?, ?, ?)`)
    .run(sha("a"), digest("b"), digest("c"), sha("a"), sha("d"),
      "2026-08-13T12:00:00.000Z", "2026-08-13T12:01:00.000Z", "2026-08-13T12:01:00.000Z");
  const cycle = enqueueWardenCiCycle(db, {
    tenantId: "tenant-a", deliveryId: "delivery-a", repositoryId: "repo-a",
    remoteRepositoryId: 101, installationId: 202, requiredChecks: ["check:77:unit"],
    allowedChangedPaths: ["src/a.ts"], maxCycles: 3, maxModelCalls: 4, maximumCostUsd: 1.5,
    observedAt: "2026-08-13T12:01:00.000Z",
  });
  const job = claimNextJob(db, ["warden.candidate.observe"], {
    tenantId: "tenant-a", workerId: "worker-a", leaseMs: 60_000,
    now: "2026-08-13T12:01:30.000Z",
  })!;
  return { db, cycle, job };
}

afterEach(() => {
  for (const value of opened.splice(0)) {
    value.db.raw.close();
    rmSync(value.root, { recursive: true, force: true });
  }
});

function observation(state: "success" | "failure" | "running"): ExactDraftObservation {
  return Object.freeze({
    state: "draft", baseRevision: sha("a"), headRevision: sha("d"), checks: state,
    checkRevision: sha("d"), approvals: 1, approvalRevision: sha("d"),
    conversationsResolved: true, checkIdentities: Object.freeze(["check:77:unit"]),
    checkResults: Object.freeze([Object.freeze({ identity: "check:77:unit", state })]),
    failures: state === "failure" ? Object.freeze([Object.freeze({
      kind: "check_run" as const, id: "9", publisherId: 77, name: "unit", state: "failure" as const,
      title: "Unit failed", summary: "token=ghp_abcdefghijklmnopqrstuvwxyz123456",
      text: "expected 1 received 2", detailsUrl: "https://github.com/acme/service/actions/runs/9",
    })]) : Object.freeze([]),
    evidenceRefs: Object.freeze(["github:head:" + sha("d")]),
  });
}

describe("Warden candidate CI observation", () => {
  it("persists redacted failed-check evidence and terminalizes the exact observation job", async () => {
    const { db, cycle, job } = fixture();
    const observe = vi.fn(async () => observation("failure"));
    const persistEvidence = vi.fn(async (bytes: Uint8Array) => ({
      artifactId: "artifact-failure-a",
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    }));

    await expect(runWardenCandidateObservation({
      db, job, observe, persistEvidence,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:02:00.000Z",
    })).resolves.toMatchObject({ status: "failed_checks", cycleId: cycle.id });

    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      pullRequestNumber: 17, expectedHeadSha: sha("d"), expectedRepositoryId: 101,
      requireExactDraft: true,
    }));
    const persisted = Buffer.from(persistEvidence.mock.calls[0]![0]).toString("utf8");
    expect(persisted).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(persisted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("done");
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)?.status).toBe("checks_failed");
    expect(listWardenCiObservations(db, "tenant-a", cycle.id)).toHaveLength(1);
  });

  it("reschedules running checks without persisting repair evidence", async () => {
    const { db, cycle, job } = fixture();
    const persistEvidence = vi.fn();
    await expect(runWardenCandidateObservation({
      db, job, observe: async () => observation("running"), persistEvidence,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:02:00.000Z",
    })).resolves.toMatchObject({ status: "retry_scheduled" });
    expect(persistEvidence).not.toHaveBeenCalled();
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("pending");
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)?.status).toBe("observation_pending");
  });

  it("durably pauses after the bounded required-check polling budget", async () => {
    const { db, cycle, job } = fixture();
    const exhaustedJob = { ...job, attempts: job.max_attempts };
    await expect(runWardenCandidateObservation({
      db, job: exhaustedJob, observe: async () => observation("running"), persistEvidence: vi.fn(),
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:02:00.000Z",
    })).resolves.toMatchObject({ status: "poll_exhausted", cycleId: cycle.id });
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("done");
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)).toMatchObject({
      status: "paused", pausedBy: "warden-ci-system", pauseReason: "required_checks_poll_exhausted",
    });
  });

  it("fails closed on missing required checks before recording an observation", async () => {
    const { db, cycle, job } = fixture();
    const invalid = { ...observation("failure"), checkIdentities: [], checkResults: [] };
    await expect(runWardenCandidateObservation({
      db, job, observe: async () => invalid, persistEvidence: vi.fn(),
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:02:00.000Z",
    })).rejects.toThrow("warden_ci_required_checks_missing");
    expect(listWardenCiObservations(db, "tenant-a", cycle.id)).toHaveLength(0);
  });
});
