import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  runVerificationCommand,
  validateVerificationCommands,
  type VerificationExecution,
} from "@mendpoint/repair";
import type { CandidateReviewEvidenceV2 } from "@mendpoint/shared";
import {
  createWardenRuntimeModelAuthorityDigest,
  runWarden,
  runWardenWithRuntime,
} from "./agent.js";
import { EXCLUDED_DIRECTORIES, verificationControlPath } from "./policies.js";
import type {
  AgentExecutionMetrics,
  AgentMissionPlan,
  AgentRunResult,
  AgentTask,
  AgentTaskMode,
} from "./types.js";
import {
  openWardenRuntimeExecution,
  type WardenRuntimeExecution,
  type WardenRuntimeTerminalEvidence,
} from "./runtime-execution.js";
import { createWardenRuntimeManifestDigest, type WardenPrivateRuntimeStateV1 } from "./runtime-state.js";
import type { WardenCheckpointJournal } from "./checkpoint.js";

export type WardenAttemptLimits = Readonly<{
  maxSourceFiles: number;
  maxSourceFileBytes: number;
  maxSourceBytes: number;
  maxTreeDepth: number;
  maxChangedFiles: number;
  maxChangedFileBytes: number;
  maxChangedBytes: number;
  maxEvidenceBytes: number;
  verificationTimeoutMs: number;
  allowedChangedPaths: readonly string[];
}>;

export type WardenAttemptRuntime = Readonly<{
  jobId: string;
  journal: WardenCheckpointJournal;
  key: Uint8Array;
  writerLeaseGeneration: number;
  executorDigest: string;
  operationTimeoutMs?: number;
  signal?: AbortSignal;
  now?: () => string;
}>;

export type WardenAttemptInput = Readonly<{
  mode?: AgentTaskMode;
  scope: Readonly<{ tenantId: string; attemptId: string }>;
  source: Readonly<{
    repositoryId: string;
    snapshotId: string;
    revision: string;
    manifestSha256: string;
    sparsePaths: readonly string[];
    root: string;
  }>;
  candidateRoot: string;
  evidenceRoot: string;
  task: Omit<AgentTask, "repoRoot" | "tenantId">;
  verification: Readonly<{
    targetCommand: string;
    regressionCommands: readonly string[];
    securityCommands: readonly string[];
  }>;
  limits: WardenAttemptLimits;
  runtime?: WardenAttemptRuntime;
}>;

type AttemptArtifacts = Readonly<{
  candidateWorkspace: string;
  candidateManifest: string;
  evidence: string;
  sourceDigest: string;
  candidateDigest: string;
  candidateManifestSha256: string;
  evidenceSha256: string;
}>;

export type WardenAttemptAgentSummary = Readonly<{
  sessionId: string;
  ok: boolean;
  steps: number;
  stoppedReason: AgentRunResult["stoppedReason"];
  filesChanged: readonly string[];
  reportMarkdown: string;
  toolCalls: number;
  verifierCalls: number;
  modelCalls: number;
  modelSuccessfulCalls: number;
  groundedMutations: number;
  blockedMutations: number;
  sourceContext: AgentExecutionMetrics["sourceContext"];
  missionPlan: AgentMissionPlan | null;
  modelSource: Readonly<{
    authorized: boolean;
    policyDigest: string | null;
    provider: string | null;
    model: string | null;
    endpoint: string | null;
  }>;
  /**
   * Measured model cost + token attribution rolled up from the agent execution
   * metrics. `measured` is true only when at least one model call was made; a
   * deterministic heuristic-only run makes no call, so every value is null
   * rather than a fabricated zero presented as a measured cost.
   */
  usage: Readonly<{
    measured: boolean;
    costUsd: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  }>;
}>;

type EmptyAttemptArtifacts = Readonly<{
  candidateWorkspace: null;
  candidateManifest: null;
  evidence: null;
  sourceDigest?: string;
  candidateDigest?: string;
}>;

export type WardenAttemptResult =
  | Readonly<{
      status: "succeeded";
      summary: string;
      nextActions: readonly string[];
      changedPaths: readonly string[];
      agent: WardenAttemptAgentSummary;
      artifacts: AttemptArtifacts;
      finalizeTerminal?: () => Promise<WardenRuntimeTerminalEvidence>;
    }>
  | Readonly<{
      status: "rejected";
      code: string;
      summary: string;
      nextActions: readonly string[];
      changedPaths: readonly string[];
      agent?: WardenAttemptAgentSummary;
      artifacts: EmptyAttemptArtifacts;
    }>;

type ManifestEntry = Readonly<{
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
}>;

type TreeManifest = Readonly<{
  entries: readonly ManifestEntry[];
  digest: string;
  totalBytes: number;
  /**
   * Repo-relative paths of symbolic links that were skipped (never followed and
   * never hashed) during the walk. Recorded for observability; deliberately not
   * part of `digest`, which covers file content only.
   */
  symlinks: readonly string[];
}>;

type VerificationRecord = Readonly<{
  command: string;
  ok: boolean;
  exitCode: number;
  outputSha256: string;
}>;

class AttemptError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AttemptError";
  }
}

const HARD_LIMITS = Object.freeze({
  // Ceilings, not defaults. Once excluded directories (node_modules, dist, build
  // outputs, VCS metadata) are skipped, the tracked tree of even a large
  // monorepo fits well under these. See scanTree and EXCLUDED_DIRECTORIES.
  maxSourceFiles: 200_000,
  maxSourceFileBytes: 32 * 1024 * 1024,
  maxSourceBytes: 2 * 1024 * 1024 * 1024,
  maxTreeDepth: 64,
  maxChangedFiles: 1_000,
  maxChangedFileBytes: 32 * 1024 * 1024,
  maxChangedBytes: 128 * 1024 * 1024,
  maxEvidenceBytes: 4 * 1024 * 1024,
  verificationTimeoutMs: 300_000,
});

