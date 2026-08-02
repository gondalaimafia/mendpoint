import { describe, expect, it } from "vitest";
import {
  GitLabFixtureAdapter,
  type GitLabFixtureAuth,
  type GitLabFixtureCredential,
  type GitLabFixtureProjectSeed,
} from "./gitlab-fixture.js";

const BASE_SHA = "a".repeat(40);
const NOW = new Date("2026-08-02T12:00:00.000Z");

const credential: GitLabFixtureCredential = {
  tenantId: "tenant-a",
  credentialId: "gitlab-credential-a",
  token: "fixture-token-a",
};

const project: GitLabFixtureProjectSeed = {
  tenantId: "tenant-a",
  projectId: "101",
  pathWithNamespace: "acme/payments",
  defaultBranch: "main",
  webhookSecret: "fixture-hook-secret",
  branches: { main: BASE_SHA },
  commits: [
    {
      sha: BASE_SHA,
      message: "Initial fixture",
      files: {
        ".gitlab-ci.yml": "test:\n  script: npm test\n",
        "src/index.ts": "export const version = 1;\n",
      },
    },
  ],
};

const author: GitLabFixtureAuth = {
  tenantId: "tenant-a",
  credentialId: credential.credentialId,
  token: credential.token,
  actorId: "user:author",
};

const reviewer: GitLabFixtureAuth = { ...author, actorId: "user:reviewer" };

function adapter(
  overrides: {
    credentials?: readonly GitLabFixtureCredential[];
    projects?: readonly GitLabFixtureProjectSeed[];
  } = {},
) {
  return new GitLabFixtureAdapter({
    credentials: overrides.credentials ?? [credential],
    projects: overrides.projects ?? [project],
    now: () => NOW,
  });
}

function expectCode(action: () => unknown, code: string) {
  expect(action).toThrow(expect.objectContaining({ name: "GitLabFixtureError", code }));
}

function deliverChange(gitlab: GitLabFixtureAdapter) {
  const branch = gitlab.createBranch(author, {
    projectId: project.projectId,
    branch: "mendpoint/node-20",
    fromRef: "main",
    deliveryId: "branch-delivery",
  });
  const commit = gitlab.commitFiles(author, {
    projectId: project.projectId,
    branch: branch.branch,
    expectedHeadSha: branch.sha,
    message: "Raise Node runtime",
    files: [{ path: "package.json", content: '{"engines":{"node":">=20"}}\n' }],
    deliveryId: "commit-delivery",
  });
  const mergeRequest = gitlab.openDraftMergeRequest(author, {
    projectId: project.projectId,
    sourceBranch: branch.branch,
    targetBranch: "main",
    title: "Raise Node runtime",
    description: "Fixture delivery only",
    deliveryId: "mr-delivery",
  });
  return { branch, commit, mergeRequest };
}

