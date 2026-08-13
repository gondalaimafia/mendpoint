import { redactSourceForModel } from "@mendpoint/agent";
import type { TransformerAdaptiveCandidateRecord } from "@mendpoint/db";
import type {
  AdaptiveCandidateArtifact,
  LearningPrecedentEntry,
} from "@mendpoint/transformer";

/**
 * The consent purpose and dataset scope for the Transformer adaptive learning
 * loop. A tenant grants consent under this purpose before any approved outcome
 * can be admitted, sealed, or surfaced.
 */
export const TRANSFORMER_LEARNING_PURPOSE = "transformer-adaptive-repair";

/**
 * Separate, opt-in consent purpose for capturing the redacted accepted
 * after-content (real file bodies / diffs) of an approved outcome. A tenant that
 * grants ONLY {@link TRANSFORMER_LEARNING_PURPOSE} gets exactly today's
 * change-spec capture and nothing more; the after-content record is written only
 * when THIS purpose is separately granted, so opting out (or never opting in)
 * leaves the base corpus byte-identical and revocation deletes the after-content
 * via the same eligibility gate that governs every learning record.
 */
export const TRANSFORMER_TRAINING_CONTENT_PURPOSE = "transformer-adaptive-training-content";

/**
 * Separate, opt-in consent purpose for capturing rejected candidates as negative
 * learning records (change-spec plus the reviewer's rejection rationale, labeled
 * `decision: "rejected"`). Governed independently of the approved-outcome and
 * after-content purposes so a tenant can opt into negatives on their own.
 */
export const TRANSFORMER_REJECTED_OUTCOME_PURPOSE = "transformer-adaptive-rejected-outcomes";

const OUTCOME_SCHEMA_VERSION = 1 as const;

/**
 * Upper bound on the redacted outcome size. Real outcomes carry only structured
 * change evidence, so this is generous; anything larger is treated as a redaction
 * failure and the outcome is not admitted (fail closed) rather than truncated.
 */
const REDACTION_CAP = 200_000;

/**
 * Upper bound on the redacted after-content document. The after-content carries
 * real (redacted) file bodies, so it is larger than the change-spec. This is the
 * redaction machinery's own hard ceiling (`redactSourceForModel` rejects a larger
 * cap); an after-content document that would exceed it fails closed (no content
 * record) rather than being stored with a truncated, weaker scrub.
 */
const CONTENT_REDACTION_CAP = 1_000_000;

/** Serializable, precedent-shaped view of one approved adaptive outcome. */
export type ApprovedOutcome = Readonly<{
  schemaVersion: 1;
  failingCommandId: string | null;
  overallRisk: string;
  confidence: number;
  changedPaths: readonly string[];
  edits: readonly Readonly<{
    path: string;
    semanticCategory: string;
    risk: string;
    rationale: string;
  }>[];
  verificationSummary: string;
  verificationCommandId: string;
  observedAt: string;
  // Deterministic migration classification labels, appended last and present only
  // when the candidate carries a determinable value. A candidate with null labels
  // (legacy or undeterminable) omits them, so its serialized outcome stays
  // byte-identical to the pre-labeling document.
  family?: string;
  provider?: string;
  framework?: string;
}>;

/**
 * Build the structured, precedent-relevant view of an approved outcome. This
 * deliberately excludes raw file bodies: it carries only the change evidence a
 * planner can learn from (paths, semantic categories, risk, rationale, and the
 * verification that passed). The raw view is redacted before it is ever stored.
 */
export function buildApprovedOutcome(
  candidate: TransformerAdaptiveCandidateRecord,
  artifact: AdaptiveCandidateArtifact,
  observedAt: string,
): ApprovedOutcome {
  return Object.freeze({
    schemaVersion: OUTCOME_SCHEMA_VERSION,
    failingCommandId: candidate.failingCommandId,
    overallRisk: artifact.review.overallRisk,
    confidence: artifact.review.confidence,
    changedPaths: Object.freeze(
      [...candidate.changedPaths].sort((left, right) => left.localeCompare(right)),
    ),
    edits: Object.freeze(
      [...artifact.review.edits]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((edit) =>
          Object.freeze({
            path: edit.path,
            semanticCategory: edit.semanticCategory,
            risk: edit.risk,
            rationale: edit.rationale,
          }),
        ),
    ),
    verificationSummary: artifact.review.verification.summary,
    verificationCommandId: artifact.review.verification.commandId,
    observedAt,
    // Real corpus labels from the persisted seal-time classification. Included only
    // when non-null so a null-label candidate serializes byte-identically to today.
    ...(candidate.family != null ? { family: candidate.family } : {}),
    ...(candidate.provider != null ? { provider: candidate.provider } : {}),
    ...(candidate.framework != null ? { framework: candidate.framework } : {}),
  });
}

/**
 * One redacted after-content entry: the exact before/after bytes of a single
 * accepted edit. Both bodies pass through {@link redactOutcomeDocument} with the
 * rest of the document, so no secret ever reaches storage.
 */
export type AfterContentEntry = Readonly<{
  path: string;
  changeType: "add" | "modify";
  beforeContent: string | null;
  afterContent: string;
}>;

/**
 * An approved outcome enriched with the redacted accepted after-content. Written
 * only under {@link TRANSFORMER_TRAINING_CONTENT_PURPOSE}; a superset of
 * {@link ApprovedOutcome} so the corpus exporter parses it with the same reader.
 */
