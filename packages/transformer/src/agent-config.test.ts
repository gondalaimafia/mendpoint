import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, evaluatePolicy, mergePolicy } from "@mendpoint/policy";
import { permissionsFor } from "@mendpoint/platform";
import type { MigrationDraft } from "@mendpoint/shared";
import {
  MENDPOINT_CONFIG_SCHEMA_VERSION,
  MendpointConfigError,
  parseMendpointConfig,
  resolveEffectiveConfig,
  effectivePolicyOverrides,
  permittedRolePermissions,
  roleMayUse,
  codingStandardContext,
  isRecipeAllowed,
  type MendpointConfig,
} from "./agent-config.js";
import { classifyReviewTier, DEFAULT_REVIEW_TIER_POLICY } from "./review-tier.js";

const FULL_YAML = `
version: 1
environments:
  - name: staging
    branches: ["staging", "release/*"]
  - name: production
    branches: ["main"]
    protected: true
codingStandards:
  - id: api-style-guide
    ref: fixtures/knowledge/api-style-guide.md
  - id: migration-playbook
    ref: fixtures/knowledge/migration-playbook.md
workflows:
  allowedRecipes: ["node-runtime-20-to-22"]
  allowedAgents: ["transformer"]
  branchTargets: ["main", "staging"]
  draftOnly: true
protectedPaths:
  - "migrations/"
  - "billing/"
escalation:
  requireTwoReviewersForAuth: true
  minConfidence: high
  reviewTier:
    enabled: true
    escalate: { risks: ["high"], minConfidence: 60, maxChangedFiles: 20 }
    block: { risks: [], minConfidence: 25, maxChangedFiles: 50 }
permissions:
  roles:
    engineer:
      trigger: ["plan:execute"]
      approve: ["plan:edit"]
    viewer:
      trigger: []
      approve: []
`;

function draft(paths: string[]): MigrationDraft {
  return {
    title: "t",
    body: "b",
    branchName: "mendpoint/change",
    patch: "",
    risk: "non_breaking",
    confidence: "high",
    fileEdits: paths.map((path) => ({ path, original: "a", updated: "b" })),
  };
}

