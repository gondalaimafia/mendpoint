import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  parseFettlerProviderChangeEvidence,
  readWardenApprovalArtifact as readSharedWardenApprovalArtifact,
  WARDEN_CANDIDATE_REVIEW_LIMITS,
} from "@mendpoint/agent";
import {
  CandidateReviewEvidenceSchema,
  type CandidateReviewEvidence,
} from "@mendpoint/shared";

export type WardenCandidateFile = Readonly<{
  path: string;
  before: string | null;
  after: string | null;
  beforeSha256: string | null;
  afterSha256: string | null;
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

function safeRelativePath(path: unknown): string {
  if (
    typeof path !== "string" ||
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("warden_candidate_path_invalid");
  }
  return path;
}

function assertNoSymlinkPath(root: string, target: string): void {
  const value = relative(root, target);
  if (!value || value.startsWith(`..${sep}`) || value === ".." || isAbsolute(value)) {
    throw new Error("warden_candidate_path_escape");
  }
  let current = root;
  for (const part of value.split(sep)) {
    current = join(current, part);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("warden_candidate_symlink_path");
    }
  }
}

function resolveTenantRoot(
  dataRoot: string,
  segment: string,
  tenantId: string,
  code: string,
): string {
  const nominal = join(dataRoot, segment, tenantId);
  assertNoSymlinkPath(dataRoot, nominal);
  const resolved = realDirectory(nominal, code);
  if (!isStrictlyWithin(dataRoot, resolved)) {
    throw new Error("warden_candidate_tenant_root_escape");
  }
  return resolved;
}

function candidateResult(resultJson: string | null): Record<string, unknown> {
  if (!resultJson) throw new Error("warden_candidate_artifact_missing");
  try {
    const parsed = JSON.parse(resultJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("warden_candidate_result_invalid");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === "warden_candidate_result_invalid") throw error;
    throw new Error("warden_candidate_result_invalid");
  }
}

export function parseWardenCandidateReviewResult(
  resultJson: string | null,
): Record<string, unknown> {
  return candidateResult(resultJson);
}

function candidateExpiry(result: Record<string, unknown>, nowMs: number, allowExpired = false): string {
  const retention = result.retention && typeof result.retention === "object"
    ? (result.retention as Record<string, unknown>)
    : null;
  const expiresAt = typeof retention?.expiresAt === "string" ? retention.expiresAt : "";
  const expiresMs = Date.parse(expiresAt);
  if (!expiresAt || !Number.isFinite(expiresMs)) throw new Error("warden_candidate_expiry_invalid");
  if (!allowExpired && expiresMs <= nowMs) throw new Error("warden_candidate_expired");
  return expiresAt;
}

function text(content: Buffer | null): string | null {
  if (!content) return null;
  if (content.includes(0)) throw new Error("warden_candidate_binary_file_unsupported");
  return content.toString("utf8");
}

function digest(content: Buffer | null): string | null {
  return content ? createHash("sha256").update(content).digest("hex") : null;
}

export type ReviewManifestEntry = Readonly<{
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
}>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

function prefixedDigest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

// Bound concurrent full-tree hashing so polling tenants queue instead of
// stampeding the single-threaded event loop. A tiny promise-based semaphore.
const TREE_GATE_LIMIT = 2;
let treeGateActive = 0;
const treeGateQueue: Array<() => void> = [];

function acquireTreeGate(): Promise<void> {
  if (treeGateActive < TREE_GATE_LIMIT) {
    treeGateActive += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => treeGateQueue.push(resolve));
}

function releaseTreeGate(): void {
  const next = treeGateQueue.shift();
  if (next) {
    next();
  } else {
    treeGateActive -= 1;
  }
}

async function withTreeGate<T>(fn: () => Promise<T>): Promise<T> {
  await acquireTreeGate();
  try {
    return await fn();
  } finally {
    releaseTreeGate();
  }
}

