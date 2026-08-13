/**
 * Documentation connector family.
 *
 * Attach doc sources — a Confluence space, a Notion page, or a repo markdown
 * path — that feed the agent's coding-standards / knowledge context. This
 * deliberately reuses the existing knowledge system
 * (`packages/platform/src/knowledge.ts`, `fixtures/knowledge/*`): `fetchDocs()`
 * returns `KnowledgeDoc[]`, the exact shape the planner already consumes via
 * `seedMemoryForAgent`, so connected docs flow into the same context as
 * `codingStandards` refs rather than a parallel store.
 */
import { loadKnowledgeFromDir, type KnowledgeDoc } from "@mendpoint/platform";
import { BaseConnector } from "./base.js";
import {
  ConnectorError,
  defaultConnectorFetch,
  resolveConnectorMode,
  type Connector,
  type ConnectorFetch,
  type ConnectorMode,
  type DocsProvider,
} from "./connector.js";

export type DocSource = Readonly<{
  provider: DocsProvider;
  id: string;
  title: string;
  /** A repo-relative markdown path, a Confluence space key, or a Notion page id. */
  ref: string;
  tags: readonly string[];
}>;

export interface DocsConnector extends Connector {
  readonly kind: "docs";
  readonly provider: DocsProvider;
  /** The doc sources this connector exposes. */
  listDocSources(): Promise<DocSource[]>;
  /** Materialize the connected docs as planner-ready knowledge docs. */
  fetchDocs(): Promise<KnowledgeDoc[]>;
}

export type DocsConnectorConfig = Readonly<{
  provider: DocsProvider;
  mode?: ConnectorMode;
  /** Real-mode API token. Required in real mode for confluence/notion. */
  token?: string;
  /** Real-mode API base override. */
  apiBaseUrl?: string;
  /**
   * The source reference: markdown_repo = a directory of markdown docs
   * (defaults to the repo `fixtures/knowledge` seed); confluence = space key;
   * notion = page/database id.
   */
  ref?: string;
  /** Confluence email for basic auth. */
  email?: string;
  fetch?: ConnectorFetch;
}>;

const DEFAULT_KNOWLEDGE_DIR = "fixtures/knowledge";

class MarkdownRepoDocsConnector extends BaseConnector implements DocsConnector {
  readonly kind = "docs" as const;
  readonly provider = "markdown_repo" as const;
  readonly #dir: string;

  constructor(ref?: string) {
    super("mock");
    this.#dir = ref && ref.trim() !== "" ? ref : DEFAULT_KNOWLEDGE_DIR;
  }

  protected async probe() {
    // Fail-closed: the directory must actually yield knowledge docs.
    const docs = loadKnowledgeFromDir(this.#dir);
    if (docs.length === 0) {
      return { ok: false, detail: `no markdown docs at ${this.#dir}`, errorCode: "markdown_repo_empty" };
    }
    return { ok: true, detail: `${docs.length} markdown docs at ${this.#dir}`, errorCode: null };
  }

  async listDocSources(): Promise<DocSource[]> {
    this.assertReady();
    return loadKnowledgeFromDir(this.#dir).map((doc) =>
      Object.freeze({
        provider: this.provider,
        id: doc.id,
        title: doc.title,
        ref: `${this.#dir}`,
        tags: Object.freeze([...doc.tags]),
      }),
    );
  }

  async fetchDocs(): Promise<KnowledgeDoc[]> {
    this.assertReady();
    return loadKnowledgeFromDir(this.#dir);
  }
}

/** Shared real-mode HTTP docs adapter for Confluence and Notion. */
abstract class HttpDocsConnector extends BaseConnector implements DocsConnector {
  readonly kind = "docs" as const;
  abstract readonly provider: DocsProvider;
  protected readonly token: string;
  protected readonly api: string;
  protected readonly ref: string;
  protected readonly fetchImpl: ConnectorFetch;

  constructor(config: DocsConnectorConfig, defaultApi: string) {
    super("real");
    if (!config.token) {
      throw new ConnectorError({
        code: `${config.provider}_credential_required`,
        kind: "docs",
        provider: config.provider,
        message: `DOCS_CONNECTOR_MODE=real requires an API token for ${config.provider}`,
      });
    }
    if (!config.ref || config.ref.trim() === "") {
      throw new ConnectorError({
        code: `${config.provider}_source_ref_required`,
        kind: "docs",
        provider: config.provider,
        message: `${config.provider} requires a source reference (space key / page id)`,
      });
    }
    this.token = config.token;
    this.api = (config.apiBaseUrl ?? defaultApi).replace(/\/+$/, "");
    this.ref = config.ref;
    this.fetchImpl = config.fetch ?? defaultConnectorFetch;
  }

  protected abstract headers(): Record<string, string>;
  protected abstract probeUrl(): string;

  protected async probe() {
    const response = await this.fetchImpl(this.probeUrl(), { method: "GET", headers: this.headers() });
    if (!response.ok) {
      return {
        ok: false,
        detail: `${this.provider} authentication failed`,
        errorCode: `${this.provider}_probe_http_${response.status}`,
      };
    }
    return { ok: true, detail: `${this.provider} authenticated`, errorCode: null };
  }

  abstract listDocSources(): Promise<DocSource[]>;
  abstract fetchDocs(): Promise<KnowledgeDoc[]>;
}

class ConfluenceDocsConnector extends HttpDocsConnector {
  readonly provider = "confluence" as const;
  readonly #email: string;

  constructor(config: DocsConnectorConfig) {
    super(config, "https://your-domain.atlassian.net/wiki/rest/api");
    if (!config.email) {
      throw new ConnectorError({
        code: "confluence_credential_required",
        kind: "docs",
        provider: "confluence",
        message: "confluence real mode requires an email for basic auth",
      });
    }
    this.#email = config.email;
  }

  protected headers(): Record<string, string> {
    const basic = Buffer.from(`${this.#email}:${this.token}`).toString("base64");
    return { Authorization: `Basic ${basic}`, Accept: "application/json", "User-Agent": "mendpoint-connectors" };
  }

  protected probeUrl(): string {
    return `${this.api}/space/${encodeURIComponent(this.ref)}`;
  }

  async listDocSources(): Promise<DocSource[]> {
    this.assertReady();
    return [
      Object.freeze({
        provider: this.provider,
        id: `confluence-${this.ref}`,
        title: `Confluence space ${this.ref}`,
        ref: this.ref,
        tags: Object.freeze(["docs", "confluence"]),
      }),
    ];
  }

  async fetchDocs(): Promise<KnowledgeDoc[]> {
    this.assertReady();
    const url = `${this.api}/content?spaceKey=${encodeURIComponent(this.ref)}&expand=body.storage&limit=50`;
    const response = await this.fetchImpl(url, { method: "GET", headers: this.headers() });
    if (!response.ok) {
      throw new ConnectorError({
        code: `confluence_fetch_http_${response.status}`,
        kind: "docs",
        provider: "confluence",
        message: "failed to fetch Confluence content",
      });
    }
    const body = (response.json ?? {}) as {
      results?: Array<{ id?: string; title?: string; body?: { storage?: { value?: string } } }>;
    };
    return (body.results ?? []).map((page) => ({
      id: `confluence-${page.id ?? ""}`,
      title: page.title ?? "Confluence page",
      tags: ["docs", "confluence"],
      body: (page.body?.storage?.value ?? "").slice(0, 8000),
    }));
  }
}

class NotionDocsConnector extends HttpDocsConnector {
  readonly provider = "notion" as const;

  constructor(config: DocsConnectorConfig) {
    super(config, "https://api.notion.com/v1");
  }

  protected headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
      "User-Agent": "mendpoint-connectors",
    };
  }

