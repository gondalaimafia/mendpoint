/**
 * Backfill a `github_installations` row's `account_id` from the authoritative
 * source. Rows created before the additive `account_id` column carry a NULL, and
 * the PR-review webhook refuses every delivery it cannot bind to a concrete
 * account (installation.account_id === String(event.accountId)). A migration
 * cannot fix this: it has no live GitHub call, so it could only invent an
 * identity it cannot verify. This asks GitHub — the authoritative source — what
 * the account id actually is, and writes only the observed answer.
 *
 * The write goes through upsertGitHubInstallation, whose COALESCE(account_id, ?)
 * never overwrites a set value and whose guard throws on a genuine divergence, so
 * this path is a fill, never a rewrite. It is tenant scoped, idempotent, and
 * records an explicit not-observed outcome (changing nothing) when GitHub cannot
 * be reached or reports no account id.
 */
import {
  listGitHubInstallations,
  upsertGitHubInstallation,
  type AppDb,
  type GitHubInstallationRow,
} from "@mendpoint/db";
import {
  createAppJwt,
  defaultFetchInstallationMetadata,
  loadAppCredentials,
  type AppCredentials,
  type InstallationAccount,
  type InstallationMetadataFetcher,
} from "@mendpoint/github";
import { nowIso } from "@mendpoint/shared";

const GITHUB_ACCOUNT_ID = /^[1-9][0-9]{0,19}$/;

/**
 * The authoritative-source seam. Given a numeric installation id, returns what
 * GitHub reports for that installation as the App. Injectable so tests never
 * touch the network; production wires it to a JWT-authenticated metadata read.
 */
export type FetchInstallationAccount = (
  installationId: number,
) => Promise<InstallationAccount>;

/**
 * Outcome of reconciling one installation. A discriminated set of distinguishable
 * states so a caller (and the operator reading the CLI output) can never confuse
 * "we filled it", "already correct", "GitHub gave us no answer", and "the stored
 * value contradicts GitHub". The last is surfaced loudly and is never a write.
 */
export type InstallationAccountReconcileResult = Readonly<{
  installationId: string;
  tenantId: string | null;
  outcome: "filled" | "already_set" | "not_observed" | "mismatch";
  existingAccountId: string | null;
  observedAccountId: string | null;
  reason: string | null;
}>;

/**
 * Reconcile a single installation's account id against GitHub. Only ever fills a
 * NULL: the write goes through upsertGitHubInstallation, whose COALESCE keeps a
 * set value and whose guard throws on divergence. An already-correct row is a
 * true no-op (no write), and an absent answer changes nothing.
 */
export async function reconcileInstallationAccount(
  input: Readonly<{
    db: AppDb;
    installation: GitHubInstallationRow;
    fetchAccount: FetchInstallationAccount;
    now?: () => string;
  }>,
): Promise<InstallationAccountReconcileResult> {
  const { db, installation } = input;
  const now = input.now ?? nowIso;
  const base = {
    installationId: installation.installation_id,
    tenantId: installation.tenant_id,
    existingAccountId: installation.account_id,
  } as const;

  let observed: InstallationAccount;
  try {
    observed = await input.fetchAccount(Number(installation.installation_id));
  } catch (error) {
    // GitHub could not be reached. Absence of an answer must never become a
    // written value, so record the not-observed outcome and change nothing.
    return Object.freeze({
      ...base,
      outcome: "not_observed",
      observedAccountId: null,
      reason:
        error instanceof Error ? error.message.slice(0, 200) : "github_unreachable",
    });
  }

  const observedAccountId =
    observed.accountId !== null &&
    GITHUB_ACCOUNT_ID.test(String(observed.accountId))
      ? String(observed.accountId)
      : null;
  if (!observedAccountId) {
    // GitHub answered but named no account id. Still not-observed: nothing to write.
    return Object.freeze({
      ...base,
      outcome: "not_observed",
      observedAccountId: null,
      reason: "github_reported_no_account_id",
    });
  }

  // Already correct. A true no-op: no write, so a repeat run is a no-op too.
  if (installation.account_id && installation.account_id === observedAccountId) {
    return Object.freeze({
      ...base,
      outcome: "already_set",
      observedAccountId,
      reason: null,
    });
  }

  try {
    upsertGitHubInstallation(db, {
      id: installation.id,
      installationId: installation.installation_id,
      accountId: observedAccountId,
      accountLogin: installation.account_login,
      accountType: installation.account_type,
      tenantId: installation.tenant_id,
      repositorySelection: installation.repository_selection,
      suspendedAt: installation.suspended_at,
      deletedAt: installation.deleted_at,
      createdAt: installation.created_at,
      updatedAt: now(),
    });
  } catch (error) {
    // A set-but-different account id is a genuine contradiction between our record
    // and GitHub. The upsert guard throws rather than overwriting; surface it
    // loudly instead of silently proceeding.
    if (
      error instanceof Error &&
      error.message === "github_installation_account_mismatch"
    ) {
      return Object.freeze({
        ...base,
        outcome: "mismatch",
        observedAccountId,
        reason: "github_installation_account_mismatch",
      });
    }
    throw error;
  }

  return Object.freeze({
    ...base,
    outcome: "filled",
    observedAccountId,
    reason: null,
  });
}

/**
 * Reconcile every installation under one tenant whose account id is NULL. Tenant
 * scoped by construction: listGitHubInstallations filters to the tenant and the
 * upsert refuses a cross-tenant write. Idempotent: once filled, a row is no longer
 * NULL, so a second run finds nothing to do. Optionally narrowed to a single
 * installation id for a precise production run.
 */
export async function reconcileNullInstallationAccounts(
  input: Readonly<{
    db: AppDb;
    tenantId: string;
    fetchAccount: FetchInstallationAccount;
    installationId?: string;
    now?: () => string;
  }>,
): Promise<InstallationAccountReconcileResult[]> {
  const { db, tenantId } = input;
  if (!tenantId.trim()) throw new Error("installation_reconcile_tenant_required");
  const candidates = listGitHubInstallations(db, tenantId).filter(
    (installation) =>
      !installation.account_id &&
      !installation.deleted_at &&
      (input.installationId === undefined ||
        installation.installation_id === input.installationId),
  );
  const results: InstallationAccountReconcileResult[] = [];
  for (const installation of candidates) {
    results.push(
      await reconcileInstallationAccount({
        db,
        installation,
        fetchAccount: input.fetchAccount,
        ...(input.now ? { now: input.now } : {}),
      }),
    );
  }
  return results;
}

/**
 * Build the authoritative-source seam from real App credentials. The metadata
 * read authenticates with a fresh App JWT (not an installation token), so it makes
 * no assumption about the identity it is trying to observe. Refuses unless
 * GITHUB_MODE=real with credentials present: this observes production identity and
 * must never run against a deterministic mock.
 */
export function createInstallationAccountFetcher(
  env: NodeJS.ProcessEnv = process.env,
  credentials?: AppCredentials | null,
  fetchMetadata: InstallationMetadataFetcher = defaultFetchInstallationMetadata,
): FetchInstallationAccount {
  if ((env.GITHUB_MODE ?? "mock") !== "real") {
    throw new Error("installation_reconcile_requires_github_mode_real");
  }
  const creds = credentials ?? loadAppCredentials(env);
  if (!creds) throw new Error("github_app_credentials_missing");
  return (installationId) => {
    if (!Number.isSafeInteger(installationId) || installationId < 1) {
      return Promise.reject(new Error("github_installation_id_invalid"));
    }
    const jwt = createAppJwt(creds.appId, creds.privateKeyPem);
    return fetchMetadata(installationId, jwt);
  };
}
