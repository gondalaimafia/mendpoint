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
  readonly operation: "createPr";
  readonly status: number;
  readonly response: unknown;

  constructor(provider: ScmProvider, status: number, response: unknown) {
    super(`${provider} createPr failed with status ${status}`);
    this.name = "ScmRequestError";
    this.provider = provider;
    this.operation = "createPr";
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
    const res = await fetch(url, init);
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

function assertCreatePrSucceeded(
  provider: ScmProvider,
  result: { ok: boolean; status: number; json: unknown },
): void {
  if (!result.ok) {
    throw new ScmRequestError(provider, result.status, result.json);
  }
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
      assertCreatePrSucceeded("github", r);
      const j = r.json as { id?: number; number?: number; html_url?: string; state?: string };
      return {
        id: String(j.id ?? "gh"),
        number: j.number ?? 0,
        title: input.title,
        url: j.html_url ?? mockPr("github", input).url,
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
      return { ok: r.ok, id: String((r.json as { id?: number })?.id ?? "") };
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
      if (!r.ok || !Array.isArray(r.json)) return [];
      return (r.json as Array<{ id: number; number: number; title: string; html_url: string }>).map(
        (p) => ({
          id: String(p.id),
          number: p.number,
          title: p.title,
          url: p.html_url,
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
      assertCreatePrSucceeded("gitlab", r);
      const j = r.json as { id?: number; iid?: number; web_url?: string; state?: string };
      return {
        id: String(j.id ?? "gl"),
        number: j.iid ?? 0,
        title: input.title,
        url: j.web_url ?? mockPr("gitlab", input).url,
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
      return { ok: r.ok, id: String((r.json as { id?: number })?.id ?? "") };
    },
    async listOpenPrs(input) {
      if (!token) return [mockPr("gitlab", { ...input, title: "mock open mr" })];
      const project = encodeURIComponent(`${input.owner}/${input.repo}`);
      const r = await fetchImpl(
        `${api}/projects/${project}/merge_requests?state=opened&per_page=20`,
        { headers: { "PRIVATE-TOKEN": token } },
      );
      if (!r.ok || !Array.isArray(r.json)) return [];
      return (r.json as Array<{ id: number; iid: number; title: string; web_url: string }>).map(
        (p) => ({
          id: String(p.id),
          number: p.iid,
          title: p.title,
          url: p.web_url,
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
      assertCreatePrSucceeded("bitbucket", r);
      const j = r.json as {
        id?: number;
        links?: { html?: { href?: string } };
        state?: string;
      };
      return {
        id: String(j.id ?? "bb"),
        number: j.id ?? 0,
        title: input.title,
        url: j.links?.html?.href ?? mockPr("bitbucket", input).url,
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
      return { ok: r.ok, id: String((r.json as { id?: number })?.id ?? "") };
    },
    async listOpenPrs(input) {
      if (!auth) return [mockPr("bitbucket", { ...input, title: "mock open pr" })];
      const r = await fetchImpl(
        `${api}/repositories/${input.owner}/${input.repo}/pullrequests?state=OPEN&pagelen=20`,
        { headers: { Authorization: auth } },
      );
      const values = (r.json as { values?: Array<{ id: number; title: string; links?: { html?: { href?: string } } }> })
        ?.values;
      if (!r.ok || !values) return [];
      return values.map((p) => ({
        id: String(p.id),
        number: p.id,
        title: p.title,
        url:
          p.links?.html?.href ??
          mockPr("bitbucket", { ...input, title: p.title }).url,
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
      assertCreatePrSucceeded("azure_devops", r);
      const j = r.json as {
        pullRequestId?: number;
        url?: string;
        status?: string;
      };
      return {
        id: String(j.pullRequestId ?? "ado"),
        number: j.pullRequestId ?? 0,
        title: input.title,
        url: j.url ?? mockPr("azure_devops", input).url,
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
      return { ok: r.ok, id: String((r.json as { id?: number })?.id ?? "") };
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
      if (!r.ok || !values) return [];
      return values.map((p) => ({
        id: String(p.pullRequestId),
        number: p.pullRequestId,
        title: p.title,
        url:
          p.url ??
          mockPr("azure_devops", { ...input, title: p.title }).url,
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
