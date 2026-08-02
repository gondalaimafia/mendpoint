import { createHash } from "node:crypto";
import {
  authorizeScmDraftDelivery,
  type ScmDraftDeliveryAuthorization,
  type ScmDraftDeliveryIntent,
  type ScmInstallationBinding,
  type ScmPermissionLevel,
  type ScmRepositoryBinding,
} from "@mendpoint/platform";
import { verifyGitHubSignature } from "./webhooks.js";

export const GITHUB_DRAFT_DELIVERY_PERMISSIONS = Object.freeze({
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  checks: "read",
} satisfies Readonly<Record<string, ScmPermissionLevel>>);

export type GitHubInstallationSeed = Readonly<{
  tenantId: string;
  appId: string;
  installationId: number;
  accountId: number;
  accountLogin: string;
  accountType: "Organization" | "User";
  repositorySelection: "all" | "selected";
  repositories: readonly Readonly<{
    repositoryId: number;
    owner: string;
    name: string;
  }>[];
  permissions: Readonly<Record<string, ScmPermissionLevel>>;
  authorizationStateVerified: true;
}>;

export type GitHubInstallationRecord = ScmInstallationBinding & Readonly<{
  provider: "github";
  appId: string;
  accountId: string;
  accountLogin: string;
  accountType: "Organization" | "User";
  repositorySelection: "all" | "selected";
  reconciledAt: string;
}>;

export type GitHubInstallationTokenRequest = Readonly<{
  tenantId: string;
  appId: string;
  installationId: number;
  repositoryIds: readonly number[];
  permissions: typeof GITHUB_DRAFT_DELIVERY_PERMISSIONS;
}>;

export type GitHubInstallationToken = Readonly<{
  token: string;
  installationId: number;
  repositoryIds: readonly number[];
  permissions: Readonly<Record<string, ScmPermissionLevel>>;
  expiresAt: string;
}>;

export interface GitHubInstallationTokenAdapter {
  exchange(request: GitHubInstallationTokenRequest): Promise<GitHubInstallationToken>;
  revoke?(token: string): Promise<void>;
}

export type GitHubDraftDeliveryIntent = Omit<ScmDraftDeliveryIntent, "provider" | "installationId"> &
  Readonly<{
    provider: "github";
    installationId: string;
  }>;

export type GitHubDraftDeliveryGrant = Readonly<{
  authorization: ScmDraftDeliveryAuthorization;
  accessToken: string;
  tokenExpiresAt: string;
}>;

export type GitHubAppLifecycleErrorCode =
  | "INSTALLATION_IDENTITY_INVALID"
  | "INSTALLATION_ALREADY_BOUND"
  | "INSTALLATION_NOT_FOUND"
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  | "TOKEN_SCOPE_DENIED"
  | "TOKEN_REFRESH_FAILED"
  | "WEBHOOK_UNSIGNED"
  | "WEBHOOK_INVALID"
  | "WEBHOOK_REPLAY_DIVERGED"
  | "INSTALLATION_CHANGED";

export class GitHubAppLifecycleError extends Error {
  constructor(
    readonly code: GitHubAppLifecycleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GitHubAppLifecycleError";
  }
}

/** Adapter operations may use this error to request exactly one fresh token retry. */
export class GitHubInstallationTokenRejectedError extends Error {
  constructor(message = "GitHub rejected the installation token") {
    super(message);
    this.name = "GitHubInstallationTokenRejectedError";
  }
}

type MutableInstallation = {
  tenantId: string;
  appId: string;
  installationId: number;
  accountId: number;
  accountLogin: string;
  accountType: "Organization" | "User";
  repositorySelection: "all" | "selected";
  repositories: Map<number, ScmRepositoryBinding>;
  permissions: Record<string, ScmPermissionLevel>;
  state: "active" | "suspended" | "revoked";
  revision: number;
  reconciledAt: string;
};

type CachedToken = {
  token: string;
  expiresAtMs: number;
  installationRevision: number;
  repositoryId: number;
};

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const DECIMAL_ID = /^[1-9][0-9]{0,15}$/;

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

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function requireIdentity(value: string, field: string): string {
  if (!IDENTITY.test(value)) {
    throw new GitHubAppLifecycleError("INSTALLATION_IDENTITY_INVALID", `${field} is invalid`);
  }
  return value;
}

