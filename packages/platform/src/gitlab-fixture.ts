import { createHash, timingSafeEqual } from "node:crypto";

export type GitLabFixtureCredential = Readonly<{
  credentialId: string;
  tenantId: string;
  token: string;
  revokedAt?: string;
}>;

export type GitLabFixtureAuth = Readonly<{
  tenantId: string;
  credentialId: string;
  token: string;
  actorId: string;
}>;

export type GitLabFixtureProjectSeed = Readonly<{
  tenantId: string;
  projectId: string;
  pathWithNamespace: string;
  defaultBranch: string;
  webhookSecret: string;
  branches: Readonly<Record<string, string>>;
  commits: readonly Readonly<{
    sha: string;
    parentSha?: string;
    message: string;
    files: Readonly<Record<string, string>>;
  }>[];
}>;

export type GitLabSnapshotFile = Readonly<{
  path: string;
  content: string;
  size: number;
  sha256: string;
}>;

export type GitLabImmutableSnapshot = Readonly<{
  provider: "gitlab";
  tenantId: string;
  projectId: string;
  repositoryId: string;
  requestedRef: string;
  sha: string;
  manifestSha256: string;
  files: readonly GitLabSnapshotFile[];
}>;

export type GitLabPipelineStatus =
  | "created"
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "canceled";

export type GitLabMergeRequest = Readonly<{
  id: string;
  iid: number;
  tenantId: string;
  projectId: string;
  sourceBranch: string;
  targetBranch: string;
  sourceSha: string;
  title: string;
  description: string;
  url: string;
  draft: true;
  state: "open";
  authorId: string;
  createdAt: string;
}>;

export type GitLabDiscussion = Readonly<{
  id: string;
  mergeRequestIid: number;
  authorId: string;
  body: string;
  resolved: boolean;
  resolutionEvidence: readonly string[];
}>;

export type GitLabApproval = Readonly<{
  mergeRequestIid: number;
  reviewerId: string;
  reviewEvidence: readonly string[];
  approvedAt: string;
}>;

export type GitLabFixtureAuditEvent = Readonly<{
  tenantId: string;
  projectId?: string;
  actorId: string;
  action: string;
  outcome: "accepted" | "denied";
  reason?: GitLabFixtureErrorCode;
  occurredAt: string;
}>;

export type GitLabFixtureErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_AMBIGUOUS"
  | "AUTH_INVALID"
  | "CREDENTIAL_REVOKED"
  | "TENANT_SCOPE_DENIED"
  | "PROJECT_NOT_FOUND"
  | "REF_NOT_FOUND"
  | "INVALID_INPUT"
  | "CONFLICT"
  | "DIVERGENT_RECOVERY"
  | "MERGE_REQUEST_NOT_FOUND"
  | "PIPELINE_NOT_SUCCESSFUL"
  | "UNRESOLVED_DISCUSSIONS"
  | "REVIEW_EVIDENCE_REQUIRED"
  | "SELF_APPROVAL_FORBIDDEN"
  | "WEBHOOK_UNSIGNED"
  | "WEBHOOK_REPLAY"
  | "WEBHOOK_INVALID";

export class GitLabFixtureError extends Error {
  constructor(
    readonly code: GitLabFixtureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GitLabFixtureError";
  }
}

type Commit = {
  sha: string;
  parentSha?: string;
  message: string;
  files: Map<string, string>;
};

type MutableDiscussion = {
  id: string;
  mergeRequestIid: number;
  authorId: string;
  body: string;
  resolved: boolean;
  resolutionEvidence: string[];
};

type Project = {
  tenantId: string;
  projectId: string;
  pathWithNamespace: string;
  defaultBranch: string;
  webhookSecret: string;
  branches: Map<string, string>;
  commits: Map<string, Commit>;
  mergeRequests: Map<number, GitLabMergeRequest>;
  discussions: Map<string, MutableDiscussion>;
  approvals: GitLabApproval[];
  pipelines: Map<string, GitLabPipelineStatus>;
  nextMergeRequestIid: number;
  nextDiscussionId: number;
};

type RecoveryRecord = {
  fingerprint: string;
  value: unknown;
};

