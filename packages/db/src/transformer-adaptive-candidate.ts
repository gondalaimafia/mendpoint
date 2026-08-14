import { createHash } from "node:crypto";
import type { AppDb } from "./index.js";

/**
 * Durable review state for Transformer adaptive candidates.
 *
 * A converged adaptive fix that DIVERGES from the deterministic recipe output is
 * never auto-promoted. It is recorded here as a distinct `kind: "adaptive"` row
 * that must receive explicit human sign-off before it can be promoted. The row
 * carries the deterministic digest it diverged from and the failing verification
 * that triggered adaptation, so an approver knows exactly what they are signing
 * off. Because these rows are the only carrier of adaptive candidates and the
 * table enforces `kind = 'adaptive'`, a recipe-candidate code path can never
 * approve one of them.
 */

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const COMMIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const BRANCH = /^(?!\/)(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;

export type AdaptiveCandidateStatus =
  | "review_pending"
  | "approved"
  | "rejected"
  | "superseded"
  | "promoted"
  | "expired";

export type AdaptiveReviewDecision = "approve" | "reject" | "regenerate";

/**
 * Selective review-tier of an adaptive candidate. Scales the REQUIRED human
 * sign-off strength; it never lets a candidate skip human review.
 *
 *   - `standard`  : the existing single-human-approval path, unchanged.
 *   - `escalated` : requires a second, distinct human escalation sign-off ON TOP
 *                   of the normal approval before it can be approved/delivered.
 *   - `blocked`   : held; cannot be approved or promoted until the blocker clears.
 *
 * The tier is computed once (deterministically) from the sealed review evidence
 * at record time and persisted. The default is `standard`, so an unconfigured
 * flow behaves exactly as today.
 */
export type AdaptiveReviewTier = "standard" | "escalated" | "blocked";

const REVIEW_TIERS = new Set<AdaptiveReviewTier>(["standard", "escalated", "blocked"]);

function requireTier(value: unknown, code: string): AdaptiveReviewTier {
  if (typeof value !== "string" || !REVIEW_TIERS.has(value as AdaptiveReviewTier)) {
    throw new Error(code);
  }
  return value as AdaptiveReviewTier;
}

export type TransformerAdaptiveCandidateRecord = Readonly<{
  id: string;
  tenantId: string;
  campaignId: string;
  unitId: string;
  attemptId: string;
  repositoryId: string;
  snapshotId: string;
  baseBranch: string;
  expectedBaseRevision: string;
  kind: "adaptive";
  status: AdaptiveCandidateStatus;
  reviewTier: AdaptiveReviewTier;
  divergedFromDigest: string;
  candidateDigest: string;
  failingCommandId: string | null;
  /**
   * Deterministic migration classification labels for the learning corpus. Pure
   * metadata captured at seal time; null for legacy rows and where the recipe
   * binding is undeterminable. They never influence review, promotion, or delivery.
   */
  family: string | null;
  provider: string | null;
  framework: string | null;
  sealedPath: string;
  sealedSha256: string;
  changedPaths: readonly string[];
  reviewerPrincipalId: string | null;
  reviewDecision: AdaptiveReviewDecision | null;
  reviewRationale: string | null;
  reviewedAt: string | null;
  escalationReviewerPrincipalId: string | null;
  escalationReviewedAt: string | null;
  escalationRationale: string | null;
  promotedAt: string | null;
  supersedesCandidateId: string | null;
  supersededByCandidateId: string | null;
  generation: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}>;

type Row = {
  id: string;
  tenant_id: string;
  campaign_id: string;
  unit_id: string;
  attempt_id: string;
  repository_id: string;
  snapshot_id: string;
  base_branch: string;
  expected_base_revision: string;
  kind: string;
  status: string;
  review_tier: string | null;
  diverged_from_digest: string;
  candidate_digest: string;
  failing_command_id: string | null;
  family: string | null;
  provider: string | null;
  framework: string | null;
  sealed_path: string;
  sealed_sha256: string;
  changed_paths_json: string;
  reviewer_principal_id: string | null;
  review_decision: string | null;
  review_rationale: string | null;
  reviewed_at: string | null;
  escalation_reviewer_principal_id: string | null;
  escalation_reviewed_at: string | null;
  escalation_rationale: string | null;
  promoted_at: string | null;
  supersedes_candidate_id: string | null;
  superseded_by_candidate_id: string | null;
  generation: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

function requiredString(value: unknown, code: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(code);
  }
  return value.trim();
}

function requireDigest(value: unknown, code: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(code);
  return value;
}

function requireIdentifier(value: unknown, code: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(code);
  return value;
}

function requireBranch(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !BRANCH.test(value) ||
    value.endsWith("/") ||
    value.endsWith(".lock")
  ) {
    throw new Error(code);
  }
  return value;
}

function requireTimestamp(value: unknown, code: string): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) throw new Error(code);
  return value;
}

const LABEL_FAMILIES = new Set([
  "sdk",
  "framework",
  "runtime",
  "internal_api",
  "warden-provider",
]);

/**
 * Normalize a corpus classification label to a stored value. Classification is
 * metadata, so this NEVER throws: an unknown family or an out-of-shape label
 * coerces to null rather than blocking the candidate record. A pre-labeling
 * (legacy) column reads as null and the candidate keeps today's behavior.
 */
function normalizeLabel(value: unknown, isFamily: boolean): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return null;
  if (isFamily && !LABEL_FAMILIES.has(trimmed)) return null;
  return trimmed;
}

