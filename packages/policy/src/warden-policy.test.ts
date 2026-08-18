import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  WardenPolicyStore,
  resolveWardenPolicy,
  type WardenPolicyContext,
} from "./warden-policy.js";
import { DEFAULT_POLICY } from "./index.js";

const databases: DatabaseSync[] = [];
const at = "2026-08-02T12:00:00.000Z";
const context: WardenPolicyContext = {
  tenantId: "tenant-a",
  repositoryId: "repo-a",
  branch: "release/2026-08",
  environment: "production",
  risk: "breaking",
};

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

function store(): WardenPolicyStore {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return new WardenPolicyStore(db);
}

function create(
  policies: WardenPolicyStore,
  version: number,
  scope: { kind: "tenant" | "repository" | "branch" | "environment" | "risk"; value: string },
  config: Parameters<WardenPolicyStore["createVersion"]>[0]["config"],
) {
  return policies.createVersion({
    id: `policy-${version}`,
    tenantId: "tenant-a",
    policyKey: "delivery",
    version,
    scope,
    config,
    createdBy: "human:policy-author",
    createdAt: new Date(Date.parse(at) + version * 1_000).toISOString(),
    evidenceArtifactId: `artifact-policy-${version}`,
  });
}

function approve(policies: WardenPolicyStore, version: number) {
  return policies.approveVersion({
    id: `approval-${version}`,
    tenantId: "tenant-a",
    policyVersionId: `policy-${version}`,
    approvedBy: "human:security-reviewer",
    approvedAt: new Date(Date.parse(at) + version * 1_000 + 500).toISOString(),
    evidenceArtifactId: `artifact-approval-${version}`,
  });
}

const draft = {
  title: "Update client",
  body: "Update client",
  branchName: "mendpoint/update-client",
  patch: "",
  risk: "breaking" as const,
  confidence: "high" as const,
  fileEdits: [{ path: "src/client.ts", original: "a", updated: "b" }],
};

