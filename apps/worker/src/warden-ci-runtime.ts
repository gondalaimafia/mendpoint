import {
  findAuthorizedGitHubInstallationForRepository,
  getConnectedRepository,
  getScmConnection,
  type AppDb,
} from "@mendpoint/db";
import {
  createAppDelivery,
  InstallationTokenCache,
  loadAppCredentials,
  resolveGitHubTenantAccountBinding,
} from "@mendpoint/github";
import { createGitHubRepositorySource, SecretMaterial, type RepositorySource } from "@mendpoint/platform";

const REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHECK_IDENTITY = /^check:[1-9][0-9]{0,19}:[A-Za-z0-9][A-Za-z0-9 ._\/-]{0,199}$/;

export type WardenCiRepositoryConfig = Readonly<{
  requiredChecks: readonly string[];
  maxCycles: number;
  maxModelCalls: number;
  maximumCostUsd: number;
}>;

export function wardenCiConfigForRepository(
  env: Readonly<Record<string, string | undefined>>,
  repositoryId: string,
): WardenCiRepositoryConfig | undefined {
  const flag = env.MENDPOINT_WARDEN_CI_REENTRY_ENABLED?.trim() ?? "0";
  if (flag === "0") return undefined;
  if (flag !== "1") throw new Error("warden_ci_reentry_flag_invalid");
  if (!REPOSITORY_ID.test(repositoryId)) throw new Error("warden_ci_repository_id_invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(env.MENDPOINT_WARDEN_CI_REENTRY_CONFIG_JSON ?? ""); }
  catch { throw new Error("warden_ci_reentry_config_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("warden_ci_reentry_config_invalid");
  }
  const raw = (parsed as Record<string, unknown>)[repositoryId];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("warden_ci_repository_config_required");
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    "maxCycles", "maxModelCalls", "maximumCostUsd", "requiredChecks",
  ])) throw new Error("warden_ci_repository_config_invalid");
  if (!Array.isArray(record.requiredChecks) || record.requiredChecks.length < 1 ||
      record.requiredChecks.length > 50 || record.requiredChecks.some((value) =>
        typeof value !== "string" || !CHECK_IDENTITY.test(value))) {
    throw new Error("warden_ci_required_checks_invalid");
  }
  const requiredChecks = [...new Set(record.requiredChecks as string[])].sort();
  if (requiredChecks.length !== record.requiredChecks.length) {
    throw new Error("warden_ci_required_checks_invalid");
  }
  if (!Number.isSafeInteger(record.maxCycles) || Number(record.maxCycles) < 1 || Number(record.maxCycles) > 10 ||
      !Number.isSafeInteger(record.maxModelCalls) || Number(record.maxModelCalls) < Number(record.maxCycles) ||
      Number(record.maxModelCalls) > 100 || typeof record.maximumCostUsd !== "number" ||
      !Number.isFinite(record.maximumCostUsd) || record.maximumCostUsd <= 0 || record.maximumCostUsd > 25) {
    throw new Error("warden_ci_budget_invalid");
  }
  return Object.freeze({ requiredChecks: Object.freeze(requiredChecks), maxCycles: Number(record.maxCycles),
    maxModelCalls: Number(record.maxModelCalls), maximumCostUsd: record.maximumCostUsd });
}

function exactRepository(input: Readonly<{
  db: AppDb;
  tenantId: string;
  repositoryId: string;
  remoteRepositoryId: number;
  installationId: number;
  env: NodeJS.ProcessEnv;
}>) {
  if (!Number.isSafeInteger(input.remoteRepositoryId) || input.remoteRepositoryId < 1 ||
      !Number.isSafeInteger(input.installationId) || input.installationId < 1) {
    throw new Error("warden_ci_repository_identity_invalid");
  }
  const repository = getConnectedRepository(input.db, input.repositoryId, input.tenantId);
  const connection = repository
    ? getScmConnection(input.db, repository.connection_id, input.tenantId)
    : undefined;
  if (!repository || repository.status !== "ready" || repository.remote_id !== String(input.remoteRepositoryId) ||
      !connection || connection.provider !== "github" || connection.revoked_at ||
      connection.external_account_id !== String(input.installationId)) {
    throw new Error("warden_ci_repository_authority_mismatch");
  }
  const installation = findAuthorizedGitHubInstallationForRepository(
    input.db,
    input.tenantId,
    repository.owner,
    repository.name,
  );
  const expectedAccountId = resolveGitHubTenantAccountBinding(input.tenantId, input.env);
  if (!installation || !expectedAccountId || installation.account_id !== expectedAccountId ||
      Number(installation.installation_id) !== input.installationId) {
    throw new Error("warden_ci_installation_authority_mismatch");
  }
  let repositories: unknown;
  try { repositories = JSON.parse(installation.repositories_json ?? "null"); }
  catch { throw new Error("warden_ci_installation_authority_mismatch"); }
  if (!Array.isArray(repositories) || !repositories.some((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const value = candidate as Record<string, unknown>;
    return value.id === input.remoteRepositoryId && typeof value.owner === "string" &&
      typeof value.name === "string" && value.owner.toLowerCase() === repository.owner.toLowerCase() &&
      value.name.toLowerCase() === repository.name.toLowerCase();
  })) throw new Error("warden_ci_installation_authority_mismatch");
  return Object.freeze({ repository, connection });
}

export function createWardenCiGitHubRuntime(input: Readonly<{
  db: AppDb;
  tenantId: string;
  repositoryId: string;
  remoteRepositoryId: number;
  installationId: number;
  env: NodeJS.ProcessEnv;
}>) {
  if (input.env.GITHUB_MODE !== "real") throw new Error("warden_ci_real_github_required");
  const connected = exactRepository(input);
  const credentials = loadAppCredentials(input.env);
  if (!credentials) throw new Error("warden_ci_github_app_credentials_required");
  const github = createAppDelivery(input.installationId, credentials, [input.remoteRepositoryId]);
  return Object.freeze({
    owner: connected.repository.owner,
    repo: connected.repository.name,
    observeExactDraft: github.observeExactDraft.bind(github),
    updateExactDraft: github.updateExactDraft.bind(github),
    reconcileExactDraftUpdate: github.reconcileExactDraftUpdate.bind(github),
  });
}

export async function createWardenCiRepositorySource(input: Readonly<{
  db: AppDb;
  tenantId: string;
  repositoryId: string;
  remoteRepositoryId: number;
  installationId: number;
  env: NodeJS.ProcessEnv;
}>): Promise<RepositorySource> {
  if (input.env.GITHUB_MODE !== "real") throw new Error("warden_ci_real_github_required");
  const connected = exactRepository(input);
  const credentials = loadAppCredentials(input.env);
  if (!credentials) throw new Error("warden_ci_github_app_credentials_required");
  const token = await new InstallationTokenCache(
    credentials,
    input.installationId,
    undefined,
    Date.now,
    [input.remoteRepositoryId],
  ).get();
  return createGitHubRepositorySource({
    installationId: String(input.installationId),
    repositoryId: String(input.remoteRepositoryId),
    owner: connected.repository.owner,
    name: connected.repository.name,
    credential: new SecretMaterial(token),
  });
}
