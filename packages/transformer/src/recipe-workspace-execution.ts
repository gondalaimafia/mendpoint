import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import {
  AWS_SDK_JS_V2_TO_V3_RECIPE,
  GOOGLEAPIS_V25_TO_V26_RECIPE,
  NODE_RUNTIME_18_TO_20_RECIPE,
  REACT_DOM_17_TO_18_RECIPE,
  STRIPE_NODE_V10_TO_V11_RECIPE,
  RecipeAnalysisCache,
  applyInverseOperations,
  getRecipe,
  normalizeRecipeFileModes,
  recipeFilesDigest,
  recipeReference,
  resolveRecipe,
  type MigrationRecipeContract,
  type RecipeApplication,
  type RecipeAnalysis,
  type RecipeFiles,
  type RecipeFileModes,
  type RecipeOperation,
  type RecipeReference,
  type RecipeVerificationCommand,
} from "./recipe.js";

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_COMMAND_TIMEOUT_MS = 30_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const WORKSPACE_ANALYSIS_CACHE = new RecipeAnalysisCache(128);

export type RecipeExecutionFence = Readonly<{
  tenantId: string;
  campaignId: string;
  unitId: string;
  attemptId: string;
  leaseGeneration: number;
  leaseToken: string;
}>;

export type RecipeExecutionFenceEvidence = Readonly<
  Omit<RecipeExecutionFence, "leaseToken"> & { leaseTokenDigest: string }
>;

export type ExactSourceSnapshot = Readonly<{
  repositoryId: string;
  revision: string;
  digest: string;
  files: RecipeFiles;
  fileModes: RecipeFileModes;
}>;

export type RecipeCommandInvocation = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  env: Readonly<Record<string, string>>;
}>;

export type RecipeCommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type RecipeCommandRunner = (
  invocation: RecipeCommandInvocation,
) => Promise<RecipeCommandResult>;

export type RecipeCommandEvidence = Readonly<{
  id: string;
  exitCode: number;
  stdoutDigest: string;
  stdoutBytes: number;
  stderrDigest: string;
  stderrBytes: number;
}>;

export type RecipeOperationEvidence = Readonly<{
  path: string;
  beforeDigest: string;
  afterDigest: string;
}>;

export type RecipeExecutionEvidenceRecord = Readonly<{
  schemaVersion: 2;
  kind: "transformer.recipe.execution";
  evidenceId: string;
  observedAt: string;
  fence: RecipeExecutionFenceEvidence;
  source: Readonly<{
    repositoryId: string;
    revision: string;
    digest: string;
  }>;
  recipe: RecipeReference;
  analysis: Readonly<Omit<RecipeAnalysis, "cacheHit">>;
  inputDigest: string;
  outputDigest: string;
  operationCount: number;
  operations: readonly RecipeOperationEvidence[];
  commands: readonly RecipeCommandEvidence[];
  workspaceDisposed: true;
}>;

export type RecipeRestoreEvidenceRecord = Readonly<{
  schemaVersion: 1;
  kind: "transformer.recipe.restore";
  evidenceId: string;
  observedAt: string;
  fence: RecipeExecutionFenceEvidence;
  recipe: RecipeReference;
  executionEvidenceDigest: string;
  inputDigest: string;
  outputDigest: string;
  operationCount: number;
  restored: true;
  workspaceDisposed: true;
}>;

export type PersistedRecipeEvidence<T> = Readonly<{
  digest: string;
  path: string;
  record: T;
}>;

export type RecipeWorkspaceExecutionResult = Readonly<{
  fence: RecipeExecutionFenceEvidence;
  source: Readonly<Omit<ExactSourceSnapshot, "files">>;
  recipe: RecipeReference;
  analysis: RecipeAnalysis;
  inputDigest: string;
  outputDigest: string;
  outputFiles: RecipeFiles;
  outputFileModes: RecipeFileModes;
  operations: readonly RecipeOperation[];
  commands: readonly RecipeCommandEvidence[];
  evidence: PersistedRecipeEvidence<RecipeExecutionEvidenceRecord>;
}>;

export type RecipeWorkspaceRestoreResult = Readonly<{
  fence: RecipeExecutionFenceEvidence;
  recipe: RecipeReference;
  inputDigest: string;
  outputDigest: string;
  restoredFiles: RecipeFiles;
  evidence: PersistedRecipeEvidence<RecipeRestoreEvidenceRecord>;
}>;

