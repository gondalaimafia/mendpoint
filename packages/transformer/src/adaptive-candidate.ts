import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  normalizeRecipeFileModes,
  recipeFilesDigest,
  type GitBlobMode,
  type RecipeFileModes,
  type RecipeFiles,
} from "./recipe.js";
import {
  MAX_ADAPTIVE_REVIEW_FILE_BYTES,
  MAX_ADAPTIVE_REVIEW_FILES,
  MAX_ADAPTIVE_REVIEW_TOTAL_BYTES,
  MAX_ADAPTIVE_SEAL_BYTES,
} from "./adaptive-review-limits.js";

/**
 * Durable, content-addressed seal for a Transformer *adaptive* candidate.
 *
 * When the bounded adaptive repair loop converges on a fix that DIVERGES from
 * the deterministic recipe output, that fix must not be auto-promoted. It is a
 * distinct "adaptive candidate" requiring explicit human sign-off. This module
 * materializes the converged file set into an immutable, content-addressed
 * artifact so the exact bytes a reviewer approved are the exact bytes promoted.
 *
 * Sealing parity with Warden (apps/api/src/warden-candidate.ts) is enforced
 * here rather than assumed: the artifact is built from validated in-memory
 * buffers (never re-read from a mutable workspace), its digest is reverified
 * byte-for-byte on read, and the write path is tenant-scoped with the same
 * ancestor/symlink containment walk. The converged output digest is recomputed
 * from the reconstructed files with the same `recipeFilesDigest` the loop used,
 * so a tampered seal fails closed.
 */

const TENANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const BRANCH = /^(?!\/)(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
const COMMIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SEALED_ARTIFACT_NAME = /^[a-f0-9]{64}\.json$/;

export type AdaptiveCandidateStorageQuota = Readonly<{
  maxArtifacts: number;
  maxBytes: number;
  maxScanEntries: number;
}>;

export const DEFAULT_ADAPTIVE_CANDIDATE_STORAGE_QUOTA: AdaptiveCandidateStorageQuota =
  Object.freeze({
    maxArtifacts: 256,
    maxBytes: 512 * 1024 * 1024,
    maxScanEntries: 512,
  });

const HARD_ADAPTIVE_CANDIDATE_STORAGE_QUOTA: AdaptiveCandidateStorageQuota = Object.freeze({
  maxArtifacts: 100_000,
  maxBytes: 100 * 1024 * 1024 * 1024,
  maxScanEntries: 100_000,
});

export type AdaptiveCandidateReconcileBounds = Readonly<{
  gracePeriodMs: number;
  maxScanEntries: number;
  maxRemovals: number;
  maxRemovalBytes: number;
}>;

export const DEFAULT_ADAPTIVE_CANDIDATE_RECONCILE_BOUNDS: AdaptiveCandidateReconcileBounds =
  Object.freeze({
    gracePeriodMs: 24 * 60 * 60 * 1_000,
    maxScanEntries: 512,
    maxRemovals: 64,
    maxRemovalBytes: 256 * 1024 * 1024,
  });

const HARD_ADAPTIVE_CANDIDATE_RECONCILE_BOUNDS: AdaptiveCandidateReconcileBounds = Object.freeze({
  gracePeriodMs: 365 * 24 * 60 * 60 * 1_000,
  maxScanEntries: 100_000,
  maxRemovals: 10_000,
  maxRemovalBytes: 100 * 1024 * 1024 * 1024,
});

export type AdaptiveCandidateSeal = Readonly<{
  path: string;
  sha256: string;
  created: boolean;
}>;

export type AdaptiveCandidateArtifact = Readonly<{
  schemaVersion: 5;
  kind: "adaptive";
  tenantId: string;
  campaignId: string;
  unitId: string;
  attemptId: string;
  repositoryId: string;
  snapshotId: string;
  baseBranch: string;
  expectedBaseRevision: string;
  /** Deterministic recipe candidate digest this adaptive candidate diverged from. */
  divergedFromDigest: string;
  /** Converged adaptive output digest (recipeFilesDigest of `files`). */
  candidateDigest: string;
  /** The failing objective verification that triggered adaptation. */
  failingCommandId: string | null;
  /** Complete source snapshot to final candidate delta. */
  changedPaths: readonly string[];
  /** Paths changed by adaptive repair relative to the deterministic recipe output. */
  adaptiveChangedPaths: readonly string[];
  files: RecipeFiles;
  fileModes: RecipeFileModes;
  review: AdaptiveCandidateReviewEvidence;
  reviewDigest: string;
}>;

export type AdaptiveSemanticCategory =
  | "behavior"
  | "tests"
  | "configuration"
  | "dependencies"
  | "security"
  | "documentation"
  | "other";

export type AdaptiveReviewRisk = "low" | "medium" | "high";

export type AdaptiveCandidateReviewEdit = Readonly<{
  path: string;
  changeType: "add" | "modify";
  /** Exact source snapshot content before the reviewed migration, null for a new file. */
  beforeContent: string | null;
  beforeDigest: string;
  beforeMode: GitBlobMode | null;
  /** Digest and mode of the exact after bytes held in artifact.files[path]. */
  afterDigest: string;
  afterMode: GitBlobMode;
  semanticCategory: AdaptiveSemanticCategory;
  rationale: string;
  risk: AdaptiveReviewRisk;
  /** Whole-number confidence percentage from 0 through 100. */
  confidence: number;
}>;

export type AdaptiveCandidateReviewEvidence = Readonly<{
  schemaVersion: 1;
  edits: readonly AdaptiveCandidateReviewEdit[];
  verification: Readonly<{
    passed: true;
    commandId: string;
    summary: string;
    /** Digest only: raw verifier output remains untrusted and is not persisted. */
    outputDigest: string;
  }>;
  overallRisk: AdaptiveReviewRisk;
  confidence: number;
}>;

export type SealAdaptiveCandidateInput = Readonly<{
  tenantId: string;
  campaignId: string;
  unitId: string;
  attemptId: string;
  repositoryId: string;
  snapshotId: string;
  baseBranch: string;
  expectedBaseRevision: string;
  divergedFromDigest: string;
  candidateDigest: string;
  failingCommandId: string | null;
  changedPaths: readonly string[];
  adaptiveChangedPaths?: readonly string[];
  files: RecipeFiles;
  fileModes: RecipeFileModes;
  review: AdaptiveCandidateReviewEvidence;
  quota?: Partial<AdaptiveCandidateStorageQuota>;
  env?: NodeJS.ProcessEnv;
}>;

export type ReadAdaptiveCandidateInput = Readonly<{
  tenantId: string;
  path: string;
  sha256: string;
  env?: NodeJS.ProcessEnv;
}>;

export type DiscardAdaptiveCandidateInput = ReadAdaptiveCandidateInput;

export type ReconcileAdaptiveCandidateArtifactsInput = Readonly<{
  /** Required acknowledgement that this runs with all candidate writers stopped. */
  offlineMaintenance: true;
  tenantId: string;
  /** Exact absolute seal paths currently referenced by durable state. */
  referencedSealedPaths: readonly string[];
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  bounds?: Partial<AdaptiveCandidateReconcileBounds>;
}>;

export type AdaptiveCandidateReconcileError = Readonly<{
  path: string;
  code: string;
}>;

export type AdaptiveCandidateReconcileResult = Readonly<{
  scannedArtifacts: number;
  scannedBytes: number;
  referencedArtifacts: number;
  referencedBytes: number;
  orphanArtifacts: number;
  orphanBytes: number;
  graceRetainedArtifacts: number;
  graceRetainedBytes: number;
  limitRetainedArtifacts: number;
  limitRetainedBytes: number;
  removedArtifacts: number;
  removedBytes: number;
  missingReferencedArtifacts: number;
  scanLimitReached: boolean;
  errors: readonly AdaptiveCandidateReconcileError[];
}>;

export type PromotedAdaptiveCandidate = Readonly<{
  files: RecipeFiles;
  fileModes: RecipeFileModes;
  repositoryId: string;
  snapshotId: string;
  expectedBaseRevision: string;
  candidateDigest: string;
  divergedFromDigest: string;
  failingCommandId: string | null;
  changedPaths: readonly string[];
}>;

function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function isStrictlyWithin(root: string, candidate: string): boolean {
  return candidate !== root && isWithin(root, candidate);
}

function realDirectory(path: string, code: string): string {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error(code);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(code);
  return realpathSync(path);
}

function assertNoSymlinkPath(root: string, target: string): void {
  const value = relative(root, target);
  if (!value || value.startsWith(`..${sep}`) || value === ".." || isAbsolute(value)) {
    throw new Error("adaptive_candidate_path_escape");
  }
  let current = root;
  for (const part of value.split(sep)) {
    current = join(current, part);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("adaptive_candidate_symlink_path");
    }
  }
}

