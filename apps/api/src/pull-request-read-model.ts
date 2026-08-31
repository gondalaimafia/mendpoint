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

type NotificationPrecursorLink = Readonly<{
  id: string;
  connected_repository_id: string | null;
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

function resolveNotificationPrecursors(input: Readonly<{
  db: AppDb;
  tenantId: string;
  env: NodeJS.ProcessEnv;
}>): Readonly<{
  suppressedLegacyIds: ReadonlySet<string>;
  candidatesById: ReadonlyMap<string, PullRequestReadModelRow>;
}> {
  const candidateIds = input.db.raw.prepare(
    `SELECT id FROM fettler_candidate_deliveries
      WHERE tenant_id = ?
      ORDER BY requested_at DESC, id DESC`,
  ).all(input.tenantId) as Array<{ id: string }>;
  const candidatesById = new Map<string, PullRequestReadModelRow>();
  const suppressedLegacyIds = new Set<string>();

  for (const { id } of candidateIds) {
    const candidate = candidateToApi(input.db, input.tenantId, id, input.env);
    candidatesById.set(id, candidate);
    const providerChange = candidate.candidateDelivery?.providerChange;
    if (!providerChange) continue;

    const links = input.db.raw.prepare(
      `SELECT pr.id, cr.connected_repository_id
         FROM migration_prs pr
         JOIN consumers consumer ON consumer.id = pr.consumer_id
         LEFT JOIN consumer_repos cr ON cr.consumer_id = pr.consumer_id
        WHERE consumer.tenant_id = ?
          AND pr.status = 'notification_only'
          AND pr.change_id = ?
        ORDER BY pr.id, cr.id`,
    ).all(input.tenantId, providerChange.changeId) as NotificationPrecursorLink[];
    const repositoriesByPr = new Map<string, Set<string>>();
    for (const link of links) {
      const repositories = repositoriesByPr.get(link.id) ?? new Set<string>();
      if (link.connected_repository_id) repositories.add(link.connected_repository_id);
      repositoriesByPr.set(link.id, repositories);
    }

    const exact: string[] = [];
    for (const [legacyId, repositories] of repositoriesByPr) {
      if (!repositories.has(providerChange.repositoryId)) continue;
      if (repositories.size !== 1) {
        throw new Error("fettler_candidate_precursor_link_ambiguous");
      }
      exact.push(legacyId);
    }
    if (exact.length > 1) throw new Error("fettler_candidate_precursor_link_ambiguous");
    if (exact.length === 1) suppressedLegacyIds.add(exact[0]!);
  }

  return Object.freeze({ suppressedLegacyIds, candidatesById });
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
  const linked = resolveNotificationPrecursors({
    db: input.db,
    tenantId: input.tenantId,
    env: input.env ?? process.env,
  });
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
     ORDER BY sort_at DESC, id DESC`,
  ).all(input.tenantId, input.tenantId) as FeedCursor[];

  return cursors
    .filter((cursor) => cursor.source !== "legacy_migration" || !linked.suppressedLegacyIds.has(cursor.id))
    .slice(input.offset, input.offset + input.limit)
    .map((cursor) => {
      if (cursor.source === "fettler_candidate") {
        const candidate = linked.candidatesById.get(cursor.id);
        if (!candidate) throw new Error("fettler_candidate_delivery_read_missing");
        return candidate;
      }
      const row = getPr(input.db, cursor.id, input.tenantId);
      if (!row) throw new Error("migration_pr_read_missing");
      return Object.freeze({ ...prToApi(row), source: "legacy_migration" as const });
    });
}
