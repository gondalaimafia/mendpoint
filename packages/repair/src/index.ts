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
export {
  applyActions,
  listCodeFilesWithContent,
  rollbackPristineFiles,
  type PristineFile,
} from "./apply.js";
export { runRepairSession } from "./session.js";
export {
  parseVerificationCommand,
  discoverVerificationCommands,
  runVerificationCommand,
  validateVerificationCommands,
  type VerificationExecution,
  type VerificationInvocation,
  type VerificationOutcome,
} from "./verify.js";
export {
  classifySandboxRunResult,
  configuredSandboxKind,
  runVerificationInSandbox,
  type VerificationSandboxOptions,
} from "./verify-sandbox.js";
