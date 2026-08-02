import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GITHUB_DRAFT_DELIVERY_PERMISSIONS,
  GitHubAppLifecycle,
  GitHubAppLifecycleError,
  GitHubInstallationTokenRejectedError,
  type GitHubDraftDeliveryIntent,
  type GitHubInstallationSeed,
  type GitHubInstallationToken,
  type GitHubInstallationTokenAdapter,
  type GitHubInstallationTokenRequest,
} from "./app-lifecycle.js";

const WEBHOOK_SECRET = "fixture-webhook-secret-32-bytes";
const START = Date.parse("2026-08-02T12:00:00.000Z");

class FakeTokenAdapter implements GitHubInstallationTokenAdapter {
  readonly requests: GitHubInstallationTokenRequest[] = [];
  readonly revoked: string[] = [];
  exchangeCount = 0;
  response?: (request: GitHubInstallationTokenRequest, count: number) => GitHubInstallationToken | Promise<GitHubInstallationToken>;

  constructor(private readonly now: () => number) {}

  async exchange(request: GitHubInstallationTokenRequest): Promise<GitHubInstallationToken> {
    this.requests.push(request);
    this.exchangeCount += 1;
    if (this.response) return this.response(request, this.exchangeCount);
    return {
      token: `installation-token-${this.exchangeCount}`,
      installationId: request.installationId,
      repositoryIds: request.repositoryIds,
      permissions: request.permissions,
      expiresAt: new Date(this.now() + 60 * 60_000).toISOString(),
    };
  }

  async revoke(token: string): Promise<void> {
    this.revoked.push(token);
  }
}

function seed(overrides: Partial<GitHubInstallationSeed> = {}): GitHubInstallationSeed {
  return {
    tenantId: "tenant-a",
    appId: "app-42",
    installationId: 7001,
    accountId: 8001,
    accountLogin: "acme",
    accountType: "Organization",
    repositorySelection: "selected",
    repositories: [{ repositoryId: 101, owner: "acme", name: "payments" }],
    permissions: GITHUB_DRAFT_DELIVERY_PERMISSIONS,
    authorizationStateVerified: true,
    ...overrides,
  };
}

function intent(overrides: Partial<GitHubDraftDeliveryIntent> = {}): GitHubDraftDeliveryIntent {
  return {
    provider: "github",
    tenantId: "tenant-a",
    installationId: "7001",
    repository: { repositoryId: "101", owner: "acme", name: "payments" },
    snapshotSha: "a".repeat(40),
    candidateDigest: "b".repeat(64),
    headBranch: "mendpoint/runtime-20",
    baseBranch: "main",
    draft: true,
    autoMerge: false,
    autoDeploy: false,
    ...overrides,
  };
}

function fixture() {
  let nowMs = START;
  const adapter = new FakeTokenAdapter(() => nowMs);
  const lifecycle = new GitHubAppLifecycle({
    tokenAdapter: adapter,
    webhookSecret: WEBHOOK_SECRET,
    now: () => new Date(nowMs),
  });
  lifecycle.connect(seed());
  return {
    adapter,
    lifecycle,
    advance(milliseconds: number) {
      nowMs += milliseconds;
    },
  };
}

function signedWebhook(input: {
  lifecycle: GitHubAppLifecycle;
  event: "installation" | "installation_repositories";
  deliveryId: string;
  payload: Record<string, unknown>;
  tenantId?: string;
}) {
  const rawBody = JSON.stringify(input.payload);
  return input.lifecycle.receiveLifecycleWebhook({
    tenantId: input.tenantId ?? "tenant-a",
    event: input.event,
    deliveryId: input.deliveryId,
    rawBody,
    signature256: `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex")}`,
  });
}

function installationPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 7001,
    app_id: "app-42",
    account: { id: 8001, login: "acme" },
    permissions: GITHUB_DRAFT_DELIVERY_PERMISSIONS,
    repository_selection: "selected",
    ...overrides,
  };
}