describe("GitLab fixture repository adapter", () => {
  it("resolves an immutable exact snapshot with stable manifest evidence", () => {
    const gitlab = adapter();
    const byBranch = gitlab.snapshot(author, { projectId: "101", ref: "main" });
    const byCommit = gitlab.snapshot(author, { projectId: "101", ref: BASE_SHA });

    expect(byBranch.sha).toBe(byCommit.sha);
    expect(byBranch.manifestSha256).toBe(byCommit.manifestSha256);
    expect(byBranch.files).toEqual(byCommit.files);
    expect(byBranch.requestedRef).toBe("main");
    expect(byCommit.requestedRef).toBe(BASE_SHA);
    expect(byBranch).toMatchObject({
      provider: "gitlab",
      tenantId: "tenant-a",
      repositoryId: "gitlab:acme/payments",
      sha: BASE_SHA,
    });
    expect(byBranch.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(byBranch.files.map((file) => file.path)).toEqual([
      ".gitlab-ci.yml",
      "src/index.ts",
    ]);
    expect(Object.isFrozen(byBranch)).toBe(true);
    expect(Object.isFrozen(byBranch.files)).toBe(true);
    expect(Object.isFrozen(byBranch.files[0])).toBe(true);
  });

  it("rejects repository paths that would collide when materialized", () => {
    expectCode(
      () =>
        adapter({
          projects: [
            {
              ...project,
              commits: [
                {
                  sha: BASE_SHA,
                  message: "Unsafe fixture",
                  files: { "src/File.ts": "a", "src/file.ts": "b" },
                },
              ],
            },
          ],
        }),
      "INVALID_INPUT",
    );
  });

  it("creates a branch and commit, opens only a draft merge request, and records pipeline state", () => {
    const gitlab = adapter();
    const { commit, mergeRequest } = deliverChange(gitlab);

    expect(commit).toMatchObject({ parentSha: BASE_SHA, recovered: false });
    expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(mergeRequest).toMatchObject({
      draft: true,
      state: "open",
      sourceSha: commit.sha,
      authorId: author.actorId,
    });
    expect(mergeRequest.url).toContain("/-/merge_requests/1");

    gitlab.recordPipeline(author, {
      projectId: "101",
      sha: commit.sha,
      status: "running",
    });
    expect(gitlab.getPipelineStatus(author, { projectId: "101", sha: commit.sha })).toBe(
      "running",
    );
  });

  it("requires successful exact commit CI, resolved discussions, and immutable review evidence", () => {
    const gitlab = adapter();
    const { commit, mergeRequest } = deliverChange(gitlab);
    const discussion = gitlab.addDiscussion(reviewer, {
      projectId: "101",
      mergeRequestIid: mergeRequest.iid,
      body: "Show the migration test result",
    });

    expectCode(
      () =>
        gitlab.approveMergeRequest(reviewer, {
          projectId: "101",
          mergeRequestIid: mergeRequest.iid,
          reviewEvidence: ["artifact://review/1"],
        }),
      "PIPELINE_NOT_SUCCESSFUL",
    );
    gitlab.recordPipeline(author, {
      projectId: "101",
      sha: commit.sha,
      status: "success",
    });
    expectCode(
      () =>
        gitlab.approveMergeRequest(reviewer, {
          projectId: "101",
          mergeRequestIid: mergeRequest.iid,
          reviewEvidence: ["artifact://review/1"],
        }),
      "UNRESOLVED_DISCUSSIONS",
    );
    expectCode(
      () =>
        gitlab.resolveDiscussion(reviewer, {
          projectId: "101",
          discussionId: discussion.id,
          evidence: [],
        }),
      "REVIEW_EVIDENCE_REQUIRED",
    );
    gitlab.resolveDiscussion(reviewer, {
      projectId: "101",
      discussionId: discussion.id,
      evidence: ["artifact://discussion/1"],
    });
    expectCode(
      () =>
        gitlab.approveMergeRequest(reviewer, {
          projectId: "101",
          mergeRequestIid: mergeRequest.iid,
          reviewEvidence: [],
        }),
      "REVIEW_EVIDENCE_REQUIRED",
    );

    expect(
      gitlab.approveMergeRequest(reviewer, {
        projectId: "101",
        mergeRequestIid: mergeRequest.iid,
        reviewEvidence: ["artifact://review/1", "pipeline://101/success"],
      }),
    ).toEqual({
      mergeRequestIid: 1,
      reviewerId: "user:reviewer",
      reviewEvidence: ["artifact://review/1", "pipeline://101/success"],
      approvedAt: NOW.toISOString(),
    });
  });

  it("forbids self approval and never exposes a merge operation", () => {
    const gitlab = adapter();
    const { commit, mergeRequest } = deliverChange(gitlab);
    gitlab.recordPipeline(author, {
      projectId: "101",
      sha: commit.sha,
      status: "success",
    });
    expectCode(
      () =>
        gitlab.approveMergeRequest(author, {
          projectId: "101",
          mergeRequestIid: mergeRequest.iid,
          reviewEvidence: ["artifact://review/1"],
        }),
      "SELF_APPROVAL_FORBIDDEN",
    );
    expect("mergeMergeRequest" in gitlab).toBe(false);
  });

  it("fails closed on cross tenant access, ambiguous authorization, and revoked credentials", () => {
    const gitlab = adapter({
      credentials: [
        credential,
        {
          tenantId: "tenant-b",
          credentialId: "gitlab-credential-b",
          token: "fixture-token-b",
        },
      ],
    });
    expectCode(
      () =>
        gitlab.snapshot(
          {
            tenantId: "tenant-b",
            credentialId: "gitlab-credential-b",
            token: "fixture-token-b",
            actorId: "user:b",
          },
          { projectId: "101", ref: "main" },
        ),
      "TENANT_SCOPE_DENIED",
    );

    const ambiguous = adapter({ credentials: [credential, credential] });
    expectCode(
      () => ambiguous.snapshot(author, { projectId: "101", ref: "main" }),
      "AUTH_AMBIGUOUS",
    );

    gitlab.revokeCredential("tenant-a", credential.credentialId, NOW.toISOString());
    expectCode(
      () => gitlab.snapshot(author, { projectId: "101", ref: "main" }),
      "CREDENTIAL_REVOKED",
    );
    expect(gitlab.getAuditEvents("tenant-a").at(-1)).toMatchObject({
      action: "snapshot",
      outcome: "denied",
      reason: "CREDENTIAL_REVOKED",
    });
  });

  it("accepts signed pipeline webhooks once and rejects unsigned, replayed, and mismatched deliveries", () => {
    const gitlab = adapter();
    const { commit } = deliverChange(gitlab);
    const rawBody = JSON.stringify({
      project: { id: 101 },
      object_attributes: { sha: commit.sha, status: "success" },
    });
    const headers = {
      "X-Gitlab-Token": project.webhookSecret,
      "X-Gitlab-Event-UUID": "delivery-1",
      "X-Gitlab-Event": "Pipeline Hook",
    };

    expectCode(
      () =>
        gitlab.receiveWebhook({
          tenantId: "tenant-a",
          projectId: "101",
          rawBody,
          headers: { ...headers, "X-Gitlab-Token": undefined },
        }),
      "WEBHOOK_UNSIGNED",
    );
    expect(
      gitlab.receiveWebhook({ tenantId: "tenant-a", projectId: "101", rawBody, headers }),
    ).toEqual({ deliveryId: "delivery-1", event: "Pipeline Hook", accepted: true });
    expect(gitlab.getPipelineStatus(author, { projectId: "101", sha: commit.sha })).toBe(
      "success",
    );
    expectCode(
      () =>
        gitlab.receiveWebhook({ tenantId: "tenant-a", projectId: "101", rawBody, headers }),
      "WEBHOOK_REPLAY",
    );
    expectCode(
      () =>
        gitlab.receiveWebhook({
          tenantId: "tenant-a",
          projectId: "101",
          rawBody: JSON.stringify({
            project: { id: 999 },
            object_attributes: { sha: commit.sha, status: "success" },
          }),
          headers: { ...headers, "X-Gitlab-Event-UUID": "delivery-2" },
        }),
      "TENANT_SCOPE_DENIED",
    );
  });

  it("replays identical deliveries safely and rejects a divergent recovery", () => {
    const gitlab = adapter();
    const request = {
      projectId: "101",
      branch: "mendpoint/recovery",
      fromRef: "main",
      deliveryId: "recovery-delivery",
    };
    const first = gitlab.createBranch(author, request);
    expect(gitlab.createBranch(author, request)).toBe(first);

    expectCode(
      () =>
        gitlab.createBranch(author, {
          ...request,
          branch: "mendpoint/different",
        }),
      "DIVERGENT_RECOVERY",
    );

    const commitRequest = {
      projectId: "101",
      branch: request.branch,
      expectedHeadSha: first.sha,
      message: "Recovery fixture",
      files: [{ path: "src/recovery.ts", content: "export const recovered = true;\n" }],
      deliveryId: "commit-recovery-delivery",
    };
    const commit = gitlab.commitFiles(author, commitRequest);
    expect(gitlab.commitFiles(author, commitRequest)).toBe(commit);
    expectCode(
      () =>
        gitlab.commitFiles(author, {
          ...commitRequest,
          files: [{ path: "src/recovery.ts", content: "divergent\n" }],
        }),
      "DIVERGENT_RECOVERY",
    );
  });
});