async function scanReviewTree(root: string, capturePaths: ReadonlySet<string>): Promise<Readonly<{
  entries: readonly ReviewManifestEntry[];
  digest: string;
  files: ReadonlyMap<string, Buffer>;
}>> {
  const entries: ReviewManifestEntry[] = [];
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error("warden_candidate_tree_limit");
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      assertNoSymlinkPath(root, absolute);
      const info = lstatSync(absolute);
      const path = prefix ? `${prefix}/${name}` : name;
      if (info.isSymbolicLink()) throw new Error("warden_candidate_symlink_path");
      if (info.isDirectory()) {
        await visit(absolute, path, depth + 1);
        continue;
      }
      if (!info.isFile()) throw new Error("warden_candidate_file_invalid");
      if (info.size > 32 * 1024 * 1024) throw new Error("warden_candidate_file_too_large");
      const content = await readFile(absolute);
      if (capturePaths.has(path)) files.set(path, content);
      totalBytes += content.byteLength;
      if (entries.length >= 20_000 || totalBytes > 512 * 1024 * 1024) {
        throw new Error("warden_candidate_tree_limit");
      }
      entries.push(Object.freeze({
        path,
        size: content.byteLength,
        sha256: prefixedDigest(content),
        executable: (info.mode & 0o111) !== 0,
      }));
    }
  };
  await visit(root, "", 0);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const frozen = Object.freeze(entries);
  return Object.freeze({
    entries: frozen,
    digest: prefixedDigest(JSON.stringify(stableValue(frozen))),
    files,
  });
}

function readArtifact(root: string, value: unknown): Readonly<{
  value: Record<string, unknown>;
  sha256: string;
}> {
  if (typeof value !== "string") throw new Error("warden_candidate_artifact_missing");
  const path = resolve(value);
  if (!isStrictlyWithin(root, path)) throw new Error("warden_candidate_artifact_escape");
  assertNoSymlinkPath(root, path);
  if (!existsSync(path)) throw new Error("warden_candidate_artifact_missing");
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 4 * 1024 * 1024) {
    throw new Error("warden_candidate_artifact_invalid");
  }
  if (!isStrictlyWithin(root, realpathSync(path))) {
    throw new Error("warden_candidate_artifact_escape");
  }
  try {
    const bytes = readFileSync(path);
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return Object.freeze({
      value: parsed as Record<string, unknown>,
      sha256: prefixedDigest(bytes),
    });
  } catch {
    throw new Error("warden_candidate_artifact_invalid");
  }
}

