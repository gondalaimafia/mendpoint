/**
 * CI/CD connector family.
 *
 * Generalizes "read build/test status for a repo/PR" behind one interface, so
 * the verification / test-results surfaces can consume CI signal from any
 * provider the same way GitHub Checks already flow in
 * (`packages/github/src/checks.ts`). Proven with two implementations —
 * GitHub Actions and GitLab CI — each with a mock (default, no credential) and a
 * real HTTP path (code-complete, credential-gated via an injectable fetch seam).
 */
import { createHash } from "node:crypto";
import { nowIso } from "@mendpoint/shared";
import { BaseConnector } from "./base.js";
import {
  ConnectorError,
  defaultConnectorFetch,
  resolveConnectorMode,
  type CiProvider,
  type Connector,
  type ConnectorFetch,
  type ConnectorMode,
} from "./connector.js";

export type BuildState = "passed" | "failed" | "running" | "unknown";

export type BuildCheck = Readonly<{
  name: string;
  passed: boolean;
  detail?: string;
}>;

/** Provider-neutral build/test status for a repo at a ref (branch or PR head). */
export type BuildStatus = Readonly<{
  provider: CiProvider;
  repo: string;
  ref: string;
  state: BuildState;
  checks: readonly BuildCheck[];
  url: string | null;
  observedAt: string;
}>;

export interface CiConnector extends Connector {
  readonly kind: "ci";
  readonly provider: CiProvider;
  /** Read the latest build/test status for a repo at a ref. */
  readBuildStatus(input: { repo: string; ref: string }): Promise<BuildStatus>;
}

export type CiConnectorConfig = Readonly<{
  provider: CiProvider;
  mode?: ConnectorMode;
  /** Real-mode credential accessor (installation/PAT token). Required in real mode. */
  token?: string;
  /** Real-mode API base override (self-managed GitLab / GHES). */
  apiBaseUrl?: string;
  /** Injected HTTP seam for deterministic tests. */
  fetch?: ConnectorFetch;
}>;

/** Deterministic mock build status derived from repo/ref, no credential needed. */
function mockBuildStatus(provider: CiProvider, repo: string, ref: string): BuildStatus {
  const digest = createHash("sha256").update(`${provider}\n${repo}\n${ref}`).digest();
  // Deterministic but varied: ~1 in 4 refs "fails" so tests can assert both.
  const failing = digest[0]! % 4 === 0;
  return Object.freeze({
    provider,
    repo,
    ref,
    state: failing ? ("failed" as const) : ("passed" as const),
    checks: Object.freeze([
      Object.freeze({ name: "build", passed: true, detail: "mock build" }),
      Object.freeze({
        name: "test",
        passed: !failing,
        detail: failing ? "mock test suite failing" : "mock test suite passing",
      }),
    ]),
    url: `mock://ci/${provider}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}`,
    observedAt: nowIso(),
  });
}

class MockCiConnector extends BaseConnector implements CiConnector {
  readonly kind = "ci" as const;
  constructor(readonly provider: CiProvider) {
    super("mock");
  }
  protected async probe() {
    return { ok: true, detail: `${this.provider} mock connector ready`, errorCode: null };
  }
  async readBuildStatus(input: { repo: string; ref: string }): Promise<BuildStatus> {
    this.assertReady();
    return mockBuildStatus(this.provider, input.repo, input.ref);
  }
}

/** GitHub Actions real adapter. Fail-closed: no token ⇒ cannot construct. */
class GithubActionsCiConnector extends BaseConnector implements CiConnector {
  readonly kind = "ci" as const;
  readonly provider = "github_actions" as const;
  readonly #token: string;
  readonly #api: string;
  readonly #fetch: ConnectorFetch;

  constructor(config: CiConnectorConfig) {
    super("real");
    if (!config.token) {
      throw new ConnectorError({
        code: "github_actions_credential_required",
        kind: "ci",
        provider: "github_actions",
        message: "CI_CONNECTOR_MODE=real requires a GitHub token for github_actions",
      });
    }
    this.#token = config.token;
    this.#api = (config.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.#fetch = config.fetch ?? defaultConnectorFetch;
  }

  #headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "mendpoint-connectors",
    };
  }

  protected async probe() {
    const response = await this.#fetch(`${this.#api}/rate_limit`, {
      method: "GET",
      headers: this.#headers(),
    });
    if (!response.ok) {
      return {
        ok: false,
        detail: "github_actions authentication failed",
        errorCode: `github_actions_probe_http_${response.status}`,
      };
    }
    return { ok: true, detail: "github_actions authenticated", errorCode: null };
  }

  async readBuildStatus(input: { repo: string; ref: string }): Promise<BuildStatus> {
    this.assertReady();
    const url =
      `${this.#api}/repos/${input.repo}/commits/` +
      `${encodeURIComponent(input.ref)}/check-runs`;
    const response = await this.#fetch(url, { method: "GET", headers: this.#headers() });
    if (!response.ok) {
      throw new ConnectorError({
        code: `github_actions_status_http_${response.status}`,
        kind: "ci",
        provider: "github_actions",
        message: "failed to read github_actions check runs",
      });
    }
    const body = (response.json ?? {}) as {
      check_runs?: Array<{ name?: string; conclusion?: string | null; status?: string; html_url?: string }>;
    };
    const runs = Array.isArray(body.check_runs) ? body.check_runs : [];
    const checks: BuildCheck[] = runs.map((run) => ({
      name: run.name ?? "check",
      passed: run.conclusion === "success",
      detail: run.conclusion ?? run.status ?? "unknown",
    }));
    const state: BuildState = runs.length === 0
      ? "unknown"
      : runs.some((r) => r.status && r.status !== "completed")
        ? "running"
        : checks.every((c) => c.passed)
          ? "passed"
          : "failed";
    return Object.freeze({
      provider: this.provider,
      repo: input.repo,
      ref: input.ref,
      state,
      checks: Object.freeze(checks),
      url: runs[0]?.html_url ?? null,
      observedAt: nowIso(),
    });
  }
}

