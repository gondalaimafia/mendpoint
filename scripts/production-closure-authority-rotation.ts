import { createHash } from "node:crypto";
import { posix } from "node:path";

const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ROTATION_ID = /^[a-z0-9][a-z0-9._-]{7,127}$/;
const MAX_ROTATION_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthorityReviewerIdentity {
  login: string;
  userId: number;
}

export interface ClosureAuthorityPolicy {
  schemaVersion: 1;
  repositoryId: number;
  repository: string;
  workflowPath: string;
  requiredCiWorkflowPath: string;
  externalCheckName: string;
  externalCheckAppId: number | null;
  controllerCheckName: string;
  controllerCheckAppId: number | null;
  protectionMode: "classic_branch";
  protectionBranch: "main";
  legacyBootstrapMatrixDigest: string;
  authorityRotationManifestPath: string;
  authorityRotationAuxiliaryFiles: string[];
  trustedReviewers: Record<string, AuthorityReviewerIdentity[]>;
  productionEvidenceAuthorities: unknown[];
  protectedFiles: Record<string, string>;
}

export interface AuthorityRotationFileChange {
  path: string;
  fromSha256: string | null;
  toSha256: string | null;
  fromMode: "100644" | "100755" | null;
  toMode: "100644" | "100755" | null;
}

export interface AuthorityRotationReceipt {
  rotationId: string;
  previousRotationId: string | null;
  baseRevision: string;
  issuedAt: string;
  expiresAt: string;
  baseLedgerSha256: string;
  basePolicySha256: string;
  proposedPolicySha256: string;
  changes: AuthorityRotationFileChange[];
}

export interface AuthorityRotationLedger {
  schemaVersion: 1;
  rotations: AuthorityRotationReceipt[];
}

export interface AuthorityRotationIssue {
  code: string;
  subject: string;
  message: string;
}

export interface AuthorityRotationVerificationInput {
  basePolicy: ClosureAuthorityPolicy;
  proposedPolicy: ClosureAuthorityPolicy;
  basePolicyBytes: Buffer;
  proposedPolicyBytes: Buffer;
  baseLedgerBytes: Buffer;
  baseLedger: AuthorityRotationLedger;
  proposedLedger: AuthorityRotationLedger;
  baseRevision: string;
  observedAt: string;
  changedFiles: AuthorityRotationFileChange[];
  proposedFileDigests: ReadonlyMap<string, string>;
  proposedFileContents: ReadonlyMap<string, Buffer>;
  proposedPaths: ReadonlySet<string>;
}

function digest(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizedPath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/").trim();
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..") ||
    normalized.includes("\0")
  ) return null;
  return posix.normalize(normalized);
}

