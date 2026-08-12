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

const OUTCOME_SCHEMA_VERSION = 1 as const;

/**
 * Upper bound on the redacted outcome size. Real outcomes carry only structured
 * change evidence, so this is generous; anything larger is treated as a redaction
 * failure and the outcome is not admitted (fail closed) rather than truncated.
 */
const REDACTION_CAP = 200_000;

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
  });
}

/** Deterministic canonical serialization of an approved outcome. */
export function serializeApprovedOutcome(outcome: ApprovedOutcome): string {
  return JSON.stringify(outcome);
}

export type RedactedApprovedOutcome =
  | Readonly<{ ok: true; redactedContent: string; redactionCount: number }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * Redact an approved outcome with the same secret-redaction machinery the agent
 * and adaptive-loop paths use before any model call. Fails closed: an excluded
 * (ambiguous), truncated, or non-parseable result yields no redacted content, so
 * the outcome is not admitted rather than admitted with a weaker scrub.
 */
export function redactApprovedOutcome(rawJson: string): RedactedApprovedOutcome {
  const result = redactSourceForModel(rawJson, REDACTION_CAP);
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