function repositoryBinding(repository: {
  repositoryId: number;
  owner: string;
  name: string;
}): ScmRepositoryBinding {
  if (!Number.isSafeInteger(repository.repositoryId) || repository.repositoryId < 1) {
    throw new GitHubAppLifecycleError("INSTALLATION_IDENTITY_INVALID", "Repository identity is invalid");
  }
  return Object.freeze({
    repositoryId: String(repository.repositoryId),
    owner: requireIdentity(repository.owner, "Repository owner"),
    name: requireIdentity(repository.name, "Repository name"),
  });
}

function repositoryIdFromIntent(value: string): number {
  if (!DECIMAL_ID.test(value)) {
    throw new GitHubAppLifecycleError("INSTALLATION_IDENTITY_INVALID", "GitHub repository identity is invalid");
  }
  const repositoryId = Number(value);
  if (!Number.isSafeInteger(repositoryId)) {
    throw new GitHubAppLifecycleError("INSTALLATION_IDENTITY_INVALID", "GitHub repository identity is invalid");
  }
  return repositoryId;
}

function normalizePermissions(
  permissions: Readonly<Record<string, ScmPermissionLevel>>,
): Record<string, ScmPermissionLevel> {
  const normalized: Record<string, ScmPermissionLevel> = {};
  for (const [name, level] of Object.entries(permissions)) {
    if (!/^[a-z][a-z_]{0,99}$/.test(name) || (level !== "read" && level !== "write")) {
      throw new GitHubAppLifecycleError("INSTALLATION_IDENTITY_INVALID", "Installation permission is invalid");
    }
    normalized[name] = level;
  }
  return normalized;
}

export class GitHubAppLifecycle {
  readonly #installations = new Map<number, MutableInstallation>();
  readonly #tenantInstallations = new Map<string, number>();
  readonly #tokens = new Map<string, CachedToken>();
  readonly #tokenRefreshes = new Map<string, Promise<CachedToken>>();
  readonly #webhookDeliveries = new Map<string, string>();
  readonly #tokenAdapter: GitHubInstallationTokenAdapter;
  readonly #webhookSecret: string;
  readonly #now: () => Date;
  readonly #refreshLeadMs: number;

  constructor(input: {
    tokenAdapter: GitHubInstallationTokenAdapter;
    webhookSecret: string;
    now?: () => Date;
    refreshLeadMs?: number;
  }) {
    if (!input.webhookSecret || input.webhookSecret.length < 16) {
      throw new GitHubAppLifecycleError("INSTALLATION_IDENTITY_INVALID", "Webhook secret is too short");
    }
    this.#tokenAdapter = input.tokenAdapter;
    this.#webhookSecret = input.webhookSecret;
    this.#now = input.now ?? (() => new Date());
    this.#refreshLeadMs = input.refreshLeadMs ?? 60_000;
  }

  connect(seed: GitHubInstallationSeed): GitHubInstallationRecord {
    if (seed.authorizationStateVerified !== true) {
      throw new GitHubAppLifecycleError("INSTALLATION_IDENTITY_INVALID", "Verified installation state is required");
    }
    requireIdentity(seed.tenantId, "Tenant");
    requireIdentity(seed.appId, "App");
    requireIdentity(seed.accountLogin, "Account login");
    if (
      !Number.isSafeInteger(seed.installationId) || seed.installationId < 1 ||
      !Number.isSafeInteger(seed.accountId) || seed.accountId < 1 ||
      (seed.accountType !== "Organization" && seed.accountType !== "User") ||
      (seed.repositorySelection !== "all" && seed.repositorySelection !== "selected") ||
      !seed.repositories.length
    ) {
      throw new GitHubAppLifecycleError("INSTALLATION_IDENTITY_INVALID", "Installation identity is incomplete");
    }
    const existing = this.#installations.get(seed.installationId);
    const tenantExisting = this.#tenantInstallations.get(seed.tenantId);
    if (existing || (tenantExisting !== undefined && tenantExisting !== seed.installationId)) {
      throw new GitHubAppLifecycleError(
        "INSTALLATION_ALREADY_BOUND",
        "Installation or tenant is already bound and requires explicit reconciliation",
      );
    }
    const repositories = new Map<number, ScmRepositoryBinding>();
    for (const repository of seed.repositories) {
      const normalized = repositoryBinding(repository);
      if (repositories.has(repository.repositoryId)) {
        throw new GitHubAppLifecycleError("INSTALLATION_IDENTITY_INVALID", "Repository identity is duplicated");
      }
      repositories.set(repository.repositoryId, normalized);
    }
    const installation: MutableInstallation = {
      tenantId: seed.tenantId,
      appId: seed.appId,
      installationId: seed.installationId,
      accountId: seed.accountId,
      accountLogin: seed.accountLogin,
      accountType: seed.accountType,
      repositorySelection: seed.repositorySelection,
      repositories,
      permissions: normalizePermissions(seed.permissions),
      state: "active",
      revision: 1,
      reconciledAt: this.#now().toISOString(),
    };
    this.#installations.set(seed.installationId, installation);
    this.#tenantInstallations.set(seed.tenantId, seed.installationId);
    return this.#record(installation);
  }

