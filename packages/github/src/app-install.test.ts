import { describe, expect, it } from "vitest";
import { buildInstallUrl, getGitHubAppConfig, normalizeMockInstall } from "./app-install.js";

describe("github app install", () => {
  it("allows mock installation outside production without app id", () => {
    const env = { NODE_ENV: "test" };
    const cfg = getGitHubAppConfig(env);
    expect(cfg.mockMode).toBe(true);
    expect(cfg.installEnabled).toBe(true);
    const url = buildInstallUrl({
      baseUrl: "http://localhost:3001",
      env,
    });
    expect(url.mock).toBe(true);
    expect(url.url).toContain("/github/app/mock-install");
  });

  it("does not claim real App readiness without the experimental flag", () => {
    const env = {
      NODE_ENV: "production",
      GITHUB_APP_ID: "123",
      GITHUB_APP_SLUG: "mendpoint",
      GITHUB_APP_PRIVATE_KEY: "private-key",
    };
    const cfg = getGitHubAppConfig(env);
    expect(cfg.configured).toBe(false);
    expect(cfg.mockMode).toBe(false);
    expect(cfg.installEnabled).toBe(false);
    expect(cfg.disabledReason).toContain("repository scoped GitHub token");
    expect(() => buildInstallUrl({ env })).toThrow(/unavailable for this pilot/i);
  });

  it("enables the incomplete real App flow only with an explicit flag", () => {
    expect(
      getGitHubAppConfig({
        NODE_ENV: "production",
        GITHUB_APP_ID: "123",
        GITHUB_APP_INSTALL_EXPERIMENTAL: "1",
      }).configured,
    ).toBe(false);

    const env = {
      NODE_ENV: "production",
      GITHUB_APP_ID: "123",
      GITHUB_APP_SLUG: "mendpoint-preview",
      GITHUB_APP_PRIVATE_KEY: "private-key",
      GITHUB_APP_INSTALL_EXPERIMENTAL: "1",
    };
    const cfg = getGitHubAppConfig(env);
    expect(cfg.configured).toBe(true);
    expect(cfg.installEnabled).toBe(true);
    const url = buildInstallUrl({ state: "state", env });
    expect(url).toEqual({
      url: "https://github.com/apps/mendpoint-preview/installations/new?state=state",
      mock: false,
      state: "state",
    });
  });

  it("normalizes mock install payload", () => {
    const n = normalizeMockInstall({ accountLogin: "acme" });
    expect(n.accountLogin).toBe("acme");
    expect(n.repositories?.[0]?.name).toBe("shop-app");
    expect(n.installationId).toBeTruthy();
  });
});
