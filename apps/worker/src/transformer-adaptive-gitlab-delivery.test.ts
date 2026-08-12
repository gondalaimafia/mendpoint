import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimNextJob,
  createDb,
  enqueueAdaptiveDelivery,
  getAdaptiveCandidate,
  getAdaptiveDeliveryByCandidate,
  recordAdaptiveCandidate,
  reviewAdaptiveCandidate,
  type AppDb,
  type JobRow,
} from "@mendpoint/db";
import {
  gitlabAsExactDraftDelivery,
  MockGitLabDelivery,
  type ExactDraftDeliveryInput,
  type ExactDraftDeliveryResult,
  type GitHubDelivery,
  type GitLabDelivery,
  type MergeRequestResult,
} from "@mendpoint/github";
import {
  recipeFilesDigest,
  sealAdaptiveCandidate,
  type RecipeFiles,
} from "@mendpoint/transformer";
import { runTransformerAdaptiveDelivery } from "./transformer-adaptive-delivery.js";
import { transformerAdaptiveScmDelivery } from "./cli.js";

const TENANT_ID = "tenant-a";
const REPOSITORY_ID = "repository-a";
const SNAPSHOT_ID = "snapshot-a";
const BASE_SHA = "a".repeat(40);
const FILES: RecipeFiles = Object.freeze({
  "package.json": "{\"name\":\"customer\"}\n",
  "README.md": "Customer repository\n",
  "src/client.ts": "export const migrated = true;\n",
});

const roots: string[] = [];
const databases: AppDb[] = [];