export type RecipeExecutionRollback = Readonly<{
  attempted: boolean;
  inverseVerified: boolean;
  workspaceDiscarded: boolean;
  error?: string;
}>;

export class RecipeWorkspaceExecutionError extends Error {
  readonly code: string;
  readonly rollback: RecipeExecutionRollback;

  constructor(code: string, rollback: RecipeExecutionRollback, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "RecipeWorkspaceExecutionError";
    this.code = code;
    this.rollback = rollback;
  }
}

export type ExecuteRecipeWorkspaceInput = Readonly<{
  fence: RecipeExecutionFence;
  assertFence: (fence: RecipeExecutionFence) => boolean | void | Promise<boolean | void>;
  source: ExactSourceSnapshot;
  recipe: RecipeReference;
  evidenceDirectory: string;
  observedAt: string;
  tempRoot?: string;
  commandTimeoutMs?: number;
  commandRunner?: RecipeCommandRunner;
}>;

export type RestoreRecipeWorkspaceInput = Readonly<{
  execution: RecipeWorkspaceExecutionResult;
  currentFiles: RecipeFiles;
  fence: RecipeExecutionFence;
  assertFence: (fence: RecipeExecutionFence) => boolean | void | Promise<boolean | void>;
  evidenceDirectory: string;
  observedAt: string;
  tempRoot?: string;
}>;

type VerificationDefinition = Readonly<{
  command: string;
  script: string;
}>;

function recipeCommandKey(reference: RecipeReference): string {
  return `${reference.id}@${reference.version}:${reference.digest}`;
}

function signedNodeCommands(recipe: MigrationRecipeContract): ReadonlyMap<string, VerificationDefinition> {
  return new Map(recipe.verificationCommands.map((command) => {
    const match = /^node -e "([^"]+)"$/.exec(command.command);
    if (!match) throw new Error(`recipe_execution_command_definition_invalid:${command.id}`);
    return [command.id, { command: command.command, script: match[1]! }] as const;
  }));
}

const SIGNED_NODE_RECIPES = [
  getRecipe(NODE_RUNTIME_18_TO_20_RECIPE.id, 1),
  NODE_RUNTIME_18_TO_20_RECIPE,
  AWS_SDK_JS_V2_TO_V3_RECIPE,
  STRIPE_NODE_V10_TO_V11_RECIPE,
  GOOGLEAPIS_V25_TO_V26_RECIPE,
  REACT_DOM_17_TO_18_RECIPE,
] as const;

const NODE_RECIPE_COMMANDS = new Map(
  SIGNED_NODE_RECIPES.map((recipe) => [
    recipeCommandKey(recipeReference(recipe)),
    signedNodeCommands(recipe),
  ] as const),
);

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

function stableJson(value: unknown, pretty = false): string {
  return JSON.stringify(stableValue(value), null, pretty ? 2 : undefined);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function requiredId(value: string, field: string): string {
  if (!ID.test(value)) throw new Error(`${field}_invalid`);
  return value;
}

function assertDigest(value: string, field: string): void {
  if (!DIGEST.test(value)) throw new Error(`${field}_invalid`);
}

function assertObservedAt(value: string): void {
  if (!value || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error("recipe_execution_observed_at_invalid");
  }
}

function safeRelativePath(value: string): string {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes(":") ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === "." ||
    value === ".." ||
    value.startsWith("../")
  ) {
    throw new Error(`recipe_workspace_path_invalid:${value}`);
  }
  return value;
}

function validateFiles(files: RecipeFiles): void {
  const entries = Object.entries(files);
  if (!entries.length || entries.length > MAX_FILES) throw new Error("recipe_workspace_files_invalid");
  let total = 0;
  for (const [path, content] of entries) {
    safeRelativePath(path);
    if (typeof content !== "string") throw new Error(`recipe_workspace_content_invalid:${path}`);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) throw new Error(`recipe_workspace_file_too_large:${path}`);
    total += bytes;
    if (total > MAX_TOTAL_BYTES) throw new Error("recipe_workspace_snapshot_too_large");
  }
}

