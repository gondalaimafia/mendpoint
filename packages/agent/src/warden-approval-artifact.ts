import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CandidateReviewEvidenceSchema } from "@mendpoint/shared";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export type FettlerProviderChangeEvidence = Readonly<{
  schemaVersion: 1;
  providerSlug: string;
  changeId: string;
  pipelineJobId: string;
  contentHash: string;
  fromVersionId: string;
  fromVersionLabel: string;
  toVersionId: string;
  toVersionLabel: string;
  repositoryId: string;
  snapshotId: string;
  revision: string;
  graphVersionId: string | null;
  graphContextArtifactId: string | null;
  impactEvidenceDigest: string;
  overallConfidence: "medium" | "high";
  whatChanged: string;
  knownFacts: readonly string[];
  unknowns: readonly string[];
  whyAffected: string;
}>;

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function boundedTextList(value: unknown, allowEmpty = false): value is string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= 20 &&
    value.every((item) => boundedText(item, 500));
}

export function parseFettlerProviderChangeEvidence(
  value: unknown,
): FettlerProviderChangeEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("fettler_provider_change_evidence_invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    !boundedText(record.providerSlug, 200) ||
    !boundedText(record.changeId, 500) ||
    !boundedText(record.pipelineJobId, 500) ||
    typeof record.contentHash !== "string" || !/^[a-f0-9]{16}$/.test(record.contentHash) ||
    !boundedText(record.fromVersionId, 500) ||
    !boundedText(record.fromVersionLabel, 500) ||
    !boundedText(record.toVersionId, 500) ||
    !boundedText(record.toVersionLabel, 500) ||
    !boundedText(record.repositoryId, 500) ||
    !boundedText(record.snapshotId, 500) ||
    typeof record.revision !== "string" || !REVISION.test(record.revision) ||
    !(record.graphVersionId === null || boundedText(record.graphVersionId, 500)) ||
    !(record.graphContextArtifactId === null || boundedText(record.graphContextArtifactId, 500)) ||
    typeof record.impactEvidenceDigest !== "string" || !SHA256.test(record.impactEvidenceDigest) ||
    (record.overallConfidence !== "medium" && record.overallConfidence !== "high") ||
    !boundedText(record.whatChanged, 2_000) ||
    !boundedTextList(record.knownFacts) ||
    !boundedTextList(record.unknowns, true) ||
    !boundedText(record.whyAffected, 2_000)
  ) {
    throw new Error("fettler_provider_change_evidence_invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    providerSlug: record.providerSlug,
    changeId: record.changeId,
    pipelineJobId: record.pipelineJobId,
    contentHash: record.contentHash,
    fromVersionId: record.fromVersionId,
    fromVersionLabel: record.fromVersionLabel,
    toVersionId: record.toVersionId,
    toVersionLabel: record.toVersionLabel,
    repositoryId: record.repositoryId,
    snapshotId: record.snapshotId,
    revision: record.revision,
    graphVersionId: record.graphVersionId,
    graphContextArtifactId: record.graphContextArtifactId,
    impactEvidenceDigest: record.impactEvidenceDigest,
    overallConfidence: record.overallConfidence,
    whatChanged: record.whatChanged,
    knownFacts: Object.freeze([...record.knownFacts]),
    unknowns: Object.freeze([...record.unknowns]),
    whyAffected: record.whyAffected,
  });
}

function within(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}
function strict(root: string, candidate: string): boolean { return root !== candidate && within(root, candidate); }
function realDirectory(path: string, code: string): string {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error(code);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(code);
  return realpathSync(path);
}
function assertNoSymlink(root: string, target: string): void {
  const value = relative(root, target);
  if (!value || value.startsWith(`..${sep}`) || value === ".." || isAbsolute(value)) {
    throw new Error("warden_candidate_approval_escape");
  }
  let current = root;
  for (const part of value.split(sep)) {
    current = join(current, part);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) throw new Error("warden_candidate_symlink_path");
  }
}

export function readWardenApprovalArtifact(input: Readonly<{
  tenantId: string; path: string; sha256: string; env?: NodeJS.ProcessEnv;
}>): Record<string, unknown> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.tenantId)) throw new Error("warden_candidate_tenant_invalid");
  const dataRootValue = input.env?.MENDPOINT_DATA_DIR?.trim() ?? process.env.MENDPOINT_DATA_DIR?.trim();
  if (!dataRootValue || !isAbsolute(dataRootValue)) throw new Error("warden_candidate_data_root_required");
  const dataRoot = realDirectory(dataRootValue, "warden_candidate_data_root_invalid");
  const nominalEvidence = join(dataRoot, "warden-evidence", input.tenantId);
  assertNoSymlink(dataRoot, nominalEvidence);
  const evidenceRoot = realDirectory(nominalEvidence, "warden_candidate_evidence_root_invalid");
  if (!strict(dataRoot, evidenceRoot)) throw new Error("warden_candidate_approval_escape");
  const approvalsDir = join(evidenceRoot, "approvals");
  const path = resolve(input.path);
  if (!strict(approvalsDir, path)) throw new Error("warden_candidate_approval_escape");
  assertNoSymlink(evidenceRoot, path);
  if (!existsSync(path)) throw new Error("warden_candidate_approval_missing");
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 4 * 1024 * 1024 || !strict(approvalsDir, realpathSync(path))) {
    throw new Error("warden_candidate_approval_invalid");
  }
  const bytes = readFileSync(path);
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== input.sha256) {
    throw new Error("warden_candidate_approval_digest_mismatch");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("warden_candidate_approval_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("warden_candidate_approval_invalid");
  const record = parsed as Record<string, unknown>;
  const reviewEvidence = CandidateReviewEvidenceSchema.safeParse(record.reviewEvidence);
  const changedPaths = Array.isArray(record.changedPaths) && record.changedPaths.every((path) => typeof path === "string")
    ? record.changedPaths as string[]
    : [];
  const schemaBound = reviewEvidence.success && (
    (record.schemaVersion === 3 && reviewEvidence.data.schemaVersion === 1) ||
    (record.schemaVersion === 4 && reviewEvidence.data.schemaVersion === 2) ||
    (record.schemaVersion === 5 && reviewEvidence.data.schemaVersion === 1) ||
    (record.schemaVersion === 6 && reviewEvidence.data.schemaVersion === 2)
  );
  const providerChange = record.schemaVersion === 5 || record.schemaVersion === 6
    ? parseFettlerProviderChangeEvidence(record.fettlerProviderChange)
    : null;
  if (!schemaBound || record.tenantId !== input.tenantId ||
    typeof record.repositoryId !== "string" || typeof record.snapshotId !== "string" ||
    typeof record.baseBranch !== "string" || typeof record.expectedBaseRevision !== "string" ||
    !/^[a-f0-9]{40}$/.test(record.expectedBaseRevision) ||
    typeof record.reviewerPrincipalId !== "string" || typeof record.rationale !== "string" ||
    !reviewEvidence.success || changedPaths.length === 0 ||
    JSON.stringify(reviewEvidence.success ? reviewEvidence.data.edits.map((edit) => edit.path) : []) !==
      JSON.stringify(changedPaths) ||
    (providerChange !== null && (
      providerChange.repositoryId !== record.repositoryId ||
      providerChange.snapshotId !== record.snapshotId ||
      providerChange.revision !== record.expectedBaseRevision
    ))) {
    throw new Error("warden_candidate_approval_invalid");
  }
  return record;
}
