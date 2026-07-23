export type {
  FailureKind,
  FailureObservation,
  RepairAction,
  RepairPlan,
  AppliedEdit,
  VerifyResult,
  RepairSessionResult,
  RepairSessionInput,
} from "./types.js";

export { diagnoseFailureLog, diagnoseWorkingTree } from "./diagnose.js";
export { planRepairs, planRepairsWithLlm } from "./plan.js";
export { applyActions, listCodeFilesWithContent } from "./apply.js";
export { runRepairSession } from "./session.js";

/** Integrate with CI loop: repair then re-verify */
export { runAgenticRepairLoop } from "./loop.js";