function validateFence(fence: RecipeExecutionFence): void {
  requiredId(fence.tenantId, "recipe_execution_tenant_id");
  requiredId(fence.campaignId, "recipe_execution_campaign_id");
  requiredId(fence.unitId, "recipe_execution_unit_id");
  requiredId(fence.attemptId, "recipe_execution_attempt_id");
  if (!Number.isSafeInteger(fence.leaseGeneration) || fence.leaseGeneration < 1) {
    throw new Error("recipe_execution_lease_generation_invalid");
  }
  if (typeof fence.leaseToken !== "string" || fence.leaseToken.length < 16) {
    throw new Error("recipe_execution_lease_token_invalid");
  }
}

function fenceEvidence(fence: RecipeExecutionFence): RecipeExecutionFenceEvidence {
  return deepFreeze({
    tenantId: fence.tenantId,
    campaignId: fence.campaignId,
    unitId: fence.unitId,
    attemptId: fence.attemptId,
    leaseGeneration: fence.leaseGeneration,
    leaseTokenDigest: sha256(fence.leaseToken),
  });
}

async function assertCurrentFence(
  fence: RecipeExecutionFence,
  assertion: ExecuteRecipeWorkspaceInput["assertFence"],
): Promise<void> {
  const current = await assertion(deepFreeze({ ...fence }));
  if (current === false) throw new Error("recipe_execution_fence_stale");
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function workspacePath(root: string, relativePath: string): string {
  const safe = safeRelativePath(relativePath);
  const candidate = resolve(root, ...safe.split("/"));
  if (!isWithin(root, candidate)) throw new Error(`recipe_workspace_path_escape:${safe}`);
  return candidate;
}

function createWorkspace(tempRoot?: string): string {
  const parent = resolve(tempRoot ?? tmpdir());
  mkdirSync(parent, { recursive: true });
  const realParent = realpathSync(parent);
  return mkdtempSync(join(realParent, "mendpoint-transformer-recipe-"));
}

function materializeFiles(root: string, files: RecipeFiles, fileModes: RecipeFileModes): void {
  validateFiles(files);
  const normalizedModes = normalizeRecipeFileModes(files, fileModes);
  const realRoot = realpathSync(root);
  for (const [path, content] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const target = workspacePath(realRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    const parent = realpathSync(dirname(target));
    if (!isWithin(realRoot, parent)) throw new Error(`recipe_workspace_parent_escape:${path}`);
    writeFileSync(target, content, {
      encoding: "utf8",
      flag: "wx",
      mode: normalizedModes[path] === "100755" ? 0o700 : 0o600,
    });
  }
}

function readWorkspaceFiles(root: string): RecipeFiles {
  const realRoot = realpathSync(root);
  const files: Record<string, string> = {};
  let total = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relativePath = relative(realRoot, absolute).split(sep).join("/");
      safeRelativePath(relativePath);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`recipe_workspace_symlink_forbidden:${relativePath}`);
      if (stat.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!stat.isFile()) throw new Error(`recipe_workspace_entry_forbidden:${relativePath}`);
      if (Object.keys(files).length >= MAX_FILES) throw new Error("recipe_workspace_files_invalid");
      if (stat.size > MAX_FILE_BYTES) throw new Error(`recipe_workspace_file_too_large:${relativePath}`);
      total += stat.size;
      if (total > MAX_TOTAL_BYTES) throw new Error("recipe_workspace_snapshot_too_large");
      files[relativePath] = readFileSync(absolute, "utf8");
    }
  };
  visit(realRoot);
  return deepFreeze(
    Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function assertWorkspaceEquals(root: string, expected: RecipeFiles, phase: string): RecipeFiles {
  const current = readWorkspaceFiles(root);
  const expectedPaths = Object.keys(expected).sort();
  const currentPaths = Object.keys(current).sort();
  if (stableJson(currentPaths) !== stableJson(expectedPaths)) {
    throw new Error(`recipe_workspace_drift:${phase}:paths`);
  }
  for (const path of expectedPaths) {
    if (current[path] !== expected[path]) throw new Error(`recipe_workspace_drift:${phase}:${path}`);
  }
  if (recipeFilesDigest(current) !== recipeFilesDigest(expected)) {
    throw new Error(`recipe_workspace_drift:${phase}:digest`);
  }
  return current;
}

function applyOperationsToWorkspace(root: string, operations: readonly RecipeOperation[]): void {
  for (const operation of operations) {
    const target = workspacePath(root, operation.path);
    const before = readFileSync(target, "utf8");
    if (before !== operation.before || sha256(before) !== operation.beforeDigest) {
      throw new Error(`recipe_workspace_drift:apply:${operation.path}`);
    }
    writeFileSync(target, operation.after, { encoding: "utf8", flag: "w", mode: 0o600 });
  }
}

function applyInverseToWorkspace(
  root: string,
  reference: RecipeReference,
  operations: readonly RecipeOperation[],
  expectedInput: RecipeFiles,
): void {
  const current = readWorkspaceFiles(root);
  const restored = applyInverseOperations(reference, current, operations);
  for (const operation of [...operations].reverse()) {
    const target = workspacePath(root, operation.path);
    writeFileSync(target, restored[operation.path]!, { encoding: "utf8", flag: "w", mode: 0o600 });
  }
  assertWorkspaceEquals(root, expectedInput, "inverse");
}

function allowlistedInvocation(
  reference: RecipeReference,
  command: RecipeVerificationCommand,
  workspace: string,
  timeoutMs: number,
): RecipeCommandInvocation {
  const commands = NODE_RECIPE_COMMANDS.get(recipeCommandKey(reference));
  if (!commands) throw new Error("recipe_execution_command_recipe_not_allowed");
  const definition = commands.get(command.id);
  if (!definition || command.command !== definition.command) {
    throw new Error(`recipe_execution_command_not_allowed:${command.id}`);
  }
  const env = Object.fromEntries(
    ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR"]
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return deepFreeze({
    executable: process.execPath,
    args: ["--no-warnings", "-e", definition.script],
    cwd: workspace,
    timeoutMs,
    env,
  });
}

const defaultCommandRunner: RecipeCommandRunner = async (invocation) =>
  await new Promise<RecipeCommandResult>((complete) => {
    execFile(
      invocation.executable,
      [...invocation.args],
      {
        cwd: invocation.cwd,
        encoding: "utf8",
        env: { ...invocation.env },
        timeout: invocation.timeoutMs,
        windowsHide: true,
        maxBuffer: 64 * 1024,
        shell: false,
      },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: number | string }) | null;
        complete({
          exitCode: failure
            ? typeof failure.code === "number"
              ? failure.code
              : 1
            : 0,
          stdout: String(stdout),
          stderr: String(stderr || failure?.message || ""),
        });
      },
    );
  });