describe("GitHub App lifecycle", () => {
  it("binds one verified installation to one tenant and immutable repository identities", () => {
    let nowMs = START;
    const adapter = new FakeTokenAdapter(() => nowMs);
    const lifecycle = new GitHubAppLifecycle({
      tokenAdapter: adapter,
      webhookSecret: WEBHOOK_SECRET,
      now: () => new Date(nowMs),
    });
    expect(lifecycle.connect(seed())).toMatchObject({
      provider: "github",
      tenantId: "tenant-a",
      installationId: "7001",
      installationRevision: 1,
      state: "active",
      repositories: [{ repositoryId: "101", owner: "acme", name: "payments" }],
    });
    expect(() => lifecycle.connect(seed({ tenantId: "tenant-b" }))).toThrow(
      expect.objectContaining({ code: "INSTALLATION_ALREADY_BOUND" }),
    );
    expect(() => lifecycle.connect(seed({ installationId: 7002 }))).toThrow(
      expect.objectContaining({ code: "INSTALLATION_ALREADY_BOUND" }),
    );
    expect(() => lifecycle.connect(seed({ tenantId: "tenant-b", installationId: 7002, authorizationStateVerified: false as true }))).toThrow(
      expect.objectContaining({ code: "INSTALLATION_IDENTITY_INVALID" }),
    );
  });

  it("injects an exact repository scoped short lived token only after draft authorization", async () => {
    const { adapter, lifecycle } = fixture();
    const grant = await lifecycle.authorizeDraft(intent());
    expect(grant.authorization).toMatchObject({
      tenantId: "tenant-a",
      installationId: "7001",
      repositoryId: "101",
      repositoryOwner: "acme",
      repositoryName: "payments",
      snapshotSha: "a".repeat(40),
      candidateDigest: "b".repeat(64),
      headBranch: "mendpoint/runtime-20",
      baseBranch: "main",
      draft: true,
      autoMerge: false,
      autoDeploy: false,
    });
    expect(grant.accessToken).toBe("installation-token-1");
    expect(adapter.requests).toEqual([{
      tenantId: "tenant-a",
      appId: "app-42",
      installationId: 7001,
      repositoryIds: [101],
      permissions: GITHUB_DRAFT_DELIVERY_PERMISSIONS,
    }]);
  });

  it("fails closed before token exchange for tenant, repository, permission, and delivery drift", async () => {
    const { adapter, lifecycle } = fixture();
    await expect(lifecycle.authorizeDraft(intent({ tenantId: "tenant-b" }))).rejects.toMatchObject({ code: "INSTALLATION_NOT_FOUND" });
    await expect(lifecycle.authorizeDraft(intent({
      repository: { repositoryId: "102", owner: "acme", name: "other" },
    }))).rejects.toMatchObject({ code: "REPOSITORY_SCOPE_DENIED" });
    await expect(lifecycle.authorizeDraft(intent({ repository: { repositoryId: "1e2", owner: "acme", name: "payments" } }))).rejects.toBeInstanceOf(Error);
    await expect(lifecycle.authorizeDraft(intent({ headBranch: "main" }))).rejects.toMatchObject({ code: "DELIVERY_INTENT_INVALID" });
    expect(adapter.exchangeCount).toBe(0);
  });

  it("deduplicates concurrent exchanges, caches valid tokens, and refreshes near expiry", async () => {
    const { adapter, lifecycle, advance } = fixture();
    let release: (() => void) | undefined;
    adapter.response = async (request, count) => {
      if (count === 1) await new Promise<void>((resolve) => { release = resolve; });
      return {
        token: `installation-token-${count}`,
        installationId: request.installationId,
        repositoryIds: request.repositoryIds,
        permissions: request.permissions,
        expiresAt: new Date(START + count * 60 * 60_000).toISOString(),
      };
    };
    const first = lifecycle.authorizeDraft(intent());
    const second = lifecycle.authorizeDraft(intent());
    await Promise.resolve();
    release?.();
    expect((await Promise.all([first, second])).map((grant) => grant.accessToken)).toEqual([
      "installation-token-1",
      "installation-token-1",
    ]);
    await lifecycle.authorizeDraft(intent());
    expect(adapter.exchangeCount).toBe(1);
    advance(59 * 60_000 + 1);
    await lifecycle.authorizeDraft(intent());
    expect(adapter.exchangeCount).toBe(2);
    expect(adapter.revoked).toEqual(["installation-token-1"]);
  });

  it("retries an adapter operation once with a fresh token and revokes the rejected token", async () => {
    const { adapter, lifecycle } = fixture();
    const attempts: string[] = [];
    const result = await lifecycle.runDraftDelivery(intent(), async (grant) => {
      attempts.push(grant.accessToken);
      if (attempts.length === 1) throw new GitHubInstallationTokenRejectedError();
      return "draft-pr-created";
    });
    expect(result).toBe("draft-pr-created");
    expect(attempts).toEqual(["installation-token-1", "installation-token-2"]);
    expect(adapter.revoked).toEqual(["installation-token-1"]);
    expect(adapter.exchangeCount).toBe(2);
  });

  it("rejects and revokes a token exchange that races repository reconciliation", async () => {
    const { adapter, lifecycle } = fixture();
    let release: (() => void) | undefined;
    adapter.response = async (request) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return {
        token: "raced-installation-token",
        installationId: request.installationId,
        repositoryIds: request.repositoryIds,
        permissions: request.permissions,
        expiresAt: new Date(START + 60 * 60_000).toISOString(),
      };
    };
    const authorization = lifecycle.authorizeDraft(intent());
    while (!release) await Promise.resolve();
    await signedWebhook({
      lifecycle,
      event: "installation_repositories",
      deliveryId: "delivery-during-exchange",
      payload: {
        action: "removed",
        installation: installationPayload(),
        repositories_removed: [{ id: 101, name: "payments", full_name: "acme/payments" }],
      },
    });
    release();
    await expect(authorization).rejects.toMatchObject({ code: "INSTALLATION_CHANGED" });
    expect(adapter.revoked).toEqual(["raced-installation-token"]);
  });

  it("does not retry a second token rejection", async () => {
    const { adapter, lifecycle } = fixture();
    await expect(lifecycle.runDraftDelivery(intent(), async () => {
      throw new GitHubInstallationTokenRejectedError();
    })).rejects.toBeInstanceOf(GitHubInstallationTokenRejectedError);
    expect(adapter.exchangeCount).toBe(2);
  });

  it("rejects expired, cross repository, and over privileged token responses", async () => {
    for (const response of [
      (request: GitHubInstallationTokenRequest): GitHubInstallationToken => ({
        token: "expired",
        installationId: request.installationId,
        repositoryIds: request.repositoryIds,
        permissions: request.permissions,
        expiresAt: new Date(START + 30_000).toISOString(),
      }),
      (request: GitHubInstallationTokenRequest): GitHubInstallationToken => ({
        token: "wrong-repository",
        installationId: request.installationId,
        repositoryIds: [999],
        permissions: request.permissions,
        expiresAt: new Date(START + 60 * 60_000).toISOString(),
      }),
      (request: GitHubInstallationTokenRequest): GitHubInstallationToken => ({
        token: "over-privileged",
        installationId: request.installationId,
        repositoryIds: request.repositoryIds,
        permissions: { ...request.permissions, administration: "write" },
        expiresAt: new Date(START + 60 * 60_000).toISOString(),
      }),
    ]) {
      const { adapter, lifecycle } = fixture();
      adapter.response = response;
      await expect(lifecycle.authorizeDraft(intent())).rejects.toBeInstanceOf(GitHubAppLifecycleError);
    }
  });

  it("reconciles signed repository removal, invalidates the token, and detects replay divergence", async () => {
    const { adapter, lifecycle } = fixture();
    await lifecycle.authorizeDraft(intent());
    const payload = {
      action: "removed",
      installation: installationPayload(),
      repositories_removed: [{ id: 101, name: "payments", full_name: "acme/payments" }],
    };
    await expect(signedWebhook({ lifecycle, event: "installation_repositories", deliveryId: "delivery-1", payload })).resolves.toEqual({
      accepted: true,
      duplicate: false,
      installationRevision: 2,
    });
    await expect(lifecycle.authorizeDraft(intent())).rejects.toMatchObject({ code: "REPOSITORY_SCOPE_DENIED" });
    await expect(signedWebhook({ lifecycle, event: "installation_repositories", deliveryId: "delivery-1", payload })).resolves.toMatchObject({ duplicate: true });
    await expect(signedWebhook({
      lifecycle,
      event: "installation_repositories",
      deliveryId: "delivery-1",
      payload: { ...payload, action: "added", repositories_added: payload.repositories_removed },
    })).rejects.toMatchObject({ code: "WEBHOOK_REPLAY_DIVERGED" });
    expect(adapter.revoked).toEqual(["installation-token-1"]);
  });

  it("reconciles permission drift and denies delivery before token exchange", async () => {
    const { adapter, lifecycle } = fixture();
    await signedWebhook({
      lifecycle,
      event: "installation",
      deliveryId: "delivery-permissions",
      payload: {
        action: "new_permissions_accepted",
        installation: installationPayload({
          permissions: { ...GITHUB_DRAFT_DELIVERY_PERMISSIONS, contents: "read" },
        }),
      },
    });
    await expect(lifecycle.authorizeDraft(intent())).rejects.toMatchObject({ code: "PERMISSION_DRIFT" });
    expect(adapter.exchangeCount).toBe(0);
  });

  it("fences an in flight draft operation when uninstall arrives and revokes cached tokens", async () => {
    const { adapter, lifecycle } = fixture();
    let release: (() => void) | undefined;
    const delivery = lifecycle.runDraftDelivery(intent(), async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return "remote-side-effect-completed";
    });
    while (!release) await Promise.resolve();
    await signedWebhook({
      lifecycle,
      event: "installation",
      deliveryId: "delivery-delete",
      payload: { action: "deleted", installation: installationPayload() },
    });
    release();
    await expect(delivery).rejects.toMatchObject({ code: "INSTALLATION_CHANGED" });
    expect(lifecycle.getInstallation("tenant-a").state).toBe("revoked");
    expect(adapter.revoked).toEqual(["installation-token-1"]);
    await expect(lifecycle.authorizeDraft(intent())).rejects.toMatchObject({ code: "INSTALLATION_INACTIVE" });
  });

  it("rejects unsigned and cross tenant lifecycle webhooks without mutating the installation", async () => {
    const { lifecycle } = fixture();
    const payload = JSON.stringify({ action: "deleted", installation: installationPayload() });
    await expect(lifecycle.receiveLifecycleWebhook({
      tenantId: "tenant-a",
      event: "installation",
      deliveryId: "unsigned",
      rawBody: payload,
      signature256: "sha256=bad",
    })).rejects.toMatchObject({ code: "WEBHOOK_UNSIGNED" });
    await expect(signedWebhook({
      lifecycle,
      tenantId: "tenant-b",
      event: "installation",
      deliveryId: "cross-tenant",
      payload: { action: "deleted", installation: installationPayload() },
    })).rejects.toMatchObject({ code: "INSTALLATION_NOT_FOUND" });
    expect(lifecycle.getInstallation("tenant-a")).toMatchObject({ state: "active", installationRevision: 1 });
  });

  it("validates the whole webhook before applying any repository or selection changes", async () => {
    const { lifecycle } = fixture();
    await expect(signedWebhook({
      lifecycle,
      event: "installation_repositories",
      deliveryId: "invalid-selection",
      payload: {
        action: "added",
        installation: installationPayload({ repository_selection: "invalid" }),
        repositories_added: [{ id: 102, name: "ledger", full_name: "acme/ledger" }],
      },
    })).rejects.toMatchObject({ code: "WEBHOOK_INVALID" });
    expect(lifecycle.getInstallation("tenant-a")).toMatchObject({
      installationRevision: 1,
      repositorySelection: "selected",
      repositories: [{ repositoryId: "101", owner: "acme", name: "payments" }],
    });
  });
});