export const WARDEN_CANDIDATE_REVIEW_LIMITS = Object.freeze({
  maxChangedFiles: 40,
  maxChangedFileBytes: 256 * 1024,
  maxChangedBytes: 2 * 1024 * 1024,
});

const WARDEN_NPM_FALLBACK_ENV = new Set([
  "path", "pathext", "systemroot", "windir", "comspec", "temp", "tmp", "tmpdir",
  "node_env", "ci", "no_color", "force_color", "lang", "lc_all", "tz",
]);

export function wardenNpmFallbackEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) =>
      value !== undefined && WARDEN_NPM_FALLBACK_ENV.has(key.toLowerCase())
    ),
  );
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function bareSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function freezeResult<T extends WardenAttemptResult>(value: T): T {
  Object.freeze(value.changedPaths);
  Object.freeze(value.nextActions);
  Object.freeze(value.artifacts);
  if (value.agent) {
    Object.freeze(value.agent.filesChanged);
    Object.freeze(value.agent);
  }
  return Object.freeze(value);
}

function reject(
  code: string,
  summary: string,
  digests: { sourceDigest?: string; candidateDigest?: string } = {},
  agent?: WardenAttemptAgentSummary,
): WardenAttemptResult {
  return freezeResult({
    status: "rejected",
    code,
    summary,
    nextActions: Object.freeze(["Review the rejection code and submit a new bounded attempt."]),
    changedPaths: Object.freeze([]),
    ...(agent ? { agent } : {}),
    artifacts: Object.freeze({
      candidateWorkspace: null,
      candidateManifest: null,
      evidence: null,
      ...digests,
    }),
  });
}

function fail(code: string, message: string): never {
  throw new AttemptError(code, message);
}

function assertAttemptContinues(input: WardenAttemptInput): void {
  if (input.task.shouldContinue?.() === false) {
    fail("warden_attempt_cancelled", "The attempt lost its execution fence.");
  }
}

function requireIdentifier(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    fail("warden_attempt_invalid_binding", `${field} is invalid.`);
  }
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail("warden_attempt_invalid_limits", `Unsafe relative path: ${value}`);
  }
  return normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function checkedDirectory(path: string, field: string): string {
  if (!isAbsolute(path) || !existsSync(path)) {
    fail("warden_attempt_invalid_root", `${field} must be an existing absolute directory.`);
  }
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail("warden_attempt_invalid_root", `${field} must be a real directory.`);
  }
  return realpathSync(resolve(path));
}

function validateLimits(limits: WardenAttemptLimits): ReadonlySet<string> {
  const numeric = Object.keys(HARD_LIMITS) as (keyof typeof HARD_LIMITS)[];
  for (const key of numeric) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > HARD_LIMITS[key]) {
      fail("warden_attempt_invalid_limits", `${key} is outside the accepted range.`);
    }
  }
  if (!Array.isArray(limits.allowedChangedPaths) || limits.allowedChangedPaths.length === 0) {
    fail("warden_attempt_invalid_limits", "At least one exact changed path must be allowed.");
  }
  const paths = limits.allowedChangedPaths.map(normalizeRelativePath);
  if (new Set(paths).size !== paths.length) {
    fail("warden_attempt_invalid_limits", "Allowed changed paths must be unique.");
  }
  const verificationPath = paths.find(verificationControlPath);
  if (verificationPath) {
    fail(
      "warden_attempt_verification_path_blocked",
      `Verification control paths cannot be mutation targets: ${verificationPath}.`,
    );
  }
  return new Set(paths);
}

function validateInput(input: WardenAttemptInput): {
  sourceRoot: string;
  candidateRoot: string;
  evidenceRoot: string;
  allowedPaths: ReadonlySet<string>;
  mode: AgentTaskMode;
} {
  requireIdentifier(input.scope.tenantId, "tenantId");
  requireIdentifier(input.scope.attemptId, "attemptId");
  requireIdentifier(input.source.repositoryId, "repositoryId");
  requireIdentifier(input.source.snapshotId, "snapshotId");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.source.revision)) {
    fail("warden_attempt_invalid_binding", "revision must be a lowercase commit digest.");
  }
  if (!/^[a-f0-9]{64}$/.test(input.source.manifestSha256)) {
    fail("warden_attempt_invalid_binding", "manifestSha256 must be a lowercase SHA-256 digest.");
  }
  if (!Array.isArray(input.source.sparsePaths)) {
    fail("warden_attempt_invalid_binding", "sparsePaths must be an array.");
  }
  const sparsePaths = input.source.sparsePaths.map(normalizeRelativePath);
  if (new Set(sparsePaths).size !== sparsePaths.length) {
    fail("warden_attempt_invalid_binding", "sparsePaths must be unique.");
  }
  if (!input.task.goal.trim()) {
    fail("warden_attempt_invalid_task", "The Warden task goal is required.");
  }
  if (input.mode !== undefined && input.mode !== "repair" && input.mode !== "feature") {
    fail("warden_attempt_invalid_task_mode", "Task mode must be repair or feature.");
  }
  if ((input.mode ?? "repair") === "feature" && !input.task.useLlm && !input.task.planner) {
    fail(
      "warden_attempt_feature_model_required",
      "Feature tasks require an approved model planner.",
    );
  }
  if (input.task.allowModelSource) {
    const policy = input.task.modelSourcePolicy;
    if (
      !policy?.approved ||
      policy.tenantId !== input.scope.tenantId ||
      !/^sha256:[a-f0-9]{64}$/.test(policy.policyDigest) ||
      !policy.provider.trim() ||
      !policy.model.trim() ||
      !policy.endpoint.trim()
    ) {
      fail("warden_attempt_source_policy_denied", "Model source authorization is not bound to this tenant.");
    }
  }

  const sourceRoot = checkedDirectory(input.source.root, "source.root");
  const candidateRoot = checkedDirectory(input.candidateRoot, "candidateRoot");
  const evidenceRoot = checkedDirectory(input.evidenceRoot, "evidenceRoot");
  const roots = [sourceRoot, candidateRoot, evidenceRoot];
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (isWithin(roots[left]!, roots[right]!) || isWithin(roots[right]!, roots[left]!)) {
        fail("warden_attempt_root_overlap", "Source, candidate, and evidence roots must be disjoint.");
      }
    }
  }
  return {
    sourceRoot,
    candidateRoot,
    evidenceRoot,
    allowedPaths: validateLimits(input.limits),
    mode: input.mode ?? "repair",
  };
}