function commandEvidence(command: RecipeVerificationCommand, result: RecipeCommandResult): RecipeCommandEvidence {
  if (!Number.isSafeInteger(result.exitCode)) throw new Error("recipe_execution_command_result_invalid");
  if (Buffer.byteLength(result.stdout, "utf8") > 64 * 1024 || Buffer.byteLength(result.stderr, "utf8") > 64 * 1024) {
    throw new Error(`recipe_execution_command_output_too_large:${command.id}`);
  }
  return deepFreeze({
    id: command.id,
    exitCode: result.exitCode,
    stdoutDigest: sha256(result.stdout),
    stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
    stderrDigest: sha256(result.stderr),
    stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
  });
}

function operationEvidence(operations: readonly RecipeOperation[]): readonly RecipeOperationEvidence[] {
  return deepFreeze(
    operations.map((operation) => ({
      path: operation.path,
      beforeDigest: operation.beforeDigest,
      afterDigest: operation.afterDigest,
    })),
  );
}

function validateSource(source: ExactSourceSnapshot): void {
  requiredId(source.repositoryId, "recipe_execution_repository_id");
  if (!REVISION.test(source.revision)) throw new Error("recipe_execution_revision_invalid");
  assertDigest(source.digest, "recipe_execution_source_digest");
  validateFiles(source.files);
  normalizeRecipeFileModes(source.files, source.fileModes);
  if (recipeFilesDigest(source.files) !== source.digest) {
    throw new Error("recipe_execution_source_digest_mismatch");
  }
}

function evidenceId(kind: "execution" | "restore", record: Omit<RecipeExecutionEvidenceRecord, "evidenceId"> | Omit<RecipeRestoreEvidenceRecord, "evidenceId">): string {
  return `tre_${kind}_${sha256(stableJson(record)).slice("sha256:".length)}`;
}

function persistEvidence<T extends RecipeExecutionEvidenceRecord | RecipeRestoreEvidenceRecord>(
  directory: string,
  record: T,
): PersistedRecipeEvidence<T> {
  const requested = resolve(directory);
  mkdirSync(requested, { recursive: true });
  const root = realpathSync(requested);
  const path = join(root, `${record.evidenceId}.json`);
  const serialized = `${stableJson(record, true)}\n`;
  const temporary = join(root, `.${record.evidenceId}.${randomUUID()}.tmp`);
  writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (!existsSync(path) || readFileSync(path, "utf8") !== serialized) {
      throw new Error("recipe_execution_evidence_conflict", { cause: error });
    }
  }
  return deepFreeze({ digest: sha256(serialized), path, record });
}

