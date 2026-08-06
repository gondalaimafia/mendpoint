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
import { applyRecipe, recipeFilesDigest, resolveRecipe, type RecipeFiles } from "./recipe.js";
import {
  RecipeWorkspaceExecutionError,
  executeRecipeInWorkspace,
  runRecipeVerificationGate,
  type ExactSourceSnapshot,
  type RecipeCommandRunner,
  type RecipeExecutionFence,
  type RecipeExecutionRollback,
  type RecipeWorkspaceExecutionResult,
} from "./recipe-workspace-execution.js";
import {
  runAdaptiveRepairLoop,
  type AdaptiveBoundExhaustion,
  type AdaptiveGate,
  type AdaptiveRepairBounds,
  type AdaptiveRepairOutcome,
  type AdaptiveRepairPlanner,
  type AdaptiveRepairUsage,
  type AdaptiveUnfixableMarker,
  type AdaptiveVerifierResult,
} from "./adaptive-loop.js";
import type { TransformerAttemptLease } from "./pilot-execution.js";

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

export type TransformerAttemptPhase = "claim" | "execute" | "failure" | "complete";

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
  observedAt: string;
  evidenceRefs: readonly string[];
  idempotencyKey: string;
  gateConfig?: string;
}>;

export type TransformerAttemptCoordinatorPort = Readonly<{
  claimNextAttempt(input: TransformerAttemptClaimInput): MaybePromise<TransformerExecutableAttemptLease | null>;
  assertCurrentAttemptFence(input: TransformerCurrentAttemptFence): MaybePromise<boolean | void>;
  completeAttempt(input: TransformerAttemptCompletionInput): MaybePromise<unknown>;
  recordAttemptFailure(input: TransformerAttemptFailureInput): MaybePromise<unknown>;
}>;

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
  convergedCandidate: Readonly<{ outputDigest: string; changedPaths: readonly string[] }> | null;
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
}>;

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
  adaptiveRepair?: TransformerAdaptiveRepairConfig;
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
  return error instanceof StaleAttemptFenceError || errorCode(error).includes("fence_stale");
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

async function assertCurrentFence(
  coordinator: TransformerAttemptCoordinatorPort,
  lease: TransformerExecutableAttemptLease,
  fence: RecipeExecutionFence,
  observedAt: string,
): Promise<void> {
  try {
    assertObservedAt(observedAt);
    const current = await coordinator.assertCurrentAttemptFence(currentFenceFor(lease, fence, observedAt));
    if (current === false) throw new StaleAttemptFenceError();
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

function summarizeAdaptiveOutcome(outcome: AdaptiveRepairOutcome): TransformerAdaptiveSummary {
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
      convergedCandidate: Object.freeze({ outputDigest: outcome.outputDigest, changedPaths: outcome.changedPaths }),
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

async function runAttemptAdaptiveRepair(
  input: RunTransformerAttemptInput,
  lease: TransformerExecutableAttemptLease,
  source: ExactSourceSnapshot,
): Promise<TransformerAdaptiveSummary | undefined> {
  const config = input.adaptiveRepair;
  if (!config) return undefined;
  let recipeFiles: RecipeFiles;
  let allowedMutationPaths: readonly string[];
  try {
    const application = applyRecipe(lease.recipe, source.files);
    recipeFiles = application.files;
    allowedMutationPaths = config.allowedMutationPaths ?? resolveRecipe(lease.recipe).allowedPaths;
  } catch {
    // The deterministic recipe output could not be reconstructed; skip adaptive
    // repair rather than guess.
    return undefined;
  }
  const gate: AdaptiveGate =
    config.gate ??
    (async (files: RecipeFiles): Promise<AdaptiveVerifierResult> =>
      await runRecipeVerificationGate({
        files,
        recipe: lease.recipe,
        commandRunner: input.commandRunner,
        commandTimeoutMs: input.commandTimeoutMs,
        tempRoot: input.tempRoot,
      }));
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
    ...(config.bounds ? { bounds: config.bounds } : {}),
    ...(config.now ? { now: config.now } : {}),
  });
  return summarizeAdaptiveOutcome(outcome);
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
  try {
    validateLease(lease, input.scope, leaseToken);
    attemptId = transformerAttemptId(lease);
    fence = fenceFor(lease, attemptId, leaseToken);
    await assertCurrentFence(input.coordinator, lease, fence, input.observedAt("execute"));
    evidenceDirectory = scopedEvidenceDirectory(input.evidenceRoot, input.scope, lease, attemptId);
    try {
      source = await input.loadExactSource(lease);
    } catch (error) {
      throw new AttemptRunnerError("source_drift", "transformer_attempt_source_load_failed", error);
    }
    bindSource(source, lease);
    const executionObservedAt = input.observedAt("execute");
    assertObservedAt(executionObservedAt);
    execution = await executeRecipeInWorkspace({
      fence,
      assertFence: async () => await assertCurrentFence(input.coordinator, lease, fence!, input.observedAt("execute")),
      source,
      recipe: lease.recipe,
      evidenceDirectory,
      observedAt: executionObservedAt,
      tempRoot: input.tempRoot,
      commandTimeoutMs: input.commandTimeoutMs,
      commandRunner: input.commandRunner,
    });
    bindCandidate(execution, lease);
    artifact = persistTransformerCandidate(input.candidateRoot, input.scope, lease, attemptId, execution);
    const completionObservedAt = input.observedAt("complete");
    await assertCurrentFence(input.coordinator, lease, fence, completionObservedAt);
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
      actualCostUsd: actualCost(input, execution),
      observedAt: completionObservedAt,
      evidenceRefs: artifact.evidenceRefs,
      idempotencyKey: completionKey,
      gateConfig: input.gateConfig,
    });
    return Object.freeze({
      status: "completed",
      summary: artifact.reused
        ? "Transformer candidate replay verified and completion reconciled"
        : "Transformer candidate verified and durably persisted",
      nextActions: Object.freeze(["Review the durable candidate before draft delivery"]),
      artifacts: Object.freeze([artifact]),
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
    const classified = classify(error);
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
        adaptiveSummary = await runAttemptAdaptiveRepair(input, lease, source);
      } catch {
        adaptiveSummary = undefined;
      }
    }
    let failureEvidence: TransformerAttemptFailureArtifact | undefined;
    try {
      const failureObservedAt = input.observedAt("failure");
      await assertCurrentFence(input.coordinator, lease, fence, failureObservedAt);
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
  }
}