function snapshotManifestSha256(
  manifest: TreeManifest,
  sparsePaths: readonly string[],
): string {
  const files = manifest.entries.map((entry) => ({
    path: entry.path,
    mode: entry.executable ? "100755" : "100644",
    kind: "file",
    size: entry.size,
    sha256: entry.sha256.replace(/^sha256:/, ""),
  }));
  return bareSha256(JSON.stringify({
    files,
    submodules: [],
    sparsePaths: [...sparsePaths].sort(),
  }));
}

/**
 * Options that bound directory exclusion for a scan.
 *
 * The immutable source is scanned faithfully (no exclusion) so its digest keeps
 * matching the stored snapshot manifest, which is computed over every tracked
 * file (Go-style `vendor/`, committed `dist/`, and so on are legitimate source).
 *
 * The private candidate workspace is where verifiers install dependencies and
 * emit build outputs (`node_modules`, `dist`, `coverage`, ...). Those are not
 * source and must not read as candidate mutations or blow the file/byte cap, so
 * candidate scans exclude the well-known generated directory names -- but only
 * where the same path was NOT copied from the tracked source (`keepDirectories`
 * carries the tracked directory prefixes, so a committed `vendor/` survives).
 */
type ScanExclusion = Readonly<{
  excludeGenerated: ReadonlySet<string>;
  keepDirectories: ReadonlySet<string>;
}>;

/** Every ancestor directory prefix that contains at least one tracked file. */
function trackedDirectories(manifest: TreeManifest): ReadonlySet<string> {
  const directories = new Set<string>();
  for (const entry of manifest.entries) {
    const segments = entry.path.split("/");
    let prefix = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      prefix = prefix ? `${prefix}/${segments[index]}` : segments[index]!;
      directories.add(prefix);
    }
  }
  return directories;
}

export function scanTree(
  root: string,
  limits: WardenAttemptLimits,
  symlinkCode: string,
  exclusion?: ScanExclusion,
): TreeManifest {
  const entries: ManifestEntry[] = [];
  const symlinks: string[] = [];
  let totalBytes = 0;

  const visit = (directory: string, relativeDirectory: string, depth: number): void => {
    if (depth > limits.maxTreeDepth) {
      fail("warden_attempt_source_tree_limit", "Tree depth exceeds the attempt limit.");
    }
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, item.name);
      const path = relativeDirectory ? `${relativeDirectory}/${item.name}` : item.name;
      const info = lstatSync(absolute);
      if (info.isSymbolicLink() || item.isSymbolicLink()) {
        // A symlink is never followed and never hashed. If it resolves outside
        // the bound root it is a traversal escape and still refuses the run;
        // otherwise it is skipped and recorded so tooling that legitimately
        // uses in-tree links (pnpm/yarn workspaces, generated links) does not
        // abort a whole attempt. An unresolvable (broken) link points to no
        // content and is safe to skip.
        let realTarget: string | null = null;
        try {
          realTarget = realpathSync(absolute);
        } catch {
          realTarget = null;
        }
        if (realTarget !== null && !isWithin(root, realTarget)) {
          fail(symlinkCode, `Symbolic link escapes its bound root: ${path}.`);
        }
        symlinks.push(path);
        continue;
      }
      if (info.isDirectory()) {
        // Skip a well-known generated directory (a verifier-installed
        // node_modules, a fresh dist/coverage/build) so it neither blows the
        // file and byte ceilings nor reads as a candidate mutation. Only skip
        // where the tracked source did not itself carry this directory, so a
        // committed vendor/ or dist/ is never dropped.
        if (
          exclusion?.excludeGenerated.has(item.name) &&
          !exclusion.keepDirectories.has(path)
        ) {
          continue;
        }
        if (!isWithin(root, realpathSync(absolute))) {
          fail("warden_attempt_source_escape", `Path escapes its bound root: ${path}.`);
        }
        visit(absolute, path, depth + 1);
        continue;
      }
      if (!isWithin(root, realpathSync(absolute))) {
        fail("warden_attempt_source_escape", `Path escapes its bound root: ${path}.`);
      }
      if (!info.isFile()) {
        fail("warden_attempt_source_special_file", `Special file blocked at ${path}.`);
      }
      if (info.size > limits.maxSourceFileBytes) {
        fail("warden_attempt_source_tree_limit", `File size exceeds the attempt limit: ${path}.`);
      }
      const content = readFileSync(absolute);
      const after = statSync(absolute);
      if (after.size !== info.size || content.byteLength !== info.size) {
        fail("warden_attempt_source_mutated", `Source changed while reading ${path}.`);
      }
      totalBytes += content.byteLength;
      if (totalBytes > limits.maxSourceBytes || entries.length + 1 > limits.maxSourceFiles) {
        fail("warden_attempt_source_tree_limit", "Source tree exceeds the attempt limit.");
      }
      entries.push(Object.freeze({
        path,
        size: content.byteLength,
        sha256: sha256(content),
        executable: (info.mode & 0o111) !== 0,
      }));
    }
  };

  visit(root, "", 0);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  symlinks.sort((left, right) => left.localeCompare(right));
  const frozenEntries = Object.freeze(entries);
  return Object.freeze({
    entries: frozenEntries,
    digest: sha256(canonicalJson(frozenEntries)),
    totalBytes,
    symlinks: Object.freeze(symlinks),
  });
}