function canonicalChanges(changes: readonly AuthorityRotationFileChange[]): string {
  return JSON.stringify(
    [...changes]
      .map((change) => ({
        path: change.path,
        fromSha256: change.fromSha256,
        toSha256: change.toSha256,
        fromMode: change.fromMode,
        toMode: change.toMode,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  );
}

function exactReviewerIdentities(policy: ClosureAuthorityPolicy): Set<string> {
  return new Set(
    Object.values(policy.trustedReviewers ?? {})
      .flat()
      .filter((identity) =>
        Boolean(identity?.login?.trim()) && Number.isInteger(identity?.userId) && identity.userId > 0
      )
      .map((identity) => `${identity.login.trim().toLowerCase()}:${identity.userId}`),
  );
}

function staticRelativeImports(contents: string): string[] {
  const imports: string[] = [];
  const patterns = [
    /(?:from\s+|import\s*)["'](\.[^"']+)["']/g,
    /export\s+(?:\*|\{[^}]*\})\s+from\s+["'](\.[^"']+)["']/g,
    /require\(\s*["'](\.[^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of contents.matchAll(pattern)) imports.push(match[1]);
  }
  return imports;
}

function resolveRelativeImport(
  importer: string,
  specifier: string,
  availablePaths: ReadonlySet<string>,
): string | null {
  const raw = posix.normalize(posix.join(posix.dirname(importer), specifier));
  const candidates = [
    raw,
    raw.replace(/\.js$/, ".ts"),
    raw.replace(/\.mjs$/, ".mts"),
    `${raw}.ts`,
    `${raw}.js`,
    `${raw}/index.ts`,
    `${raw}/index.js`,
  ];
  return candidates.find((candidate) => availablePaths.has(candidate)) ?? null;
}

function add(
  issues: AuthorityRotationIssue[],
  code: string,
  subject: string,
  message: string,
): void {
  issues.push({ code, subject, message });
}

export function verifyAuthorityRotation(
  input: AuthorityRotationVerificationInput,
): AuthorityRotationIssue[] {
  const issues: AuthorityRotationIssue[] = [];
  const baseRotations = input.baseLedger.rotations;
  const proposedRotations = input.proposedLedger.rotations;
  const baseReceipt = baseRotations?.at(-1) ?? null;
  const receipt = proposedRotations?.at(-1) ?? null;
  if (
    input.baseLedger.schemaVersion !== 1 ||
    input.proposedLedger.schemaVersion !== 1 ||
    !Array.isArray(baseRotations) ||
    !Array.isArray(proposedRotations) ||
    proposedRotations.length !== baseRotations.length + 1 ||
    JSON.stringify(proposedRotations.slice(0, -1)) !== JSON.stringify(baseRotations) ||
    !receipt
  ) {
    add(issues, "AUTHORITY_ROTATION_RECEIPT_INVALID", "rotation", "rotation requires a schema v1 receipt");
    return issues;
  }

  const issuedAt = Date.parse(receipt.issuedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  const observedAt = Date.parse(input.observedAt);
  if (
    !ROTATION_ID.test(receipt.rotationId) ||
    receipt.previousRotationId !== (baseReceipt?.rotationId ?? null) ||
    receipt.rotationId === baseReceipt?.rotationId ||
    baseRotations.some((prior) => prior.rotationId === receipt.rotationId) ||
    !SHA.test(receipt.baseRevision) ||
    receipt.baseRevision !== input.baseRevision ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(observedAt) ||
    issuedAt > observedAt ||
    expiresAt < observedAt ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_ROTATION_VALIDITY_MS
  ) {
    add(
      issues,
      "AUTHORITY_ROTATION_RECEIPT_INVALID",
      receipt.rotationId || "rotation",
      "rotation identity, chain, base revision, and bounded validity must be exact",
    );
  }
  if (
    receipt.baseLedgerSha256 !== digest(input.baseLedgerBytes) ||
    receipt.basePolicySha256 !== digest(input.basePolicyBytes) ||
    receipt.proposedPolicySha256 !== digest(input.proposedPolicyBytes)
  ) {
    add(
      issues,
      "AUTHORITY_ROTATION_POLICY_DIGEST_MISMATCH",
      receipt.rotationId,
      "rotation policy digests must bind the raw base and proposed policy bytes",
    );
  }

  const immutableFields: Array<keyof ClosureAuthorityPolicy> = [
    "schemaVersion",
    "repositoryId",
    "repository",
    "workflowPath",
    "requiredCiWorkflowPath",
    "externalCheckName",
    "controllerCheckName",
    "protectionMode",
    "protectionBranch",
    "authorityRotationManifestPath",
    "authorityRotationAuxiliaryFiles",
  ];
  for (const field of immutableFields) {
    if (JSON.stringify(input.basePolicy[field]) !== JSON.stringify(input.proposedPolicy[field])) {
      add(
        issues,
        "AUTHORITY_ROTATION_IDENTITY_DRIFT",
        String(field),
        "repository, check, workflow, and rotation identities cannot change in a runtime rotation",
      );
    }
  }
  if (input.changedFiles.some((change) => change.path === input.basePolicy.workflowPath)) {
    add(
      issues,
      "AUTHORITY_ROTATION_WORKFLOW_SUCCESSOR_REQUIRED",
      input.basePolicy.workflowPath,
      "the active controller workflow requires a separately proven successor before replacement",
    );
  }

  const baseReviewers = exactReviewerIdentities(input.basePolicy);
  const proposedReviewers = exactReviewerIdentities(input.proposedPolicy);
  if (baseReviewers.size === 0 || ![...baseReviewers].some((identity) => proposedReviewers.has(identity))) {
    add(
      issues,
      "AUTHORITY_ROTATION_REVIEWER_CONTINUITY_REQUIRED",
      receipt.rotationId,
      "a rotation must retain at least one exact reviewer identity trusted by the base policy",
    );
  }

  const baseAllowedPaths = new Set([
    ...Object.keys(input.basePolicy.protectedFiles),
    ...input.basePolicy.authorityRotationAuxiliaryFiles,
    "config/production-closure-authority.json",
    "docs/PRODUCTION_CLOSURE_MATRIX.json",
  ]);
  const authorityAdditionAllowed = (path: string): boolean =>
    /^scripts\/production-closure-[a-z0-9-]+(?:\.test)?\.ts$/.test(path) ||
    /^scripts\/fixtures\/production-closure-[a-z0-9-]+\.json$/.test(path) ||
    /^\.github\/workflows\/closure-authority-[a-z0-9-]+\.yml$/.test(path);
  const changedPaths = new Set<string>();
  for (const change of input.changedFiles) {
    const path = normalizedPath(change.path);
    if (
      !path ||
      path !== change.path ||
      changedPaths.has(path) ||
      (change.fromSha256 !== null && !SHA256.test(change.fromSha256)) ||
      (change.toSha256 !== null && !SHA256.test(change.toSha256)) ||
      (change.fromSha256 === null && change.toSha256 === null) ||
      (change.fromMode !== null && !["100644", "100755"].includes(change.fromMode)) ||
      (change.toMode !== null && !["100644", "100755"].includes(change.toMode)) ||
      (change.fromSha256 === null) !== (change.fromMode === null) ||
      (change.toSha256 === null) !== (change.toMode === null)
    ) {
      add(issues, "AUTHORITY_ROTATION_CHANGE_INVALID", change.path, "rotation changes must be unique normalized digest transitions");
      continue;
    }
    changedPaths.add(path);
    if (!baseAllowedPaths.has(path) && !authorityAdditionAllowed(path)) {
      add(issues, "AUTHORITY_ROTATION_SCOPE_INVALID", path, "authority rotation pull requests cannot change product files");
    }
  }
  if (canonicalChanges(receipt.changes) !== canonicalChanges(input.changedFiles)) {
    add(
      issues,
      "AUTHORITY_ROTATION_CHANGESET_MISMATCH",
      receipt.rotationId,
      "the signed review receipt must exhaustively bind every changed file digest",
    );
  }

  for (const path of Object.keys(input.basePolicy.protectedFiles)) {
    if (!(path in input.proposedPolicy.protectedFiles)) {
      add(issues, "AUTHORITY_ROTATION_PROTECTED_FILE_REMOVED", path, "runtime rotations cannot remove a base protected file");
    }
  }
  for (const [path, expectedDigest] of Object.entries(input.proposedPolicy.protectedFiles)) {
    if (!(path in input.basePolicy.protectedFiles) && !authorityAdditionAllowed(path)) {
      add(issues, "AUTHORITY_ROTATION_PROTECTED_PATH_INVALID", path, "new protected paths must be confined to the hard-coded authority namespace");
    }
    if (!SHA256.test(expectedDigest) || input.proposedFileDigests.get(path) !== expectedDigest) {
      add(issues, "AUTHORITY_ROTATION_PROTECTED_DIGEST_INVALID", path, "proposed protected digests must match exact proposal bytes");
    }
  }

  const protectedPaths = new Set(Object.keys(input.proposedPolicy.protectedFiles));
  for (const path of protectedPaths) {
    if (!/\.[cm]?[jt]s$/.test(path)) continue;
    const contents = input.proposedFileContents.get(path)?.toString("utf8");
    if (contents === undefined) continue;
    if (/import\s*\(\s*["']\./.test(contents)) {
      add(issues, "AUTHORITY_ROTATION_DYNAMIC_IMPORT_FORBIDDEN", path, "protected authority code cannot use a dynamic relative import");
    }
    for (const specifier of staticRelativeImports(contents)) {
      const dependency = resolveRelativeImport(path, specifier, input.proposedPaths);
      if (!dependency) {
        add(
          issues,
          "AUTHORITY_ROTATION_IMPORT_UNRESOLVED",
          `${path}:${specifier}`,
          "every protected relative import must resolve in the exact proposal tree",
        );
      } else if (!protectedPaths.has(dependency)) {
        add(
          issues,
          "AUTHORITY_ROTATION_IMPORT_CLOSURE_INCOMPLETE",
          dependency,
          `protected authority import from ${path} is not pinned`,
        );
      }
    }
  }

  return issues.sort(
    (left, right) => left.code.localeCompare(right.code) || left.subject.localeCompare(right.subject),
  );
}
