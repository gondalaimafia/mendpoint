import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { authorizeTransformerWorkerAction } from "@mendpoint/ops";
import {
  applyRecipe,
  classifyRecipeReference,
  normalizeRecipeFileModes,
  recipeFilesDigest,
  resolveRecipe,
  type MigrationLabelFamily,
  type RecipeFileModes,
  type RecipeFiles,
} from "./recipe.js";
import {
  RecipeWorkspaceExecutionError,
  executeRecipeInWorkspace,
  runRecipeVerificationGate,
  type ExactSourceSnapshot,
  type RecipeCommandRunner,
  type RecipeExecutionFence,
  type RecipeExecutionRollback,
  type RecipeVerificationControl,
  type RecipeWorkspaceExecutionResult,
} from "./recipe-workspace-execution.js";
import {
  DEFAULT_ADAPTIVE_REPAIR_BOUNDS,
  runAdaptiveRepairLoop,
  type AdaptiveBoundExhaustion,
  type AdaptiveGate,
  type AdaptiveExternalModelReservation,
  type AdaptiveExternalModelSettlement,
  type AdaptiveRepairBounds,
  type AdaptiveRepairOutcome,
  type AdaptiveRepairPlanner,
  type AdaptiveRepairReviewEvidence,
  type AdaptiveRepairUsage,
  type AdaptiveUnfixableMarker,
  type AdaptiveVerifierResult,
} from "./adaptive-loop.js";
import type {
  AdaptiveCandidateReviewEdit,
  AdaptiveCandidateReviewEvidence,
  AdaptiveReviewRisk,
  AdaptiveSemanticCategory,
} from "./adaptive-candidate.js";
import type {
  TransformerAdaptiveCandidateHandoffInput,
  TransformerAdaptiveAttemptAccounting,
  TransformerAttemptLease,
  TransformerAttemptLeaseRenewal,
} from "./pilot-execution.js";
import type { TransformerMissionArtifactRegistrationBinding } from "./attempt-checkpoint.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const REVISION = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_CANDIDATE_FILES = 10_000;
const MAX_CANDIDATE_BYTES = 50 * 1024 * 1024;

type MaybePromise<T> = T | Promise<T>;

export type TransformerAttemptRecoveryCode =
  | "source_drift"
  | "candidate_drift"
  | "verification_failed"
  | "execution_failed"
  | "worker_crash";

export type TransformerExecutableAttemptLease = TransformerAttemptLease;

export type TransformerAttemptScope = Readonly<{
  tenantId: string;
  environment: string;
  campaignId: string;
}>;

export type TransformerAttemptPhase = "claim" | "execute" | "renew" | "usage" | "failure" | "complete";

export type TransformerAttemptClaimInput = Readonly<{
  tenantId: string;
  campaignId: string;
  observedAt: string;
  evidenceRefs: readonly string[];
  idempotencyKey: string;
  leaseToken: string;
  leaseDurationMs: number;
  gateConfig?: string;
}>;

export type TransformerCurrentAttemptFence = Readonly<{
  tenantId: string;
  campaignId: string;
  unitId: string;
  leaseGeneration: number;
  leaseToken: string;
  observedAt: string;
}>;

export type TransformerAttemptLeaseRenewalInput = Readonly<{
  tenantId: string;
  campaignId: string;
  unitId: string;
  leaseGeneration: number;
  leaseToken: string;
  leaseDurationMs: number;
  observedAt: string;
  evidenceRefs: readonly string[];
  idempotencyKey: string;
  gateConfig?: string;
}>;

export type TransformerAttemptCompletionInput = Readonly<{
  tenantId: string;
  campaignId: string;
  unitId: string;
  leaseGeneration: number;
  leaseToken: string;
  sourceRevision: string;
  sourceDigest: string;
  candidateRevision: string;
  candidateDigest: string;
  verificationPassed: true;
  actualCostUsd: number;
  accounting: TransformerAdaptiveAttemptAccounting;
  artifactRegistration: TransformerMissionArtifactRegistrationBinding;
  observedAt: string;
  evidenceRefs: readonly string[];
  idempotencyKey: string;
  gateConfig?: string;
}>;

export type TransformerAttemptFailureInput = Readonly<{
  tenantId: string;
  campaignId: string;
  unitId: string;
  leaseGeneration: number;
  leaseToken: string;
  code: TransformerAttemptRecoveryCode;
  errorCode?: string;
  accounting: TransformerAdaptiveAttemptAccounting;
  observedAt: string;
  evidenceRefs: readonly string[];
  idempotencyKey: string;
  gateConfig?: string;
}>;

export type TransformerAttemptUsageInput = Readonly<{
  tenantId: string;
  campaignId: string;
  unitId: string;
  leaseGeneration: number;
  leaseToken: string;
  accounting: TransformerAdaptiveAttemptAccounting;
  observedAt: string;
  evidenceRefs: readonly string[];
  idempotencyKey: string;
  gateConfig?: string;
}>;

export type TransformerAttemptModelReservationInput = Readonly<{
  tenantId: string;
  campaignId: string;
  unitId: string;
  leaseGeneration: number;
  leaseToken: string;
  reservation: AdaptiveExternalModelReservation;
  observedAt: string;
  evidenceRefs: readonly string[];
  idempotencyKey: string;
  gateConfig?: string;
}>;

export type TransformerAttemptModelSettlementInput = Readonly<{
  tenantId: string;
  campaignId: string;
  unitId: string;
  leaseGeneration: number;
  leaseToken: string;
  settlement: AdaptiveExternalModelSettlement;
  observedAt: string;
  evidenceRefs: readonly string[];
  idempotencyKey: string;
  gateConfig?: string;
}>;

export type TransformerAttemptCoordinatorPort = Readonly<{
  claimNextAttempt(input: TransformerAttemptClaimInput): MaybePromise<TransformerExecutableAttemptLease | null>;
  renewAttemptLease(input: TransformerAttemptLeaseRenewalInput): MaybePromise<TransformerAttemptLeaseRenewal>;
  assertCurrentAttemptFence(input: TransformerCurrentAttemptFence): MaybePromise<boolean | void>;
  recordAdaptiveAttemptUsage(input: TransformerAttemptUsageInput): MaybePromise<unknown>;
  reserveAdaptiveModelCall?(input: TransformerAttemptModelReservationInput): MaybePromise<TransformerAdaptiveAttemptAccounting>;
  settleAdaptiveModelCall?(input: TransformerAttemptModelSettlementInput): MaybePromise<TransformerAdaptiveAttemptAccounting>;
  recordAdaptiveCandidateHandoff(input: TransformerAdaptiveCandidateHandoffInput): MaybePromise<unknown>;
  completeAttempt(input: TransformerAttemptCompletionInput): MaybePromise<unknown>;
  recordAttemptFailure(input: TransformerAttemptFailureInput): MaybePromise<unknown>;
}>;

export type TransformerAttemptCheckpointOpenInput = Readonly<{
  scope: TransformerAttemptScope;
  lease: TransformerExecutableAttemptLease;
  leaseToken: string;
  attemptId: string;
  source: ExactSourceSnapshot;
  fence: RecipeExecutionFence;
  assertFence(): Promise<void>;
  observedAt: string;
  signal: AbortSignal;
  operationTimeoutMs: number;
}>;

export type TransformerAttemptCheckpointCompletion = Readonly<{
  execution: RecipeWorkspaceExecutionResult;
  artifact: TransformerCandidateArtifact;
  actualCostUsd: number;
  accounting: TransformerAdaptiveAttemptAccounting;
  artifactRegistration: TransformerMissionArtifactRegistrationBinding;
  observedAt: string;
  evidenceRefs: readonly string[];
  signal: AbortSignal;
  operationTimeoutMs: number;
}>;

export type TransformerAttemptCheckpointFailure = Readonly<{
  recoveryCode: "verification_failed";
  errorCode: string;
  accounting: TransformerAdaptiveAttemptAccounting;
  observedAt: string;
  evidenceRefs: readonly string[];
  signal: AbortSignal;
  operationTimeoutMs: number;
}>;

export type TransformerAttemptCheckpointExecutionController = Readonly<{
  verificationControl: RecipeVerificationControl;
  complete(input: TransformerAttemptCheckpointCompletion): MaybePromise<void>;
  fail?(input: TransformerAttemptCheckpointFailure): MaybePromise<void>;
}>;

export type TransformerAttemptCheckpointConfig = Readonly<{
  operationTimeoutMs?: number;
  open(input: TransformerAttemptCheckpointOpenInput):
    MaybePromise<TransformerAttemptCheckpointExecutionController>;
}>;

export class TransformerAttemptCheckpointUncertainError extends Error {
  constructor(code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "TransformerAttemptCheckpointUncertainError";
  }
}

function checkpointOperationTimeoutMs(
  config: TransformerAttemptCheckpointConfig,
  leaseDurationMs: number,
): number {
  const value = config.operationTimeoutMs ?? Math.min(60_000, Math.max(250, Math.floor(leaseDurationMs / 3)));
  if (!Number.isSafeInteger(value) || value < 1 || value > Math.max(1, Math.floor(leaseDurationMs / 2))) {
    throw new AttemptRunnerError(
      "execution_failed",
      "transformer_attempt_checkpoint_timeout_invalid",
    );
  }
  return value;
}

async function runCheckpointOperation<T>(
  operation: (signal: AbortSignal) => MaybePromise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operationController = new AbortController();
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      const reason = signal.reason;
      const failure = isStale(reason)
        ? new StaleAttemptFenceError(reason)
        : new TransformerAttemptCheckpointUncertainError(
          "transformer_attempt_checkpoint_operation_aborted",
          reason,
        );
      operationController.abort(failure);
      finish(() => reject(failure));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      const failure = new TransformerAttemptCheckpointUncertainError(
        "transformer_attempt_checkpoint_operation_timeout",
      );
      operationController.abort(failure);
      finish(() => reject(failure));
    }, timeoutMs);
    timer.unref();
    Promise.resolve()
      .then(() => operation(operationController.signal))
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}

export type TransformerCandidateFileManifest = Readonly<{
  path: string;
  digest: string;
  bytes: number;
}>;

export type TransformerCandidateManifest = Readonly<{
  schemaVersion: 1;
  kind: "transformer.candidate";
  scope: Readonly<{
    tenantId: string;
    campaignId: string;
    unitId: string;
    attemptId: string;
    attemptNumber: number;
    leaseGeneration: number;
  }>;
  source: Readonly<{
    snapshotId: string;
    repositoryId: string;
    revision: string;
    manifestSha256: string;
    digest: string;
  }>;
  candidate: Readonly<{
    revision: string;
    digest: string;
    changedPaths: readonly string[];
  }>;
  executionEvidence: Readonly<{
    id: string;
    digest: string;
  }>;
  files: readonly TransformerCandidateFileManifest[];
}>;

export type TransformerCandidateArtifact = Readonly<{
  directory: string;
  filesDirectory: string;
  manifestPath: string;
  manifestDigestPath: string;
  manifestDigest: string;
  outputDigest: string;
  fileCount: number;
  reused: boolean;
  evidenceRefs: readonly string[];
}>;

