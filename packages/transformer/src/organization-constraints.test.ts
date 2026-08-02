import { describe, expect, it } from "vitest";
import {
  assessOrganizationConstraint,
  createOrganizationConstraintContract,
} from "./organization-constraints.js";

const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;

function contract() {
  return createOrganizationConstraintContract({
    tenantId: "tenant-a",
    organizationId: "organization-a",
    version: 3,
    effectiveAt: "2026-08-02T08:00:00.000Z",
    sources: [
      {
        id: "source-codeowners",
        kind: "codeowners",
        repositoryId: "repo-api",
        revision,
        digest,
        locator: "source://repo-api/CODEOWNERS",
        evidenceRefs: ["evidence://codeowners"],
      },
      {
        id: "source-policy",
        kind: "explicit_policy",
        repositoryId: "repo-api",
        revision,
        digest,
        locator: "policy://organization-a/protected-paths/v3",
        evidenceRefs: ["evidence://policy-v3"],
      },
    ],
    rules: [
      {
        id: "allow-service",
        sourceId: "source-codeowners",
        repositoryId: "repo-api",
        pathPattern: "services/payments/**",
        actions: ["read", "change"],
        effect: "allow",
        ownerIds: ["team-payments"],
        rationale: "Payments owns this service",
      },
      {
        id: "deny-secrets",
        sourceId: "source-policy",
        repositoryId: "repo-api",
        pathPattern: "services/payments/secrets/**",
        actions: ["change", "delete"],
        effect: "deny",
        ownerIds: ["security"],
        rationale: "Secret material requires a separate process",
      },
    ],
  });
}

describe("organization constraints", () => {
  it("creates a deterministic versioned evidence contract", () => {
    const first = contract();
    const second = contract();
    expect(first.digest).toBe(second.digest);
    expect(first).toMatchObject({ version: 3, schemaVersion: "2026-08-02.v1" });
    expect(Object.isFrozen(first.rules)).toBe(true);
  });

  it("uses explicit policy precedence and preserves decisive evidence", () => {
    expect(assessOrganizationConstraint(contract(), {
      tenantId: "tenant-a",
      organizationId: "organization-a",
      repositoryId: "repo-api",
      path: "services/payments/secrets/key.ts",
      action: "change",
    })).toMatchObject({
      allowed: false,
      reasons: ["constraint_denied"],
      evidenceRefs: ["evidence://policy-v3"],
    });
  });

  it("defaults deny for missing coverage and cross tenant access", () => {
    expect(assessOrganizationConstraint(contract(), {
      tenantId: "tenant-a",
      organizationId: "organization-a",
      repositoryId: "repo-api",
      path: "unknown/file.ts",
      action: "change",
    })).toMatchObject({ allowed: false, reasons: ["constraint_default_deny"] });
    expect(assessOrganizationConstraint(contract(), {
      tenantId: "tenant-b",
      organizationId: "organization-a",
      repositoryId: "repo-api",
      path: "services/payments/index.ts",
      action: "change",
    })).toMatchObject({ allowed: false, reasons: ["constraint_tenant_mismatch"] });
  });

  it("rejects ambiguous rules at equal precedence", () => {
    const base = contract();
    expect(() => createOrganizationConstraintContract({
      tenantId: base.tenantId,
      organizationId: base.organizationId,
      version: 4,
      effectiveAt: base.effectiveAt,
      sources: base.sources,
      rules: [
        ...base.rules,
        {
          ...base.rules[1]!,
          id: "allow-secrets-conflict",
          effect: "allow",
        },
      ],
    })).toThrow("organization_constraint_equal_precedence_conflict");
  });
});