function dataRootFrom(env: NodeJS.ProcessEnv): string {
  const value = env.MENDPOINT_DATA_DIR?.trim();
  if (!value || !isAbsolute(value)) throw new Error("adaptive_candidate_data_root_required");
  return realDirectory(value, "adaptive_candidate_data_root_invalid");
}

function ensureTenantRoot(dataRoot: string, tenantId: string): string {
  const nominal = join(dataRoot, "transformer-adaptive-candidates", tenantId);
  assertNoSymlinkPath(dataRoot, nominal);
  mkdirSync(nominal, { recursive: true, mode: 0o700 });
  const resolved = realDirectory(nominal, "adaptive_candidate_tenant_root_invalid");
  if (!isStrictlyWithin(dataRoot, resolved)) {
    throw new Error("adaptive_candidate_tenant_root_escape");
  }
  return resolved;
}

function resolveTenantRoot(dataRoot: string, tenantId: string): string {
  const nominal = join(dataRoot, "transformer-adaptive-candidates", tenantId);
  assertNoSymlinkPath(dataRoot, nominal);
  const resolved = realDirectory(nominal, "adaptive_candidate_tenant_root_invalid");
  if (!isStrictlyWithin(dataRoot, resolved)) {
    throw new Error("adaptive_candidate_tenant_root_escape");
  }
  return resolved;
}

function assertTenant(tenantId: string): void {
  if (!TENANT.test(tenantId)) throw new Error("adaptive_candidate_tenant_invalid");
}

function assertIdentifier(value: string, code: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new Error(code);
}