/** GitLab CI real adapter. Fail-closed: no token ⇒ cannot construct. */
class GitlabCiConnector extends BaseConnector implements CiConnector {
  readonly kind = "ci" as const;
  readonly provider = "gitlab_ci" as const;
  readonly #token: string;
  readonly #api: string;
  readonly #fetch: ConnectorFetch;

  constructor(config: CiConnectorConfig) {
    super("real");
    if (!config.token) {
      throw new ConnectorError({
        code: "gitlab_ci_credential_required",
        kind: "ci",
        provider: "gitlab_ci",
        message: "CI_CONNECTOR_MODE=real requires a GitLab token for gitlab_ci",
      });
    }
    this.#token = config.token;
    this.#api = (config.apiBaseUrl ?? "https://gitlab.com/api/v4").replace(/\/+$/, "");
    this.#fetch = config.fetch ?? defaultConnectorFetch;
  }

  #headers(): Record<string, string> {
    return { "PRIVATE-TOKEN": this.#token, "User-Agent": "mendpoint-connectors" };
  }

  protected async probe() {
    const response = await this.#fetch(`${this.#api}/version`, {
      method: "GET",
      headers: this.#headers(),
    });
    if (!response.ok) {
      return {
        ok: false,
        detail: "gitlab_ci authentication failed",
        errorCode: `gitlab_ci_probe_http_${response.status}`,
      };
    }
    return { ok: true, detail: "gitlab_ci authenticated", errorCode: null };
  }

  async readBuildStatus(input: { repo: string; ref: string }): Promise<BuildStatus> {
    this.assertReady();
    const project = encodeURIComponent(input.repo);
    const url = `${this.#api}/projects/${project}/pipelines?ref=${encodeURIComponent(input.ref)}&per_page=1`;
    const response = await this.#fetch(url, { method: "GET", headers: this.#headers() });
    if (!response.ok) {
      throw new ConnectorError({
        code: `gitlab_ci_status_http_${response.status}`,
        kind: "ci",
        provider: "gitlab_ci",
        message: "failed to read gitlab_ci pipelines",
      });
    }
    const pipelines = (Array.isArray(response.json) ? response.json : []) as Array<{
      status?: string;
      web_url?: string;
    }>;
    const latest = pipelines[0];
    const gitlabStatus = latest?.status ?? null;
    const state: BuildState = gitlabStatus === null
      ? "unknown"
      : gitlabStatus === "success"
        ? "passed"
        : gitlabStatus === "running" || gitlabStatus === "pending"
          ? "running"
          : "failed";
    return Object.freeze({
      provider: this.provider,
      repo: input.repo,
      ref: input.ref,
      state,
      checks: Object.freeze([
        Object.freeze({ name: "pipeline", passed: state === "passed", detail: gitlabStatus ?? "unknown" }),
      ]),
      url: latest?.web_url ?? null,
      observedAt: nowIso(),
    });
  }
}

/**
 * Build a CI connector. Mock is the default; only `mode:"real"` (or
 * `CI_CONNECTOR_MODE=real`) selects the credential-gated HTTP adapter, which
 * throws if the token is absent (fail-closed at construction).
 */
export function createCiConnector(config: CiConnectorConfig): CiConnector {
  const mode = config.mode ?? "mock";
  if (mode === "mock") return new MockCiConnector(config.provider);
  switch (config.provider) {
    case "github_actions":
      return new GithubActionsCiConnector(config);
    case "gitlab_ci":
      return new GitlabCiConnector(config);
    default: {
      const exhaustive: never = config.provider;
      throw new ConnectorError({
        code: "ci_provider_unsupported",
        kind: "ci",
        provider: exhaustive,
      });
    }
  }
}

export function ciConnectorFromEnv(
  provider: CiProvider,
  env: NodeJS.ProcessEnv = process.env,
  overrides?: Partial<CiConnectorConfig>,
): CiConnector {
  const mode = resolveConnectorMode(env.CI_CONNECTOR_MODE);
  const token =
    overrides?.token ??
    (provider === "github_actions" ? env.GITHUB_TOKEN : env.GITLAB_TOKEN);
  return createCiConnector({ provider, mode, token, ...overrides });
}
