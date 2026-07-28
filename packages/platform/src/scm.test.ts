import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAzureDevOpsAdapter,
  createBitbucketAdapter,
  createGitHubAdapter,
  createGitLabAdapter,
  type ScmAdapter,
  type ScmProvider,
} from "./scm.js";

const input = {
  owner: "owner",
  repo: "repo",
  title: "Title",
  body: "Body",
  head: "feature",
  base: "main",
};

const failedFetch = async () => ({
  ok: false,
  status: 503,
  json: { message: "service unavailable" },
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("live SCM failures", () => {
  const cases: Array<{
    provider: ScmProvider;
    create: () => ScmAdapter;
    configure: () => void;
  }> = [
    {
      provider: "github",
      configure: () => vi.stubEnv("GITHUB_TOKEN", "token"),
      create: () => createGitHubAdapter(failedFetch),
    },
    {
      provider: "gitlab",
      configure: () => vi.stubEnv("GITLAB_TOKEN", "token"),
      create: () => createGitLabAdapter(failedFetch),
    },
    {
      provider: "bitbucket",
      configure: () => vi.stubEnv("BITBUCKET_TOKEN", "token"),
      create: () => createBitbucketAdapter(failedFetch),
    },
    {
      provider: "azure_devops",
      configure: () => {
        vi.stubEnv("AZURE_DEVOPS_PAT", "token");
        vi.stubEnv("AZURE_DEVOPS_API_URL", "https://azure.example/repository");
      },
      create: () => createAzureDevOpsAdapter(failedFetch),
    },
  ];

  it.each(cases)(
    "returns an explicit $provider createPr failure instead of a fake PR",
    async ({ provider, create, configure }) => {
      configure();
      const adapter = create();

      await expect(adapter.createPr(input)).rejects.toMatchObject({
        name: "ScmRequestError",
        provider,
        operation: "createPr",
        status: 503,
        response: { message: "service unavailable" },
      });
    },
  );
});
