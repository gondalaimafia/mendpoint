import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  GitHubRestClient,
  githubAuthorityContextFromEvent,
  verifyGitHubClosureAuthority,
  writeGitHubAuthorityFailureObservation,
  writeGitHubAuthorityObservation,
  type GitHubAuthorityClient,
  type GitHubAuthorityContext,
  type GitHubAuthorityMatrix,
  type GitHubCheckRun,
  type GitHubCommitStatus,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubReview,
  type GitHubWorkflowJob,
  type GitHubWorkflowRun,
} from "./production-closure-github-authority.js";

const MAIN = "a".repeat(40);
const HEAD = "b".repeat(40);
const MERGE = "c".repeat(40);
const MERGED = "d".repeat(40);

function matrix(): GitHubAuthorityMatrix {
  return {
    issueAuthority: {
      repository: "gondalaimafia/mendpoint",
      issues: [
        {
          number: 430,
          state: "open",
          owner: "gondalaimafia",
          title: "Production closure FC 00",
          url: "https://github.com/gondalaimafia/mendpoint/issues/430",
          updatedAt: "2026-08-25T10:05:19.000Z",
          requirementIds: ["ME-FND-001"],
        },
      ],
    },
    releaseTrain: {
      repository: "gondalaimafia/mendpoint",
      observedMainRevision: MAIN,
      pullRequests: [],
      currentPullRequestBootstrap: {
        observationSource: "github_api",
        number: 440,
        url: "https://github.com/gondalaimafia/mendpoint/pull/440",
        title: "Harden production closure authority",
        baseBranch: "main",
        headBranch: "codex/production-closure-authority-hardening",
        owner: {
          actor: "Codex",
          source: "github_label",
          label: "release-owner:codex",
        },
        disposition: "merge_after_rebase_and_review",
        dependencies: { pullRequests: [], branches: [] },
        requirementIds: ["ME-FND-001"],
        blockers: [],
        remediatesPullRequests: [],
      },
    },
  };
}

function pullRequest(overrides: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
  return {
    number: 440,
    state: "open",
    merged: false,
    merge_commit_sha: null,
    title: "Harden production closure authority",
    html_url: "https://github.com/gondalaimafia/mendpoint/pull/440",
    body: "## Requirement mapping\n\n- ME-FND-001\n",
    user: { login: "gondalaimafia" },
    labels: [{ name: "release-owner:codex" }],
    head: {
      ref: "codex/production-closure-authority-hardening",
      sha: HEAD,
    },
    base: { ref: "main", sha: MAIN },
    ...overrides,
  };
}

function issue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 430,
    state: "open",
    title: "Production closure FC 00",
    html_url: "https://github.com/gondalaimafia/mendpoint/issues/430",
    body: "## Requirement mapping\n\n- ME-FND-001\n",
    updated_at: "2026-08-25T10:05:19Z",
    assignees: [{ login: "gondalaimafia" }],
    ...overrides,
  };
}

function checks(overrides: Partial<GitHubCheckRun> = {}): GitHubCheckRun[] {
  return ["test", "release-gates", "container-builds", "deployment-e2e"].map(
    (name, index) => ({
      id: index + 1,
      name,
      status: "completed",
      conclusion: "success",
      head_sha: HEAD,
      html_url: `https://github.com/gondalaimafia/mendpoint/actions/runs/1/job/${index + 1}`,
      ...overrides,
    }),
  );
}

function reviews(overrides: Partial<GitHubReview> = {}): GitHubReview[] {
  return [
    {
      id: 71,
      state: "APPROVED",
      commit_id: HEAD,
      user: { login: "claude-reviewer[bot]", id: 71 },
      body: null,
      submitted_at: "2026-08-25T12:00:00Z",
      html_url: "https://github.com/gondalaimafia/mendpoint/pull/440#pullrequestreview-71",
      ...overrides,
    },
  ];
}

function context(
  overrides: Partial<GitHubAuthorityContext> = {},
): GitHubAuthorityContext {
  return {
    eventName: "pull_request",
    observationScope: "full_release_train",
    providerValidationPullRequests: [],
    providerValidationIssues: [],
    repository: "gondalaimafia/mendpoint",
    githubSha: MAIN,
    workflowRunId: "1234",
    observedAt: "2026-08-25T12:05:00.000Z",
    checkout: { headRevision: MAIN, parentRevisions: [] },
    pullRequest: {
      number: 440,
      baseRef: "main",
      baseRevision: MAIN,
      headRef: "codex/production-closure-authority-hardening",
      headRevision: HEAD,
    },
    trustedReviewerIdentities: {
      Claude: [{ login: "claude-reviewer[bot]", userId: 71 }],
      Cursor: [{ login: "cursor-reviewer[bot]", userId: 72 }],
    },
    ...overrides,
  };
}

class FixtureClient implements GitHubAuthorityClient {
  mainReads = 0;
  pullRequestReads: number[] = [];
  issueReads: number[] = [];
  mainRevisions = [MAIN, MAIN];
  ancestorRevisions: string[] = [];
  ancestorPairs: string[] = [];
  openPullRequests = [pullRequest()];
  trackedPullRequest = pullRequest();
  pullRequestsByNumber = new Map<number, GitHubPullRequest>();
  trackedChecks = checks();
  trackedWorkflowRuns: GitHubWorkflowRun[] = [{
    id: 101,
    path: ".github/workflows/ci.yml@refs/pull/440/merge",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: HEAD,
    html_url: "https://github.com/gondalaimafia/mendpoint/actions/runs/101",
  }];
  trackedWorkflowJobs: GitHubWorkflowJob[] = checks().map((check) => ({
    id: check.id,
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
  }));
  trackedReviews = reviews();
  trackedStatuses: GitHubCommitStatus[] = [];
  trackedIssue = issue();
  failure: Error | null = null;

  async getMainRevision(): Promise<string> {
    if (this.failure) throw this.failure;
    return this.mainRevisions[Math.min(this.mainReads++, this.mainRevisions.length - 1)];
  }
  async revisionIsAncestor(revision: string, descendant: string): Promise<boolean> {
    if (this.failure) throw this.failure;
    return (
      revision === descendant ||
      this.ancestorPairs.includes(`${revision}:${descendant}`) ||
      this.ancestorRevisions.includes(revision)
    );
  }
  async listOpenPullRequests(): Promise<GitHubPullRequest[]> {
    if (this.failure) throw this.failure;
    return this.openPullRequests;
  }
  async getPullRequest(number: number): Promise<GitHubPullRequest> {
    if (this.failure) throw this.failure;
    this.pullRequestReads.push(number);
    return this.pullRequestsByNumber.get(number) ?? this.trackedPullRequest;
  }
  async listCheckRuns(): Promise<GitHubCheckRun[]> {
    if (this.failure) throw this.failure;
    return this.trackedChecks;
  }
  async listWorkflowRuns(): Promise<GitHubWorkflowRun[]> {
    if (this.failure) throw this.failure;
    return this.trackedWorkflowRuns;
  }
  async listWorkflowJobs(): Promise<GitHubWorkflowJob[]> {
    if (this.failure) throw this.failure;
    return this.trackedWorkflowJobs;
  }
  async listReviews(): Promise<GitHubReview[]> {
    if (this.failure) throw this.failure;
    return this.trackedReviews;
  }
  async listCommitStatuses(): Promise<GitHubCommitStatus[]> {
    return this.trackedStatuses;
  }
  async getWorkflowRun(runId: number): Promise<GitHubWorkflowRun> {
    const run = this.trackedWorkflowRuns.find((candidate) => candidate.id === runId);
    if (!run) throw new Error("workflow run missing");
    return run;
  }
  async getIssue(number: number): Promise<GitHubIssue> {
    if (this.failure) throw this.failure;
    this.issueReads.push(number);
    return this.trackedIssue;
  }
}