  protected probeUrl(): string {
    return `${this.api}/users/me`;
  }

  async listDocSources(): Promise<DocSource[]> {
    this.assertReady();
    return [
      Object.freeze({
        provider: this.provider,
        id: `notion-${this.ref}`,
        title: `Notion source ${this.ref}`,
        ref: this.ref,
        tags: Object.freeze(["docs", "notion"]),
      }),
    ];
  }

  async fetchDocs(): Promise<KnowledgeDoc[]> {
    this.assertReady();
    const response = await this.fetchImpl(`${this.api}/blocks/${encodeURIComponent(this.ref)}/children?page_size=50`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new ConnectorError({
        code: `notion_fetch_http_${response.status}`,
        kind: "docs",
        provider: "notion",
        message: "failed to fetch Notion content",
      });
    }
    const body = (response.json ?? {}) as {
      results?: Array<{ id?: string; paragraph?: { rich_text?: Array<{ plain_text?: string }> } }>;
    };
    const text = (body.results ?? [])
      .map((block) => (block.paragraph?.rich_text ?? []).map((rt) => rt.plain_text ?? "").join(""))
      .filter((line) => line.trim() !== "")
      .join("\n")
      .slice(0, 8000);
    return [
      { id: `notion-${this.ref}`, title: `Notion source ${this.ref}`, tags: ["docs", "notion"], body: text },
    ];
  }
}

export function createDocsConnector(config: DocsConnectorConfig): DocsConnector {
  const mode = config.mode ?? "mock";
  if (mode === "mock") return new MarkdownRepoDocsConnector(config.ref);
  switch (config.provider) {
    case "markdown_repo":
      // markdown_repo is filesystem-backed; "real" and "mock" behave identically.
      return new MarkdownRepoDocsConnector(config.ref);
    case "confluence":
      return new ConfluenceDocsConnector(config);
    case "notion":
      return new NotionDocsConnector(config);
    default: {
      const exhaustive: never = config.provider;
      throw new ConnectorError({
        code: "docs_provider_unsupported",
        kind: "docs",
        provider: exhaustive,
      });
    }
  }
}

export function docsConnectorFromEnv(
  provider: DocsProvider,
  env: NodeJS.ProcessEnv = process.env,
  overrides?: Partial<DocsConnectorConfig>,
): DocsConnector {
  const mode = resolveConnectorMode(env.DOCS_CONNECTOR_MODE);
  const token =
    overrides?.token ??
    (provider === "confluence" ? env.CONFLUENCE_API_TOKEN : provider === "notion" ? env.NOTION_API_TOKEN : undefined);
  return createDocsConnector({
    provider,
    mode,
    token,
    email: overrides?.email ?? env.CONFLUENCE_EMAIL,
    ref: overrides?.ref,
    ...overrides,
  });
}