export type ApprovedAfterContentOutcome = Readonly<
  ApprovedOutcome & { afterContent: readonly AfterContentEntry[] }
>;

/**
 * A rejected outcome: the same change-spec shape, labeled `decision: "rejected"`
 * and carrying the reviewer's rejection rationale. Written only under
 * {@link TRANSFORMER_REJECTED_OUTCOME_PURPOSE}. A superset of
 * {@link ApprovedOutcome} so the exporter parses it with the same reader.
 */
export type RejectedOutcome = Readonly<
  ApprovedOutcome & { decision: "rejected"; rejectionRationale: string }
>;

export type LearningOutcomeDocument =
  | ApprovedOutcome
  | ApprovedAfterContentOutcome
  | RejectedOutcome;

/**
 * Build an approved outcome enriched with the accepted after-content. Reuses
 * {@link buildApprovedOutcome} verbatim and appends the exact before/after bytes
 * of each edit (sorted by path); the whole document is redacted before storage.
 */
export function buildApprovedAfterContentOutcome(
  candidate: TransformerAdaptiveCandidateRecord,
  artifact: AdaptiveCandidateArtifact,
  observedAt: string,
): ApprovedAfterContentOutcome {
  const base = buildApprovedOutcome(candidate, artifact, observedAt);
  const afterContent = Object.freeze(
    [...artifact.review.edits]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((edit) =>
        Object.freeze({
          path: edit.path,
          changeType: edit.changeType,
          beforeContent: edit.beforeContent,
          afterContent: artifact.files[edit.path] ?? "",
        }),
      ),
  );
  return Object.freeze({ ...base, afterContent });
}

/**
 * Build a rejected outcome from a candidate whose review decision is "reject".
 * Reuses {@link buildApprovedOutcome} for the change-spec and labels the document
 * `decision: "rejected"` with the reviewer's rejection rationale.
 */
export function buildRejectedOutcome(
  candidate: TransformerAdaptiveCandidateRecord,
  artifact: AdaptiveCandidateArtifact,
  observedAt: string,
): RejectedOutcome {
  const base = buildApprovedOutcome(candidate, artifact, observedAt);
  return Object.freeze({
    ...base,
    decision: "rejected",
    rejectionRationale: candidate.reviewRationale ?? "",
  });
}

/** Deterministic canonical serialization of an approved outcome. */
export function serializeApprovedOutcome(outcome: ApprovedOutcome): string {
  return JSON.stringify(outcome);
}

/** Deterministic canonical serialization of any learning outcome document. */
export function serializeOutcomeDocument(outcome: LearningOutcomeDocument): string {
  return JSON.stringify(outcome);
}

export type RedactedApprovedOutcome =
  | Readonly<{ ok: true; redactedContent: string; redactionCount: number }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * Redact a learning outcome document with the same secret-redaction machinery the
 * agent and adaptive-loop paths use before any model call, bounded by `cap`. Fails
 * closed: an excluded (ambiguous), truncated, or non-parseable result yields no
 * redacted content, so the outcome is not admitted rather than admitted with a
 * weaker scrub. The change-spec outcomes use {@link REDACTION_CAP}; the
 * after-content document, which carries redacted file bodies, uses the larger
 * {@link CONTENT_REDACTION_CAP}.
 */
export function redactOutcomeDocument(rawJson: string, cap: number): RedactedApprovedOutcome {
  const result = redactSourceForModel(rawJson, cap);
  if (result.excluded) {
    return Object.freeze({
      ok: false,
      reason: `redaction_excluded:${result.exclusionReason ?? "unknown"}`,
    });
  }
  if (result.truncated) {
    return Object.freeze({ ok: false, reason: "redaction_truncated" });
  }
  try {
    JSON.parse(result.text);
  } catch {
    return Object.freeze({ ok: false, reason: "redaction_unparseable" });
  }
  return Object.freeze({
    ok: true,
    redactedContent: result.text,
    redactionCount: result.counts.total,
  });
}

/**
 * Redact an approved outcome (change-spec only). Unchanged behavior: delegates to
 * {@link redactOutcomeDocument} with the change-spec cap.
 */
export function redactApprovedOutcome(rawJson: string): RedactedApprovedOutcome {
  return redactOutcomeDocument(rawJson, REDACTION_CAP);
}

/** The redaction cap for the after-content document. */
export const AFTER_CONTENT_REDACTION_CAP = CONTENT_REDACTION_CAP;

/**
 * Parse a sealed, redacted outcome back into a planner precedent entry. Returns
 * null if the content is not the expected redacted-outcome shape so a corrupt or
 * unexpected artifact is skipped rather than surfaced to a model.
 */
export function parseLearningPrecedent(
  redactedContent: string,
  contentSha256: string,
): LearningPrecedentEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(redactedContent);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const outcome = parsed as Record<string, unknown>;
  if (outcome.schemaVersion !== OUTCOME_SCHEMA_VERSION) return null;
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
  return Object.freeze({
    contentSha256,
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
    observedAt: typeof outcome.observedAt === "string" ? outcome.observedAt : "",
  });
}

/** The learning loop is default-off; only an explicit "1" enables it. */
export function learningLoopEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.MENDPOINT_TRANSFORMER_LEARNING_ENABLED === "1";
}