const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^(?!\/)(?!.*(?:\.\.|\/\/))[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireText(value: string, name: string): string {
  const result = value.trim();
  if (!result || /[\0\r\n]/.test(result)) {
    throw new GitLabFixtureError("INVALID_INPUT", `${name} is invalid`);
  }
  return result;
}

function requireRepositoryPath(path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new GitLabFixtureError("INVALID_INPUT", "Repository path is invalid");
  }
  return path;
}

function assertPortablePaths(paths: Iterable<string>): void {
  const seen = new Set<string>();
  for (const path of paths) {
    const portable = path.toLowerCase();
    if (seen.has(portable)) {
      throw new GitLabFixtureError(
        "INVALID_INPUT",
        "Repository paths collide on a case insensitive filesystem",
      );
    }
    seen.add(portable);
  }
}

function readonlySnapshot(
  project: Project,
  requestedRef: string,
  commit: Commit,
): GitLabImmutableSnapshot {
  const files = [...commit.files]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) =>
      Object.freeze({
        path,
        content,
        size: Buffer.byteLength(content),
        sha256: digest(content),
      }),
    );
  const manifestSha256 = digest(
    stable(files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))),
  );
  return Object.freeze({
    provider: "gitlab",
    tenantId: project.tenantId,
    projectId: project.projectId,
    repositoryId: `gitlab:${project.pathWithNamespace}`,
    requestedRef,
    sha: commit.sha,
    manifestSha256,
    files: Object.freeze(files),
  });
}

/**
 * Deterministic GitLab transport used to prove adapter behavior without a live
 * customer token. It intentionally exposes no merge operation.
 */
export class GitLabFixtureAdapter {
  readonly provenance = "test" as const;
  readonly #credentials: GitLabFixtureCredential[];
  readonly #projects = new Map<string, Project>();
  readonly #recovery = new Map<string, RecoveryRecord>();
  readonly #webhookDeliveries = new Set<string>();
  readonly #audit: GitLabFixtureAuditEvent[] = [];
  readonly #now: () => Date;