function normalizedChangedPaths(files: RecipeFiles, changedPaths: readonly string[]): string[] {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0 || changedPaths.length > MAX_ADAPTIVE_REVIEW_FILES) {
    throw new Error("adaptive_candidate_changed_paths_invalid");
  }
  const seen = new Set<string>();
  for (const path of changedPaths) {
    if (typeof path !== "string" || !path || files[path] === undefined) {
      throw new Error("adaptive_candidate_changed_paths_invalid");
    }
    if (seen.has(path)) throw new Error("adaptive_candidate_changed_paths_duplicate");
    seen.add(path);
  }
  return [...changedPaths].sort();
}

function encodeFiles(files: RecipeFiles): Record<string, string> {
  const entries = Object.entries(files);
  if (!entries.length || entries.length > MAX_ADAPTIVE_REVIEW_FILES) {
    throw new Error("adaptive_candidate_files_invalid");
  }
  let total = 0;
  const encoded: Record<string, string> = {};
  for (const [path, content] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof content !== "string") throw new Error("adaptive_candidate_file_content_invalid");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_ADAPTIVE_REVIEW_FILE_BYTES) {
      throw new Error("adaptive_candidate_file_too_large");
    }
    total += bytes;
    if (total > MAX_ADAPTIVE_REVIEW_TOTAL_BYTES) throw new Error("adaptive_candidate_too_large");
    encoded[path] = Buffer.from(content, "utf8").toString("base64");
  }
  return encoded;
}

function decodeFiles(value: unknown): RecipeFiles {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("adaptive_candidate_files_invalid");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length || entries.length > MAX_ADAPTIVE_REVIEW_FILES) {
    throw new Error("adaptive_candidate_files_invalid");
  }
  let total = 0;
  const files: Record<string, string> = {};
  for (const [path, encoded] of entries) {
    if (typeof path !== "string" || !path || typeof encoded !== "string") {
      throw new Error("adaptive_candidate_files_invalid");
    }
    if (
      encoded.length % 4 !== 0 ||
      encoded.length > 4 * Math.ceil(MAX_ADAPTIVE_REVIEW_FILE_BYTES / 3) + 4
    ) {
      throw new Error("adaptive_candidate_files_invalid");
    }
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) {
      throw new Error("adaptive_candidate_files_invalid");
    }
    const content = decoded.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(decoded)) {
      throw new Error("adaptive_candidate_file_encoding_invalid");
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_ADAPTIVE_REVIEW_FILE_BYTES) {
      throw new Error("adaptive_candidate_file_too_large");
    }
    total += bytes;
    if (total > MAX_ADAPTIVE_REVIEW_TOTAL_BYTES) throw new Error("adaptive_candidate_too_large");
    files[path] = content;
  }
  return Object.freeze(files);
}

const SEMANTIC_CATEGORIES = new Set<AdaptiveSemanticCategory>([
  "behavior",
  "tests",
  "configuration",
  "dependencies",
  "security",
  "documentation",
  "other",
]);
const REVIEW_RISKS = new Set<AdaptiveReviewRisk>(["low", "medium", "high"]);

function contentDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function boundedReviewText(value: unknown, maximumBytes: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(code);
  }
  return value;
}

function reviewConfidence(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 100) {
    throw new Error("adaptive_candidate_review_confidence_invalid");
  }
  return value as number;
}

