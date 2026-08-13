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
  installEnabled: boolean;
  disabledReason: string | null;
  webhookPath: string;
  setupCallbackPath: string;
  permissions: Record<string, string>;
  events: string[];
};

export function getGitHubAppConfig(
  env: NodeJS.ProcessEnv = process.env,
): GitHubAppConfig {
  const appId = env.GITHUB_APP_ID ?? null;
  const appSlug = env.GITHUB_APP_SLUG ?? "mendpoint";
  const mockMode = !appId || env.GITHUB_APP_MOCK === "1";
  const hasAppCredentials =
    Boolean(appId) &&
    Boolean(env.GITHUB_APP_PRIVATE_KEY || env.GITHUB_APP_PRIVATE_KEY_PATH);
  // The credentialed install flow unlocks under either the legacy experimental
  // flag or the self-serve connect flag, so a customer can drive "Connect
  // GitHub" themselves once MENDPOINT_SELF_SERVE_CONNECT=1. Real credentials are
  // still required (hasAppCredentials && !mockMode); mock mode is unaffected.
  const configured =
    hasAppCredentials &&
    !mockMode &&
    (env.GITHUB_APP_INSTALL_EXPERIMENTAL === "1" ||
      env.MENDPOINT_SELF_SERVE_CONNECT === "1");
  const installEnabled =
    configured || (env.NODE_ENV !== "production" && mockMode);
  return {
    appId,
    appSlug,
    appName: env.GITHUB_APP_NAME ?? "Mendpoint",
    configured,
    mockMode,
    installEnabled,
    disabledReason: installEnabled
      ? null
      : "GitHub App installation is unavailable for this pilot. Real pull request delivery uses an approved repository scoped GitHub token.",
    webhookPath: "/webhooks/github",
    setupCallbackPath: "/github/setup",
    permissions: {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
      checks: "read",
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
  env?: NodeJS.ProcessEnv;
}): { url: string; mock: boolean; state: string } {
  const env = opts?.env ?? process.env;
  const cfg = getGitHubAppConfig(env);
  if (!cfg.installEnabled) {
    throw new Error(
      cfg.disabledReason ?? "GitHub App installation is unavailable",
    );
  }
  const state = opts?.state ?? `st_${Date.now().toString(36)}`;
  const base = (opts?.baseUrl ?? env.PUBLIC_API_URL ?? "http://localhost:3001").replace(
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
      checks: "read",
    },
  };
}
