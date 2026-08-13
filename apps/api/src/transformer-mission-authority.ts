import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import {
  getConnectedRepository,
  getPrincipalBySubject,
  getRepositorySnapshotDeletionStatus,
  getRepositorySnapshotPolicy,
  listRepositorySnapshotFiles,
  listRepositorySnapshots,
  listTenantMemberships,
  type AppDb,
  type RepositorySnapshotPolicyRow,
  type RepositorySnapshotRow,
} from "@mendpoint/db";
import {
  createOrganizationConstraintContract,
  recipeFilesDigest,
  type OrganizationConstraintContract,
  type RecipeFiles,
} from "@mendpoint/transformer";
import type {
  TransformerMissionOrganizationAuthority,
  TransformerMissionRepositoryAuthority,
} from "./transformer-missions.js";

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function prefixedDigest(value: string | Buffer): string {
  return `sha256:${digest(value)}`;
}

function stableId(prefix: string, ...values: readonly string[]): string {
  return `${prefix}-${digest(values.map((value) => `${value.length}:${value}`).join("" )).slice(0, 24)}`;
}

function exactJson<T>(value: string, code: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(code);
  }
}

function safePath(path: string): string {
  if (!path || path.length > 1_000 || path.startsWith("/") || path.includes("\\") ||
      path.includes("\0") || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("transformer_mission_snapshot_path_invalid");
  }
  return path;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function snapshotRoot(snapshot: RepositorySnapshotRow): string {
  if (!snapshot.storage_path.trim() || !isAbsolute(snapshot.storage_path)) {
    throw new Error("transformer_mission_snapshot_root_invalid");
  }
  const entry = lstatSync(snapshot.storage_path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("transformer_mission_snapshot_root_invalid");
  return realpathSync(resolve(snapshot.storage_path));
}

function readExactFile(root: string, path: string): Buffer {
  let cursor = root;
  const segments = safePath(path).split("/");
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment);
    let entry;
    try {
      entry = lstatSync(cursor);
    } catch {
      throw new Error("transformer_mission_snapshot_file_missing");
    }
    if (entry.isSymbolicLink()) throw new Error("transformer_mission_snapshot_symlink_forbidden");
    if (index < segments.length - 1 && !entry.isDirectory()) {
      throw new Error("transformer_mission_snapshot_file_invalid");
    }
    if (index === segments.length - 1 && !entry.isFile()) {
      throw new Error("transformer_mission_snapshot_file_invalid");
    }
  }
  const real = realpathSync(cursor);
  if (!within(root, real)) throw new Error("transformer_mission_snapshot_path_escape");
  return readFileSync(real);
}

function activeSnapshot(
  db: AppDb,
  tenantId: string,
  repositoryId: string,
  observedAt: string,
): Readonly<{ snapshot: RepositorySnapshotRow; policy: RepositorySnapshotPolicyRow }> {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed) || new Date(observed).toISOString() !== observedAt) {
    throw new Error("transformer_mission_observed_at_invalid");
  }
  const repository = getConnectedRepository(db, repositoryId, tenantId);
  if (!repository || repository.status !== "ready") throw new Error("transformer_mission_repository_not_found");
  for (const snapshot of listRepositorySnapshots(db, tenantId, repositoryId)) {
    const deletion = getRepositorySnapshotDeletionStatus(db, tenantId, snapshot.id);
    if (deletion?.status === "planned" || deletion?.status === "deleted") continue;
    if (snapshot.file_manifest_version !== 1 || !REVISION.test(snapshot.resolved_sha) ||
        !SHA256.test(snapshot.manifest_sha256) || Date.parse(snapshot.expires_at) <= observed) continue;
    const policy = getRepositorySnapshotPolicy(db, tenantId, snapshot.id);
    if (policy) return Object.freeze({ snapshot, policy });
  }
  throw new Error("transformer_mission_snapshot_not_found");
}

type CodeownersDocument = Readonly<{ path: string; content: string }>;

function codeowners(policy: RepositorySnapshotPolicyRow): CodeownersDocument[] {
  const value = exactJson<unknown>(policy.codeowners_json, "transformer_mission_codeowners_invalid");
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new Error("transformer_mission_codeowners_required");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("transformer_mission_codeowners_invalid");
    }
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string" || typeof record.content !== "string" ||
        !record.path || record.path.length > 1_000 || record.content.length > 256_000) {
      throw new Error("transformer_mission_codeowners_invalid");
    }
    return Object.freeze({ path: safePath(record.path), content: record.content });
  });
}