function normalizeReviewEvidence(
  value: unknown,
  changedPaths: readonly string[],
  files: RecipeFiles,
  fileModes: RecipeFileModes,
): AdaptiveCandidateReviewEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("adaptive_candidate_review_evidence_missing");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.edits)) {
    throw new Error("adaptive_candidate_review_evidence_invalid");
  }
  if (record.edits.length !== changedPaths.length || record.edits.length > MAX_ADAPTIVE_REVIEW_FILES) {
    throw new Error("adaptive_candidate_review_paths_mismatch");
  }
  const normalizedEdits: AdaptiveCandidateReviewEdit[] = [];
  const seen = new Set<string>();
  let beforeBytes = 0;
  for (const raw of record.edits) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("adaptive_candidate_review_edit_invalid");
    }
    const edit = raw as Record<string, unknown>;
    if (typeof edit.path !== "string" || !changedPaths.includes(edit.path) || seen.has(edit.path)) {
      throw new Error("adaptive_candidate_review_paths_mismatch");
    }
    seen.add(edit.path);
    const afterContent = files[edit.path];
    const afterMode = fileModes[edit.path];
    if (afterContent === undefined || (afterMode !== "100644" && afterMode !== "100755")) {
      throw new Error("adaptive_candidate_review_after_invalid");
    }
    if (edit.afterDigest !== contentDigest(afterContent)) {
      throw new Error("adaptive_candidate_review_after_digest_mismatch");
    }
    if (edit.afterMode !== afterMode) {
      throw new Error("adaptive_candidate_review_after_mode_mismatch");
    }
    const beforeContent = edit.beforeContent;
    if (beforeContent !== null && typeof beforeContent !== "string") {
      throw new Error("adaptive_candidate_review_before_content_invalid");
    }
    if (edit.beforeDigest !== contentDigest(beforeContent ?? "")) {
      throw new Error("adaptive_candidate_review_before_digest_mismatch");
    }
    if (beforeContent === null) {
      if (edit.changeType !== "add" || edit.beforeMode !== null) {
        throw new Error("adaptive_candidate_review_before_mode_invalid");
      }
    } else {
      if (
        edit.changeType !== "modify" ||
        (edit.beforeMode !== "100644" && edit.beforeMode !== "100755") ||
        edit.beforeMode !== edit.afterMode ||
        beforeContent === afterContent
      ) {
        throw new Error("adaptive_candidate_review_before_mode_invalid");
      }
      const bytes = Buffer.byteLength(beforeContent, "utf8");
      if (bytes > MAX_ADAPTIVE_REVIEW_FILE_BYTES) {
        throw new Error("adaptive_candidate_review_before_file_too_large");
      }
      beforeBytes += bytes;
      if (beforeBytes > MAX_ADAPTIVE_REVIEW_TOTAL_BYTES) {
        throw new Error("adaptive_candidate_review_before_too_large");
      }
    }
    if (typeof edit.semanticCategory !== "string" || !SEMANTIC_CATEGORIES.has(edit.semanticCategory as AdaptiveSemanticCategory)) {
      throw new Error("adaptive_candidate_review_category_invalid");
    }
    if (typeof edit.risk !== "string" || !REVIEW_RISKS.has(edit.risk as AdaptiveReviewRisk)) {
      throw new Error("adaptive_candidate_review_risk_invalid");
    }
    normalizedEdits.push(Object.freeze({
      path: edit.path,
      changeType: edit.changeType as "add" | "modify",
      beforeContent,
      beforeDigest: edit.beforeDigest as string,
      beforeMode: edit.beforeMode as GitBlobMode | null,
      afterDigest: edit.afterDigest as string,
      afterMode: edit.afterMode as GitBlobMode,
      semanticCategory: edit.semanticCategory as AdaptiveSemanticCategory,
      rationale: boundedReviewText(edit.rationale, 2_000, "adaptive_candidate_review_rationale_invalid"),
      risk: edit.risk as AdaptiveReviewRisk,
      confidence: reviewConfidence(edit.confidence),
    }));
  }
  if (changedPaths.some((path) => !seen.has(path))) {
    throw new Error("adaptive_candidate_review_paths_mismatch");
  }
  const verification = record.verification;
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
    throw new Error("adaptive_candidate_review_verification_invalid");
  }
  const verified = verification as Record<string, unknown>;
  if (verified.passed !== true || typeof verified.outputDigest !== "string" || !DIGEST.test(verified.outputDigest)) {
    throw new Error("adaptive_candidate_review_verification_invalid");
  }
  if (typeof record.overallRisk !== "string" || !REVIEW_RISKS.has(record.overallRisk as AdaptiveReviewRisk)) {
    throw new Error("adaptive_candidate_review_risk_invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    edits: Object.freeze(normalizedEdits.sort((left, right) => left.path.localeCompare(right.path))),
    verification: Object.freeze({
      passed: true,
      commandId: boundedReviewText(verified.commandId, 256, "adaptive_candidate_review_verification_invalid"),
      summary: boundedReviewText(verified.summary, 2_000, "adaptive_candidate_review_verification_invalid"),
      outputDigest: verified.outputDigest,
    }),
    overallRisk: record.overallRisk as AdaptiveReviewRisk,
    confidence: reviewConfidence(record.confidence),
  });
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

function serializeArtifact(artifact: AdaptiveCandidateArtifact): Buffer {
  return Buffer.from(JSON.stringify(stableValue(artifact)), "utf8");
}

function reviewDigest(review: AdaptiveCandidateReviewEvidence): string {
  return contentDigest(JSON.stringify(stableValue(review)));
}

function assertPositiveBound(value: number, maximum: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(code);
}

function resolveStorageQuota(
  quota: Partial<AdaptiveCandidateStorageQuota> | undefined,
): AdaptiveCandidateStorageQuota {
  const resolved = { ...DEFAULT_ADAPTIVE_CANDIDATE_STORAGE_QUOTA, ...quota };
  assertPositiveBound(
    resolved.maxArtifacts,
    HARD_ADAPTIVE_CANDIDATE_STORAGE_QUOTA.maxArtifacts,
    "adaptive_candidate_quota_artifacts_invalid",
  );
  assertPositiveBound(
    resolved.maxBytes,
    HARD_ADAPTIVE_CANDIDATE_STORAGE_QUOTA.maxBytes,
    "adaptive_candidate_quota_bytes_invalid",
  );
  assertPositiveBound(
    resolved.maxScanEntries,
    HARD_ADAPTIVE_CANDIDATE_STORAGE_QUOTA.maxScanEntries,
    "adaptive_candidate_quota_scan_invalid",
  );
  return Object.freeze(resolved);
}

function resolveReconcileBounds(
  bounds: Partial<AdaptiveCandidateReconcileBounds> | undefined,
): AdaptiveCandidateReconcileBounds {
  const resolved = { ...DEFAULT_ADAPTIVE_CANDIDATE_RECONCILE_BOUNDS, ...bounds };
  if (
    !Number.isSafeInteger(resolved.gracePeriodMs) ||
    resolved.gracePeriodMs < 0 ||
    resolved.gracePeriodMs > HARD_ADAPTIVE_CANDIDATE_RECONCILE_BOUNDS.gracePeriodMs
  ) {
    throw new Error("adaptive_candidate_reconcile_grace_invalid");
  }
  assertPositiveBound(
    resolved.maxScanEntries,
    HARD_ADAPTIVE_CANDIDATE_RECONCILE_BOUNDS.maxScanEntries,
    "adaptive_candidate_reconcile_scan_invalid",
  );
  assertPositiveBound(
    resolved.maxRemovals,
    HARD_ADAPTIVE_CANDIDATE_RECONCILE_BOUNDS.maxRemovals,
    "adaptive_candidate_reconcile_removals_invalid",
  );
  assertPositiveBound(
    resolved.maxRemovalBytes,
    HARD_ADAPTIVE_CANDIDATE_RECONCILE_BOUNDS.maxRemovalBytes,
    "adaptive_candidate_reconcile_bytes_invalid",
  );
  return Object.freeze(resolved);
}

