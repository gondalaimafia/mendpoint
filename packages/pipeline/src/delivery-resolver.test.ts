import { mkdtempSync, rmSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  insertConnectedRepository,
  upsertGitHubInstallation,
  upsertScmConnection,
  type AppDb,
} from "@mendpoint/db";
import { GitHubAppDelivery, OctokitGitHubDelivery } from "@mendpoint/github";
import { createPipelineDeliveryResolver } from "./index.js";

const directories: string[] = [];
const previous = {
  mode: process.env.GITHUB_MODE,
  token: process.env.GITHUB_TOKEN,
  appId: process.env.GITHUB_APP_ID,
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
  accountBindings: process.env.GITHUB_APP_ACCOUNT_TENANT_BINDINGS,
  deploymentClass: process.env.MENDPOINT_DEPLOYMENT_CLASS,
  deploymentProfile: process.env.MENDPOINT_DEPLOYMENT_PROFILE,
  tenantId: process.env.MENDPOINT_TENANT_ID,
};

function bindRepository(
  db: AppDb,
  input: {
    tenantId?: string;
    owner?: string;
    repo?: string;
    installationId?: string;
    repositoryId?: string;
  } = {},
) {
  const tenantId = input.tenantId ?? "tenant_default";
  upsertScmConnection(db, {
    id: "connection-a",
    tenantId,
    provider: "github",
    credentialRef: "env://GITHUB_TOKEN",
    externalAccountId: input.installationId ?? "12345",
    displayName: "GitHub",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  insertConnectedRepository(db, {
    id: "repository-a",
    tenantId,
    connectionId: "connection-a",
    remoteId: input.repositoryId ?? "77",
    owner: input.owner ?? "gondalaimafia",
    name: input.repo ?? "private-repo",
    defaultBranch: "main",
    status: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  return {
    scm_connection_id: "connection-a",
    connected_repository_id: "repository-a",
  };
}

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
  for (const [name, value] of Object.entries({
    GITHUB_MODE: previous.mode,
    GITHUB_TOKEN: previous.token,
    GITHUB_APP_ID: previous.appId,
    GITHUB_APP_PRIVATE_KEY: previous.privateKey,
    GITHUB_APP_ACCOUNT_TENANT_BINDINGS: previous.accountBindings,
    MENDPOINT_DEPLOYMENT_CLASS: previous.deploymentClass,
    MENDPOINT_DEPLOYMENT_PROFILE: previous.deploymentProfile,
    MENDPOINT_TENANT_ID: previous.tenantId,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("pipeline GitHub delivery resolver", () => {
  it("uses and caches the tenant verified App installation", () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-delivery-resolver-"));
    directories.push(directory);
    const db = createDb(join(directory, "db.sqlite"));
    process.env.GITHUB_MODE = "real";
    process.env.GITHUB_APP_ID = "99";
    process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.GITHUB_APP_ACCOUNT_TENANT_BINDINGS =
      '{"7123456":"tenant_default"}';
    delete process.env.GITHUB_TOKEN;
    upsertGitHubInstallation(db, {
      id: "install-a",
      installationId: "12345",
      accountId: "7123456",
      accountLogin: "gondalaimafia",
      tenantId: "tenant_default",
      repositorySelection: "selected",
      permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        checks: "read",
      },
      repositories: [{ id: 77, owner: "gondalaimafia", name: "private-repo" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const repository = bindRepository(db);
    const resolver = createPipelineDeliveryResolver(
      { tenantId: "tenant_default", providerSlug: "provider" },
      db,
    );
    const consumer = {
      installation_id: "12345",
      github_delivery_mode: "app" as const,
      github_owner: "gondalaimafia",
      github_repo: "private-repo",
    };
    const first = resolver(consumer, repository);
    expect(first.delivery).toBeInstanceOf(GitHubAppDelivery);
    expect(resolver(consumer, repository).delivery).toBe(first.delivery);
    db.raw
      .prepare(
        `UPDATE github_installations SET repository_selection = 'all'
         WHERE installation_id = '12345'`,
      )
      .run();
    const allRepositoriesResolver = createPipelineDeliveryResolver(
      { tenantId: "tenant_default", providerSlug: "provider" },
      db,
    );
    expect(allRepositoriesResolver(consumer, repository).delivery).toBeInstanceOf(
      GitHubAppDelivery,
    );
    db.raw.prepare(
      "UPDATE connected_repositories SET remote_id = '88' WHERE id = 'repository-a'",
    ).run();
    expect(() =>
      createPipelineDeliveryResolver(
        { tenantId: "tenant_default", providerSlug: "provider" },
        db,
      )(consumer, repository),
    ).toThrow("github_app_repository_identity_mismatch");
    db.raw.prepare(
      "UPDATE connected_repositories SET remote_id = '77' WHERE id = 'repository-a'",
    ).run();
    db.raw
      .prepare(
        `UPDATE github_installations SET suspended_at = '2026-01-01T00:05:00.000Z'
         WHERE installation_id = '12345'`,
      )
      .run();
    const suspendedResolver = createPipelineDeliveryResolver(
      { tenantId: "tenant_default", providerSlug: "provider" },
      db,
    );
    expect(() => suspendedResolver(consumer, repository)).toThrow(
      "github_app_installation_suspended",
    );
    db.raw
      .prepare(
        `UPDATE github_installations
         SET suspended_at = NULL, deleted_at = '2026-01-01T00:06:00.000Z'
         WHERE installation_id = '12345'`,
      )
      .run();
    const deletedResolver = createPipelineDeliveryResolver(
      { tenantId: "tenant_default", providerSlug: "provider" },
      db,
    );
    expect(() => deletedResolver(consumer, repository)).toThrow(
      "github_app_installation_deleted",
    );
    expect(() => resolver({ ...consumer, installation_id: "99999" }, repository)).toThrow(
      "github_app_installation_tenant_mismatch",
    );
    db.raw.close();
  });

  it("rejects missing or mismatched stable account identity at delivery", () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-delivery-identity-"));
    directories.push(directory);
    const db = createDb(join(directory, "db.sqlite"));
    process.env.GITHUB_MODE = "real";
    process.env.GITHUB_APP_ID = "99";
    process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.GITHUB_APP_ACCOUNT_TENANT_BINDINGS =
      '{"7123456":"tenant_default"}';
    delete process.env.GITHUB_TOKEN;
    const installation = {
      id: "install-a",
      installationId: "12345",
      accountLogin: "gondalaimafia",
      tenantId: "tenant_default",
      repositorySelection: "selected" as const,
      permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        checks: "read",
      },
      repositories: [{ id: 77, owner: "gondalaimafia", name: "private-repo" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const consumer = {
      installation_id: "12345",
      github_delivery_mode: "app" as const,
      github_owner: "gondalaimafia",
      github_repo: "private-repo",
    };
    const repository = bindRepository(db);

    try {
      upsertGitHubInstallation(db, installation);
      expect(() =>
        createPipelineDeliveryResolver(
          { tenantId: "tenant_default", providerSlug: "provider" },
          db,
        )(consumer, repository),
      ).toThrow("github_app_installation_account_identity_required");

      db.raw.prepare("DELETE FROM github_installations").run();
      upsertGitHubInstallation(db, { ...installation, accountId: "9999999" });
      expect(() =>
        createPipelineDeliveryResolver(
          { tenantId: "tenant_default", providerSlug: "provider" },
          db,
        )(consumer, repository),
      ).toThrow("github_app_installation_account_identity_mismatch");
    } finally {
      db.raw.close();
    }
  });

  it("uses a configured PAT only for an unbound legacy consumer", () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-delivery-legacy-"));
    directories.push(directory);
    const db = createDb(join(directory, "db.sqlite"));
    process.env.GITHUB_MODE = "real";
    process.env.GITHUB_TOKEN = "fine-grained-pat";
    process.env.MENDPOINT_DEPLOYMENT_CLASS = "disposable_canary";
    process.env.MENDPOINT_TENANT_ID = "tenant_default";
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    const resolver = createPipelineDeliveryResolver(
      { tenantId: "tenant_default", providerSlug: "provider" },
      db,
    );
    const legacy = {
      installation_id: null,
      github_delivery_mode: "legacy_pat" as const,
      github_owner: "legacy",
      github_repo: "repo",
    };
    const repository = bindRepository(db, {
      owner: "legacy",
      repo: "repo",
      repositoryId: "77",
    });
    expect(resolver(legacy, repository).delivery).toBeInstanceOf(
      OctokitGitHubDelivery,
    );
    process.env.MENDPOINT_DEPLOYMENT_PROFILE = " CUSTOMER ";
    expect(() => resolver(legacy, repository)).toThrow(
      "github_pat_customer_profile_forbidden",
    );
    process.env.MENDPOINT_DEPLOYMENT_PROFILE = "demo";
    expect(() =>
      resolver(
        { ...legacy, installation_id: "12345", github_delivery_mode: "app" },
        repository,
      ),
    ).toThrow(
      "github_app_credentials_required_for_bound_consumer",
    );
    expect(() =>
      resolver({ ...legacy, github_delivery_mode: "revoked" }, repository),
    ).toThrow("github_app_installation_revoked");
    db.raw.close();
  });
});
