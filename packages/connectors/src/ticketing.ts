/**
 * Ticketing connector family.
 *
 * Create or link an issue for a migration/PR — e.g. "Warden opened PR #123 for
 * the Acme v3 breaking change". Two shapes are provided: Jira and Linear, each
 * with a deterministic mock (default, no credential) and a real HTTP path
 * (code-complete, credential-gated via an injectable fetch seam).
 */
import { createHash } from "node:crypto";
import { BaseConnector } from "./base.js";
import {
  ConnectorError,
  defaultConnectorFetch,
  resolveConnectorMode,
  type Connector,
  type ConnectorFetch,
  type ConnectorMode,
  type TicketingProvider,
} from "./connector.js";

export type IssueRef = Readonly<{
  provider: TicketingProvider;
  id: string;
  key: string;
  title: string;
  url: string;
}>;

export type IssueLink = Readonly<{
  provider: TicketingProvider;
  issueKey: string;
  targetUrl: string;
  relation: string;
}>;

export interface TicketingConnector extends Connector {
  readonly kind: "ticketing";
  readonly provider: TicketingProvider;
  createIssue(input: {
    title: string;
    body: string;
    project?: string;
  }): Promise<IssueRef>;
  linkIssue(input: {
    issueKey: string;
    targetUrl: string;
    relation?: string;
  }): Promise<IssueLink>;
}

export type TicketingConnectorConfig = Readonly<{
  provider: TicketingProvider;
  mode?: ConnectorMode;
  /** Real-mode API token. Required in real mode. */
  token?: string;
  /** Jira: site base URL (https://acme.atlassian.net). Jira also needs an email. */
  apiBaseUrl?: string;
  /** Jira basic-auth email; ignored by Linear. */
  email?: string;
  /** Default project/team key for created issues. */
  project?: string;
  fetch?: ConnectorFetch;
}>;

function mockKey(provider: TicketingProvider, title: string, project?: string): string {
  const digest = createHash("sha256").update(`${provider}\n${project ?? ""}\n${title}`).digest("hex");
  const number = (parseInt(digest.slice(0, 6), 16) % 900) + 100;
  const prefix = (project ?? (provider === "jira" ? "MEND" : "ENG")).toUpperCase();
  return `${prefix}-${number}`;
}

class MockTicketingConnector extends BaseConnector implements TicketingConnector {
  readonly kind = "ticketing" as const;
  readonly #project?: string;
  constructor(
    readonly provider: TicketingProvider,
    project?: string,
  ) {
    super("mock");
    this.#project = project;
  }
  protected async probe() {
    return { ok: true, detail: `${this.provider} mock connector ready`, errorCode: null };
  }
  async createIssue(input: { title: string; body: string; project?: string }): Promise<IssueRef> {
    this.assertReady();
    const project = input.project ?? this.#project;
    const key = mockKey(this.provider, input.title, project);
    return Object.freeze({
      provider: this.provider,
      id: `mock-${key}`,
      key,
      title: input.title,
      url: `mock://ticketing/${this.provider}/${key}`,
    });
  }
  async linkIssue(input: { issueKey: string; targetUrl: string; relation?: string }): Promise<IssueLink> {
    this.assertReady();
    return Object.freeze({
      provider: this.provider,
      issueKey: input.issueKey,
      targetUrl: input.targetUrl,
      relation: input.relation ?? "relates_to",
    });
  }
}

class JiraTicketingConnector extends BaseConnector implements TicketingConnector {
  readonly kind = "ticketing" as const;
  readonly provider = "jira" as const;
  readonly #token: string;
  readonly #email: string;
  readonly #api: string;
  readonly #project?: string;
  readonly #fetch: ConnectorFetch;

  constructor(config: TicketingConnectorConfig) {
    super("real");
    if (!config.token || !config.email || !config.apiBaseUrl) {
      throw new ConnectorError({
        code: "jira_credential_required",
        kind: "ticketing",
        provider: "jira",
        message: "TICKETING_CONNECTOR_MODE=real requires a Jira email, API token, and site URL",
      });
    }
    this.#token = config.token;
    this.#email = config.email;
    this.#api = config.apiBaseUrl.replace(/\/+$/, "");
    this.#project = config.project;
    this.#fetch = config.fetch ?? defaultConnectorFetch;
  }

  #headers(): Record<string, string> {
    const basic = Buffer.from(`${this.#email}:${this.#token}`).toString("base64");
    return {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "mendpoint-connectors",
    };
  }

  protected async probe() {
    const response = await this.#fetch(`${this.#api}/rest/api/3/myself`, {
      method: "GET",
      headers: this.#headers(),
    });
    if (!response.ok) {
      return { ok: false, detail: "jira authentication failed", errorCode: `jira_probe_http_${response.status}` };
    }
    return { ok: true, detail: "jira authenticated", errorCode: null };
  }

  async createIssue(input: { title: string; body: string; project?: string }): Promise<IssueRef> {
    this.assertReady();
    const project = input.project ?? this.#project;
    if (!project) {
      throw new ConnectorError({ code: "jira_project_required", kind: "ticketing", provider: "jira" });
    }
    const response = await this.#fetch(`${this.#api}/rest/api/3/issue`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({
        fields: {
          project: { key: project },
          summary: input.title,
          issuetype: { name: "Task" },
          description: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: input.body }] }],
          },
        },
      }),
    });
    if (!response.ok) {
      throw new ConnectorError({
        code: `jira_create_http_${response.status}`,
        kind: "ticketing",
        provider: "jira",
        message: "failed to create Jira issue",
      });
    }
    const body = (response.json ?? {}) as { id?: string; key?: string };
    const key = body.key ?? "";
    return Object.freeze({
      provider: this.provider,
      id: body.id ?? key,
      key,
      title: input.title,
      url: `${this.#api}/browse/${key}`,
    });
  }

  async linkIssue(input: { issueKey: string; targetUrl: string; relation?: string }): Promise<IssueLink> {
    this.assertReady();
    const relation = input.relation ?? "relates_to";
    const response = await this.#fetch(`${this.#api}/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/remotelink`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({ object: { url: input.targetUrl, title: input.targetUrl } }),
    });
    if (!response.ok) {
      throw new ConnectorError({
        code: `jira_link_http_${response.status}`,
        kind: "ticketing",
        provider: "jira",
        message: "failed to link Jira issue",
      });
    }
    return Object.freeze({ provider: this.provider, issueKey: input.issueKey, targetUrl: input.targetUrl, relation });
  }
}

