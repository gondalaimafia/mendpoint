import type { AppDb } from "./index.js";
import {
  countLearningDatasetMembers,
  findActiveLearningConsent,
  getLatestSealedLearningDatasetVersion,
  getLearningDatasetVersion,
  getLearningRecord,
  getLearningRecordRedactedContent,
  listEligibleLearningDatasetMembers,
  type LearningDatasetVersionRow,
} from "./learning.js";

// ---------------------------------------------------------------------------
// Training-corpus exporter.
//
// Turns sealed, consented, approved, redacted learning-dataset members into a
// labeled fine-tuning corpus (JSONL). It is strictly READ-ONLY over the learning
// tables and reuses the same consent/residency/temporal eligibility gate the
// Transformer precedent consumer uses (listEligibleLearningDatasetMembers). It
// never writes, never weakens admission guards, and never trains a model.
//
// Fail-closed everywhere: no active consent, no sealed dataset, or a member that
// cannot be resolved to redacted, expected-shape content is EXCLUDED and counted,
// never emitted with weaker evidence.
// ---------------------------------------------------------------------------

/** Corpus JSONL schema version. Bump only on a breaking example-shape change. */
export const LEARNING_CORPUS_SCHEMA_VERSION = 1 as const;

/**
 * The redacted learning artifact serializes an approved-outcome document at this
 * schema version. Anything else is treated as an unexpected shape and excluded.
 */
const REDACTED_OUTCOME_SCHEMA_VERSION = 1;

/** One structured, redacted edit from an approved outcome. */
export type LearningCorpusEdit = Readonly<{
  path: string;
  semanticCategory: string;
  risk: string;
  rationale: string;
}>;

/**
 * One redacted after-content entry (before/after bytes of an accepted edit),
 * present only in examples exported from the opt-in after-content dataset
 * (`transformer-adaptive-training-content`). Absent for base and rejected
 * examples, so those corpora stay byte-identical.
 */
export type LearningCorpusAfterContentEntry = Readonly<{
  path: string;
  changeType: string;
  beforeContent: string | null;
  afterContent: string;
}>;

/**
 * One labeled training example. `input`, `output`, and `labels` are the trainable
 * fields a post-training run consumes; `provenance` is audit metadata (tenant,
 * dataset, hashes) that a pipeline strips before it reaches a model.
 */
export type LearningCorpusExample = Readonly<{
  schemaVersion: typeof LEARNING_CORPUS_SCHEMA_VERSION;
  id: string;
  input: Readonly<{
    task: string;
    failingCommandId: string | null;
    changedPaths: readonly string[];
    targetPaths: readonly string[];
  }>;
  output: Readonly<{
    edits: readonly LearningCorpusEdit[];
    verificationSummary: string;
    verificationCommandId: string;
    // Present only for after-content examples (opt-in content purpose); absent
    // otherwise so base and rejected examples stay byte-identical.
    afterContent?: readonly LearningCorpusAfterContentEntry[];
    // Present only for rejected examples (opt-in rejected purpose); the reviewer's
    // rejection rationale. Absent otherwise.
    rejectionRationale?: string;
  }>;
  labels: Readonly<{
    // Not carried by the sealed learning shape today; emitted as null rather than
    // fabricated. See docs/LEARNING_CORPUS.md ("What is deliberately absent").
    family: null;
    provider: null;
    framework: null;
    semanticCategories: readonly string[];
    overallRisk: string;
    confidence: number;
    // For approved and after-content examples this is a passing objective
    // verification; a rejected example carries the objective verification result as
    // captured (the human rejected the change despite it). Defaults to true for the
    // approved-only shape, so base corpora stay byte-identical.
    verificationPassed: boolean;
    // "accepted" for approved and after-content examples; "rejected" for negatives.
    decision: "accepted" | "rejected";
  }>;
  provenance: Readonly<{
    tenantId: string;
    purpose: string;
    residencyRegion: string;
    datasetVersionId: string;
    datasetVersion: number;
    datasetSha256: string | null;
    learningRecordId: string;
    sourceObjectType: string;
    observedAt: string;
    contentSha256: string;
  }>;
}>;

export type LearningCorpusExclusionReason =
  | "ineligible_membership"
  | "missing_redacted_content"
  | "unparseable_content"
  | "unexpected_schema";

