import { mkdtempSync, rmSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, upsertGitHubInstallation } from "@mendpoint/db";
import { GitHubAppDelivery, OctokitGitHubDelivery } from "@mendpoint/github";
import { createPipelineDeliveryResolver } from "./index.js";

const directories: string[] = [];
const previous = {
  mode: process.env.GITHUB_MODE,
  token: process.env.GITHUB_TOKEN,
  appId: process.env.GITHUB_APP_ID,
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
};

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
  for (const [name, value] of Object.entries({
    GITHUB_MODE: previous.mode,
    GITHUB_TOKEN: previous.token,
    GITHUB_APP_ID: previous.appId,
    GITHUB_APP_PRIVATE_KEY: previous.privateKey,
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
    delete process.env.GITHUB_TOKEN;
    upsertGitHubInstallation(db, {
      id: "install-a",
      installationId: "12345",
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
    const first = resolver(consumer);
    expect(first).toBeInstanceOf(GitHubAppDelivery);
    expect(resolver(consumer)).toBe(first);
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
    expect(allRepositoriesResolver(consumer)).toBeInstanceOf(GitHubAppDelivery);
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
    expect(() => suspendedResolver(consumer)).toThrow(
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
    expect(() => deletedResolver(consumer)).toThrow(
      "github_app_installation_deleted",
    );
    expect(() => resolver({ ...consumer, installation_id: "99999" })).toThrow(
      "github_app_installation_tenant_mismatch",
    );
    db.raw.close();
  });

  it("uses a configured PAT only for an unbound legacy consumer", () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-delivery-legacy-"));
    directories.push(directory);
    const db = createDb(join(directory, "db.sqlite"));
    process.env.GITHUB_MODE = "real";
    process.env.GITHUB_TOKEN = "fine-grained-pat";
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
    expect(resolver(legacy)).toBeInstanceOf(
      OctokitGitHubDelivery,
    );
    expect(() =>
      resolver({ ...legacy, installation_id: "12345", github_delivery_mode: "app" }),
    ).toThrow(
      "github_app_credentials_required_for_bound_consumer",
    );
    expect(() =>
      resolver({ ...legacy, github_delivery_mode: "revoked" }),
    ).toThrow("github_app_installation_revoked");
    db.raw.close();
  });
});