export type TransformerAttemptFailureEvidenceRecord = Readonly<{
  schemaVersion: 1;
  kind: "transformer.attempt.failure";
  evidenceId: string;
  observedAt: string;
  scope: Readonly<{
    tenantId: string;
    campaignId: string;
    unitId: string;
    attemptId: string;
    attemptNumber: number;
    leaseGeneration: number;
  }>;
  fence: Readonly<{
    tenantId: string;
    campaignId: string;
    unitId: string;
    attemptId: string;
    leaseGeneration: number;
    leaseTokenDigest: string;
  }>;
  recoveryCode: TransformerAttemptRecoveryCode;
  errorCode: string;
  rollback: Readonly<{
    attempted: boolean;
    inverseVerified: boolean;
    workspaceDiscarded: boolean;
  }>;
  completedEvidenceIds: readonly string[];
  /**
   * Present and true only when adaptive repair produced a usage tally that could
   * not be trusted into the recorded accounting — for example a planner that
   * threw before any usage checkpoint or accepted external-model reservation.
   * The recorded accounting deliberately excludes that untrustworthy adaptive
   * usage; this flag preserves the diagnostic that it was incomplete rather than
   * silently dropping it. Absent on every path with complete (or no) adaptive
   * usage, so those records are byte-for-byte unchanged.
   */
  adaptiveUsageAccountingIncomplete?: true;
}>;

export type TransformerAttemptFailureArtifact = Readonly<{
  evidenceId: string;
  digest: string;
  path: string;
  record: TransformerAttemptFailureEvidenceRecord;
}>;

/**
 * Opt-in adaptive repair. When configured and the deterministic recipe fails
 * verification, the runner engages the bounded inspect/edit/verify/retry loop.
 * When absent the deterministic path is entirely unchanged.
 */
export type TransformerAdaptiveRepairConfig = Readonly<{
  planner: AdaptiveRepairPlanner;
  /** Objective gate. Defaults to the recipe's verification commands. */
  gate?: AdaptiveGate;
  /** Pre-migration regression gate for the pre-existing-failure trap. */
  baselineGate?: AdaptiveGate;
  /** Exact mutation allowlist. Defaults to the recipe's allowed paths. */
  allowedMutationPaths?: readonly string[];
  bounds?: Partial<AdaptiveRepairBounds>;
  now?: () => number;
  signal?: AbortSignal;
}>;

/**
 * Emitted when the adaptive loop converges on a fix whose digest DIVERGES from
 * the lease-bound deterministic recipe output. The consumer is expected to seal
 * the converged files and record a review-pending adaptive candidate; the runner
 * never auto-completes a divergent candidate (that path stays candidate_drift).
 */
export type TransformerAdaptiveCandidateHandoff = Readonly<{
  tenantId: string;
  campaignId: string;
  unitId: string;
  attemptId: string;
  attemptNumber: number;
  leaseGeneration: number;
  leaseToken: string;
  repositoryId: string;
  snapshotId: string;
  expectedBaseRevision: string;
  /** Deterministic recipe candidate digest the adaptive fix diverged from. */
  divergedFromDigest: string;
  /** Converged adaptive output digest. */
  candidateDigest: string;
  /** The failing objective verification that triggered adaptation. */
  failingCommandId: string | null;
  /** Complete source snapshot to final candidate delta delivered for review. */
  changedPaths: readonly string[];
  /** Paths changed specifically by the adaptive loop relative to the recipe output. */
  adaptiveChangedPaths: readonly string[];
  files: RecipeFiles;
  fileModes: RecipeFileModes;
  review: AdaptiveCandidateReviewEvidence;
  /**
   * Deterministic migration classification of the lease-bound recipe. Pure
   * metadata for the learning corpus; null where undeterminable. It never gates
   * the seal, the review, or delivery.
   */
  family: MigrationLabelFamily | null;
  provider: string | null;
  framework: string | null;
}>;

export type TransformerAdaptiveSummary = Readonly<{
  engaged: boolean;
  outcome: AdaptiveRepairOutcome["status"];
  iterationsUsed: number;
  totalIterationsUsed: number;
  unitsFixedAdaptively: number;
  unitsMarkedUnfixable: number;
  preExistingFailures: number;
  boundExhaustion: readonly AdaptiveBoundExhaustion[];
  markers: readonly AdaptiveUnfixableMarker[];
  /** The converged fix (digest + changed paths), null unless converged. */
  convergedCandidate: Readonly<{
    outputDigest: string;
    /** Complete source snapshot to final candidate delta. */
    changedPaths: readonly string[];
    /** Adaptive-only delta relative to the deterministic recipe output. */
    adaptiveChangedPaths: readonly string[];
    /** The failing objective verification that triggered adaptation. */
    failingCommandId: string | null;
    review: AdaptiveCandidateReviewEvidence;
  }> | null;
  /** Converged files carried onward for promotion (null unless converged). */
  convergedFiles: RecipeFiles | null;
  /** Best failing attempt files carried for human escalation (null if none). */
  bestAttemptFiles: RecipeFiles | null;
  usage: AdaptiveRepairUsage;
}>;

export type TransformerAttemptRunResult = Readonly<{
  status: "idle" | "completed" | "failed" | "stale";
  summary: string;
  nextActions: readonly string[];
  artifacts: readonly TransformerCandidateArtifact[];
  recoveryCode?: TransformerAttemptRecoveryCode;
  errorCode?: string;
  rollback?: RecipeExecutionRollback;
  failureEvidence?: TransformerAttemptFailureArtifact;
  /** Present only when adaptive repair was configured and engaged. */
  adaptive?: TransformerAdaptiveSummary;
  verifierShadowError?: "transformer_verifier_shadow_failed";
}>;

export type TransformerVerifiedCandidateCompletion = Readonly<{
  lease: TransformerExecutableAttemptLease;
  execution: RecipeWorkspaceExecutionResult;
  artifact: TransformerCandidateArtifact;
  observedAt: string;
}>;

function artifactRegistrationPath(root: string, path: string): string {
  const scopedRoot = resolve(root);
  const scopedPath = resolve(path);
  const local = relative(scopedRoot, scopedPath);
  if (local.length === 0 || isAbsolute(local) || local === ".." || local.startsWith(`..${posix.sep}`) ||
      local.startsWith("..\\")) {
    throw new Error("transformer_attempt_artifact_registration_path_invalid");
  }
  return local.replaceAll("\\", "/");
}

function createMissionArtifactRegistration(
  input: Pick<RunTransformerAttemptInput, "candidateRoot" | "evidenceRoot">,
  lease: TransformerExecutableAttemptLease,
  attemptId: string,
  artifact: TransformerCandidateArtifact,
  execution: RecipeWorkspaceExecutionResult,
): TransformerMissionArtifactRegistrationBinding {
  const candidateSha256 = artifact.manifestDigest.slice("sha256:".length);
  if (!DIGEST.test(artifact.manifestDigest) || !DIGEST.test(execution.evidence.digest)) {
    throw new Error("transformer_attempt_artifact_registration_digest_invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    attemptId,
    sourceSnapshotId: lease.snapshot.snapshotId,
    candidateArtifactId: `tcman_${candidateSha256}`,
    candidateManifestDigest: artifact.manifestDigest,
    candidateManifestPath: artifactRegistrationPath(input.candidateRoot, artifact.manifestPath),
    executionArtifactId: execution.evidence.record.evidenceId,
    executionEvidenceDigest: execution.evidence.digest,
    executionEvidencePath: artifactRegistrationPath(input.evidenceRoot, execution.evidence.path),
    executionSchemaVersion: execution.evidence.record.schemaVersion,
  });
}

export type RunTransformerAttemptInput = Readonly<{
  scope: TransformerAttemptScope;
  gateConfig?: string;
  coordinator: TransformerAttemptCoordinatorPort;
  loadExactSource(lease: TransformerExecutableAttemptLease): MaybePromise<ExactSourceSnapshot>;
  evidenceRoot: string;
  candidateRoot: string;
  leaseDurationMs: number;
  observedAt(phase: TransformerAttemptPhase): string;
  idempotencyKey(phase: TransformerAttemptPhase, attemptId?: string): string;
  leaseToken(): string;
  commandRunner?: RecipeCommandRunner;
  commandTimeoutMs?: number;
  tempRoot?: string;
  actualCostUsd?: number | ((execution: RecipeWorkspaceExecutionResult) => number);
  /** Opt-in authenticated checkpoint controller. The legacy path is unchanged when absent. */
  checkpoint?: TransformerAttemptCheckpointConfig;
  adaptiveRepair?: TransformerAdaptiveRepairConfig;
  /**
   * Invoked when adaptive repair converges on a candidate that diverges from the
   * deterministic recipe output. The consumer must seal and record it for human
   * review. A persistence failure fails the fenced attempt as a worker crash.
   */
  onAdaptiveCandidateConverged?(input: TransformerAdaptiveCandidateHandoff): MaybePromise<void>;
  /** Advisory verifier observer invoked only after authoritative completion. */
  onVerifiedCandidateCompleted?(input: TransformerVerifiedCandidateCompletion): MaybePromise<void>;
}>;

class AttemptRunnerError extends Error {
  readonly recoveryCode: TransformerAttemptRecoveryCode;

  constructor(recoveryCode: TransformerAttemptRecoveryCode, code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "AttemptRunnerError";
    this.recoveryCode = recoveryCode;
  }
}