export type LearningCorpusStats = Readonly<{
  tenantId: string;
  purpose: string;
  residencyRegion: string | null;
  datasetVersionId: string | null;
  datasetVersion: number | null;
  sealedMembers: number;
  eligibleMembers: number;
  exported: number;
  excluded: number;
  excludedByReason: Readonly<Record<LearningCorpusExclusionReason, number>>;
  byDecision: Readonly<Record<string, number>>;
  byOverallRisk: Readonly<Record<string, number>>;
  bySemanticCategory: Readonly<Record<string, number>>;
}>;

export type LearningCorpusResult = Readonly<{
  examples: readonly LearningCorpusExample[];
  stats: LearningCorpusStats;
  reason: string;
}>;

export type BuildLearningCorpusInput = Readonly<{
  db: AppDb;
  tenantId: string;
  purpose: string;
  at: string;
  /** Optional explicit sealed dataset version; defaults to the latest sealed. */
  datasetVersionId?: string;
}>;

type ParsedOutcome = Readonly<{
  failingCommandId: string | null;
  overallRisk: string;
  confidence: number;
  changedPaths: readonly string[];
  edits: readonly LearningCorpusEdit[];
  verificationSummary: string;
  verificationCommandId: string;
  // Additive, opt-in fields. Legacy approved-outcome docs omit them and resolve to
  // the constants below, so the base corpus is byte-identical.
  decision: "accepted" | "rejected";
  verificationPassed: boolean;
  afterContent?: readonly LearningCorpusAfterContentEntry[];
  rejectionRationale?: string;
}>;

/** Defensively parse the optional after-content array; undefined when absent. */
function parseAfterContent(value: unknown): readonly LearningCorpusAfterContentEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return Object.freeze(
    value
      .filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
      .map((entry) =>
        Object.freeze({
          path: typeof entry.path === "string" ? entry.path : "",
          changeType: typeof entry.changeType === "string" ? entry.changeType : "modify",
          beforeContent: typeof entry.beforeContent === "string" ? entry.beforeContent : null,
          afterContent: typeof entry.afterContent === "string" ? entry.afterContent : "",
        }),
      ),
  );
}

/**
 * Parse the redacted approved-outcome JSON defensively. Mirrors the precedent
 * consumer's parse: unexpected shape yields null so the member is skipped rather
 * than surfaced. Returns `undefined` when the JSON is unparseable and `null` when
 * it parses but is not the expected schema, so callers can attribute the reason.
 */
function parseRedactedOutcome(redactedContent: string): ParsedOutcome | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(redactedContent);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const outcome = parsed as Record<string, unknown>;
  if (outcome.schemaVersion !== REDACTED_OUTCOME_SCHEMA_VERSION) return null;
  if (!Array.isArray(outcome.changedPaths) || !Array.isArray(outcome.edits)) return null;
  const changedPaths = outcome.changedPaths.filter(
    (value): value is string => typeof value === "string",
  );
  const edits = outcome.edits
    .filter(
      (value): value is Record<string, unknown> =>
        Boolean(value) && typeof value === "object" && !Array.isArray(value),
    )
    .map((edit) =>
      Object.freeze({
        path: typeof edit.path === "string" ? edit.path : "",
        semanticCategory:
          typeof edit.semanticCategory === "string" ? edit.semanticCategory : "other",
        risk: typeof edit.risk === "string" ? edit.risk : "unknown",
        rationale: typeof edit.rationale === "string" ? edit.rationale : "",
      }),
    );
  const afterContent = parseAfterContent(outcome.afterContent);
  return Object.freeze({
    failingCommandId:
      typeof outcome.failingCommandId === "string" ? outcome.failingCommandId : null,
    overallRisk: typeof outcome.overallRisk === "string" ? outcome.overallRisk : "unknown",
    confidence: typeof outcome.confidence === "number" ? outcome.confidence : 0,
    changedPaths: Object.freeze(changedPaths),
    edits: Object.freeze(edits),
    verificationSummary:
      typeof outcome.verificationSummary === "string" ? outcome.verificationSummary : "",
    verificationCommandId:
      typeof outcome.verificationCommandId === "string" ? outcome.verificationCommandId : "",
    // Legacy approved-outcome docs omit these; they resolve to the today-constants,
    // so a base (accepted-only) corpus is byte-identical.
    decision: outcome.decision === "rejected" ? "rejected" : "accepted",
    verificationPassed:
      typeof outcome.verificationPassed === "boolean" ? outcome.verificationPassed : true,
    ...(afterContent ? { afterContent } : {}),
    ...(typeof outcome.rejectionRationale === "string"
      ? { rejectionRationale: outcome.rejectionRationale }
      : {}),
  });
}

