import {
  findAuthorizedGitHubInstallationForRepository,
  getConnectedRepository,
  getScmConnection,
  listRepositorySnapshots,
  type AppDb,
} from "@mendpoint/db";
import { resolveGitHubTenantAccountBinding } from "@mendpoint/github";
import type { TransformerDraftRepositoryTarget } from "./transformer-attempt-coordinator.js";

function repositoryIdFromInstallation(
  value: string | null,
  owner: string,
  repo: string,
): number | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(value ?? "null"); } catch { return undefined; }
  if (!Array.isArray(parsed)) return undefined;
  const match = parsed.find((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return typeof item.owner === "string" && typeof item.name === "string" &&
      item.owner.toLowerCase() === owner.toLowerCase() &&
      item.name.toLowerCase() === repo.toLowerCase();
  }) as Record<string, unknown> | undefined;
  const id = Number(match?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function createTransformerDraftRepositoryAuthority(
  db: AppDb,
  env: NodeJS.ProcessEnv = process.env,
): (input: Readonly<{
  tenantId: string;
  repositoryId: string;
  snapshotId: string;
  expectedBaseRevision: string;
}>) => TransformerDraftRepositoryTarget {
  return (input) => {
    const repository = getConnectedRepository(db, input.repositoryId, input.tenantId);
    if (!repository || repository.status !== "ready") {
      throw new Error("transformer_draft_repository_not_ready");
    }
    const connection = getScmConnection(db, repository.connection_id, input.tenantId);
    if (!connection || connection.provider !== "github" || connection.revoked_at) {
      throw new Error("transformer_draft_github_connection_required");
    }
    const snapshot = listRepositorySnapshots(db, input.tenantId, input.repositoryId)
      .find((candidate) => candidate.id === input.snapshotId);
    if (!snapshot || snapshot.resolved_sha !== input.expectedBaseRevision ||
        !snapshot.requested_ref.trim()) {
      throw new Error("transformer_draft_snapshot_binding_mismatch");
    }
    const installation = findAuthorizedGitHubInstallationForRepository(
      db,
      input.tenantId,
      repository.owner,
      repository.name,
    );
    const expectedAccountId = resolveGitHubTenantAccountBinding(input.tenantId, env);
    const installationId = Number(installation?.installation_id);
    const remoteRepositoryId = Number(repository.remote_id);
    const authorizedRepositoryId = installation
      ? repositoryIdFromInstallation(
          installation.repositories_json,
          repository.owner,
          repository.name,
        )
      : undefined;
    if (!installation || !installation.account_id || !expectedAccountId ||
        installation.account_id !== expectedAccountId ||
        !Number.isSafeInteger(installationId) || installationId < 1 ||
        !Number.isSafeInteger(remoteRepositoryId) || remoteRepositoryId < 1 ||
        authorizedRepositoryId !== remoteRepositoryId ||
        Number(connection.external_account_id) !== installationId) {
      throw new Error("transformer_draft_installation_not_authorized");
    }
    return Object.freeze({
      owner: repository.owner,
      repo: repository.name,
      baseBranch: snapshot.requested_ref,
      installationId,
      remoteRepositoryId,
    });
  };
}
