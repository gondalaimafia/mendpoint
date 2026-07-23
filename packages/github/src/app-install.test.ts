import { describe, expect, it } from "vitest";
import { buildInstallUrl, getGitHubAppConfig, normalizeMockInstall } from "./app-install.js";

describe("github app install", () => {
  it("defaults to mock mode without app id", () => {
    const prev = process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_ID;
    const cfg = getGitHubAppConfig();
    expect(cfg.mockMode).toBe(true);
    const url = buildInstallUrl({ baseUrl: "http://localhost:3001" });
    expect(url.mock).toBe(true);
    expect(url.url).toContain("/github/app/mock-install");
    if (prev !== undefined) process.env.GITHUB_APP_ID = prev;
  });

  it("normalizes mock install payload", () => {
    const n = normalizeMockInstall({ accountLogin: "acme" });
    expect(n.accountLogin).toBe("acme");
    expect(n.repositories?.[0]?.name).toBe("shop-app");
    expect(n.installationId).toBeTruthy();
  });
});