/**
 * Copies the bound source manifest into the private workspace and returns the
 * manifest of what actually landed on disk. Each file is read back after the
 * write and re-hashed, so this preserves the same "the copy matches the source"
 * integrity guarantee the earlier separate `scanTree(workspace)` pass gave,
 * while removing one full independent tree walk per attempt. The returned digest
 * is computed identically to `scanTree`, so the caller can still assert it
 * equals the source digest.
 */
function copyManifest(sourceRoot: string, workspace: string, manifest: TreeManifest): TreeManifest {
  chmodSync(workspace, 0o700);
  const entries: ManifestEntry[] = [];
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    const source = join(sourceRoot, ...entry.path.split("/"));
    const target = join(workspace, ...entry.path.split("/"));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    chmodSync(dirname(target), 0o700);
    const content = readFileSync(source);
    if (content.byteLength !== entry.size || sha256(content) !== entry.sha256) {
      fail("warden_attempt_source_mutated", `Source changed before copy: ${entry.path}.`);
    }
    writeFileSync(target, content, { flag: "wx", mode: entry.executable ? 0o700 : 0o600 });
    chmodSync(target, entry.executable ? 0o700 : 0o600);
    const written = readFileSync(target);
    const writtenDigest = sha256(written);
    if (written.byteLength !== entry.size || writtenDigest !== entry.sha256) {
      fail("warden_attempt_copy_mismatch", `Candidate copy does not match the bound source tree: ${entry.path}.`);
    }
    totalBytes += written.byteLength;
    entries.push(Object.freeze({
      path: entry.path,
      size: written.byteLength,
      sha256: writtenDigest,
      executable: entry.executable,
    }));
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const frozenEntries = Object.freeze(entries);
  return Object.freeze({
    entries: frozenEntries,
    digest: sha256(canonicalJson(frozenEntries)),
    totalBytes,
    symlinks: Object.freeze([] as string[]),
  });
}

async function verify(
  command: string,
  workspace: string,
  timeoutMs: number,
): Promise<{ execution: VerificationExecution; record: VerificationRecord }> {
  let execution: VerificationExecution;
  try {
    execution = await runVerificationCommand(command, workspace, timeoutMs);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    const npmExecutable = process.env.npm_execpath;
    if (
      failure.code !== "EINVAL" ||
      process.env.NODE_ENV === "production" ||
      !npmExecutable ||
      !existsSync(npmExecutable) ||
      !/^npm (?:test|build|run (?:test|build|typecheck|lint))$/.test(command)
    ) {
      throw error;
    }
    const args = command.split(" ").slice(1);
    execution = await new Promise<VerificationExecution>((resolveExecution) => {
      execFile(process.execPath, [npmExecutable, ...args], {
        cwd: workspace,
        encoding: "utf8",
        timeout: Math.max(1_000, Math.min(timeoutMs, 300_000)),
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        env: wardenNpmFallbackEnvironment(process.env),
      }, (npmError, stdout, stderr) => {
        if (!npmError) {
          resolveExecution({ ok: true, stdout: String(stdout), stderr: String(stderr), exitCode: 0 });
          return;
        }
        const npmFailure = npmError as Error & { code?: number | string };
        resolveExecution({
          ok: false,
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode: Number.isInteger(npmFailure.code) ? Number(npmFailure.code) : 1,
          error: npmFailure.message,
        });
      });
    });
  }
  return {
    execution,
    record: Object.freeze({
      command,
      ok: execution.ok,
      exitCode: execution.exitCode,
      outputSha256: sha256(`${execution.stdout}\0${execution.stderr}\0${execution.error ?? ""}`),
    }),
  };
}

async function verifyAll(
  commands: readonly string[],
  workspace: string,
  timeoutMs: number,
): Promise<{ ok: boolean; records: readonly VerificationRecord[] }> {
  const records: VerificationRecord[] = [];
  for (const command of commands) {
    const result = await verify(command, workspace, timeoutMs);
    records.push(result.record);
    if (!result.execution.ok) return { ok: false, records: Object.freeze(records) };
  }
  return { ok: true, records: Object.freeze(records) };
}

function verifierPaths(manifest: TreeManifest): string[] {
  return manifest.entries
    .map((entry) => entry.path)
    .filter(verificationControlPath);
}

function sourceBudget(input: WardenAttemptInput): NonNullable<AgentTask["sourceContextBudget"]> {
  return {
    maxFileBytes: input.limits.maxSourceFileBytes,
    maxTotalReadBytes: input.limits.maxSourceBytes,
    maxSearchFiles: input.limits.maxSourceFiles,
    maxSearchBytes: input.limits.maxSourceBytes,
    maxSearchHits: input.limits.maxSourceFiles,
    maxPromptEvidenceBytes: input.limits.maxEvidenceBytes,
    maxChangedFiles: input.limits.maxChangedFiles,
    maxChangedBytes: input.limits.maxChangedBytes,
    maxSearchDepth: input.limits.maxTreeDepth,
  };
}

function compareTrees(
  before: TreeManifest,
  after: TreeManifest,
): { changedPaths: string[]; changedBytes: number } {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort();
  const changedPaths: string[] = [];
  let changedBytes = 0;
  for (const path of paths) {
    const left = beforeByPath.get(path);
    const right = afterByPath.get(path);
    if (
      !left ||
      !right ||
      left.sha256 !== right.sha256 ||
      left.size !== right.size ||
      left.executable !== right.executable
    ) {
      changedPaths.push(path);
      changedBytes += (left?.size ?? 0) + (right?.size ?? 0);
    }
  }
  return { changedPaths, changedBytes };
}