  getInstallation(tenantId: string): GitHubInstallationRecord {
    const id = this.#tenantInstallations.get(tenantId);
    const installation = id === undefined ? undefined : this.#installations.get(id);
    if (!installation) {
      throw new GitHubAppLifecycleError("INSTALLATION_NOT_FOUND", "Tenant installation is not connected");
    }
    return this.#record(installation);
  }

  async authorizeDraft(intent: GitHubDraftDeliveryIntent, forceRefresh = false): Promise<GitHubDraftDeliveryGrant> {
    const installation = this.#forTenant(intent.tenantId, Number(intent.installationId));
    const authorization = authorizeScmDraftDelivery({
      installation: this.#binding(installation),
      intent,
      requiredPermissions: GITHUB_DRAFT_DELIVERY_PERMISSIONS,
    });
    const repositoryId = repositoryIdFromIntent(intent.repository.repositoryId);
    const token = await this.#token(installation, repositoryId, forceRefresh);
    if (installation.revision !== authorization.installationRevision || installation.state !== "active") {
      throw new GitHubAppLifecycleError(
        "INSTALLATION_CHANGED",
        "Installation changed while delivery authorization was acquired",
      );
    }
    return Object.freeze({
      authorization,
      accessToken: token.token,
      tokenExpiresAt: new Date(token.expiresAtMs).toISOString(),
    });
  }

  async runDraftDelivery<T>(
    intent: GitHubDraftDeliveryIntent,
    operation: (grant: GitHubDraftDeliveryGrant) => Promise<T>,
  ): Promise<T> {
    const initial = await this.authorizeDraft(intent);
    try {
      return await this.#runFenced(intent, initial, operation);
    } catch (error) {
      if (!(error instanceof GitHubInstallationTokenRejectedError)) throw error;
      await this.#discardToken(Number(intent.installationId), repositoryIdFromIntent(intent.repository.repositoryId));
      const refreshed = await this.authorizeDraft(intent, true);
      return this.#runFenced(intent, refreshed, operation);
    }
  }