function enforceTenantStorageQuota(
  approvalsDir: string,
  prospectiveBytes: number,
  quotaInput: Partial<AdaptiveCandidateStorageQuota> | undefined,
): void {
  const quota = resolveStorageQuota(quotaInput);
  let artifacts = 0;
  let bytes = 0;
  let scanned = 0;
  const directory = opendirSync(approvalsDir);
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      scanned += 1;
      if (scanned > quota.maxScanEntries) {
        throw new Error("adaptive_candidate_quota_scan_exceeded");
      }
      const path = join(approvalsDir, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error("adaptive_candidate_quota_scan_unsafe");
      }
      artifacts += 1;
      bytes += info.size;
      if (artifacts + 1 > quota.maxArtifacts) {
        throw new Error("adaptive_candidate_quota_count_exceeded");
      }
      if (bytes + prospectiveBytes > quota.maxBytes) {
        throw new Error("adaptive_candidate_quota_bytes_exceeded");
      }
    }
  } finally {
    directory.closeSync();
  }
  if (artifacts + 1 > quota.maxArtifacts) {
    throw new Error("adaptive_candidate_quota_count_exceeded");
  }
  if (bytes + prospectiveBytes > quota.maxBytes) {
    throw new Error("adaptive_candidate_quota_bytes_exceeded");
  }
}

function exactReferencedSealPaths(
  approvalsDir: string,
  paths: readonly string[],
  maxPaths: number,
): Set<string> {
  if (!Array.isArray(paths) || paths.length > maxPaths) {
    throw new Error("adaptive_candidate_reconcile_references_invalid");
  }
  const exact = new Set<string>();
  for (const value of paths) {
    if (typeof value !== "string" || !isAbsolute(value)) {
      throw new Error("adaptive_candidate_reconcile_reference_invalid");
    }
    const path = resolve(value);
    const child = relative(approvalsDir, path);
    if (
      !child ||
      child.startsWith(`..${sep}`) ||
      child === ".." ||
      isAbsolute(child) ||
      child.includes(sep) ||
      !SEALED_ARTIFACT_NAME.test(child)
    ) {
      throw new Error("adaptive_candidate_reconcile_reference_invalid");
    }
    exact.add(path);
  }
  return exact;
}

/**
 * Materialize the converged adaptive file set into an immutable,
 * content-addressed seal. The write refuses to clobber an existing seal: if one
 * is already present with identical bytes it belongs to a concurrent seal of the
 * same converged output (success); different bytes are a conflict (fail closed).
 */
