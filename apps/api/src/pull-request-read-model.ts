import {
  CandidateReviewEvidenceSchema,
  type CandidateReviewEvidence,
} from "@mendpoint/shared";
import {
  parseFettlerProviderChangeEvidence,
  readWardenApprovalArtifact,
  type FettlerProviderChangeEvidence,
} from "@mendpoint/agent";
import {
  getPr,
  getWardenCandidateDelivery,
  prToApi,
  type AppDb,
  type WardenCandidateDeliveryRecord,
} from "@mendpoint/db";

type FeedCursor = Readonly<{
  id: string;
  source: "legacy_migration" | "fettler_candidate";
}>;

export type FettlerCandidatePrEvidence = Readonly<{
  source: "fettler_candidate";
  runId: string;
  deliveryStatus: WardenCandidateDeliveryRecord["status"];
  outcome: WardenCandidateDeliveryRecord["outcome"];
  repositoryId: string;
  snapshotId: string;
  baseBranch: string;
  expectedBaseRevision: string;
  deliveredBaseRevision: string | null;
  deliveredCommitSha: string | null;
  providerChange: FettlerProviderChangeEvidence | null;
  proposedMigration: Readonly<{
    summary: string;
    edits: readonly Readonly<{
      path: string;
      explanation: string;
      risk: "low" | "medium" | "high" | null;
      confidence: number | null;
    }>[];
  }>;
  verification: Readonly<{
    summary: string;
    commands: readonly Readonly<{
      command: string;
      outputSha256: string;
    }>[];
  }>;
  changedPaths: readonly string[];
}>;

export type PullRequestReadModelRow = ReturnType<typeof prToApi> & Readonly<{
  source: "legacy_migration" | "fettler_candidate";
  candidateDelivery?: FettlerCandidatePrEvidence;
}>;

function riskFromReview(review: CandidateReviewEvidence): string {
  const risks = review.edits.map((edit) => edit.risk).filter((risk): risk is "low" | "medium" | "high" => Boolean(risk));
  if (risks.includes("high")) return "high";
  if (risks.includes("medium")) return "medium";
  if (risks.includes("low")) return "low";
  return "unknown";
}

function candidateToApi(
  db: AppDb,
  tenantId: string,
  id: string,
  env: NodeJS.ProcessEnv,
): PullRequestReadModelRow {
  const delivery = getWardenCandidateDelivery(db, tenantId, id);
  if (!delivery) throw new Error("fettler_candidate_delivery_read_missing");
  const artifact = readWardenApprovalArtifact({
    tenantId,
    path: delivery.sealedPath,
    sha256: delivery.sealedSha256,
    env,
  });
  const review = CandidateReviewEvidenceSchema.parse(artifact.reviewEvidence);
  const providerChange = artifact.fettlerProviderChange === undefined
    ? null
    : parseFettlerProviderChangeEvidence(artifact.fettlerProviderChange);
  const changedPaths = review.edits.map((edit) => edit.path);

  return Object.freeze({
    id: delivery.id,
    changeId: providerChange?.changeId ?? delivery.runId,
    consumerId: delivery.repositoryId,
    title: review.summary,
    body: review.verification.summary,
    branchName: delivery.branchName ?? delivery.baseBranch,
    status: delivery.status,
    risk: riskFromReview(review),
    patchUnified: "",
    githubPrNumber: delivery.draftPrNumber,
    githubPrUrl: delivery.draftPrUrl,
    createdAt: delivery.requestedAt,
    resolvedAt: delivery.deliveredAt ?? delivery.failedAt,
    coverage: null,
    source: "fettler_candidate",
    candidateDelivery: Object.freeze({
      source: "fettler_candidate",
      runId: delivery.runId,
      deliveryStatus: delivery.status,
      outcome: delivery.outcome,
      repositoryId: delivery.repositoryId,
      snapshotId: delivery.snapshotId,
      baseBranch: delivery.baseBranch,
      expectedBaseRevision: delivery.expectedBaseRevision,
      deliveredBaseRevision: delivery.baseRevision,
      deliveredCommitSha: delivery.commitSha,
      providerChange,
      proposedMigration: Object.freeze({
        summary: review.summary,
        edits: Object.freeze(review.edits.map((edit) => Object.freeze({
          path: edit.path,
          explanation: "hypothesis" in edit
            ? edit.hypothesis
            : edit.rationale ?? "No rationale was recorded.",
          risk: edit.risk ?? null,
          confidence: edit.confidence,
        }))),
      }),
      verification: Object.freeze({
        summary: review.verification.summary,
        commands: Object.freeze(review.verification.commands.map((command) => Object.freeze({
          command: command.command,
          outputSha256: command.outputSha256,
        }))),
      }),
      changedPaths: Object.freeze(changedPaths),
    }),
  });
}

/**
 * Tenant scoped, chronologically merged read model for legacy migration rows and
 * sealed Fettler candidate deliveries. Candidate prose is read only from the
 * digest verified approval artifact. Any malformed seal aborts the whole read,
 * allowing the caller to report an unavailable feed instead of a false empty or
 * unverified candidate.
 */
export function listPullRequestReadModel(input: Readonly<{
  db: AppDb;
  tenantId: string;
  limit: number;
  offset: number;
  env?: NodeJS.ProcessEnv;
}>): PullRequestReadModelRow[] {
  if (!input.tenantId.trim()) throw new Error("tenant_scope_required");
  const cursors = input.db.raw.prepare(
    `SELECT id, source FROM (
       SELECT pr.id AS id, 'legacy_migration' AS source, pr.created_at AS sort_at
         FROM migration_prs pr
         JOIN consumers c ON c.id = pr.consumer_id
        WHERE c.tenant_id = ?
       UNION ALL
       SELECT delivery.id AS id, 'fettler_candidate' AS source, delivery.requested_at AS sort_at
         FROM fettler_candidate_deliveries delivery
        WHERE delivery.tenant_id = ?
     )
     ORDER BY sort_at DESC, id DESC
     LIMIT ? OFFSET ?`,
  ).all(input.tenantId, input.tenantId, input.limit, input.offset) as FeedCursor[];

  return cursors.map((cursor) => {
    if (cursor.source === "fettler_candidate") {
      return candidateToApi(input.db, input.tenantId, cursor.id, input.env ?? process.env);
    }
    const row = getPr(input.db, cursor.id, input.tenantId);
    if (!row) throw new Error("migration_pr_read_missing");
    return Object.freeze({ ...prToApi(row), source: "legacy_migration" as const });
  });
}