function assertExecutionEvidenceIntegrity(execution: RecipeWorkspaceExecutionResult): void {
  assertDigest(execution.evidence.digest, "recipe_execution_evidence_digest");
  if (!existsSync(execution.evidence.path)) throw new Error("recipe_execution_evidence_missing");
  const serialized = readFileSync(execution.evidence.path, "utf8");
  if (sha256(serialized) !== execution.evidence.digest) {
    throw new Error("recipe_execution_evidence_digest_mismatch");
  }
  let persisted: unknown;
  try {
    persisted = JSON.parse(serialized);
  } catch {
    throw new Error("recipe_execution_evidence_invalid_json");
  }
  if (stableJson(persisted) !== stableJson(execution.evidence.record)) {
    throw new Error("recipe_execution_evidence_record_mismatch");
  }
  const record = execution.evidence.record;
  const { cacheHit: _cacheHit, ...analysisEvidence } = execution.analysis;
  if (
    record.schemaVersion !== 2 ||
    record.kind !== "transformer.recipe.execution" ||
    stableJson(record.fence) !== stableJson(execution.fence) ||
    stableJson(record.recipe) !== stableJson(execution.recipe) ||
    stableJson(record.analysis) !== stableJson(analysisEvidence) ||
    record.inputDigest !== execution.inputDigest ||
    record.outputDigest !== execution.outputDigest ||
    record.operationCount !== execution.operations.length ||
    stableJson(record.operations) !== stableJson(operationEvidence(execution.operations))
  ) {
    throw new Error("recipe_execution_evidence_binding_mismatch");
  }
  validateFiles(execution.outputFiles);
  if (recipeFilesDigest(execution.outputFiles) !== execution.outputDigest) {
    throw new Error("recipe_execution_output_digest_mismatch");
  }
}

function failureCode(error: unknown): string {
  if (error instanceof RecipeWorkspaceExecutionError) return error.code;
  if (error instanceof Error && error.message) return error.message;
  return "recipe_workspace_execution_failed";
}

function discardWorkspace(workspace: string | undefined): boolean {
  if (!workspace) return true;
  try {
    rmSync(workspace, { recursive: true, force: true });
    return !existsSync(workspace);
  } catch {
    return false;
  }
}

function validateCommon(
  fence: RecipeExecutionFence,
  observedAt: string,
  commandTimeoutMs?: number,
): number {
  validateFence(fence);
  assertObservedAt(observedAt);
  const timeout = commandTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > MAX_COMMAND_TIMEOUT_MS) {
    throw new Error("recipe_execution_command_timeout_invalid");
  }
  return timeout;
}

export type RecipeVerificationGateResult = Readonly<{
  passed: boolean;
  /** Identifier of the first failing verification command, null when passed. */
  failingCommandId: string | null;
  /** Bounded, untrusted verifier output for the failing command. */
  output: string;
  /** Recipe-allowed paths present in the supplied files. */
  implicatedPaths: readonly string[];
}>;

export type RunRecipeVerificationGateInput = Readonly<{
  files: RecipeFiles;
  fileModes: RecipeFileModes;
  recipe: RecipeReference;
  commandRunner?: RecipeCommandRunner;
  commandTimeoutMs?: number;
  tempRoot?: string;
}>;

const GATE_OUTPUT_MAX_CHARS = 8_192;

/**
 * Run the recipe's objective verification commands against an arbitrary set of
 * files in a disposable workspace. Unlike {@link executeRecipeInWorkspace} this
 * applies no transform and enforces no lease fence — it is the objective gate
 * the adaptive repair loop re-runs after each edit. The workspace is always
 * disposed and the recipe's command allowlist is still enforced.
 */
