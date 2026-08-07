import { describe, expect, it } from "vitest";
import {
  parseGitHubAccountTenantBindings,
  resolveGitHubInstallationTenant,
  resolveGitHubAccountTenantBinding,
  resolveGitHubTenantAccountBinding,
} from "./owner-bindings.js";

describe("GitHub App stable account bindings", () => {
  it("resolves a deploy authority controlled numeric account binding", () => {
    const value = JSON.stringify({ "7123456": "tenant_default" });
    expect(parseGitHubAccountTenantBindings(value).get("7123456")).toBe(
      "tenant_default",
    );
    expect(
      resolveGitHubAccountTenantBinding(7123456, {
        GITHUB_APP_ACCOUNT_TENANT_BINDINGS: value,
      }),
    ).toBe("tenant_default");
    expect(
      resolveGitHubTenantAccountBinding("tenant_default", {
        GITHUB_APP_ACCOUNT_TENANT_BINDINGS: value,
      }),
    ).toBe("7123456");
  });

  it.each([
    "not-json",
    "[]",
    JSON.stringify({ gondalaimafia: "tenant_default" }),
    JSON.stringify({ "0": "tenant_default" }),
    JSON.stringify({ "01": "tenant_default" }),
    JSON.stringify({ "7123456": "../tenant" }),
  ])("rejects invalid binding configuration", (value) => {
    expect(() => parseGitHubAccountTenantBindings(value)).toThrow(
      /github_app_account_binding/,
    );
  });

  it("fails closed on a legacy mutable login binding", () => {
    expect(() => resolveGitHubAccountTenantBinding(7123456, {
      GITHUB_APP_OWNER_TENANT_BINDINGS: '{"gondalaimafia":"tenant_default"}',
    })).toThrow("github_app_legacy_owner_bindings_forbidden");
  });

  it("rejects an ambiguous tenant to account state binding", () => {
    expect(() => resolveGitHubTenantAccountBinding("tenant_default", {
      GITHUB_APP_ACCOUNT_TENANT_BINDINGS:
        '{"7123456":"tenant_default","8123456":"tenant_default"}',
    })).toThrow("github_app_tenant_account_binding_ambiguous");
  });

  it("allows a login rename only when the stable account identity is unchanged", () => {
    expect(resolveGitHubInstallationTenant({
      accountId: "7123456",
      configuredTenantId: undefined,
      existing: { accountId: "7123456", tenantId: "tenant-a" },
    })).toBe("tenant-a");
  });

  it("rejects recycled account identity and cross tenant rebinding", () => {
    expect(() => resolveGitHubInstallationTenant({
      accountId: "8123456",
      configuredTenantId: "tenant-a",
      existing: { accountId: "7123456", tenantId: "tenant-a" },
    })).toThrow("github_installation_account_identity_mismatch");
    expect(() => resolveGitHubInstallationTenant({
      accountId: "7123456",
      configuredTenantId: "tenant-b",
      existing: { accountId: "7123456", tenantId: "tenant-a" },
    })).toThrow("github_installation_tenant_identity_mismatch");
  });

  it("upgrades a legacy record only when a stable binding corroborates its tenant", () => {
    expect(resolveGitHubInstallationTenant({
      accountId: "7123456",
      configuredTenantId: "tenant-a",
      existing: { accountId: null, tenantId: "tenant-a" },
    })).toBe("tenant-a");
    expect(() => resolveGitHubInstallationTenant({
      accountId: "7123456",
      configuredTenantId: undefined,
      existing: { accountId: null, tenantId: "tenant-a" },
    })).toThrow("github_installation_tenant_identity_mismatch");
  });
});