export async function validateWardenCandidateForReview(
  input: Readonly<{
    tenantId: string;
    repoPath: string;
    status: string;
    resultJson: string | null;
    env?: NodeJS.ProcessEnv;
    nowMs?: number;
  }>,
): Promise<Readonly<{
  result: Record<string, unknown>;
  source: string;
  workspace: string;
  evidenceRoot: string;
  changedPaths: readonly string[];
  expiresAt: string;
  sourceDigest: string;
  candidateDigest: string;
  candidateEntries: readonly ReviewManifestEntry[];
  reviewEvidence: CandidateReviewEvidence;
  sourceFiles: ReadonlyMap<string, Buffer>;
  candidateFiles: ReadonlyMap<string, Buffer>;
}>> {
  if (input.status !== "candidate_ready" && input.status !== "candidate_approved") {
    throw new Error("warden_candidate_not_ready");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.tenantId)) {
    throw new Error("warden_candidate_tenant_invalid");
  }
  const result = candidateResult(input.resultJson);
  const expiresAt = candidateExpiry(
    result,
    input.nowMs ?? Date.now(),
    input.status === "candidate_approved",
  );
  const artifacts = result.artifacts && typeof result.artifacts === "object"
    ? (result.artifacts as Record<string, unknown>)
    : null;
  if (!artifacts) throw new Error("warden_candidate_artifact_missing");
  const env = input.env ?? process.env;
  const dataRootValue = env.MENDPOINT_DATA_DIR?.trim();
  if (!dataRootValue || !isAbsolute(dataRootValue)) {
    throw new Error("warden_candidate_data_root_required");
  }
  const dataRoot = realDirectory(dataRootValue, "warden_candidate_data_root_invalid");
  const candidateRoot = resolveTenantRoot(
    dataRoot,
    "warden-candidates",
    input.tenantId,
    "warden_candidate_tenant_root_invalid",
  );
  const evidenceRoot = resolveTenantRoot(
    dataRoot,
    "warden-evidence",
    input.tenantId,
    "warden_candidate_evidence_root_invalid",
  );
  const workspaceValue = artifacts.candidateWorkspace;
  if (typeof workspaceValue !== "string") throw new Error("warden_candidate_artifact_missing");
  const workspace = realDirectory(workspaceValue, "warden_candidate_workspace_invalid");
  if (!isStrictlyWithin(candidateRoot, workspace)) {
    throw new Error("warden_candidate_workspace_escape");
  }
  const source = realDirectory(input.repoPath, "warden_candidate_source_invalid");
  const changedPaths = Array.isArray(result.changedPaths)
    ? result.changedPaths.map(safeRelativePath)
    : [];
  if (!changedPaths.length || changedPaths.length > WARDEN_CANDIDATE_REVIEW_LIMITS.maxChangedFiles ||
    new Set(changedPaths).size !== changedPaths.length) {
    throw new Error("warden_candidate_changed_paths_invalid");
  }
  const manifestArtifact = readArtifact(candidateRoot, artifacts.candidateManifest);
  const evidenceArtifact = readArtifact(evidenceRoot, artifacts.evidence);
  const manifest = manifestArtifact.value;
  const evidence = evidenceArtifact.value;
  const manifestSource = manifest.source && typeof manifest.source === "object"
    ? manifest.source as Record<string, unknown>
    : null;
  const manifestCandidate = manifest.candidate && typeof manifest.candidate === "object"
    ? manifest.candidate as Record<string, unknown>
    : null;
  const capturePaths = new Set(changedPaths);
  const { sourceTree, candidateTree } = await withTreeGate(async () => ({
    sourceTree: await scanReviewTree(source, capturePaths),
    candidateTree: await scanReviewTree(workspace, capturePaths),
  }));
  const artifactChangedPaths = Array.isArray(manifest.changedPaths)
    ? manifest.changedPaths.map(safeRelativePath)
    : [];
  const evidenceChangedPaths = Array.isArray(evidence.changedPaths)
    ? evidence.changedPaths.map(safeRelativePath)
    : [];
  const parsedReviewEvidence = CandidateReviewEvidenceSchema.safeParse(evidence.review);
  if (!parsedReviewEvidence.success) throw new Error("warden_candidate_integrity_failed");
  const storedManifestDigest = artifacts.candidateManifestSha256;
  const storedEvidenceDigest = artifacts.evidenceSha256;
  const exactArtifactDigests =
    typeof storedManifestDigest === "string" &&
    storedManifestDigest === manifestArtifact.sha256 &&
    typeof storedEvidenceDigest === "string" &&
    storedEvidenceDigest === evidenceArtifact.sha256;
  const reviewPaths = parsedReviewEvidence.data.edits.map((edit) => safeRelativePath(edit.path));
  const expectedCandidateEntries = Array.isArray(manifestCandidate?.entries)
    ? manifestCandidate.entries
    : null;
  const valid = manifest.schemaVersion === 1 && evidence.schemaVersion === 1 &&
    manifestSource?.digest === sourceTree.digest &&
    artifacts.sourceDigest === sourceTree.digest &&
    evidence.sourceDigest === sourceTree.digest &&
    manifestCandidate?.digest === candidateTree.digest &&
    artifacts.candidateDigest === candidateTree.digest &&
    evidence.candidateDigest === candidateTree.digest &&
    JSON.stringify(stableValue(expectedCandidateEntries)) ===
      JSON.stringify(stableValue(candidateTree.entries)) &&
    JSON.stringify(artifactChangedPaths) === JSON.stringify(changedPaths) &&
    JSON.stringify(evidenceChangedPaths) === JSON.stringify(changedPaths) &&
    new Set(reviewPaths).size === reviewPaths.length &&
    JSON.stringify(reviewPaths) === JSON.stringify(changedPaths) &&
    (parsedReviewEvidence.data.schemaVersion === 1 || exactArtifactDigests);
  if (!valid) throw new Error("warden_candidate_integrity_failed");
  return Object.freeze({
    result,
    source,
    workspace,
    evidenceRoot,
    changedPaths: Object.freeze(changedPaths),
    expiresAt,
    sourceDigest: sourceTree.digest,
    candidateDigest: candidateTree.digest,
    candidateEntries: candidateTree.entries,
    reviewEvidence: parsedReviewEvidence.data,
    sourceFiles: sourceTree.files,
    candidateFiles: candidateTree.files,
  });
}