/** Deterministic id so recording the same converged attempt is idempotent. */
function candidateId(
  tenantId: string,
  campaignId: string,
  unitId: string,
  attemptId: string,
): string {
  const digest = createHash("sha256")
    .update([tenantId, campaignId, unitId, attemptId].join("\0"), "utf8")
    .digest("hex");
  return `tfadapt_${digest.slice(0, 32)}`;
}

function mapRow(row: Row): TransformerAdaptiveCandidateRecord {
  if (row.kind !== "adaptive") throw new Error("transformer_adaptive_candidate_kind_invalid");
  let changedPaths: readonly string[];
  try {
    const parsed = JSON.parse(row.changed_paths_json) as unknown;
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
      throw new Error("transformer_adaptive_candidate_corrupt");
    }
    changedPaths = Object.freeze(parsed as string[]);
  } catch {
    throw new Error("transformer_adaptive_candidate_corrupt");
  }
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    campaignId: row.campaign_id,
    unitId: row.unit_id,
    attemptId: row.attempt_id,
    repositoryId: row.repository_id,
    snapshotId: row.snapshot_id,
    baseBranch: requireBranch(
      row.base_branch,
      "transformer_adaptive_candidate_base_branch_invalid",
    ),
    expectedBaseRevision: row.expected_base_revision,
    kind: "adaptive",
    status: row.status as AdaptiveCandidateStatus,
    // A pre-tiering row (added column defaulted) reads as `standard`, so legacy
    // candidates keep the existing single-approval behavior.
    reviewTier: requireTier(
      row.review_tier ?? "standard",
      "transformer_adaptive_candidate_tier_invalid",
    ),
    divergedFromDigest: row.diverged_from_digest,
    candidateDigest: row.candidate_digest,
    failingCommandId: row.failing_command_id,
    family: normalizeLabel(row.family, true),
    provider: normalizeLabel(row.provider, false),
    framework: normalizeLabel(row.framework, false),
    sealedPath: row.sealed_path,
    sealedSha256: row.sealed_sha256,
    changedPaths,
    reviewerPrincipalId: row.reviewer_principal_id,
    reviewDecision: (row.review_decision as AdaptiveReviewDecision | null) ?? null,
    reviewRationale: row.review_rationale,
    reviewedAt: row.reviewed_at,
    escalationReviewerPrincipalId: row.escalation_reviewer_principal_id,
    escalationReviewedAt: row.escalation_reviewed_at,
    escalationRationale: row.escalation_rationale,
    promotedAt: row.promoted_at,
    supersedesCandidateId: row.supersedes_candidate_id,
    supersededByCandidateId: row.superseded_by_candidate_id,
    generation: row.generation,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function loadRow(
  db: AppDb,
  tenantId: string,
  id: string,
): TransformerAdaptiveCandidateRecord | undefined {
  const row = db.raw
    .prepare("SELECT * FROM regauge_adaptive_candidates WHERE id = ? AND tenant_id = ?")
    .get(id, tenantId) as Row | undefined;
  return row ? mapRow(row) : undefined;
}

export type RecordAdaptiveCandidateInput = Readonly<{
  tenantId: string;
  campaignId: string;
  unitId: string;
  attemptId: string;
  repositoryId: string;
  snapshotId: string;
  baseBranch: string;
  expectedBaseRevision: string;
  divergedFromDigest: string;
  candidateDigest: string;
  failingCommandId: string | null;
  /**
   * Deterministic migration classification labels (corpus metadata). Optional and
   * default null; an unknown or out-of-shape value is stored as null. They never
   * change any control-flow decision.
   */
  family?: string | null;
  provider?: string | null;
  framework?: string | null;
  sealedPath: string;
  sealedSha256: string;
  changedPaths: readonly string[];
  /** Required human-review tier. Defaults to `standard` (today's behavior). */
  reviewTier?: AdaptiveReviewTier;
  expiresAt: string;
  now?: string;
}>;

/**
 * Record a converged adaptive candidate in the review-pending state. Idempotent
 * per (tenant, campaign, unit, attempt): re-recording the identical sealed
 * candidate returns the existing row; a different seal for the same attempt is a
 * conflict and fails closed.
 */