  async receiveLifecycleWebhook(input: {
    tenantId: string;
    event: "installation" | "installation_repositories";
    deliveryId: string;
    rawBody: string;
    signature256?: string;
  }): Promise<Readonly<{ accepted: true; duplicate: boolean; installationRevision: number }>> {
    if (!verifyGitHubSignature(input.rawBody, input.signature256, this.#webhookSecret, { requireSecret: true })) {
      throw new GitHubAppLifecycleError("WEBHOOK_UNSIGNED", "GitHub lifecycle webhook signature is invalid");
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(input.rawBody) as Record<string, unknown>;
    } catch {
      throw new GitHubAppLifecycleError("WEBHOOK_INVALID", "GitHub lifecycle webhook body is invalid");
    }
    const deliveryKey = requireIdentity(input.deliveryId, "Webhook delivery");
    const fingerprint = digest({ tenantId: input.tenantId, event: input.event, payload });
    const replay = this.#webhookDeliveries.get(deliveryKey);
    if (replay) {
      if (replay !== fingerprint) {
        throw new GitHubAppLifecycleError("WEBHOOK_REPLAY_DIVERGED", "Webhook delivery identity was reused");
      }
      return Object.freeze({
        accepted: true,
        duplicate: true,
        installationRevision: this.getInstallation(input.tenantId).installationRevision,
      });
    }
    const installationPayload = payload.installation as Record<string, unknown> | undefined;
    if (!installationPayload) {
      throw new GitHubAppLifecycleError("WEBHOOK_INVALID", "Webhook installation is missing");
    }
    const installationId = Number(installationPayload?.id);
    const installation = this.#forTenant(input.tenantId, installationId);
    const account = installationPayload?.account as Record<string, unknown> | undefined;
    if (
      Number(account?.id) !== installation.accountId ||
      String(account?.login ?? "") !== installation.accountLogin ||
      String(installationPayload?.app_id ?? installation.appId) !== installation.appId
    ) {
      throw new GitHubAppLifecycleError("WEBHOOK_INVALID", "Webhook installation identity does not match its tenant binding");
    }
    const action = String(payload.action ?? "");
    let nextState = installation.state;
    let nextRepositories = new Map(installation.repositories);
    let nextPermissions = { ...installation.permissions };
    let nextRepositorySelection = installation.repositorySelection;
    if (input.event === "installation_repositories") {
      if (action !== "added" && action !== "removed") {
        throw new GitHubAppLifecycleError("WEBHOOK_INVALID", "Repository lifecycle action is invalid");
      }
      const key = action === "added" ? "repositories_added" : "repositories_removed";
      const repositories = this.#webhookRepositories(payload[key]);
      for (const repository of repositories) {
        if (action === "added") nextRepositories.set(Number(repository.repositoryId), repository);
        else nextRepositories.delete(Number(repository.repositoryId));
      }
    } else if (action === "deleted") {
      nextState = "revoked";
    } else if (action === "suspend") {
      nextState = "suspended";
    } else if (action === "unsuspend" || action === "created") {
      nextState = "active";
    } else if (action === "new_permissions_accepted") {
      nextPermissions = this.#webhookPermissions(installationPayload.permissions);
    } else {
      throw new GitHubAppLifecycleError("WEBHOOK_INVALID", "Installation lifecycle action is invalid");
    }
    if (installationPayload.permissions && action !== "deleted") {
      nextPermissions = this.#webhookPermissions(installationPayload.permissions);
    }
    if (installationPayload.repository_selection !== undefined && action !== "deleted") {
      const selection = String(installationPayload.repository_selection);
      if (selection !== "all" && selection !== "selected") {
        throw new GitHubAppLifecycleError("WEBHOOK_INVALID", "Webhook repository selection is invalid");
      }
      nextRepositorySelection = selection;
    }
    installation.state = nextState;
    installation.repositories = nextRepositories;
    installation.permissions = nextPermissions;
    installation.repositorySelection = nextRepositorySelection;
    installation.revision += 1;
    installation.reconciledAt = this.#now().toISOString();
    this.#webhookDeliveries.set(deliveryKey, fingerprint);
    // Every lifecycle revision invalidates cached credentials, including
    // repository and permission changes that leave the installation active.
    await this.#discardInstallationTokens(installation.installationId);
    return Object.freeze({ accepted: true, duplicate: false, installationRevision: installation.revision });
  }

  async #runFenced<T>(
    intent: GitHubDraftDeliveryIntent,
    grant: GitHubDraftDeliveryGrant,
    operation: (grant: GitHubDraftDeliveryGrant) => Promise<T>,
  ): Promise<T> {
    const result = await operation(grant);
    const current = this.#forTenant(intent.tenantId, Number(intent.installationId));
    if (current.state !== "active" || current.revision !== grant.authorization.installationRevision) {
      throw new GitHubAppLifecycleError(
        "INSTALLATION_CHANGED",
        "Installation changed during draft pull request delivery",
      );
    }
    return result;
  }

