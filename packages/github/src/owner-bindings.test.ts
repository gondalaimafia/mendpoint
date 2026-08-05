import { describe, expect, it } from "vitest";
import {
  parseGitHubOwnerTenantBindings,
  resolveGitHubOwnerTenantBinding,
} from "./owner-bindings.js";

describe("GitHub App owner bindings", () => {
  it("resolves a deploy authority controlled binding case insensitively", () => {
    const value = JSON.stringify({ gondalaimafia: "tenant_default" });
    expect(parseGitHubOwnerTenantBindings(value).get("gondalaimafia")).toBe(
      "tenant_default",
    );
    expect(
      resolveGitHubOwnerTenantBinding("GondalaiMafia", {
        GITHUB_APP_OWNER_TENANT_BINDINGS: value,
      }),
    ).toBe("tenant_default");
  });

  it.each([
    "not-json",
    "[]",
    JSON.stringify({ "bad owner": "tenant_default" }),
    JSON.stringify({ gondalaimafia: "../tenant" }),
  ])("rejects invalid binding configuration", (value) => {
    expect(() => parseGitHubOwnerTenantBindings(value)).toThrow(
      /github_app_owner_binding/,
    );
  });
});