function reviewEvidence(
  agent: AgentRunResult,
  task: Omit<AgentTask, "repoRoot" | "tenantId">,
  mode: AgentTaskMode,
  changedPaths: readonly string[],
  commands: readonly VerificationRecord[],
): CandidateReviewEvidenceV2 {
  if (!commands.length || commands.some((command) => !command.ok || command.exitCode !== 0)) {
    throw new Error("warden_attempt_review_verification_invalid");
  }
  if (commands.length > 20 || commands.some((command) => command.command.length > 500)) {
    throw new AttemptError(
      "warden_attempt_review_evidence_limit",
      "The configured verification evidence does not fit the customer review contract.",
    );
  }
  const objective = task.goal.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 350);
  if (!objective) throw new Error("warden_attempt_review_objective_invalid");
  const verification = {
    summary: `All ${commands.length} configured verification commands passed on the exact candidate.`,
    commands: commands.map((command) => ({ ...command, ok: true as const, exitCode: 0 as const })),
  };
  const intentsByPath = new Map<string, Array<NonNullable<AgentRunResult["steps"][number]["call"]["intent"]>>>();
  for (const step of agent.steps) {
    const intent = step.call.intent;
    if (
      !step.result.ok ||
      (step.call.tool !== "write_file" && step.call.tool !== "replace_in_file") ||
      !intent ||
      intent.targetPath !== step.call.args.path
    ) continue;
    const intents = intentsByPath.get(intent.targetPath) ?? [];
    intents.push(intent);
    intentsByPath.set(intent.targetPath, intents);
  }
  const evidence: CandidateReviewEvidenceV2 = {
    schemaVersion: 2 as const,
    summary: "Every reviewed file is bound to the source snapshot, its accepted execution intent, and exact verifier evidence.",
    verification,
    edits: changedPaths.map((path) => {
      const intents = intentsByPath.get(path) ?? [];
      if (!intents.length) {
        throw new AttemptError(
          "warden_attempt_mutation_intent_missing",
          `Changed file has no accepted mutation intent: ${path}`,
        );
      }
      if (intents.some((intent) => intent.risk === "critical")) {
        throw new AttemptError(
          "warden_attempt_critical_risk_requires_escalation",
          `Critical-risk mutation cannot enter delivery review: ${path}`,
        );
      }
      const intent = intents.at(-1)!;
      const sourceEvidence = [...new Map(intents.flatMap((candidate) => candidate.evidenceRefs)
        .map((item) => [`${item.path}\0${item.digest}`, item] as const)).values()];
      if (sourceEvidence.length > 40) {
        throw new AttemptError(
          "warden_attempt_review_evidence_limit",
          `Changed file has too many source evidence references: ${path}`,
        );
      }
      const risk = intents.some((candidate) => candidate.risk === "high")
        ? "high" as const
        : intents.some((candidate) => candidate.risk === "medium")
          ? "medium" as const
          : "low" as const;
      return {
        path,
        hypothesis: intent.hypothesis.slice(0, 500),
        targetSymbol: intent.targetSymbol,
        sourceEvidence,
        precondition: intent.precondition,
        expectedObservation: intent.expectedObservation,
        postcondition: intent.postcondition,
        rollback: intent.rollback,
        stopCondition: intent.stopCondition,
        risk,
        confidence: Math.min(...intents.map((candidate) => candidate.confidence)),
        assessmentSource: intents.every((candidate) => candidate.assessmentSource === "model")
          ? "planner" as const
          : "heuristic" as const,
        verification: {
          summary: `${verification.summary} ${mode === "feature" ? "Feature" : "Repair"} objective: ${objective}`,
          commandOutputSha256: verification.commands.map((command) => command.outputSha256),
        },
      };
    }),
  };
  return Object.freeze(evidence);
}

function agentEvidence(
  agent: AgentRunResult,
  task: Omit<AgentTask, "repoRoot" | "tenantId">,
): WardenAttemptAgentSummary {
  const policy = task.modelSourcePolicy;
  const model = agent.metrics.model;
  const measured = model.calls > 0;
  return Object.freeze({
    sessionId: agent.sessionId,
    ok: agent.ok,
    steps: agent.steps.length,
    stoppedReason: agent.stoppedReason,
    filesChanged: Object.freeze([...agent.filesChanged].sort()),
    reportMarkdown: agent.reportMarkdown,
    toolCalls: agent.metrics.toolCalls,
    verifierCalls: agent.metrics.verifierCalls,
    modelCalls: model.calls,
    modelSuccessfulCalls: model.successfulCalls,
    groundedMutations: agent.metrics.sourceContext.groundedMutations,
    blockedMutations: agent.metrics.sourceContext.blockedMutations,
    sourceContext: agent.metrics.sourceContext,
    missionPlan: agent.missionPlan,
    modelSource: Object.freeze({
      authorized: Boolean(task.allowModelSource && policy?.approved),
      policyDigest: policy?.policyDigest ?? null,
      provider: policy?.provider ?? null,
      model: policy?.model ?? null,
      endpoint: policy?.endpoint ?? null,
    }),
    usage: Object.freeze({
      measured,
      costUsd: measured ? model.costUsd : null,
      promptTokens: measured ? model.promptTokens : null,
      completionTokens: measured ? model.completionTokens : null,
      totalTokens: measured ? model.totalTokens : null,
    }),
  });
}

