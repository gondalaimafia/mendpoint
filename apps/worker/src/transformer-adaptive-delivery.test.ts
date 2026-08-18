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
import type {
  ExactDraftDeliveryInput,
  ExactDraftDeliveryResult,
  GitHubDelivery,
} from "@mendpoint/github";
import {
  recipeFilesDigest,
  sealAdaptiveCandidate,
  type RecipeFiles,
} from "@mendpoint/transformer";
import { runTransformerAdaptiveDelivery } from "./transformer-adaptive-delivery.js";

const TENANT_ID = "tenant-a";
const REPOSITORY_ID = "repository-a";
const SNAPSHOT_ID = "snapshot-a";
const BASE_SHA = "a".repeat(40);
const COMMIT_SHA = "b".repeat(40);
const DIVERGED_DIGEST = `sha256:${"c".repeat(64)}`;
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

function githubWith(
  deliverExactDraft: (input: ExactDraftDeliveryInput) => Promise<ExactDraftDeliveryResult>,
): GitHubDelivery {
  return {
    deliverExactDraft,
    createBranch: async () => undefined,
    commitFiles: async () => undefined,
    openPullRequest: async () => ({
      number: 1,
      url: "https://github.com/acme/customer/pull/1",
      branch: "unused",
      title: "unused",
    }),
  };
}

function exactResult(input: ExactDraftDeliveryInput): ExactDraftDeliveryResult {
  return Object.freeze({
    number: 17,
    url: "https://github.com/acme/customer/pull/17",
    branch: input.branch,
    title: input.title,
    draft: true,
    baseBranch: input.baseBranch,
    baseSha: input.expectedBaseSha,
    commitSha: COMMIT_SHA,
  });
}

function fixture(options: Readonly<{
  maxAttempts?: number;
  artifactSnapshotId?: string;
  artifactBaseBranch?: string;
}> = {}): {
  db: AppDb;
  job: JobRow;
  candidateId: string;
  deliveryId: string;
  artifactEnv: NodeJS.ProcessEnv;
} {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-transformer-delivery-"));
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
    snapshotId: options.artifactSnapshotId ?? SNAPSHOT_ID,
    baseBranch: options.artifactBaseBranch ?? "main",
    expectedBaseRevision: BASE_SHA,
    divergedFromDigest: DIVERGED_DIGEST,
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
    divergedFromDigest: DIVERGED_DIGEST,
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
    maxAttempts: options.maxAttempts ?? 3,
    now: "2026-08-06T01:00:20.000Z",
  });
  const job = claimNextJob(db, ["transformer.adaptive.deliver"], {
    tenantId: TENANT_ID,
    workerId: "worker-a",
    leaseMs: 60_000,
    now: "2026-08-06T01:01:00.000Z",
  });
  if (!job) throw new Error("test delivery job was not claimed");
  return {
    db,
    job,
    candidateId: candidate.id,
    deliveryId: delivery.id,
    artifactEnv,
  };
}

function workerInput(
  value: ReturnType<typeof fixture>,
  github: GitHubDelivery,
  times = ["2026-08-06T01:01:01.000Z", "2026-08-06T01:01:02.000Z"],
) {
  let cursor = 0;
  return {
    db: value.db,
    job: value.job,
    github,
    resolveRepository: vi.fn(async () => ({
      owner: "acme",
      repo: "customer",
      baseBranch: "main",
    })),
    now: () => times[Math.min(cursor++, times.length - 1)]!,
    artifactEnv: value.artifactEnv,
  };
}

function claimRetry(
  value: ReturnType<typeof fixture>,
  now: string,
): ReturnType<typeof fixture> {
  const job = claimNextJob(value.db, ["transformer.adaptive.deliver"], {
    tenantId: TENANT_ID,
    workerId: "worker-a",
    leaseMs: 60_000,
    now,
  });
  if (!job) throw new Error("test delivery retry job was not claimed");
  return { ...value, job };
}