export async function runRecipeVerificationGate(
  input: RunRecipeVerificationGateInput,
): Promise<RecipeVerificationGateResult> {
  const timeout = input.commandTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > MAX_COMMAND_TIMEOUT_MS) {
    throw new Error("recipe_execution_command_timeout_invalid");
  }
  const recipe = resolveRecipe(input.recipe);
  const implicatedPaths = Object.freeze(
    recipe.allowedPaths.filter((path) => input.files[path] !== undefined),
  );
  const runner = input.commandRunner ?? defaultCommandRunner;
  let workspace: string | undefined;
  try {
    workspace = createWorkspace(input.tempRoot);
    materializeFiles(workspace, input.files, input.fileModes);
    for (const command of recipe.verificationCommands) {
      const invocation = allowlistedInvocation(input.recipe, command, workspace, timeout);
      const result = await runner(invocation);
      if (!Number.isSafeInteger(result.exitCode)) throw new Error("recipe_execution_command_result_invalid");
      if (result.exitCode !== 0) {
        const output = `${result.stdout}\n${result.stderr}`.slice(0, GATE_OUTPUT_MAX_CHARS);
        return deepFreeze({ passed: false, failingCommandId: command.id, output, implicatedPaths });
      }
    }
    return deepFreeze({ passed: true, failingCommandId: null, output: "", implicatedPaths });
  } finally {
    discardWorkspace(workspace);
  }
}

export async function executeRecipeInWorkspace(
  input: ExecuteRecipeWorkspaceInput,
): Promise<RecipeWorkspaceExecutionResult> {
  const timeoutMs = validateCommon(input.fence, input.observedAt, input.commandTimeoutMs);
  validateSource(input.source);
  const recipe = resolveRecipe(input.recipe);
  let workspace: string | undefined;
  let application: RecipeApplication | undefined;
  let operationsApplied = false;
  try {
    await assertCurrentFence(input.fence, input.assertFence);
    application = WORKSPACE_ANALYSIS_CACHE.apply(
      input.fence.tenantId,
      input.recipe,
      input.source.files,
    );
    workspace = createWorkspace(input.tempRoot);
    materializeFiles(workspace, input.source.files, input.source.fileModes);
    assertWorkspaceEquals(workspace, input.source.files, "materialized");

    await assertCurrentFence(input.fence, input.assertFence);
    operationsApplied = true;
    applyOperationsToWorkspace(workspace, application.operations);
    assertWorkspaceEquals(workspace, application.files, "transformed");

    const commands: RecipeCommandEvidence[] = [];
    const runner = input.commandRunner ?? defaultCommandRunner;
    for (const command of recipe.verificationCommands) {
      await assertCurrentFence(input.fence, input.assertFence);
      const invocation = allowlistedInvocation(input.recipe, command, workspace, timeoutMs);
      const result = await runner(invocation);
      const evidence = commandEvidence(command, result);
      commands.push(evidence);
      if (result.exitCode !== 0) throw new Error(`recipe_execution_verification_failed:${command.id}`);
      assertWorkspaceEquals(workspace, application.files, `verification:${command.id}`);
    }

    await assertCurrentFence(input.fence, input.assertFence);
    if (!discardWorkspace(workspace)) throw new Error("recipe_workspace_disposal_failed");
    workspace = undefined;
    const publicFence = fenceEvidence(input.fence);
    const source = deepFreeze({
      repositoryId: input.source.repositoryId,
      revision: input.source.revision,
      digest: input.source.digest,
      fileModes: normalizeRecipeFileModes(input.source.files, input.source.fileModes),
    });
    const { cacheHit: _cacheHit, ...analysisEvidence } = application.analysis;
    const recordWithoutId = deepFreeze({
      schemaVersion: 2 as const,
      kind: "transformer.recipe.execution" as const,
      observedAt: input.observedAt,
      fence: publicFence,
      source,
      recipe: application.recipe,
      analysis: deepFreeze(analysisEvidence),
      inputDigest: application.inputDigest,
      outputDigest: application.outputDigest,
      operationCount: application.operations.length,
      operations: operationEvidence(application.operations),
      commands: deepFreeze(commands),
      workspaceDisposed: true as const,
    });
    const record = deepFreeze({
      ...recordWithoutId,
      evidenceId: evidenceId("execution", recordWithoutId),
    });
    const evidence = persistEvidence(input.evidenceDirectory, record);
    return deepFreeze({
      fence: publicFence,
      source,
      recipe: application.recipe,
      analysis: application.analysis,
      inputDigest: application.inputDigest,
      outputDigest: application.outputDigest,
      outputFiles: application.files,
      outputFileModes: normalizeRecipeFileModes(application.files, input.source.fileModes),
      operations: application.operations,
      commands,
      evidence,
    });
  } catch (error) {
    let inverseVerified = false;
    let rollbackError: string | undefined;
    if (workspace && application && operationsApplied) {
      try {
        applyInverseToWorkspace(workspace, application.recipe, application.operations, input.source.files);
        inverseVerified = true;
      } catch (rollbackFailure) {
        rollbackError = failureCode(rollbackFailure);
      }
    }
    const attempted = Boolean(workspace && application && operationsApplied);
    const discarded = discardWorkspace(workspace);
    workspace = undefined;
    throw new RecipeWorkspaceExecutionError(
      failureCode(error),
      deepFreeze({
        attempted,
        inverseVerified,
        workspaceDiscarded: discarded,
        ...(rollbackError ? { error: rollbackError } : {}),
      }),
      error,
    );
  } finally {
    discardWorkspace(workspace);
  }
}