describe("versioned Warden policy store", () => {
  it("persists immutable sequential versions and independent human approvals", () => {
    const policies = store();
    const created = create(policies, 1, { kind: "tenant", value: "tenant-a" }, {
      notificationsOnly: true,
    });
    expect(created.approvalState).toBe("draft");
    expect(created.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => create(policies, 3, { kind: "repository", value: "repo-a" }, {}))
      .toThrow("warden_policy_version_sequence_invalid");
    const approved = approve(policies, 1);
    expect(approved).toMatchObject({
      approvalState: "approved",
      approval: { approvedBy: "human:security-reviewer" },
    });
    expect(() => policies.approveVersion({
      id: "approval-again",
      tenantId: "tenant-a",
      policyVersionId: "policy-1",
      approvedBy: "human:security-reviewer",
      approvedAt: "2026-08-02T12:02:00.000Z",
      evidenceArtifactId: "artifact-approval-again",
    })).toThrow("warden_policy_already_approved");

    const raw = databases[0]!;
    expect(() => raw.prepare("UPDATE warden_policy_versions SET version = 9 WHERE id = 'policy-1'").run())
      .toThrow(/append_only/);
    expect(() => raw.prepare("DELETE FROM warden_policy_approvals WHERE id = 'approval-1'").run())
      .toThrow(/append_only/);
  });

  it("applies approved tenant, repository, branch, environment, and risk layers in order", () => {
    const policies = store();
    create(policies, 1, { kind: "tenant", value: "tenant-a" }, {
      neverTouchPaths: ["tenant-only/"],
      minConfidenceForEdit: "low",
    });
    create(policies, 2, { kind: "repository", value: "repo-a" }, {
      minConfidenceForEdit: "medium",
    });
    create(policies, 3, { kind: "branch", value: "release/*" }, {
      neverTouchPaths: ["branch-only/"],
    });
    create(policies, 4, { kind: "environment", value: "production" }, {
      notificationsOnly: true,
    });
    create(policies, 5, { kind: "risk", value: "breaking" }, {
      requireTwoReviewersForAuth: false,
    });
    for (let version = 1; version <= 5; version++) approve(policies, version);

    const resolution = policies.resolve(context);
    expect(resolution.appliedVersionIds).toEqual([
      "policy-1", "policy-2", "policy-3", "policy-4", "policy-5",
    ]);
    expect(resolution.appliedDigests).toHaveLength(5);
    expect(resolution.policy).toMatchObject({
      minConfidenceForEdit: "medium",
      neverTouchPaths: [...DEFAULT_POLICY.neverTouchPaths, "branch-only/"],
      notificationsOnly: true,
      requireTwoReviewersForAuth: false,
    });
  });

  it("ignores drafts, other tenants, and nonmatching scopes", () => {
    const policies = store();
    create(policies, 1, { kind: "tenant", value: "tenant-a" }, {
      notificationsOnly: true,
    });
    const tenant = approve(policies, 1);
    const draftVersion = create(policies, 2, { kind: "repository", value: "repo-a" }, {
      notificationsOnly: false,
    });
    const otherBranch = create(policies, 3, { kind: "branch", value: "main" }, {
      minConfidenceForEdit: "high",
    });
    approve(policies, 3);
    const resolved = resolveWardenPolicy([tenant, draftVersion, otherBranch], context);
    expect(resolved.appliedVersionIds).toEqual(["policy-1"]);
    expect(resolved.policy.notificationsOnly).toBe(true);
  });

  it("simulates a draft without activating or mutating it", () => {
    const policies = store();
    create(policies, 1, { kind: "tenant", value: "tenant-a" }, {
      notificationsOnly: false,
    });
    approve(policies, 1);
    const candidate = create(policies, 2, { kind: "risk", value: "breaking" }, {
      notificationsOnly: true,
    });
    const report = policies.simulate({
      tenantId: "tenant-a",
      candidateVersionId: candidate.id,
      cases: [{ id: "breaking-client", context, draft, findings: [] }],
    });
    expect(report.candidateDigest).toBe(candidate.contentSha256);
    expect(report.cases[0]).toMatchObject({
      changed: true,
      before: { allowPr: true },
      after: { allowPr: false },
    });
    expect(policies.getVersion("tenant-a", candidate.id)?.approvalState).toBe("draft");
  });

  it("requires scoped, reasoned, short lived waivers and expires them fail closed", () => {
    const policies = store();
    create(policies, 1, { kind: "tenant", value: "tenant-a" }, {
      notificationsOnly: true,
    });
    approve(policies, 1);
    const waiver = policies.issueWaiver({
      id: "waiver-1",
      tenantId: "tenant-a",
      policyVersionId: "policy-1",
      subjectType: "migration_pr",
      subjectId: "pr-1",
      reason: "Release window approved by the security reviewer",
      issuedBy: "human:security-reviewer",
      issuedAt: "2026-08-02T13:00:00.000Z",
      expiresAt: "2026-08-02T14:00:00.000Z",
      evidenceArtifactId: "artifact-waiver-1",
    });
    expect(policies.activeWaiver({
      tenantId: "tenant-a",
      policyVersionId: "policy-1",
      subjectType: "migration_pr",
      subjectId: "pr-1",
      now: "2026-08-02T13:30:00.000Z",
    })).toEqual(waiver);
    expect(policies.activeWaiver({
      tenantId: "tenant-a",
      policyVersionId: "policy-1",
      subjectType: "migration_pr",
      subjectId: "pr-1",
      now: "2026-08-02T14:00:00.000Z",
    })).toBeNull();
    expect(() => policies.issueWaiver({
      ...waiver,
      id: "waiver-too-long",
      expiresAt: "2026-08-04T13:00:00.000Z",
    })).toThrow("warden_policy_waiver_expiry_invalid");
    expect(() => databases[0]!.prepare(
      "UPDATE warden_policy_waivers SET reason = 'changed' WHERE id = 'waiver-1'",
    ).run()).toThrow(/append_only/);
  });
});
