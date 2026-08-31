import { createHash } from "node:crypto";
import type { EvaluationArm } from "./evaluation.js";
import type { LearningCase } from "./schema.js";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface ModeledCaseInput {
  schemaVersion: "mendpoint.modeled-case-input.v1";
  caseId: string;
  product: LearningCase["product"];
  cohort: LearningCase["cohort"];
  datasetSplit: LearningCase["datasetSplit"];
  arm: Exclude<EvaluationArm, "oracle">;
  title: string;
  repository: LearningCase["repository"];
  pattern: Pick<LearningCase["pattern"], "family" | "seededFailure" | "evidenceState">;
  fixture: Pick<LearningCase["fixture"], "manifestId" | "mutationId" | "allowedEditPaths">;
  security: LearningCase["security"];
}

export function stageModeledCase(
  learningCase: LearningCase,
  arm: Exclude<EvaluationArm, "oracle">,
): ModeledCaseInput {
  return {
    schemaVersion: "mendpoint.modeled-case-input.v1",
    caseId: learningCase.id,
    product: learningCase.product,
    cohort: learningCase.cohort,
    datasetSplit: learningCase.datasetSplit,
    arm,
    title: learningCase.title,
    repository: learningCase.repository,
    pattern: {
      family: learningCase.pattern.family,
      seededFailure: learningCase.pattern.seededFailure,
      evidenceState: learningCase.pattern.evidenceState,
    },
    fixture: {
      manifestId: learningCase.fixture.manifestId,
      mutationId: learningCase.fixture.mutationId,
      allowedEditPaths: learningCase.fixture.allowedEditPaths,
    },
    security: learningCase.security,
  };
}

// Everything a holdout case withholds from published artifacts. `expected` is
// the obvious half. `pattern.expectedImpactGraph` is the other half: it names
// the exact call-graph nodes the seeded failure is supposed to reach, which is
// answer signal for the impact-analysis half of both products. The fixture
// manifest ledger has always nulled it for holdouts, so publishing it in the
// case catalog made the two artifacts disagree about the same field. Both are
// withheld here, and the commitment below covers both, so the commitment binds
// every value that was withheld rather than only `expected`.
function withheldHoldoutAnswerKey(learningCase: LearningCase): Record<string, unknown> {
  return {
    expected: learningCase.expected,
    expectedImpactGraph: learningCase.pattern.expectedImpactGraph,
  };
}

// The digest of the one leak-free input a modeled arm is allowed to receive.
// This is what lets a validator decide answer-key exposure from content instead
// of from a self-reported flag: `stageModeledCase` is a pure function of the
// case and the arm, so any validator holding the case registry can recompute
// this digest independently. A producer that fed its arm anything else cannot
// make the digests agree, and a producer that retained no input artifact at all
// has nothing to present, which is a third state distinct from "no leak".
export function modeledCaseInputDigest(
  learningCase: LearningCase,
  arm: Exclude<EvaluationArm, "oracle">,
): string {
  return createHash("sha256").update(canonicalJson(stageModeledCase(learningCase, arm))).digest("hex");
}

export function publicCaseProjection(learningCase: LearningCase): Record<string, unknown> {
  if (learningCase.datasetSplit === "development") return learningCase as unknown as Record<string, unknown>;
  const { expected: _expected, pattern, ...publicCase } = learningCase;
  const { expectedImpactGraph: _expectedImpactGraph, ...publicPattern } = pattern;
  return {
    ...publicCase,
    // Nulled rather than omitted, so the published shape matches the fixture
    // manifest ledger's own holdout convention for this field.
    pattern: { ...publicPattern, expectedImpactGraph: null },
    holdout: {
      state: "assigned_unsealed",
      answerKeyCommitmentSha256: createHash("sha256")
        .update(canonicalJson(withheldHoldoutAnswerKey(learningCase)))
        .digest("hex"),
      note: "The expected outcome and expected impact graph are withheld from generated catalogs, but protected storage and access receipts do not yet exist.",
    },
  };
}