function codes(result: Awaited<ReturnType<typeof verifyGitHubClosureAuthority>>) {
  return result.issues.map((entry) => entry.code);
}

describe("GitHub production closure authority", () => {
  it("runs per-PR authority from default-branch code and publishes an App-bound verdict", () => {
    const workflow = parse(
      readFileSync(
        new URL("../.github/workflows/closure-authority-quiet-sweep.yml", import.meta.url),
        "utf8",
      ),
    ) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      concurrency?: unknown;
      jobs: Record<string, {
        if?: string;
        concurrency?: { group?: string; "cancel-in-progress"?: boolean };
        permissions?: Record<string, string>;
        strategy?: { "fail-fast"?: boolean; "max-parallel"?: number };
        steps?: Array<{
          name?: string;
          run?: string;
          env?: Record<string, string>;
          with?: Record<string, string | number>;
        }>;
      }>;
    };
    const job = workflow.jobs["closure-authority"];
    const mainObservationJob = workflow.jobs["main-authority-observation"];

    expect(workflow.on).toHaveProperty("push");
    expect(workflow.on).toHaveProperty("pull_request_target");
    expect(workflow.on).toHaveProperty("schedule");
    // Trigger economics (#453): workflow_run, issues, and pull_request_review were
    // removed deliberately — each fired a full per-PR authority sweep on events that
    // change no validated input, exhausting the installation API budget. Assert they
    // stay removed so a future edit cannot quietly reintroduce the self-DoS.
    expect(workflow.on).not.toHaveProperty("workflow_run");
    expect(workflow.on).not.toHaveProperty("issues");
    expect(workflow.on).not.toHaveProperty("pull_request_review");
    // Workflow-level concurrency collapses redundant sweeps during merge bursts;
    // PR-scoped events collapse per PR. Added by #453, deliberately.
    expect(workflow.concurrency).toEqual({
      group:
        "closure-authority-${{ github.event_name == 'pull_request_target' && format('pr-{0}', github.event.pull_request.number) || 'sweep' }}",
      "cancel-in-progress": true,
    });
    expect(workflow.permissions).toEqual({
      actions: "read",
      contents: "read",
      checks: "read",
      issues: "read",
      "pull-requests": "read",
      statuses: "write",
    });
    expect(job.strategy).toMatchObject({
      "fail-fast": false,
      "max-parallel": 4,
    });
    expect(workflow.jobs["invalidate-authority"].strategy).toMatchObject({
      "fail-fast": false,
      "max-parallel": 4,
    });
    expect(job.concurrency).toEqual({
      group: "production-closure-authority-${{ matrix.pull_request }}",
      "cancel-in-progress": false,
    });
    expect(job.steps).toContainEqual(
      expect.objectContaining({
        name: "Checkout exact immutable main authority",
        with: expect.objectContaining({
          ref: "${{ needs.discover.outputs.main_sha }}",
        }),
      }),
    );
    expect(job.steps).toContainEqual(
      expect.objectContaining({
        name: "Validate exact proposal bytes with immutable authority",
        run: "npm run closure:proposal:check",
        env: expect.objectContaining({
          MENDPOINT_AUTHORITY_BASE_SHA: "${{ needs.discover.outputs.main_sha }}",
        }),
      }),
    );
    expect(job.steps).toContainEqual(
      expect.objectContaining({
        name: "Verify live GitHub release authority",
        run: "npm run closure:github:check",
      }),
    );
    expect(job.steps).toContainEqual(
      expect.objectContaining({
        name: "Create dedicated authority App token",
        uses: "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
      }),
    );
    expect(job.steps).toContainEqual(
      expect.objectContaining({ name: "Invalidate prior external authority result" }),
    );
    expect(workflow.jobs["invalidate-authority"].steps).toContainEqual(
      expect.objectContaining({
        name: "Invalidate controller authority before protected credentials",
        run: expect.stringContaining("state=pending"),
      }),
    );
    expect(
      job.steps!.findIndex((step) => step.name === "Invalidate prior external authority result"),
    ).toBeLessThan(
      job.steps!.findIndex((step) => step.name === "Checkout exact immutable main authority"),
    );
    expect(job.steps).toContainEqual(
      expect.objectContaining({ name: "Publish dedicated authority App verdict" }),
    );
    expect(job.steps).toContainEqual(
      expect.objectContaining({ name: "Verify dedicated authority App identity" }),
    );
    expect(job.steps).toContainEqual(
      expect.objectContaining({
        name: "Verify live protected branch authority bindings",
        run: expect.stringContaining("required_status_checks"),
      }),
    );
    expect(job.steps).toContainEqual(
      expect.objectContaining({ name: "Publish controller authority verdict" }),
    );
    expect(job.steps).toContainEqual(
      expect.objectContaining({
        name: "Enforce protected authority verdict",
        run: expect.stringContaining("set -euo pipefail"),
      }),
    );
    expect(mainObservationJob.steps).toContainEqual(
      expect.objectContaining({
        name: "Verify merged main authority",
        run: "npm run closure:github:check",
        env: expect.objectContaining({
          MENDPOINT_CLOSURE_EVENT_NAME: "push",
        }),
      }),
    );
    expect(mainObservationJob.if).toBe(
      "github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
  });

  it("limits pull request observations to current-head authority and global invariants", async () => {
    const configured = matrix();
    configured.releaseTrain.pullRequests.push({
      number: 439,
      state: "open",
      url: "https://github.com/gondalaimafia/mendpoint/pull/439",
      title: "Prior release work",
      headBranch: "codex/prior-release-work",
      baseBranch: "main",
      headRevision: MERGE,
      mergeRevision: null,
      requirementIds: ["ME-FND-001"],
      checkState: "stale_checks",
    });
    const client = new FixtureClient();
    client.openPullRequests = [pullRequest({ number: 439 }), pullRequest()];

    const result = await verifyGitHubClosureAuthority(
      configured,
      context({ observationScope: "current_pull_request" }),
      client,
    );

    expect(result.verdict, JSON.stringify(result.issues, null, 2)).toBe("pass");
    expect(client.pullRequestReads).toEqual([440]);
    expect(client.issueReads).toEqual([]);
    expect(result.verifiedPullRequests).toEqual([440]);
    expect(result.verifiedIssues).toEqual([]);
  });

  it("provider-validates historical declarations changed by the proposal", async () => {
    const configured = matrix();
    configured.releaseTrain.pullRequests.push({
      number: 439,
      state: "closed",
      url: "https://github.com/gondalaimafia/mendpoint/pull/439",
      title: "Changed historical work",
      headBranch: "codex/prior-release-work",
      baseBranch: "main",
      headRevision: MERGE,
      mergeRevision: null,
      requirementIds: ["ME-FND-001"],
      checkState: "closed",
    });
    const client = new FixtureClient();

    const result = await verifyGitHubClosureAuthority(
      configured,
      context({
        observationScope: "current_pull_request",
        providerValidationPullRequests: [439],
        providerValidationIssues: [430],
      }),
      client,
    );

    expect(client.pullRequestReads).toEqual([440, 439]);
    expect(client.issueReads).toEqual([430]);
    expect(codes(result)).toContain("PR_METADATA_MISMATCH");
  });

  it("routes reads onto the closure App token pool and keeps controller writes on GITHUB_TOKEN", () => {
    // A full sweep over all open PRs was exhausting the 1,000/hr Actions GITHUB_TOKEN
    // installation pool, so starved legs 403'd and skipped the whole verdict stage. Reads
    // were moved onto the dedicated closure App installation token (its own 5,000/hr pool).
    // Every controller status POST must stay on secrets.GITHUB_TOKEN: its identity (app id
    // 15368) is pinned by branch protection, so switching its token would break the binding.
    // Pin both invariants so a future edit cannot silently reintroduce the starvation or
    // relocate a controller write off its pinned identity.
    const APP_TOKEN = "${{ steps.app-token.outputs.token }}";
    const ACTIONS_TOKEN = "${{ secrets.GITHUB_TOKEN }}";
    const workflow = parse(
      readFileSync(
        new URL("../.github/workflows/closure-authority-quiet-sweep.yml", import.meta.url),
        "utf8",
      ),
    ) as {
      jobs: Record<string, {
        steps?: Array<{
          name?: string;
          run?: string;
          uses?: string;
          env?: Record<string, string>;
        }>;
      }>;
    };
    const stepEnv = (jobId: string, name: string): Record<string, string> => {
      const step = workflow.jobs[jobId].steps!.find((candidate) => candidate.name === name);
      if (!step) throw new Error(`missing step ${jobId}/${name}`);
      return step.env ?? {};
    };
    const jobMintsAppToken = (jobId: string): boolean =>
      (workflow.jobs[jobId].steps ?? []).some(
        (step) =>
          typeof step.uses === "string" &&
          step.uses.startsWith("actions/create-github-app-token@"),
      );

    // Reads on the App pool.
    expect(jobMintsAppToken("discover")).toBe(true);
    expect(stepEnv("discover", "Discover the current protected release set").GH_TOKEN).toBe(APP_TOKEN);
    expect(jobMintsAppToken("invalidate-authority")).toBe(true);
    expect(stepEnv("invalidate-authority", "Read the pull request head sha").GH_TOKEN).toBe(APP_TOKEN);
    expect(stepEnv("closure-authority", "Validate exact proposal bytes with immutable authority").GITHUB_TOKEN).toBe(APP_TOKEN);
    expect(stepEnv("closure-authority", "Verify live GitHub release authority").GITHUB_TOKEN).toBe(APP_TOKEN);
    expect(jobMintsAppToken("main-authority-observation")).toBe(true);
    expect(stepEnv("main-authority-observation", "Verify merged main authority").GITHUB_TOKEN).toBe(APP_TOKEN);

    // Controller status writes stay on the Actions GITHUB_TOKEN so app id 15368 keeps posting.
    expect(stepEnv("invalidate-authority", "Invalidate controller authority before protected credentials").GH_TOKEN).toBe(ACTIONS_TOKEN);
    expect(stepEnv("closure-authority", "Publish controller authority verdict").GH_TOKEN).toBe(ACTIONS_TOKEN);
  });

  it("accepts an exact PR event and double-reads current main", async () => {
    const client = new FixtureClient();

    const result = await verifyGitHubClosureAuthority(matrix(), context(), client);

    expect(result.verdict).toBe("pass");
    expect(result.issues).toEqual([]);
    expect(client.mainReads).toBe(2);
    expect(result.mainRevisionStart).toBe(MAIN);
    expect(result.mainRevisionEnd).toBe(MAIN);
    expect(result.verifiedPullRequests).toEqual([440]);
    expect(result.verifiedIssues).toEqual([430]);
  });

  it("requires a base-trusted exact-head attestation for an authority rotation", async () => {
    const configured = matrix();
    configured.releaseTrain.currentPullRequestBootstrap.authorityRotation = {
      rotationId: "rotation-20260825-001",
      kind: "runtime",
      issuedAt: "2026-08-25T11:00:00.000Z",
      expiresAt: "2026-08-26T11:00:00.000Z",
      basePolicySha256: `sha256:${"1".repeat(64)}`,
      proposedPolicySha256: `sha256:${"2".repeat(64)}`,
    };
    const client = new FixtureClient();
    client.trackedReviews = [...reviews({
      body: [
        "## Authority rotation attestation",
        "",
        "- Rotation ID: rotation-20260825-001",
        "- Transition: runtime",
        `- Base policy: sha256:${"1".repeat(64)}`,
        `- Proposed policy: sha256:${"2".repeat(64)}`,
      ].join("\n"),
    }), ...reviews({
      id: 72,
      user: { login: "cursor-reviewer[bot]", id: 72 },
      body: null,
    })];

    const result = await verifyGitHubClosureAuthority(configured, context(), client);

    expect(codes(result)).not.toContain("AUTHORITY_ROTATION_REVIEW_ATTESTATION_REQUIRED");
  });

  it("rejects a wrong or out-of-window authority rotation attestation", async () => {
    const configured = matrix();
    configured.releaseTrain.currentPullRequestBootstrap.authorityRotation = {
      rotationId: "rotation-20260825-001",
      kind: "runtime",
      issuedAt: "2026-08-25T11:00:00.000Z",
      expiresAt: "2026-08-25T11:30:00.000Z",
      basePolicySha256: `sha256:${"1".repeat(64)}`,
      proposedPolicySha256: `sha256:${"2".repeat(64)}`,
    };
    const client = new FixtureClient();
    client.trackedReviews = reviews({
      body: [
        "## Authority rotation attestation",
        "",
        "- Rotation ID: rotation-20260825-001",
        "- Transition: runtime",
        `- Base policy: sha256:${"1".repeat(64)}`,
        `- Proposed policy: sha256:${"3".repeat(64)}`,
      ].join("\n"),
      submitted_at: "2026-08-25T12:00:00.000Z",
    });

    const result = await verifyGitHubClosureAuthority(configured, context(), client);

    expect(codes(result)).toContain("AUTHORITY_ROTATION_REVIEW_ATTESTATION_REQUIRED");
  });

  it("requires a staged successor live run on the activation head and current base", async () => {
    const configured = matrix();
    configured.releaseTrain.currentPullRequestBootstrap.authorityRotation = {
      rotationId: "rotation-20260825-002",
      kind: "activate_successor",
      issuedAt: "2026-08-25T11:00:00.000Z",
      expiresAt: "2026-08-26T11:00:00.000Z",
      basePolicySha256: `sha256:${"1".repeat(64)}`,
      proposedPolicySha256: `sha256:${"2".repeat(64)}`,
      successor: {
        templatePath: "config/production-closure-successors/closure-authority-v2.yml",
        workflowPath: ".github/workflows/closure-authority-v2.yml",
        workflowSha256: `sha256:${"3".repeat(64)}`,
        externalCheckName: "mendpoint-production-closure-authority-v2",
        externalCheckAppId: 123,
        controllerCheckName: "mendpoint-production-closure-controller-v2",
        controllerCheckAppId: 15368,
        controllerStatusCreatorLogin: "github-actions[bot]",
        controllerStatusCreatorUserId: 41898282,
        activationDeadline: "2026-08-26T11:00:00.000Z",
      },
    };
    const client = new FixtureClient();
    client.trackedReviews = reviews({
      body: [
        "## Authority rotation attestation",
        "",
        "- Rotation ID: rotation-20260825-002",
        "- Transition: activate_successor",
        `- Base policy: sha256:${"1".repeat(64)}`,
        `- Proposed policy: sha256:${"2".repeat(64)}`,
      ].join("\n"),
    });
    client.trackedChecks.push({
      id: 202,
      name: "mendpoint-production-closure-authority-v2",
      status: "completed",
      conclusion: "success",
      head_sha: HEAD,
      html_url: "https://github.com/gondalaimafia/mendpoint/runs/202",
      details_url: "https://github.com/gondalaimafia/mendpoint/actions/runs/202",
      app: { id: 123 },
    });
    client.trackedStatuses = [{
      id: 303,
      context: "mendpoint-production-closure-controller-v2",
      state: "success",
      target_url: "https://github.com/gondalaimafia/mendpoint/actions/runs/202",
      creator: { login: "github-actions[bot]", id: 41898282 },
    }];
    client.trackedWorkflowRuns.push({
      id: 202,
      path: ".github/workflows/closure-authority-v2.yml@refs/heads/main",
      event: "pull_request_target",
      status: "completed",
      conclusion: "success",
      head_sha: MAIN,
      html_url: "https://github.com/gondalaimafia/mendpoint/actions/runs/202",
    });

    const result = await verifyGitHubClosureAuthority(configured, context(), client);

    expect(result.verdict, JSON.stringify(result.issues, null, 2)).toBe("pass");
    expect(result.workflowRunIds).toContain(202);

    client.trackedChecks.at(-1)!.app = { id: 999 };
    const wrongApp = await verifyGitHubClosureAuthority(configured, context(), client);
    expect(codes(wrongApp)).toContain("AUTHORITY_SUCCESSOR_LIVE_PROOF_REQUIRED");

    client.trackedChecks.at(-1)!.app = { id: 123 };
    client.trackedStatuses[0].creator = { login: "untrusted-bot", id: 999 };
    const wrongControllerProducer = await verifyGitHubClosureAuthority(configured, context(), client);
    expect(codes(wrongControllerProducer)).toContain("AUTHORITY_SUCCESSOR_LIVE_PROOF_REQUIRED");
  });

  it("accepts a matrix that omits a newer live-open pull request", async () => {
    // Cross-PR completeness is unsatisfiable by a PR-authored snapshot: PR #441 was
    // opened after this matrix was authored, so the matrix cannot enumerate it. The
    // snapshot omitting a live-open sibling must not fail.
    const client = new FixtureClient();
    client.openPullRequests = [pullRequest(), pullRequest({ number: 441 })];

    const result = await verifyGitHubClosureAuthority(matrix(), context(), client);

    expect(result.verdict, JSON.stringify(result.issues, null, 2)).toBe("pass");
    expect(codes(result)).not.toContain("OPEN_PR_COMPLETENESS_MISMATCH");
  });

  it("accepts a matrix that still lists a pull request that has since merged", async () => {
    // The matrix records #439 as open; it has since merged and left the live open set.
    // Dropping completeness means this stale-but-honest snapshot passes. #439 carries no
    // green check state, so only the (now open-relaxed) metadata mirror would have fired.
    const configured = matrix();
    configured.releaseTrain.pullRequests.push({
      number: 439,
      state: "open",
      url: "https://github.com/gondalaimafia/mendpoint/pull/439",
      title: "Prior release work",
      headBranch: "codex/prior-release-work",
      baseBranch: "main",
      headRevision: MERGE,
      mergeRevision: null,
      requirementIds: ["ME-FND-001"],
      checkState: "stale_checks",
    });
    const client = new FixtureClient();
    client.openPullRequests = [pullRequest()];
    client.pullRequestsByNumber.set(
      439,
      pullRequest({ number: 439, state: "closed", merged: true, merge_commit_sha: MERGED }),
    );

    const result = await verifyGitHubClosureAuthority(configured, context(), client);

    expect(result.verdict, JSON.stringify(result.issues, null, 2)).toBe("pass");
    expect(codes(result)).not.toContain("OPEN_PR_COMPLETENESS_MISMATCH");
  });

  it("relaxes the metadata mirror for an open sibling that drifted, retitled or closed", async () => {
    // The live sibling has been retitled and re-pushed and its state moved on since the
    // snapshot; because the record is open (not the bootstrap), the mirror is not judged.
    const configured = matrix();
    configured.releaseTrain.pullRequests.push({
      number: 439,
      state: "open",
      url: "https://github.com/gondalaimafia/mendpoint/pull/439",
      title: "Prior release work",
      headBranch: "codex/prior-release-work",
      baseBranch: "main",
      headRevision: MERGE,
      mergeRevision: null,
      requirementIds: ["ME-FND-001"],
      checkState: "stale_checks",
    });
    const client = new FixtureClient();
    client.pullRequestsByNumber.set(
      439,
      pullRequest({
        number: 439,
        state: "closed",
        title: "Prior release work (renamed)",
        html_url: "https://github.com/gondalaimafia/mendpoint/pull/439",
        head: { ref: "codex/prior-release-work", sha: "e".repeat(40) },
        body: "## Requirement mapping\n\n- ME-FND-777\n",
      }),
    );

    const result = await verifyGitHubClosureAuthority(configured, context(), client);

    expect(result.verdict, JSON.stringify(result.issues, null, 2)).toBe("pass");
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: "PR_METADATA_MISMATCH", subject: "439" }),
    );
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: "PR_REQUIREMENT_MAPPING_MISMATCH", subject: "439" }),
    );
  });

  it("still fails a matrix that records a pull request number that never existed", async () => {
    // A fabricated open sibling number resolves to nothing on GitHub; the live read
    // throws and the observation fails closed. Dropping completeness does not open a
    // hole for fabricated numbers in a full-release-train sweep.
    const configured = matrix();
    configured.releaseTrain.pullRequests.push({
      number: 999999,
      state: "open",
      url: "https://github.com/gondalaimafia/mendpoint/pull/999999",
      title: "Fabricated",
      headBranch: "codex/fabricated",
      baseBranch: "main",
      headRevision: MERGE,
      mergeRevision: null,
      requirementIds: ["ME-FND-001"],
      checkState: "stale_checks",
    });
    const notFound = new (class extends FixtureClient {
      async getPullRequest(number: number): Promise<GitHubPullRequest> {
        this.pullRequestReads.push(number);
        if (number === 999999) throw new Error("GitHub API request failed with HTTP 404");
        return super.getPullRequest(number);
      }
    })();

    const result = await verifyGitHubClosureAuthority(configured, context(), notFound);

    expect(result.verdict).toBe("fail");
    expect(codes(result)).toContain("GITHUB_AUTHORITY_UNAVAILABLE");
  });

  it("accepts a matrix observed revision that is an ancestor of main but not the tip", async () => {
    // The snapshot was taken at an earlier main; main advanced afterward. Ancestry holds,
    // so both the start- and end-of-observation revision checks pass. Exact equality (the
    // prior behavior at both sites) would have failed this.
    const client = new FixtureClient();
    const configured = matrix();
    const earlierMain = "e".repeat(40);
    configured.releaseTrain.observedMainRevision = earlierMain;
    client.ancestorRevisions = [earlierMain];

    const result = await verifyGitHubClosureAuthority(configured, context(), client);

    expect(result.verdict, JSON.stringify(result.issues, null, 2)).toBe("pass");
    expect(codes(result)).not.toContain("MATRIX_MAIN_REVISION_MISMATCH");
  });

  it("still fails a matrix observed revision that is not an ancestor of main", async () => {
    // A forked or fabricated revision is not an ancestor of live main; the ancestry guard
    // still rejects it at both emission sites.
    const client = new FixtureClient();
    const configured = matrix();
    configured.releaseTrain.observedMainRevision = "f".repeat(40);

    const result = await verifyGitHubClosureAuthority(configured, context(), client);

    expect(codes(result)).toContain("MATRIX_MAIN_REVISION_MISMATCH");
  });

  it("still fails a matrix claiming a merged sibling at a revision that is not its merge commit", async () => {
    // The load-bearing dependency binding. #439 is recorded merged at MERGE (a real
    // ancestor of main), but its actual merge_commit_sha is MERGED. Merged records stay
    // strictly mirrored, so this fabricated merge revision is caught. This is the only
    // live proof a claimed-merged dependency actually merged at the recorded revision.
    const configured = matrix();
    configured.releaseTrain.observedMainRevision = MAIN;
    configured.releaseTrain.pullRequests.push({
      number: 439,
      state: "merged",
      url: "https://github.com/gondalaimafia/mendpoint/pull/439",
      title: "Merged dependency",
      headBranch: "codex/merged-dependency",
      baseBranch: "main",
      headRevision: HEAD,
      mergeRevision: MERGE,
      requirementIds: ["ME-FND-001"],
      checkState: "stale_checks",
    });
    const client = new FixtureClient();
    client.ancestorRevisions = [MERGE];
    client.pullRequestsByNumber.set(
      439,
      pullRequest({
        number: 439,
        state: "closed",
        merged: true,
        merge_commit_sha: MERGED,
        title: "Merged dependency",
        html_url: "https://github.com/gondalaimafia/mendpoint/pull/439",
        head: { ref: "codex/merged-dependency", sha: HEAD },
      }),
    );

    const result = await verifyGitHubClosureAuthority(configured, context(), client);

    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "PR_METADATA_MISMATCH", subject: "439" }),
    );
  });

  // Reconstruction of the #284 case (its live instance has since been corrected on
  // main): an unfinished requirement whose sole closure path cites a pull request the
  // matrix records as open but which is absent from the live open set. This is the
  // durable evidence the live-open closure-path guard works.
  function me284Matrix(): GitHubAuthorityMatrix {
    const configured = matrix();
    configured.requirements = [
      { requirementId: "ME-GTM-003", issues: [], pullRequests: [284] },
    ];
    configured.releaseTrain.pullRequests.push({
      number: 284,
      state: "open",
      url: "https://github.com/gondalaimafia/mendpoint/pull/284",
      title: "Make the public claims gate able to fail",
      headBranch: "claude/claims-gate-drift",
      baseBranch: "main",
      headRevision: MERGE,
      mergeRevision: null,
      requirementIds: ["ME-GTM-003"],
      checkState: "behind",
    });
    return configured;
  }

  it("fails an unfinished requirement whose only closure-path PR is absent from the live open set", async () => {
    const client = new FixtureClient();
    client.openPullRequests = [pullRequest()]; // live open = {440}; #284 has closed

    const result = await verifyGitHubClosureAuthority(
       me284Matrix(),
      context({ canonicalRequirementStatuses: { "ME-GTM-003": "partial" } }),
      client,
    );

    expect(codes(result)).toContain("REQUIREMENT_CLOSURE_PATH_PR_NOT_LIVE_OPEN");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "REQUIREMENT_CLOSURE_PATH_PR_NOT_LIVE_OPEN",
        subject: "ME-GTM-003",
      }),
    );
  });

  it("accepts the same requirement when its closure-path PR is still in the live open set", async () => {
    const client = new FixtureClient();
    client.openPullRequests = [pullRequest(), pullRequest({ number: 284 })];

    const result = await verifyGitHubClosureAuthority(
       me284Matrix(),
      context({ canonicalRequirementStatuses: { "ME-GTM-003": "partial" } }),
      client,
    );

    expect(codes(result)).not.toContain("REQUIREMENT_CLOSURE_PATH_PR_NOT_LIVE_OPEN");
  });

  it("does not apply the live-open closure-path check to a verified requirement", async () => {
    const client = new FixtureClient();
    client.openPullRequests = [pullRequest()];

    const result = await verifyGitHubClosureAuthority(
      me284Matrix(),
      context({ canonicalRequirementStatuses: { "ME-GTM-003": "verified" } }),
      client,
    );

    expect(codes(result)).not.toContain("REQUIREMENT_CLOSURE_PATH_PR_NOT_LIVE_OPEN");
  });

  it("rejects a non-ancestor observed revision on push (start-of-observation site)", async () => {
    // On push only the start-of-observation site runs; this isolates site A so it is
    // individually killable rather than only when both revision sites are removed.
    const client = new FixtureClient();
    client.trackedPullRequest = pullRequest({
      state: "closed",
      merged: true,
      merge_commit_sha: MERGED,
    });
    client.openPullRequests = [];
    client.mainRevisions = [MERGED, MERGED];
    const configured = matrix();
    configured.releaseTrain.observedMainRevision = "f".repeat(40); // not ancestor of parent

    const result = await verifyGitHubClosureAuthority(
      configured,
      context({
        eventName: "push",
        githubSha: MERGED,
        checkout: { headRevision: MERGED, parentRevisions: [MAIN] },
        pullRequest: undefined,
      }),
      client,
    );

    expect(codes(result)).toContain("MATRIX_MAIN_REVISION_MISMATCH");
  });

  it("rejects an observed revision that is not an ancestor of the final main (end-of-observation site)", async () => {
    // Main diverges between the two reads: the observed revision is an ancestor of the
    // start revision but not of the divergent end revision. Only the end-of-observation
    // site fires MATRIX_MAIN_REVISION_MISMATCH here, isolating site B.
    const startMain = MAIN;
    const endMain = "e".repeat(40);
    const observed = "1".repeat(40);
    const client = new FixtureClient();
    client.mainRevisions = [startMain, endMain];
    client.ancestorPairs = [`${observed}:${startMain}`]; // ancestor of start, not of end
    const configured = matrix();
    configured.releaseTrain.observedMainRevision = observed;

    const result = await verifyGitHubClosureAuthority(configured, context(), client);

    expect(codes(result)).toContain("MATRIX_MAIN_REVISION_MISMATCH");
    expect(codes(result)).toContain("MAIN_CHANGED_DURING_OBSERVATION");
  });

  it("maps GitHub compare status onto ancestry in the real REST client", async () => {
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    const makeClient = (status: string) =>
      new GitHubRestClient(
        "gondalaimafia/mendpoint",
        "token-value",
        (async (url: string | URL) => {
          expect(String(url)).toContain(`/compare/${base}...${head}`);
          return new Response(JSON.stringify({ status }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as unknown as typeof fetch,
      );

    await expect(makeClient("ahead").revisionIsAncestor(base, head)).resolves.toBe(true);
    await expect(makeClient("identical").revisionIsAncestor(base, head)).resolves.toBe(true);
    await expect(makeClient("behind").revisionIsAncestor(base, head)).resolves.toBe(false);
    await expect(makeClient("diverged").revisionIsAncestor(base, head)).resolves.toBe(false);
  });

  it("rejects non-SHA arguments to the real REST ancestry check before calling GitHub", async () => {
    let fetched = false;
    const client = new GitHubRestClient(
      "gondalaimafia/mendpoint",
      "token-value",
      (async () => {
        fetched = true;
        return new Response(JSON.stringify({ status: "ahead" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    );

    await expect(client.revisionIsAncestor("HEAD", "b".repeat(40))).rejects.toThrow();
    await expect(client.revisionIsAncestor("a".repeat(40), "origin/main")).rejects.toThrow();
    expect(fetched).toBe(false);
  });

  it("binds event base and head while executing immutable base authority", async () => {
    const client = new FixtureClient();
    const result = await verifyGitHubClosureAuthority(
      matrix(),
      context({
        pullRequest: {
          number: 440,
          baseRef: "main",
          baseRevision: "e".repeat(40),
          headRef: "codex/production-closure-authority-hardening",
          headRevision: "f".repeat(40),
        },
        checkout: {
          headRevision: "0".repeat(40),
          parentRevisions: [],
        },
      }),
      client,
    );

    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "PR_EVENT_BASE_MISMATCH",
        "PR_EVENT_HEAD_MISMATCH",
        "CHECKOUT_REVISION_MISMATCH",
      ]),
    );
  });

  it("rejects a matrix main revision that differs from live GitHub main", async () => {
    const client = new FixtureClient();
    const configured = matrix();
    configured.releaseTrain.observedMainRevision = "f".repeat(40);

    const result = await verifyGitHubClosureAuthority(configured, context(), client);

    expect(codes(result)).toContain("MATRIX_MAIN_REVISION_MISMATCH");
  });

  it("rejects required checks and approvals that are not exact-head and trusted", async () => {
    const client = new FixtureClient();
    client.trackedChecks = checks({ head_sha: "e".repeat(40) });
    client.trackedReviews = reviews({
      commit_id: "f".repeat(40),
      user: { login: "gondalaimafia", id: 1 },
    });

    const result = await verifyGitHubClosureAuthority(matrix(), context(), client);

    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "PR_REQUIRED_CHECKS_NOT_GREEN",
        "PR_EXACT_TRUSTED_REVIEW_REQUIRED",
      ]),
    );
  });

  it("rejects successful names emitted outside the trusted CI workflow run", async () => {
    const client = new FixtureClient();
    client.trackedWorkflowRuns[0] = {
      ...client.trackedWorkflowRuns[0],
      path: ".github/workflows/spoof.yml@refs/pull/440/merge",
    };

    const result = await verifyGitHubClosureAuthority(matrix(), context(), client);

    expect(codes(result)).toContain("PR_REQUIRED_CHECKS_NOT_GREEN");
  });

  it("rejects trusted workflow jobs whose check run identities do not match", async () => {
    const client = new FixtureClient();
    client.trackedWorkflowJobs[0] = {
      ...client.trackedWorkflowJobs[0],
      id: 999,
    };

    const result = await verifyGitHubClosureAuthority(matrix(), context(), client);

    expect(codes(result)).toContain("PR_REQUIRED_CHECKS_NOT_GREEN");
  });

  it("verifies a tracked green PR review against the exact GitHub review", async () => {
    const configured = matrix();
    configured.releaseTrain.pullRequests.push({
      number: 439,
      state: "closed",
      url: "https://github.com/gondalaimafia/mendpoint/pull/439",
      title: "Prior release work",
      headBranch: "codex/prior-release-work",
      baseBranch: "main",
      headRevision: HEAD,
      mergeRevision: null,
      requirementIds: ["ME-FND-001"],
      checkState: "current_checks_green",
      owner: { actor: "Codex" },
      review: {
        state: "approved",
        reviewedHeadRevision: HEAD,
        reviewer: "claude-reviewer[bot]",
        reviewId: "999",
        url: "https://github.com/gondalaimafia/mendpoint/pull/439#pullrequestreview-999",
      },
    });
    const client = new FixtureClient();

    const result = await verifyGitHubClosureAuthority(configured, context(), client);

    expect(codes(result)).toContain("PR_EXACT_TRUSTED_REVIEW_REQUIRED");
  });

  it("accepts a trusted exact-head review on the declared remediation PR", async () => {
    const configured = matrix();
    configured.releaseTrain.currentPullRequestBootstrap.remediatesPullRequests = [416];
    configured.releaseTrain.pullRequests.push({
      number: 416,
      state: "merged",
      url: "https://github.com/gondalaimafia/mendpoint/pull/416",
      title: "Persist Mission graph identity",
      headBranch: "codex/mission-graph-identity",
      baseBranch: "main",
      headRevision: HEAD,
      mergeRevision: MERGED,
      requirementIds: ["ME-FND-001"],
      checkState: "checks_green_unreviewed",
      owner: { actor: "Codex" },
      reviewRemediationPullRequest: 440,
      review: {
        state: "none",
        reviewedHeadRevision: null,
        reviewer: null,
        reviewId: null,
        url: null,
      },
    });
    const client = new FixtureClient();
    client.trackedReviews = reviews({
      body: `## Remediation review scope\n\n- #416 @ ${HEAD}\n`,
    });

    const result = await verifyGitHubClosureAuthority(configured, context(), client);

    expect(result.issues).not.toContainEqual(
      expect.objectContaining({
        code: "PR_EXACT_TRUSTED_REVIEW_REQUIRED",
        subject: "416",
      }),
    );
  });

  it("rejects a remediation approval that does not attest the exact historical head", async () => {
    const configured = matrix();
    configured.releaseTrain.currentPullRequestBootstrap.remediatesPullRequests = [416];
    configured.releaseTrain.pullRequests.push({
      number: 416,
      state: "merged",
      url: "https://github.com/gondalaimafia/mendpoint/pull/416",
      title: "Persist Mission graph identity",
      headBranch: "codex/mission-graph-identity",
      baseBranch: "main",
      headRevision: HEAD,
      mergeRevision: MERGED,
      requirementIds: ["ME-FND-001"],
      checkState: "checks_green_unreviewed",
      owner: { actor: "Codex" },
      reviewRemediationPullRequest: 440,
      review: { state: "none", reviewedHeadRevision: null, reviewer: null, reviewId: null, url: null },
    });
    const client = new FixtureClient();
    client.trackedReviews = reviews({
      body: `## Remediation review scope\n\n- #416 @ ${"f".repeat(40)}\n`,
    });

    const result = await verifyGitHubClosureAuthority(configured, context(), client);

    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "PR_EXACT_TRUSTED_REVIEW_REQUIRED", subject: "416" }),
    );
  });

  it("rejects drift in tracked issue metadata and requirement mapping", async () => {
    const client = new FixtureClient();
    client.trackedIssue = issue({
      state: "closed",
      assignees: [],
      body: "## Requirement mapping\n\n- ME-FND-999\n",
    });

    const result = await verifyGitHubClosureAuthority(matrix(), context(), client);

    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "ISSUE_METADATA_MISMATCH",
        "ISSUE_REQUIREMENT_MAPPING_MISMATCH",
      ]),
    );
  });

  it("fails closed and still returns an observation when GitHub is unavailable", async () => {
    const client = new FixtureClient();
    client.failure = new Error("token-shaped-secret-value");

    const result = await verifyGitHubClosureAuthority(matrix(), context(), client);

    expect(result.verdict).toBe("fail");
    expect(codes(result)).toContain("GITHUB_AUTHORITY_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain("token-shaped-secret-value");
  });

  it("binds a main push to live main and the checked-out HEAD", async () => {
    const client = new FixtureClient();
    client.trackedPullRequest = pullRequest({
      state: "closed",
      merged: true,
      merge_commit_sha: MERGED,
    });
    client.openPullRequests = [];
    client.mainRevisions = [MERGED, MERGED];
    client.trackedChecks = checks();
    client.trackedReviews = reviews();

    const result = await verifyGitHubClosureAuthority(
      matrix(),
      context({
        eventName: "push",
        githubSha: MERGED,
        checkout: { headRevision: MERGED, parentRevisions: [MAIN] },
        pullRequest: undefined,
      }),
      client,
    );

    expect(result.verdict).toBe("pass");
  });

  it("rejects a main push whose live main or checkout differs", async () => {
    const client = new FixtureClient();
    client.trackedPullRequest = pullRequest({
      state: "closed",
      merged: true,
      merge_commit_sha: MERGED,
    });
    client.openPullRequests = [];
    client.mainRevisions = [MAIN, MAIN];

    const result = await verifyGitHubClosureAuthority(
      matrix(),
      context({
        eventName: "push",
        githubSha: MERGED,
        checkout: { headRevision: "f".repeat(40), parentRevisions: [] },
        pullRequest: undefined,
      }),
      client,
    );

    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "PUSH_MAIN_REVISION_MISMATCH",
        "CHECKOUT_REVISION_MISMATCH",
      ]),
    );
  });

  it("rejects a merged bootstrap without the exact pushed merge revision", async () => {
    const client = new FixtureClient();
    client.trackedPullRequest = pullRequest({
      state: "closed",
      merged: true,
      merge_commit_sha: null,
    });
    client.openPullRequests = [];
    client.mainRevisions = [MERGED, MERGED];

    const result = await verifyGitHubClosureAuthority(
      matrix(),
      context({
        eventName: "push",
        githubSha: MERGED,
        checkout: { headRevision: MERGED, parentRevisions: [MAIN] },
        pullRequest: undefined,
      }),
      client,
    );

    expect(codes(result)).toContain("PUSH_MAIN_REVISION_MISMATCH");
  });

  it("paginates GitHub list endpoints without exposing the token", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      pullRequest({ number: index + 1 }),
    );
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, authorization: headers.get("authorization") });
      const body = url.includes("page=2") ? [pullRequest({ number: 101 })] : firstPage;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new GitHubRestClient(
      "gondalaimafia/mendpoint",
      "sensitive-token",
      fetchImpl,
    );

    const result = await client.listOpenPullRequests("main");

    expect(result).toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain("page=2");
    expect(JSON.stringify(result)).not.toContain("sensitive-token");
  });

  it("retries a secondary-limited read after the provider retry interval", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const fetchImpl: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(null, {
          status: 403,
          headers: {
            "retry-after": "1",
            "x-ratelimit-remaining": "4921",
          },
        });
      }
      return new Response(JSON.stringify({ object: { sha: MAIN } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new GitHubRestClient(
      "gondalaimafia/mendpoint",
      "sensitive-token",
      fetchImpl,
      async (milliseconds) => {
        waits.push(milliseconds);
      },
    );

    await expect(client.getMainRevision()).resolves.toBe(MAIN);
    expect(attempts).toBe(2);
    expect(waits).toEqual([1_000]);
  });

  it("does not retry an unauthorized GitHub read", async () => {
    let attempts = 0;
    const client = new GitHubRestClient(
      "gondalaimafia/mendpoint",
      "sensitive-token",
      async () => {
        attempts += 1;
        return new Response(null, { status: 401 });
      },
      async () => {
        throw new Error("unexpected retry");
      },
    );

    await expect(client.getMainRevision()).rejects.toThrow("HTTP 401");
    expect(attempts).toBe(1);
  });

  it("uses bounded fallback delays for secondary throttling without retry headers", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const client = new GitHubRestClient(
      "gondalaimafia/mendpoint",
      "sensitive-token",
      async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(null, {
            status: 403,
            headers: { "x-ratelimit-remaining": "4921" },
          });
        }
        return new Response(JSON.stringify({ object: { sha: MAIN } }), { status: 200 });
      },
      async (milliseconds) => {
        waits.push(milliseconds);
      },
    );

    await expect(client.getMainRevision()).resolves.toBe(MAIN);
    expect(attempts).toBe(2);
    expect(waits).toEqual([60_000]);
  });

  it("fails without retrying when primary reset exceeds the total wait budget", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const client = new GitHubRestClient(
      "gondalaimafia/mendpoint",
      "sensitive-token",
      async () => {
        attempts += 1;
        return new Response(null, {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.ceil(Date.now() / 1_000) + 600),
          },
        });
      },
      async (milliseconds) => {
        waits.push(milliseconds);
      },
    );

    await expect(client.getMainRevision()).rejects.toThrow("HTTP 403");
    expect(attempts).toBe(1);
    expect(waits).toEqual([]);
  });

  it("retries transient provider and network failures within the fixed budget", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const client = new GitHubRestClient(
      "gondalaimafia/mendpoint",
      "sensitive-token",
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient network failure");
        if (attempts === 2) return new Response(null, { status: 503 });
        return new Response(JSON.stringify({ object: { sha: MAIN } }), { status: 200 });
      },
      async (milliseconds) => {
        waits.push(milliseconds);
      },
    );

    await expect(client.getMainRevision()).resolves.toBe(MAIN);
    expect(attempts).toBe(3);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("fails closed after exhausting secondary throttle retries", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const client = new GitHubRestClient(
      "gondalaimafia/mendpoint",
      "sensitive-token",
      async () => {
        attempts += 1;
        return new Response(null, { status: 429 });
      },
      async (milliseconds) => {
        waits.push(milliseconds);
      },
    );

    await expect(client.getMainRevision()).rejects.toThrow("HTTP 429");
    expect(attempts).toBe(3);
    expect(waits).toEqual([60_000, 120_000]);
  });

  it("writes a secret-free observation artifact", async () => {
    const client = new FixtureClient();
    client.trackedPullRequest.body += "\n## Private context\n\nprivate-repository-content";
    const result = await verifyGitHubClosureAuthority(matrix(), context(), client);
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-github-authority-"));
    const path = join(directory, "observation.json");
    try {
      writeGitHubAuthorityObservation(path, result);
      const artifact = readFileSync(path, "utf8");
      expect(JSON.parse(artifact).verdict).toBe("pass");
      expect(artifact).not.toContain("private-repository-content");
      expect(artifact).not.toContain("Requirement mapping");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes a secret-free failure artifact when protected configuration fails early", () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-github-authority-failure-"));
    const path = join(directory, "observation.json");
    try {
      writeGitHubAuthorityFailureObservation(path, "2026-08-25T12:05:00.000Z");
      const artifact = readFileSync(path, "utf8");
      expect(JSON.parse(artifact)).toMatchObject({
        eventName: "configuration_failure",
        verdict: "fail",
        issues: [{ code: "GITHUB_AUTHORITY_CONFIGURATION_INVALID" }],
      });
      expect(artifact).not.toContain("token");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("builds an exact PR context from the GitHub event without retaining secrets", () => {
    const built = githubAuthorityContextFromEvent(
      {
        GITHUB_EVENT_NAME: "pull_request_target",
        GITHUB_REPOSITORY: "gondalaimafia/mendpoint",
        GITHUB_SHA: MAIN,
        GITHUB_RUN_ID: "1234",
        MENDPOINT_CLOSURE_TRUSTED_REVIEWERS_JSON: JSON.stringify({
          Claude: [{ login: "claude-reviewer[bot]", userId: 71 }],
        }),
        GITHUB_TOKEN: "must-not-be-retained",
      },
      {
        pull_request: {
          number: 440,
          base: { ref: "main", sha: MAIN },
          head: {
            ref: "codex/production-closure-authority-hardening",
            sha: HEAD,
          },
        },
      },
      { headRevision: MAIN, parentRevisions: [] },
      "2026-08-25T12:05:00.000Z",
    );

    expect(built.pullRequest?.headRevision).toBe(HEAD);
    expect(built.observationScope).toBe("current_pull_request");
    expect(built.trustedReviewerIdentities.Claude).toEqual([
      { login: "claude-reviewer[bot]", userId: 71 },
    ]);
    expect(JSON.stringify(built)).not.toContain("must-not-be-retained");
  });

  it.each(["schedule", "workflow_dispatch"])(
    "keeps %s fanout runs on full release-train provider validation",
    (workflowEventName) => {
      const built = githubAuthorityContextFromEvent(
        {
          GITHUB_EVENT_NAME: workflowEventName,
          MENDPOINT_CLOSURE_EVENT_NAME: "pull_request",
          MENDPOINT_CLOSURE_AUTHORITY_SHA: MAIN,
          GITHUB_REPOSITORY: "gondalaimafia/mendpoint",
          GITHUB_SHA: MAIN,
          GITHUB_RUN_ID: "1234",
          MENDPOINT_CLOSURE_TRUSTED_REVIEWERS_JSON: JSON.stringify({
            Claude: [{ login: "claude-reviewer[bot]", userId: 71 }],
          }),
          MENDPOINT_CLOSURE_PR_NUMBER: "440",
          MENDPOINT_CLOSURE_PR_BASE_REF: "main",
          MENDPOINT_CLOSURE_PR_BASE_SHA: MAIN,
          MENDPOINT_CLOSURE_PR_HEAD_REF: "codex/production-closure-authority-hardening",
          MENDPOINT_CLOSURE_PR_HEAD_SHA: HEAD,
        },
        {},
        { headRevision: MAIN, parentRevisions: [] },
      );

      expect(built.eventName).toBe("pull_request");
      expect(built.observationScope).toBe("full_release_train");
      expect(built.pullRequest?.number).toBe(440);
    },
  );

  it("keeps the checked-in protected authority policy runnable and App-bound", () => {
    const policy = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", "config", "production-closure-authority.json"),
        "utf8",
      ),
    ) as {
      externalCheckAppId: number | null;
      controllerCheckAppId: number | null;
      trustedReviewers: unknown;
    };

    const built = githubAuthorityContextFromEvent(
      {
        GITHUB_EVENT_NAME: "push",
        GITHUB_REPOSITORY: "gondalaimafia/mendpoint",
        GITHUB_SHA: MERGED,
        GITHUB_RUN_ID: "1234",
      },
      {},
      { headRevision: MERGED, parentRevisions: [MAIN] },
      "2026-08-25T12:05:00.000Z",
      policy.trustedReviewers,
    );

    expect(policy.externalCheckAppId).toBe(4718395);
    expect(policy.controllerCheckAppId).toBe(15368);
    expect(built.observationScope).toBe("full_release_train");
    expect(built.trustedReviewerIdentities.Claude).toEqual([
      { login: "mendpoint-closure-authority[bot]", userId: 321156448 },
      // Owner decision (keep both): the human owner stays in the trust root
      // under the accepted key — also required for rotation continuity, since
      // main's base root is the human and bot-only would have zero overlap.
      { login: "gondalaimafia", userId: 273115720 },
    ]);
  });

  it("uses the explicitly checked-out base authority SHA for review-triggered reevaluation", () => {
    const built = githubAuthorityContextFromEvent(
      {
        GITHUB_EVENT_NAME: "pull_request_review",
        MENDPOINT_CLOSURE_EVENT_NAME: "pull_request",
        MENDPOINT_CLOSURE_AUTHORITY_SHA: MAIN,
        GITHUB_REPOSITORY: "gondalaimafia/mendpoint",
        GITHUB_SHA: "f".repeat(40),
        GITHUB_RUN_ID: "1234",
        MENDPOINT_CLOSURE_TRUSTED_REVIEWERS_JSON: JSON.stringify({
          Claude: [{ login: "claude-reviewer[bot]", userId: 71 }],
        }),
        MENDPOINT_CLOSURE_PR_NUMBER: "440",
        MENDPOINT_CLOSURE_PR_BASE_REF: "main",
        MENDPOINT_CLOSURE_PR_BASE_SHA: MAIN,
        MENDPOINT_CLOSURE_PR_HEAD_REF: "codex/production-closure-authority-hardening",
        MENDPOINT_CLOSURE_PR_HEAD_SHA: HEAD,
      },
      {},
      { headRevision: MAIN, parentRevisions: [] },
    );

    expect(built.githubSha).toBe(MAIN);
    expect(built.observationScope).toBe("full_release_train");
  });

  it("rejects a reviewer login bound to multiple agent identities", () => {
    expect(() =>
      githubAuthorityContextFromEvent(
        {
          GITHUB_EVENT_NAME: "push",
          GITHUB_REPOSITORY: "gondalaimafia/mendpoint",
          GITHUB_SHA: MERGED,
          GITHUB_RUN_ID: "1234",
          MENDPOINT_CLOSURE_TRUSTED_REVIEWERS_JSON: JSON.stringify({
            Codex: [{ login: "shared-reviewer", userId: 1 }],
            Claude: [{ login: "shared-reviewer", userId: 1 }],
          }),
        },
        {},
        { headRevision: MERGED, parentRevisions: [MAIN] },
      ),
    ).toThrow(/multiple agent identities/);
  });
});
