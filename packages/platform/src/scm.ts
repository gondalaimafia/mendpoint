/**
 * Multi-SCM adapters — GitHub, GitLab, Bitbucket, Azure DevOps.
 * Token-backed live HTTP when env set; deterministic mock mode otherwise.
 */
export type ScmProvider = "github" | "gitlab" | "bitbucket" | "azure_devops";

export type ScmPr = {
  id: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "merged" | "closed";
  provider: ScmProvider;
};

export class ScmRequestError extends Error {
  readonly provider: ScmProvider;
  readonly operation: "createPr" | "commentOnPr" | "listOpenPrs";
  readonly status: number;
  readonly response: unknown;

  constructor(
    provider: ScmProvider,
    status: number,
    response: unknown,
    operation: ScmRequestError["operation"] = "createPr",
    reason?: string,
  ) {
    super(`${provider} ${operation} failed with status ${status}${reason ? `: ${reason}` : ""}`);
    this.name = "ScmRequestError";
    this.provider = provider;
    this.operation = operation;
    this.status = status;
    this.response = response;
  }
}

export type ScmAdapter = {
  provider: ScmProvider;
  available: boolean;
  mode: "live" | "mock";
  createPr: (input: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }) => Promise<ScmPr>;
  commentOnPr: (input: {
    owner: string;
    repo: string;
    number: number;
    body: string;
  }) => Promise<{ ok: boolean; id?: string }>;
  listOpenPrs: (input: {
    owner: string;
    repo: string;
  }) => Promise<ScmPr[]>;
};

type FetchJson = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json: unknown }>;

async function defaultFetch(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: { error: String(e) } };
  }
}

function mockPr(
  provider: ScmProvider,
  input: { owner: string; repo: string; title: string; number?: number },
): ScmPr {
  const n = input.number ?? 1;
  const urls: Record<ScmProvider, string> = {
    github: `https://github.com/${input.owner}/${input.repo}/pull/${n}`,
    gitlab: `https://gitlab.com/${input.owner}/${input.repo}/-/merge_requests/${n}`,
    bitbucket: `https://bitbucket.org/${input.owner}/${input.repo}/pull-requests/${n}`,
    azure_devops: `https://dev.azure.com/${input.owner}/_git/${input.repo}/pullrequest/${n}`,
  };
  return {
    id: `${provider}-mock-${n}`,
    number: n,
    title: input.title,
    url: urls[provider],
    state: "open",
    provider,
  };
}

function assertRequestSucceeded(
  provider: ScmProvider,
  result: { ok: boolean; status: number; json: unknown },
  operation: ScmRequestError["operation"],
): void {
  if (!result.ok) {
    throw new ScmRequestError(provider, result.status, result.json, operation);
  }
}

function malformed(
  provider: ScmProvider,
  operation: ScmRequestError["operation"],
  result: { status: number; json: unknown },
  reason: string,
): never {
  throw new ScmRequestError(provider, result.status, result.json, operation, reason);
}

function requireString(
  provider: ScmProvider,
  operation: ScmRequestError["operation"],
  result: { status: number; json: unknown },
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || !value.trim()) {
    return malformed(provider, operation, result, `missing ${field}`);
  }
  return value;
}

function requirePositiveNumber(
  provider: ScmProvider,
  operation: ScmRequestError["operation"],
  result: { status: number; json: unknown },
  value: unknown,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return malformed(provider, operation, result, `missing ${field}`);
  }
  return value;
}

