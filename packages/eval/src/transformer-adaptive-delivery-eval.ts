import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createDb,
  enqueueAdaptiveDelivery,
  getAdaptiveCandidate,
  getAdaptiveDeliveryByCandidate,
  getJob,
  getRoutingLedgerForJob,
  insertConnectedRepository,
  insertRepositorySnapshot,
  insertRepositorySnapshotFiles,
  listAdaptiveCandidates,
  listAudit,
  listJobs,
  recordAudit,
  reviewAdaptiveCandidate,
  upsertScmConnection,
} from "@mendpoint/db";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  TransformerPilotExecutionStore,
  applyRecipe,
  createOrganizationConstraintContract,
  readAdaptiveCandidateArtifact,
  recipeFilesDigest,
  recipeReference,
  type RecipeFiles,
} from "@mendpoint/transformer";
import { processJobsOnce } from "@mendpoint/worker/job-runner";
import {
  runTransformerPilotLaneOnce,
  type RunTransformerPilotLaneInput,
} from "@mendpoint/worker/transformer-pilot-lane";
import {
  agentEvalDigest,
  evalGrade,
  type AgentEvalGrade,
  type AgentEvalScenario,
} from "./agent-eval-contract.js";

const TENANT_ID = "tenant-transformer-delivery-eval";
const OTHER_TENANT_ID = "tenant-transformer-delivery-other";
const CAMPAIGN_ID = "campaign-transformer-delivery-eval";
const UNIT_ID = "unit-transformer-delivery-eval";
const REPOSITORY_ID = "repository-transformer-delivery-eval";
const SNAPSHOT_ID = "snapshot-transformer-delivery-eval";
const SOURCE_REVISION = "a".repeat(40);
const CANDIDATE_REVISION = "c".repeat(40);
const CREATED_AT = "2026-08-06T12:00:00.000Z";
const RUN_AT = "2026-08-06T12:01:00.000Z";
const REVIEWED_AT = "2026-08-06T12:02:00.000Z";
const EXPIRES_AT = "2026-08-20T12:00:00.000Z";
const REVIEWER_ID = "human:transformer-delivery-reviewer";
const MODEL_POLICY_DIGEST = `sha256:${"9".repeat(64)}`;

const SOURCE_FILES: RecipeFiles = Object.freeze({
  "package.json": `${JSON.stringify({
    name: "transformer-adaptive-delivery-heldout",
    private: true,
    engines: { node: ">=18 <19" },
  }, null, 2)}\n`,
  ".nvmrc": "18\n",
  ".node-version": "18.20.4\n",
  Dockerfile: "FROM node:18-alpine\nWORKDIR /app\n",
});

type AdaptiveAdapter = NonNullable<
  ReturnType<NonNullable<RunTransformerPilotLaneInput["adaptivePlannerAdapterForTenant"]>>
>;
type AdaptiveProvenance = ReturnType<AdaptiveAdapter["provenance"]>[number];
type WorkerOptions = NonNullable<Parameters<typeof processJobsOnce>[1]>;
type EvalGitHubDelivery = NonNullable<WorkerOptions["transformerAdaptiveGithub"]>;
type ExactDraftDeliveryInput = Parameters<EvalGitHubDelivery["deliverExactDraft"]>[0];
type ExactDraftDeliveryResult = Awaited<
  ReturnType<EvalGitHubDelivery["deliverExactDraft"]>
>;

function materialize(root: string, files: RecipeFiles): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

function gateConfig(): string {
  return JSON.stringify({
    schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
    tenantAllowlist: [TENANT_ID],
    environmentAllowlist: ["staging"],
    grants: [{
      tenantId: TENANT_ID,
      environment: "staging",
      boundaries: ["worker_action"],
      acceptanceEvidenceRefs: ["acceptance:adaptive-delivery-heldout:v1"],
      productionDeliveryApprovalRefs: [],
    }],
  });
}

