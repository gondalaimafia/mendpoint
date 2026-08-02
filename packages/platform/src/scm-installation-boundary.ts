import { createHash } from "node:crypto";

export type ScmPermissionLevel = "read" | "write";

export type ScmRepositoryBinding = Readonly<{
  repositoryId: string;
  owner: string;
  name: string;
}>;

export type ScmInstallationBinding = Readonly<{
  provider: "github" | "gitlab" | "bitbucket" | "azure_devops";
  tenantId: string;
  installationId: string;
  installationRevision: number;
  state: "active" | "suspended" | "revoked";
  repositories: readonly ScmRepositoryBinding[];
  permissions: Readonly<Record<string, ScmPermissionLevel>>;
}>;

export type ScmDraftDeliveryIntent = Readonly<{
  provider: ScmInstallationBinding["provider"];
  tenantId: string;
  installationId: string;
  repository: ScmRepositoryBinding;
  snapshotSha: string;
  candidateDigest: string;
  headBranch: string;
  baseBranch: string;
  draft: true;
  autoMerge: false;
  autoDeploy: false;
}>;

export type ScmDraftDeliveryAuthorization = Readonly<{
  provider: ScmInstallationBinding["provider"];
  tenantId: string;
  installationId: string;
  installationRevision: number;
  repositoryId: string;
  repositoryOwner: string;
  repositoryName: string;
  snapshotSha: string;
  candidateDigest: string;
  headBranch: string;
  baseBranch: string;
  intentDigest: string;
  draft: true;
  autoMerge: false;
  autoDeploy: false;
}>;

export type ScmInstallationBoundaryErrorCode =
  | "INSTALLATION_INACTIVE"
  | "INSTALLATION_SCOPE_DENIED"
  | "REPOSITORY_SCOPE_DENIED"
  | "PERMISSION_DRIFT"
  | "DELIVERY_INTENT_INVALID";

export class ScmInstallationBoundaryError extends Error {
  constructor(
    readonly code: ScmInstallationBoundaryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ScmInstallationBoundaryError";
  }
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const BRANCH = /^(?!\/)(?!.*(?:\.\.|\/\/))[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function levelSatisfies(actual: ScmPermissionLevel | undefined, required: ScmPermissionLevel): boolean {
  return actual === "write" || (actual === "read" && required === "read");
}

/**
 * Provider neutral, pure authorization gate. It binds an immutable draft-only
 * delivery intent to the current installation revision and repository scope.
 */
export function authorizeScmDraftDelivery(input: {
  installation: ScmInstallationBinding;
  intent: ScmDraftDeliveryIntent;
  requiredPermissions: Readonly<Record<string, ScmPermissionLevel>>;
}): ScmDraftDeliveryAuthorization {
  const { installation, intent } = input;
  if (installation.state !== "active") {
    throw new ScmInstallationBoundaryError("INSTALLATION_INACTIVE", "SCM installation is not active");
  }
  if (
    installation.provider !== intent.provider ||
    installation.tenantId !== intent.tenantId ||
    installation.installationId !== intent.installationId
  ) {
    throw new ScmInstallationBoundaryError(
      "INSTALLATION_SCOPE_DENIED",
      "Delivery identity is outside the installation tenant or provider scope",
    );
  }
  const matchingRepositoryIds = installation.repositories.filter(
    (candidate) => candidate.repositoryId === intent.repository.repositoryId,
  );
  const repository = matchingRepositoryIds.find(
    (candidate) =>
      candidate.owner === intent.repository.owner &&
      candidate.name === intent.repository.name,
  );
  if (!repository || matchingRepositoryIds.length !== 1) {
    throw new ScmInstallationBoundaryError(
      "REPOSITORY_SCOPE_DENIED",
      "Repository is not selected for this installation",
    );
  }
  const missing = Object.entries(input.requiredPermissions)
    .filter(([permission, required]) => !levelSatisfies(installation.permissions[permission], required))
    .map(([permission]) => permission)
    .sort();
  if (missing.length) {
    throw new ScmInstallationBoundaryError(
      "PERMISSION_DRIFT",
      `Installation permissions no longer satisfy: ${missing.join(",")}`,
    );
  }
  if (
    !Number.isSafeInteger(installation.installationRevision) ||
    installation.installationRevision < 1 ||
    !IDENTITY.test(intent.repository.repositoryId) ||
    !IDENTITY.test(intent.repository.owner) ||
    !IDENTITY.test(intent.repository.name) ||
    !SHA.test(intent.snapshotSha) ||
    !DIGEST.test(intent.candidateDigest) ||
    !BRANCH.test(intent.headBranch) ||
    !BRANCH.test(intent.baseBranch) ||
    intent.headBranch.endsWith("/") ||
    intent.baseBranch.endsWith("/") ||
    intent.headBranch.endsWith(".lock") ||
    intent.baseBranch.endsWith(".lock") ||
    intent.headBranch.includes("@{") ||
    intent.baseBranch.includes("@{") ||
    intent.headBranch === intent.baseBranch ||
    intent.draft !== true ||
    intent.autoMerge !== false ||
    intent.autoDeploy !== false
  ) {
    throw new ScmInstallationBoundaryError(
      "DELIVERY_INTENT_INVALID",
      "Draft delivery intent is incomplete or permits an unsafe action",
    );
  }
  const canonical = {
    ...intent,
    installationRevision: installation.installationRevision,
  };
  return Object.freeze({
    provider: intent.provider,
    tenantId: intent.tenantId,
    installationId: intent.installationId,
    installationRevision: installation.installationRevision,
    repositoryId: intent.repository.repositoryId,
    repositoryOwner: intent.repository.owner,
    repositoryName: intent.repository.name,
    snapshotSha: intent.snapshotSha,
    candidateDigest: intent.candidateDigest,
    headBranch: intent.headBranch,
    baseBranch: intent.baseBranch,
    intentDigest: createHash("sha256").update(stable(canonical)).digest("hex"),
    draft: true,
    autoMerge: false,
    autoDeploy: false,
  });
}