  constructor(input: {
    credentials: readonly GitLabFixtureCredential[];
    projects: readonly GitLabFixtureProjectSeed[];
    now?: () => Date;
  }) {
    this.#credentials = input.credentials.map((credential) => ({ ...credential }));
    this.#now = input.now ?? (() => new Date());
    for (const seed of input.projects) {
      const key = this.#projectKey(seed.tenantId, seed.projectId);
      if (this.#projects.has(key)) {
        throw new GitLabFixtureError("CONFLICT", "Duplicate tenant project binding");
      }
      const commits = new Map<string, Commit>();
      for (const seedCommit of seed.commits) {
        const sha = seedCommit.sha.toLowerCase();
        if (!SHA.test(sha) || commits.has(sha)) {
          throw new GitLabFixtureError("INVALID_INPUT", "Commit identity is invalid or duplicated");
        }
        const files = new Map<string, string>();
        for (const [path, content] of Object.entries(seedCommit.files)) {
          files.set(requireRepositoryPath(path), content);
        }
        assertPortablePaths(files.keys());
        commits.set(sha, {
          sha,
          parentSha: seedCommit.parentSha?.toLowerCase(),
          message: requireText(seedCommit.message, "Commit message"),
          files,
        });
      }
      const branches = new Map<string, string>();
      for (const [branch, shaValue] of Object.entries(seed.branches)) {
        const sha = shaValue.toLowerCase();
        if (!BRANCH.test(branch) || !commits.has(sha)) {
          throw new GitLabFixtureError("INVALID_INPUT", "Branch binding is invalid");
        }
        branches.set(branch, sha);
      }
      if (!branches.has(seed.defaultBranch) || !seed.webhookSecret) {
        throw new GitLabFixtureError("INVALID_INPUT", "Default branch or webhook secret is invalid");
      }
      this.#projects.set(key, {
        tenantId: requireText(seed.tenantId, "Tenant"),
        projectId: requireText(seed.projectId, "Project"),
        pathWithNamespace: requireText(seed.pathWithNamespace, "Project path"),
        defaultBranch: seed.defaultBranch,
        webhookSecret: seed.webhookSecret,
        branches,
        commits,
        mergeRequests: new Map(),
        discussions: new Map(),
        approvals: [],
        pipelines: new Map(),
        nextMergeRequestIid: 1,
        nextDiscussionId: 1,
      });
    }
  }

  getAuditEvents(tenantId: string): readonly GitLabFixtureAuditEvent[] {
    return Object.freeze(this.#audit.filter((event) => event.tenantId === tenantId));
  }

  revokeCredential(tenantId: string, credentialId: string, revokedAt: string): void {
    const matches = this.#credentials.filter(
      (credential) =>
        credential.tenantId === tenantId && credential.credentialId === credentialId,
    );
    if (matches.length !== 1 || !Number.isFinite(Date.parse(revokedAt))) {
      throw new GitLabFixtureError(
        matches.length > 1 ? "AUTH_AMBIGUOUS" : "AUTH_INVALID",
        "Credential revocation target is invalid",
      );
    }
    (matches[0] as { revokedAt?: string }).revokedAt = revokedAt;
  }

  snapshot(
    auth: GitLabFixtureAuth,
    input: { projectId: string; ref: string },
  ): GitLabImmutableSnapshot {
    const project = this.#authorize(auth, input.projectId, "snapshot");
    const commit = this.#resolveCommit(project, input.ref);
    return readonlySnapshot(project, input.ref, commit);
  }

  createBranch(
    auth: GitLabFixtureAuth,
    input: { projectId: string; branch: string; fromRef: string; deliveryId: string },
  ): Readonly<{ branch: string; sha: string; recovered: boolean }> {
    const project = this.#authorize(auth, input.projectId, "create_branch");
    if (!BRANCH.test(input.branch)) {
      throw new GitLabFixtureError("INVALID_INPUT", "Branch name is invalid");
    }
    const from = this.#resolveCommit(project, input.fromRef);
    return this.#recover(
      auth,
      input.deliveryId,
      "create_branch",
      { projectId: input.projectId, branch: input.branch, fromSha: from.sha },
      () => {
        const current = project.branches.get(input.branch);
        if (current && current !== from.sha) {
          throw new GitLabFixtureError(
            "DIVERGENT_RECOVERY",
            "Existing branch has a different head and requires human reconciliation",
          );
        }
        project.branches.set(input.branch, from.sha);
        return Object.freeze({ branch: input.branch, sha: from.sha, recovered: Boolean(current) });
      },
    );
  }

  commitFiles(
    auth: GitLabFixtureAuth,
    input: {
      projectId: string;
      branch: string;
      expectedHeadSha: string;
      message: string;
      files: readonly Readonly<{ path: string; content: string }>[];
      deliveryId: string;
    },
  ): Readonly<{ branch: string; sha: string; parentSha: string; recovered: boolean }> {
    const project = this.#authorize(auth, input.projectId, "commit_files");
    const message = requireText(input.message, "Commit message");
    if (!input.files.length) {
      throw new GitLabFixtureError("INVALID_INPUT", "Commit must include at least one file");
    }
    const normalizedFiles = input.files
      .map((file) => ({ path: requireRepositoryPath(file.path), content: file.content }))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (new Set(normalizedFiles.map((file) => file.path)).size !== normalizedFiles.length) {
      throw new GitLabFixtureError("INVALID_INPUT", "Commit contains duplicate file paths");
    }
    const expectedHeadSha = input.expectedHeadSha.toLowerCase();
    return this.#recover(
      auth,
      input.deliveryId,
      "commit_files",
      {
        projectId: input.projectId,
        branch: input.branch,
        expectedHeadSha,
        message,
        files: normalizedFiles,
      },
      () => {
        const head = project.branches.get(input.branch);
        if (!head) throw new GitLabFixtureError("REF_NOT_FOUND", "Branch does not exist");
        if (head !== expectedHeadSha) {
          throw new GitLabFixtureError(
            "DIVERGENT_RECOVERY",
            "Branch head differs from the expected immutable parent",
          );
        }
        const parent = project.commits.get(head)!;
        const files = new Map(parent.files);
        for (const file of normalizedFiles) files.set(file.path, file.content);
        assertPortablePaths(files.keys());
        const sha = digest(stable({ parentSha: head, message, files: [...files] })).slice(0, 40);
        project.commits.set(sha, { sha, parentSha: head, message, files });
        project.branches.set(input.branch, sha);
        return Object.freeze({ branch: input.branch, sha, parentSha: head, recovered: false });
      },
    );
  }

  openDraftMergeRequest(
    auth: GitLabFixtureAuth,
    input: {
      projectId: string;
      sourceBranch: string;
      targetBranch: string;
      title: string;
      description: string;
      deliveryId: string;
    },
  ): GitLabMergeRequest {
    const project = this.#authorize(auth, input.projectId, "open_draft_merge_request");
    const sourceSha = project.branches.get(input.sourceBranch);
    const targetSha = project.branches.get(input.targetBranch);
    if (!sourceSha || !targetSha) {
      throw new GitLabFixtureError("REF_NOT_FOUND", "Merge request branch does not exist");
    }
    if (sourceSha === targetSha) {
      throw new GitLabFixtureError("CONFLICT", "Merge request has no changes");
    }
    return this.#recover(
      auth,
      input.deliveryId,
      "open_draft_merge_request",
      { ...input, sourceSha, title: requireText(input.title, "Title") },
      () => {
        const iid = project.nextMergeRequestIid++;
        const mergeRequest = Object.freeze({
          id: `gitlab-fixture-${project.projectId}-${iid}`,
          iid,
          tenantId: auth.tenantId,
          projectId: project.projectId,
          sourceBranch: input.sourceBranch,
          targetBranch: input.targetBranch,
          sourceSha,
          title: input.title.trim(),
          description: input.description,
          url: `https://gitlab.example/${project.pathWithNamespace}/-/merge_requests/${iid}`,
          draft: true as const,
          state: "open" as const,
          authorId: auth.actorId,
          createdAt: this.#now().toISOString(),
        });
        project.mergeRequests.set(iid, mergeRequest);
        return mergeRequest;
      },
    );
  }

  recordPipeline(
    auth: GitLabFixtureAuth,
    input: { projectId: string; sha: string; status: GitLabPipelineStatus },
  ): void {
    const project = this.#authorize(auth, input.projectId, "record_pipeline");
    this.#setPipeline(project, input.sha, input.status);
  }

  getPipelineStatus(
    auth: GitLabFixtureAuth,
    input: { projectId: string; sha: string },
  ): GitLabPipelineStatus | undefined {
    const project = this.#authorize(auth, input.projectId, "get_pipeline");
    return project.pipelines.get(input.sha.toLowerCase());
  }

  addDiscussion(
    auth: GitLabFixtureAuth,
    input: { projectId: string; mergeRequestIid: number; body: string },
  ): GitLabDiscussion {
    const project = this.#authorize(auth, input.projectId, "add_discussion");
    this.#mergeRequest(project, input.mergeRequestIid);
    const id = `discussion-${project.nextDiscussionId++}`;
    const discussion: MutableDiscussion = {
      id,
      mergeRequestIid: input.mergeRequestIid,
      authorId: auth.actorId,
      body: requireText(input.body, "Discussion body"),
      resolved: false,
      resolutionEvidence: [],
    };
    project.discussions.set(id, discussion);
    return this.#readonlyDiscussion(discussion);
  }

  resolveDiscussion(
    auth: GitLabFixtureAuth,
    input: { projectId: string; discussionId: string; evidence: readonly string[] },
  ): GitLabDiscussion {
    const project = this.#authorize(auth, input.projectId, "resolve_discussion");
    const discussion = project.discussions.get(input.discussionId);
    if (!discussion) {
      throw new GitLabFixtureError("MERGE_REQUEST_NOT_FOUND", "Discussion does not exist");
    }
    const evidence = this.#evidence(input.evidence);
    discussion.resolved = true;
    discussion.resolutionEvidence = evidence;
    return this.#readonlyDiscussion(discussion);
  }

  approveMergeRequest(
    auth: GitLabFixtureAuth,
    input: { projectId: string; mergeRequestIid: number; reviewEvidence: readonly string[] },
  ): GitLabApproval {
    const project = this.#authorize(auth, input.projectId, "approve_merge_request");
    const mergeRequest = this.#mergeRequest(project, input.mergeRequestIid);
    if (mergeRequest.authorId === auth.actorId) {
      throw new GitLabFixtureError("SELF_APPROVAL_FORBIDDEN", "Author cannot approve own change");
    }
    const reviewEvidence = this.#evidence(input.reviewEvidence);
    if (project.pipelines.get(mergeRequest.sourceSha) !== "success") {
      throw new GitLabFixtureError(
        "PIPELINE_NOT_SUCCESSFUL",
        "Exact merge request commit does not have a successful pipeline",
      );
    }
    if (
      [...project.discussions.values()].some(
        (discussion) =>
          discussion.mergeRequestIid === mergeRequest.iid && !discussion.resolved,
      )
    ) {
      throw new GitLabFixtureError(
        "UNRESOLVED_DISCUSSIONS",
        "Merge request has unresolved discussions",
      );
    }
    const approval = Object.freeze({
      mergeRequestIid: mergeRequest.iid,
      reviewerId: auth.actorId,
      reviewEvidence: Object.freeze(reviewEvidence),
      approvedAt: this.#now().toISOString(),
    });
    project.approvals.push(approval);
    return approval;
  }

  receiveWebhook(input: {
    tenantId: string;
    projectId: string;
    rawBody: string;
    headers: Readonly<Record<string, string | undefined>>;
  }): Readonly<{ deliveryId: string; event: string; accepted: true }> {
    const project = this.#project(input.tenantId, input.projectId);
    const headers = Object.fromEntries(
      Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const token = headers["x-gitlab-token"];
    const deliveryId = headers["x-gitlab-event-uuid"];
    const event = headers["x-gitlab-event"];
    if (!token || !constantTimeEquals(token, project.webhookSecret)) {
      throw new GitLabFixtureError("WEBHOOK_UNSIGNED", "Webhook signature is missing or invalid");
    }
    if (!deliveryId || !event) {
      throw new GitLabFixtureError("WEBHOOK_INVALID", "Webhook identity is missing");
    }
    const replayKey = stable([input.tenantId, input.projectId, deliveryId]);
    if (this.#webhookDeliveries.has(replayKey)) {
      throw new GitLabFixtureError("WEBHOOK_REPLAY", "Webhook delivery was already processed");
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(input.rawBody) as Record<string, unknown>;
    } catch {
      throw new GitLabFixtureError("WEBHOOK_INVALID", "Webhook payload is not valid JSON");
    }
    const payloadProjectId = String(
      (payload.project as { id?: string | number } | undefined)?.id ?? "",
    );
    if (payloadProjectId !== project.projectId) {
      throw new GitLabFixtureError("TENANT_SCOPE_DENIED", "Webhook project binding does not match");
    }
    if (event === "Pipeline Hook") {
      const attributes = payload.object_attributes as
        | { sha?: string; status?: GitLabPipelineStatus }
        | undefined;
      if (!attributes?.sha || !attributes.status) {
        throw new GitLabFixtureError("WEBHOOK_INVALID", "Pipeline hook is incomplete");
      }
      this.#setPipeline(project, attributes.sha, attributes.status);
    }
    this.#webhookDeliveries.add(replayKey);
    return Object.freeze({ deliveryId, event, accepted: true as const });
  }

  #authorize(auth: GitLabFixtureAuth, projectId: string, action: string): Project {
    let project: Project | undefined;
    try {
      if (!auth.tenantId || !auth.credentialId || !auth.token || !auth.actorId) {
        throw new GitLabFixtureError("AUTH_REQUIRED", "Complete GitLab authorization is required");
      }
      const credentials = this.#credentials.filter(
        (credential) =>
          credential.tenantId === auth.tenantId && credential.credentialId === auth.credentialId,
      );
      if (credentials.length !== 1) {
        throw new GitLabFixtureError(
          credentials.length > 1 ? "AUTH_AMBIGUOUS" : "AUTH_INVALID",
          "GitLab credential binding is not unique",
        );
      }
      const credential = credentials[0]!;
      if (credential.revokedAt) {
        throw new GitLabFixtureError("CREDENTIAL_REVOKED", "GitLab credential is revoked");
      }
      if (!constantTimeEquals(auth.token, credential.token)) {
        throw new GitLabFixtureError("AUTH_INVALID", "GitLab credential is invalid");
      }
      project = this.#project(auth.tenantId, projectId);
      this.#record(auth, projectId, action, "accepted");
      return project;
    } catch (error) {
      const reason =
        error instanceof GitLabFixtureError ? error.code : "AUTH_INVALID";
      this.#record(auth, projectId, action, "denied", reason);
      throw error;
    }
  }

  #project(tenantId: string, projectId: string): Project {
    const project = this.#projects.get(this.#projectKey(tenantId, projectId));
    if (project) return project;
    const existsForAnotherTenant = [...this.#projects.values()].some(
      (candidate) => candidate.projectId === projectId,
    );
    throw new GitLabFixtureError(
      existsForAnotherTenant ? "TENANT_SCOPE_DENIED" : "PROJECT_NOT_FOUND",
      existsForAnotherTenant ? "Project belongs to another tenant" : "Project does not exist",
    );
  }

  #resolveCommit(project: Project, ref: string): Commit {
    const normalizedRef = requireText(ref, "Ref").toLowerCase();
    const sha = SHA.test(normalizedRef) ? normalizedRef : project.branches.get(ref);
    const commit = sha ? project.commits.get(sha) : undefined;
    if (!commit) throw new GitLabFixtureError("REF_NOT_FOUND", "Ref does not resolve");
    return commit;
  }

  #mergeRequest(project: Project, iid: number): GitLabMergeRequest {
    const mergeRequest = project.mergeRequests.get(iid);
    if (!mergeRequest) {
      throw new GitLabFixtureError("MERGE_REQUEST_NOT_FOUND", "Merge request does not exist");
    }
    return mergeRequest;
  }

  #setPipeline(project: Project, shaInput: string, status: GitLabPipelineStatus): void {
    const sha = shaInput.toLowerCase();
    if (!SHA.test(sha) || !project.commits.has(sha)) {
      throw new GitLabFixtureError("REF_NOT_FOUND", "Pipeline commit is not in the project");
    }
    if (!["created", "pending", "running", "success", "failed", "canceled"].includes(status)) {
      throw new GitLabFixtureError("WEBHOOK_INVALID", "Pipeline status is invalid");
    }
    project.pipelines.set(sha, status);
  }

  #evidence(input: readonly string[]): string[] {
    const evidence = [...new Set(input.map((item) => item.trim()).filter(Boolean))].sort();
    if (!evidence.length) {
      throw new GitLabFixtureError(
        "REVIEW_EVIDENCE_REQUIRED",
        "Immutable review evidence is required",
      );
    }
    return evidence;
  }

  #readonlyDiscussion(discussion: MutableDiscussion): GitLabDiscussion {
    return Object.freeze({
      ...discussion,
      resolutionEvidence: Object.freeze([...discussion.resolutionEvidence]),
    });
  }

  #recover<T>(
    auth: GitLabFixtureAuth,
    deliveryIdInput: string,
    operation: string,
    input: unknown,
    perform: () => T,
  ): T {
    const deliveryId = requireText(deliveryIdInput, "Delivery identity");
    const key = stable([auth.tenantId, deliveryId]);
    const fingerprint = digest(stable({ operation, input }));
    const existing = this.#recovery.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new GitLabFixtureError(
          "DIVERGENT_RECOVERY",
          "Delivery identity was reused for different work",
        );
      }
      return existing.value as T;
    }
    const value = perform();
    this.#recovery.set(key, { fingerprint, value });
    return value;
  }

  #record(
    auth: Pick<GitLabFixtureAuth, "tenantId" | "actorId">,
    projectId: string,
    action: string,
    outcome: GitLabFixtureAuditEvent["outcome"],
    reason?: GitLabFixtureErrorCode,
  ): void {
    this.#audit.push(
      Object.freeze({
        tenantId: auth.tenantId || "unknown",
        projectId,
        actorId: auth.actorId || "unknown",
        action,
        outcome,
        reason,
        occurredAt: this.#now().toISOString(),
      }),
    );
  }

  #projectKey(tenantId: string, projectId: string): string {
    return stable([tenantId, projectId]);
  }
}