export function sealAdaptiveCandidate(input: SealAdaptiveCandidateInput): AdaptiveCandidateSeal {
  assertTenant(input.tenantId);
  assertIdentifier(input.campaignId, "adaptive_candidate_campaign_invalid");
  assertIdentifier(input.unitId, "adaptive_candidate_unit_invalid");
  assertIdentifier(input.attemptId, "adaptive_candidate_attempt_invalid");
  assertIdentifier(input.repositoryId, "adaptive_candidate_repository_invalid");
  assertIdentifier(input.snapshotId, "adaptive_candidate_snapshot_invalid");
  if (!BRANCH.test(input.baseBranch) || input.baseBranch.endsWith("/") || input.baseBranch.endsWith(".lock")) {
    throw new Error("adaptive_candidate_base_branch_invalid");
  }
  if (!COMMIT_REVISION.test(input.expectedBaseRevision)) {
    throw new Error("adaptive_candidate_expected_base_invalid");
  }
  if (!DIGEST.test(input.divergedFromDigest)) {
    throw new Error("adaptive_candidate_diverged_digest_invalid");
  }
  if (!DIGEST.test(input.candidateDigest)) {
    throw new Error("adaptive_candidate_candidate_digest_invalid");
  }
  // The candidate must genuinely diverge from the deterministic recipe output;
  // a matching digest is not an adaptive candidate and must never be sealed here.
  if (input.divergedFromDigest === input.candidateDigest) {
    throw new Error("adaptive_candidate_not_divergent");
  }
  // Reverify the converged digest from the in-memory buffers before sealing so a
  // mislabeled file set cannot be written under a digest it does not match.
  if (recipeFilesDigest(input.files) !== input.candidateDigest) {
    throw new Error("adaptive_candidate_digest_mismatch");
  }
  if (
    input.failingCommandId !== null &&
    (typeof input.failingCommandId !== "string" || input.failingCommandId.length > 256)
  ) {
    throw new Error("adaptive_candidate_failing_command_invalid");
  }
  const changedPaths = normalizedChangedPaths(input.files, input.changedPaths);
  const files = encodeFiles(input.files);
  const fileModes = normalizeRecipeFileModes(input.files, input.fileModes);
  const review = normalizeReviewEvidence(input.review, changedPaths, input.files, fileModes);
  const adaptiveChangedPaths = normalizedChangedPaths(
    input.files,
    input.adaptiveChangedPaths ?? input.review.edits.map((edit) => edit.path),
  );
  const env = input.env ?? process.env;
  const dataRoot = dataRootFrom(env);
  const tenantRoot = ensureTenantRoot(dataRoot, input.tenantId);
  const approvalsDir = join(tenantRoot, "approvals");
  mkdirSync(approvalsDir, { recursive: true, mode: 0o700 });
  assertNoSymlinkPath(tenantRoot, approvalsDir);
  if (!isStrictlyWithin(tenantRoot, realpathSync(approvalsDir))) {
    throw new Error("adaptive_candidate_approval_escape");
  }
  const artifact: AdaptiveCandidateArtifact = {
    schemaVersion: 5,
    kind: "adaptive",
    tenantId: input.tenantId,
    campaignId: input.campaignId,
    unitId: input.unitId,
    attemptId: input.attemptId,
    repositoryId: input.repositoryId,
    snapshotId: input.snapshotId,
    baseBranch: input.baseBranch,
    expectedBaseRevision: input.expectedBaseRevision,
    divergedFromDigest: input.divergedFromDigest,
    candidateDigest: input.candidateDigest,
    failingCommandId: input.failingCommandId,
    changedPaths,
    adaptiveChangedPaths,
    files: files as RecipeFiles,
    fileModes,
    review,
    reviewDigest: reviewDigest(review),
  };
  const serialized = serializeArtifact(artifact);
  if (serialized.byteLength > MAX_ADAPTIVE_SEAL_BYTES) {
    throw new Error("adaptive_candidate_too_large");
  }
  const hex = createHash("sha256").update(serialized).digest("hex");
  const artifactPath = join(approvalsDir, `${hex}.json`);
  assertNoSymlinkPath(tenantRoot, artifactPath);
  if (existsSync(artifactPath)) {
    const info = lstatSync(artifactPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("adaptive_candidate_seal_conflict");
    }
    const existing = readFileSync(artifactPath);
    if (!existing.equals(serialized)) {
      throw new Error("adaptive_candidate_seal_conflict");
    }
    return Object.freeze({ path: artifactPath, sha256: `sha256:${hex}`, created: false });
  }
  enforceTenantStorageQuota(approvalsDir, serialized.byteLength, input.quota);
  let created = true;
  try {
    writeFileSync(artifactPath, serialized, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    created = false;
    const existing = readFileSync(artifactPath);
    if (!existing.equals(serialized)) {
      throw new Error("adaptive_candidate_seal_conflict");
    }
  }
  return Object.freeze({ path: artifactPath, sha256: `sha256:${hex}`, created });
}

/**
 * Read a sealed adaptive candidate, reverifying its digest byte-for-byte and its
 * converged output digest from the reconstructed files. Any corruption, tamper,
 * tenant mismatch, or digest drift fails closed.
 */
export function readAdaptiveCandidateArtifact(
  input: ReadAdaptiveCandidateInput,
): AdaptiveCandidateArtifact {
  assertTenant(input.tenantId);
  if (!DIGEST.test(input.sha256)) throw new Error("adaptive_candidate_sha256_invalid");
  const env = input.env ?? process.env;
  const dataRoot = dataRootFrom(env);
  const tenantRoot = resolveTenantRoot(dataRoot, input.tenantId);
  const approvalsDir = join(tenantRoot, "approvals");
  const path = resolve(input.path);
  if (!isStrictlyWithin(approvalsDir, path)) throw new Error("adaptive_candidate_approval_escape");
  assertNoSymlinkPath(tenantRoot, path);
  if (!existsSync(path)) throw new Error("adaptive_candidate_seal_missing");
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_ADAPTIVE_SEAL_BYTES) {
    throw new Error("adaptive_candidate_seal_invalid");
  }
  if (!isStrictlyWithin(approvalsDir, realpathSync(path))) {
    throw new Error("adaptive_candidate_approval_escape");
  }
  const bytes = readFileSync(path);
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== input.sha256) {
    throw new Error("adaptive_candidate_seal_digest_mismatch");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("adaptive_candidate_seal_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("adaptive_candidate_seal_invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion === 3) {
    throw new Error("adaptive_candidate_file_modes_missing");
  }
  if (record.schemaVersion === 4) {
    throw new Error("adaptive_candidate_review_evidence_missing");
  }
  if (
    record.schemaVersion !== 5 ||
    record.kind !== "adaptive" ||
    record.tenantId !== input.tenantId ||
    typeof record.campaignId !== "string" ||
    typeof record.unitId !== "string" ||
    typeof record.attemptId !== "string" ||
    typeof record.repositoryId !== "string" ||
    typeof record.snapshotId !== "string" ||
    typeof record.baseBranch !== "string" ||
    !BRANCH.test(record.baseBranch) ||
    record.baseBranch.endsWith("/") ||
    record.baseBranch.endsWith(".lock") ||
    typeof record.expectedBaseRevision !== "string" ||
    !COMMIT_REVISION.test(record.expectedBaseRevision) ||
    typeof record.divergedFromDigest !== "string" ||
    typeof record.candidateDigest !== "string" ||
    !DIGEST.test(record.divergedFromDigest) ||
    !DIGEST.test(record.candidateDigest) ||
    record.divergedFromDigest === record.candidateDigest ||
    (record.failingCommandId !== null && typeof record.failingCommandId !== "string") ||
    !Array.isArray(record.changedPaths) ||
    !Array.isArray(record.adaptiveChangedPaths)
  ) {
    throw new Error("adaptive_candidate_seal_invalid");
  }
  const files = decodeFiles(record.files);
  let fileModes: RecipeFileModes;
  try {
    fileModes = normalizeRecipeFileModes(files, record.fileModes as RecipeFileModes);
  } catch {
    throw new Error("adaptive_candidate_file_modes_invalid");
  }
  // Reverify the converged output digest from the reconstructed files: a seal
  // whose files were tampered with cannot survive this check.
  if (recipeFilesDigest(files) !== record.candidateDigest) {
    throw new Error("adaptive_candidate_seal_digest_mismatch");
  }
  assertIdentifier(record.campaignId, "adaptive_candidate_seal_invalid");
  assertIdentifier(record.unitId, "adaptive_candidate_seal_invalid");
  assertIdentifier(record.attemptId, "adaptive_candidate_seal_invalid");
  assertIdentifier(record.repositoryId, "adaptive_candidate_seal_invalid");
  assertIdentifier(record.snapshotId, "adaptive_candidate_seal_invalid");
  if (record.changedPaths.some((path) => typeof path !== "string")) {
    throw new Error("adaptive_candidate_seal_invalid");
  }
  const changedPaths = normalizedChangedPaths(files, record.changedPaths as string[]);
  const adaptiveChangedPaths = normalizedChangedPaths(
    files,
    record.adaptiveChangedPaths as string[],
  );
  const review = normalizeReviewEvidence(record.review, changedPaths, files, fileModes);
  if (typeof record.reviewDigest !== "string" || record.reviewDigest !== reviewDigest(review)) {
    throw new Error("adaptive_candidate_review_digest_mismatch");
  }
  return Object.freeze({
    schemaVersion: 5,
    kind: "adaptive",
    tenantId: input.tenantId,
    campaignId: record.campaignId,
    unitId: record.unitId,
    attemptId: record.attemptId,
    repositoryId: record.repositoryId,
    snapshotId: record.snapshotId,
    baseBranch: record.baseBranch,
    expectedBaseRevision: record.expectedBaseRevision,
    divergedFromDigest: record.divergedFromDigest,
    candidateDigest: record.candidateDigest,
    failingCommandId: (record.failingCommandId as string | null) ?? null,
    changedPaths: Object.freeze(changedPaths),
    adaptiveChangedPaths: Object.freeze(adaptiveChangedPaths),
    files,
    fileModes,
    review,
    reviewDigest: record.reviewDigest,
  });
}

