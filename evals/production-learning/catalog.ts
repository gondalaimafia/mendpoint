import { fettlerCases } from "./fettler-cases.js";
import { regaugeCases } from "./regauge-cases.js";
import { validateCaseCatalog, type LearningCase } from "./schema.js";

export const learningCases: readonly LearningCase[] = Object.freeze([
  ...fettlerCases,
  ...regaugeCases,
]);

export function assertCatalogComplete(cases: readonly LearningCase[] = learningCases): void {
  const errors = validateCaseCatalog([...cases]);
  if (errors.length > 0) throw new Error(`production_learning_catalog_invalid:${errors.join("|")}`);
}

export function catalogSummary(cases: readonly LearningCase[] = learningCases): {
  total: number;
  development: number;
  holdout: number;
  byProductAndCohort: Record<string, number>;
  sourceCount: number;
  repositoryCount: number;
} {
  const byProductAndCohort: Record<string, number> = {};
  for (const item of cases) {
    const key = `${item.product}:${item.cohort}`;
    byProductAndCohort[key] = (byProductAndCohort[key] ?? 0) + 1;
  }
  return {
    total: cases.length,
    development: cases.filter((item) => item.datasetSplit === "development").length,
    holdout: cases.filter((item) => item.datasetSplit === "holdout").length,
    byProductAndCohort,
    sourceCount: new Set(cases.flatMap((item) => item.sources.map((source) => source.url))).size,
    repositoryCount: new Set(cases.map((item) => item.repository.provenanceId)).size,
  };
}
