import { createHash } from "node:crypto";
import {
  addLearningDatasetMember,
  createLearningDatasetVersion,
  findActiveLearningConsent,
  getLatestLearningDatasetVersion,
  getLatestSealedLearningDatasetVersion,
  getLearningRecordRedactedContent,
  listAdmittableLearningRecords,
  listEligibleLearningDatasetMembers,
  sealLearningDatasetVersion,
  type AppDb,
} from "@mendpoint/db";
import type { LearningPrecedentEntry } from "@mendpoint/transformer";
import {
  TRANSFORMER_LEARNING_PURPOSE,
  learningLoopEnabled,
  parseLearningPrecedent,
} from "./transformer-learning-outcome.js";

const DEFAULT_MAX_PRECEDENT_ENTRIES = 16;

/**
 * Per-record errors that mean a candidate is simply not eligible for this
 * dataset (temporal cutoff, duplicate content, policy mismatch, or consent no
 * longer active). They are skipped so one ineligible record cannot block a seal;
 * any other error is a real fault and propagates.
 */
const SKIPPABLE_MEMBER_ERRORS = new Set([
  "learning_dataset_temporal_leakage",
  "learning_member_duplicate_content",
  "learning_dataset_policy_mismatch",
  "learning_consent_revoked",
  "learning_consent_expired",
  "learning_consent_not_effective",
  "learning_record_deleted",
]);

export type SealApprovedLearningInput = Readonly<{
  db: AppDb;
  tenantId: string;
  temporalCutoffAt: string;
  createdByPrincipalId: string;
  sealedByPrincipalId: string;
  now: string;
  env?: NodeJS.ProcessEnv;
}>;

export type SealApprovedLearningResult = Readonly<{
  sealed: boolean;
  reason: string;
  datasetVersionId?: string;
  memberCount?: number;
}>;

/**
 * Seal the currently eligible, consented, approved learning records into an
 * immutable dataset version. A dataset version is a point-in-time snapshot: each
 * distinct temporal cutoff yields its own version. Only members that pass the
 * append-only admission guards are included; sealing an empty set is refused.
 */
export function sealApprovedLearningOutcomes(
  input: SealApprovedLearningInput,
): SealApprovedLearningResult {
  const env = input.env ?? process.env;
  if (!learningLoopEnabled(env)) return Object.freeze({ sealed: false, reason: "disabled" });
  const { db, tenantId } = input;
  const consent = findActiveLearningConsent(db, {
    tenantId,
    purpose: TRANSFORMER_LEARNING_PURPOSE,
    at: input.now,
  });
  if (!consent) return Object.freeze({ sealed: false, reason: "no_active_consent" });
  const residencyRegion = consent.residency_region;

  // A stable id/idempotency key per (tenant, purpose, residency, cutoff) makes a
  // re-run reuse the same version rather than minting a runaway new one.
  const datasetVersionId = `tflearnds_${createHash("sha256")
    .update(
      `${tenantId} ${TRANSFORMER_LEARNING_PURPOSE} ${residencyRegion} ${input.temporalCutoffAt}`,
    )
    .digest("hex")
    .slice(0, 40)}`;

  const latest = getLatestLearningDatasetVersion(db, {
    tenantId,
    purpose: TRANSFORMER_LEARNING_PURPOSE,
    residencyRegion,
  });
  const draft = createLearningDatasetVersion(db, {
    id: datasetVersionId,
    tenantId,
    purpose: TRANSFORMER_LEARNING_PURPOSE,
    residencyRegion,
    version: (latest?.version ?? 0) + 1,
    temporalCutoffAt: input.temporalCutoffAt,
    createdByPrincipalId: input.createdByPrincipalId,
    idempotencyKey: datasetVersionId,
    createdAt: input.now,
  });
  if (draft.status === "sealed") {
    return Object.freeze({
      sealed: true,
      reason: "already_sealed",
      datasetVersionId: draft.id,
      memberCount: listEligibleLearningDatasetMembers(db, {
        tenantId,
        datasetVersionId: draft.id,
        at: input.now,
      }).length,
    });
  }

  const candidates = listAdmittableLearningRecords(db, {
    tenantId,
    purpose: TRANSFORMER_LEARNING_PURPOSE,
    residencyRegion,
    before: input.temporalCutoffAt,
  });
  let memberCount = 0;
  for (const record of candidates) {
    try {
      addLearningDatasetMember(db, {
        tenantId,
        datasetVersionId: draft.id,
        learningRecordId: record.id,
        idempotencyKey: `${draft.id} ${record.id}`,
        createdAt: input.now,
      });
      memberCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!SKIPPABLE_MEMBER_ERRORS.has(message)) throw error;
    }
  }
  if (memberCount === 0) {
    return Object.freeze({
      sealed: false,
      reason: "no_eligible_members",
      datasetVersionId: draft.id,
      memberCount,
    });
  }

  const sealedVersion = sealLearningDatasetVersion(db, {
    tenantId,
    datasetVersionId: draft.id,
    sealedByPrincipalId: input.sealedByPrincipalId,
    sealedAt: input.now,
  });
  return Object.freeze({
    sealed: sealedVersion.status === "sealed",
    reason: "sealed",
    datasetVersionId: draft.id,
    memberCount,
  });
}

export type BuildLearningPrecedentInput = Readonly<{
  db: AppDb;
  tenantId: string;
  at: string;
  env?: NodeJS.ProcessEnv;
  maxEntries?: number;
}>;

/**
 * Load precedent for the model-sourced planner from the latest sealed dataset.
 *
 * Consent-gated and residency-correct: it reads the tenant's single active
 * consent, then only the newest SEALED dataset in that residency, then only the
 * currently eligible members (consent still active, not deleted, within the
 * temporal cutoff). It never surfaces draft, in-flight, or unconsented data, and
 * returns an empty list when the loop is disabled or no consent exists.
 */
export function buildLearningPrecedent(
  input: BuildLearningPrecedentInput,
): readonly LearningPrecedentEntry[] {
  const env = input.env ?? process.env;
  if (!learningLoopEnabled(env)) return Object.freeze([]);
  const { db, tenantId } = input;
  const consent = findActiveLearningConsent(db, {
    tenantId,
    purpose: TRANSFORMER_LEARNING_PURPOSE,
    at: input.at,
  });
  if (!consent) return Object.freeze([]);
  const sealed = getLatestSealedLearningDatasetVersion(db, {
    tenantId,
    purpose: TRANSFORMER_LEARNING_PURPOSE,
    residencyRegion: consent.residency_region,
  });
  if (!sealed) return Object.freeze([]);

  const members = listEligibleLearningDatasetMembers(db, {
    tenantId,
    datasetVersionId: sealed.id,
    at: input.at,
  });
  const max = input.maxEntries ?? DEFAULT_MAX_PRECEDENT_ENTRIES;
  const entries: LearningPrecedentEntry[] = [];
  for (const member of members) {
    if (entries.length >= max) break;
    const content = getLearningRecordRedactedContent(db, tenantId, member.learning_record_id);
    if (!content) continue;
    const entry = parseLearningPrecedent(content, member.content_sha256);
    if (entry) entries.push(entry);
  }
  return Object.freeze(entries);
}