function matchesCodeowners(patternInput: string, path: string): boolean {
  let pattern = patternInput.trim();
  if (!pattern || pattern.startsWith("#") || pattern.startsWith("!")) return false;
  pattern = pattern.replace(/^\//, "");
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return pattern.includes("/")
    ? new RegExp(`^${escaped}${pattern.includes(".") ? "" : "(?:/.*)?"}$`).test(path)
    : new RegExp(`^(?:.*/)?${escaped}$`).test(path);
}

function ownersForPath(documents: readonly CodeownersDocument[], path: string): string[] {
  let owners: string[] = [];
  for (const document of documents) {
    for (const line of document.content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [pattern, ...candidates] = trimmed.split(/\s+/);
      if (pattern && candidates.length && matchesCodeowners(pattern, path)) {
        owners = candidates.filter((owner) => /^@[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(owner));
      }
    }
  }
  return [...new Set(owners)].sort(compareCodeUnits);
}

function loadRepository(
  db: AppDb,
  tenantId: string,
  repositoryId: string,
  observedAt: string,
  allowedPaths?: readonly string[],
) {
  const { snapshot, policy } = activeSnapshot(db, tenantId, repositoryId, observedAt);
  const allowed = allowedPaths === undefined ? undefined : new Set(allowedPaths.map(safePath));
  const manifest = listRepositorySnapshotFiles(db, tenantId, snapshot.id)
    .filter((row) => allowed === undefined || allowed.has(row.path));
  if (manifest.length === 0 || manifest.length > MAX_FILES) {
    throw new Error("transformer_mission_snapshot_manifest_invalid");
  }
  const root = snapshotRoot(snapshot);
  const documents = codeowners(policy);
  const files: Record<string, string> = {};
  let total = 0;
  const fileEvidence = manifest.map((row) => {
    if (row.kind !== "file" || (row.mode !== "100644" && row.mode !== "100755") ||
        !Number.isSafeInteger(row.size) || row.size < 0 || row.size > MAX_FILE_BYTES || !SHA256.test(row.sha256)) {
      throw new Error("transformer_mission_snapshot_manifest_invalid");
    }
    const path = safePath(row.path);
    total += row.size;
    if (total > MAX_TOTAL_BYTES) throw new Error("transformer_mission_snapshot_total_limit_exceeded");
    const bytes = readExactFile(root, path);
    if (bytes.length !== row.size) throw new Error("transformer_mission_snapshot_file_size_mismatch");
    if (digest(bytes) !== row.sha256) throw new Error("transformer_mission_snapshot_file_hash_mismatch");
    let content: string;
    try {
      content = UTF8.decode(bytes).replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n");
    } catch {
      throw new Error("transformer_mission_snapshot_utf8_invalid");
    }
    files[path] = content;
    const ownerIds = ownersForPath(documents, path);
    return Object.freeze({
      path,
      digest: prefixedDigest(content),
      ownerIds: Object.freeze(ownerIds),
      evidenceRefs: Object.freeze([
        `repository-snapshot:${snapshot.id}:file:${path}:sha256:${row.sha256}`,
        ...documents.map((document) =>
          `repository-snapshot-policy:${policy.id}:codeowners:${document.path}:sha256:${digest(document.content)}`),
      ].sort(compareCodeUnits)),
    });
  }).sort((left, right) => compareCodeUnits(left.path, right.path));
  const recipeFiles = Object.freeze(files) as RecipeFiles;
  const snapshotDigest = recipeFilesDigest(recipeFiles);
  const evidenceRefs = Object.freeze([
    `repository-snapshot:${snapshot.id}:manifest:sha256:${snapshot.manifest_sha256}`,
    `repository-snapshot-policy:${policy.id}`,
  ]);
  return Object.freeze({
    planning: Object.freeze({
      id: repositoryId,
      organizationId: tenantId,
      revision: snapshot.resolved_sha,
      snapshotDigest,
      observedAt: snapshot.created_at,
      evidenceRefs,
      files: recipeFiles,
      fileEvidence: Object.freeze(fileEvidence),
    }),
    execution: Object.freeze({
      snapshot: Object.freeze({
        snapshotId: snapshot.id,
        repositoryId,
        revision: snapshot.resolved_sha,
        manifestSha256: snapshot.manifest_sha256,
        digest: snapshotDigest,
        evidenceRefs,
      }),
      files: recipeFiles,
    }),
    policy,
    codeowners: documents,
  });
}

export function createAppDbTransformerMissionAuthority(db: AppDb): Readonly<{
  repositories: TransformerMissionRepositoryAuthority;
  organizations: TransformerMissionOrganizationAuthority;
}> {
  const repositories: TransformerMissionRepositoryAuthority = Object.freeze({
    load(tenantId: string, repositoryId: string, observedAt: string, allowedPaths?: readonly string[]) {
      const value = loadRepository(db, tenantId, repositoryId, observedAt, allowedPaths);
      return Object.freeze({ planning: value.planning, execution: value.execution });
    },
  });
  const organizations: TransformerMissionOrganizationAuthority = Object.freeze({
    load(
      tenantId: string,
      rawRepositoryIds: readonly string[],
      plannerActorId: string,
      observedAt: string,
    ) {
      const repositoryIds = [...new Set(rawRepositoryIds)].sort(compareCodeUnits);
      if (repositoryIds.length === 0 || repositoryIds.length !== rawRepositoryIds.length) {
        throw new Error("transformer_mission_repository_invalid");
      }
      const loaded = repositoryIds.map((repositoryId) =>
        loadRepository(db, tenantId, repositoryId, observedAt));
      const reviewers = listTenantMemberships(db, tenantId)
        .filter((membership) => membership.status === "active" && membership.role !== "viewer")
        .map((membership) => ({
          membership,
          subject: `${membership.issuer}|${membership.subject}`,
          actorId: `human:${membership.issuer}|${membership.subject}`,
        }))
        .filter((candidate) => candidate.actorId !== plannerActorId &&
          Boolean(getPrincipalBySubject(db, tenantId, "human", candidate.subject)))
        .sort((left, right) => compareCodeUnits(left.actorId, right.actorId));
      if (reviewers.length === 0) throw new Error("transformer_mission_reviewer_required");

      const sources = loaded.map((repository) => ({
        id: stableId("snapshot-policy", repository.planning.id, repository.policy.id),
        kind: "codeowners" as const,
        repositoryId: repository.planning.id,
        revision: repository.planning.revision,
        digest: prefixedDigest(canonical({
          codeowners: exactJson(repository.policy.codeowners_json, "transformer_mission_codeowners_invalid"),
          ciFiles: exactJson(repository.policy.ci_files_json, "transformer_mission_snapshot_policy_invalid"),
          verificationCommands: exactJson(repository.policy.verification_commands_json, "transformer_mission_snapshot_policy_invalid"),
          protectedBranch: exactJson(repository.policy.protected_branch_json, "transformer_mission_snapshot_policy_invalid"),
        })),
        locator: `repository-snapshot-policy:${repository.policy.id}`,
        evidenceRefs: repository.planning.evidenceRefs,
      }));
      const sourceByRepository = new Map(sources.map((source) => [source.repositoryId, source]));
      const rules = loaded.flatMap((repository) => repository.planning.fileEvidence
        .filter((file) => file.ownerIds.length > 0)
        .map((file) => ({
        id: stableId("change", repository.planning.id, file.path),
        sourceId: sourceByRepository.get(repository.planning.id)!.id,
        repositoryId: repository.planning.id,
        pathPattern: file.path,
        actions: ["change"] as const,
        effect: "allow" as const,
        ownerIds: file.ownerIds,
        rationale: "The exact snapshot policy assigns owners for this path.",
        })));
      const constraints: OrganizationConstraintContract = createOrganizationConstraintContract({
        tenantId,
        organizationId: tenantId,
        version: 1,
        effectiveAt: loaded.map((repository) => repository.policy.created_at).sort(compareCodeUnits).at(-1)!,
        sources,
        rules,
      });
      const reviewerIds = reviewers.map((candidate) => candidate.actorId);
      const memberIds = [...new Set([
        plannerActorId,
        ...reviewerIds,
        ...rules.flatMap((rule) => rule.ownerIds),
      ])].sort(compareCodeUnits);
      const organizationRevision = createHash("sha1")
        .update(canonical({ tenantId, repositoryIds, reviewerIds, constraints: constraints.digest }), "utf8")
        .digest("hex");
      return Object.freeze({
        constraints,
        organization: Object.freeze({
          id: tenantId,
          revision: organizationRevision,
          digest: constraints.digest,
          observedAt: loaded.map((repository) => repository.planning.observedAt).sort(compareCodeUnits).at(-1)!,
          repositoryIds: [...repositoryIds],
          memberIds: [...memberIds],
          evidenceRefs: [
            `organization-constraint:${constraints.digest}`,
            ...reviewers.map((candidate) =>
              `tenant-membership:${candidate.membership.issuer}:${candidate.membership.subject}:${candidate.membership.updated_at}`),
          ].sort(compareCodeUnits),
          humanReviewPolicy: Object.freeze({
            required: true as const,
            minimumApprovals: 1,
            reviewerIds: [...reviewerIds],
            prohibitPlannerApproval: true as const,
          }),
        }),
      });
    },
  });
  return Object.freeze({ repositories, organizations });
}