export function recordAdaptiveCandidate(
  db: AppDb,
  input: RecordAdaptiveCandidateInput,
): TransformerAdaptiveCandidateRecord {
  const tenantId = requiredString(input.tenantId, "transformer_adaptive_candidate_tenant_invalid", 200);
  const campaignId = requireIdentifier(input.campaignId, "transformer_adaptive_candidate_campaign_invalid");
  const unitId = requireIdentifier(input.unitId, "transformer_adaptive_candidate_unit_invalid");
  const attemptId = requireIdentifier(input.attemptId, "transformer_adaptive_candidate_attempt_invalid");
  const repositoryId = requireIdentifier(
    input.repositoryId,
    "transformer_adaptive_candidate_repository_invalid",
  );
  const snapshotId = requireIdentifier(
    input.snapshotId,
    "transformer_adaptive_candidate_snapshot_invalid",
  );
  const baseBranch = requireBranch(
    input.baseBranch,
    "transformer_adaptive_candidate_base_branch_invalid",
  );
  if (!COMMIT_REVISION.test(input.expectedBaseRevision)) {
    throw new Error("transformer_adaptive_candidate_expected_base_invalid");
  }
  const expectedBaseRevision = input.expectedBaseRevision;
  const divergedFromDigest = requireDigest(input.divergedFromDigest, "transformer_adaptive_candidate_diverged_digest_invalid");
  const candidateDigest = requireDigest(input.candidateDigest, "transformer_adaptive_candidate_candidate_digest_invalid");
  if (divergedFromDigest === candidateDigest) {
    throw new Error("transformer_adaptive_candidate_not_divergent");
  }
  const sealedSha256 = requireDigest(input.sealedSha256, "transformer_adaptive_candidate_seal_digest_invalid");
  const sealedPath = requiredString(input.sealedPath, "transformer_adaptive_candidate_seal_path_invalid", 4_000);
  const failingCommandId = input.failingCommandId === null
    ? null
    : requiredString(input.failingCommandId, "transformer_adaptive_candidate_failing_command_invalid", 256);
  if (!Array.isArray(input.changedPaths) || input.changedPaths.length === 0) {
    throw new Error("transformer_adaptive_candidate_changed_paths_invalid");
  }
  const changedPaths = input.changedPaths.map((value) =>
    requiredString(value, "transformer_adaptive_candidate_changed_paths_invalid", 1_000),
  );
  const reviewTier = input.reviewTier === undefined
    ? "standard"
    : requireTier(input.reviewTier, "transformer_adaptive_candidate_tier_invalid");
  const family = normalizeLabel(input.family, true);
  const provider = normalizeLabel(input.provider, false);
  const framework = normalizeLabel(input.framework, false);
  const expiresAt = requireTimestamp(input.expiresAt, "transformer_adaptive_candidate_expiry_invalid");
  const now = input.now ? requireTimestamp(input.now, "transformer_adaptive_candidate_now_invalid") : new Date().toISOString();
  const id = candidateId(tenantId, campaignId, unitId, attemptId);

  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = loadRow(db, tenantId, id);
    if (existing) {
      if (
        existing.candidateDigest !== candidateDigest ||
        existing.divergedFromDigest !== divergedFromDigest ||
        existing.sealedSha256 !== sealedSha256 ||
        existing.repositoryId !== repositoryId ||
        existing.snapshotId !== snapshotId ||
        existing.baseBranch !== baseBranch ||
        existing.expectedBaseRevision !== expectedBaseRevision
      ) {
        throw new Error("transformer_adaptive_candidate_conflict");
      }
      if (ownsTransaction) db.raw.exec("COMMIT");
      return existing;
    }
    const regeneration = db.raw.prepare(
      `SELECT regeneration.id, regeneration.candidate_id, candidate.generation
       FROM regauge_adaptive_regenerations regeneration
       JOIN regauge_adaptive_candidates candidate
         ON candidate.id = regeneration.candidate_id
        AND candidate.tenant_id = regeneration.tenant_id
       WHERE regeneration.tenant_id = ?
         AND regeneration.campaign_id = ?
         AND regeneration.unit_id = ?
         AND regeneration.status = 'scheduled'
         AND regeneration.superseding_candidate_id IS NULL
       ORDER BY regeneration.requested_at, regeneration.id
       LIMIT 1`,
    ).get(tenantId, campaignId, unitId) as {
      id: string;
      candidate_id: string;
      generation: number;
    } | undefined;
    const supersedesCandidateId = regeneration?.candidate_id ?? null;
    const generation = regeneration ? regeneration.generation + 1 : 1;
    db.raw
      .prepare(
        `INSERT INTO regauge_adaptive_candidates
          (id, tenant_id, campaign_id, unit_id, attempt_id, repository_id,
           snapshot_id, base_branch, expected_base_revision, kind, status, review_tier,
           diverged_from_digest, candidate_digest, failing_command_id,
           family, provider, framework,
           sealed_path, sealed_sha256, changed_paths_json,
           reviewer_principal_id, review_decision, review_rationale, reviewed_at, promoted_at,
           escalation_reviewer_principal_id, escalation_reviewed_at, escalation_rationale,
           supersedes_candidate_id, superseded_by_candidate_id, generation,
           expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'adaptive', 'review_pending', ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        id,
        tenantId,
        campaignId,
        unitId,
        attemptId,
        repositoryId,
        snapshotId,
        baseBranch,
        expectedBaseRevision,
        reviewTier,
        divergedFromDigest,
        candidateDigest,
        failingCommandId,
        family,
        provider,
        framework,
        sealedPath,
        sealedSha256,
        JSON.stringify(changedPaths),
        supersedesCandidateId,
        generation,
        expiresAt,
        now,
        now,
      );
    if (regeneration) {
      const linkedPrior = db.raw.prepare(
        `UPDATE regauge_adaptive_candidates
         SET superseded_by_candidate_id = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'superseded'
           AND superseded_by_candidate_id IS NULL`,
      ).run(id, now, regeneration.candidate_id, tenantId);
      if (Number(linkedPrior.changes) !== 1) {
        throw new Error("transformer_adaptive_candidate_lineage_conflict");
      }
      const linkedRequest = db.raw.prepare(
        `UPDATE regauge_adaptive_regenerations
         SET status = 'completed', superseding_candidate_id = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'scheduled'
           AND superseding_candidate_id IS NULL`,
      ).run(id, now, now, regeneration.id, tenantId);
      if (Number(linkedRequest.changes) !== 1) {
        throw new Error("transformer_adaptive_candidate_lineage_conflict");
      }
    }
    if (ownsTransaction) db.raw.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
  return loadRow(db, tenantId, id)!;
}

export function getAdaptiveCandidate(
  db: AppDb,
  tenantId: string,
  id: string,
): TransformerAdaptiveCandidateRecord | undefined {
  return loadRow(db, requiredString(tenantId, "transformer_adaptive_candidate_tenant_invalid", 200), requiredString(id, "transformer_adaptive_candidate_id_invalid", 200));
}

export function listAdaptiveCandidates(
  db: AppDb,
  tenantId: string,
  campaignId?: string,
  limit = 50,
): TransformerAdaptiveCandidateRecord[] {
  const safeTenant = requiredString(tenantId, "transformer_adaptive_candidate_tenant_invalid", 200);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("transformer_adaptive_candidate_limit_invalid");
  }
  const rows = campaignId === undefined
    ? db.raw
        .prepare("SELECT * FROM regauge_adaptive_candidates WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
        .all(safeTenant, limit) as Row[]
    : db.raw
        .prepare("SELECT * FROM regauge_adaptive_candidates WHERE tenant_id = ? AND campaign_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
        .all(
          safeTenant,
          requiredString(campaignId, "transformer_adaptive_candidate_campaign_invalid", 200),
          limit,
        ) as Row[];
  return rows.map(mapRow);
}

/** The default sealed-artifact quota bounds every candidate requiring attention. */
export const MAX_ADAPTIVE_ATTENTION_CANDIDATES = 256;

export function listAdaptiveAttentionCandidates(
  db: AppDb,
  tenantId: string,
  campaignId?: string,
): TransformerAdaptiveCandidateRecord[] {
  const safeTenant = requiredString(
    tenantId,
    "transformer_adaptive_candidate_tenant_invalid",
    200,
  );
  const params: Array<string | number> = [safeTenant];
  const campaignFilter = campaignId === undefined
    ? ""
    : " AND campaign_id = ?";
  if (campaignId !== undefined) {
    params.push(requiredString(
      campaignId,
      "transformer_adaptive_candidate_campaign_invalid",
      200,
    ));
  }
  params.push(MAX_ADAPTIVE_ATTENTION_CANDIDATES + 1);
  const rows = db.raw
    .prepare(
      `SELECT * FROM regauge_adaptive_candidates
       WHERE tenant_id = ?${campaignFilter}
         AND status IN ('review_pending', 'approved')
       ORDER BY CASE status WHEN 'review_pending' THEN 0 ELSE 1 END,
                expires_at, created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...params) as Row[];
  if (rows.length > MAX_ADAPTIVE_ATTENTION_CANDIDATES) {
    throw new Error("transformer_adaptive_candidate_attention_quota_exceeded");
  }
  return rows.map(mapRow);
}