export function createGitHubAdapter(fetchImpl: FetchJson = defaultFetch): ScmAdapter {
  const token = process.env.GITHUB_TOKEN;
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  return {
    provider: "github",
    available: true,
    mode: token ? "live" : "mock",
    async createPr(input) {
      if (!token) {
        return mockPr("github", { ...input, number: 1 });
      }
      const r = await fetchImpl(`${api}/repos/${input.owner}/${input.repo}/pulls`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
        }),
      });
      assertRequestSucceeded("github", r, "createPr");
      const j = r.json as { id?: number; number?: number; html_url?: string; state?: string };
      const id = requirePositiveNumber("github", "createPr", r, j.id, "id");
      const number = requirePositiveNumber("github", "createPr", r, j.number, "number");
      const url = requireString("github", "createPr", r, j.html_url, "html_url");
      return {
        id: String(id),
        number,
        title: input.title,
        url,
        state: j.state === "closed" ? "closed" : "open",
        provider: "github",
      };
    },
    async commentOnPr(input) {
      if (!token) return { ok: true, id: "mock-comment" };
      const r = await fetchImpl(
        `${api}/repos/${input.owner}/${input.repo}/issues/${input.number}/comments`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ body: input.body }),
        },
      );
      assertRequestSucceeded("github", r, "commentOnPr");
      const id = requirePositiveNumber(
        "github",
        "commentOnPr",
        r,
        (r.json as { id?: number })?.id,
        "id",
      );
      return { ok: true, id: String(id) };
    },
    async listOpenPrs(input) {
      if (!token) return [mockPr("github", { ...input, title: "mock open pr" })];
      const r = await fetchImpl(
        `${api}/repos/${input.owner}/${input.repo}/pulls?state=open&per_page=20`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
          },
        },
      );
      assertRequestSucceeded("github", r, "listOpenPrs");
      if (!Array.isArray(r.json)) malformed("github", "listOpenPrs", r, "response is not an array");
      return (r.json as Array<{ id?: number; number?: number; title?: string; html_url?: string }>).map(
        (p) => ({
          id: String(requirePositiveNumber("github", "listOpenPrs", r, p.id, "id")),
          number: requirePositiveNumber("github", "listOpenPrs", r, p.number, "number"),
          title: requireString("github", "listOpenPrs", r, p.title, "title"),
          url: requireString("github", "listOpenPrs", r, p.html_url, "html_url"),
          state: "open" as const,
          provider: "github" as const,
        }),
      );
    },
  };
}

export function createGitLabAdapter(fetchImpl: FetchJson = defaultFetch): ScmAdapter {
  const token = process.env.GITLAB_TOKEN;
  const api = (process.env.GITLAB_API_URL ?? "https://gitlab.com/api/v4").replace(/\/$/, "");
  return {
    provider: "gitlab",
    available: true,
    mode: token ? "live" : "mock",
    async createPr(input) {
      const project = encodeURIComponent(`${input.owner}/${input.repo}`);
      if (!token) return mockPr("gitlab", input);
      const r = await fetchImpl(`${api}/projects/${project}/merge_requests`, {
        method: "POST",
        headers: {
          "PRIVATE-TOKEN": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: input.title,
          description: input.body,
          source_branch: input.head,
          target_branch: input.base,
        }),
      });
      assertRequestSucceeded("gitlab", r, "createPr");
      const j = r.json as { id?: number; iid?: number; web_url?: string; state?: string };
      const id = requirePositiveNumber("gitlab", "createPr", r, j.id, "id");
      const number = requirePositiveNumber("gitlab", "createPr", r, j.iid, "iid");
      const url = requireString("gitlab", "createPr", r, j.web_url, "web_url");
      return {
        id: String(id),
        number,
        title: input.title,
        url,
        state: j.state === "merged" ? "merged" : j.state === "closed" ? "closed" : "open",
        provider: "gitlab",
      };
    },
    async commentOnPr(input) {
      if (!token) return { ok: true, id: "gl-mock-note" };
      const project = encodeURIComponent(`${input.owner}/${input.repo}`);
      const r = await fetchImpl(
        `${api}/projects/${project}/merge_requests/${input.number}/notes`,
        {
          method: "POST",
          headers: {
            "PRIVATE-TOKEN": token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ body: input.body }),
        },
      );
      assertRequestSucceeded("gitlab", r, "commentOnPr");
      const id = requirePositiveNumber(
        "gitlab",
        "commentOnPr",
        r,
        (r.json as { id?: number })?.id,
        "id",
      );
      return { ok: true, id: String(id) };
    },
    async listOpenPrs(input) {
      if (!token) return [mockPr("gitlab", { ...input, title: "mock open mr" })];
      const project = encodeURIComponent(`${input.owner}/${input.repo}`);
      const r = await fetchImpl(
        `${api}/projects/${project}/merge_requests?state=opened&per_page=20`,
        { headers: { "PRIVATE-TOKEN": token } },
      );
      assertRequestSucceeded("gitlab", r, "listOpenPrs");
      if (!Array.isArray(r.json)) malformed("gitlab", "listOpenPrs", r, "response is not an array");
      return (r.json as Array<{ id?: number; iid?: number; title?: string; web_url?: string }>).map(
        (p) => ({
          id: String(requirePositiveNumber("gitlab", "listOpenPrs", r, p.id, "id")),
          number: requirePositiveNumber("gitlab", "listOpenPrs", r, p.iid, "iid"),
          title: requireString("gitlab", "listOpenPrs", r, p.title, "title"),
          url: requireString("gitlab", "listOpenPrs", r, p.web_url, "web_url"),
          state: "open" as const,
          provider: "gitlab" as const,
        }),
      );
    },
  };
}

