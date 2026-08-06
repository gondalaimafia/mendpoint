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
} from "./verify.js";
export {
  createSandboxVerifier,
  createSandboxVerifierFromEnv,
  resolveSandboxConfig,
  sweepOrphanedSandboxMachines,
  packWorkspaceTarGz,
  LocalSandboxVerifier,
  FlyMachinesSandbox,
  type SandboxVerifier,
  type SandboxBackend,
  type SandboxConfig,
  type SandboxDeps,
  type SandboxErrorCode,
  type SandboxVerificationRequest,
  type SandboxVerificationResult,
  type SandboxSweepResult,
  type FlyGuestConfig,
  type FlyMachinesConfig,
  type PackedWorkspace,
} from "./sandbox.js";

/** Integrate with CI loop: repair then re-verify */
export { runAgenticRepairLoop } from "./loop.js";