function resolveSealedDataset(
  input: BuildLearningCorpusInput,
  residencyRegion: string,
): LearningDatasetVersionRow | undefined {
  const { db, tenantId, purpose } = input;
  if (!input.datasetVersionId) {
    return getLatestSealedLearningDatasetVersion(db, {
      tenantId,
      purpose,
      residencyRegion,
    });
  }
  // An explicitly named version must still match the consented policy scope
  // (tenant, purpose, residency) and be sealed; anything else is refused (fail
  // closed) rather than exported.
  const dataset = getLearningDatasetVersion(db, tenantId, input.datasetVersionId);
  if (
    !dataset ||
    dataset.status !== "sealed" ||
    dataset.purpose !== purpose ||
    dataset.residency_region !== residencyRegion
  ) {
    return undefined;
  }
  return dataset;
}

/**
 * Build the labeled training corpus from a tenant's sealed, consented learning
 * data. Consent-gated and residency-correct: reads the tenant's single active
 * consent for the purpose, then only the sealed dataset in that residency, then
 * only the currently eligible members. Returns an empty corpus (never throws)
 * when the loop has no consent or no sealed data.
 */
export function buildLearningCorpus(input: BuildLearningCorpusInput): LearningCorpusResult {
  const { db, tenantId, purpose, at } = input;
  const emptyExcluded: Record<LearningCorpusExclusionReason, number> = {
    ineligible_membership: 0,
    missing_redacted_content: 0,
    unparseable_content: 0,
    unexpected_schema: 0,
  };

  const baseStats = (
    residencyRegion: string | null,
    dataset: LearningDatasetVersionRow | undefined,
  ): LearningCorpusStats =>
    Object.freeze({
      tenantId,
      purpose,
      residencyRegion,
      datasetVersionId: dataset?.id ?? null,
      datasetVersion: dataset?.version ?? null,
      sealedMembers: 0,
      eligibleMembers: 0,
      exported: 0,
      excluded: 0,
      excludedByReason: Object.freeze({ ...emptyExcluded }),
      byDecision: Object.freeze({}),
      byOverallRisk: Object.freeze({}),
      bySemanticCategory: Object.freeze({}),
    });

  const consent = findActiveLearningConsent(db, { tenantId, purpose, at });
  if (!consent) {
    return Object.freeze({
      examples: Object.freeze([]),
      stats: baseStats(null, undefined),
      reason: "no_active_consent",
    });
  }
  const residencyRegion = consent.residency_region;

  const dataset = resolveSealedDataset(input, residencyRegion);
  if (!dataset) {
    return Object.freeze({
      examples: Object.freeze([]),
      stats: baseStats(residencyRegion, undefined),
      reason: input.datasetVersionId ? "dataset_not_found_or_unsealed" : "no_sealed_dataset",
    });
  }

  const sealedMembers = countLearningDatasetMembers(db, {
    tenantId,
    datasetVersionId: dataset.id,
  });
  const eligible = listEligibleLearningDatasetMembers(db, {
    tenantId,
    datasetVersionId: dataset.id,
    at,
  });

  const excludedByReason: Record<LearningCorpusExclusionReason, number> = { ...emptyExcluded };
  // Sealed members that are no longer eligible (revoked consent, deletion, or the
  // temporal cutoff) are excluded before any content is ever read.
  excludedByReason.ineligible_membership = Math.max(0, sealedMembers - eligible.length);

  const byDecision: Record<string, number> = {};
  const byOverallRisk: Record<string, number> = {};
  const bySemanticCategory: Record<string, number> = {};
  const examples: LearningCorpusExample[] = [];

  for (const member of eligible) {
    const content = getLearningRecordRedactedContent(db, tenantId, member.learning_record_id);
    if (content === null) {
      excludedByReason.missing_redacted_content += 1;
      continue;
    }
    const parsed = parseRedactedOutcome(content);
    if (parsed === undefined) {
      excludedByReason.unparseable_content += 1;
      continue;
    }
    if (parsed === null) {
      excludedByReason.unexpected_schema += 1;
      continue;
    }
    const record = getLearningRecord(db, tenantId, member.learning_record_id);
    if (!record) {
      // Should never happen for an eligible member, but fail closed if it does.
      excludedByReason.ineligible_membership += 1;
      continue;
    }

    const targetPaths = Object.freeze(
      [...new Set(parsed.edits.map((edit) => edit.path).filter((path) => path.length > 0))].sort(
        (left, right) => left.localeCompare(right),
      ),
    );
    const semanticCategories = Object.freeze(
      [...new Set(parsed.edits.map((edit) => edit.semanticCategory))].sort((left, right) =>
        left.localeCompare(right),
      ),
    );

    examples.push(
      Object.freeze({
        schemaVersion: LEARNING_CORPUS_SCHEMA_VERSION,
        id: member.content_sha256,
        input: Object.freeze({
          task: purpose,
          failingCommandId: parsed.failingCommandId,
          changedPaths: parsed.changedPaths,
          targetPaths,
        }),
        output: Object.freeze({
          edits: parsed.edits,
          verificationSummary: parsed.verificationSummary,
          verificationCommandId: parsed.verificationCommandId,
          // Additive, opt-in fields appended last: absent for base examples, so a
          // base (accepted-only) corpus is byte-identical to today.
          ...(parsed.afterContent ? { afterContent: parsed.afterContent } : {}),
          ...(parsed.rejectionRationale !== undefined
            ? { rejectionRationale: parsed.rejectionRationale }
            : {}),
        }),
        labels: Object.freeze({
          family: null,
          provider: null,
          framework: null,
          semanticCategories,
          overallRisk: parsed.overallRisk,
          confidence: parsed.confidence,
          verificationPassed: parsed.verificationPassed,
          decision: parsed.decision,
        }),
        provenance: Object.freeze({
          tenantId,
          purpose,
          residencyRegion,
          datasetVersionId: dataset.id,
          datasetVersion: dataset.version,
          datasetSha256: dataset.dataset_sha256,
          learningRecordId: record.id,
          sourceObjectType: record.source_object_type,
          observedAt: record.observed_at,
          contentSha256: member.content_sha256,
        }),
      }),
    );

    byDecision[parsed.decision] = (byDecision[parsed.decision] ?? 0) + 1;
    byOverallRisk[parsed.overallRisk] = (byOverallRisk[parsed.overallRisk] ?? 0) + 1;
    for (const category of semanticCategories) {
      bySemanticCategory[category] = (bySemanticCategory[category] ?? 0) + 1;
    }
  }

  const excluded =
    excludedByReason.ineligible_membership +
    excludedByReason.missing_redacted_content +
    excludedByReason.unparseable_content +
    excludedByReason.unexpected_schema;

  const stats: LearningCorpusStats = Object.freeze({
    tenantId,
    purpose,
    residencyRegion,
    datasetVersionId: dataset.id,
    datasetVersion: dataset.version,
    sealedMembers,
    eligibleMembers: eligible.length,
    exported: examples.length,
    excluded,
    excludedByReason: Object.freeze(excludedByReason),
    byDecision: Object.freeze(byDecision),
    byOverallRisk: Object.freeze(byOverallRisk),
    bySemanticCategory: Object.freeze(bySemanticCategory),
  });

  return Object.freeze({ examples: Object.freeze(examples), stats, reason: "ok" });
}