export function createBitbucketAdapter(fetchImpl: FetchJson = defaultFetch): ScmAdapter {
  const user = process.env.BITBUCKET_USERNAME;
  const pass = process.env.BITBUCKET_APP_PASSWORD ?? process.env.BITBUCKET_TOKEN;
  const api = "https://api.bitbucket.org/2.0";
  const auth =
    user && pass
      ? `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`
      : pass
        ? `Bearer ${pass}`
        : null;
  return {
    provider: "bitbucket",
    available: true,
    mode: auth ? "live" : "mock",
    async createPr(input) {
      if (!auth) return mockPr("bitbucket", input);
      const r = await fetchImpl(
        `${api}/repositories/${input.owner}/${input.repo}/pullrequests`,
        {
          method: "POST",
          headers: {
            Authorization: auth,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: input.title,
            description: input.body,
            source: { branch: { name: input.head } },
            destination: { branch: { name: input.base } },
          }),
        },
      );
      assertRequestSucceeded("bitbucket", r, "createPr");
      const j = r.json as {
        id?: number;
        links?: { html?: { href?: string } };
        state?: string;
      };
      const id = requirePositiveNumber("bitbucket", "createPr", r, j.id, "id");
      const url = requireString(
        "bitbucket",
        "createPr",
        r,
        j.links?.html?.href,
        "links.html.href",
      );
      return {
        id: String(id),
        number: id,
        title: input.title,
        url,
        state: j.state === "MERGED" ? "merged" : j.state === "DECLINED" ? "closed" : "open",
        provider: "bitbucket",
      };
    },
    async commentOnPr(input) {
      if (!auth) return { ok: true, id: "bb-mock" };
      const r = await fetchImpl(
        `${api}/repositories/${input.owner}/${input.repo}/pullrequests/${input.number}/comments`,
        {
          method: "POST",
          headers: {
            Authorization: auth,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: { raw: input.body } }),
        },
      );
      assertRequestSucceeded("bitbucket", r, "commentOnPr");
      const id = requirePositiveNumber(
        "bitbucket",
        "commentOnPr",
        r,
        (r.json as { id?: number })?.id,
        "id",
      );
      return { ok: true, id: String(id) };
    },
    async listOpenPrs(input) {
      if (!auth) return [mockPr("bitbucket", { ...input, title: "mock open pr" })];
      const r = await fetchImpl(
        `${api}/repositories/${input.owner}/${input.repo}/pullrequests?state=OPEN&pagelen=20`,
        { headers: { Authorization: auth } },
      );
      const values = (r.json as { values?: Array<{ id: number; title: string; links?: { html?: { href?: string } } }> })
        ?.values;
      assertRequestSucceeded("bitbucket", r, "listOpenPrs");
      if (!Array.isArray(values)) {
        malformed("bitbucket", "listOpenPrs", r, "missing values array");
      }
      return values.map((p) => ({
        id: String(requirePositiveNumber("bitbucket", "listOpenPrs", r, p.id, "id")),
        number: requirePositiveNumber("bitbucket", "listOpenPrs", r, p.id, "id"),
        title: requireString("bitbucket", "listOpenPrs", r, p.title, "title"),
        url: requireString(
          "bitbucket",
          "listOpenPrs",
          r,
          p.links?.html?.href,
          "links.html.href",
        ),
        state: "open" as const,
        provider: "bitbucket" as const,
      }));
    },
  };
}

