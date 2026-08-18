import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimNextJob,
  createDb,
  enqueueWardenCandidateDelivery,
  getJob,
  getWardenCandidateDeliveryByRun,
  insertAgentRun,
  type AppDb,
} from "@mendpoint/db";
import {
  gitlabAsExactDraftDelivery,
  MockGitLabDelivery,
  type ExactDraftDeliveryInput,
  type GitHubDelivery,
  type GitLabDelivery,
  type MergeRequestResult,
} from "@mendpoint/github";
import { runWardenCandidateDelivery } from "./warden-candidate-delivery.js";
import { transformerAdaptiveScmDelivery } from "./cli.js";

const NOW = "2026-08-06T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];

/** Wrap a GitLabDelivery as the GitHubDelivery-shaped exact-draft delivery the worker consumes. */
function gitlabGithub(delivery: GitLabDelivery): GitHubDelivery {
  const exact = gitlabAsExactDraftDelivery(delivery);
  const unsupported = async (): Promise<never> => {
    throw new Error("transformer_adaptive_delivery_exact_draft_only");
  };
  return {
    deliverExactDraft: (input) => exact.deliverExactDraft(input),
    createBranch: unsupported as GitHubDelivery["createBranch"],
    commitFiles: unsupported as GitHubDelivery["commitFiles"],
    openPullRequest: unsupported as GitHubDelivery["openPullRequest"],
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-warden-gitlab-delivery-"));
  const dataRoot = join(directory, "data");
  const approvalRoot = join(dataRoot, "warden-evidence", "tenant-a", "approvals");
  mkdirSync(approvalRoot, { recursive: true });
  const db = createDb(join(directory, "worker.sqlite"));
  opened.push({ db, directory });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?)`,
  ).run(NOW);
  const after = Buffer.from("export const fixed = 1;\n");
  const afterSha = `sha256:${createHash("sha256").update(after).digest("hex")}`;
  const artifact = {
    schemaVersion: 3,
    tenantId: "tenant-a",
    repositoryId: "repo-1",
    snapshotId: "snapshot-1",
    baseBranch: "main",
    expectedBaseRevision: "a".repeat(40),
    reviewerPrincipalId: "human:reviewer@example.com",
    rationale: "The target and regression checks pass.",
    reviewEvidence: {
      schemaVersion: 1,
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
      before: Buffer.from("export const old = 1;\n").toString("base64"),
      after: after.toString("base64"),
      beforeSha256: `sha256:${"f".repeat(64)}`,
      afterSha256: afterSha,
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

describe("Warden candidate GitLab draft delivery", () => {
  it("delivers an approved candidate as a GitLab draft merge request", async () => {
    const { db, dataRoot, delivery, job } = fixture();
    const github = gitlabGithub(new MockGitLabDelivery());
    const result = await runWardenCandidateDelivery({
      db, job, github, artifactEnv: { MENDPOINT_DATA_DIR: dataRoot },
      now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main" }),
    });

    expect(result).toMatchObject({
      status: "delivered",
      runId: delivery.runId,
      pullRequestNumber: 1,
      pullRequestUrl: "https://gitlab.com/acme/sdk/-/merge_requests/1",
      // The real 40-hex GitLab commit SHA is threaded through evidence unchanged.
      commitSha: expect.stringMatching(/^[a-f0-9]{40}$/),
    });

    expect(getJob(db, job.id, "tenant-a")?.status).toBe("done");
    const persisted = getWardenCandidateDeliveryByRun(db, "tenant-a", delivery.runId)!;
    expect(persisted).toMatchObject({
      status: "delivered",
      draftPr: true,
      draftPrNumber: 1,
      draftPrUrl: "https://gitlab.com/acme/sdk/-/merge_requests/1",
    });
    expect(persisted.commitSha).toMatch(/^[a-f0-9]{40}$/);
  });

  it("fails closed and does not deliver when GitLab returns a non-draft merge request", async () => {
    const { db, dataRoot, delivery, job } = fixture();
    const nonDraft: GitLabDelivery = {
      async resolveBranchSha() {
        return "a".repeat(40);
      },
      async createBranch() {},
      async commitFiles() {
        return "f".repeat(40);
      },
      async openDraftMergeRequest(namespace, project, sourceBranch, title) {
        return {
          number: 4,
          url: `https://gitlab.com/${namespace}/${project}/-/merge_requests/4`,
          branch: sourceBranch,
          title,
          draft: false as unknown as true,
        } as MergeRequestResult;
      },
    };

    const result = await runWardenCandidateDelivery({
      db, job, github: gitlabGithub(nonDraft), artifactEnv: { MENDPOINT_DATA_DIR: dataRoot },
      now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main" }),
    });

    expect(result.status).toBe("delivery_failed");
    expect(getWardenCandidateDeliveryByRun(db, "tenant-a", delivery.runId)).toMatchObject({
      status: "delivery_failed",
      commitSha: null,
    });
  });

  it("selects the GitHub path when SCM_PROVIDER is unset and GitLab when it is gitlab", async () => {
    const { db } = fixture();
    const intent: ExactDraftDeliveryInput = Object.freeze({
      owner: "acme",
      repo: "sdk",
      baseBranch: "main",
      expectedBaseSha: "a".repeat(40),
      branch: "mendpoint/warden-select",
      commitMessage: "Apply approved Warden repair",
      commitDate: NOW,
      title: "Apply approved Warden repair",
      body: "Sealed exact-draft body.",
      files: Object.freeze([
        { path: "src/client.ts", content: "export const fixed = 1;\n", mode: "100644" as const },
      ]),
    });

    // Unset provider routes to the GitHub path; without GITHUB_MODE=real it
    // refuses before any delivery, proving the GitHub delivery was selected and
    // is unchanged.
    const githubSelected = transformerAdaptiveScmDelivery(db, "tenant-a", { GITHUB_MODE: "mock" });
    await expect(githubSelected.deliverExactDraft(intent)).rejects.toThrow(
      "transformer_adaptive_delivery_real_github_required",
    );

    // SCM_PROVIDER=gitlab routes to the GitLab draft-MR path (mock by default).
    const gitlabSelected = transformerAdaptiveScmDelivery(db, "tenant-a", { SCM_PROVIDER: "gitlab" });
    const result = await gitlabSelected.deliverExactDraft(intent);
    expect(result).toMatchObject({
      branch: "mendpoint/warden-select",
      title: "Apply approved Warden repair",
      draft: true,
      baseBranch: "main",
      baseSha: "a".repeat(40),
      url: "https://gitlab.com/acme/sdk/-/merge_requests/1",
    });
    expect(result.commitSha).toMatch(/^[a-f0-9]{40}$/);
  });
});