class StaleAttemptFenceError extends Error {
  constructor(cause?: unknown) {
    super("transformer_attempt_fence_stale", cause === undefined ? undefined : { cause });
    this.name = "StaleAttemptFenceError";
  }
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value))}\n`;
}

function errorCode(error: unknown): string {
  if (error instanceof RecipeWorkspaceExecutionError) return error.code;
  if (error instanceof Error && error.message) return error.message;
  return "transformer_attempt_unknown_error";
}

function assertIdentifier(value: string, code: string): void {
  if (!ID.test(value) || value === "." || value === "..") throw new AttemptRunnerError("execution_failed", code);
}

function assertObservedAt(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new AttemptRunnerError("execution_failed", "transformer_attempt_observed_at_invalid");
  }
}

function assertDigest(value: string, code: string): void {
  if (!DIGEST.test(value)) throw new AttemptRunnerError("candidate_drift", code);
}

function safeRelativePath(value: string): string {
  if (!value || value.includes("\\") || value.includes("\0") || posix.isAbsolute(value)) {
    throw new AttemptRunnerError("candidate_drift", `transformer_candidate_path_invalid:${value}`);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new AttemptRunnerError("candidate_drift", `transformer_candidate_path_invalid:${value}`);
  }
  return value;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function ensureRoot(path: string, code: string): string {
  if (!isAbsolute(path)) throw new AttemptRunnerError("execution_failed", `${code}_absolute_required`);
  const requested = resolve(path);
  if (existsSync(requested) && lstatSync(requested).isSymbolicLink()) {
    throw new AttemptRunnerError("execution_failed", `${code}_symlink_forbidden`);
  }
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const root = realpathSync(requested);
  if (!lstatSync(root).isDirectory()) throw new AttemptRunnerError("execution_failed", `${code}_not_directory`);
  return root;
}

function assertDirectorySafe(root: string, path: string, code: string): string {
  const target = resolve(path);
  if (!isWithin(root, target)) throw new AttemptRunnerError("execution_failed", `${code}_escape`);
  if (!existsSync(target)) throw new AttemptRunnerError("execution_failed", `${code}_missing`);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new AttemptRunnerError("execution_failed", `${code}_unsafe`);
  }
  const real = realpathSync(target);
  if (!isWithin(root, real)) throw new AttemptRunnerError("execution_failed", `${code}_realpath_escape`);
  return real;
}

function ensureDirectory(root: string, parent: string, segment: string): string {
  const target = resolve(parent, segment);
  if (!isWithin(root, target)) throw new AttemptRunnerError("execution_failed", "transformer_candidate_directory_escape");
  if (!existsSync(target)) mkdirSync(target, { mode: 0o700 });
  return assertDirectorySafe(root, target, "transformer_candidate_directory");
}

function storageSegment(label: string, value: string): string {
  assertIdentifier(value, `transformer_attempt_${label}_invalid`);
  return `${label}-${sha256(value).slice("sha256:".length, "sha256:".length + 32)}`;
}

function scopedParent(root: string, scope: TransformerAttemptScope, unitId: string): string {
  let current = root;
  for (const [label, value] of [
    ["tenant", scope.tenantId],
    ["campaign", scope.campaignId],
    ["unit", unitId],
  ] as const) {
    current = ensureDirectory(root, current, storageSegment(label, value));
  }
  return current;
}

function attemptDirectoryName(attemptId: string): string {
  return storageSegment("attempt", attemptId);
}

function openExclusive(path: string): number {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  return openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
}

function durableWrite(path: string, content: string): void {
  const fd = openExclusive(path);
  try {
    writeFileSync(fd, content, { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function manifestFiles(files: RecipeFiles): readonly TransformerCandidateFileManifest[] {
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length || entries.length > MAX_CANDIDATE_FILES) {
    throw new AttemptRunnerError("candidate_drift", "transformer_candidate_files_invalid");
  }
  let total = 0;
  return Object.freeze(entries.map(([path, content]) => {
    safeRelativePath(path);
    if (typeof content !== "string") {
      throw new AttemptRunnerError("candidate_drift", `transformer_candidate_content_invalid:${path}`);
    }
    const bytes = Buffer.byteLength(content, "utf8");
    total += bytes;
    if (total > MAX_CANDIDATE_BYTES) {
      throw new AttemptRunnerError("candidate_drift", "transformer_candidate_too_large");
    }
    return Object.freeze({ path, digest: sha256(content), bytes });
  }));
}

function candidateFilePath(filesRoot: string, relativePath: string): string {
  const safe = safeRelativePath(relativePath);
  const target = resolve(filesRoot, ...safe.split("/"));
  if (!isWithin(filesRoot, target)) {
    throw new AttemptRunnerError("candidate_drift", `transformer_candidate_path_escape:${safe}`);
  }
  return target;
}

function ensureCandidateFileParent(filesRoot: string, relativePath: string): string {
  const parts = safeRelativePath(relativePath).split("/").slice(0, -1);
  let current = filesRoot;
  for (const part of parts) current = ensureDirectory(filesRoot, current, part);
  return current;
}

function listTree(root: string, prefix = ""): string[] {
  const paths: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const full = join(root, name);
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new AttemptRunnerError("candidate_drift", `transformer_candidate_symlink:${relativePath}`);
    if (stat.isDirectory()) paths.push(...listTree(full, relativePath));
    else if (stat.isFile()) paths.push(relativePath);
    else throw new AttemptRunnerError("candidate_drift", `transformer_candidate_entry_invalid:${relativePath}`);
  }
  return paths;
}

function candidateEvidenceRefs(execution: RecipeWorkspaceExecutionResult, manifestDigest: string): readonly string[] {
  return Object.freeze([
    execution.evidence.record.evidenceId,
    `tcman_${manifestDigest.slice("sha256:".length)}`,
  ]);
}

function parseExistingManifest(serialized: string): TransformerCandidateManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new AttemptRunnerError("candidate_drift", "transformer_candidate_manifest_invalid", error);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || canonicalJson(parsed) !== serialized) {
    throw new AttemptRunnerError("candidate_drift", "transformer_candidate_manifest_noncanonical");
  }
  return parsed as TransformerCandidateManifest;
}

function validateExistingCandidate(
  root: string,
  directory: string,
  manifest: TransformerCandidateManifest,
  outputFiles: RecipeFiles,
  execution: RecipeWorkspaceExecutionResult,
): TransformerCandidateArtifact {
  const realDirectory = assertDirectorySafe(root, directory, "transformer_candidate_attempt");
  const manifestPath = join(realDirectory, "manifest.json");
  const manifestDigestPath = join(realDirectory, "manifest.sha256");
  const filesDirectory = assertDirectorySafe(root, join(realDirectory, "files"), "transformer_candidate_files");
  for (const path of [manifestPath, manifestDigestPath]) {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
      throw new AttemptRunnerError("candidate_drift", "transformer_candidate_manifest_missing");
    }
  }
  const serialized = readFileSync(manifestPath, "utf8");
  const digest = sha256(serialized);
  if (readFileSync(manifestDigestPath, "utf8") !== `${digest}\n`) {
    throw new AttemptRunnerError("candidate_drift", "transformer_candidate_manifest_conflict");
  }
  const existingManifest = parseExistingManifest(serialized);
  const expectedWithPersistedEvidence: TransformerCandidateManifest = Object.freeze({
    ...manifest,
    executionEvidence: existingManifest.executionEvidence,
  });
  if (canonicalJson(existingManifest) !== canonicalJson(expectedWithPersistedEvidence) ||
      !/^tre_execution_[a-f0-9]{64}$/.test(existingManifest.executionEvidence?.id ?? "") ||
      !DIGEST.test(existingManifest.executionEvidence?.digest ?? "")) {
    throw new AttemptRunnerError("candidate_drift", "transformer_candidate_manifest_conflict");
  }
  const persistedExecutionPath = join(dirname(execution.evidence.path), `${existingManifest.executionEvidence.id}.json`);
  if (!existsSync(persistedExecutionPath) || lstatSync(persistedExecutionPath).isSymbolicLink() ||
      sha256(readFileSync(persistedExecutionPath)) !== existingManifest.executionEvidence.digest) {
    throw new AttemptRunnerError("candidate_drift", "transformer_candidate_execution_evidence_conflict");
  }
  const expectedTree = [
    ...existingManifest.files.map((file) => `files/${file.path}`),
    "manifest.json",
    "manifest.sha256",
  ].sort();
  if (JSON.stringify(listTree(realDirectory).sort()) !== JSON.stringify(expectedTree)) {
    throw new AttemptRunnerError("candidate_drift", "transformer_candidate_tree_conflict");
  }
  for (const file of existingManifest.files) {
    const path = candidateFilePath(filesDirectory, file.path);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
      throw new AttemptRunnerError("candidate_drift", `transformer_candidate_file_missing:${file.path}`);
    }
    const content = readFileSync(path, "utf8");
    if (content !== outputFiles[file.path] || sha256(content) !== file.digest) {
      throw new AttemptRunnerError("candidate_drift", `transformer_candidate_file_conflict:${file.path}`);
    }
  }
  return Object.freeze({
    directory: realDirectory,
    filesDirectory,
    manifestPath,
    manifestDigestPath,
    manifestDigest: digest,
    outputDigest: existingManifest.candidate.digest,
    fileCount: existingManifest.files.length,
    reused: true,
    evidenceRefs: Object.freeze([
      existingManifest.executionEvidence.id,
      ...candidateEvidenceRefs(execution, digest),
    ].filter((value, index, values) => values.indexOf(value) === index)),
  });
}

export function persistTransformerCandidate(
  candidateRoot: string,
  scope: TransformerAttemptScope,
  lease: TransformerExecutableAttemptLease,
  attemptId: string,
  execution: RecipeWorkspaceExecutionResult,
): TransformerCandidateArtifact {
  const root = ensureRoot(candidateRoot, "transformer_candidate_root");
  const parent = scopedParent(root, scope, lease.unitId);
  const directory = resolve(parent, attemptDirectoryName(attemptId));
  if (!isWithin(root, directory)) throw new AttemptRunnerError("execution_failed", "transformer_candidate_attempt_escape");
  const files = manifestFiles(execution.outputFiles);
  const manifest: TransformerCandidateManifest = Object.freeze({
    schemaVersion: 1,
    kind: "transformer.candidate",
    scope: Object.freeze({
      tenantId: scope.tenantId,
      campaignId: scope.campaignId,
      unitId: lease.unitId,
      attemptId,
      attemptNumber: lease.attemptNumber,
      leaseGeneration: lease.leaseGeneration,
    }),
    source: Object.freeze({
      snapshotId: lease.snapshot.snapshotId,
      repositoryId: lease.snapshot.repositoryId,
      revision: lease.snapshot.revision,
      manifestSha256: lease.snapshot.manifestSha256,
      digest: lease.snapshot.digest,
    }),
    candidate: Object.freeze({
      revision: lease.candidateRevision,
      digest: lease.candidateDigest,
      changedPaths: Object.freeze([...lease.changedPaths].sort()),
    }),
    executionEvidence: Object.freeze({
      id: execution.evidence.record.evidenceId,
      digest: execution.evidence.digest,
    }),
    files,
  });
  if (existsSync(directory)) return validateExistingCandidate(root, directory, manifest, execution.outputFiles, execution);

  const temporary = mkdtempSync(join(parent, ".candidate-tmp-"));
  try {
    const realTemporary = assertDirectorySafe(root, temporary, "transformer_candidate_temporary");
    const filesDirectory = ensureDirectory(realTemporary, realTemporary, "files");
    for (const [path, content] of Object.entries(execution.outputFiles).sort(([left], [right]) => left.localeCompare(right))) {
      ensureCandidateFileParent(filesDirectory, path);
      durableWrite(candidateFilePath(filesDirectory, path), content);
    }
    const serialized = canonicalJson(manifest);
    const digest = sha256(serialized);
    durableWrite(join(realTemporary, "manifest.json"), serialized);
    durableWrite(join(realTemporary, "manifest.sha256"), `${digest}\n`);
    syncDirectory(filesDirectory);
    syncDirectory(realTemporary);
    try {
      renameSync(realTemporary, directory);
    } catch (error) {
      if (!existsSync(directory)) throw error;
      rmSync(realTemporary, { recursive: true, force: true });
      return validateExistingCandidate(root, directory, manifest, execution.outputFiles, execution);
    }
    syncDirectory(parent);
    const persisted = validateExistingCandidate(root, directory, manifest, execution.outputFiles, execution);
    return Object.freeze({ ...persisted, reused: false });
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function transformerAttemptId(lease: TransformerExecutableAttemptLease): string {
  const identity = [
    lease.tenantId,
    lease.campaignId,
    lease.unitId,
    String(lease.attemptNumber),
    String(lease.leaseGeneration),
  ].join("\0");
  return `tfattempt_${sha256(identity).slice("sha256:".length, "sha256:".length + 32)}`;
}

function validateScope(scope: TransformerAttemptScope): void {
  assertIdentifier(scope.tenantId, "transformer_attempt_tenant_invalid");
  assertIdentifier(scope.environment, "transformer_attempt_environment_invalid");
  assertIdentifier(scope.campaignId, "transformer_attempt_campaign_invalid");
}

function validateLease(lease: TransformerExecutableAttemptLease, scope: TransformerAttemptScope, leaseToken: string): void {
  if (lease.type !== "execute_recipe" || lease.tenantId !== scope.tenantId || lease.campaignId !== scope.campaignId) {
    throw new AttemptRunnerError("execution_failed", "transformer_attempt_lease_scope_mismatch");
  }
  assertIdentifier(lease.unitId, "transformer_attempt_unit_invalid");
  if (!Number.isSafeInteger(lease.attemptNumber) || lease.attemptNumber < 1 ||
      !Number.isSafeInteger(lease.leaseGeneration) || lease.leaseGeneration < 1) {
    throw new AttemptRunnerError("execution_failed", "transformer_attempt_lease_invalid");
  }
  const startedAt = Date.parse(lease.startedAt);
  const expiresAt = Date.parse(lease.leaseExpiresAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(expiresAt) || startedAt >= expiresAt) {
    throw new AttemptRunnerError("execution_failed", "transformer_attempt_lease_accounting_invalid");
  }
  const remaining = lease.adaptiveBudgetRemaining;
  if (!remaining || typeof remaining !== "object" ||
      !Number.isSafeInteger(remaining.attempts) || remaining.attempts < 0 ||
      !Number.isSafeInteger(remaining.plannerCalls) || remaining.plannerCalls < 1 ||
      !Number.isSafeInteger(remaining.modelCalls) || remaining.modelCalls < 1 ||
      !Number.isSafeInteger(remaining.inputTokens) || remaining.inputTokens < 1 ||
      !Number.isSafeInteger(remaining.outputTokens) || remaining.outputTokens < 1 ||
      !Number.isSafeInteger(remaining.totalTokens) || remaining.totalTokens < 1 ||
      typeof remaining.actualCostUsd !== "number" || !Number.isFinite(remaining.actualCostUsd) ||
      remaining.actualCostUsd <= 0 ||
      !Number.isSafeInteger(remaining.wallTimeMs) || remaining.wallTimeMs < 1) {
    throw new AttemptRunnerError("execution_failed", "transformer_attempt_budget_remaining_invalid");
  }
  if (lease.leaseTokenDigest !== sha256(leaseToken)) {
    throw new StaleAttemptFenceError();
  }
  if (!REVISION.test(lease.candidateRevision)) {
    throw new AttemptRunnerError("candidate_drift", "transformer_attempt_candidate_revision_invalid");
  }
  assertDigest(lease.candidateDigest, "transformer_attempt_candidate_digest_invalid");
  if (!Array.isArray(lease.changedPaths) || !lease.changedPaths.length) {
    throw new AttemptRunnerError("candidate_drift", "transformer_attempt_changed_paths_required");
  }
  const paths = lease.changedPaths.map(safeRelativePath);
  if (new Set(paths).size !== paths.length) {
    throw new AttemptRunnerError("candidate_drift", "transformer_attempt_changed_paths_duplicate");
  }
}

function bindSource(source: ExactSourceSnapshot, lease: TransformerExecutableAttemptLease): void {
  try {
    normalizeRecipeFileModes(source.files, source.fileModes);
    if (source.repositoryId !== lease.snapshot.repositoryId ||
        source.revision !== lease.snapshot.revision ||
        source.digest !== lease.snapshot.digest ||
        recipeFilesDigest(source.files) !== source.digest) {
      throw new Error("transformer_attempt_source_drift");
    }
  } catch (error) {
    throw new AttemptRunnerError("source_drift", "transformer_attempt_source_drift", error);
  }
}

function bindCandidate(execution: RecipeWorkspaceExecutionResult, lease: TransformerExecutableAttemptLease): void {
  if (execution.outputDigest !== lease.candidateDigest) {
    throw new AttemptRunnerError("candidate_drift", "transformer_attempt_candidate_digest_mismatch");
  }
  const allowed = new Set(lease.changedPaths);
  const changed = execution.operations.map((operation) => operation.path);
  if (changed.some((path) => !allowed.has(path))) {
    throw new AttemptRunnerError("candidate_drift", "transformer_attempt_changed_paths_mismatch");
  }
}

function classify(error: unknown): Readonly<{
  recoveryCode: TransformerAttemptRecoveryCode;
  errorCode: string;
  rollback?: RecipeExecutionRollback;
}> {
  if (error instanceof AttemptRunnerError) {
    return { recoveryCode: error.recoveryCode, errorCode: error.message };
  }
  if (error instanceof RecipeWorkspaceExecutionError) {
    const rawCode = normalizedErrorCode(error.code);
    const closedCode = /^(?:recipe_execution|recipe_workspace|recipe_inverse|recipe_path|recipe_no_changes|recipe_not_applicable)[a-z0-9_.:-]{0,140}$/.test(rawCode)
      ? rawCode
      : "recipe_workspace_execution_failed";
    return {
      recoveryCode: error.code.includes("verification_failed") ? "verification_failed" : "execution_failed",
      errorCode: closedCode,
      rollback: error.rollback,
    };
  }
  return { recoveryCode: "worker_crash", errorCode: "transformer_attempt_worker_crash" };
}

function isStale(error: unknown): boolean {
  const code = errorCode(error);
  return error instanceof StaleAttemptFenceError || [
    "fence_stale",
    "fence_expired",
    "attempt_not_running",
    "campaign_not_running",
    "lease_expired_before_renewal",
    "checkpoint_head_conflict",
    "checkpoint_lease_mismatch",
    "checkpoint_lease_expired",
  ].some((marker) => code.includes(marker));
}

function nextActions(code: TransformerAttemptRecoveryCode): readonly string[] {
  const actions: Record<TransformerAttemptRecoveryCode, readonly string[]> = {
    source_drift: ["Reload and replan the unit from the current source revision"],
    candidate_drift: ["Regenerate the candidate contract before retrying"],
    verification_failed: ["Review verification evidence and authorize a fenced retry"],
    execution_failed: ["Review execution evidence and authorize a fenced retry"],
    worker_crash: ["Resolve worker health and authorize a fenced retry"],
  };
  return actions[code];
}

function fenceFor(lease: TransformerExecutableAttemptLease, attemptId: string, leaseToken: string): RecipeExecutionFence {
  return Object.freeze({
    tenantId: lease.tenantId,
    campaignId: lease.campaignId,
    unitId: lease.unitId,
    attemptId,
    leaseGeneration: lease.leaseGeneration,
    leaseToken,
  });
}

function currentFenceFor(
  lease: TransformerExecutableAttemptLease,
  fence: RecipeExecutionFence,
  observedAt: string,
): TransformerCurrentAttemptFence {
  return Object.freeze({
    tenantId: fence.tenantId,
    campaignId: fence.campaignId,
    unitId: fence.unitId,
    leaseGeneration: lease.leaseGeneration,
    leaseToken: fence.leaseToken,
    observedAt,
  });
}

type TransformerLeaseHeartbeat = Readonly<{
  signal: AbortSignal;
  confirm(): Promise<void>;
  stop(): Promise<void>;
}>;

class LeaseRenewalUncertainError extends Error {
  constructor(cause?: unknown) {
    super("transformer_attempt_lease_renewal_failed", cause === undefined ? undefined : { cause });
    this.name = "LeaseRenewalUncertainError";
  }
}

function startLeaseHeartbeat(
  input: RunTransformerAttemptInput,
  lease: TransformerExecutableAttemptLease,
  leaseToken: string,
  attemptId: string,
): TransformerLeaseHeartbeat {
  let stopped = false;
  let ordinal = 0;
  let renewal: Promise<void> | undefined;
  let failure: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentExpiry = Date.parse(lease.leaseExpiresAt);
  const controller = new AbortController();
  const intervalMs = Math.max(250, Math.floor(input.leaseDurationMs / 3));
  const fail = (error: unknown): void => {
    failure = error;
    controller.abort(error);
  };
  const schedule = (): void => {
    if (stopped || renewal || failure) return;
    const observedAt = input.observedAt("renew");
    assertObservedAt(observedAt);
    const remainingMs = currentExpiry - Date.parse(observedAt);
    if (remainingMs <= 0) {
      fail(new StaleAttemptFenceError(new Error("transformer_attempt_lease_expired_before_renewal")));
      return;
    }
    if (remainingMs <= intervalMs) {
      renew();
      return;
    }
    const delayMs = Math.max(10, Math.min(intervalMs, Math.floor(remainingMs / 3)));
    timer = setTimeout(renew, delayMs);
    timer.unref();
  };
  const renew = (): void => {
    if (stopped || renewal || failure) return;
    const observedAt = input.observedAt("renew");
    assertObservedAt(observedAt);
    const remainingMs = currentExpiry - Date.parse(observedAt);
    if (remainingMs <= 0) {
      fail(new StaleAttemptFenceError(new Error("transformer_attempt_lease_expired_before_renewal")));
      return;
    }
    const renewalOrdinal = ordinal;
    ordinal += 1;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = Math.max(1, Math.floor(remainingMs / 2));
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("transformer_attempt_lease_renewal_timeout")), timeoutMs);
      timeout.unref();
    });
    renewal = (async () => {
      const result = await Promise.race([
        input.coordinator.renewAttemptLease({
          tenantId: lease.tenantId,
          campaignId: lease.campaignId,
          unitId: lease.unitId,
          leaseGeneration: lease.leaseGeneration,
          leaseToken,
          leaseDurationMs: input.leaseDurationMs,
          observedAt,
          evidenceRefs: lease.gateEvidenceRefs,
          idempotencyKey: input.idempotencyKey("renew", `${attemptId}:${renewalOrdinal}`),
          gateConfig: input.gateConfig,
        }),
        timedOut,
      ]);
      const nextExpiry = Date.parse(result.leaseExpiresAt);
      if (result.leaseGeneration !== lease.leaseGeneration ||
          result.leaseTokenDigest !== lease.leaseTokenDigest ||
          !Number.isFinite(nextExpiry) || nextExpiry <= currentExpiry) {
        throw new Error("transformer_attempt_lease_renewal_invalid");
      }
      currentExpiry = nextExpiry;
    })().catch((error: unknown) => {
      fail(error);
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
      renewal = undefined;
      schedule();
    });
  };
  schedule();
  return Object.freeze({
    signal: controller.signal,
    async confirm(): Promise<void> {
      if (renewal) await renewal;
      if (failure !== undefined) {
        if (isStale(failure)) throw new StaleAttemptFenceError(failure);
        throw new LeaseRenewalUncertainError(failure);
      }
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (renewal) await renewal;
    },
  });
}

async function assertCurrentFence(
  coordinator: TransformerAttemptCoordinatorPort,
  lease: TransformerExecutableAttemptLease,
  fence: RecipeExecutionFence,
  observedAt: string,
  heartbeat?: TransformerLeaseHeartbeat,
): Promise<void> {
  try {
    await heartbeat?.confirm();
    assertObservedAt(observedAt);
    const current = await coordinator.assertCurrentAttemptFence(currentFenceFor(lease, fence, observedAt));
    if (current === false) throw new StaleAttemptFenceError();
    await heartbeat?.confirm();
  } catch (error) {
    if (isStale(error)) throw new StaleAttemptFenceError(error);
    throw error;
  }
}

function scopedEvidenceDirectory(rootPath: string, scope: TransformerAttemptScope, lease: TransformerExecutableAttemptLease, attemptId: string): string {
  const root = ensureRoot(rootPath, "transformer_evidence_root");
  const parent = scopedParent(root, scope, lease.unitId);
  return ensureDirectory(root, parent, attemptDirectoryName(attemptId));
}

function normalizedErrorCode(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);
  return normalized || "transformer_attempt_unknown_error";
}

export function persistTransformerAttemptFailureEvidence(
  evidenceDirectory: string,
  lease: TransformerExecutableAttemptLease,
  attemptId: string,
  leaseToken: string,
  observedAt: string,
  recoveryCode: TransformerAttemptRecoveryCode,
  failureErrorCode: string,
  rollback: RecipeExecutionRollback | undefined,
  completedEvidenceIds: readonly string[],
  adaptiveUsageAccountingIncomplete = false,
): TransformerAttemptFailureArtifact {
  assertObservedAt(observedAt);
  const directory = realpathSync(evidenceDirectory);
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
    throw new AttemptRunnerError("worker_crash", "transformer_failure_evidence_directory_unsafe");
  }
  const recordBody = Object.freeze({
    schemaVersion: 1 as const,
    kind: "transformer.attempt.failure" as const,
    observedAt,
    scope: Object.freeze({
      tenantId: lease.tenantId,
      campaignId: lease.campaignId,
      unitId: lease.unitId,
      attemptId,
      attemptNumber: lease.attemptNumber,
      leaseGeneration: lease.leaseGeneration,
    }),
    fence: Object.freeze({
      tenantId: lease.tenantId,
      campaignId: lease.campaignId,
      unitId: lease.unitId,
      attemptId,
      leaseGeneration: lease.leaseGeneration,
      leaseTokenDigest: sha256(leaseToken),
    }),
    recoveryCode,
    errorCode: normalizedErrorCode(failureErrorCode),
    rollback: Object.freeze({
      attempted: rollback?.attempted ?? false,
      inverseVerified: rollback?.inverseVerified ?? false,
      workspaceDiscarded: rollback?.workspaceDiscarded ?? true,
    }),
    completedEvidenceIds: Object.freeze([...new Set(completedEvidenceIds)].sort().slice(0, 32)),
    ...(adaptiveUsageAccountingIncomplete ? { adaptiveUsageAccountingIncomplete: true as const } : {}),
  });
  const evidenceId = `tfev_${sha256(canonicalJson(recordBody)).slice("sha256:".length)}`;
  const record: TransformerAttemptFailureEvidenceRecord = Object.freeze({ ...recordBody, evidenceId });
  const serialized = canonicalJson(record);
  if (Buffer.byteLength(serialized, "utf8") > 16 * 1024) {
    throw new AttemptRunnerError("worker_crash", "transformer_failure_evidence_too_large");
  }
  const digest = sha256(serialized);
  const path = join(directory, `${evidenceId}.json`);
  const temporary = join(directory, `.${evidenceId}.${randomUUID()}.tmp`);
  durableWrite(temporary, serialized);
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || readFileSync(path, "utf8") !== serialized) {
      throw new AttemptRunnerError("worker_crash", "transformer_failure_evidence_conflict", error);
    }
  }
  syncDirectory(directory);
  return Object.freeze({ evidenceId, digest, path, record });
}

function actualCost(input: RunTransformerAttemptInput, execution: RecipeWorkspaceExecutionResult): number {
  const value = typeof input.actualCostUsd === "function"
    ? input.actualCostUsd(execution)
    : input.actualCostUsd ?? 0;
  if (!Number.isFinite(value) || value < 0) {
    throw new AttemptRunnerError("execution_failed", "transformer_attempt_cost_invalid");
  }
  return value;
}

function accountingExecutionCost(
  input: RunTransformerAttemptInput,
  execution: RecipeWorkspaceExecutionResult | undefined,
): number {
  if (execution) return actualCost(input, execution);
  if (typeof input.actualCostUsd === "function") {
    throw new AttemptRunnerError("worker_crash", "transformer_attempt_cost_accounting_incomplete");
  }
  const value = input.actualCostUsd ?? 0;
  if (!Number.isFinite(value) || value < 0) {
    throw new AttemptRunnerError("worker_crash", "transformer_attempt_cost_accounting_invalid");
  }
  return value;
}

function attemptAccounting(
  lease: TransformerExecutableAttemptLease,
  observedAt: string,
  executionCostUsd: number,
  usage?: AdaptiveRepairUsage,
): TransformerAdaptiveAttemptAccounting {
  assertObservedAt(observedAt);
  const wallTimeMs = Date.parse(observedAt) - Date.parse(lease.startedAt);
  if (!Number.isSafeInteger(wallTimeMs) || wallTimeMs < 0) {
    throw new AttemptRunnerError("worker_crash", "transformer_adaptive_wall_time_accounting_invalid");
  }
  if (usage && !usage.complete) {
    throw new AttemptRunnerError("worker_crash", "transformer_adaptive_usage_accounting_incomplete");
  }
  const plannerCalls = usage?.plannerCalls ?? 0;
  const modelCalls = usage?.modelCalls ?? 0;
  const inputTokens = usage?.promptTokens ?? 0;
  const outputTokens = usage?.completionTokens ?? 0;
  const totalTokens = usage?.totalTokens ?? 0;
  const adaptiveCostUsd = usage?.costUsd ?? 0;
  if (
    !Number.isSafeInteger(plannerCalls) || plannerCalls < 0 ||
    !Number.isSafeInteger(modelCalls) || modelCalls < 0 || modelCalls > plannerCalls ||
    !Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) || outputTokens < 0 ||
    !Number.isSafeInteger(totalTokens) || totalTokens !== inputTokens + outputTokens ||
    !Number.isFinite(adaptiveCostUsd) || adaptiveCostUsd < 0
  ) {
    throw new AttemptRunnerError("worker_crash", "transformer_adaptive_usage_accounting_invalid");
  }
  const actualCostUsd = executionCostUsd + adaptiveCostUsd;
  if (!Number.isFinite(actualCostUsd) || actualCostUsd < 0) {
    throw new AttemptRunnerError("worker_crash", "transformer_adaptive_cost_accounting_invalid");
  }
  return Object.freeze({
    plannerCalls,
    modelCalls,
    inputTokens,
    outputTokens,
    totalTokens,
    actualCostUsd,
    wallTimeMs,
  });
}

function changedPathsBetweenSourceAndFinal(
  sourceFiles: RecipeFiles,
  finalFiles: RecipeFiles,
): readonly string[] {
  const paths = [...new Set([...Object.keys(sourceFiles), ...Object.keys(finalFiles)])].sort();
  const changed = paths.filter((path) => sourceFiles[path] !== finalFiles[path]);
  if (changed.some((path) => finalFiles[path] === undefined)) {
    throw new AttemptRunnerError(
      "candidate_drift",
      "transformer_adaptive_candidate_delete_unsupported",
    );
  }
  return Object.freeze(changed);
}

function deterministicSemanticCategory(path: string): AdaptiveSemanticCategory {
  const normalized = path.toLowerCase();
  if (
    normalized === "package.json" ||
    normalized.endsWith("lock.json") ||
    normalized.endsWith("lock.yaml") ||
    normalized.endsWith("lock.yml")
  ) return "dependencies";
  if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\./.test(normalized)) return "tests";
  if (/(?:^|\/)(?:readme|changelog|docs?)(?:\.|\/|$)/.test(normalized)) return "documentation";
  if (
    normalized === "dockerfile" ||
    normalized.startsWith(".") ||
    /(?:^|\/)(?:config|configuration)(?:\/|$)/.test(normalized)
  ) return "configuration";
  return "behavior";
}

function candidateReviewEvidence(
  review: AdaptiveRepairReviewEvidence,
  sourceFiles: RecipeFiles,
  convergedFiles: RecipeFiles,
  sourceModes: RecipeFileModes,
): AdaptiveCandidateReviewEvidence {
  const sourceFileModes = adaptiveOutputFileModes(sourceFiles, sourceModes);
  const afterModes = adaptiveOutputFileModes(convergedFiles, sourceModes);
  const adaptiveByPath = new Map(review.edits.map((edit) => [edit.path, edit]));
  const changedPaths = changedPathsBetweenSourceAndFinal(sourceFiles, convergedFiles);
  const edits = changedPaths.map((path): AdaptiveCandidateReviewEdit => {
    const adaptive = adaptiveByPath.get(path);
    const beforeContent = sourceFiles[path] ?? null;
    const afterContent = convergedFiles[path];
    if (afterContent === undefined) throw new Error(`adaptive_review_after_missing:${path}`);
    return Object.freeze({
      path,
      changeType: beforeContent === null ? "add" as const : "modify" as const,
      beforeContent,
      beforeDigest: sha256(beforeContent ?? ""),
      beforeMode: beforeContent === null ? null : sourceFileModes[path]!,
      afterDigest: sha256(afterContent),
      afterMode: afterModes[path]!,
      semanticCategory: adaptive?.semanticCategory ?? deterministicSemanticCategory(path),
      rationale: adaptive?.rationale ?? "Apply the approved deterministic migration recipe change.",
      risk: adaptive?.risk ?? "medium",
      confidence: adaptive?.confidence ?? 100,
    });
  });
  const riskRank: Readonly<Record<AdaptiveReviewRisk, number>> = { low: 0, medium: 1, high: 2 };
  const overallRisk = edits.reduce<AdaptiveReviewRisk>(
    (highest, edit) => riskRank[edit.risk] > riskRank[highest] ? edit.risk : highest,
    review.overallRisk,
  );
  return Object.freeze({
    schemaVersion: 1,
    edits: Object.freeze(edits),
    verification: review.verification,
    overallRisk,
    confidence: edits.reduce((minimum, edit) => Math.min(minimum, edit.confidence), review.confidence),
  });
}

function summarizeAdaptiveOutcome(
  outcome: AdaptiveRepairOutcome,
  sourceFiles: RecipeFiles,
  sourceModes: RecipeFileModes,
): TransformerAdaptiveSummary {
  const base = {
    engaged: outcome.status !== "not_engaged",
    outcome: outcome.status,
    iterationsUsed: outcome.iterationsUsed,
    totalIterationsUsed: outcome.iterationsUsed,
    usage: outcome.usage,
  } as const;
  if (outcome.status === "converged") {
    return Object.freeze({
      ...base,
      unitsFixedAdaptively: 1,
      unitsMarkedUnfixable: 0,
      preExistingFailures: 0,
      boundExhaustion: Object.freeze([]),
      markers: Object.freeze([]),
      convergedCandidate: Object.freeze({
        outputDigest: outcome.outputDigest,
        changedPaths: changedPathsBetweenSourceAndFinal(sourceFiles, outcome.files),
        adaptiveChangedPaths: outcome.changedPaths,
        failingCommandId: outcome.triggeredByFailingCommandId,
        review: candidateReviewEvidence(
          outcome.review,
          sourceFiles,
          outcome.files,
          sourceModes,
        ),
      }),
      convergedFiles: outcome.files,
      bestAttemptFiles: null,
    });
  }
  if (outcome.status === "pre_existing_failure") {
    return Object.freeze({
      ...base,
      unitsFixedAdaptively: 0,
      unitsMarkedUnfixable: 0,
      preExistingFailures: 1,
      boundExhaustion: Object.freeze([]),
      markers: Object.freeze([outcome.marker]),
      convergedCandidate: null,
      convergedFiles: null,
      bestAttemptFiles: null,
    });
  }
  if (outcome.status === "unfixable") {
    return Object.freeze({
      ...base,
      unitsFixedAdaptively: 0,
      unitsMarkedUnfixable: 1,
      preExistingFailures: 0,
      boundExhaustion: Object.freeze(outcome.boundExhausted ? [outcome.boundExhausted] : []),
      markers: Object.freeze([outcome.marker]),
      convergedCandidate: null,
      convergedFiles: null,
      bestAttemptFiles: outcome.bestAttemptFiles,
    });
  }
  return Object.freeze({
    ...base,
    unitsFixedAdaptively: 0,
    unitsMarkedUnfixable: 0,
    preExistingFailures: 0,
    boundExhaustion: Object.freeze([]),
    markers: Object.freeze([]),
    convergedCandidate: null,
    convergedFiles: null,
    bestAttemptFiles: null,
  });
}

function adaptiveOutputFileModes(
  files: RecipeFiles,
  sourceModes: RecipeFileModes,
): RecipeFileModes {
  const modes = Object.fromEntries(
    Object.keys(files)
      .sort((left, right) => left.localeCompare(right))
      .map((path) => [path, sourceModes[path] ?? "100644"] as const),
  );
  return normalizeRecipeFileModes(files, modes);
}

async function runAttemptAdaptiveRepair(
  input: RunTransformerAttemptInput,
  lease: TransformerExecutableAttemptLease,
  leaseToken: string,
  source: ExactSourceSnapshot,
  reservedExecutionCostUsd: number,
  adaptiveStartedAt: string,
  onUsageCheckpoint: (usage: AdaptiveRepairUsage) => Promise<void>,
  onExternalAccountingAccepted: (accounting: TransformerAdaptiveAttemptAccounting) => void,
  leaseSignal?: AbortSignal,
): Promise<TransformerAdaptiveSummary | undefined> {
  const config = input.adaptiveRepair;
  if (!config) return undefined;
  // Regeneration review feedback is retained on the fenced lease but must not
  // be sent to a planner until an explicit tenant-scoped external-processing
  // policy is available. Fail before planner invocation instead of running an
  // unguided retry that would falsely imply the human feedback was applied.
  if (lease.regenerationReview) {
    throw new AttemptRunnerError(
      "verification_failed",
      "transformer_regeneration_review_external_processing_not_approved",
    );
  }
  let recipeFiles: RecipeFiles;
  let allowedMutationPaths: readonly string[];
  try {
    const application = applyRecipe(lease.recipe, source.files);
    recipeFiles = application.files;
    allowedMutationPaths = config.allowedMutationPaths ?? resolveRecipe(lease.recipe).allowedPaths;
    if (application.outputDigest !== lease.candidateDigest) {
      throw new AttemptRunnerError(
        "candidate_drift",
        "transformer_attempt_candidate_digest_mismatch",
      );
    }
    const reconstructedPaths = [...new Set(application.operations.map((operation) => operation.path))].sort();
    const leasedPaths = [...new Set(lease.changedPaths)].sort();
    if (
      reconstructedPaths.length !== leasedPaths.length ||
      reconstructedPaths.some((path, index) => path !== leasedPaths[index])
    ) {
      throw new AttemptRunnerError(
        "candidate_drift",
        "transformer_attempt_changed_paths_mismatch",
      );
    }
  } catch (error) {
    // The deterministic recipe output could not be reconstructed; skip adaptive
    // repair rather than guess.
    if (error instanceof AttemptRunnerError) throw error;
    return undefined;
  }
  const gate: AdaptiveGate =
    config.gate ??
    (async (files: RecipeFiles): Promise<AdaptiveVerifierResult> =>
      await runRecipeVerificationGate({
        files,
        fileModes: adaptiveOutputFileModes(files, source.fileModes),
        recipe: lease.recipe,
        commandRunner: input.commandRunner,
        commandTimeoutMs: input.commandTimeoutMs,
        tempRoot: input.tempRoot,
      }));
  assertObservedAt(adaptiveStartedAt);
  const elapsedWallTimeMs = Date.parse(adaptiveStartedAt) - Date.parse(lease.startedAt);
  const adaptiveWallTimeMs = lease.adaptiveBudgetRemaining.wallTimeMs - elapsedWallTimeMs;
  if (!Number.isSafeInteger(adaptiveWallTimeMs) || adaptiveWallTimeMs < 1) {
    throw new AttemptRunnerError("worker_crash", "transformer_adaptive_wall_time_budget_exhausted");
  }
  const adaptiveCostUsd = lease.adaptiveBudgetRemaining.actualCostUsd - reservedExecutionCostUsd;
  if (!Number.isFinite(adaptiveCostUsd) || adaptiveCostUsd < 0) {
    throw new AttemptRunnerError("worker_crash", "transformer_adaptive_cost_budget_exhausted");
  }
  const maxPlannerCalls = Math.min(
    config.bounds?.maxPlannerCalls ?? DEFAULT_ADAPTIVE_REPAIR_BOUNDS.maxPlannerCalls,
    lease.adaptiveBudgetRemaining.plannerCalls,
  );
  const maxModelCalls = Math.min(
    config.bounds?.maxModelCalls ?? DEFAULT_ADAPTIVE_REPAIR_BOUNDS.maxModelCalls,
    lease.adaptiveBudgetRemaining.modelCalls,
  );
  const signals = [config.signal, leaseSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const outcome = await runAdaptiveRepairLoop({
    unitId: lease.unitId,
    goal: `Adaptively repair unit ${lease.unitId} for recipe ${lease.recipe.id}@${lease.recipe.version}`,
    recipe: lease.recipe,
    sourceFiles: source.files,
    recipeFiles,
    allowedMutationPaths,
    gate,
    ...(config.baselineGate ? { baselineGate: config.baselineGate } : {}),
    planner: config.planner,
    bounds: {
      ...config.bounds,
      maxPlannerCalls,
      maxModelCalls,
      wallClockBudgetMs: Math.min(
        config.bounds?.wallClockBudgetMs ?? DEFAULT_ADAPTIVE_REPAIR_BOUNDS.wallClockBudgetMs,
        adaptiveWallTimeMs,
      ),
    },
    resourceBudget: {
      plannerCalls: maxPlannerCalls,
      modelCalls: maxModelCalls,
      inputTokens: lease.adaptiveBudgetRemaining.inputTokens,
      outputTokens: lease.adaptiveBudgetRemaining.outputTokens,
      totalTokens: lease.adaptiveBudgetRemaining.totalTokens,
      actualCostUsd: adaptiveCostUsd,
    },
    ...(config.now ? { now: config.now } : {}),
    ...(signal ? { signal } : {}),
    onUsageCheckpoint,
    ...(input.coordinator.reserveAdaptiveModelCall && input.coordinator.settleAdaptiveModelCall
      ? {
          externalModelAccounting: {
            executionScopeId: sha256([
              transformerAttemptId(lease),
              String(lease.leaseGeneration),
              lease.leaseTokenDigest,
            ].join("\0")),
            reserve: async (reservation: AdaptiveExternalModelReservation) => {
              const observedAt = input.observedAt("usage");
              const accounting = await input.coordinator.reserveAdaptiveModelCall!({
                tenantId: lease.tenantId,
                campaignId: lease.campaignId,
                unitId: lease.unitId,
                leaseGeneration: lease.leaseGeneration,
                leaseToken,
                reservation,
                observedAt,
                evidenceRefs: lease.gateEvidenceRefs,
                idempotencyKey: input.idempotencyKey("usage", `${transformerAttemptId(lease)}:model-reserve:${reservation.reservationId}`),
                gateConfig: input.gateConfig,
              });
              onExternalAccountingAccepted(accounting);
            },
            settle: async (settlement: AdaptiveExternalModelSettlement) => {
              const observedAt = input.observedAt("usage");
              const accounting = await input.coordinator.settleAdaptiveModelCall!({
                tenantId: lease.tenantId,
                campaignId: lease.campaignId,
                unitId: lease.unitId,
                leaseGeneration: lease.leaseGeneration,
                leaseToken,
                settlement,
                observedAt,
                evidenceRefs: lease.gateEvidenceRefs,
                idempotencyKey: input.idempotencyKey("usage", `${transformerAttemptId(lease)}:model-settle:${settlement.reservationId}`),
                gateConfig: input.gateConfig,
              });
              onExternalAccountingAccepted(accounting);
            },
          },
        }
      : {}),
  });
  return summarizeAdaptiveOutcome(outcome, source.files, source.fileModes);
}

export async function runTransformerAttempt(input: RunTransformerAttemptInput): Promise<TransformerAttemptRunResult> {
  validateScope(input.scope);
  const authorization = authorizeTransformerWorkerAction(
    { tenantId: input.scope.tenantId, environment: input.scope.environment },
    input.gateConfig,
  );
  if (!authorization.allowed) {
    const code = `transformer_worker_action_denied:${authorization.reasons.join(",")}`;
    return Object.freeze({
      status: "failed",
      summary: code,
      nextActions: Object.freeze(["Correct the Transformer worker authorization"]),
      artifacts: Object.freeze([]),
      recoveryCode: "execution_failed",
      errorCode: code,
    });
  }

  const leaseToken = input.leaseToken();
  if (typeof leaseToken !== "string" || leaseToken.length < 24) {
    throw new AttemptRunnerError("execution_failed", "transformer_attempt_lease_token_invalid");
  }
  const claimObservedAt = input.observedAt("claim");
  assertObservedAt(claimObservedAt);
  const claimIdempotencyKey = input.idempotencyKey("claim");
  assertIdentifier(claimIdempotencyKey, "transformer_attempt_claim_idempotency_key_invalid");
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1_000 || input.leaseDurationMs > 3_600_000) {
    throw new AttemptRunnerError("execution_failed", "transformer_attempt_lease_duration_invalid");
  }
  const lease = await input.coordinator.claimNextAttempt({
    tenantId: input.scope.tenantId,
    campaignId: input.scope.campaignId,
    observedAt: claimObservedAt,
    evidenceRefs: authorization.acceptanceEvidenceRefs,
    idempotencyKey: claimIdempotencyKey,
    leaseToken,
    leaseDurationMs: input.leaseDurationMs,
    gateConfig: input.gateConfig,
  });
  if (!lease) {
    return Object.freeze({
      status: "idle",
      summary: "No Transformer attempt is currently eligible",
      nextActions: Object.freeze([]),
      artifacts: Object.freeze([]),
    });
  }

  let attemptId = "unbound";
  let fence: RecipeExecutionFence | undefined;
  let execution: RecipeWorkspaceExecutionResult | undefined;
  let artifact: TransformerCandidateArtifact | undefined;
  let evidenceDirectory: string | undefined;
  let source: ExactSourceSnapshot | undefined;
  let lastAcceptedAccounting: TransformerAdaptiveAttemptAccounting | undefined;
  let usageCheckpointFailed = false;
  let durableExternalAccounting = false;
  let heartbeat: TransformerLeaseHeartbeat | undefined;
  let checkpointController: TransformerAttemptCheckpointExecutionController | undefined;
  let checkpointOwned = false;
  try {
    validateLease(lease, input.scope, leaseToken);
    attemptId = transformerAttemptId(lease);
    fence = fenceFor(lease, attemptId, leaseToken);
    heartbeat = startLeaseHeartbeat(input, lease, leaseToken, attemptId);
    await assertCurrentFence(
      input.coordinator, lease, fence, input.observedAt("execute"), heartbeat,
    );
    evidenceDirectory = scopedEvidenceDirectory(input.evidenceRoot, input.scope, lease, attemptId);
    try {
      source = await input.loadExactSource(lease);
    } catch (error) {
      throw new AttemptRunnerError("source_drift", "transformer_attempt_source_load_failed", error);
    }
    bindSource(source, lease);
    const executionObservedAt = input.observedAt("execute");
    assertObservedAt(executionObservedAt);
    if (input.checkpoint) {
      checkpointOwned = true;
      const checkpointSource = source;
      const checkpointFence = fence;
      const operationTimeoutMs = checkpointOperationTimeoutMs(input.checkpoint, input.leaseDurationMs);
      checkpointController = await runCheckpointOperation(
        (signal) => input.checkpoint!.open({
          scope: input.scope,
          lease,
          leaseToken,
          attemptId,
          source: checkpointSource,
          fence: checkpointFence,
          assertFence: async () => await assertCurrentFence(
            input.coordinator, lease, checkpointFence, input.observedAt("execute"), heartbeat,
          ),
          observedAt: executionObservedAt,
          signal,
          operationTimeoutMs,
        }),
        heartbeat!.signal,
        operationTimeoutMs,
      );
      if (!checkpointController || typeof checkpointController !== "object" ||
          typeof checkpointController.complete !== "function" ||
          !checkpointController.verificationControl) {
        throw new AttemptRunnerError(
          "worker_crash",
          "transformer_attempt_checkpoint_controller_invalid",
        );
      }
    }
    execution = await executeRecipeInWorkspace({
      fence,
      assertFence: async () => await assertCurrentFence(
        input.coordinator, lease, fence!, input.observedAt("execute"), heartbeat,
      ),
      source,
      recipe: lease.recipe,
      evidenceDirectory,
      observedAt: executionObservedAt,
      tempRoot: input.tempRoot,
      commandTimeoutMs: input.commandTimeoutMs,
      commandRunner: input.commandRunner,
      ...(checkpointController
        ? { verificationControl: checkpointController.verificationControl }
        : {}),
    });
    bindCandidate(execution, lease);
    await assertCurrentFence(
      input.coordinator, lease, fence, input.observedAt("execute"), heartbeat,
    );
    artifact = persistTransformerCandidate(input.candidateRoot, input.scope, lease, attemptId, execution);
    const artifactRegistration = createMissionArtifactRegistration(
      input,
      lease,
      attemptId,
      artifact,
      execution,
    );
    const completionObservedAt = input.observedAt("complete");
    await assertCurrentFence(input.coordinator, lease, fence, completionObservedAt, heartbeat);
    const executionCostUsd = accountingExecutionCost(input, execution);
    const completionAccounting = attemptAccounting(
      lease,
      completionObservedAt,
      executionCostUsd,
    );
    if (checkpointController) {
      const operationTimeoutMs = checkpointOperationTimeoutMs(input.checkpoint!, input.leaseDurationMs);
      const completionInput: TransformerAttemptCheckpointCompletion = {
        execution,
        artifact,
        actualCostUsd: executionCostUsd,
        accounting: completionAccounting,
        artifactRegistration,
        observedAt: completionObservedAt,
        evidenceRefs: artifact.evidenceRefs,
        signal: heartbeat.signal,
        operationTimeoutMs,
      };
      const complete = async (): Promise<void> => await runCheckpointOperation(
        (signal) => checkpointController!.complete({ ...completionInput, signal }),
        heartbeat!.signal,
        operationTimeoutMs,
      );
      try {
        await complete();
      } catch (error) {
        if (!(error instanceof TransformerAttemptCheckpointUncertainError) ||
            error.message === "transformer_attempt_checkpoint_operation_timeout" ||
            error.message === "transformer_attempt_checkpoint_operation_aborted") {
          throw error;
        }
        await complete();
      }
    } else {
      const completionKey = input.idempotencyKey("complete", attemptId);
      assertIdentifier(completionKey, "transformer_attempt_complete_idempotency_key_invalid");
      await input.coordinator.completeAttempt({
        tenantId: lease.tenantId,
        campaignId: lease.campaignId,
        unitId: lease.unitId,
        leaseGeneration: lease.leaseGeneration,
        leaseToken,
        sourceRevision: lease.snapshot.revision,
        sourceDigest: lease.snapshot.digest,
        candidateRevision: lease.candidateRevision,
        candidateDigest: lease.candidateDigest,
        verificationPassed: true,
        actualCostUsd: executionCostUsd,
        accounting: completionAccounting,
        artifactRegistration,
        observedAt: completionObservedAt,
        evidenceRefs: artifact.evidenceRefs,
        idempotencyKey: completionKey,
        gateConfig: input.gateConfig,
      });
    }
    let verifierShadowError: "transformer_verifier_shadow_failed" | undefined;
    if (input.onVerifiedCandidateCompleted) {
      try {
        await input.onVerifiedCandidateCompleted({
          lease,
          execution,
          artifact,
          observedAt: completionObservedAt,
        });
      } catch {
        verifierShadowError = "transformer_verifier_shadow_failed";
      }
    }
    return Object.freeze({
      status: "completed",
      summary: artifact.reused
        ? "Transformer candidate replay verified and completion reconciled"
        : "Transformer candidate verified and durably persisted",
      nextActions: Object.freeze(["Review the durable candidate before draft delivery"]),
      artifacts: Object.freeze([artifact]),
      ...(verifierShadowError ? { verifierShadowError } : {}),
    });
  } catch (error) {
    if (isStale(error) || !fence) {
      return Object.freeze({
        status: "stale",
        summary: "Transformer attempt fence is stale",
        nextActions: Object.freeze(["Discard the stale result and claim a current attempt"]),
        artifacts: Object.freeze(artifact ? [artifact] : []),
        ...(error instanceof RecipeWorkspaceExecutionError ? { rollback: error.rollback } : {}),
      });
    }
    if (error instanceof TransformerAttemptCheckpointUncertainError) {
      return Object.freeze({
        status: "failed",
        summary: error.message,
        nextActions: Object.freeze(nextActions("worker_crash")),
        artifacts: Object.freeze(artifact ? [artifact] : []),
        recoveryCode: "worker_crash",
        errorCode: error.message,
      });
    }
    if (error instanceof LeaseRenewalUncertainError) {
      return Object.freeze({
        status: "failed",
        summary: error.message,
        nextActions: Object.freeze(nextActions("worker_crash")),
        artifacts: Object.freeze(artifact ? [artifact] : []),
        recoveryCode: "worker_crash",
        errorCode: error.message,
      });
    }
    if (checkpointOwned) {
      const checkpointFailure = classify(error);
      const recoveryCode = checkpointFailure.recoveryCode === "verification_failed"
        ? "verification_failed"
        : "worker_crash";
      if (recoveryCode === "verification_failed" && checkpointController?.fail) {
        const failCheckpoint = checkpointController.fail;
        const failureObservedAt = input.observedAt("failure");
        const failureAccounting = attemptAccounting(
          lease,
          failureObservedAt,
          accountingExecutionCost(input, execution),
        );
        const operationTimeoutMs = checkpointOperationTimeoutMs(input.checkpoint!, input.leaseDurationMs);
        try {
          await runCheckpointOperation(
            (signal) => failCheckpoint({
              recoveryCode,
              errorCode: checkpointFailure.errorCode,
              accounting: failureAccounting,
              observedAt: failureObservedAt,
              evidenceRefs: lease.gateEvidenceRefs,
              signal,
              operationTimeoutMs,
            }),
            heartbeat!.signal,
            operationTimeoutMs,
          );
        } catch (failureError) {
          if (isStale(failureError)) {
            return Object.freeze({
              status: "stale",
              summary: "Transformer attempt fence became stale before checkpoint failure recording",
              nextActions: Object.freeze(["Discard the stale result and claim a current attempt"]),
              artifacts: Object.freeze(artifact ? [artifact] : []),
              ...(checkpointFailure.rollback ? { rollback: checkpointFailure.rollback } : {}),
            });
          }
          return Object.freeze({
            status: "failed",
            summary: `transformer_attempt_checkpoint_failure_record_failed:${errorCode(failureError)}`,
            nextActions: Object.freeze(nextActions("worker_crash")),
            artifacts: Object.freeze(artifact ? [artifact] : []),
            recoveryCode: "worker_crash",
            errorCode: errorCode(failureError),
            ...(checkpointFailure.rollback ? { rollback: checkpointFailure.rollback } : {}),
          });
        }
      }
      return Object.freeze({
        status: "failed",
        summary: checkpointFailure.errorCode,
        nextActions: Object.freeze(nextActions(recoveryCode)),
        artifacts: Object.freeze(artifact ? [artifact] : []),
        recoveryCode,
        errorCode: checkpointFailure.errorCode,
        ...(checkpointFailure.rollback ? { rollback: checkpointFailure.rollback } : {}),
      });
    }
    let classified = classify(error);
    const completedEvidenceIds = Object.freeze([
      ...(execution ? [execution.evidence.record.evidenceId] : []),
      ...(artifact ? artifact.evidenceRefs : []),
    ].filter((value, index, values) => values.indexOf(value) === index));
    // Recipe-first: adaptive repair engages only after the deterministic recipe
    // has failed verification, only when configured, and never disturbs the
    // deterministic success path above.
    let adaptiveSummary: TransformerAdaptiveSummary | undefined;
    if (classified.recoveryCode === "verification_failed" && source && input.adaptiveRepair) {
      try {
        const adaptiveStartedAt = input.observedAt("usage");
        const executionCostUsd = accountingExecutionCost(input, execution);
        adaptiveSummary = await runAttemptAdaptiveRepair(
          input,
          lease,
          leaseToken,
          source,
          executionCostUsd,
          adaptiveStartedAt,
          async (usage) => {
            const checkpointObservedAt = input.observedAt("usage");
            try {
              const accounting = attemptAccounting(
                lease,
                checkpointObservedAt,
                accountingExecutionCost(input, execution),
                usage,
              );
              const checkpointKey = input.idempotencyKey(
                "usage",
                `${attemptId}:${accounting.plannerCalls}:${accounting.wallTimeMs}`,
              );
              assertIdentifier(
                checkpointKey,
                "transformer_attempt_usage_idempotency_key_invalid",
              );
              await input.coordinator.recordAdaptiveAttemptUsage({
                tenantId: lease.tenantId,
                campaignId: lease.campaignId,
                unitId: lease.unitId,
                leaseGeneration: lease.leaseGeneration,
                leaseToken,
                accounting,
                observedAt: checkpointObservedAt,
                evidenceRefs: lease.gateEvidenceRefs,
                idempotencyKey: checkpointKey,
                gateConfig: input.gateConfig,
              });
              lastAcceptedAccounting = accounting;
            } catch (checkpointError) {
              usageCheckpointFailed = true;
              throw checkpointError instanceof AttemptRunnerError
                ? checkpointError
                : new AttemptRunnerError(
                    "worker_crash",
                    "transformer_adaptive_budget_checkpoint_failed",
                    checkpointError,
                  );
            }
          },
          (accounting) => {
            lastAcceptedAccounting = Object.freeze({
              ...accounting,
              actualCostUsd: accounting.actualCostUsd + executionCostUsd,
            });
            durableExternalAccounting = true;
          },
          heartbeat?.signal,
        );
      } catch (adaptiveError) {
        if (adaptiveError instanceof AttemptRunnerError) {
          classified = classify(adaptiveError);
        }
        adaptiveSummary = undefined;
      }
      try {
        await heartbeat?.confirm();
      } catch (renewalError) {
        if (isStale(renewalError)) {
          return Object.freeze({
            status: "stale",
            summary: "Transformer attempt fence became stale during adaptive repair",
            nextActions: Object.freeze(["Discard the stale result and claim a current attempt"]),
            artifacts: Object.freeze(artifact ? [artifact] : []),
            ...(classified.rollback ? { rollback: classified.rollback } : {}),
          });
        }
        return Object.freeze({
          status: "failed",
          summary: "transformer_attempt_lease_renewal_failed",
          nextActions: Object.freeze(nextActions("worker_crash")),
          artifacts: Object.freeze(artifact ? [artifact] : []),
          recoveryCode: "worker_crash",
          errorCode: "transformer_attempt_lease_renewal_failed",
          ...(classified.rollback ? { rollback: classified.rollback } : {}),
        });
      }
      // A converged adaptive fix that diverges from the deterministic recipe
      // output is never auto-promoted: hand it off to be sealed and recorded as a
      // review-pending adaptive candidate. The deterministic completion path is
      // untouched, so the drift guarantee above still holds for every other path.
      const converged = adaptiveSummary?.convergedCandidate;
      if (
        adaptiveSummary?.outcome === "converged" &&
        converged &&
        adaptiveSummary.convergedFiles &&
        converged.outputDigest !== lease.candidateDigest &&
        input.onAdaptiveCandidateConverged
      ) {
        let handoffFenceCurrent = true;
        try {
          await assertCurrentFence(
            input.coordinator,
            lease,
            fence,
            input.observedAt("execute"),
            heartbeat,
          );
        } catch (fenceError) {
          if (isStale(fenceError)) {
            return Object.freeze({
              status: "stale",
              summary: "Transformer attempt fence became stale before adaptive candidate handoff",
              nextActions: Object.freeze(["Discard the stale result and claim a current attempt"]),
              artifacts: Object.freeze(artifact ? [artifact] : []),
              ...(classified.rollback ? { rollback: classified.rollback } : {}),
              adaptive: adaptiveSummary,
            });
          }
          classified = classify(fenceError);
          handoffFenceCurrent = false;
        }
        if (handoffFenceCurrent) {
          try {
            const adaptiveFileModes = adaptiveOutputFileModes(
              adaptiveSummary.convergedFiles,
              source.fileModes,
            );
            const classification = classifyRecipeReference(lease.recipe);
            await input.onAdaptiveCandidateConverged({
              tenantId: lease.tenantId,
              campaignId: lease.campaignId,
              unitId: lease.unitId,
              attemptId,
              attemptNumber: lease.attemptNumber,
              leaseGeneration: lease.leaseGeneration,
              leaseToken,
              repositoryId: lease.snapshot.repositoryId,
              snapshotId: lease.snapshot.snapshotId,
              expectedBaseRevision: lease.snapshot.revision,
              divergedFromDigest: lease.candidateDigest,
              candidateDigest: converged.outputDigest,
              failingCommandId: converged.failingCommandId,
              changedPaths: converged.changedPaths,
              adaptiveChangedPaths: converged.adaptiveChangedPaths,
              files: adaptiveSummary.convergedFiles,
              fileModes: adaptiveFileModes,
              review: converged.review,
              family: classification.family,
              provider: classification.provider,
              framework: classification.framework,
            });
          } catch (handoffError) {
            classified = classify(new AttemptRunnerError(
              "worker_crash",
              "transformer_adaptive_candidate_persistence_failed",
              handoffError,
            ));
          }
        }
      }
    }
    let failureEvidence: TransformerAttemptFailureArtifact | undefined;
    try {
      const failureObservedAt = input.observedAt("failure");
      await assertCurrentFence(input.coordinator, lease, fence, failureObservedAt, heartbeat);
      // Invariant: the failure-recording path must never abort on accounting.
      // A unit whose failure is never recorded stays "running" until the lease
      // expiry sweep a full leaseDurationMs later, on a terminal path with
      // different bookkeeping; that is strictly worse than recording slightly
      // coarser numbers now. Incomplete adaptive usage is information to record,
      // not a reason to skip recording. It is reachable whenever adaptive repair
      // produced a usage tally that never passed a durable checkpoint or an
      // accepted external-model reservation — for example a planner that threw on
      // its first iteration (before onUsageCheckpoint runs), or a coordinator
      // that omits the optional reserve/settle model-accounting methods. In those
      // states neither usageCheckpointFailed nor durableExternalAccounting is set,
      // yet adaptiveSummary.usage.complete is false, so folding it into
      // attemptAccounting would throw transformer_adaptive_usage_accounting_incomplete
      // and be swallowed below, destroying the true recoveryCode along with it.
      const adaptiveUsage = adaptiveSummary?.usage;
      const adaptiveUsageAccountingIncomplete =
        adaptiveUsage !== undefined && !adaptiveUsage.complete;
      let failureAccounting: TransformerAdaptiveAttemptAccounting;
      if (usageCheckpointFailed || durableExternalAccounting || adaptiveUsageAccountingIncomplete) {
        const fallback = lastAcceptedAccounting ?? attemptAccounting(
          lease,
          failureObservedAt,
          accountingExecutionCost(input, execution),
        );
        failureAccounting = Object.freeze({
          ...fallback,
          wallTimeMs: Math.max(
            fallback.wallTimeMs,
            Date.parse(failureObservedAt) - Date.parse(lease.startedAt),
          ),
        });
      } else {
        failureAccounting = attemptAccounting(
          lease,
          failureObservedAt,
          accountingExecutionCost(input, execution),
          adaptiveUsage,
        );
      }
      if (!evidenceDirectory) {
        evidenceDirectory = scopedEvidenceDirectory(input.evidenceRoot, input.scope, lease, attemptId);
      }
      failureEvidence = persistTransformerAttemptFailureEvidence(
        evidenceDirectory,
        lease,
        attemptId,
        leaseToken,
        failureObservedAt,
        classified.recoveryCode,
        classified.errorCode,
        classified.rollback,
        completedEvidenceIds,
        adaptiveUsageAccountingIncomplete,
      );
      const failureKey = input.idempotencyKey("failure", attemptId);
      assertIdentifier(failureKey, "transformer_attempt_failure_idempotency_key_invalid");
      await input.coordinator.recordAttemptFailure({
        tenantId: lease.tenantId,
        campaignId: lease.campaignId,
        unitId: lease.unitId,
        leaseGeneration: lease.leaseGeneration,
        leaseToken,
        code: classified.recoveryCode,
        errorCode: classified.errorCode,
        accounting: failureAccounting,
        observedAt: failureObservedAt,
        evidenceRefs: Object.freeze([
          failureEvidence.evidenceId,
          ...completedEvidenceIds,
          ...lease.gateEvidenceRefs,
        ].filter((value, index, values) => values.indexOf(value) === index)),
        idempotencyKey: failureKey,
        gateConfig: input.gateConfig,
      });
    } catch (recordError) {
      if (isStale(recordError)) {
        return Object.freeze({
          status: "stale",
          summary: "Transformer attempt fence became stale before failure recording",
          nextActions: Object.freeze(["Discard the stale result and claim a current attempt"]),
          artifacts: Object.freeze(artifact ? [artifact] : []),
          ...(classified.rollback ? { rollback: classified.rollback } : {}),
          ...(failureEvidence ? { failureEvidence } : {}),
          ...(adaptiveSummary ? { adaptive: adaptiveSummary } : {}),
        });
      }
      return Object.freeze({
        status: "failed",
        summary: `transformer_attempt_failure_record_failed:${errorCode(recordError)}`,
        nextActions: Object.freeze(nextActions("worker_crash")),
        artifacts: Object.freeze(artifact ? [artifact] : []),
        recoveryCode: "worker_crash",
        errorCode: errorCode(recordError),
        ...(classified.rollback ? { rollback: classified.rollback } : {}),
        ...(failureEvidence ? { failureEvidence } : {}),
        ...(adaptiveSummary ? { adaptive: adaptiveSummary } : {}),
      });
    }
    return Object.freeze({
      status: "failed",
      summary: classified.errorCode,
      nextActions: Object.freeze(nextActions(classified.recoveryCode)),
      artifacts: Object.freeze(artifact ? [artifact] : []),
      recoveryCode: classified.recoveryCode,
      errorCode: classified.errorCode,
      ...(classified.rollback ? { rollback: classified.rollback } : {}),
      ...(failureEvidence ? { failureEvidence } : {}),
      ...(adaptiveSummary ? { adaptive: adaptiveSummary } : {}),
    });
  } finally {
    await heartbeat?.stop();
  }
}