/**
 * Deterministic JSONL serialization: one example per line, keys in construction
 * order, trailing newline. Idempotent for a fixed database state.
 */
export function serializeLearningCorpusJsonl(
  examples: readonly LearningCorpusExample[],
): string {
  if (examples.length === 0) return "";
  return `${examples.map((example) => JSON.stringify(example)).join("\n")}\n`;
}

/** Human-readable one-block summary of a corpus export. */
export function formatLearningCorpusStats(stats: LearningCorpusStats): string {
  const lines = [
    `tenant:            ${stats.tenantId}`,
    `purpose:           ${stats.purpose}`,
    `residency:         ${stats.residencyRegion ?? "(none)"}`,
    `dataset version:   ${stats.datasetVersionId ?? "(none)"} (v${stats.datasetVersion ?? 0})`,
    `sealed members:    ${stats.sealedMembers}`,
    `eligible members:  ${stats.eligibleMembers}`,
    `exported examples: ${stats.exported}`,
    `excluded total:    ${stats.excluded}`,
    `  ineligible membership (consent/deleted/temporal): ${stats.excludedByReason.ineligible_membership}`,
    `  missing redacted content:                         ${stats.excludedByReason.missing_redacted_content}`,
    `  unparseable content:                              ${stats.excludedByReason.unparseable_content}`,
    `  unexpected schema:                                ${stats.excludedByReason.unexpected_schema}`,
    `by decision:       ${JSON.stringify(stats.byDecision)}`,
    `by overall risk:   ${JSON.stringify(stats.byOverallRisk)}`,
    `by semantic cat.:  ${JSON.stringify(stats.bySemanticCategory)}`,
  ];
  return lines.join("\n");
}
