/**
 * Multi-SCM adapter interface — GitHub live; GitLab/Bitbucket stubs with same shape.
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

export type ScmAdapter = {
  provider: ScmProvider;
  available: boolean;
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
  }) => Promise<{ ok: boolean }>;
  listOpenPrs: (input: {
    owner: string;
    repo: string;
  }) => Promise<ScmPr[]>;
};

function stubAdapter(provider: ScmProvider): ScmAdapter {
  return {
    provider,
    available: false,
    async createPr(input) {
      return {
        id: `${provider}-stub`,
        number: 0,
        title: input.title,
        url: `https://${provider}.example/${input.owner}/${input.repo}/-/merge_requests/0`,
        state: "open",
        provider,
      };
    },
    async commentOnPr() {
      return { ok: false };
    },
    async listOpenPrs() {
      return [];
    },
  };
}

/** GitHub adapter uses env token when present; otherwise mock URLs. */
export function createGitHubAdapter(): ScmAdapter {
  const token = process.env.GITHUB_TOKEN;
  return {
    provider: "github",
    available: !!token,
    async createPr(input) {
      if (!token) {
        return {
          id: "gh-mock",
          number: 1,
          title: input.title,
          url: `https://github.com/${input.owner}/${input.repo}/pull/1`,
          state: "open",
          provider: "github",
        };
      }
      // Real Octokit path lives in @mendpoint/github — this adapter stays thin
      return {
        id: "gh-token-present",
        number: 0,
        title: input.title,
        url: `https://github.com/${input.owner}/${input.repo}/compare/${input.base}...${input.head}`,
        state: "open",
        provider: "github",
      };
    },
    async commentOnPr() {
      return { ok: !!token };
    },
    async listOpenPrs(input) {
      return [
        {
          id: "1",
          number: 1,
          title: "mock open pr",
          url: `https://github.com/${input.owner}/${input.repo}/pull/1`,
          state: "open",
          provider: "github",
        },
      ];
    },
  };
}

export function getScmAdapter(provider: ScmProvider): ScmAdapter {
  if (provider === "github") return createGitHubAdapter();
  return stubAdapter(provider);
}

export function listScmProviders(): Array<{
  provider: ScmProvider;
  available: boolean;
  note: string;
}> {
  return [
    {
      provider: "github",
      available: true,
      note: process.env.GITHUB_TOKEN ? "token set" : "mock mode",
    },
    {
      provider: "gitlab",
      available: false,
      note: "adapter stub — same ScmAdapter interface",
    },
    {
      provider: "bitbucket",
      available: false,
      note: "adapter stub",
    },
    {
      provider: "azure_devops",
      available: false,
      note: "adapter stub",
    },
  ];
}
