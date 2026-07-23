/**
 * GitHub App install URL + mock callback helpers (Phase E wizard).
 */
export type GitHubAppConfig = {
  appId: string | null;
  appSlug: string;
  /** Public name shown in UI */
  appName: string;
  configured: boolean;
  mockMode: boolean;
  webhookPath: string;
  setupCallbackPath: string;
  permissions: Record<string, string>;
  events: string[];
};

export function getGitHubAppConfig(): GitHubAppConfig {
  const appId = process.env.GITHUB_APP_ID ?? null;
  const appSlug = process.env.GITHUB_APP_SLUG ?? "mendpoint";
  return {
    appId,
    appSlug,
    appName: process.env.GITHUB_APP_NAME ?? "Mendpoint",
    configured: Boolean(appId),
    mockMode: !appId || process.env.GITHUB_APP_MOCK === "1",
    webhookPath: "/webhooks/github",
    setupCallbackPath: "/github/app/callback",
    permissions: {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
      checks: "write",
    },
    events: ["installation", "installation_repositories", "pull_request", "push"],
  };
}

/**
 * Build GitHub App install URL.
 * Real: https://github.com/apps/{slug}/installations/new
 * Mock: local callback that simulates install.
 */
export function buildInstallUrl(opts?: {
  state?: string;
  baseUrl?: string;
}): { url: string; mock: boolean; state: string } {
  const cfg = getGitHubAppConfig();
  const state = opts?.state ?? `st_${Date.now().toString(36)}`;
  const base = (opts?.baseUrl ?? process.env.PUBLIC_API_URL ?? "http://localhost:3001").replace(
    /\/$/,
    "",
  );

  if (cfg.mockMode) {
    return {
      url: `${base}/github/app/mock-install?state=${encodeURIComponent(state)}`,
      mock: true,
      state,
    };
  }

  const slug = cfg.appSlug;
  return {
    url: `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`,
    mock: false,
    state,
  };
}

export type MockInstallInput = {
  accountLogin: string;
  accountType?: "User" | "Organization";
  installationId?: string;
  repositories?: Array<{ owner: string; name: string }>;
  tenantId?: string | null;
};

export function normalizeMockInstall(input: MockInstallInput) {
  return {
    installationId: input.installationId ?? String(Math.floor(10_000 + Math.random() * 90_000)),
    accountLogin: input.accountLogin,
    accountType: input.accountType ?? "Organization",
    repositories: input.repositories ?? [
      { owner: input.accountLogin, name: "shop-app" },
    ],
    tenantId: input.tenantId ?? null,
    permissions: {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
    },
  };
}
