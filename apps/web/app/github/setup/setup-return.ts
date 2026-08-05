export type GitHubSetupReturn = {
  state: string;
  installationId: string;
  setupAction: "install" | "update";
};

export function parseGitHubSetupReturn(
  search: string,
  historyState?: unknown,
): GitHubSetupReturn | null {
  const params = new URLSearchParams(search);
  const stored =
    historyState && typeof historyState === "object"
      ? (historyState as { mendpointGitHubSetup?: unknown }).mendpointGitHubSetup
      : undefined;
  const candidate = params.has("state")
    ? {
        state: params.get("state"),
        installationId: params.get("installation_id"),
        setupAction: params.get("setup_action"),
      }
    : stored;
  if (!candidate || typeof candidate !== "object") return null;
  const value = candidate as Record<string, unknown>;
  if (
    typeof value.state !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(value.state) ||
    typeof value.installationId !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value.installationId) ||
    (value.setupAction !== "install" && value.setupAction !== "update")
  ) {
    return null;
  }
  return {
    state: value.state,
    installationId: value.installationId,
    setupAction: value.setupAction,
  };
}

export function githubSetupRetryDelay(attempt: number): number | null {
  const delays = [1_000, 2_000, 4_000, 8_000, 8_000];
  return delays[attempt] ?? null;
}
