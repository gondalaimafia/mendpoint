/**
 * Connector abstraction (S3-connectors).
 *
 * A `Connector` is a typed handle to an external toolchain system a tenant has
 * connected through guided setup — CI/CD, ticketing, or documentation. It mirrors
 * the shape the SCM adapters already use (`packages/github/src/gitlab.ts`): a
 * real|mock mode chosen from the environment, a credential read from config,
 * and fail-closed behaviour when the credential is missing.
 *
 * Fail-closed invariants (never a silent no-op):
 *   - A real connector cannot be constructed without its credential — the
 *     constructor throws `<provider>_credential_required`.
 *   - Every capability call (readBuildStatus / createIssue / fetchDocs ...) is
 *     gated on a successful `verifyConnection()`. Until the connector is verified
 *     it reports unavailable and its capability methods throw
 *     `connector_unverified`.
 *   - Mock connectors need no credential and are ready on construction, so tests
 *     exercise the full surface without any external secret.
 */

export type ConnectorKind = "ci" | "ticketing" | "docs";
export type ConnectorMode = "mock" | "real";

export type CiProvider = "github_actions" | "gitlab_ci";
export type TicketingProvider = "jira" | "linear";
export type DocsProvider = "confluence" | "notion" | "markdown_repo";
export type ConnectorProvider = CiProvider | TicketingProvider | DocsProvider;

export const CONNECTOR_KINDS: readonly ConnectorKind[] = Object.freeze([
  "ci",
  "ticketing",
  "docs",
]);

export const CI_PROVIDERS: readonly CiProvider[] = Object.freeze([
  "github_actions",
  "gitlab_ci",
]);
export const TICKETING_PROVIDERS: readonly TicketingProvider[] = Object.freeze([
  "jira",
  "linear",
]);
export const DOCS_PROVIDERS: readonly DocsProvider[] = Object.freeze([
  "confluence",
  "notion",
  "markdown_repo",
]);

/** Result of a connector health probe. `ok:false` always carries an errorCode. */
export type ConnectionHealth = Readonly<{
  ok: boolean;
  kind: ConnectorKind;
  provider: ConnectorProvider;
  mode: ConnectorMode;
  detail: string;
  errorCode: string | null;
  checkedAt: string;
}>;

/** Base handle every connector family extends. */
export interface Connector {
  readonly kind: ConnectorKind;
  readonly provider: ConnectorProvider;
  readonly mode: ConnectorMode;
  /**
   * Probe the external system. Returns a health record and flips the connector
   * to "ready" on success so capability methods become available. Fails closed:
   * a probe that cannot authenticate returns `ok:false` and leaves the connector
   * unavailable.
   */
  verifyConnection(): Promise<ConnectionHealth>;
  /** True only after a successful `verifyConnection()`. */
  readonly ready: boolean;
}

export class ConnectorError extends Error {
  readonly code: string;
  readonly kind: ConnectorKind;
  readonly provider: ConnectorProvider;
  constructor(input: {
    code: string;
    kind: ConnectorKind;
    provider: ConnectorProvider;
    message?: string;
  }) {
    super(input.message ?? input.code);
    this.name = "ConnectorError";
    this.code = input.code;
    this.kind = input.kind;
    this.provider = input.provider;
  }
}

/**
 * Decide real|mock exactly like the SCM adapters: only the literal string
 * `"real"` selects the real HTTP path; every other value (including unset)
 * yields the safe mock default.
 */
export function resolveConnectorMode(
  value: string | undefined,
): ConnectorMode {
  return value === "real" ? "real" : "mock";
}

/** The env var that selects real vs mock for a whole family. */
export function connectorModeEnvVar(kind: ConnectorKind): string {
  return kind === "ci"
    ? "CI_CONNECTOR_MODE"
    : kind === "ticketing"
      ? "TICKETING_CONNECTOR_MODE"
      : "DOCS_CONNECTOR_MODE";
}

/**
 * Minimal fetch seam shared by every real connector, mirroring `GitLabFetch`
 * in `packages/github/src/gitlab.ts`. Injecting it lets tests script the real
 * HTTP path deterministically without a network.
 */
export type ConnectorFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; json: unknown }>;

export const defaultConnectorFetch: ConnectorFetch = async (url, init) => {
  try {
    const response = await fetch(url, {
      method: init?.method ?? "GET",
      headers: init?.headers,
      body: init?.body,
      signal: AbortSignal.timeout(15000),
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  }
};
