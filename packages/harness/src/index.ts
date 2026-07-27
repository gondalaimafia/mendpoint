export type { TraceEvent, RunScore, RunPaths } from "./trajectory.js";
export {
  runDir,
  initRun,
  appendTrace,
  writeScore,
  loadPlan,
  savePlan,
  runExists,
} from "./trajectory.js";

export type { ExecuteOptions, ExecuteResult } from "./executor.js";
export { executePlan, helloWorldRun } from "./executor.js";

export type { DogfoodReport, DogfoodRunSummary, LedgerEntry } from "./dogfood.js";
export {
  collectDogfood,
  appendDogfoodLedger,
  writeDogfoodReport,
  formatDogfoodReport,
  seedDogfoodScores,
  listRunIds,
  loadRunScore,
  DOGFOOD_TARGET_RUNS,
  DOGFOOD_TARGET_OK_RATE,
} from "./dogfood.js";

export type { RunListItem } from "./viewer.js";
export { listTrajectories, viewTrajectory, formatRunList } from "./viewer.js";