export async function readWardenCandidate(
  input: Readonly<{
    tenantId: string;
    repoPath: string;
    status: string;
    resultJson: string | null;
    env?: NodeJS.ProcessEnv;
    nowMs?: number;
  }>,
): Promise<Readonly<{
  changedPaths: readonly string[];
  files: readonly WardenCandidateFile[];
  expiresAt: string | null;
  reviewEvidence: CandidateReviewEvidence;
}>> {
  const validated = await validateWardenCandidateForReview(input);
  const { changedPaths, expiresAt, sourceFiles, candidateFiles } = validated;
  let totalBytes = 0;
  const files = changedPaths.map((path) => {
    const before = sourceFiles.get(path) ?? null;
    const after = candidateFiles.get(path) ?? null;
    if ((before?.byteLength ?? 0) > WARDEN_CANDIDATE_REVIEW_LIMITS.maxChangedFileBytes ||
      (after?.byteLength ?? 0) > WARDEN_CANDIDATE_REVIEW_LIMITS.maxChangedFileBytes) {
      throw new Error("warden_candidate_file_too_large");
    }
    totalBytes += (before?.byteLength ?? 0) + (after?.byteLength ?? 0);
    if (totalBytes > WARDEN_CANDIDATE_REVIEW_LIMITS.maxChangedBytes) {
      throw new Error("warden_candidate_response_too_large");
    }
    return Object.freeze({
      path,
      before: text(before),
      after: text(after),
      beforeSha256: digest(before),
      afterSha256: digest(after),
    });
  });
  return Object.freeze({
    changedPaths: Object.freeze(changedPaths),
    files: Object.freeze(files),
    expiresAt,
    reviewEvidence: validated.reviewEvidence,
  });
}