function createAdaptiveAdapter(): AdaptiveAdapter {
  const provenance: AdaptiveProvenance[] = [];
  const policy = Object.freeze({
    schemaVersion: 1 as const,
    approved: true as const,
    tenantId: TENANT_ID,
    provider: "heldout-openai-compatible",
    model: "heldout-adaptive-model",
    deployment: "heldout-us-central",
    approvedExternalProcessing: true as const,
    executionRegion: "us-central1",
    maximumDataClassification: "confidential" as const,
    endpoint: "https://models.example/v1/chat/completions",
    policyDigest: MODEL_POLICY_DIGEST,
  });
  return Object.freeze({
    policy,
    planner: async (input) => {
      const file = input.context.find((entry) => entry.path === "package.json");
      if (!file) throw new Error("heldout_adaptive_context_missing");
      const parsed = JSON.parse(file.content) as Record<string, unknown>;
      parsed.mendpointAdaptiveReview = "approved-candidate";
      provenance.push(Object.freeze({
        schemaVersion: 1 as const,
        tenantId: TENANT_ID,
        provider: policy.provider,
        configuredModel: policy.model,
        actualModel: policy.model,
        deployment: policy.deployment,
        approvedExternalProcessing: true as const,
        executionRegion: policy.executionRegion,
        maximumDataClassification: policy.maximumDataClassification,
        endpointHost: "models.example",
        endpointProtocol: "https:",
        policyDigest: policy.policyDigest,
        bodyRequestId: "adaptive-heldout-body-request",
        headerRequestId: "adaptive-heldout-header-request",
        promptTokens: 50,
        completionTokens: 15,
        totalTokens: 65,
        costUsd: 0.00008,
        monotonicTimestampMs: provenance.length + 1,
      }));
      return Object.freeze({
        plan: Object.freeze({
          edits: Object.freeze([Object.freeze({
            path: file.path,
            observedContentDigest: file.digest,
            nextContent: `${JSON.stringify(parsed, null, 2)}\n`,
          })]),
          rationale: "Repair the held out objective gate within the approved file boundary",
        }),
        usage: Object.freeze({
          modelCalled: true,
          promptTokens: 50,
          completionTokens: 15,
          totalTokens: 65,
          costUsd: 0.00008,
          model: policy.model,
        }),
      });
    },
    provenance: () => Object.freeze([...provenance]),
  });
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function criticalGrade(
  id: string,
  passed: boolean,
  expected: unknown,
  observed: unknown,
): AgentEvalGrade {
  return evalGrade({ id, critical: true, passed, expected, observed });
}

export const TRANSFORMER_ADAPTIVE_DELIVERY_EVAL_SCENARIO: AgentEvalScenario = Object.freeze({
  id: "transformer.adaptive.delivery.production_path.heldout",
  product: "transformer",
  family: "adaptive_review_delivery",
  tier: "recovery",
  critical: true,
  sourceRefs: Object.freeze([
    "https://docs.github.com/en/rest/git/refs",
    "https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request",
  ]),
  deterministic: true,
  evidenceLane: "simulated_scripted",
  budget: Object.freeze({
    maxDurationMs: 15_000,
    maxSteps: 40,
    maxChangedFiles: 4,
    maxChangedBytes: 32 * 1024,
    maxEvidenceBytes: 256 * 1024,
  }),
  run: async () => {
    const started = Date.now();
    const root = mkdtempSync(join(tmpdir(), "mendpoint-transformer-adaptive-delivery-eval-"));
    const snapshotRoot = join(root, "snapshot");
    const db = createDb(join(root, "mendpoint.sqlite"));
    const store = new TransformerPilotExecutionStore(join(root, "pilot.sqlite"));
    try {
      materialize(snapshotRoot, SOURCE_FILES);
      upsertScmConnection(db, {
        id: "connection-transformer-delivery-eval",
        tenantId: TENANT_ID,
        provider: "local_git",
        credentialRef: "env://TRANSFORMER_DELIVERY_EVAL",
        externalAccountId: TENANT_ID,
        displayName: "Transformer delivery held out",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      });
      insertConnectedRepository(db, {
        id: REPOSITORY_ID,
        tenantId: TENANT_ID,
        connectionId: "connection-transformer-delivery-eval",
        remoteId: `${TENANT_ID}/${REPOSITORY_ID}`,
        owner: TENANT_ID,
        name: REPOSITORY_ID,
        defaultBranch: "main",
        status: "ready",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      });
      insertRepositorySnapshot(db, {
        id: SNAPSHOT_ID,
        tenantId: TENANT_ID,
        repositoryId: REPOSITORY_ID,
        requestedRef: "main",
        resolvedSha: SOURCE_REVISION,
        manifestSha256: "b".repeat(64),
        storagePath: snapshotRoot,
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
      });
      insertRepositorySnapshotFiles(db, {
        tenantId: TENANT_ID,
        snapshotId: SNAPSHOT_ID,
        files: Object.entries(SOURCE_FILES).map(([path, content]) => ({
          path,
          mode: path === "package.json" ? "100755" : "100644",
          kind: "file",
          size: Buffer.byteLength(content, "utf8"),
          sha256: createHash("sha256").update(content, "utf8").digest("hex"),
        })),
      });
      const recipe = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
      const deterministic = applyRecipe(recipe, SOURCE_FILES);
      const constraints = createOrganizationConstraintContract({
        tenantId: TENANT_ID,
        organizationId: "organization-transformer-delivery-eval",
        version: 1,
        effectiveAt: CREATED_AT,
        sources: [{
          id: "policy-transformer-delivery-eval",
          kind: "explicit_policy",
          repositoryId: REPOSITORY_ID,
          revision: SOURCE_REVISION,
          digest: `sha256:${"d".repeat(64)}`,
          locator: `policy://heldout/${REPOSITORY_ID}/v1`,
          evidenceRefs: ["evidence:heldout-policy"],
        }],
        rules: [{
          id: "allow-transformer-delivery-eval",
          sourceId: "policy-transformer-delivery-eval",
          repositoryId: REPOSITORY_ID,
          pathPattern: "**",
          actions: ["change"],
          effect: "allow",
          ownerIds: ["owner-transformer-delivery-eval"],
          rationale: "Approved held out adaptive delivery fixture",
        }],
      });
      store.createCampaign({
        tenantId: TENANT_ID,
        organizationId: "organization-transformer-delivery-eval",
        environment: "staging",
        campaignId: CAMPAIGN_ID,
        constraints,
        units: [{
          id: UNIT_ID,
          title: "Migrate held out repository",
          ownerId: "owner-transformer-delivery-eval",
          reviewerIds: [REVIEWER_ID],
          dependsOn: [],
          snapshot: {
            snapshotId: SNAPSHOT_ID,
            repositoryId: REPOSITORY_ID,
            revision: SOURCE_REVISION,
            manifestSha256: "b".repeat(64),
            digest: recipeFilesDigest(SOURCE_FILES),
            evidenceRefs: ["evidence:heldout-snapshot"],
          },
          candidateRevision: CANDIDATE_REVISION,
          candidateDigest: deterministic.outputDigest,
          changedPaths: deterministic.operations.map((operation) => operation.path),
          recipe,
        }],
        observedAt: CREATED_AT,
        evidenceRefs: ["evidence:heldout-campaign"],
        idempotencyKey: "create-transformer-delivery-heldout",
        gateConfig: gateConfig(),
      });

      const adapter = createAdaptiveAdapter();
      const lane = await runTransformerPilotLaneOnce({
        db,
        store,
        gateConfig: gateConfig(),
        tenantId: TENANT_ID,
        workerId: "worker-transformer-adaptive-eval",
        evidenceRoot: join(root, "evidence"),
        candidateRoot: join(root, "candidates"),
        tempRoot: join(root, "workspaces"),
        adaptiveCandidateDataRoot: root,
        adaptivePlannerAdapterForTenant: () => adapter,
        authorizeAdaptiveExternalProcessing: () => Object.freeze({
          allowed: true,
          evidenceRef: "human-approval:heldout-adaptive-model",
        }),
        runId: "run-transformer-adaptive-delivery-eval",
        leaseToken: () => "transformer-adaptive-delivery-eval-lease",
        now: () => RUN_AT,
        commandRunner: async ({ cwd }) => {
          const passed = readFileSync(join(cwd, "package.json"), "utf8")
            .includes('"mendpointAdaptiveReview": "approved-candidate"');
          return Object.freeze({
            exitCode: passed ? 0 : 9,
            stdout: passed ? "verified" : "",
            stderr: passed ? "" : "deterministic candidate failed held out verification",
          });
        },
      });
      const candidate = listAdaptiveCandidates(db, TENANT_ID)[0]!;
      const pilotHandoff = store.getCampaign(TENANT_ID, CAMPAIGN_ID)
        ?.units[0]?.adaptiveCandidateHandoff;
      const artifact = readAdaptiveCandidateArtifact({
        tenantId: TENANT_ID,
        path: candidate.sealedPath,
        sha256: candidate.sealedSha256,
        env: { MENDPOINT_DATA_DIR: root },
      });
      const routing = getRoutingLedgerForJob(db, CAMPAIGN_ID, TENANT_ID);

      const tenantInvisible = getAdaptiveCandidate(db, OTHER_TENANT_ID, candidate.id) === undefined;
      let crossTenantError = "none";
      try {
        reviewAdaptiveCandidate(db, {
          tenantId: OTHER_TENANT_ID,
          id: candidate.id,
          decision: "approve",
          reviewerPrincipalId: "human:other-tenant-reviewer",
          now: REVIEWED_AT,
        });
      } catch (error) {
        crossTenantError = errorCode(error);
      }

      db.raw.exec("BEGIN IMMEDIATE");
      let delivery;
      try {
        const reviewed = reviewAdaptiveCandidate(db, {
          tenantId: TENANT_ID,
          id: candidate.id,
          decision: "approve",
          reviewerPrincipalId: REVIEWER_ID,
          rationale: "Approved the complete source to final migration after reviewing the sealed evidence.",
          now: REVIEWED_AT,
        });
        delivery = enqueueAdaptiveDelivery(db, {
          tenantId: TENANT_ID,
          candidateId: reviewed.id,
          repositoryId: reviewed.repositoryId,
          snapshotId: reviewed.snapshotId,
          baseBranch: reviewed.baseBranch,
          expectedBaseRevision: reviewed.expectedBaseRevision,
          requesterPrincipalId: REVIEWER_ID,
          now: REVIEWED_AT,
        });
        recordAudit(db, {
          id: "audit-transformer-adaptive-delivery-review",
          tenantId: TENANT_ID,
          actor: "operator",
          principalId: REVIEWER_ID,
          requestId: "request-transformer-adaptive-delivery-review",
          action: "transformer.adaptive_candidate.approved",
          resourceType: "transformer_adaptive_candidate",
          resourceId: candidate.id,
          metadata: {
            rationale: "Held out reviewer approved the exact sealed candidate",
            deliveryId: delivery.id,
            deliveryJobId: delivery.jobId,
          },
        });
        db.raw.exec("COMMIT");
      } catch (error) {
        if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
        throw error;
      }
      const replayedOutbox = enqueueAdaptiveDelivery(db, {
        tenantId: TENANT_ID,
        candidateId: candidate.id,
        repositoryId: candidate.repositoryId,
        snapshotId: candidate.snapshotId,
        baseBranch: candidate.baseBranch,
        expectedBaseRevision: candidate.expectedBaseRevision,
        requesterPrincipalId: REVIEWER_ID,
        now: REVIEWED_AT,
      });

      const branches = new Map<string, string>();
      const draftPullRequests = new Map<string, ExactDraftDeliveryResult>();
      const deliverExactDraft = async (
        input: ExactDraftDeliveryInput,
      ): Promise<ExactDraftDeliveryResult> => {
        if (input.expectedBaseSha !== SOURCE_REVISION) {
          throw new Error("github_exact_draft_base_revision_drift");
        }
        const commitSha = createHash("sha256")
          .update(JSON.stringify(input.files))
          .digest("hex")
          .slice(0, 40);
        const branchKey = `${input.owner}/${input.repo}/${input.branch}`;
        const existingCommit = branches.get(branchKey);
        if (existingCommit && existingCommit !== commitSha) {
          throw new Error("github_exact_draft_branch_diverged");
        }
        branches.set(branchKey, commitSha);
        const pullRequestKey = `${branchKey}/${input.baseBranch}`;
        const existingPullRequest = draftPullRequests.get(pullRequestKey);
        if (existingPullRequest) return existingPullRequest;
        const result = Object.freeze({
          number: draftPullRequests.size + 1,
          url: `https://github.com/${input.owner}/${input.repo}/pull/${draftPullRequests.size + 1}`,
          title: input.title,
          branch: input.branch,
          baseBranch: input.baseBranch,
          baseSha: input.expectedBaseSha,
          commitSha,
          draft: true as const,
        });
        draftPullRequests.set(pullRequestKey, result);
        return result;
      };
      const exactCalls: ExactDraftDeliveryInput[] = [];
      const exactResults: ExactDraftDeliveryResult[] = [];
      let legacyMutationCalls = 0;
      let transferLease = true;
      const github: EvalGitHubDelivery = {
        deliverExactDraft: async (input) => {
          exactCalls.push(input);
          const result = await deliverExactDraft(input);
          exactResults.push(result);
          if (transferLease) {
            transferLease = false;
            db.raw.prepare(
              `UPDATE jobs
               SET lease_owner = ?, lease_generation = lease_generation + 1,
                   lease_expires_at = ?
               WHERE id = ? AND tenant_id = ? AND status = 'running'`,
            ).run("worker-transformer-adaptive-successor", EXPIRES_AT, delivery.jobId, TENANT_ID);
          }
          return result;
        },
        createBranch: async () => {
          legacyMutationCalls++;
          throw new Error("heldout_legacy_github_path_forbidden");
        },
        commitFiles: async () => {
          legacyMutationCalls++;
          throw new Error("heldout_legacy_github_path_forbidden");
        },
        openPullRequest: async () => {
          legacyMutationCalls++;
          throw new Error("heldout_legacy_github_path_forbidden");
        },
      };
      const repositoryResolver = async () => Object.freeze({
        owner: TENANT_ID,
        repo: REPOSITORY_ID,
        baseBranch: "main",
      });
      const workerOptions = {
        tenantId: TENANT_ID,
        maxJobs: 1,
        leaseMs: 30_000,
        runWardenMaintenance: false,
        transformerAdaptiveGithub: github,
        transformerAdaptiveRepositoryResolver: repositoryResolver,
        wardenEnv: { MENDPOINT_DATA_DIR: root },
      } as const;
      const staleDrain = await processJobsOnce(db, {
        ...workerOptions,
        workerId: "worker-transformer-adaptive-original",
      });
      const staleCandidate = getAdaptiveCandidate(db, TENANT_ID, candidate.id)!;
      const staleDelivery = getAdaptiveDeliveryByCandidate(db, TENANT_ID, candidate.id)!;
      const staleJob = getJob(db, delivery.jobId, TENANT_ID)!;
      const staleAudit = listAudit(db, TENANT_ID);

      db.raw.prepare(
        "UPDATE jobs SET lease_expires_at = ? WHERE id = ? AND tenant_id = ? AND status = 'running'",
      ).run("2000-01-01T00:00:00.000Z", delivery.jobId, TENANT_ID);
      const successfulDrain = await processJobsOnce(db, {
        ...workerOptions,
        workerId: "worker-transformer-adaptive-successor",
      });
      const finalCandidate = getAdaptiveCandidate(db, TENANT_ID, candidate.id)!;
      const finalDelivery = getAdaptiveDeliveryByCandidate(db, TENANT_ID, candidate.id)!;
      const finalJob = getJob(db, delivery.jobId, TENANT_ID)!;
      const finalAudit = listAudit(db, TENANT_ID);

      const expectedFiles = [...artifact.changedPaths].sort().map((path) => ({
        path,
        content: artifact.files[path]!,
        mode: artifact.fileModes[path]!,
      }));
      const expectedDeliveryPaths = [...new Set(
        deterministic.operations.map((operation) => operation.path),
      )].sort();
      const deliveredFiles = exactCalls[0]?.files ?? [];
      const exactSealedBytes = JSON.stringify(deliveredFiles) === JSON.stringify(expectedFiles);
      const identicalReplay = exactCalls.length === 2 && exactResults.length === 2 &&
        JSON.stringify(exactCalls[0]) === JSON.stringify(exactCalls[1]) &&
        JSON.stringify(exactResults[0]) === JSON.stringify(exactResults[1]);

      let baseDriftError = "none";
      try {
        await deliverExactDraft({
          ...exactCalls[0]!,
          branch: "mendpoint/transformer-heldout-base-drift",
          expectedBaseSha: "f".repeat(40),
        });
      } catch (error) {
        baseDriftError = errorCode(error);
      }
      let divergentBranchError = "none";
      try {
        await deliverExactDraft({
          ...exactCalls[0]!,
          files: exactCalls[0]!.files.map((file, index) => index === 0
            ? "delete" in file
              ? file
              : { ...file, content: `${file.content}\nunsafe divergence` }
            : file),
        });
      } catch (error) {
        divergentBranchError = errorCode(error);
      }
      const pullCount = draftPullRequests.size;
      const jobs = listJobs(db, 20, TENANT_ID).filter((job) =>
        job.type === "transformer.adaptive.deliver"
      );
      const route = routing[0];
      const routeDecision = route
        ? JSON.parse(route.decision_json) as {
          action?: string;
          selectedExecutorId?: string;
          taskId?: string;
          tenantId?: string;
        }
        : undefined;
      const grades = Object.freeze([
        criticalGrade(
          "adaptive.production_lane_candidate",
          lane.attempted === 1 && lane.failed === 1 && candidate.status === "review_pending",
          "one routed adaptive attempt produces a review pending candidate",
          { lane, status: candidate.status },
        ),
        criticalGrade(
          "adaptive.routing_source_provenance",
          routing.length === 1 && route?.action === "human_handoff" &&
            routeDecision?.action === "execute" &&
            routeDecision.selectedExecutorId === route.selected_executor_id &&
            routeDecision.selectedExecutorId.startsWith("transformer-model-") &&
            routeDecision.taskId === CAMPAIGN_ID && routeDecision.tenantId === TENANT_ID &&
            route.task_snapshot_id === SNAPSHOT_ID && route.outcome === "failed" &&
            candidate.repositoryId === REPOSITORY_ID && candidate.snapshotId === SNAPSHOT_ID &&
            candidate.baseBranch === "main" && candidate.expectedBaseRevision === SOURCE_REVISION &&
            artifact.repositoryId === REPOSITORY_ID && artifact.snapshotId === SNAPSHOT_ID &&
            artifact.baseBranch === "main" && artifact.expectedBaseRevision === SOURCE_REVISION,
          "one production Transformer route, human handoff, and exact repository snapshot base provenance",
          { route, routeDecision, candidate, artifact: {
            repositoryId: artifact.repositoryId,
            snapshotId: artifact.snapshotId,
            baseBranch: artifact.baseBranch,
            expectedBaseRevision: artifact.expectedBaseRevision,
          } },
        ),
        criticalGrade(
          "adaptive.tenant_boundary",
          tenantInvisible && crossTenantError === "transformer_adaptive_candidate_not_found" &&
            getAdaptiveCandidate(db, TENANT_ID, candidate.id)?.reviewerPrincipalId === REVIEWER_ID,
          "another tenant cannot observe or approve; the direct human reviewer is durable",
          { tenantInvisible, crossTenantError, reviewer: finalCandidate.reviewerPrincipalId },
        ),
        criticalGrade(
          "adaptive.approval_outbox_atomic",
          delivery.id === replayedOutbox.id && delivery.jobId === replayedOutbox.jobId &&
            jobs.length === 1 && staleAudit.some((event) =>
              event.action === "transformer.adaptive_candidate.approved" &&
              event.principal_id === REVIEWER_ID
            ),
          "human approval, audit, and one deterministic outbox job",
          { deliveryId: delivery.id, replayDeliveryId: replayedOutbox.id, jobs: jobs.length },
        ),
        criticalGrade(
          "adaptive.sealed_bytes_only",
          exactSealedBytes &&
            JSON.stringify(deliveredFiles.map((file) => file.path)) ===
              JSON.stringify(expectedDeliveryPaths) &&
            (() => {
              const file = deliveredFiles.find((candidate) => candidate.path === "package.json");
              return file !== undefined && !("delete" in file) && file.mode === "100755";
            })() &&
            pilotHandoff?.fileModes["package.json"] === "100755" &&
            artifact.fileModes["package.json"] === "100755",
          expectedFiles,
          deliveredFiles,
        ),
        criticalGrade(
          "adaptive.stale_lease_no_promotion",
          staleDrain.claimed === 1 && staleDrain.succeeded === 0 && staleDrain.failed === 1 &&
            staleCandidate.status === "approved" && staleDelivery.status === "delivery_pending" &&
            staleJob.status === "running" && !staleAudit.some((event) =>
              event.action === "transformer.adaptive_candidate.delivered"
            ),
          "a lost lease leaves approval and outbox pending without promotion",
          { staleDrain, candidate: staleCandidate.status, delivery: staleDelivery.status, job: staleJob.status },
        ),
        criticalGrade(
          "adaptive.exact_draft_replay",
          identicalReplay && pullCount === 1 && legacyMutationCalls === 0 &&
            exactResults.every((result) => result.draft === true) &&
            exactResults.every((result) => result.baseSha === SOURCE_REVISION),
          "two identical exact-draft calls yield one draft PR and no legacy or force-capable mutation",
          { calls: exactCalls.length, results: exactResults, pullCount, legacyMutationCalls },
        ),
        criticalGrade(
          "adaptive.atomic_promotion",
          successfulDrain.claimed === 1 && successfulDrain.succeeded === 1 &&
            successfulDrain.failed === 0 && finalCandidate.status === "promoted" &&
            finalDelivery.status === "delivered" && finalDelivery.draftPr === true &&
            finalJob.status === "done" && finalAudit.some((event) =>
              event.action === "transformer.adaptive_candidate.delivered"
            ),
          "delivery, promotion, audit, and job completion commit together",
          {
            successfulDrain,
            candidate: finalCandidate.status,
            delivery: finalDelivery.status,
            draft: finalDelivery.draftPr,
            job: finalJob.status,
          },
        ),
        criticalGrade(
          "adaptive.base_and_branch_drift_fail_closed",
          baseDriftError === "github_exact_draft_base_revision_drift" &&
            divergentBranchError === "github_exact_draft_branch_diverged" &&
            draftPullRequests.size === 1,
          "base drift and a divergent deterministic branch are rejected without another PR",
          { baseDriftError, divergentBranchError, pullCount: draftPullRequests.size },
        ),
      ]);
      const passed = grades.every((grade) => grade.passed);
      const evidenceBytes = readdirSync(join(root, "evidence", "adaptive-model", TENANT_ID), {
        recursive: true,
        withFileTypes: true,
      }).filter((entry) => entry.isFile()).reduce((total, entry) => {
        const path = join(entry.parentPath, entry.name);
        return total + readFileSync(path).byteLength;
      }, 0);
      return Object.freeze({
        observation: Object.freeze({
          disposition: passed ? "passed" : "failed",
          semanticDigest: agentEvalDigest({
            grades: grades.map((grade) => [grade.id, grade.passed]),
            route: {
              action: route?.action,
              outcome: route?.outcome,
              taskSnapshotId: route?.task_snapshot_id,
            },
            candidate: finalCandidate.status,
            delivery: finalDelivery.status,
            job: finalJob.status,
            exactReplay: identicalReplay,
            pullCount,
            baseDriftError,
            divergentBranchError,
          }),
          metrics: Object.freeze({
            durationMs: Date.now() - started,
            steps: grades.length + exactCalls.length,
            changedFiles: deliveredFiles.length,
            changedBytes: deliveredFiles.reduce(
              (total, file) => total + ("delete" in file
                ? 0
                : Buffer.byteLength(file.content, "utf8")),
              0,
            ),
            evidenceBytes,
            modelCalls: adapter.provenance().length,
          }),
          details: Object.freeze({
            productionRouter: true,
            directDatabaseReviewFixture: true,
            authenticatedHumanApproval: false,
            deterministicOutbox: true,
            productionWorkerDelivery: true,
            exactDraftBoundary: true,
            staleLeaseRecovery: true,
            pullRequestCount: pullCount,
          }),
        }),
        grades,
      });
    } finally {
      store.close();
      db.raw.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
});