class LinearTicketingConnector extends BaseConnector implements TicketingConnector {
  readonly kind = "ticketing" as const;
  readonly provider = "linear" as const;
  readonly #token: string;
  readonly #api: string;
  readonly #team?: string;
  readonly #fetch: ConnectorFetch;

  constructor(config: TicketingConnectorConfig) {
    super("real");
    if (!config.token) {
      throw new ConnectorError({
        code: "linear_credential_required",
        kind: "ticketing",
        provider: "linear",
        message: "TICKETING_CONNECTOR_MODE=real requires a Linear API token",
      });
    }
    this.#token = config.token;
    this.#api = (config.apiBaseUrl ?? "https://api.linear.app/graphql").replace(/\/+$/, "");
    this.#team = config.project;
    this.#fetch = config.fetch ?? defaultConnectorFetch;
  }

  #headers(): Record<string, string> {
    return {
      Authorization: this.#token,
      "Content-Type": "application/json",
      "User-Agent": "mendpoint-connectors",
    };
  }

  protected async probe() {
    const response = await this.#fetch(this.#api, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({ query: "{ viewer { id } }" }),
    });
    if (!response.ok) {
      return { ok: false, detail: "linear authentication failed", errorCode: `linear_probe_http_${response.status}` };
    }
    return { ok: true, detail: "linear authenticated", errorCode: null };
  }

  async createIssue(input: { title: string; body: string; project?: string }): Promise<IssueRef> {
    this.assertReady();
    const team = input.project ?? this.#team;
    if (!team) {
      throw new ConnectorError({ code: "linear_team_required", kind: "ticketing", provider: "linear" });
    }
    const response = await this.#fetch(this.#api, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({
        query:
          "mutation($input: IssueCreateInput!){ issueCreate(input:$input){ issue{ id identifier url title } } }",
        variables: { input: { teamId: team, title: input.title, description: input.body } },
      }),
    });
    if (!response.ok) {
      throw new ConnectorError({
        code: `linear_create_http_${response.status}`,
        kind: "ticketing",
        provider: "linear",
        message: "failed to create Linear issue",
      });
    }
    const issue =
      ((response.json ?? {}) as {
        data?: { issueCreate?: { issue?: { id?: string; identifier?: string; url?: string; title?: string } } };
      }).data?.issueCreate?.issue ?? {};
    return Object.freeze({
      provider: this.provider,
      id: issue.id ?? "",
      key: issue.identifier ?? "",
      title: issue.title ?? input.title,
      url: issue.url ?? "",
    });
  }

  async linkIssue(input: { issueKey: string; targetUrl: string; relation?: string }): Promise<IssueLink> {
    this.assertReady();
    const relation = input.relation ?? "relates_to";
    const response = await this.#fetch(this.#api, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({
        query:
          "mutation($input: AttachmentCreateInput!){ attachmentCreate(input:$input){ success } }",
        variables: { input: { issueId: input.issueKey, url: input.targetUrl, title: input.targetUrl } },
      }),
    });
    if (!response.ok) {
      throw new ConnectorError({
        code: `linear_link_http_${response.status}`,
        kind: "ticketing",
        provider: "linear",
        message: "failed to link Linear issue",
      });
    }
    return Object.freeze({ provider: this.provider, issueKey: input.issueKey, targetUrl: input.targetUrl, relation });
  }
}

export function createTicketingConnector(config: TicketingConnectorConfig): TicketingConnector {
  const mode = config.mode ?? "mock";
  if (mode === "mock") return new MockTicketingConnector(config.provider, config.project);
  switch (config.provider) {
    case "jira":
      return new JiraTicketingConnector(config);
    case "linear":
      return new LinearTicketingConnector(config);
    default: {
      const exhaustive: never = config.provider;
      throw new ConnectorError({
        code: "ticketing_provider_unsupported",
        kind: "ticketing",
        provider: exhaustive,
      });
    }
  }
}

export function ticketingConnectorFromEnv(
  provider: TicketingProvider,
  env: NodeJS.ProcessEnv = process.env,
  overrides?: Partial<TicketingConnectorConfig>,
): TicketingConnector {
  const mode = resolveConnectorMode(env.TICKETING_CONNECTOR_MODE);
  const token =
    overrides?.token ?? (provider === "jira" ? env.JIRA_API_TOKEN : env.LINEAR_API_TOKEN);
  return createTicketingConnector({
    provider,
    mode,
    token,
    email: overrides?.email ?? env.JIRA_EMAIL,
    apiBaseUrl: overrides?.apiBaseUrl ?? (provider === "jira" ? env.JIRA_BASE_URL : undefined),
    ...overrides,
  });
}