export function discardWardenCandidate(
  input: Readonly<{
    tenantId: string;
    status: string;
    resultJson: string | null;
    env?: NodeJS.ProcessEnv;
  }>,
): void {
  if (input.status !== "candidate_ready") throw new Error("warden_candidate_not_ready");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.tenantId)) {
    throw new Error("warden_candidate_tenant_invalid");
  }
  const result = candidateResult(input.resultJson);
  const artifacts = result?.artifacts && typeof result.artifacts === "object"
    ? (result.artifacts as Record<string, unknown>)
    : null;
  const workspaceValue = artifacts?.candidateWorkspace;
  const manifestValue = artifacts?.candidateManifest;
  const evidenceValue = artifacts?.evidence;
  if (
    typeof workspaceValue !== "string" ||
    typeof manifestValue !== "string" ||
    typeof evidenceValue !== "string"
  ) {
    throw new Error("warden_candidate_artifact_missing");
  }
  const env = input.env ?? process.env;
  const dataRootValue = env.MENDPOINT_DATA_DIR?.trim();
  if (!dataRootValue || !isAbsolute(dataRootValue)) {
    throw new Error("warden_candidate_data_root_required");
  }
  const dataRoot = realDirectory(dataRootValue, "warden_candidate_data_root_invalid");
  const candidateRoot = resolveTenantRoot(
    dataRoot,
    "warden-candidates",
    input.tenantId,
    "warden_candidate_tenant_root_invalid",
  );
  const evidenceRoot = resolveTenantRoot(
    dataRoot,
    "warden-evidence",
    input.tenantId,
    "warden_candidate_evidence_root_invalid",
  );
  const workspace = realDirectory(workspaceValue, "warden_candidate_workspace_invalid");
  const manifest = resolve(manifestValue);
  const evidence = resolve(evidenceValue);
  if (
    !isStrictlyWithin(candidateRoot, workspace) ||
    !isStrictlyWithin(candidateRoot, manifest) ||
    !isStrictlyWithin(evidenceRoot, evidence)
  ) {
    throw new Error("warden_candidate_artifact_escape");
  }
  for (const file of [manifest, evidence]) {
    const root = file === manifest ? candidateRoot : evidenceRoot;
    assertNoSymlinkPath(root, file);
    if (!existsSync(file)) throw new Error("warden_candidate_artifact_missing");
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("warden_candidate_artifact_invalid");
    if (!isStrictlyWithin(root, realpathSync(file))) {
      throw new Error("warden_candidate_artifact_escape");
    }
  }
  rmSync(workspace, { recursive: true, force: true });
  rmSync(manifest, { force: true });
  rmSync(evidence, { force: true });
}

