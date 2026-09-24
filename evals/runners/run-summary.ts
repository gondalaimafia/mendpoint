/**
 * Machine-readable summary of WHAT ACTUALLY RAN in a synthetic-eval run, so a
 * workflow can label the job honestly rather than presenting a full-corpus pass
 * when part (or all) of the corpus was skipped.
 *
 * The honest distinction is three-way, keyed on how many corpus scenarios ran vs
 * were skipped — NOT on whether a corpus env var was set, and NOT on "at least
 * one corpus scenario ran". A run that executed 20 of 21 corpus scenarios is
 * PARTIAL, not full: it must say which one it skipped.
 */

export type CorpusStatus = "full" | "partial" | "unavailable";

export interface SyntheticRunSummary {
  schemaVersion: "mendpoint.synthetic-eval-run-summary.v1";
  corpusConfigured: boolean;
  corpusRoot: string;
  /** full = every corpus scenario ran; partial = some ran, some skipped; unavailable = none ran. */
  corpusStatus: CorpusStatus;
  /** True when the corpus was present enough to run at least one scenario. Never sufficient for a "full corpus" claim on its own. */
  corpusAvailable: boolean;
  corpusScenariosRun: number;
  corpusScenariosSkipped: number;
  corpusScenariosTotal: number;
  corpusSkippedScenarioIds: string[];
  generatedScenariosRun: number;
  suiteTotal: number;
  suitePassed: number;
  p0Failures: number;
  readinessOverall: string;
}

export function corpusStatusOf(run: number, skipped: number): CorpusStatus {
  if (run === 0) return "unavailable";
  if (skipped === 0) return "full";
  return "partial";
}

export function summarizeSyntheticRun(input: {
  corpusConfigured: boolean;
  corpusRoot: string;
  corpusScenariosRun: number;
  corpusSkippedScenarioIds: readonly string[];
  generatedScenariosRun: number;
  suiteTotal: number;
  suitePassed: number;
  p0Failures: number;
  readinessOverall: string;
}): SyntheticRunSummary {
  const corpusScenariosSkipped = input.corpusSkippedScenarioIds.length;
  return {
    schemaVersion: "mendpoint.synthetic-eval-run-summary.v1",
    corpusConfigured: input.corpusConfigured,
    corpusRoot: input.corpusRoot,
    corpusStatus: corpusStatusOf(input.corpusScenariosRun, corpusScenariosSkipped),
    corpusAvailable: input.corpusScenariosRun > 0,
    corpusScenariosRun: input.corpusScenariosRun,
    corpusScenariosSkipped,
    corpusScenariosTotal: input.corpusScenariosRun + corpusScenariosSkipped,
    corpusSkippedScenarioIds: [...input.corpusSkippedScenarioIds].sort(),
    generatedScenariosRun: input.generatedScenariosRun,
    suiteTotal: input.suiteTotal,
    suitePassed: input.suitePassed,
    p0Failures: input.p0Failures,
    readinessOverall: input.readinessOverall,
  };
}