afterEach(() => {
  while (databases.length) databases.pop()!.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

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

function fixture(): {
  db: AppDb;
  job: JobRow;
  candidateId: string;
  deliveryId: string;
  artifactEnv: NodeJS.ProcessEnv;
} {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-transformer-gitlab-"));
  roots.push(root);
  const db = createDb(join(root, "app.db"));
  databases.push(db);
  const dataRoot = join(root, "data");
  mkdirSync(dataRoot, { recursive: true });
  const artifactEnv = { ...process.env, MENDPOINT_DATA_DIR: dataRoot };
  const candidateDigest = recipeFilesDigest(FILES);
  const seal = sealAdaptiveCandidate({
    tenantId: TENANT_ID,
    campaignId: "campaign-a",
    unitId: "unit-a",
    attemptId: "attempt-a",
    repositoryId: REPOSITORY_ID,
    snapshotId: SNAPSHOT_ID,
    baseBranch: "main",
    expectedBaseRevision: BASE_SHA,
    divergedFromDigest: `sha256:${"c".repeat(64)}`,
    candidateDigest,
    failingCommandId: "verify-tests",
    changedPaths: ["src/client.ts", "package.json"],
    files: FILES,
    fileModes: Object.freeze({
      "package.json": "100644" as const,
      "README.md": "100644" as const,
      "src/client.ts": "100755" as const,
    }),
    review: {
      schemaVersion: 1,
      edits: [
        {
          path: "package.json",
          changeType: "modify",
          beforeContent: "{\"name\":\"customer\",\"legacy\":true}\n",
          beforeDigest: `sha256:${createHash("sha256").update("{\"name\":\"customer\",\"legacy\":true}\n").digest("hex")}`,
          beforeMode: "100644",
          afterDigest: `sha256:${createHash("sha256").update(FILES["package.json"]!).digest("hex")}`,
          afterMode: "100644",
          semanticCategory: "dependencies",
          rationale: "Remove the obsolete package declaration after verification.",
          risk: "medium",
          confidence: 92,
        },
        {
          path: "src/client.ts",
          changeType: "modify",
          beforeContent: "export const migrated = false;\n",
          beforeDigest: `sha256:${createHash("sha256").update("export const migrated = false;\n").digest("hex")}`,
          beforeMode: "100755",
          afterDigest: `sha256:${createHash("sha256").update(FILES["src/client.ts"]!).digest("hex")}`,
          afterMode: "100755",
          semanticCategory: "behavior",
          rationale: "Apply the verified client migration behavior.",
          risk: "medium",
          confidence: 92,
        },
      ],
      verification: {
        passed: true,
        commandId: "verify-tests",
        summary: "The objective verification passed on the sealed candidate.",
        outputDigest: `sha256:${createHash("sha256").update("passed").digest("hex")}`,
      },
      overallRisk: "medium",
      confidence: 92,
    },
    env: artifactEnv,
  });
  const candidate = recordAdaptiveCandidate(db, {
    tenantId: TENANT_ID,
    campaignId: "campaign-a",
    unitId: "unit-a",
    attemptId: "attempt-a",
    repositoryId: REPOSITORY_ID,
    snapshotId: SNAPSHOT_ID,
    baseBranch: "main",
    expectedBaseRevision: BASE_SHA,
    divergedFromDigest: `sha256:${"c".repeat(64)}`,
    candidateDigest,
    failingCommandId: "verify-tests",
    sealedPath: seal.path,
    sealedSha256: seal.sha256,
    changedPaths: ["src/client.ts", "package.json"],
    expiresAt: "2026-08-06T02:00:00.000Z",
    now: "2026-08-06T01:00:00.000Z",
  });
  reviewAdaptiveCandidate(db, {
    tenantId: TENANT_ID,
    id: candidate.id,
    decision: "approve",
    reviewerPrincipalId: "reviewer-a",
    rationale: "Verified the exact proposed files\nRisk is limited to the reviewed paths.",
    now: "2026-08-06T01:00:10.000Z",
  });
  const delivery = enqueueAdaptiveDelivery(db, {
    tenantId: TENANT_ID,
    candidateId: candidate.id,
    repositoryId: REPOSITORY_ID,
    snapshotId: SNAPSHOT_ID,
    baseBranch: "main",
    expectedBaseRevision: BASE_SHA,
    requesterPrincipalId: "reviewer-a",
    maxAttempts: 3,
    now: "2026-08-06T01:00:20.000Z",
  });
  const job = claimNextJob(db, ["transformer.adaptive.deliver"], {
    tenantId: TENANT_ID,
    workerId: "worker-a",
    leaseMs: 60_000,
    now: "2026-08-06T01:01:00.000Z",
  });
  if (!job) throw new Error("test delivery job was not claimed");
  return { db, job, candidateId: candidate.id, deliveryId: delivery.id, artifactEnv };
}

function workerInput(value: ReturnType<typeof fixture>, github: GitHubDelivery) {
  const times = ["2026-08-06T01:01:01.000Z", "2026-08-06T01:01:02.000Z"];
  let cursor = 0;
  return {
    db: value.db,
    job: value.job,
    github,
    resolveRepository: vi.fn(async () => ({ owner: "acme", repo: "customer", baseBranch: "main" })),
    now: () => times[Math.min(cursor++, times.length - 1)]!,
    artifactEnv: value.artifactEnv,
  };
}

describe("Transformer adaptive GitLab draft delivery", () => {
  it("delivers an approved exact-draft candidate as a GitLab draft merge request", async () => {
    const value = fixture();
    const mock = new MockGitLabDelivery();
    const result = await runTransformerAdaptiveDelivery(workerInput(value, gitlabGithub(mock)));

    expect(result).toMatchObject({
      status: "delivered",
      candidateId: value.candidateId,
      deliveryId: value.deliveryId,
      pullRequestNumber: 1,
      pullRequestUrl: "https://gitlab.com/acme/customer/-/merge_requests/1",
    });

    expect(getAdaptiveCandidate(value.db, TENANT_ID, value.candidateId)?.status).toBe("promoted");
    const persisted = getAdaptiveDeliveryByCandidate(value.db, TENANT_ID, value.candidateId)!;
    expect(persisted).toMatchObject({
      status: "delivered",
      draftPr: true,
      draftPrNumber: 1,
      draftPrUrl: "https://gitlab.com/acme/customer/-/merge_requests/1",
    });
    expect(persisted.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(value.db.raw.prepare("SELECT status FROM jobs WHERE id = ?").get(value.job.id))
      .toEqual({ status: "done" });

    // The draft merge request is real and deduped: the same source/target
    // branch returns the same MR, and merge is never triggered here.
    const replay = await mock.openDraftMergeRequest(
      "acme",
      "customer",
      persisted.branchName!,
      "unused",
      "unused",
      "main",
    );
    expect(replay).toMatchObject({ number: 1, draft: true });
  });

  it("fails closed and does not deliver when GitLab returns a non-draft merge request", async () => {
    const value = fixture();
    const nonDraft: GitLabDelivery = {
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

    const result = await runTransformerAdaptiveDelivery(workerInput(value, gitlabGithub(nonDraft)));

    expect(result).toMatchObject({
      status: "delivery_failed",
      errorCode: "transformer_adaptive_delivery_terminal",
    });
    expect(getAdaptiveCandidate(value.db, TENANT_ID, value.candidateId)?.status).toBe("approved");
    expect(getAdaptiveDeliveryByCandidate(value.db, TENANT_ID, value.candidateId)).toMatchObject({
      status: "delivery_failed",
      commitSha: null,
    });
  });

  it("selects GitHub delivery when SCM_PROVIDER is unset and GitLab when it is gitlab", async () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-scm-select-"));
    roots.push(root);
    const db = createDb(join(root, "app.db"));
    databases.push(db);
    const intent: ExactDraftDeliveryInput = Object.freeze({
      owner: "acme",
      repo: "customer",
      baseBranch: "main",
      expectedBaseSha: BASE_SHA,
      branch: "mendpoint/transformer-select",
      commitMessage: "Apply approved Transformer candidate",
      commitDate: "2026-08-06T01:00:20.000Z",
      title: "Apply approved Transformer candidate",
      body: "Sealed exact-draft body.",
      files: Object.freeze([
        { path: "package.json", content: "{\"name\":\"customer\"}\n", mode: "100644" as const },
      ]),
    });

    // Unset provider routes to the GitHub path; without GITHUB_MODE=real it
    // refuses before any delivery, proving the GitHub delivery was selected.
    const githubSelected = transformerAdaptiveScmDelivery(db, TENANT_ID, { GITHUB_MODE: "mock" });
    await expect(githubSelected.deliverExactDraft(intent)).rejects.toThrow(
      "transformer_adaptive_delivery_real_github_required",
    );

    // SCM_PROVIDER=gitlab routes to the GitLab draft-MR path (mock by default).
    const gitlabSelected = transformerAdaptiveScmDelivery(db, TENANT_ID, { SCM_PROVIDER: "gitlab" });
    const result = await gitlabSelected.deliverExactDraft(intent);
    expect(result).toMatchObject({
      branch: "mendpoint/transformer-select",
      title: "Apply approved Transformer candidate",
      draft: true,
      baseBranch: "main",
      baseSha: BASE_SHA,
      url: "https://gitlab.com/acme/customer/-/merge_requests/1",
    });
  });
});