  async #token(
    installation: MutableInstallation,
    repositoryId: number,
    forceRefresh: boolean,
  ): Promise<CachedToken> {
    const key = `${installation.installationId}:${repositoryId}`;
    const nowMs = this.#now().getTime();
    const requestedRevision = installation.revision;
    const cached = this.#tokens.get(key);
    if (
      !forceRefresh && cached && cached.installationRevision === installation.revision &&
      cached.expiresAtMs > nowMs + this.#refreshLeadMs
    ) return cached;
    const inFlight = this.#tokenRefreshes.get(key);
    if (!forceRefresh && inFlight) return inFlight;
    const refresh = this.#refreshToken(installation, repositoryId, cached, requestedRevision);
    this.#tokenRefreshes.set(key, refresh);
    try {
      return await refresh;
    } finally {
      if (this.#tokenRefreshes.get(key) === refresh) this.#tokenRefreshes.delete(key);
    }
  }

  async #refreshToken(
    installation: MutableInstallation,
    repositoryId: number,
    cached: CachedToken | undefined,
    requestedRevision: number,
  ): Promise<CachedToken> {
    const key = `${installation.installationId}:${repositoryId}`;
    if (cached) await this.#discardToken(installation.installationId, repositoryId);
    let exchanged: GitHubInstallationToken;
    try {
      exchanged = await this.#tokenAdapter.exchange({
        tenantId: installation.tenantId,
        appId: installation.appId,
        installationId: installation.installationId,
        repositoryIds: Object.freeze([repositoryId]),
        permissions: GITHUB_DRAFT_DELIVERY_PERMISSIONS,
      });
    } catch (error) {
      throw new GitHubAppLifecycleError(
        "TOKEN_REFRESH_FAILED",
        error instanceof Error ? `Installation token refresh failed: ${error.message}` : "Installation token refresh failed",
      );
    }
    const nowMs = this.#now().getTime();
    const expiresAtMs = Date.parse(exchanged.expiresAt);
    if (!exchanged.token || /[\0\r\n]/.test(exchanged.token) || exchanged.installationId !== installation.installationId) {
      throw new GitHubAppLifecycleError("TOKEN_INVALID", "Installation token response identity is invalid");
    }
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs + this.#refreshLeadMs || expiresAtMs > nowMs + 65 * 60_000) {
      throw new GitHubAppLifecycleError("TOKEN_EXPIRED", "Installation token lifetime is invalid");
    }
    if (
      exchanged.repositoryIds.length !== 1 || exchanged.repositoryIds[0] !== repositoryId ||
      Object.keys(exchanged.permissions).some((permission) => !(permission in GITHUB_DRAFT_DELIVERY_PERMISSIONS)) ||
      Object.entries(GITHUB_DRAFT_DELIVERY_PERMISSIONS).some(
        ([permission, required]) =>
          exchanged.permissions[permission] !== "write" &&
          !(required === "read" && exchanged.permissions[permission] === "read"),
      )
    ) {
      throw new GitHubAppLifecycleError("TOKEN_SCOPE_DENIED", "Installation token is not restricted to the authorized repository and permissions");
    }
    const token = { token: exchanged.token, expiresAtMs, installationRevision: requestedRevision, repositoryId };
    if (installation.state !== "active" || installation.revision !== token.installationRevision) {
      if (this.#tokenAdapter.revoke) await this.#tokenAdapter.revoke(token.token);
      throw new GitHubAppLifecycleError("INSTALLATION_CHANGED", "Installation changed during token refresh");
    }
    this.#tokens.set(key, token);
    return token;
  }

  async #discardToken(installationId: number, repositoryId: number): Promise<void> {
    const key = `${installationId}:${repositoryId}`;
    const token = this.#tokens.get(key);
    this.#tokens.delete(key);
    if (token && this.#tokenAdapter.revoke) await this.#tokenAdapter.revoke(token.token);
  }

  async #discardInstallationTokens(installationId: number): Promise<void> {
    const keys = [...this.#tokens.keys()].filter((key) => key.startsWith(`${installationId}:`));
    for (const key of keys) {
      const repositoryId = Number(key.slice(key.indexOf(":") + 1));
      await this.#discardToken(installationId, repositoryId);
    }
  }

  #forTenant(tenantId: string, installationId: number): MutableInstallation {
    const installation = this.#installations.get(installationId);
    if (!installation || installation.tenantId !== tenantId || this.#tenantInstallations.get(tenantId) !== installationId) {
      throw new GitHubAppLifecycleError("INSTALLATION_NOT_FOUND", "Installation is not bound to this tenant");
    }
    return installation;
  }

  #binding(installation: MutableInstallation): ScmInstallationBinding {
    return Object.freeze({
      provider: "github" as const,
      tenantId: installation.tenantId,
      installationId: String(installation.installationId),
      installationRevision: installation.revision,
      state: installation.state,
      repositories: Object.freeze([...installation.repositories.values()].sort((a, b) => a.repositoryId.localeCompare(b.repositoryId))),
      permissions: Object.freeze({ ...installation.permissions }),
    });
  }

  #record(installation: MutableInstallation): GitHubInstallationRecord {
    return Object.freeze({
      ...this.#binding(installation),
      provider: "github" as const,
      appId: installation.appId,
      accountId: String(installation.accountId),
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      repositorySelection: installation.repositorySelection,
      reconciledAt: installation.reconciledAt,
    });
  }

  #webhookRepositories(value: unknown): ScmRepositoryBinding[] {
    if (!Array.isArray(value) || !value.length) {
      throw new GitHubAppLifecycleError("WEBHOOK_INVALID", "Webhook repository selection is empty");
    }
    return value.map((item) => {
      const repository = item as Record<string, unknown>;
      const owner = (repository.owner as Record<string, unknown> | undefined)?.login ??
        String(repository.full_name ?? "").split("/")[0];
      return repositoryBinding({
        repositoryId: Number(repository.id),
        owner: String(owner ?? ""),
        name: String(repository.name ?? ""),
      });
    });
  }

  #webhookPermissions(value: unknown): Record<string, ScmPermissionLevel> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new GitHubAppLifecycleError("WEBHOOK_INVALID", "Webhook permissions are missing");
    }
    return normalizePermissions(value as Record<string, ScmPermissionLevel>);
  }
}