export async function restoreRecipeExecutionInWorkspace(
  input: RestoreRecipeWorkspaceInput,
): Promise<RecipeWorkspaceRestoreResult> {
  validateCommon(input.fence, input.observedAt);
  const execution = input.execution;
  if (
    input.fence.tenantId !== execution.fence.tenantId ||
    input.fence.campaignId !== execution.fence.campaignId ||
    input.fence.unitId !== execution.fence.unitId ||
    input.fence.attemptId !== execution.fence.attemptId ||
    input.fence.leaseGeneration !== execution.fence.leaseGeneration ||
    sha256(input.fence.leaseToken) !== execution.fence.leaseTokenDigest
  ) {
    throw new RecipeWorkspaceExecutionError("recipe_restore_fence_mismatch", {
      attempted: false,
      inverseVerified: false,
      workspaceDiscarded: true,
    });
  }
  resolveRecipe(execution.recipe);
  assertExecutionEvidenceIntegrity(execution);
  validateFiles(input.currentFiles);
  if (recipeFilesDigest(input.currentFiles) !== execution.outputDigest) {
    throw new RecipeWorkspaceExecutionError("recipe_restore_current_digest_mismatch", {
      attempted: false,
      inverseVerified: false,
      workspaceDiscarded: true,
    });
  }
  let workspace: string | undefined;
  try {
    await assertCurrentFence(input.fence, input.assertFence);
    workspace = createWorkspace(input.tempRoot);
    materializeFiles(workspace, input.currentFiles, execution.outputFileModes);
    assertWorkspaceEquals(workspace, input.currentFiles, "restore_materialized");
    const restoredFiles = applyInverseOperations(
      execution.recipe,
      input.currentFiles,
      execution.operations,
    );
    applyInverseToWorkspace(workspace, execution.recipe, execution.operations, restoredFiles);
    const outputDigest = recipeFilesDigest(restoredFiles);
    if (outputDigest !== execution.inputDigest) throw new Error("recipe_restore_input_digest_mismatch");
    await assertCurrentFence(input.fence, input.assertFence);
    if (!discardWorkspace(workspace)) throw new Error("recipe_workspace_disposal_failed");
    workspace = undefined;
    const publicFence = fenceEvidence(input.fence);
    const recordWithoutId = deepFreeze({
      schemaVersion: 1 as const,
      kind: "transformer.recipe.restore" as const,
      observedAt: input.observedAt,
      fence: publicFence,
      recipe: execution.recipe,
      executionEvidenceDigest: execution.evidence.digest,
      inputDigest: execution.outputDigest,
      outputDigest,
      operationCount: execution.operations.length,
      restored: true as const,
      workspaceDisposed: true as const,
    });
    const record = deepFreeze({
      ...recordWithoutId,
      evidenceId: evidenceId("restore", recordWithoutId),
    });
    const evidence = persistEvidence(input.evidenceDirectory, record);
    return deepFreeze({
      fence: publicFence,
      recipe: execution.recipe,
      inputDigest: execution.outputDigest,
      outputDigest,
      restoredFiles,
      evidence,
    });
  } catch (error) {
    const attempted = Boolean(workspace);
    const discarded = discardWorkspace(workspace);
    workspace = undefined;
    if (error instanceof RecipeWorkspaceExecutionError) throw error;
    throw new RecipeWorkspaceExecutionError(
      failureCode(error),
      {
        attempted,
        inverseVerified: false,
        workspaceDiscarded: discarded,
      },
      error,
    );
  } finally {
    discardWorkspace(workspace);
  }
}
