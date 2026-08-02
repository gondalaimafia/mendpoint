import { describe, expect, it } from "vitest";
import {
  authorizeScmDraftDelivery,
  type ScmDraftDeliveryIntent,
  type ScmInstallationBinding,
} from "./scm-installation-boundary.js";

const repository = { repositoryId: "repo-101", owner: "acme", name: "payments" };
const installation: ScmInstallationBinding = {
  provider: "github" as const,
  tenantId: "tenant-a",
  installationId: "7001",
  installationRevision: 3,
  state: "active" as const,
  repositories: [repository],
  permissions: { metadata: "read" as const, contents: "write" as const, pull_requests: "write" as const },
};
const intent: ScmDraftDeliveryIntent = {
  provider: "github" as const,
  tenantId: "tenant-a",
  installationId: "7001",
  repository,
  snapshotSha: "a".repeat(40),
  candidateDigest: "b".repeat(64),
  headBranch: "mendpoint/runtime-20",
  baseBranch: "main",
  draft: true as const,
  autoMerge: false as const,
  autoDeploy: false as const,
};

describe("SCM installation delivery boundary", () => {
  it("binds a safe draft intent to an exact repository, snapshot, and installation revision", () => {
    expect(authorizeScmDraftDelivery({
      installation,
      intent,
      requiredPermissions: { metadata: "read", contents: "write", pull_requests: "write" },
    })).toMatchObject({
      tenantId: "tenant-a",
      installationId: "7001",
      installationRevision: 3,
      repositoryId: "repo-101",
      repositoryOwner: "acme",
      repositoryName: "payments",
      snapshotSha: "a".repeat(40),
      candidateDigest: "b".repeat(64),
      headBranch: "mendpoint/runtime-20",
      baseBranch: "main",
      draft: true,
      autoMerge: false,
      autoDeploy: false,
    });
  });

  it("fails closed for tenant, repository, permission, lifecycle, and safety drift", () => {
    const authorize = (overrides: Partial<typeof intent> = {}, installOverrides: Partial<typeof installation> = {}) =>
      authorizeScmDraftDelivery({
        installation: { ...installation, ...installOverrides },
        intent: { ...intent, ...overrides },
        requiredPermissions: { metadata: "read", contents: "write", pull_requests: "write" },
      });
    expect(() => authorize({ tenantId: "tenant-b" })).toThrow(expect.objectContaining({ code: "INSTALLATION_SCOPE_DENIED" }));
    expect(() => authorize({ repository: { ...repository, repositoryId: "repo-999" } })).toThrow(expect.objectContaining({ code: "REPOSITORY_SCOPE_DENIED" }));
    expect(() => authorize({}, { permissions: { ...installation.permissions, contents: "read" } })).toThrow(expect.objectContaining({ code: "PERMISSION_DRIFT" }));
    expect(() => authorize({}, { state: "revoked" })).toThrow(expect.objectContaining({ code: "INSTALLATION_INACTIVE" }));
    expect(() => authorize({ headBranch: "main" })).toThrow(expect.objectContaining({ code: "DELIVERY_INTENT_INVALID" }));
    expect(() => authorize({ headBranch: "refs/heads/bad.lock" })).toThrow(expect.objectContaining({ code: "DELIVERY_INTENT_INVALID" }));
    expect(() => authorize({}, { repositories: [repository, { ...repository, owner: "other" }] })).toThrow(
      expect.objectContaining({ code: "REPOSITORY_SCOPE_DENIED" }),
    );
  });
});
