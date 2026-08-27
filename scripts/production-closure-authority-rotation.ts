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

export interface AuthoritySuccessorTuple {
  templatePath: string;
  workflowPath: string;
  workflowSha256: string;
  externalCheckName: string;
  externalCheckAppId: number;
  controllerCheckName: string;
  controllerCheckAppId: number;
  controllerStatusCreatorLogin: string;
  controllerStatusCreatorUserId: number;
  activationDeadline: string;
}

export interface AuthoritySuccessorState extends AuthoritySuccessorTuple {
  phase: "staged";
  stagedByRotationId: string;
  activatedByRotationId: null;
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
  successor: AuthoritySuccessorState | null;
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
  kind: "runtime" | "stage_successor" | "activate_successor";
  rotationId: string;
  previousRotationId: string | null;
  baseRevision: string;
  issuedAt: string;
  expiresAt: string;
  baseLedgerSha256: string;
  basePolicySha256: string;
  proposedPolicySha256: string;
  successor: AuthoritySuccessorTuple | null;
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

function canonicalTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function exactSuccessorTuple(
  left: AuthoritySuccessorTuple | null | undefined,
  right: AuthoritySuccessorTuple | null | undefined,
): boolean {
  const tuple = (value: AuthoritySuccessorTuple | null | undefined) => value ? {
    templatePath: value.templatePath,
    workflowPath: value.workflowPath,
    workflowSha256: value.workflowSha256,
    externalCheckName: value.externalCheckName,
    externalCheckAppId: value.externalCheckAppId,
    controllerCheckName: value.controllerCheckName,
    controllerCheckAppId: value.controllerCheckAppId,
    controllerStatusCreatorLogin: value.controllerStatusCreatorLogin,
    controllerStatusCreatorUserId: value.controllerStatusCreatorUserId,
    activationDeadline: value.activationDeadline,
  } : null;
  return JSON.stringify(tuple(left)) === JSON.stringify(tuple(right));
}

function exactSuccessorRestageIdentity(
  left: AuthoritySuccessorTuple | null | undefined,
  right: AuthoritySuccessorTuple | null | undefined,
): boolean {
  const identity = (value: AuthoritySuccessorTuple | null | undefined) => value ? {
    templatePath: value.templatePath,
    workflowPath: value.workflowPath,
    externalCheckName: value.externalCheckName,
    externalCheckAppId: value.externalCheckAppId,
    controllerCheckName: value.controllerCheckName,
    controllerCheckAppId: value.controllerCheckAppId,
    controllerStatusCreatorLogin: value.controllerStatusCreatorLogin,
    controllerStatusCreatorUserId: value.controllerStatusCreatorUserId,
  } : null;
  return JSON.stringify(identity(left)) === JSON.stringify(identity(right));
}

function validSuccessorTuple(
  successor: AuthoritySuccessorTuple | null | undefined,
): successor is AuthoritySuccessorTuple {
  return Boolean(
    successor &&
    normalizedPath(successor.templatePath) === successor.templatePath &&
    /^config\/production-closure-successors\/closure-authority-[a-z0-9-]+\.yml$/.test(successor.templatePath) &&
    normalizedPath(successor.workflowPath) === successor.workflowPath &&
    /^\.github\/workflows\/closure-authority-[a-z0-9-]+\.yml$/.test(successor.workflowPath) &&
    SHA256.test(successor.workflowSha256) &&
    typeof successor.externalCheckName === "string" &&
    successor.externalCheckName.trim() &&
    typeof successor.controllerCheckName === "string" &&
    successor.controllerCheckName.trim() &&
    successor.externalCheckName !== successor.controllerCheckName &&
    successor.templatePath.split("/").at(-1) === successor.workflowPath.split("/").at(-1) &&
    Number.isInteger(successor.externalCheckAppId) &&
    successor.externalCheckAppId > 0 &&
    Number.isInteger(successor.controllerCheckAppId) &&
    successor.controllerCheckAppId > 0 &&
    typeof successor.controllerStatusCreatorLogin === "string" &&
    successor.controllerStatusCreatorLogin.trim() === successor.controllerStatusCreatorLogin &&
    successor.controllerStatusCreatorLogin.length > 0 &&
    Number.isInteger(successor.controllerStatusCreatorUserId) &&
    successor.controllerStatusCreatorUserId > 0 &&
    canonicalTime(successor.activationDeadline)
  );
}

function activeIdentity(policy: ClosureAuthorityPolicy): unknown {
  return {
    workflowPath: policy.workflowPath,
    externalCheckName: policy.externalCheckName,
    externalCheckAppId: policy.externalCheckAppId,
    controllerCheckName: policy.controllerCheckName,
    controllerCheckAppId: policy.controllerCheckAppId,
  };
}

function successorActiveIdentity(successor: AuthoritySuccessorTuple): unknown {
  return {
    workflowPath: successor.workflowPath,
    externalCheckName: successor.externalCheckName,
    externalCheckAppId: successor.externalCheckAppId,
    controllerCheckName: successor.controllerCheckName,
    controllerCheckAppId: successor.controllerCheckAppId,
  };
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

  const transitionKind = receipt.kind;
  if (!(["runtime", "stage_successor", "activate_successor"] as const).includes(transitionKind)) {
    add(
      issues,
      "AUTHORITY_SUCCESSOR_TRANSITION_INVALID",
      receipt.rotationId,
      "every rotation must declare one recognized authority transition kind",
    );
  }

  const immutableFields: Array<keyof ClosureAuthorityPolicy> = [
    "schemaVersion",
    "repositoryId",
    "repository",
    "requiredCiWorkflowPath",
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

  const activeIdentityChanged =
    JSON.stringify(activeIdentity(input.basePolicy)) !==
    JSON.stringify(activeIdentity(input.proposedPolicy));
  if (transitionKind !== "activate_successor" && activeIdentityChanged) {
    add(
      issues,
      transitionKind === "stage_successor"
        ? "AUTHORITY_SUCCESSOR_STAGE_ACTIVE_DRIFT"
        : "AUTHORITY_ROTATION_IDENTITY_DRIFT",
      input.basePolicy.workflowPath,
      "the active workflow and check identity cannot change before a staged successor is activated",
    );
  }

  if (transitionKind === "runtime") {
    if (receipt.successor !== null || !exactSuccessorTuple(input.basePolicy.successor, input.proposedPolicy.successor)) {
      add(
        issues,
        "AUTHORITY_SUCCESSOR_TRANSITION_INVALID",
        receipt.rotationId,
        "a runtime rotation cannot stage, activate, or rewrite successor state",
      );
    }
  } else if (!validSuccessorTuple(receipt.successor)) {
    add(
      issues,
      "AUTHORITY_SUCCESSOR_TUPLE_INVALID",
      receipt.rotationId,
      "successor transitions require a normalized pinned workflow, unique checks, positive App IDs, and canonical deadline",
    );
  } else if (transitionKind === "stage_successor") {
    const successor = receipt.successor;
    const staged = input.basePolicy.successor;
    const isRestage = staged !== null && staged !== undefined;
    const stagedByReceipt = isRestage
      ? baseRotations.find((candidate) => candidate.rotationId === staged.stagedByRotationId) ?? null
      : null;
    const expectedState: AuthoritySuccessorState = {
      phase: "staged",
      stagedByRotationId: receipt.rotationId,
      activatedByRotationId: null,
      ...successor,
    };
    const deadline = Date.parse(successor.activationDeadline);
    if (
      JSON.stringify(input.proposedPolicy.successor) !== JSON.stringify(expectedState)
    ) {
      add(
        issues,
        "AUTHORITY_SUCCESSOR_STAGE_STATE_INVALID",
        receipt.rotationId,
        "staging must create one exact successor state bound to the current rotation",
      );
    }
    if (
      staged === undefined || (isRestage && (
        !validSuccessorTuple(staged) ||
        staged.phase !== "staged" ||
        staged.activatedByRotationId !== null ||
        stagedByReceipt?.kind !== "stage_successor" ||
        !exactSuccessorTuple(stagedByReceipt.successor, staged)
      ))
    ) {
      add(
        issues,
        "AUTHORITY_SUCCESSOR_RESTAGE_AUTHORITY_INVALID",
        staged?.stagedByRotationId ?? receipt.rotationId,
        "re-staging requires the immutable stage receipt for the exact unactivated successor tuple",
      );
    }
    if (isRestage && !exactSuccessorRestageIdentity(staged, successor)) {
      add(
        issues,
        "AUTHORITY_SUCCESSOR_RESTAGE_TUPLE_DRIFT",
        receipt.rotationId,
        "re-staging may change only the workflow digest and canonical activation deadline",
      );
    }
    if (
      successor.workflowPath === input.basePolicy.workflowPath ||
      new Set([
        input.basePolicy.externalCheckName,
        input.basePolicy.controllerCheckName,
        successor.externalCheckName,
        successor.controllerCheckName,
      ]).size !== 4
    ) {
      add(
        issues,
        "AUTHORITY_SUCCESSOR_CONTEXT_COLLISION",
        successor.workflowPath,
        "the successor workflow and both check contexts must be distinct from the active authority",
      );
    }
    if (
      deadline < observedAt ||
      deadline <= issuedAt ||
      deadline - issuedAt > MAX_ROTATION_VALIDITY_MS
    ) {
      add(
        issues,
        "AUTHORITY_SUCCESSOR_ACTIVATION_DEADLINE_INVALID",
        receipt.rotationId,
        "a staged successor must be activated within a canonical seven-day window",
      );
    }
    const baseSuccessorDigest = staged?.workflowSha256 ?? successor.workflowSha256;
    if (
      input.basePolicy.protectedFiles[successor.templatePath] !== baseSuccessorDigest ||
      (isRestage && input.basePolicy.protectedFiles[successor.workflowPath] !== baseSuccessorDigest) ||
      input.proposedPolicy.protectedFiles[successor.templatePath] !== successor.workflowSha256 ||
      input.proposedPolicy.protectedFiles[successor.workflowPath] !== successor.workflowSha256 ||
      input.proposedFileDigests.get(successor.templatePath) !== successor.workflowSha256 ||
      input.proposedFileDigests.get(successor.workflowPath) !== successor.workflowSha256 ||
      !input.proposedFileContents.get(successor.templatePath)?.equals(
        input.proposedFileContents.get(successor.workflowPath) ?? Buffer.alloc(0),
      )
    ) {
      add(
        issues,
        "AUTHORITY_SUCCESSOR_WORKFLOW_NOT_PINNED",
        successor.workflowPath,
        "staging must copy one exact inert base-protected template into the executable successor workflow without changing its bytes",
      );
    }
    if (
      successor.externalCheckAppId !== input.basePolicy.externalCheckAppId ||
      successor.controllerCheckAppId !== input.basePolicy.controllerCheckAppId
    ) {
      add(
        issues,
        "AUTHORITY_SUCCESSOR_APP_IDENTITY_DRIFT",
        successor.workflowPath,
        "the successor must retain the active external and controller App identities used by the protected credentials",
      );
    }
    if (
      input.proposedPolicy.protectedFiles[input.basePolicy.workflowPath] !==
      input.basePolicy.protectedFiles[input.basePolicy.workflowPath]
    ) {
      add(
        issues,
        "AUTHORITY_SUCCESSOR_PREDECESSOR_NOT_RETAINED",
        input.basePolicy.workflowPath,
        "staging must retain the active predecessor workflow unchanged",
      );
    }
  } else if (transitionKind === "activate_successor") {
    const successor = receipt.successor;
    const staged = input.basePolicy.successor;
    if (
      !staged ||
      staged.phase !== "staged" ||
      staged.activatedByRotationId !== null ||
      baseReceipt?.kind !== "stage_successor" ||
      baseReceipt.rotationId !== staged.stagedByRotationId ||
      !exactSuccessorTuple(baseReceipt.successor, successor) ||
      !exactSuccessorTuple(staged, successor) ||
      input.proposedPolicy.successor !== null
    ) {
      add(
        issues,
        "AUTHORITY_SUCCESSOR_ACTIVATION_STATE_INVALID",
        receipt.rotationId,
        "activation must immediately follow and clear the exact staged successor state",
      );
    }
    if (JSON.stringify(activeIdentity(input.proposedPolicy)) !== JSON.stringify(successorActiveIdentity(successor))) {
      add(
        issues,
        "AUTHORITY_SUCCESSOR_ACTIVATION_IDENTITY_INVALID",
        receipt.rotationId,
        "the proposed active workflow and check identity must equal the staged successor tuple",
      );
    }
    if (
      successor.externalCheckAppId !== input.basePolicy.externalCheckAppId ||
      successor.controllerCheckAppId !== input.basePolicy.controllerCheckAppId
    ) {
      add(
        issues,
        "AUTHORITY_SUCCESSOR_APP_IDENTITY_DRIFT",
        successor.workflowPath,
        "activation must retain the App identities already bound to the predecessor and protected credentials",
      );
    }
    if (observedAt > Date.parse(successor.activationDeadline)) {
      add(
        issues,
        "AUTHORITY_SUCCESSOR_ACTIVATION_EXPIRED",
        receipt.rotationId,
        "successor activation must complete before its staged deadline",
      );
    }
    if (
      input.basePolicy.protectedFiles[successor.workflowPath] !== successor.workflowSha256 ||
      input.proposedPolicy.protectedFiles[successor.workflowPath] !== successor.workflowSha256 ||
      input.proposedFileDigests.get(successor.workflowPath) !== successor.workflowSha256 ||
      input.changedFiles.some((change) => change.path === successor.workflowPath)
    ) {
      add(
        issues,
        "AUTHORITY_SUCCESSOR_STAGED_BYTES_DRIFT",
        successor.workflowPath,
        "activation cannot change the successor bytes that were staged and proven from main",
      );
    }
    const predecessorDeletion = input.changedFiles.find(
      (change) => change.path === input.basePolicy.workflowPath,
    );
    if (
      input.basePolicy.workflowPath === successor.workflowPath ||
      input.basePolicy.protectedFiles[input.basePolicy.workflowPath] === undefined ||
      input.basePolicy.workflowPath in input.proposedPolicy.protectedFiles ||
      input.proposedPaths.has(input.basePolicy.workflowPath) ||
      !predecessorDeletion ||
      predecessorDeletion.fromSha256 !== input.basePolicy.protectedFiles[input.basePolicy.workflowPath] ||
      predecessorDeletion.toSha256 !== null ||
      predecessorDeletion.fromMode === null ||
      predecessorDeletion.toMode !== null
    ) {
      add(
        issues,
        "AUTHORITY_SUCCESSOR_PREDECESSOR_NOT_REMOVED",
        input.basePolicy.workflowPath,
        "activation must atomically remove the exact predecessor workflow after the dual-authority handoff",
      );
    }
    for (const [path, expectedDigest] of Object.entries(input.basePolicy.protectedFiles)) {
      if (path === input.basePolicy.workflowPath) continue;
      if (input.proposedPolicy.protectedFiles[path] !== expectedDigest) {
        add(
          issues,
          "AUTHORITY_SUCCESSOR_STAGED_BYTES_DRIFT",
          path,
          "activation cannot combine the handoff with changes to staged authority bytes",
        );
      }
    }
  }

  if (
    transitionKind !== "activate_successor" &&
    input.changedFiles.some((change) => change.path === input.basePolicy.workflowPath)
  ) {
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
    /^config\/production-closure-successors\/closure-authority-[a-z0-9-]+\.yml$/.test(path) ||
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
    if (transitionKind === "activate_successor" && path === input.basePolicy.workflowPath) continue;
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