function writeArtifactPair(
  candidateRoot: string,
  evidenceRoot: string,
  attemptId: string,
  manifest: unknown,
  evidence: unknown,
  maxBytes: number,
): { candidateManifest: string; evidence: string } {
  const manifestBody = `${canonicalJson(manifest)}\n`;
  const evidenceBody = `${canonicalJson(evidence)}\n`;
  if (Buffer.byteLength(manifestBody) + Buffer.byteLength(evidenceBody) > maxBytes) {
    fail("warden_attempt_evidence_limit", "Canonical attempt artifacts exceed the evidence limit.");
  }
  const stem = `${attemptId}-${randomUUID()}`;
  const manifestPath = join(candidateRoot, `${stem}.candidate-manifest.json`);
  const evidencePath = join(evidenceRoot, `${stem}.evidence.json`);
  const manifestTemp = `${manifestPath}.${randomUUID()}.tmp`;
  const evidenceTemp = `${evidencePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(manifestTemp, manifestBody, { flag: "wx", mode: 0o600 });
    writeFileSync(evidenceTemp, evidenceBody, { flag: "wx", mode: 0o600 });
    renameSync(manifestTemp, manifestPath);
    renameSync(evidenceTemp, evidencePath);
    return { candidateManifest: manifestPath, evidence: evidencePath };
  } catch (error) {
    rmSync(manifestTemp, { force: true });
    rmSync(evidenceTemp, { force: true });
    rmSync(manifestPath, { force: true });
    rmSync(evidencePath, { force: true });
    throw error;
  }
}

export async function runWardenAttempt(input: WardenAttemptInput): Promise<WardenAttemptResult> {
  let workspace: string | undefined;
  let sourceDigest: string | undefined;
  let candidateDigest: string | undefined;
  let agentSummary: WardenAttemptAgentSummary | undefined;
  let createdArtifacts: { candidateManifest: string; evidence: string } | undefined;
  let runtimeExecution: WardenRuntimeExecution | undefined;
  try {
    const validated = validateInput(input);
    assertAttemptContinues(input);
    const commands = [
      input.verification.targetCommand,
      ...input.verification.regressionCommands,
      ...input.verification.securityCommands,
    ];
    if (!commands.length || commands.some((command) => !command.trim())) {
      fail("warden_attempt_invalid_verification", "Every verification command must be nonempty.");
    }
    const verification = validateVerificationCommands(commands, validated.sourceRoot);
    if (!verification.ok) {
      fail("warden_attempt_invalid_verification", verification.error);
    }

    const sourceManifest = scanTree(
      validated.sourceRoot,
      input.limits,
      "warden_attempt_source_symlink",
    );
    if (
      snapshotManifestSha256(sourceManifest, input.source.sparsePaths) !==
      input.source.manifestSha256
    ) {
      fail(
        "warden_attempt_snapshot_manifest_mismatch",
        "The immutable source content does not match its stored snapshot manifest.",
      );
    }
    sourceDigest = sourceManifest.digest;
    // The candidate workspace is where verifiers install dependencies and emit
    // build outputs. Candidate scans skip those generated directories, but never
    // a directory that the tracked source itself carried.
    const candidateExclusion: ScanExclusion = {
      excludeGenerated: EXCLUDED_DIRECTORIES,
      keepDirectories: trackedDirectories(sourceManifest),
    };
    workspace = mkdtempSync(join(validated.candidateRoot, `${input.scope.attemptId}-`));
    chmodSync(workspace, 0o700);
    const copiedManifest = copyManifest(validated.sourceRoot, workspace, sourceManifest);
    if (copiedManifest.digest !== sourceManifest.digest) {
      fail("warden_attempt_copy_mismatch", "Candidate copy does not match the bound source tree.");
    }

    const baselineTarget = await verify(
      input.verification.targetCommand,
      workspace,
      input.limits.verificationTimeoutMs,
    );
    assertAttemptContinues(input);
    if (baselineTarget.execution.exitCode === 126) {
      fail(
        "warden_attempt_verifier_unavailable",
        baselineTarget.execution.error ?? "The target verifier is unavailable under production policy.",
      );
    }
    const baselineRegression = await verifyAll(
      input.verification.regressionCommands,
      workspace,
      input.limits.verificationTimeoutMs,
    );
    assertAttemptContinues(input);
    const baselineSecurity = await verifyAll(
      input.verification.securityCommands,
      workspace,
      input.limits.verificationTimeoutMs,
    );
    assertAttemptContinues(input);
    if (validated.mode === "feature") {
      if (!baselineTarget.execution.ok || !baselineRegression.ok || !baselineSecurity.ok) {
        fail(
          "warden_attempt_feature_baseline_failed",
          "A feature task requires every approved source verification command to pass before execution.",
        );
      }
    } else if (baselineTarget.execution.ok) {
      if (!baselineRegression.ok || !baselineSecurity.ok) {
        fail(
          "warden_attempt_primary_target_mismatch",
          "The primary target passes while another required snapshot policy check fails.",
        );
      }
      fail("warden_attempt_baseline_target_green", "The target verifier already passes on the source snapshot.");
    } else if (!baselineRegression.ok) {
      fail("warden_attempt_baseline_regression_failed", "A regression verifier fails before repair.");
    } else if (!baselineSecurity.ok) {
      fail("warden_attempt_baseline_security_failed", "A security verifier fails before repair.");
    }
    const baselineManifest = scanTree(workspace, input.limits, "warden_attempt_candidate_symlink", candidateExclusion);
    if (baselineManifest.digest !== sourceManifest.digest) {
      fail("warden_attempt_verifier_mutated_candidate", "A baseline verifier changed the private candidate.");
    }

    const readOnlyPaths = [...new Set([
      ...(input.task.readOnlyPaths ?? []).map(normalizeRelativePath),
      ...verifierPaths(sourceManifest),
    ])].sort();
    const agentTask: AgentTask = {
      ...input.task,
      taskMode: validated.mode,
      tenantId: input.scope.tenantId,
      repoRoot: workspace,
      verifyCommand: input.verification.targetCommand,
      neverTouchPaths: input.task.neverTouchPaths,
      readOnlyPaths,
      allowNetwork: false,
      requireSourceObservation: true,
      sourceContextBudget: sourceBudget(input),
    };
    let agent: AgentRunResult;
    if (input.runtime) {
      const sourceRuntimeManifest = Object.freeze(sourceManifest.entries.map((entry) =>
        Object.freeze({ path: entry.path, digest: entry.sha256, bytes: entry.size })
      ));
      const binding = Object.freeze({
        schemaVersion: 1 as const,
        tenantId: input.scope.tenantId,
        jobId: input.runtime.jobId,
        attemptId: input.scope.attemptId,
        repositoryId: input.source.repositoryId,
        snapshotId: input.source.snapshotId,
        revision: input.source.revision,
        sourceManifestSha256: createWardenRuntimeManifestDigest(sourceRuntimeManifest),
        allowedPathsDigest: sha256(canonicalJson([...validated.allowedPaths].sort())),
        verificationProfileDigest: sha256(canonicalJson({
          ...(validated.mode === "feature" ? { taskMode: "feature" } : {}),
          targetCommand: input.verification.targetCommand,
          regressionCommands: input.verification.regressionCommands,
          securityCommands: input.verification.securityCommands,
        })),
        modelPolicyDigest: createWardenRuntimeModelAuthorityDigest(agentTask),
      });
      const createdAt = input.runtime.now?.() ?? new Date().toISOString();
      const genesis: WardenPrivateRuntimeStateV1 = {
        schemaVersion: 1,
        binding,
        generation: 1,
        writerLeaseGeneration: input.runtime.writerLeaseGeneration,
        workspaceName: `${input.source.repositoryId}.${input.source.snapshotId}`,
        phase: "agent_running",
        previousEnvelopeDigest: null,
        createdAt,
        executorDigest: input.runtime.executorDigest,
        sourceManifest: sourceRuntimeManifest,
        workspaceManifest: sourceRuntimeManifest,
        events: [],
        sourceEvidence: [],
        observedDirectories: [],
        searches: [],
        modelCalls: [],
        sourceCounters: {
          observedBytes: 0,
          searchBytes: 0,
          changedBytes: 0,
          groundedMutations: 0,
          blockedMutations: 0,
        },
        privateState: {},
        privateHistory: [],
        rollbackPreimages: [],
        blobs: [],
        effectReceipts: [],
        pendingEffect: { kind: "none" },
      };
      const execution = await openWardenRuntimeExecution({
        binding,
        journal: input.runtime.journal,
        key: input.runtime.key,
        executorDigest: input.runtime.executorDigest,
        writerLeaseGeneration: input.runtime.writerLeaseGeneration,
        operationTimeoutMs: input.runtime.operationTimeoutMs,
        signal: input.runtime.signal,
        genesis,
        now: input.runtime.now,
      });
      runtimeExecution = execution;
      agent = await runWardenWithRuntime(agentTask, {
        execution,
        binding,
        repoRoot: workspace,
        verifyCommand: input.verification.targetCommand,
        durableEffects: true,
      });
    } else {
      agent = await runWarden(agentTask);
    }
    assertAttemptContinues(input);
    agentSummary = agentEvidence(agent, input.task);

    const sourceAfterAgent = scanTree(
      validated.sourceRoot,
      input.limits,
      "warden_attempt_source_symlink",
    );
    if (sourceAfterAgent.digest !== sourceManifest.digest) {
      fail("warden_attempt_source_mutated", "The immutable source changed during agent execution.");
    }
    if (!agent.ok) {
      if (agent.stoppedReason === "mutation_intent_critical_requires_escalation") {
        fail(
          "warden_attempt_critical_risk_requires_escalation",
          "Warden blocked a critical-risk mutation before repository execution.",
        );
      }
      if (agent.stoppedReason === "verifier_mutated_candidate") {
        fail(
          "warden_attempt_verifier_mutated_candidate",
          "Warden rejected an in-agent verifier that changed candidate bytes.",
        );
      }
      fail("warden_attempt_agent_failed", `Warden rejected the candidate: ${agent.stoppedReason}`);
    }
    const agentCandidateManifest = scanTree(
      workspace,
      input.limits,
      "warden_attempt_candidate_symlink",
      candidateExclusion,
    );
    for (const path of agent.filesChanged) {
      const expected = [...agent.steps].reverse().find((step) =>
        step.result.ok &&
        (step.call.tool === "write_file" || step.call.tool === "replace_in_file") &&
        step.call.intent?.targetPath === path
      )?.call.intent?.expectedResultDigest;
      const actual = agentCandidateManifest.entries.find((entry) => entry.path === path)?.sha256;
      if (!expected || actual !== expected) {
        fail(
          "warden_attempt_verifier_mutated_candidate",
          `Candidate bytes do not match the latest accepted mutation intent: ${path}.`,
        );
      }
    }

    const target = await verify(
      input.verification.targetCommand,
      workspace,
      input.limits.verificationTimeoutMs,
    );
    assertAttemptContinues(input);
    if (!target.execution.ok) {
      fail("warden_attempt_target_failed", "The repaired candidate does not pass the target verifier.");
    }
    const regression = await verifyAll(
      input.verification.regressionCommands,
      workspace,
      input.limits.verificationTimeoutMs,
    );
    assertAttemptContinues(input);
    if (!regression.ok) {
      fail("warden_attempt_regression_failed", "The repaired candidate fails a regression verifier.");
    }
    const security = await verifyAll(
      input.verification.securityCommands,
      workspace,
      input.limits.verificationTimeoutMs,
    );
    assertAttemptContinues(input);
    if (!security.ok) {
      fail("warden_attempt_security_failed", "The repaired candidate fails a security verifier.");
    }

    const candidateManifest = scanTree(workspace, input.limits, "warden_attempt_candidate_symlink", candidateExclusion);
    if (candidateManifest.digest !== agentCandidateManifest.digest) {
      fail("warden_attempt_verifier_mutated_candidate", "An independent verifier changed the candidate.");
    }
    candidateDigest = candidateManifest.digest;
    const difference = compareTrees(sourceManifest, candidateManifest);
    if (difference.changedPaths.length === 0) {
      fail("warden_attempt_empty_diff", "The successful candidate contains no source change.");
    }
    const blockedPath = difference.changedPaths.find((path) => !validated.allowedPaths.has(path));
    if (blockedPath) {
      fail("warden_attempt_changed_path_blocked", `Changed path is outside the exact allowlist: ${blockedPath}.`);
    }
    if (difference.changedPaths.length > input.limits.maxChangedFiles) {
      fail("warden_attempt_changed_file_limit", "The candidate exceeds the changed file limit.");
    }
    const oversizedChangedPath = difference.changedPaths.find((path) => {
      const before = sourceManifest.entries.find((entry) => entry.path === path);
      const after = candidateManifest.entries.find((entry) => entry.path === path);
      return (before?.size ?? 0) > input.limits.maxChangedFileBytes ||
        (after?.size ?? 0) > input.limits.maxChangedFileBytes;
    });
    if (oversizedChangedPath) {
      fail(
        "warden_attempt_changed_file_byte_limit",
        `Changed file exceeds the review limit: ${oversizedChangedPath}.`,
      );
    }
    if (difference.changedBytes > input.limits.maxChangedBytes) {
      fail("warden_attempt_changed_byte_limit", "The candidate exceeds the changed byte limit.");
    }
    const finalSource = scanTree(
      validated.sourceRoot,
      input.limits,
      "warden_attempt_source_symlink",
    );
    if (finalSource.digest !== sourceManifest.digest) {
      fail("warden_attempt_source_mutated", "The immutable source changed before commit.");
    }
    assertAttemptContinues(input);

    const manifestArtifact = {
      schemaVersion: 1,
      taskMode: validated.mode,
      scope: input.scope,
      source: {
        repositoryId: input.source.repositoryId,
        snapshotId: input.source.snapshotId,
        revision: input.source.revision,
        manifestSha256: input.source.manifestSha256,
        digest: sourceManifest.digest,
      },
      candidate: {
        digest: candidateManifest.digest,
        entries: candidateManifest.entries,
      },
      changedPaths: difference.changedPaths,
      changedBytes: difference.changedBytes,
    };
    const evidenceArtifact = {
      schemaVersion: 1,
      taskMode: validated.mode,
      scope: input.scope,
      sourceDigest: sourceManifest.digest,
      candidateDigest: candidateManifest.digest,
      agent: agentSummary,
      baseline: {
        target: baselineTarget.record,
        regression: baselineRegression.records,
        security: baselineSecurity.records,
      },
      final: {
        target: target.record,
        regression: regression.records,
        security: security.records,
      },
      changedPaths: difference.changedPaths,
      changedBytes: difference.changedBytes,
      review: reviewEvidence(agent, input.task, validated.mode, difference.changedPaths, [
        target.record,
        ...regression.records,
        ...security.records,
      ]),
    };
    const artifacts = writeArtifactPair(
      validated.candidateRoot,
      validated.evidenceRoot,
      input.scope.attemptId,
      manifestArtifact,
      evidenceArtifact,
      input.limits.maxEvidenceBytes,
    );
    createdArtifacts = artifacts;
    assertAttemptContinues(input);
    const candidateManifestSha256 = sha256(readFileSync(artifacts.candidateManifest));
    const evidenceSha256 = sha256(readFileSync(artifacts.evidence));
    const terminalOutcome = runtimeExecution
      ? {
          schemaVersion: 1,
          status: "succeeded" as const,
          candidateDigest: /^[a-f0-9]{64}$/.test(candidateManifest.digest)
            ? `sha256:${candidateManifest.digest}`
            : sha256(candidateManifest.digest),
          candidateManifestDigest: candidateManifestSha256,
          evidenceDigest: evidenceSha256,
          changedPathsDigest: sha256(canonicalJson(difference.changedPaths)),
        } as const
      : undefined;
    const finalizeTerminal = runtimeExecution && terminalOutcome
      ? (() => {
          const execution = runtimeExecution;
          const outcome = terminalOutcome;
          return async (): Promise<WardenRuntimeTerminalEvidence> =>
            await execution.finalize(outcome);
        })()
      : undefined;
    const result = freezeResult({
      status: "succeeded",
      summary: "Warden produced a source bound candidate that passed independent verification.",
      nextActions: Object.freeze(["Review and promote the verified candidate through the approval gate."]),
      changedPaths: Object.freeze([...difference.changedPaths]),
      agent: agentSummary,
      artifacts: Object.freeze({
        candidateWorkspace: workspace,
        candidateManifest: artifacts.candidateManifest,
        evidence: artifacts.evidence,
        sourceDigest: sourceManifest.digest,
        candidateDigest: candidateManifest.digest,
        candidateManifestSha256,
        evidenceSha256,
      }),
      ...(finalizeTerminal ? { finalizeTerminal } : {}),
    });
    workspace = undefined;
    createdArtifacts = undefined;
    return result;
  } catch (error) {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    if (createdArtifacts) {
      rmSync(createdArtifacts.candidateManifest, { force: true });
      rmSync(createdArtifacts.evidence, { force: true });
    }
    if (error instanceof AttemptError) {
      return reject(error.code, error.message, { sourceDigest, candidateDigest }, agentSummary);
    }
    const message = error instanceof Error ? error.message : "Unknown attempt engine failure.";
    return reject(
      "warden_attempt_internal_error",
      message,
      { sourceDigest, candidateDigest },
      agentSummary,
    );
  }
}