describe("parseMendpointConfig", () => {
  it("parses a complete valid YAML config", () => {
    const config = parseMendpointConfig(FULL_YAML);
    expect(config.version).toBe(MENDPOINT_CONFIG_SCHEMA_VERSION);
    expect(config.environments.map((e) => e.name)).toEqual(["staging", "production"]);
    expect(config.environments[1].protected).toBe(true);
    expect(config.codingStandards.map((s) => s.id)).toEqual(["api-style-guide", "migration-playbook"]);
    expect(config.protectedPaths).toEqual(["migrations/", "billing/"]);
    expect(config.escalation.minConfidence).toBe("high");
    expect(config.escalation.reviewTier?.enabled).toBe(true);
    expect(config.permissions.roles.engineer.trigger).toEqual(["plan:execute"]);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("parses the JSON form identically", () => {
    const json = JSON.stringify({
      version: 1,
      protectedPaths: ["migrations/"],
      escalation: { minConfidence: "high" },
    });
    const config = parseMendpointConfig(json, { format: "json" });
    expect(config.protectedPaths).toEqual(["migrations/"]);
    expect(config.escalation.minConfidence).toBe("high");
  });

  it("accepts an already-parsed object", () => {
    const config = parseMendpointConfig({ version: 1 });
    expect(config.version).toBe(1);
    expect(config.protectedPaths).toEqual([]);
  });

  describe("fails closed with actionable errors", () => {
    it("rejects a missing version", () => {
      try {
        parseMendpointConfig({ protectedPaths: ["x/"] });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MendpointConfigError);
        const e = err as MendpointConfigError;
        expect(e.code).toBe("mendpoint_config_version_required");
        expect(e.path).toBe("version");
        expect(e.message).toContain("set version: 1");
      }
    });

    it("rejects an unsupported version", () => {
      const e = capture(() => parseMendpointConfig({ version: 2 }));
      expect(e.code).toBe("mendpoint_config_version_unsupported");
      expect(e.message).toContain("understands version 1");
    });

    it("rejects an unknown top-level field naming the allowed set", () => {
      const e = capture(() => parseMendpointConfig({ version: 1, autoMerge: true }));
      expect(e.code).toBe("mendpoint_config_unknown_key");
      expect(e.path).toBe("autoMerge");
      expect(e.message).toContain("allowed fields here are");
    });

    it("rejects an unknown nested field", () => {
      const e = capture(() => parseMendpointConfig({ version: 1, escalation: { nope: 1 } }));
      expect(e.code).toBe("mendpoint_config_unknown_key");
      expect(e.path).toBe("escalation.nope");
    });

    it("rejects a wrong type with a location and fix", () => {
      const e = capture(() => parseMendpointConfig({ version: 1, protectedPaths: "migrations/" }));
      expect(e.code).toBe("mendpoint_config_array_required");
      expect(e.path).toBe("protectedPaths");
      expect(e.message).toContain("list of strings");
    });

    it("rejects malformed YAML syntax", () => {
      const e = capture(() => parseMendpointConfig("version: 1\n  bad: : :", { filename: "mendpoint.yaml" }));
      expect(e.code).toBe("mendpoint_config_syntax_invalid");
    });

    it("rejects an unknown confidence value", () => {
      const e = capture(() => parseMendpointConfig({ version: 1, escalation: { minConfidence: "extreme" } }));
      expect(e.code).toBe("mendpoint_config_min_confidence_invalid");
      expect(e.message).toContain("low, medium, high");
    });
  });

  describe("rejects widening attempts (narrow-only)", () => {
    it("rejects draftOnly: false (cannot bypass review)", () => {
      const e = capture(() => parseMendpointConfig({ version: 1, workflows: { draftOnly: false } }));
      expect(e.code).toBe("mendpoint_config_draft_only_widen");
      expect(e.path).toBe("workflows.draftOnly");
    });

    it("rejects granting a role a permission RBAC does not give it (widen RBAC)", () => {
      // viewer has only read perms in RBAC; granting pr:write is a widening attempt.
      const e = capture(() =>
        parseMendpointConfig({ version: 1, permissions: { roles: { viewer: { trigger: ["pr:write"] } } } }),
      );
      expect(e.code).toBe("mendpoint_config_permission_widen");
      expect(e.message).toContain("can only narrow RBAC");
    });

    it("rejects an unknown role name", () => {
      const e = capture(() =>
        parseMendpointConfig({ version: 1, permissions: { roles: { superuser: { trigger: [] } } } }),
      );
      expect(e.code).toBe("mendpoint_config_role_unknown");
    });

    it("rejects a non-monotonic review-tier (block laxer than escalate)", () => {
      const e = capture(() =>
        parseMendpointConfig({
          version: 1,
          escalation: {
            reviewTier: {
              enabled: true,
              escalate: { minConfidence: 60 },
              block: { minConfidence: 90 },
            },
          },
        }),
      );
      expect(e.code).toBe("mendpoint_config_review_tier_invalid");
    });
  });
});

describe("resolveEffectiveConfig — default-safe", () => {
  it("with no config is byte-identical to platform defaults", () => {
    const effective = resolveEffectiveConfig({});
    expect(effective.source).toBe("default");
    expect(effective.policy).toEqual(mergePolicy());
    expect(effective.policy).toEqual(DEFAULT_POLICY);
    expect(effective.reviewTierPolicy).toEqual(DEFAULT_REVIEW_TIER_POLICY);
    expect(effective.roleRestrictions).toEqual({});
    expect(effectivePolicyOverrides(effective)).toEqual({});
    // Full RBAC preserved for every role.
    expect(permittedRolePermissions(effective, "engineer").trigger).toEqual(permissionsFor("engineer"));
  });

  it("null layers resolve to defaults", () => {
    const effective = resolveEffectiveConfig({ fileConfig: null, tenantDefaults: null });
    expect(effectivePolicyOverrides(effective)).toEqual({});
  });
});

describe("resolveEffectiveConfig — governs runs", () => {
  const config = parseMendpointConfig(FULL_YAML);

  it("a protected path blocks an edit at the real policy seam", () => {
    const effective = resolveEffectiveConfig({ fileConfig: config });
    const decision = evaluatePolicy(draft(["migrations/001.sql", "src/app.ts"]), [], {
      policy: effectivePolicyOverrides(effective),
    });
    expect(decision.blockedFiles).toContain("migrations/001.sql");
    expect(decision.allowedEdits.map((e) => e.path)).toEqual(["src/app.ts"]);
    // Baseline denylist still enforced (union, not replacement).
    const withDefault = evaluatePolicy(draft([".env", "src/app.ts"]), [], {
      policy: effectivePolicyOverrides(effective),
    });
    expect(withDefault.blockedFiles).toContain(".env");
  });

  it("escalation raises the required approval strength via review-tier", () => {
    const effective = resolveEffectiveConfig({ fileConfig: config });
    const candidate = { overallRisk: "high" as const, confidence: 95, changedFileCount: 3, verificationPassed: true };
    // Default (disabled) policy => standard. Config policy => escalated for high risk.
    expect(classifyReviewTier(candidate, DEFAULT_REVIEW_TIER_POLICY)).toBe("standard");
    expect(classifyReviewTier(candidate, effective.reviewTierPolicy)).toBe("escalated");
  });

  it("raises minConfidence and requires two reviewers (narrowing overrides)", () => {
    const effective = resolveEffectiveConfig({ fileConfig: config });
    const overrides = effectivePolicyOverrides(effective);
    expect(overrides.minConfidenceForEdit).toBe("high");
    // requireTwoReviewersForAuth is already the platform default (true), so the
    // minimal diff omits it while the effective policy still enforces it.
    expect(effective.policy.requireTwoReviewersForAuth).toBe(true);
    expect("requireTwoReviewersForAuth" in overrides).toBe(false);
    // Config can never emit an auto-merge widening.
    expect("autoMergeLowRisk" in overrides).toBe(false);
    expect(effective.policy.autoMergeLowRisk).toBe(false);
  });

  it("a coding-standard ref reaches the agent context", () => {
    const effective = resolveEffectiveConfig({ fileConfig: config });
    const context = codingStandardContext(effective);
    expect(context).toContain("api-style-guide:fixtures/knowledge/api-style-guide.md");
    expect(context).toContain("migration-playbook:fixtures/knowledge/migration-playbook.md");
  });

  it("workflow allow-list gates recipes", () => {
    const effective = resolveEffectiveConfig({ fileConfig: config });
    expect(isRecipeAllowed(effective, "node-runtime-20-to-22")).toBe(true);
    expect(isRecipeAllowed(effective, "aws-sdk-js-v2-to-v3")).toBe(false);
  });

  it("narrows RBAC per role without widening", () => {
    const effective = resolveEffectiveConfig({ fileConfig: config });
    // engineer restricted to a subset it actually holds.
    expect(roleMayUse(effective, "engineer", "trigger", "plan:execute")).toBe(true);
    expect(roleMayUse(effective, "engineer", "trigger", "pr:write")).toBe(false);
    expect(roleMayUse(effective, "engineer", "approve", "plan:edit")).toBe(true);
    // viewer fully locked down.
    expect(permittedRolePermissions(effective, "viewer")).toEqual({ trigger: [], approve: [] });
    // a role the config did not mention keeps full RBAC.
    expect(permittedRolePermissions(effective, "owner").trigger).toEqual(permissionsFor("owner"));
  });

  it("a protected environment forces two-reviewer escalation", () => {
    const minimal = parseMendpointConfig({
      version: 1,
      environments: [{ name: "production", branches: ["main"], protected: true }],
    });
    const withoutEnv = resolveEffectiveConfig({ fileConfig: minimal });
    expect(withoutEnv.policy.requireTwoReviewersForAuth).toBe(DEFAULT_POLICY.requireTwoReviewersForAuth);
    const withEnv = resolveEffectiveConfig({ fileConfig: minimal, environment: "production" });
    expect(withEnv.policy.requireTwoReviewersForAuth).toBe(true);
    expect(withEnv.selectedEnvironment?.name).toBe("production");
  });
});

describe("resolveEffectiveConfig — layering (repo over tenant)", () => {
  it("repo config narrows further than tenant defaults; neither can widen", () => {
    const tenant = parseMendpointConfig({
      version: 1,
      protectedPaths: ["tenant-secrets/"],
      escalation: { minConfidence: "medium" },
      permissions: { roles: { engineer: { trigger: ["plan:execute", "pr:write"] } } },
    });
    const repo = parseMendpointConfig({
      version: 1,
      protectedPaths: ["repo-migrations/"],
      escalation: { minConfidence: "high", notificationsOnly: true },
      permissions: { roles: { engineer: { trigger: ["plan:execute"] } } },
    });
    const effective = resolveEffectiveConfig({ tenantDefaults: tenant, fileConfig: repo });
    // Protected paths union across both layers plus the platform default denylist.
    expect(effective.policy.neverTouchPaths).toEqual(expect.arrayContaining(["tenant-secrets/", "repo-migrations/", ".env"]));
    // minConfidence took the stricter (high) of the two layers.
    expect(effective.policy.minConfidenceForEdit).toBe("high");
    expect(effective.policy.notificationsOnly).toBe(true);
    // Role permissions intersect: engineer ends with just plan:execute (repo narrowed pr:write away).
    expect(permittedRolePermissions(effective, "engineer").trigger).toEqual(["plan:execute"]);
  });

  it("a lower-confidence repo layer cannot lower a stricter tenant floor (clamped up)", () => {
    const tenant = parseMendpointConfig({ version: 1, escalation: { minConfidence: "high" } });
    const repo = parseMendpointConfig({ version: 1, escalation: { minConfidence: "low" } });
    const effective = resolveEffectiveConfig({ tenantDefaults: tenant, fileConfig: repo });
    expect(effective.policy.minConfidenceForEdit).toBe("high");
  });
});

function capture(fn: () => unknown): MendpointConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof MendpointConfigError) return err;
    throw err;
  }
  throw new Error("expected MendpointConfigError to be thrown");
}