describe("Transformer adaptive draft delivery worker", () => {
  it("delivers the exact seal and commits delivery, promotion, then job completion", async () => {
    const value = fixture();
    value.db.raw.exec(`
      CREATE TRIGGER delivery_before_candidate_promotion
      BEFORE UPDATE OF status ON regauge_adaptive_candidates
      WHEN NEW.status = 'promoted'
      BEGIN
        SELECT CASE WHEN (
          SELECT status FROM regauge_adaptive_deliveries
          WHERE tenant_id = NEW.tenant_id AND candidate_id = NEW.id
        ) != 'delivered' THEN RAISE(ABORT, 'delivery must precede promotion') END;
      END;
      CREATE TRIGGER promotion_before_delivery_job_completion
      BEFORE UPDATE OF status ON jobs
      WHEN NEW.status = 'done' AND OLD.type = 'transformer.adaptive.deliver'
      BEGIN
        SELECT CASE WHEN (
          SELECT status FROM regauge_adaptive_candidates
          WHERE tenant_id = OLD.tenant_id
            AND id = json_extract(OLD.payload_json, '$.candidateId')
        ) != 'promoted' THEN RAISE(ABORT, 'promotion must precede completion') END;
      END;
    `);
    let deliveredInput: ExactDraftDeliveryInput | undefined;
    const github = githubWith(async (input) => {
      deliveredInput = input;
      return exactResult(input);
    });
    const input = workerInput(value, github);

    await expect(runTransformerAdaptiveDelivery(input)).resolves.toMatchObject({
      status: "delivered",
      candidateId: value.candidateId,
      deliveryId: value.deliveryId,
      pullRequestNumber: 17,
      commitSha: COMMIT_SHA,
    });

    expect(input.resolveRepository).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      repositoryId: REPOSITORY_ID,
      snapshotId: SNAPSHOT_ID,
      baseBranch: "main",
      expectedBaseRevision: BASE_SHA,
    });
    expect(deliveredInput).toMatchObject({
      owner: "acme",
      repo: "customer",
      baseBranch: "main",
      expectedBaseSha: BASE_SHA,
      commitDate: "2026-08-06T01:00:20.000Z",
      files: [
        { path: "package.json", content: FILES["package.json"], mode: "100644" },
        { path: "src/client.ts", content: FILES["src/client.ts"], mode: "100755" },
      ],
    });
    expect(deliveredInput?.branch).toMatch(/^mendpoint\/transformer-[a-f0-9]{24}$/);
    const deliveredCandidate = getAdaptiveCandidate(value.db, TENANT_ID, value.candidateId)!;
    expect(deliveredInput?.body).toBe([
      "This draft contains the exact sealed files approved for a Regauge adaptive candidate.",
      "",
      "## Rationale",
      "",
      "> Verified the exact proposed files",
      "> Risk is limited to the reviewed paths.",
      "",
      "## Reviewed evidence",
      "",
      `- Candidate: \`${value.candidateId}\``,
      `- Reviewed seal: \`${deliveredCandidate.sealedSha256}\``,
      `- Candidate digest: \`${deliveredCandidate.candidateDigest}\``,
      `- Deterministic candidate digest: \`${DIVERGED_DIGEST}\``,
      `- Source snapshot: \`${SNAPSHOT_ID}\``,
      `- Base: \`main\` at [\`${BASE_SHA}\`](https://github.com/acme/customer/commit/${BASE_SHA})`,
      "- Human review: approved by `reviewer-a` at `2026-08-06T01:00:10.000Z`",
      "- Changed paths at the reviewed base:",
      `  - [\`package.json\`](https://github.com/acme/customer/blob/${BASE_SHA}/package.json)`,
      `  - [\`src/client.ts\`](https://github.com/acme/customer/blob/${BASE_SHA}/src/client.ts)`,
      "",
      "## Structured change evidence",
      "",
      "| Path | Category | Risk | Confidence | Rationale |",
      "| --- | --- | --- | ---: | --- |",
      "| `package.json` | dependencies | medium | 92% | Remove the obsolete package declaration after verification. |",
      "| `src/client.ts` | behavior | medium | 92% | Apply the verified client migration behavior. |",
      "",
      "## Risk",
      "",
      "- Overall risk: `medium`.",
      "- Confidence: `92%`.",
      `This adaptive result differs from deterministic candidate \`${DIVERGED_DIGEST}\`. Changes are restricted to 2 reviewed files. This pull request is a draft and merge remains human controlled.`,
      "",
      "## Verification",
      "",
      "- Result: passed.",
      "- Summary: The objective verification passed on the sealed candidate.",
      "- Command: `verify-tests`.",
      `- Output digest: \`sha256:${createHash("sha256").update("passed").digest("hex")}\`.`,
      `- Adaptive repair converged on candidate digest \`${deliveredCandidate.candidateDigest}\`.`,
      "- Triggering failed check: `verify-tests`.",
      "- Delivery reverified the seal SHA, candidate digest, base revision, paths, and contents before creating this draft.",
    ].join("\n"));
    expect(getAdaptiveCandidate(value.db, TENANT_ID, value.candidateId)?.status).toBe("promoted");
    expect(getAdaptiveDeliveryByCandidate(value.db, TENANT_ID, value.candidateId)).toMatchObject({
      status: "delivered",
      commitSha: COMMIT_SHA,
      draftPr: true,
      draftPrNumber: 17,
    });
    expect(value.db.raw.prepare("SELECT status FROM jobs WHERE id = ?").get(value.job.id))
      .toEqual({ status: "done" });
    expect(value.db.raw.prepare(
      "SELECT action, resource_id FROM audit_events WHERE tenant_id = ? AND request_id = ?",
    ).get(TENANT_ID, value.job.id)).toEqual({
      action: "transformer.adaptive_candidate.delivered",
      resource_id: value.candidateId,
    });
  });

  it("rejects a stale lease before any GitHub mutation and leaves durable state unchanged", async () => {
    const value = fixture();
    const deliverExactDraft = vi.fn(async (input: ExactDraftDeliveryInput) => exactResult(input));
    value.db.raw
      .prepare(
        `UPDATE jobs SET lease_owner = 'worker-b', lease_generation = lease_generation + 1
         WHERE id = ?`,
      )
      .run(value.job.id);

    await expect(
      runTransformerAdaptiveDelivery(workerInput(value, githubWith(deliverExactDraft))),
    ).rejects.toThrow("transformer_adaptive_delivery_lease_lost");

    expect(deliverExactDraft).not.toHaveBeenCalled();
    expect(getAdaptiveCandidate(value.db, TENANT_ID, value.candidateId)?.status).toBe("approved");
    expect(getAdaptiveDeliveryByCandidate(value.db, TENANT_ID, value.candidateId)).toMatchObject({
      status: "delivery_pending",
      intentDigest: null,
      errorCode: null,
    });
  });

  it("schedules an exact replay when final persistence fails after GitHub succeeds", async () => {
    const value = fixture();
    value.db.raw.exec(`
      CREATE TRIGGER block_delivery_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'transformer.adaptive_candidate.delivered'
      BEGIN
        SELECT RAISE(ABORT, 'audit unavailable');
      END;
    `);
    const deliverExactDraft = vi.fn(async (input: ExactDraftDeliveryInput) => exactResult(input));

    await expect(runTransformerAdaptiveDelivery(
      workerInput(value, githubWith(deliverExactDraft)),
    )).resolves.toMatchObject({
      status: "retry_scheduled",
      errorCode: "transformer_adaptive_delivery_remote_side_effect_uncertain",
    });

    expect(deliverExactDraft).toHaveBeenCalledTimes(1);
    expect(getAdaptiveCandidate(value.db, TENANT_ID, value.candidateId)?.status).toBe("approved");
    expect(getAdaptiveDeliveryByCandidate(value.db, TENANT_ID, value.candidateId)).toMatchObject({
      status: "delivery_pending",
      commitSha: null,
      errorCode: "transformer_adaptive_delivery_remote_side_effect_uncertain",
    });
    expect(value.db.raw.prepare("SELECT status FROM jobs WHERE id = ?").get(value.job.id))
      .toEqual({ status: "pending" });
  });

  it("recovers exact finalization after the approved review window expires", async () => {
    const value = fixture();
    value.db.raw.exec(`
      CREATE TRIGGER block_delivery_audit_after_external_success
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'transformer.adaptive_candidate.delivered'
      BEGIN
        SELECT RAISE(ABORT, 'audit unavailable');
      END;
    `);
    const deliverExactDraft = vi.fn(async (input: ExactDraftDeliveryInput) => exactResult(input));

    await expect(runTransformerAdaptiveDelivery(workerInput(
      value,
      githubWith(deliverExactDraft),
      ["2026-08-06T01:01:01.000Z", "2026-08-06T01:01:02.000Z"],
    ))).resolves.toMatchObject({ status: "retry_scheduled" });
    value.db.raw.exec("DROP TRIGGER block_delivery_audit_after_external_success");

    const retry = claimRetry(value, "2026-08-06T03:00:00.000Z");
    await expect(runTransformerAdaptiveDelivery(workerInput(
      retry,
      githubWith(deliverExactDraft),
      ["2026-08-06T03:00:01.000Z", "2026-08-06T03:00:02.000Z"],
    ))).resolves.toMatchObject({
      status: "delivered",
      candidateId: value.candidateId,
      deliveryId: value.deliveryId,
    });

    expect(deliverExactDraft).toHaveBeenCalledTimes(2);
    expect(getAdaptiveCandidate(value.db, TENANT_ID, value.candidateId)?.status).toBe("promoted");
  });

  it("records retryable provider failure before scheduling the job retry", async () => {
    const value = fixture();
    const failure = Object.assign(new Error("GitHub temporarily unavailable"), { status: 503 });
    const github = githubWith(async () => {
      throw failure;
    });

    await expect(runTransformerAdaptiveDelivery(workerInput(value, github))).resolves.toEqual({
      status: "retry_scheduled",
      candidateId: value.candidateId,
      deliveryId: value.deliveryId,
      errorCode: "transformer_adaptive_delivery_retryable",
    });

    expect(getAdaptiveDeliveryByCandidate(value.db, TENANT_ID, value.candidateId)).toMatchObject({
      status: "delivery_pending",
      errorCode: "transformer_adaptive_delivery_retryable",
      errorMessage: "GitHub temporarily unavailable",
    });
    expect(value.db.raw.prepare("SELECT status, error_code FROM jobs WHERE id = ?").get(value.job.id))
      .toEqual({ status: "pending", error_code: "transformer_adaptive_delivery_retryable" });
  });

  it("retries a rate-limited approved delivery after the review window expires", async () => {
    const value = fixture();
    const deliverExactDraft = vi.fn(async (input: ExactDraftDeliveryInput) => {
      if (deliverExactDraft.mock.calls.length === 1) {
        throw Object.assign(new Error("GitHub rate limit"), { status: 429 });
      }
      return exactResult(input);
    });

    await expect(runTransformerAdaptiveDelivery(workerInput(
      value,
      githubWith(deliverExactDraft),
      ["2026-08-06T01:01:01.000Z", "2026-08-06T01:01:02.000Z"],
    ))).resolves.toMatchObject({ status: "retry_scheduled" });

    const retry = claimRetry(value, "2026-08-06T03:00:00.000Z");
    await expect(runTransformerAdaptiveDelivery(workerInput(
      retry,
      githubWith(deliverExactDraft),
      ["2026-08-06T03:00:01.000Z", "2026-08-06T03:00:02.000Z"],
    ))).resolves.toMatchObject({
      status: "delivered",
      candidateId: value.candidateId,
      deliveryId: value.deliveryId,
    });

    expect(deliverExactDraft).toHaveBeenCalledTimes(2);
    expect(getAdaptiveCandidate(value.db, TENANT_ID, value.candidateId)?.status).toBe("promoted");
  });

  it("records terminal failure before dead lettering the job", async () => {
    const value = fixture();
    value.db.raw.exec(`
      CREATE TRIGGER delivery_failure_before_dead_letter
      BEFORE UPDATE OF status ON jobs
      WHEN NEW.status = 'dead_letter' AND OLD.type = 'transformer.adaptive.deliver'
      BEGIN
        SELECT CASE WHEN (
          SELECT status FROM regauge_adaptive_deliveries
          WHERE job_id = OLD.id
        ) != 'delivery_failed' THEN RAISE(ABORT, 'failure must precede dead letter') END;
      END;
    `);
    const github = githubWith(async () => {
      throw new Error("github_exact_draft_base_revision_drift");
    });

    await expect(runTransformerAdaptiveDelivery(workerInput(value, github))).resolves.toEqual({
      status: "delivery_failed",
      candidateId: value.candidateId,
      deliveryId: value.deliveryId,
      errorCode: "transformer_adaptive_delivery_terminal",
    });
    expect(getAdaptiveDeliveryByCandidate(value.db, TENANT_ID, value.candidateId)).toMatchObject({
      status: "delivery_failed",
      errorCode: "transformer_adaptive_delivery_terminal",
    });
    expect(value.db.raw.prepare("SELECT status FROM jobs WHERE id = ?").get(value.job.id))
      .toEqual({ status: "dead_letter" });
  });

  it("marks an otherwise retryable failure terminal when attempts are exhausted", async () => {
    const value = fixture({ maxAttempts: 1 });
    const github = githubWith(async () => {
      throw Object.assign(new Error("provider timeout"), { code: "ETIMEDOUT" });
    });

    await expect(runTransformerAdaptiveDelivery(workerInput(value, github))).resolves.toEqual({
      status: "delivery_failed",
      candidateId: value.candidateId,
      deliveryId: value.deliveryId,
      errorCode: "transformer_adaptive_delivery_retry_exhausted",
    });
    expect(getAdaptiveDeliveryByCandidate(value.db, TENANT_ID, value.candidateId)).toMatchObject({
      status: "delivery_failed",
      errorCode: "transformer_adaptive_delivery_retry_exhausted",
    });
    expect(value.db.raw.prepare("SELECT status FROM jobs WHERE id = ?").get(value.job.id))
      .toEqual({ status: "dead_letter" });
  });

  it("never dead letters an exhausted job while GitHub creation may have succeeded", async () => {
    const value = fixture({ maxAttempts: 1 });
    const github = githubWith(async () => {
      throw Object.assign(
        new Error("github_exact_draft_remote_side_effect_uncertain"),
        {
          code: "GITHUB_EXACT_DRAFT_REMOTE_SIDE_EFFECT_UNCERTAIN",
          remoteSideEffectUncertain: true,
        },
      );
    });

    await expect(runTransformerAdaptiveDelivery(workerInput(value, github))).resolves.toEqual({
      status: "retry_scheduled",
      candidateId: value.candidateId,
      deliveryId: value.deliveryId,
      errorCode: "transformer_adaptive_delivery_remote_side_effect_uncertain",
    });
    expect(getAdaptiveDeliveryByCandidate(value.db, TENANT_ID, value.candidateId)).toMatchObject({
      status: "delivery_pending",
      errorCode: "transformer_adaptive_delivery_remote_side_effect_uncertain",
    });
    expect(value.db.raw.prepare("SELECT status, attempts FROM jobs WHERE id = ?").get(value.job.id))
      .toEqual({ status: "pending", attempts: 1 });
  });

  it("never dead letters an exhausted job when returned GitHub evidence is inconsistent", async () => {
    const value = fixture({ maxAttempts: 1 });
    const github = githubWith(async (input) => ({
      ...exactResult(input),
      branch: "mendpoint/unexpected-branch",
    }));

    await expect(runTransformerAdaptiveDelivery(workerInput(value, github))).resolves.toEqual({
      status: "retry_scheduled",
      candidateId: value.candidateId,
      deliveryId: value.deliveryId,
      errorCode: "transformer_adaptive_delivery_remote_side_effect_uncertain",
    });
    expect(getAdaptiveDeliveryByCandidate(value.db, TENANT_ID, value.candidateId)).toMatchObject({
      status: "delivery_pending",
      errorCode: "transformer_adaptive_delivery_remote_side_effect_uncertain",
    });
    expect(value.db.raw.prepare("SELECT status, attempts FROM jobs WHERE id = ?").get(value.job.id))
      .toEqual({ status: "pending", attempts: 1 });
  });

  it("never dead letters an exhausted job when finalization cannot begin", async () => {
    const value = fixture({ maxAttempts: 1 });
    let remoteReturned = false;
    let blocked = false;
    const originalExec = value.db.raw.exec.bind(value.db.raw);
    const exec = vi.spyOn(value.db.raw, "exec").mockImplementation((sql) => {
      if (remoteReturned && !blocked && sql.trim() === "BEGIN IMMEDIATE") {
        blocked = true;
        throw new Error("finalization database unavailable");
      }
      return originalExec(sql);
    });
    const github = githubWith(async (input) => {
      remoteReturned = true;
      return exactResult(input);
    });

    await expect(runTransformerAdaptiveDelivery(workerInput(value, github))).resolves.toEqual({
      status: "retry_scheduled",
      candidateId: value.candidateId,
      deliveryId: value.deliveryId,
      errorCode: "transformer_adaptive_delivery_remote_side_effect_uncertain",
    });
    exec.mockRestore();
    expect(blocked).toBe(true);
    expect(getAdaptiveDeliveryByCandidate(value.db, TENANT_ID, value.candidateId)).toMatchObject({
      status: "delivery_pending",
      errorCode: "transformer_adaptive_delivery_remote_side_effect_uncertain",
    });
    expect(value.db.raw.prepare("SELECT status, attempts FROM jobs WHERE id = ?").get(value.job.id))
      .toEqual({ status: "pending", attempts: 1 });
  });

  it("fails closed before GitHub when the sealed artifact binding differs from durable state", async () => {
    const value = fixture({ artifactSnapshotId: "snapshot-other" });
    const deliverExactDraft = vi.fn(async (input: ExactDraftDeliveryInput) => exactResult(input));
    const input = workerInput(value, githubWith(deliverExactDraft));

    await expect(runTransformerAdaptiveDelivery(input)).resolves.toMatchObject({
      status: "delivery_failed",
      errorCode: "transformer_adaptive_delivery_terminal",
    });

    expect(input.resolveRepository).not.toHaveBeenCalled();
    expect(deliverExactDraft).not.toHaveBeenCalled();
    expect(getAdaptiveDeliveryByCandidate(value.db, TENANT_ID, value.candidateId)?.status)
      .toBe("delivery_failed");
  });

  it("fails closed before GitHub when the sealed or resolved base branch differs", async () => {
    const sealedMismatch = fixture({ artifactBaseBranch: "release" });
    const sealedDelivery = vi.fn(async (input: ExactDraftDeliveryInput) => exactResult(input));
    await expect(runTransformerAdaptiveDelivery(
      workerInput(sealedMismatch, githubWith(sealedDelivery)),
    )).resolves.toMatchObject({
      status: "delivery_failed",
      errorCode: "transformer_adaptive_delivery_terminal",
    });
    expect(sealedDelivery).not.toHaveBeenCalled();

    const resolvedMismatch = fixture();
    const resolvedDelivery = vi.fn(async (input: ExactDraftDeliveryInput) => exactResult(input));
    const input = workerInput(resolvedMismatch, githubWith(resolvedDelivery));
    input.resolveRepository.mockResolvedValue({
      owner: "acme",
      repo: "customer",
      baseBranch: "release",
    });
    await expect(runTransformerAdaptiveDelivery(input)).resolves.toMatchObject({
      status: "delivery_failed",
      errorCode: "transformer_adaptive_delivery_terminal",
    });
    expect(resolvedDelivery).not.toHaveBeenCalled();
  });

  it("accepts only a payload containing candidateId", async () => {
    const value = fixture();
    value.job.payload_json = JSON.stringify({ candidateId: value.candidateId, extra: true });
    const deliverExactDraft = vi.fn(async (input: ExactDraftDeliveryInput) => exactResult(input));

    await expect(
      runTransformerAdaptiveDelivery(workerInput(value, githubWith(deliverExactDraft))),
    ).rejects.toThrow("transformer_adaptive_delivery_payload_invalid");

    expect(deliverExactDraft).not.toHaveBeenCalled();
    expect(getAdaptiveDeliveryByCandidate(value.db, TENANT_ID, value.candidateId)).toMatchObject({
      status: "delivery_pending",
      intentDigest: null,
    });
  });
});