/**
 * Promote an approved adaptive candidate by reading ONLY the sealed artifact and
 * reverifying its digest. The returned files are the exact bytes that were
 * sealed; a mutable workspace is never consulted.
 */
export function promoteAdaptiveCandidateFiles(
  input: ReadAdaptiveCandidateInput,
): PromotedAdaptiveCandidate {
  const artifact = readAdaptiveCandidateArtifact(input);
  return Object.freeze({
    files: artifact.files,
    fileModes: artifact.fileModes,
    repositoryId: artifact.repositoryId,
    snapshotId: artifact.snapshotId,
    baseBranch: artifact.baseBranch,
    expectedBaseRevision: artifact.expectedBaseRevision,
    candidateDigest: artifact.candidateDigest,
    divergedFromDigest: artifact.divergedFromDigest,
    failingCommandId: artifact.failingCommandId,
    changedPaths: artifact.changedPaths,
  });
}

/**
 * Offline-only repair operation that removes unreferenced, grace-expired seal
 * files from one tenant's approval directory. All candidate writers must be
 * stopped before the durable reference snapshot is taken. Live maintenance
 * must delete only exact terminal records because a concurrent writer can make
 * an old content-addressed seal referenced after a reference snapshot.
 *
 * The scan is shallow and bounded, links and directories are reported but
 * never followed or removed, and the approvals directory itself is never a
 * deletion target.
 */
