import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CandidateReviewEvidenceSchema } from "@mendpoint/shared";

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
    (record.schemaVersion === 4 && reviewEvidence.data.schemaVersion === 2)
  );
  if (!schemaBound || record.tenantId !== input.tenantId ||
    typeof record.repositoryId !== "string" || typeof record.snapshotId !== "string" ||
    typeof record.baseBranch !== "string" || typeof record.expectedBaseRevision !== "string" ||
    !/^[a-f0-9]{40}$/.test(record.expectedBaseRevision) ||
    typeof record.reviewerPrincipalId !== "string" || typeof record.rationale !== "string" ||
    !reviewEvidence.success || changedPaths.length === 0 ||
    JSON.stringify(reviewEvidence.success ? reviewEvidence.data.edits.map((edit) => edit.path) : []) !==
      JSON.stringify(changedPaths)) {
    throw new Error("warden_candidate_approval_invalid");
  }
  return record;
}