export function createAzureDevOpsAdapter(
  fetchImpl: FetchJson = defaultFetch,
): ScmAdapter {
  const token = process.env.AZURE_DEVOPS_PAT ?? process.env.AZDO_PAT;
  const org = process.env.AZURE_DEVOPS_ORG;
  const apiBase = process.env.AZURE_DEVOPS_API_URL; // optional full override
  return {
    provider: "azure_devops",
    available: true,
    mode: token && (org || apiBase) ? "live" : "mock",
    async createPr(input) {
      if (!token || (!org && !apiBase)) return mockPr("azure_devops", input);
      const base =
        apiBase ??
        `https://dev.azure.com/${org}/${input.owner}/_apis/git/repositories/${input.repo}`;
      const r = await fetchImpl(`${base}/pullrequests?api-version=7.1`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: input.title,
          description: input.body,
          sourceRefName: `refs/heads/${input.head}`,
          targetRefName: `refs/heads/${input.base}`,
        }),
      });
      assertRequestSucceeded("azure_devops", r, "createPr");
      const j = r.json as {
        pullRequestId?: number;
        url?: string;
        status?: string;
      };
      const id = requirePositiveNumber(
        "azure_devops",
        "createPr",
        r,
        j.pullRequestId,
        "pullRequestId",
      );
      const url = requireString("azure_devops", "createPr", r, j.url, "url");
      return {
        id: String(id),
        number: id,
        title: input.title,
        url,
        state: j.status === "completed" ? "merged" : "open",
        provider: "azure_devops",
      };
    },
    async commentOnPr(input) {
      if (!token || (!org && !apiBase)) return { ok: true, id: "ado-mock" };
      const base =
        apiBase ??
        `https://dev.azure.com/${org}/${input.owner}/_apis/git/repositories/${input.repo}`;
      const r = await fetchImpl(
        `${base}/pullRequests/${input.number}/threads?api-version=7.1`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            comments: [{ parentCommentId: 0, content: input.body, commentType: 1 }],
            status: 1,
          }),
        },
      );
      assertRequestSucceeded("azure_devops", r, "commentOnPr");
      const id = requirePositiveNumber(
        "azure_devops",
        "commentOnPr",
        r,
        (r.json as { id?: number })?.id,
        "id",
      );
      return { ok: true, id: String(id) };
    },
    async listOpenPrs(input) {
      if (!token || (!org && !apiBase)) {
        return [mockPr("azure_devops", { ...input, title: "mock open pr" })];
      }
      const base =
        apiBase ??
        `https://dev.azure.com/${org}/${input.owner}/_apis/git/repositories/${input.repo}`;
      const r = await fetchImpl(
        `${base}/pullrequests?searchCriteria.status=active&api-version=7.1`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
          },
        },
      );
      const values = (r.json as { value?: Array<{ pullRequestId: number; title: string; url?: string }> })
        ?.value;
      assertRequestSucceeded("azure_devops", r, "listOpenPrs");
      if (!Array.isArray(values)) {
        malformed("azure_devops", "listOpenPrs", r, "missing value array");
      }
      return values.map((p) => ({
        id: String(
          requirePositiveNumber(
            "azure_devops",
            "listOpenPrs",
            r,
            p.pullRequestId,
            "pullRequestId",
          ),
        ),
        number: requirePositiveNumber(
          "azure_devops",
          "listOpenPrs",
          r,
          p.pullRequestId,
          "pullRequestId",
        ),
        title: requireString("azure_devops", "listOpenPrs", r, p.title, "title"),
        url: requireString("azure_devops", "listOpenPrs", r, p.url, "url"),
        state: "open" as const,
        provider: "azure_devops" as const,
      }));
    },
  };
}

export function getScmAdapter(provider: ScmProvider): ScmAdapter {
  switch (provider) {
    case "github":
      return createGitHubAdapter();
    case "gitlab":
      return createGitLabAdapter();
    case "bitbucket":
      return createBitbucketAdapter();
    case "azure_devops":
      return createAzureDevOpsAdapter();
    default:
      return createGitHubAdapter();
  }
}

export function listScmProviders(): Array<{
  provider: ScmProvider;
  available: boolean;
  mode: "live" | "mock";
  note: string;
}> {
  return (["github", "gitlab", "bitbucket", "azure_devops"] as ScmProvider[]).map(
    (p) => {
      const a = getScmAdapter(p);
      return {
        provider: p,
        available: a.available,
        mode: a.mode,
        note:
          a.mode === "live"
            ? "token/credentials present — live HTTP"
            : "mock mode (set provider token env for live)",
      };
    },
  );
}