export function reconcileAdaptiveCandidateArtifacts(
  input: ReconcileAdaptiveCandidateArtifactsInput,
): AdaptiveCandidateReconcileResult {
  if (input.offlineMaintenance !== true) {
    throw new Error("adaptive_candidate_reconcile_offline_acknowledgement_required");
  }
  assertTenant(input.tenantId);
  const bounds = resolveReconcileBounds(input.bounds);
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("adaptive_candidate_reconcile_now_invalid");
  }
  const env = input.env ?? process.env;
  const dataRoot = dataRootFrom(env);
  const tenantRoot = resolveTenantRoot(dataRoot, input.tenantId);
  const approvalsDir = join(tenantRoot, "approvals");
  const resolvedApprovalsDir = realDirectory(
    approvalsDir,
    "adaptive_candidate_approval_directory_invalid",
  );
  if (!isStrictlyWithin(tenantRoot, resolvedApprovalsDir)) {
    throw new Error("adaptive_candidate_approval_escape");
  }
  const referenced = exactReferencedSealPaths(
    resolvedApprovalsDir,
    input.referencedSealedPaths,
    bounds.maxScanEntries,
  );
  const seenReferences = new Set<string>();
  const errors: AdaptiveCandidateReconcileError[] = [];
  let entriesInspected = 0;
  let scannedArtifacts = 0;
  let scannedBytes = 0;
  let referencedArtifacts = 0;
  let referencedBytes = 0;
  let orphanArtifacts = 0;
  let orphanBytes = 0;
  let graceRetainedArtifacts = 0;
  let graceRetainedBytes = 0;
  let limitRetainedArtifacts = 0;
  let limitRetainedBytes = 0;
  let removedArtifacts = 0;
  let removedBytes = 0;
  let scanLimitReached = false;

  const directory = opendirSync(resolvedApprovalsDir);
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      entriesInspected += 1;
      if (entriesInspected > bounds.maxScanEntries) {
        scanLimitReached = true;
        errors.push(Object.freeze({
          path: resolvedApprovalsDir,
          code: "adaptive_candidate_reconcile_scan_limit",
        }));
        break;
      }
      const path = join(resolvedApprovalsDir, entry.name);
      if (referenced.has(path)) seenReferences.add(path);
      let info;
      try {
        info = lstatSync(path);
      } catch {
        errors.push(Object.freeze({ path, code: "adaptive_candidate_reconcile_lstat_failed" }));
        continue;
      }
      if (info.isSymbolicLink()) {
        errors.push(Object.freeze({ path, code: "adaptive_candidate_reconcile_symlink" }));
        continue;
      }
      if (!info.isFile() || !SEALED_ARTIFACT_NAME.test(entry.name)) {
        errors.push(Object.freeze({ path, code: "adaptive_candidate_reconcile_unknown_entry" }));
        continue;
      }

      scannedArtifacts += 1;
      scannedBytes += info.size;
      if (referenced.has(path)) {
        referencedArtifacts += 1;
        referencedBytes += info.size;
        continue;
      }

      orphanArtifacts += 1;
      orphanBytes += info.size;
      if (nowMs - info.mtimeMs < bounds.gracePeriodMs) {
        graceRetainedArtifacts += 1;
        graceRetainedBytes += info.size;
        continue;
      }
      if (
        removedArtifacts >= bounds.maxRemovals ||
        removedBytes + info.size > bounds.maxRemovalBytes
      ) {
        limitRetainedArtifacts += 1;
        limitRetainedBytes += info.size;
        continue;
      }

      try {
        const current = lstatSync(path);
        if (
          current.isSymbolicLink() ||
          !current.isFile() ||
          current.size !== info.size ||
          current.mtimeMs !== info.mtimeMs
        ) {
          errors.push(Object.freeze({ path, code: "adaptive_candidate_reconcile_entry_changed" }));
          continue;
        }
        // unlink removes only this direct directory entry. It does not recurse,
        // cannot remove the approvals directory, and does not follow links.
        unlinkSync(path);
        removedArtifacts += 1;
        removedBytes += info.size;
      } catch {
        errors.push(Object.freeze({ path, code: "adaptive_candidate_reconcile_remove_failed" }));
      }
    }
  } finally {
    directory.closeSync();
  }

  if (!scanLimitReached) {
    for (const path of referenced) {
      if (!seenReferences.has(path)) {
        errors.push(Object.freeze({ path, code: "adaptive_candidate_reconcile_reference_missing" }));
      }
    }
  }
  const missingReferencedArtifacts = errors.filter(
    (error) => error.code === "adaptive_candidate_reconcile_reference_missing",
  ).length;
  return Object.freeze({
    scannedArtifacts,
    scannedBytes,
    referencedArtifacts,
    referencedBytes,
    orphanArtifacts,
    orphanBytes,
    graceRetainedArtifacts,
    graceRetainedBytes,
    limitRetainedArtifacts,
    limitRetainedBytes,
    removedArtifacts,
    removedBytes,
    missingReferencedArtifacts,
    scanLimitReached,
    errors: Object.freeze(errors),
  });
}

/**
 * Remove a sealed adaptive candidate artifact (rejection cleanup). Containment is
 * revalidated before deletion so a caller-supplied path can never escape the
 * tenant's approvals directory.
 */
export function discardAdaptiveCandidate(input: DiscardAdaptiveCandidateInput): boolean {
  assertTenant(input.tenantId);
  if (!DIGEST.test(input.sha256)) throw new Error("adaptive_candidate_sha256_invalid");
  const env = input.env ?? process.env;
  const dataRoot = dataRootFrom(env);
  const tenantRoot = resolveTenantRoot(dataRoot, input.tenantId);
  const approvalsDir = join(tenantRoot, "approvals");
  const path = resolve(input.path);
  if (!isStrictlyWithin(approvalsDir, path)) throw new Error("adaptive_candidate_approval_escape");
  assertNoSymlinkPath(tenantRoot, path);
  const existed = existsSync(path);
  if (existed) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("adaptive_candidate_seal_invalid");
    if (!isStrictlyWithin(approvalsDir, realpathSync(path))) {
      throw new Error("adaptive_candidate_approval_escape");
    }
  }
  rmSync(path, { force: true });
  return existed;
}