export async function sealWardenCandidateApproval(
  input: Readonly<{
    tenantId: string;
    repoPath: string;
    status: string;
    resultJson: string | null;
    baseBranch?: string;
    reviewerPrincipalId?: string;
    rationale?: string;
    env?: NodeJS.ProcessEnv;
    nowMs?: number;
  }>,
): Promise<Readonly<{ path: string; sha256: string; created: boolean }>> {
  const validated = await validateWardenCandidateForReview(input);
  const source = validated.result.source && typeof validated.result.source === "object"
    ? validated.result.source as Record<string, unknown>
    : null;
  if (
    typeof source?.repositoryId !== "string" ||
    typeof source.snapshotId !== "string" ||
    typeof source.revision !== "string" ||
    !/^[a-f0-9]{40}$/.test(source.revision) ||
    !/^(?!\/)(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(input.baseBranch ?? "") ||
    typeof input.reviewerPrincipalId !== "string" ||
    !input.reviewerPrincipalId.trim() || input.reviewerPrincipalId.length > 500 ||
    typeof input.rationale !== "string" || !input.rationale.trim() || input.rationale.trim().length > 2_000
  ) {
    throw new Error("warden_candidate_approval_binding_invalid");
  }
  const intake = validated.result.intake && typeof validated.result.intake === "object" &&
    !Array.isArray(validated.result.intake)
    ? validated.result.intake as Record<string, unknown>
    : null;
  const providerChange = intake?.fettlerProviderChange === undefined
    ? null
    : parseFettlerProviderChangeEvidence(intake.fettlerProviderChange);
  if (providerChange && (
    providerChange.repositoryId !== source.repositoryId ||
    providerChange.snapshotId !== source.snapshotId ||
    providerChange.revision !== source.revision
  )) {
    throw new Error("fettler_provider_change_evidence_binding_mismatch");
  }
  let totalBytes = 0;
  const files = validated.changedPaths.map((path) => {
    const before = validated.sourceFiles.get(path) ?? null;
    const after = validated.candidateFiles.get(path) ?? null;
    if ((before?.byteLength ?? 0) > WARDEN_CANDIDATE_REVIEW_LIMITS.maxChangedFileBytes ||
      (after?.byteLength ?? 0) > WARDEN_CANDIDATE_REVIEW_LIMITS.maxChangedFileBytes) {
      throw new Error("warden_candidate_file_too_large");
    }
    totalBytes += (before?.byteLength ?? 0) + (after?.byteLength ?? 0);
    if (totalBytes > WARDEN_CANDIDATE_REVIEW_LIMITS.maxChangedBytes) {
      throw new Error("warden_candidate_response_too_large");
    }
    return Object.freeze({
      path,
      before: before ? before.toString("base64") : null,
      after: after ? after.toString("base64") : null,
      beforeSha256: before ? prefixedDigest(before) : null,
      afterSha256: after ? prefixedDigest(after) : null,
    });
  });
  const artifact = {
    schemaVersion: providerChange
      ? validated.reviewEvidence.schemaVersion === 2 ? 6 : 5
      : validated.reviewEvidence.schemaVersion === 2 ? 4 : 3,
    tenantId: input.tenantId,
    repositoryId: source.repositoryId,
    snapshotId: source.snapshotId,
    baseBranch: input.baseBranch!,
    expectedBaseRevision: source.revision,
    reviewerPrincipalId: input.reviewerPrincipalId!.trim(),
    rationale: input.rationale!.trim(),
    reviewEvidence: validated.reviewEvidence,
    ...(providerChange ? { fettlerProviderChange: providerChange } : {}),
    changedPaths: [...validated.changedPaths],
    sourceDigest: validated.sourceDigest,
    candidate: {
      digest: validated.candidateDigest,
      entries: validated.candidateEntries,
    },
    files,
  };
  const serialized = Buffer.from(JSON.stringify(artifact), "utf8");
  if (serialized.byteLength > 4 * 1024 * 1024) {
    throw new Error("warden_candidate_approval_too_large");
  }
  const hex = createHash("sha256").update(serialized).digest("hex");
  const approvalsDir = join(validated.evidenceRoot, "approvals");
  mkdirSync(approvalsDir, { recursive: true });
  assertNoSymlinkPath(validated.evidenceRoot, approvalsDir);
  if (!isStrictlyWithin(validated.evidenceRoot, realpathSync(approvalsDir))) {
    throw new Error("warden_candidate_approval_escape");
  }
  const artifactPath = join(approvalsDir, `${hex}.json`);
  assertNoSymlinkPath(validated.evidenceRoot, artifactPath);
  const verifyExisting = (): Readonly<{ path: string; sha256: string; created: false }> => {
    const info = lstatSync(artifactPath);
    if (info.isSymbolicLink() || !info.isFile() || !readFileSync(artifactPath).equals(serialized)) {
      throw new Error("warden_candidate_approval_conflict");
    }
    return Object.freeze({ path: artifactPath, sha256: `sha256:${hex}`, created: false });
  };
  if (existsSync(artifactPath)) return verifyExisting();

  // Publish the fully written and synced inode as one directory entry. A crash
  // can leave only an unreferenced temp file or the complete final seal, never a
  // partial final path. Hard-link publication is the non-clobbering equivalent
  // of an atomic rename and makes concurrent exact writers deterministic.
  const temporary = join(approvalsDir, `.${hex}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, serialized);
    fsyncSync(fd);
    try {
      closeSync(fd);
    } finally {
      fd = null;
    }
    try {
      linkSync(temporary, artifactPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return verifyExisting();
    }
  } catch (error) {
    if (fd !== null) closeSync(fd);
    throw error;
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* final seal remains authoritative */ }
  }
  return Object.freeze({ path: artifactPath, sha256: `sha256:${hex}`, created: true });
}

export function readWardenApprovalArtifact(
  input: Parameters<typeof readSharedWardenApprovalArtifact>[0],
): Record<string, unknown> {
  return readSharedWardenApprovalArtifact(input);
}
