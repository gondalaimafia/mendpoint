import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

type RepoPathEnv = Partial<
  Pick<NodeJS.ProcessEnv, "NODE_ENV" | "MENDPOINT_REPOS_DIR">
>;

function configuredReposRoot(env: RepoPathEnv): string {
  const configuredRoot = env.MENDPOINT_REPOS_DIR?.trim();
  if (!configuredRoot) throw new Error("repos_root_not_configured");
  return realpathSync(resolve(configuredRoot));
}

function safeTenantId(tenantId: string): string {
  if (
    tenantId === "." ||
    tenantId === ".." ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tenantId)
  ) {
    throw new Error("tenant_id_not_path_safe");
  }
  return tenantId;
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return Boolean(
    fromRoot &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(fromRoot),
  );
}

/**
 * Production repositories are provisioned below:
 *   MENDPOINT_REPOS_DIR/<tenantId>/<repoKey>
 *
 * Development keeps the existing MENDPOINT_REPOS_DIR/<repoKey> fixture layout.
 * Both modes reject the repository root itself and revalidate real paths so
 * stored paths and symlinks cannot escape their active boundary.
 */
export function canonicalRepoPath(
  inputPath: string,
  tenantId: string,
  env: RepoPathEnv = process.env,
): string {
  const root = configuredReposRoot(env);
  const boundary =
    env.NODE_ENV === "production"
      ? realpathSync(resolve(root, safeTenantId(tenantId)))
      : root;
  const candidate = realpathSync(resolve(inputPath));
  if (!isWithin(boundary, candidate)) {
    throw new Error("repo_path_outside_tenant_root");
  }
  if (!statSync(candidate).isDirectory()) {
    throw new Error("repo_path_not_directory");
  }
  return candidate;
}

export function resolveRepoKey(
  repoKey: string,
  tenantId: string,
  env: RepoPathEnv = process.env,
): string {
  const root = configuredReposRoot(env);
  if (!repoKey || isAbsolute(repoKey)) {
    throw new Error("repo_key_must_be_relative");
  }
  const candidate =
    env.NODE_ENV === "production"
      ? resolve(root, safeTenantId(tenantId), repoKey)
      : resolve(root, repoKey);
  return canonicalRepoPath(candidate, tenantId, env);
}