export type AdaptiveCandidateHistoryCursor = Readonly<{
  updatedAt: string;
  id: string;
}>;

export type AdaptiveCandidateHistoryPage = Readonly<{
  records: readonly TransformerAdaptiveCandidateRecord[];
  nextCursor: AdaptiveCandidateHistoryCursor | null;
}>;

export function listAdaptiveCandidateHistory(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    campaignId?: string;
    limit?: number;
    cursor?: AdaptiveCandidateHistoryCursor;
  }>,
): AdaptiveCandidateHistoryPage {
  const tenantId = requiredString(
    input.tenantId,
    "transformer_adaptive_candidate_tenant_invalid",
    200,
  );
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("transformer_adaptive_candidate_history_limit_invalid");
  }
  const clauses = [
    "tenant_id = ?",
    "status IN ('rejected', 'superseded', 'promoted', 'expired')",
  ];
  const params: Array<string | number> = [tenantId];
  if (input.campaignId !== undefined) {
    clauses.push("campaign_id = ?");
    params.push(requiredString(
      input.campaignId,
      "transformer_adaptive_candidate_campaign_invalid",
      200,
    ));
  }
  if (input.cursor) {
    const updatedAt = requireTimestamp(
      input.cursor.updatedAt,
      "transformer_adaptive_candidate_history_cursor_invalid",
    );
    const id = requiredString(
      input.cursor.id,
      "transformer_adaptive_candidate_history_cursor_invalid",
      200,
    );
    clauses.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
    params.push(updatedAt, updatedAt, id);
  }
  params.push(limit + 1);
  const rows = db.raw
    .prepare(
      `SELECT * FROM regauge_adaptive_candidates
       WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...params) as Row[];
  const pageRows = rows.slice(0, limit);
  const last = rows.length > limit ? pageRows[pageRows.length - 1] : undefined;
  return Object.freeze({
    records: Object.freeze(pageRows.map(mapRow)),
    nextCursor: last
      ? Object.freeze({ updatedAt: last.updated_at, id: last.id })
      : null,
  });
}

/**
 * Enumerate tenants and their complete adaptive candidate ledger for bounded
 * worker maintenance. Artifact storage is already quota bounded per tenant, so
 * this avoids a page boundary that could make an older live seal look orphaned.
 */
export function listAdaptiveCandidateTenantIds(db: AppDb): string[] {
  const rows = db.raw
    .prepare("SELECT DISTINCT tenant_id FROM regauge_adaptive_candidates ORDER BY tenant_id")
    .all() as Array<{ tenant_id: string }>;
  return rows.map((row) => requiredString(
    row.tenant_id,
    "transformer_adaptive_candidate_tenant_invalid",
    200,
  ));
}

export function listAdaptiveCandidatesForMaintenance(
  db: AppDb,
  tenantId: string,
): TransformerAdaptiveCandidateRecord[] {
  const safeTenant = requiredString(
    tenantId,
    "transformer_adaptive_candidate_tenant_invalid",
    200,
  );
  const rows = db.raw
    .prepare(
      "SELECT * FROM regauge_adaptive_candidates WHERE tenant_id = ? ORDER BY id",
    )
    .all(safeTenant) as Row[];
  return rows.map(mapRow);
}

export type ReviewAdaptiveCandidateInput = Readonly<{
  tenantId: string;
  id: string;
  decision: Exclude<AdaptiveReviewDecision, "regenerate">;
  reviewerPrincipalId: string;
  rationale?: string;
  now?: string;
}>;

/**
 * Apply a human review decision to an adaptive candidate. Only a review_pending
 * row can transition; re-applying the same decision is idempotent. The row's
 * `kind = 'adaptive'` invariant is re-asserted so this can never mutate a
 * recipe-candidate record.
 */
export function reviewAdaptiveCandidate(
  db: AppDb,
  input: ReviewAdaptiveCandidateInput,
): TransformerAdaptiveCandidateRecord {
  const tenantId = requiredString(input.tenantId, "transformer_adaptive_candidate_tenant_invalid", 200);
  const id = requiredString(input.id, "transformer_adaptive_candidate_id_invalid", 200);
  if (input.decision !== "approve" && input.decision !== "reject") {
    throw new Error("transformer_adaptive_candidate_decision_invalid");
  }
  const reviewerPrincipalId = requiredString(input.reviewerPrincipalId, "transformer_adaptive_candidate_reviewer_invalid", 200);
  const rationale = input.rationale === undefined
    ? null
    : requiredString(input.rationale, "transformer_adaptive_candidate_review_rationale_invalid", 2_000);
  const now = input.now ? requireTimestamp(input.now, "transformer_adaptive_candidate_now_invalid") : new Date().toISOString();
  const nextStatus: AdaptiveCandidateStatus = input.decision === "approve" ? "approved" : "rejected";

  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const current = loadRow(db, tenantId, id);
    if (!current) throw new Error("transformer_adaptive_candidate_not_found");
    if (current.kind !== "adaptive") throw new Error("transformer_adaptive_candidate_kind_invalid");
    if (
      current.status === "review_pending" &&
      Date.parse(now) >= Date.parse(current.expiresAt)
    ) {
      db.raw
        .prepare(
          `UPDATE regauge_adaptive_candidates
           SET status = 'expired', updated_at = ?
           WHERE id = ? AND tenant_id = ? AND kind = 'adaptive'
             AND status = 'review_pending' AND expires_at <= ?`,
        )
        .run(now, id, tenantId, now);
      if (ownsTransaction) db.raw.exec("COMMIT");
      return loadRow(db, tenantId, id)!;
    }
    if (
      (current.status === "approved" || current.status === "rejected") &&
      current.reviewDecision === input.decision
    ) {
      if (rationale !== null && current.reviewRationale !== rationale) {
        throw new Error("transformer_adaptive_candidate_review_conflict");
      }
      if (ownsTransaction) db.raw.exec("COMMIT");
      return current;
    }
    if (current.status !== "review_pending") {
      throw new Error("transformer_adaptive_candidate_not_pending");
    }
    // Selective review tiering. Every existing approval guard is preserved; the
    // tier requirement is ADDED on top of an approval, never in place of one.
    // A rejection is always permitted (it never delivers anything).
    if (input.decision === "approve") {
      // Blocked: held, not deliverable until the blocker clears (e.g. regenerate).
      if (current.reviewTier === "blocked") {
        throw new Error("transformer_adaptive_candidate_blocked");
      }
      // Escalated: a single standard approval is insufficient. A second, DISTINCT
      // human must have recorded an escalation sign-off first.
      if (
        current.reviewTier === "escalated" &&
        (current.escalationReviewerPrincipalId === null ||
          current.escalationReviewerPrincipalId === reviewerPrincipalId)
      ) {
        throw new Error("transformer_adaptive_candidate_escalation_required");
      }
    }
    const changed = db.raw
      .prepare(
        `UPDATE regauge_adaptive_candidates
         SET status = ?, review_decision = ?, review_rationale = ?, reviewer_principal_id = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND kind = 'adaptive'
           AND status = 'review_pending' AND expires_at > ?`,
      )
      .run(nextStatus, input.decision, rationale, reviewerPrincipalId, now, now, id, tenantId, now);
    if (Number(changed.changes) !== 1) throw new Error("transformer_adaptive_candidate_review_conflict");
    if (ownsTransaction) db.raw.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
  return loadRow(db, tenantId, id)!;
}

export type SignOffAdaptiveEscalationInput = Readonly<{
  tenantId: string;
  id: string;
  reviewerPrincipalId: string;
  rationale: string;
  now?: string;
}>;

/**
 * Record the second, DISTINCT human escalation sign-off required by an
 * `escalated` candidate. This does NOT approve or promote anything — it only
 * satisfies the added tier requirement so that a later approval (by a different
 * reviewer) may proceed through the unchanged standard path. Only an escalated,
 * still-pending candidate can be signed off; re-signing with the identical
 * reviewer and rationale is idempotent, and a second distinct signer conflicts.
 */
export function signOffAdaptiveEscalation(
  db: AppDb,
  input: SignOffAdaptiveEscalationInput,
): TransformerAdaptiveCandidateRecord {
  const tenantId = requiredString(input.tenantId, "transformer_adaptive_candidate_tenant_invalid", 200);
  const id = requiredString(input.id, "transformer_adaptive_candidate_id_invalid", 200);
  const reviewerPrincipalId = requiredString(
    input.reviewerPrincipalId,
    "transformer_adaptive_candidate_reviewer_invalid",
    200,
  );
  const rationale = requiredString(
    input.rationale,
    "transformer_adaptive_candidate_review_rationale_invalid",
    2_000,
  );
  const now = input.now
    ? requireTimestamp(input.now, "transformer_adaptive_candidate_now_invalid")
    : new Date().toISOString();

  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const current = loadRow(db, tenantId, id);
    if (!current) throw new Error("transformer_adaptive_candidate_not_found");
    if (current.kind !== "adaptive") throw new Error("transformer_adaptive_candidate_kind_invalid");
    if (current.reviewTier !== "escalated") {
      throw new Error("transformer_adaptive_candidate_escalation_not_required");
    }
    if (
      current.status === "review_pending" &&
      Date.parse(now) >= Date.parse(current.expiresAt)
    ) {
      db.raw
        .prepare(
          `UPDATE regauge_adaptive_candidates
           SET status = 'expired', updated_at = ?
           WHERE id = ? AND tenant_id = ? AND kind = 'adaptive'
             AND status = 'review_pending' AND expires_at <= ?`,
        )
        .run(now, id, tenantId, now);
      if (ownsTransaction) db.raw.exec("COMMIT");
      return loadRow(db, tenantId, id)!;
    }
    if (current.escalationReviewerPrincipalId !== null) {
      if (
        current.escalationReviewerPrincipalId === reviewerPrincipalId &&
        current.escalationRationale === rationale
      ) {
        if (ownsTransaction) db.raw.exec("COMMIT");
        return current;
      }
      throw new Error("transformer_adaptive_candidate_escalation_conflict");
    }
    if (current.status !== "review_pending") {
      throw new Error("transformer_adaptive_candidate_not_pending");
    }
    const changed = db.raw
      .prepare(
        `UPDATE regauge_adaptive_candidates
         SET escalation_reviewer_principal_id = ?, escalation_reviewed_at = ?,
             escalation_rationale = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND kind = 'adaptive'
           AND review_tier = 'escalated' AND status = 'review_pending'
           AND escalation_reviewer_principal_id IS NULL AND expires_at > ?`,
      )
      .run(reviewerPrincipalId, now, rationale, now, id, tenantId, now);
    if (Number(changed.changes) !== 1) {
      throw new Error("transformer_adaptive_candidate_escalation_conflict");
    }
    if (ownsTransaction) db.raw.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
  return loadRow(db, tenantId, id)!;
}

export type AdaptiveRegenerationStatus = "pending" | "scheduled" | "completed";

export type TransformerAdaptiveRegenerationRecord = Readonly<{
  id: string;
  tenantId: string;
  candidateId: string;
  campaignId: string;
  unitId: string;
  reviewerPrincipalId: string;
  rationale: string;
  rationaleDigest: string;
  status: AdaptiveRegenerationStatus;
  attemptCount: number;
  lastErrorCode: string | null;
  supersedingCandidateId: string | null;
  requestedAt: string;
  scheduledAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}>;

type RegenerationRow = {
  id: string;
  tenant_id: string;
  candidate_id: string;
  campaign_id: string;
  unit_id: string;
  reviewer_principal_id: string;
  rationale: string;
  rationale_digest: string;
  status: AdaptiveRegenerationStatus;
  attempt_count: number;
  last_error_code: string | null;
  superseding_candidate_id: string | null;
  requested_at: string;
  scheduled_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

function mapRegeneration(row: RegenerationRow): TransformerAdaptiveRegenerationRecord {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    candidateId: row.candidate_id,
    campaignId: row.campaign_id,
    unitId: row.unit_id,
    reviewerPrincipalId: row.reviewer_principal_id,
    rationale: row.rationale,
    rationaleDigest: row.rationale_digest,
    status: row.status,
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
    supersedingCandidateId: row.superseding_candidate_id,
    requestedAt: row.requested_at,
    scheduledAt: row.scheduled_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  });
}

function loadRegeneration(
  db: AppDb,
  tenantId: string,
  id: string,
): TransformerAdaptiveRegenerationRecord | undefined {
  const row = db.raw.prepare(
    "SELECT * FROM regauge_adaptive_regenerations WHERE id = ? AND tenant_id = ?",
  ).get(id, tenantId) as RegenerationRow | undefined;
  return row ? mapRegeneration(row) : undefined;
}

function regenerationId(tenantId: string, candidateIdValue: string): string {
  return `tfregen_${createHash("sha256")
    .update([tenantId, candidateIdValue, "regenerate"].join("\0"), "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

export function getAdaptiveRegenerationByCandidate(
  db: AppDb,
  tenantId: string,
  candidateIdValue: string,
): TransformerAdaptiveRegenerationRecord | undefined {
  const row = db.raw.prepare(
    `SELECT * FROM regauge_adaptive_regenerations
     WHERE tenant_id = ? AND candidate_id = ?`,
  ).get(
    requiredString(tenantId, "transformer_adaptive_candidate_tenant_invalid", 200),
    requiredString(candidateIdValue, "transformer_adaptive_candidate_id_invalid", 200),
  ) as RegenerationRow | undefined;
  return row ? mapRegeneration(row) : undefined;
}

export function requestAdaptiveCandidateRegeneration(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    id: string;
    reviewerPrincipalId: string;
    rationale: string;
    now?: string;
  }>,
): Readonly<{
  candidate: TransformerAdaptiveCandidateRecord;
  regeneration: TransformerAdaptiveRegenerationRecord;
}> {
  const tenantId = requiredString(input.tenantId, "transformer_adaptive_candidate_tenant_invalid", 200);
  const id = requiredString(input.id, "transformer_adaptive_candidate_id_invalid", 200);
  const reviewerPrincipalId = requiredString(
    input.reviewerPrincipalId,
    "transformer_adaptive_candidate_reviewer_invalid",
    200,
  );
  const rationale = requiredString(
    input.rationale,
    "transformer_adaptive_candidate_review_rationale_invalid",
    2_000,
  );
  const now = input.now
    ? requireTimestamp(input.now, "transformer_adaptive_candidate_now_invalid")
    : new Date().toISOString();
  const requestId = regenerationId(tenantId, id);
  const rationaleDigest = `sha256:${createHash("sha256").update(rationale, "utf8").digest("hex")}`;

  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const current = loadRow(db, tenantId, id);
    if (!current) throw new Error("transformer_adaptive_candidate_not_found");
    const prior = loadRegeneration(db, tenantId, requestId);
    if (prior) {
      if (
        current.status !== "superseded" ||
        current.reviewDecision !== "regenerate" ||
        current.reviewerPrincipalId !== reviewerPrincipalId ||
        current.reviewRationale !== rationale ||
        prior.candidateId !== id ||
        prior.reviewerPrincipalId !== reviewerPrincipalId ||
        prior.rationaleDigest !== rationaleDigest
      ) {
        throw new Error("transformer_adaptive_candidate_review_conflict");
      }
      if (ownsTransaction) db.raw.exec("COMMIT");
      return Object.freeze({ candidate: current, regeneration: prior });
    }
    if (current.status === "review_pending" && Date.parse(now) >= Date.parse(current.expiresAt)) {
      throw new Error("transformer_adaptive_candidate_expired");
    }
    if (current.status !== "review_pending") {
      throw new Error("transformer_adaptive_candidate_not_pending");
    }
    const changed = db.raw.prepare(
      `UPDATE regauge_adaptive_candidates
       SET status = 'superseded', review_decision = 'regenerate', review_rationale = ?,
           reviewer_principal_id = ?, reviewed_at = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND kind = 'adaptive'
         AND status = 'review_pending' AND expires_at > ?`,
    ).run(rationale, reviewerPrincipalId, now, now, id, tenantId, now);
    if (Number(changed.changes) !== 1) {
      throw new Error("transformer_adaptive_candidate_review_conflict");
    }
    db.raw.prepare(
      `INSERT INTO regauge_adaptive_regenerations
        (id, tenant_id, candidate_id, campaign_id, unit_id, reviewer_principal_id,
         rationale, rationale_digest, status, attempt_count, last_error_code,
         superseding_candidate_id, requested_at, scheduled_at, completed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, NULL, NULL, ?)`,
    ).run(
      requestId,
      tenantId,
      id,
      current.campaignId,
      current.unitId,
      reviewerPrincipalId,
      rationale,
      rationaleDigest,
      now,
      now,
    );
    if (ownsTransaction) db.raw.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
  return Object.freeze({
    candidate: loadRow(db, tenantId, id)!,
    regeneration: loadRegeneration(db, tenantId, requestId)!,
  });
}

export function listPendingAdaptiveRegenerations(
  db: AppDb,
  tenantId?: string,
  limit = 25,
): TransformerAdaptiveRegenerationRecord[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("transformer_adaptive_regeneration_limit_invalid");
  }
  const rows = tenantId === undefined
    ? db.raw.prepare(
        `SELECT * FROM regauge_adaptive_regenerations
         WHERE status = 'pending' ORDER BY requested_at, id LIMIT ?`,
      ).all(limit) as RegenerationRow[]
    : db.raw.prepare(
        `SELECT * FROM regauge_adaptive_regenerations
         WHERE tenant_id = ? AND status = 'pending'
         ORDER BY requested_at, id LIMIT ?`,
      ).all(
        requiredString(tenantId, "transformer_adaptive_candidate_tenant_invalid", 200),
        limit,
      ) as RegenerationRow[];
  return rows.map(mapRegeneration);
}

export function markAdaptiveRegenerationScheduled(
  db: AppDb,
  input: Readonly<{ tenantId: string; id: string; observedAt: string }>,
): TransformerAdaptiveRegenerationRecord {
  const tenantId = requiredString(input.tenantId, "transformer_adaptive_candidate_tenant_invalid", 200);
  const id = requiredString(input.id, "transformer_adaptive_regeneration_id_invalid", 200);
  const observedAt = requireTimestamp(input.observedAt, "transformer_adaptive_candidate_now_invalid");
  const current = loadRegeneration(db, tenantId, id);
  if (!current) throw new Error("transformer_adaptive_regeneration_not_found");
  if (current.status === "scheduled" || current.status === "completed") return current;
  const changed = db.raw.prepare(
    `UPDATE regauge_adaptive_regenerations
     SET status = 'scheduled', attempt_count = attempt_count + 1,
         last_error_code = NULL, scheduled_at = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
  ).run(observedAt, observedAt, id, tenantId);
  if (Number(changed.changes) !== 1) {
    throw new Error("transformer_adaptive_regeneration_schedule_conflict");
  }
  return loadRegeneration(db, tenantId, id)!;
}

/**
 * Keep a regeneration request recoverably pending when customer authorization
 * for external processing is absent. An identical block is a true no-op and
 * never consumes a regeneration attempt.
 */
export function markAdaptiveRegenerationBlocked(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    id: string;
    reason: string;
    observedAt: string;
  }>,
): TransformerAdaptiveRegenerationRecord {
  const tenantId = requiredString(input.tenantId, "transformer_adaptive_candidate_tenant_invalid", 200);
  const id = requiredString(input.id, "transformer_adaptive_regeneration_id_invalid", 200);
  const reason = requiredString(input.reason, "transformer_adaptive_regeneration_error_invalid", 500);
  const observedAt = requireTimestamp(input.observedAt, "transformer_adaptive_candidate_now_invalid");
  const current = loadRegeneration(db, tenantId, id);
  if (!current) throw new Error("transformer_adaptive_regeneration_not_found");
  if (current.status !== "pending" || current.lastErrorCode === reason) return current;
  const changed = db.raw.prepare(
    `UPDATE regauge_adaptive_regenerations
     SET last_error_code = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
  ).run(reason, observedAt, id, tenantId);
  if (Number(changed.changes) !== 1) {
    throw new Error("transformer_adaptive_regeneration_schedule_conflict");
  }
  return loadRegeneration(db, tenantId, id)!;
}

export function recordAdaptiveRegenerationScheduleFailure(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    id: string;
    errorCode: string;
    observedAt: string;
  }>,
): TransformerAdaptiveRegenerationRecord {
  const tenantId = requiredString(input.tenantId, "transformer_adaptive_candidate_tenant_invalid", 200);
  const id = requiredString(input.id, "transformer_adaptive_regeneration_id_invalid", 200);
  const errorCode = requiredString(input.errorCode, "transformer_adaptive_regeneration_error_invalid", 500);
  const observedAt = requireTimestamp(input.observedAt, "transformer_adaptive_candidate_now_invalid");
  const changed = db.raw.prepare(
    `UPDATE regauge_adaptive_regenerations
     SET attempt_count = attempt_count + 1, last_error_code = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
  ).run(errorCode, observedAt, id, tenantId);
  if (Number(changed.changes) !== 1) {
    throw new Error("transformer_adaptive_regeneration_schedule_conflict");
  }
  return loadRegeneration(db, tenantId, id)!;
}

export type PromoteAdaptiveCandidateInput = Readonly<{
  tenantId: string;
  id: string;
  now?: string;
}>;

/**
 * Mark an approved adaptive candidate as promoted. Only an `approved` row may be
 * promoted; promoting an already-promoted row is idempotent. Callers must read
 * the sealed artifact (reverifying its digest) to obtain the promoted files.
 */
export function promoteAdaptiveCandidate(
  db: AppDb,
  input: PromoteAdaptiveCandidateInput,
): TransformerAdaptiveCandidateRecord {
  const tenantId = requiredString(input.tenantId, "transformer_adaptive_candidate_tenant_invalid", 200);
  const id = requiredString(input.id, "transformer_adaptive_candidate_id_invalid", 200);
  const now = input.now ? requireTimestamp(input.now, "transformer_adaptive_candidate_now_invalid") : new Date().toISOString();

  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const current = loadRow(db, tenantId, id);
    if (!current) throw new Error("transformer_adaptive_candidate_not_found");
    if (current.status === "promoted") {
      if (ownsTransaction) db.raw.exec("COMMIT");
      return current;
    }
    if (current.status !== "approved") throw new Error("transformer_adaptive_candidate_not_approved");
    const changed = db.raw
      .prepare(
        `UPDATE regauge_adaptive_candidates
         SET status = 'promoted', promoted_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND kind = 'adaptive'
           AND status = 'approved'`,
      )
      .run(now, now, id, tenantId);
    if (Number(changed.changes) !== 1) throw new Error("transformer_adaptive_candidate_promote_conflict");
    if (ownsTransaction) db.raw.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
  return loadRow(db, tenantId, id)!;
}

export type ExpireAdaptiveCandidateInput = Readonly<{
  tenantId: string;
  id: string;
  observedAt: string;
}>;

/**
 * Expire a review-pending adaptive candidate once the retention window has
 * elapsed. Human approval is durable: an approved candidate remains eligible
 * for its already-enqueued draft delivery even if the review window later ends.
 */
export function expireAdaptiveCandidate(
  db: AppDb,
  input: ExpireAdaptiveCandidateInput,
): TransformerAdaptiveCandidateRecord {
  const tenantId = requiredString(input.tenantId, "transformer_adaptive_candidate_tenant_invalid", 200);
  const id = requiredString(input.id, "transformer_adaptive_candidate_id_invalid", 200);
  const observedAt = requireTimestamp(input.observedAt, "transformer_adaptive_candidate_now_invalid");

  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const current = loadRow(db, tenantId, id);
    if (!current) throw new Error("transformer_adaptive_candidate_not_found");
    if (current.status === "expired") {
      if (ownsTransaction) db.raw.exec("COMMIT");
      return current;
    }
    if (current.status !== "review_pending") {
      throw new Error("transformer_adaptive_candidate_not_expirable");
    }
    if (Date.parse(observedAt) < Date.parse(current.expiresAt)) {
      throw new Error("transformer_adaptive_candidate_not_expired");
    }
    const changed = db.raw
      .prepare(
        `UPDATE regauge_adaptive_candidates
         SET status = 'expired', updated_at = ?
         WHERE id = ? AND tenant_id = ? AND kind = 'adaptive'
           AND status = 'review_pending'`,
      )
      .run(observedAt, id, tenantId);
    if (Number(changed.changes) !== 1) throw new Error("transformer_adaptive_candidate_expire_conflict");
    if (ownsTransaction) db.raw.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
  return loadRow(db, tenantId, id)!;
}
