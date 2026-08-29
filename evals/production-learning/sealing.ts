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

export function publicCaseProjection(learningCase: LearningCase): Record<string, unknown> {
  if (learningCase.datasetSplit === "development") return learningCase as unknown as Record<string, unknown>;
  const { expected: _expected, ...publicCase } = learningCase;
  return {
    ...publicCase,
    holdout: {
      state: "assigned_unsealed",
      answerKeyCommitmentSha256: createHash("sha256").update(canonicalJson(learningCase.expected)).digest("hex"),
      note: "The answer key is withheld from generated catalogs, but protected storage and access receipts do not yet exist.",
    },
  };
}
