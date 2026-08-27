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
  openPullRequests = [pullRequest()];
  trackedPullRequest = pullRequest();
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
  async listOpenPullRequests(): Promise<GitHubPullRequest[]> {
    if (this.failure) throw this.failure;
    return this.openPullRequests;
  }
  async getPullRequest(number: number): Promise<GitHubPullRequest> {
    if (this.failure) throw this.failure;
    this.pullRequestReads.push(number);
    return this.trackedPullRequest;
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
  it("preauthorizes reactive per-PR authority with an App-bound verdict", () => {
    const workflowSource = readFileSync(
      new URL(
        "../config/production-closure-successors/closure-authority-quiet-sweep.yml",
        import.meta.url,
      ),
      "utf8",
    );
    const workflow = parse(workflowSource) as {
      name: string;
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
          if?: string;
          "continue-on-error"?: boolean;
          run?: string;
          env?: Record<string, string>;
          with?: Record<string, string | number>;
        }>;
      }>;
    };
    const job = workflow.jobs["closure-authority"];
    const mainObservationJob = workflow.jobs["main-authority-observation"];

    expect(workflow.name).toBe("Production Closure Authority Reactive");
    expect(workflowSource).toContain("mendpoint-production-closure-authority-reactive");
    expect(workflowSource).toContain("mendpoint-production-closure-controller-reactive");
    expect(workflow.on).toHaveProperty("push");
    expect(workflow.on).toHaveProperty("pull_request_target");
    expect(workflow.on).toHaveProperty("schedule");
    expect(workflow.on).toMatchObject({
      workflow_run: { workflows: ["CI"], types: ["completed"] },
      pull_request_review: { types: ["submitted", "edited", "dismissed"] },
      issues: {
        types: [
          "opened",
          "edited",
          "deleted",
          "transferred",
          "closed",
          "reopened",
          "assigned",
          "unassigned",
          "labeled",
          "unlabeled",
        ],
      },
      issue_comment: { types: ["created", "edited", "deleted"] },
      branch_protection_rule: { types: ["created", "edited", "deleted"] },
      pull_request_target: {
        branches: ["main"],
        types: ["opened", "synchronize", "reopened", "edited", "labeled", "unlabeled"],
      },
    });
    // Push observations are immutable production evidence and cannot be cancelled
    // by a later cron. Reactive PR events are scoped instead of becoming full sweeps.
    expect(workflow.concurrency).toEqual({
      group:
        "closure-authority-${{ github.event_name == 'push' && format('push-{0}', github.sha) || (github.event_name == 'pull_request_target' || github.event_name == 'pull_request_review') && format('pr-{0}', github.event.pull_request.number) || github.event_name == 'workflow_run' && format('pr-head-{0}', github.event.workflow_run.head_sha) || (github.event_name == 'issues' || github.event_name == 'issue_comment') && format('issue-{0}', github.event.issue.number) || github.event_name == 'branch_protection_rule' && 'branch-protection' || 'sweep' }}",
      "cancel-in-progress": "${{ github.event_name != 'push' }}",
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
    expect(workflow.jobs["invalidate-authority"].concurrency).toEqual({
      group: "production-closure-authority-invalidation-${{ matrix.pull_request }}",
      "cancel-in-progress": false,
    });
    expect(job.concurrency).toEqual({
      group: "production-closure-authority-${{ matrix.pull_request }}",
      "cancel-in-progress": false,
    });
    expect(workflow.jobs["invalidate-authority"].concurrency?.group)
      .not.toBe(job.concurrency?.group);

    // Model GitHub's one-running/one-pending concurrency rule, including replacement
    // of an older pending invalidation by a newer event. Closure A is already past
    // authority verification. A distinct invalidation group lets the newest B post
    // pending before A publishes; a shared group would leave B queued behind A and
    // this regression would incorrectly observe A as still owning the generation.
    const modelCrossEventInterleaving = (
      invalidationGroup: string,
      closureGroup: string,
    ) => {
      const running = new Map<string, string>([[closureGroup, "closure-A"]]);
      const pending = new Map<string, string>();
      let latestControllerRun = "run-A";
      const appChecks = new Map([["check-A", "in_progress"]]);

      const startInvalidation = (run: string) => {
        running.set(invalidationGroup, run);
        latestControllerRun = run;
        running.delete(invalidationGroup);
        const next = pending.get(invalidationGroup);
        if (next) {
          pending.delete(invalidationGroup);
          startInvalidation(next);
        }
      };
      const queueInvalidation = (run: string) => {
        if (running.has(invalidationGroup)) {
          pending.set(invalidationGroup, run);
        } else {
          startInvalidation(run);
        }
      };

      // X occupies the short invalidation group while two newer events arrive.
      // GitHub replaces pending B-old with B, then B runs as soon as X completes.
      if (!running.has(invalidationGroup)) running.set(invalidationGroup, "run-X");
      queueInvalidation("run-B-old");
      queueInvalidation("run-B");
      if (running.get(invalidationGroup) === "run-X") {
        running.delete(invalidationGroup);
        const newest = pending.get(invalidationGroup);
        if (newest) {
          pending.delete(invalidationGroup);
          startInvalidation(newest);
        }
      }

      const aOwnsGeneration = latestControllerRun === "run-A";
      if (!aOwnsGeneration) appChecks.set("check-A", "failure");
      const controllerPublishedByA = aOwnsGeneration;
      if (controllerPublishedByA) latestControllerRun = "run-A-success";
      return { appCheckA: appChecks.get("check-A"), controllerPublishedByA, latestControllerRun };
    };
    expect(modelCrossEventInterleaving(
      workflow.jobs["invalidate-authority"].concurrency!.group!,
      job.concurrency!.group!,
    )).toEqual({
      appCheckA: "failure",
      controllerPublishedByA: false,
      latestControllerRun: "run-B",
    });
    const discoverRun = workflow.jobs.discover.steps?.find(
      (step) => step.name === "Discover the current protected release set",
    )?.run;
    expect(discoverRun).toEqual(expect.stringContaining("installation API budget exhausted"));
    expect(discoverRun).toEqual(expect.stringContaining(
      '.workflow_run.path == ".github/workflows/ci.yml"',
    ));
    expect(discoverRun).toEqual(expect.stringContaining(
      '.workflow_run.event == "pull_request"',
    ));
    expect(discoverRun).toEqual(expect.stringContaining("commits/${workflow_head}/pulls"));
    expect(discoverRun).toEqual(expect.stringContaining("issue_is_tracked"));
    expect(discoverRun).toEqual(expect.stringContaining(".issue.pull_request != null"));
    expect(job.steps).toContainEqual(
      expect.objectContaining({
        name: "Verify live GitHub release authority",
        env: expect.objectContaining({
          MENDPOINT_CLOSURE_OBSERVATION_SCOPE:
            "${{ needs.discover.outputs.observation_scope }}",
          MENDPOINT_CLOSURE_PROVIDER_VALIDATION_ISSUES:
            "${{ needs.discover.outputs.provider_validation_issues }}",
        }),
      }),
    );
    const successorWait = job.steps?.find(
      (step) => step.name === "Wait for declared successor activation result",
    );
    expect(successorWait).toMatchObject({
      "continue-on-error": true,
      env: expect.objectContaining({
        CURRENT_CHECK_NAME: "${{ steps.external-check.outputs.check_name }}",
      }),
    });
    expect(successorWait?.run).toEqual(expect.stringContaining("for attempt in $(seq 1 24)"));
    expect(successorWait?.run).toEqual(expect.stringContaining("CURRENT_CHECK_NAME"));
    expect(successorWait?.run).toEqual(expect.stringContaining("controllerStatusCreatorUserId"));
    expect(successorWait?.run).toEqual(expect.stringContaining("within 120 seconds"));
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
      expect.objectContaining({
        name: "Publish dedicated authority App verdict",
        run: expect.stringContaining("SUCCESSOR_READINESS_OUTCOME"),
      }),
    );
    const publicationGeneration = job.steps?.find(
      (step) => step.name === "Verify publication generation ownership",
    );
    const closeSuperseded = job.steps?.find(
      (step) => step.name === "Close superseded dedicated authority App check",
    );
    const publishExternal = job.steps?.find(
      (step) => step.name === "Publish dedicated authority App verdict",
    );
    const publishController = job.steps?.find(
      (step) => step.name === "Publish controller authority verdict",
    );
    expect(publicationGeneration).toMatchObject({
      "continue-on-error": true,
      env: expect.objectContaining({
        CHECK_ID: "${{ steps.external-check.outputs.check_id }}",
        CHECK_NAME: "${{ steps.external-check.outputs.check_name }}",
        CONTROLLER_CREATOR_LOGIN: "github-actions[bot]",
        CONTROLLER_CREATOR_USER_ID: 41898282,
        PR_HEAD_SHA: "${{ steps.pull-request.outputs.head_sha }}",
        PR_NUMBER: "${{ matrix.pull_request }}",
      }),
    });
    expect(publicationGeneration?.run).toEqual(expect.stringContaining(
      'test "$latest_check_id" = "$CHECK_ID"',
    ));
    expect(publicationGeneration?.run).toEqual(expect.stringContaining(
      '.state == "pending" and .target_url == $run_url',
    ));
    expect(publicationGeneration?.run).toEqual(expect.stringContaining(
      '.status == "in_progress" and .conclusion == null and .details_url == $run_url',
    ));
    expect(publicationGeneration?.run).toEqual(expect.stringContaining(
      'repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}',
    ));
    expect(publicationGeneration?.run).toEqual(expect.stringContaining(
      'test "$live_head" = "$PR_HEAD_SHA"',
    ));
    expect(closeSuperseded).toMatchObject({
      if: "always() && steps.external-check.outputs.check_id != '' && steps.publication-generation.outcome != 'success'",
      run: expect.stringContaining("-f conclusion=failure"),
      env: expect.objectContaining({
        CHECK_ID: "${{ steps.external-check.outputs.check_id }}",
      }),
    });
    const generationIndex = job.steps!.findIndex(
      (step) => step.name === "Verify publication generation ownership",
    );
    expect(generationIndex + 1).toBe(job.steps!.findIndex(
      (step) => step.name === "Close superseded dedicated authority App check",
    ));
    expect(generationIndex + 2).toBe(job.steps!.findIndex(
      (step) => step.name === "Publish dedicated authority App verdict",
    ));
    expect(publishExternal?.if).toContain("steps.publication-generation.outcome == 'success'");
    expect(publishController?.if).toContain("steps.publication-generation.outcome == 'success'");
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
      expect.objectContaining({
        name: "Publish controller authority verdict",
        run: expect.stringContaining("SUCCESSOR_READINESS_OUTCOME"),
      }),
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
          MENDPOINT_CLOSURE_AUTHORITY_SHA: "${{ github.sha }}",
          MENDPOINT_CLOSURE_EVENT_NAME: "push",
        }),
      }),
    );
    expect(mainObservationJob.steps).toContainEqual(
      expect.objectContaining({
        name: "Checkout exact pushed main revision",
        with: expect.objectContaining({ ref: "${{ github.sha }}" }),
      }),
    );
    expect(mainObservationJob.steps).toContainEqual(
      expect.objectContaining({
        name: "Upload secret-free merged authority evidence",
        with: expect.objectContaining({
          name: "production-closure-main-authority-${{ github.sha }}",
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
        new URL(
          "../config/production-closure-successors/closure-authority-quiet-sweep.yml",
          import.meta.url,
        ),
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
      head_sha: HEAD,
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

    client.trackedStatuses[0].creator = { login: "github-actions[bot]", id: 41898282 };
    client.trackedWorkflowRuns.at(-1)!.head_sha = MAIN;
    const wrongActivationHead = await verifyGitHubClosureAuthority(configured, context(), client);
    expect(codes(wrongActivationHead)).toContain("AUTHORITY_SUCCESSOR_WORKFLOW_PROVENANCE_INVALID");
  });

  it("permits only the exact authenticated successor run to self-bootstrap in progress", async () => {
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
      status: "in_progress",
      conclusion: null,
      head_sha: HEAD,
      html_url: "https://github.com/gondalaimafia/mendpoint/runs/202",
      details_url: "https://github.com/gondalaimafia/mendpoint/actions/runs/1234",
      app: { id: 123 },
    });
    client.trackedStatuses = [{
      id: 303,
      context: "mendpoint-production-closure-controller-v2",
      state: "pending",
      target_url: "https://github.com/gondalaimafia/mendpoint/actions/runs/1234",
      creator: { login: "github-actions[bot]", id: 41898282 },
    }];
    client.trackedWorkflowRuns.push({
      id: 1234,
      path: ".github/workflows/closure-authority-v2.yml@refs/heads/main",
      event: "pull_request_target",
      status: "in_progress",
      conclusion: null,
      head_sha: HEAD,
      html_url: "https://github.com/gondalaimafia/mendpoint/actions/runs/1234",
    });

    const exact = await verifyGitHubClosureAuthority(configured, context(), client);
    expect(exact.verdict, JSON.stringify(exact.issues, null, 2)).toBe("pass");
    expect(exact.checkRunIds).toContain(202);
    expect(exact.workflowRunIds).toContain(1234);

    client.trackedWorkflowRuns.at(-1)!.path = ".github/workflows/predecessor.yml@refs/heads/main";
    const wrongPath = await verifyGitHubClosureAuthority(configured, context(), client);
    expect(codes(wrongPath)).toContain("AUTHORITY_SUCCESSOR_LIVE_PROOF_REQUIRED");

    client.trackedWorkflowRuns.at(-1)!.path =
      ".github/workflows/closure-authority-v2.yml@refs/heads/main";
    client.trackedChecks.at(-1)!.app = { id: 999 };
    const wrongApp = await verifyGitHubClosureAuthority(configured, context(), client);
    expect(codes(wrongApp)).toContain("AUTHORITY_SUCCESSOR_LIVE_PROOF_REQUIRED");

    client.trackedChecks.at(-1)!.app = { id: 123 };
    client.trackedChecks.at(-1)!.details_url =
      "https://github.com/gondalaimafia/mendpoint/actions/runs/9999";
    const wrongCheckRun = await verifyGitHubClosureAuthority(configured, context(), client);
    expect(codes(wrongCheckRun)).toContain("AUTHORITY_SUCCESSOR_LIVE_PROOF_REQUIRED");

    client.trackedChecks.at(-1)!.details_url =
      "https://github.com/gondalaimafia/mendpoint/actions/runs/1234";
    client.trackedStatuses[0].target_url =
      "https://github.com/gondalaimafia/mendpoint/actions/runs/9999";
    const wrongStatusRun = await verifyGitHubClosureAuthority(configured, context(), client);
    expect(codes(wrongStatusRun)).toContain("AUTHORITY_SUCCESSOR_LIVE_PROOF_REQUIRED");

    client.trackedStatuses[0].target_url =
      "https://github.com/gondalaimafia/mendpoint/actions/runs/1234";
    client.trackedStatuses[0].creator = { login: "untrusted-bot", id: 999 };
    const wrongController = await verifyGitHubClosureAuthority(configured, context(), client);
    expect(codes(wrongController)).toContain("AUTHORITY_SUCCESSOR_LIVE_PROOF_REQUIRED");

    client.trackedStatuses[0].creator = { login: "github-actions[bot]", id: 41898282 };
    client.trackedWorkflowRuns.at(-1)!.event = "workflow_dispatch";
    const wrongEvent = await verifyGitHubClosureAuthority(configured, context(), client);
    expect(codes(wrongEvent)).toContain("AUTHORITY_SUCCESSOR_LIVE_PROOF_REQUIRED");

    client.trackedWorkflowRuns.at(-1)!.event = "pull_request_target";
    client.trackedWorkflowRuns.at(-1)!.status = "completed";
    client.trackedWorkflowRuns.at(-1)!.conclusion = "failure";
    const failedRun = await verifyGitHubClosureAuthority(configured, context(), client);
    expect(codes(failedRun)).toContain("AUTHORITY_SUCCESSOR_LIVE_PROOF_REQUIRED");

    client.trackedWorkflowRuns.at(-1)!.status = "in_progress";
    client.trackedWorkflowRuns.at(-1)!.conclusion = null;
    client.trackedWorkflowRuns.at(-1)!.head_sha = MAIN;
    const wrongHead = await verifyGitHubClosureAuthority(configured, context(), client);
    expect(codes(wrongHead)).toContain("AUTHORITY_SUCCESSOR_LIVE_PROOF_REQUIRED");

    client.trackedWorkflowRuns.at(-1)!.head_sha = HEAD;
    const wrongContextRun = await verifyGitHubClosureAuthority(
      configured,
      context({ workflowRunId: "9999" }),
      client,
    );
    expect(codes(wrongContextRun)).toContain("AUTHORITY_SUCCESSOR_LIVE_PROOF_REQUIRED");

    const pushObserver = await verifyGitHubClosureAuthority(
      configured,
      context({ eventName: "push" }),
      client,
    );
    expect(codes(pushObserver)).toContain("AUTHORITY_SUCCESSOR_LIVE_PROOF_REQUIRED");
  });

  it("fails closed when the live open PR set is incomplete", async () => {
    const client = new FixtureClient();
    client.openPullRequests = [pullRequest(), pullRequest({ number: 441 })];

    const result = await verifyGitHubClosureAuthority(matrix(), context(), client);

    expect(codes(result)).toContain("OPEN_PR_COMPLETENESS_MISMATCH");
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

  it("fails closed when live main advances beyond the immutable push revision", async () => {
    const advancedMain = "e".repeat(40);
    const client = new FixtureClient();
    client.trackedPullRequest = pullRequest({
      state: "closed",
      merged: true,
      merge_commit_sha: MERGED,
    });
    client.openPullRequests = [];
    client.mainRevisions = [advancedMain, advancedMain];

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
    expect(codes(result)).not.toContain("CHECKOUT_REVISION_MISMATCH");
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

  it.each(["pull_request_review", "workflow_run"])(
    "uses exact base authority and current-PR scope for %s reevaluation",
    (workflowEventName) => {
    const built = githubAuthorityContextFromEvent(
      {
        GITHUB_EVENT_NAME: workflowEventName,
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
    expect(built.observationScope).toBe("current_pull_request");
    },
  );

  it("rejects an event scope downgrade and validates scoped issue subjects", () => {
    expect(() =>
      githubAuthorityContextFromEvent(
        {
          GITHUB_EVENT_NAME: "workflow_run",
          MENDPOINT_CLOSURE_EVENT_NAME: "pull_request",
          MENDPOINT_CLOSURE_OBSERVATION_SCOPE: "full_release_train",
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
      )
    ).toThrow(/scope does not match/);

    const built = githubAuthorityContextFromEvent(
      {
        GITHUB_EVENT_NAME: "issues",
        MENDPOINT_CLOSURE_EVENT_NAME: "pull_request",
        MENDPOINT_CLOSURE_OBSERVATION_SCOPE: "full_release_train",
        MENDPOINT_CLOSURE_PROVIDER_VALIDATION_ISSUES: "[430]",
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
    expect(built.observationScope).toBe("full_release_train");
    expect(built.providerValidationIssues).toEqual([430]);
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
