/**
 * Agent configuration-as-code (`mendpoint.yaml` / `mendpoint.json`).
 *
 * A repo-committed config file lets a customer define agent roles/permissions,
 * environments, coding standards, workflows, and escalation rules WITHOUT our
 * help. This module is the typed, versioned schema plus a strict fail-closed
 * parser and a resolution seam that layers repo config over tenant defaults and
 * feeds the existing enforcement primitives.
 *
 * NARROW-ONLY INVARIANT (enforced in code + tested):
 *   Config may only NARROW the platform's safety guarantees, never widen them.
 *   It can require MORE approvals or protect MORE paths, but can never enable
 *   auto-merge, bypass human review/draft-only, unprotect a protected path, or
 *   grant a role a permission the platform RBAC does not already give it.
 *
 * DEFAULT-SAFE: with no config present the resolved effective config is
 * byte-identical to today's platform defaults (empty policy overrides, the
 * disabled review-tier policy, full RBAC), so behavior is unchanged.
 *
 * Composes (never duplicates) existing primitives:
 *   - `@mendpoint/policy`  PolicyConfig / DEFAULT_POLICY / mergePolicy
 *   - `./review-tier.js`   ReviewTierPolicy / resolveReviewTierPolicy
 *   - `@mendpoint/platform` RBAC permissionsFor / Role / Permission
 *   - protected paths compose with the policy `neverTouchPaths` denylist, the
 *     self-serve twin of the machine-derived organization-constraints ladder.
 */
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_POLICY,
  mergePolicy,
  type PolicyConfig,
} from "@mendpoint/policy";
import { permissionsFor, type Permission, type Role } from "@mendpoint/platform";
import type { Confidence } from "@mendpoint/shared";
import {
  DEFAULT_REVIEW_TIER_POLICY,
  resolveReviewTierPolicy,
  type ReviewTierPolicy,
  type ReviewTierBand,
} from "./review-tier.js";

export const MENDPOINT_CONFIG_SCHEMA_VERSION = 1 as const;

const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = { low: 0, medium: 1, high: 2 };
const CONFIDENCE_VALUES: readonly Confidence[] = ["low", "medium", "high"];
const REVIEW_RISK_VALUES: readonly ("low" | "medium" | "high")[] = ["low", "medium", "high"];

/**
 * A parse/validation failure. Messages are deliberately actionable: they name
 * WHERE the problem is (`path`), WHAT is wrong (the message body), and HOW to
 * fix it (`hint`). Callers can surface `message` directly to an engineer.
 */
export class MendpointConfigError extends Error {
  readonly code: string;
  readonly path: string;
  readonly hint: string;
  constructor(code: string, path: string, problem: string, hint: string) {
    super(`${path}: ${problem} — ${hint}`);
    this.name = "MendpointConfigError";
    this.code = code;
    this.path = path;
    this.hint = hint;
  }
}

// ---------------------------------------------------------------------------
// Schema (normalized, frozen)
// ---------------------------------------------------------------------------

export type MendpointEnvironment = Readonly<{
  name: string;
  /** Branch glob patterns this environment scopes (e.g. `main`, `release/*`). */
  branches: readonly string[];
  /** A protected environment forces escalation (two reviewers) on every run. */
  protected: boolean;
}>;

export type MendpointCodingStandard = Readonly<{
  /** Stable id the agent context keys on. */
  id: string;
  /** A repo-relative path or knowledge-doc id the agent must preserve. */
  ref: string;
}>;

export type MendpointWorkflows = Readonly<{
  /** Recipe ids the agent may run; `null` means no repo restriction. */
  allowedRecipes: readonly string[] | null;
  /** Agent names allowed to act; `null` means no repo restriction. */
  allowedAgents: readonly string[] | null;
  /** Branches a run may target; `null` means no repo restriction. */
  branchTargets: readonly string[] | null;
  /**
   * Draft-only is the platform floor: every candidate is a reviewable draft and
   * nothing auto-merges. Config may assert `true` (a no-op that documents the
   * intent); it may never set `false` to bypass review. `false` is rejected.
   */
  draftOnly: boolean;
}>;

export type MendpointRolePermissions = Readonly<{
  /** Permissions this role may use to TRIGGER a run. Subset of RBAC grants. */
  trigger: readonly Permission[];
  /** Permissions this role may use to APPROVE a run. Subset of RBAC grants. */
  approve: readonly Permission[];
}>;

export type MendpointConfig = Readonly<{
  version: typeof MENDPOINT_CONFIG_SCHEMA_VERSION;
  environments: readonly MendpointEnvironment[];
  codingStandards: readonly MendpointCodingStandard[];
  workflows: MendpointWorkflows;
  /** Extra paths the agent must never edit (union with the platform denylist). */
  protectedPaths: readonly string[];
  escalation: Readonly<{
    /** May raise to `true`; may never lower a platform/tenant `true` to `false`. */
    requireTwoReviewersForAuth: boolean;
    /** May raise (low<medium<high); may never lower the baseline. */
    minConfidence: Confidence;
    /** May raise to `true` (block PR opens); OR-combined, never lowered. */
    notificationsOnly: boolean;
    /** Review-tier escalation bands; `null` inherits. Only ever raises the bar. */
    reviewTier: ReviewTierPolicy | null;
  }>;
  /** Per-role permission narrowing; roles absent here keep full RBAC. */
  permissions: Readonly<{
    roles: Readonly<Record<string, MendpointRolePermissions>>;
  }>;
}>;

// ---------------------------------------------------------------------------
// Strict field readers (fail-closed, actionable)
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new MendpointConfigError(
        "mendpoint_config_unknown_key",
        path === "" ? key : `${path}.${key}`,
        `unknown field '${key}'`,
        `remove it — allowed fields here are: ${allowed.join(", ")}`,
      );
    }
  }
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new MendpointConfigError(
      "mendpoint_config_object_required",
      path,
      "expected a mapping/object",
      "provide a YAML mapping or JSON object here",
    );
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new MendpointConfigError(
      "mendpoint_config_string_required",
      path,
      "expected a non-empty, trimmed string",
      "provide a text value with no leading/trailing whitespace",
    );
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new MendpointConfigError(
      "mendpoint_config_boolean_required",
      path,
      "expected true or false",
      "use a boolean literal (true/false), not a string",
    );
  }
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new MendpointConfigError(
      "mendpoint_config_array_required",
      path,
      "expected a list of strings",
      "provide a YAML/JSON array of text values",
    );
  }
  return value.map((item, index) => requireString(item, `${path}[${index}]`));
}

function requireIntInRange(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new MendpointConfigError(
      "mendpoint_config_integer_range",
      path,
      `expected a whole number from ${min} through ${max}`,
      `use an integer within [${min}, ${max}]`,
    );
  }
  return value as number;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const ROOT_KEYS = [
  "version",
  "environments",
  "codingStandards",
  "workflows",
  "protectedPaths",
  "escalation",
  "permissions",
] as const;

function parseEnvironments(raw: unknown): MendpointEnvironment[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new MendpointConfigError(
      "mendpoint_config_array_required",
      "environments",
      "expected a list of environments",
      "provide a list, e.g. [{ name: production, branches: [main], protected: true }]",
    );
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const path = `environments[${index}]`;
    const obj = requireObject(entry, path);
    rejectUnknownKeys(obj, ["name", "branches", "protected"], path);
    const name = requireString(obj.name, `${path}.name`);
    if (seen.has(name)) {
      throw new MendpointConfigError(
        "mendpoint_config_environment_duplicate",
        `${path}.name`,
        `duplicate environment '${name}'`,
        "give each environment a unique name",
      );
    }
    seen.add(name);
    const branches = obj.branches === undefined ? [] : requireStringArray(obj.branches, `${path}.branches`);
    const isProtected = obj.protected === undefined ? false : requireBoolean(obj.protected, `${path}.protected`);
    return { name, branches, protected: isProtected };
  });
}

function parseCodingStandards(raw: unknown): MendpointCodingStandard[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new MendpointConfigError(
      "mendpoint_config_array_required",
      "codingStandards",
      "expected a list of coding standards",
      "provide a list, e.g. [{ id: api-style, ref: fixtures/knowledge/api-style-guide.md }]",
    );
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const path = `codingStandards[${index}]`;
    const obj = requireObject(entry, path);
    rejectUnknownKeys(obj, ["id", "ref"], path);
    const id = requireString(obj.id, `${path}.id`);
    if (seen.has(id)) {
      throw new MendpointConfigError(
        "mendpoint_config_coding_standard_duplicate",
        `${path}.id`,
        `duplicate coding-standard id '${id}'`,
        "give each coding standard a unique id",
      );
    }
    seen.add(id);
    return { id, ref: requireString(obj.ref, `${path}.ref`) };
  });
}

function parseWorkflows(raw: unknown): MendpointWorkflows {
  if (raw === undefined) {
    return { allowedRecipes: null, allowedAgents: null, branchTargets: null, draftOnly: true };
  }
  const obj = requireObject(raw, "workflows");
  rejectUnknownKeys(obj, ["allowedRecipes", "allowedAgents", "branchTargets", "draftOnly"], "workflows");
  const draftOnly = obj.draftOnly === undefined ? true : requireBoolean(obj.draftOnly, "workflows.draftOnly");
  if (draftOnly === false) {
    throw new MendpointConfigError(
      "mendpoint_config_draft_only_widen",
      "workflows.draftOnly",
      "draft-only review cannot be disabled by config",
      "remove the field or set it to true — every candidate must stay a reviewable draft",
    );
  }
  return {
    allowedRecipes: obj.allowedRecipes === undefined ? null : requireStringArray(obj.allowedRecipes, "workflows.allowedRecipes"),
    allowedAgents: obj.allowedAgents === undefined ? null : requireStringArray(obj.allowedAgents, "workflows.allowedAgents"),
    branchTargets: obj.branchTargets === undefined ? null : requireStringArray(obj.branchTargets, "workflows.branchTargets"),
    draftOnly: true,
  };
}

function parseReviewTierBand(raw: unknown, path: string): ReviewTierBand {
  const obj = requireObject(raw, path);
  rejectUnknownKeys(obj, ["risks", "minConfidence", "maxChangedFiles"], path);
  const risks = obj.risks === undefined ? [] : requireStringArray(obj.risks, `${path}.risks`);
  for (const [index, risk] of risks.entries()) {
    if (!REVIEW_RISK_VALUES.includes(risk as (typeof REVIEW_RISK_VALUES)[number])) {
      throw new MendpointConfigError(
        "mendpoint_config_review_risk_invalid",
        `${path}.risks[${index}]`,
        `unknown risk '${risk}'`,
        `use one of: ${REVIEW_RISK_VALUES.join(", ")}`,
      );
    }
  }
  return {
    risks: risks as readonly ("low" | "medium" | "high")[],
    minConfidence: obj.minConfidence === undefined ? 0 : requireIntInRange(obj.minConfidence, `${path}.minConfidence`, 0, 100),
    maxChangedFiles:
      obj.maxChangedFiles === undefined
        ? Number.MAX_SAFE_INTEGER
        : requireIntInRange(obj.maxChangedFiles, `${path}.maxChangedFiles`, 1, Number.MAX_SAFE_INTEGER),
  };
}

function parseEscalation(raw: unknown): MendpointConfig["escalation"] {
  if (raw === undefined) {
    return {
      requireTwoReviewersForAuth: DEFAULT_POLICY.requireTwoReviewersForAuth,
      minConfidence: DEFAULT_POLICY.minConfidenceForEdit,
      notificationsOnly: DEFAULT_POLICY.notificationsOnly,
      reviewTier: null,
    };
  }
  const obj = requireObject(raw, "escalation");
  rejectUnknownKeys(
    obj,
    ["requireTwoReviewersForAuth", "minConfidence", "notificationsOnly", "reviewTier"],
    "escalation",
  );
  let minConfidence: Confidence = DEFAULT_POLICY.minConfidenceForEdit;
  if (obj.minConfidence !== undefined) {
    const value = requireString(obj.minConfidence, "escalation.minConfidence");
    if (!CONFIDENCE_VALUES.includes(value as Confidence)) {
      throw new MendpointConfigError(
        "mendpoint_config_min_confidence_invalid",
        "escalation.minConfidence",
        `unknown confidence '${value}'`,
        `use one of: ${CONFIDENCE_VALUES.join(", ")}`,
      );
    }
    minConfidence = value as Confidence;
  }
  let reviewTier: ReviewTierPolicy | null = null;
  if (obj.reviewTier !== undefined) {
    const tierObj = requireObject(obj.reviewTier, "escalation.reviewTier");
    rejectUnknownKeys(tierObj, ["enabled", "escalate", "block"], "escalation.reviewTier");
    const enabled = tierObj.enabled === undefined ? true : requireBoolean(tierObj.enabled, "escalation.reviewTier.enabled");
    const escalate = parseReviewTierBand(tierObj.escalate ?? {}, "escalation.reviewTier.escalate");
    const block = parseReviewTierBand(tierObj.block ?? {}, "escalation.reviewTier.block");
    // resolveReviewTierPolicy validates the monotonic block>=escalate invariant.
    try {
      reviewTier = resolveReviewTierPolicy({ enabled, escalate, block });
    } catch (cause) {
      throw new MendpointConfigError(
        "mendpoint_config_review_tier_invalid",
        "escalation.reviewTier",
        `invalid review-tier bands (${(cause as Error).message})`,
        "the block band must be at least as strict as the escalate band on every axis",
      );
    }
  }
  return {
    requireTwoReviewersForAuth:
      obj.requireTwoReviewersForAuth === undefined
        ? DEFAULT_POLICY.requireTwoReviewersForAuth
        : requireBoolean(obj.requireTwoReviewersForAuth, "escalation.requireTwoReviewersForAuth"),
    minConfidence,
    notificationsOnly:
      obj.notificationsOnly === undefined
        ? DEFAULT_POLICY.notificationsOnly
        : requireBoolean(obj.notificationsOnly, "escalation.notificationsOnly"),
    reviewTier,
  };
}

function parsePermissions(raw: unknown): MendpointConfig["permissions"] {
  if (raw === undefined) return { roles: {} };
  const obj = requireObject(raw, "permissions");
  rejectUnknownKeys(obj, ["roles"], "permissions");
  if (obj.roles === undefined) return { roles: {} };
  const rolesObj = requireObject(obj.roles, "permissions.roles");
  const roles: Record<string, MendpointRolePermissions> = {};
  for (const roleName of Object.keys(rolesObj)) {
    const path = `permissions.roles.${roleName}`;
    // A real RBAC role always has at least one grant; an empty set means the role
    // does not exist in the platform RBAC model.
    const grants = permissionsFor(roleName as Role);
    if (grants.length === 0) {
      throw new MendpointConfigError(
        "mendpoint_config_role_unknown",
        path,
        `unknown role '${roleName}'`,
        "use a role defined in the platform RBAC model (owner, admin, engineer, fde, viewer, agent)",
      );
    }
    const roleObj = requireObject(rolesObj[roleName], path);
    rejectUnknownKeys(roleObj, ["trigger", "approve"], path);
    const readPerms = (key: "trigger" | "approve"): Permission[] => {
      if (roleObj[key] === undefined) return [];
      const requested = requireStringArray(roleObj[key], `${path}.${key}`);
      return requested.map((perm, index) => {
        // Narrow-only: a role may only be GRANTED a permission the platform RBAC
        // already gives it. Anything else is a widening attempt and is rejected.
        if (!grants.includes(perm as Permission)) {
          throw new MendpointConfigError(
            "mendpoint_config_permission_widen",
            `${path}.${key}[${index}]`,
            `role '${roleName}' cannot be granted '${perm}'`,
            "config can only narrow RBAC — remove it (this permission is not among the platform grants for this role)",
          );
        }
        return perm as Permission;
      });
    };
    roles[roleName] = { trigger: readPerms("trigger"), approve: readPerms("approve") };
  }
  return { roles };
}

/**
 * Parse and strictly validate a `mendpoint.yaml` / `mendpoint.json` config.
 *
 * Accepts a raw YAML/JSON string or an already-parsed plain object. Fails closed:
 * an unknown field, wrong type, unknown version, unknown role/permission, or any
 * widening attempt throws a {@link MendpointConfigError} with an actionable
 * message (what is wrong, where, and how to fix it).
 */
export function parseMendpointConfig(
  input: string | Record<string, unknown>,
  opts: { format?: "yaml" | "json" | "auto"; filename?: string } = {},
): MendpointConfig {
  let doc: unknown;
  if (typeof input === "string") {
    const format = opts.format ?? (opts.filename?.endsWith(".json") ? "json" : "auto");
    try {
      doc = format === "json" ? JSON.parse(input) : parseYaml(input);
    } catch (cause) {
      throw new MendpointConfigError(
        "mendpoint_config_syntax_invalid",
        opts.filename ?? "mendpoint.yaml",
        `could not parse ${format === "json" ? "JSON" : "YAML"} (${(cause as Error).message})`,
        "fix the syntax so the file parses as a mapping/object",
      );
    }
  } else {
    doc = input;
  }

  const root = requireObject(doc, "");
  rejectUnknownKeys(root, ROOT_KEYS, "");

  if (root.version === undefined) {
    throw new MendpointConfigError(
      "mendpoint_config_version_required",
      "version",
      "missing required field 'version'",
      `set version: ${MENDPOINT_CONFIG_SCHEMA_VERSION}`,
    );
  }
  if (root.version !== MENDPOINT_CONFIG_SCHEMA_VERSION) {
    throw new MendpointConfigError(
      "mendpoint_config_version_unsupported",
      "version",
      `unsupported schema version ${JSON.stringify(root.version)}`,
      `this build understands version ${MENDPOINT_CONFIG_SCHEMA_VERSION} — set version: ${MENDPOINT_CONFIG_SCHEMA_VERSION}`,
    );
  }

  return deepFreeze({
    version: MENDPOINT_CONFIG_SCHEMA_VERSION,
    environments: parseEnvironments(root.environments),
    codingStandards: parseCodingStandards(root.codingStandards),
    workflows: parseWorkflows(root.workflows),
    protectedPaths: root.protectedPaths === undefined ? [] : requireStringArray(root.protectedPaths, "protectedPaths"),
    escalation: parseEscalation(root.escalation),
    permissions: parsePermissions(root.permissions),
  });
}

// ---------------------------------------------------------------------------
// Resolution + enforcement seam
// ---------------------------------------------------------------------------

export type EffectiveConfig = Readonly<{
  /** All declared environments (from the winning layers). */
  environments: readonly MendpointEnvironment[];
  /** The environment selected for this resolution, if any. */
  selectedEnvironment: MendpointEnvironment | null;
  /** Coding-standard refs that must reach the agent context. */
  codingStandards: readonly MendpointCodingStandard[];
  /** Resolved workflow allow-lists / draft-only floor. */
  workflows: MendpointWorkflows;
  /** Fully-merged effective PolicyConfig — safe to pass to `evaluatePolicy`. */
  policy: PolicyConfig;
  /** Resolved review-tier escalation policy — pass to `classifyReviewTier`. */
  reviewTierPolicy: ReviewTierPolicy;
  /** Per-role permission narrowing; roles absent keep full RBAC. */
  roleRestrictions: Readonly<Record<string, MendpointRolePermissions>>;
  /** `default` when no config narrowed anything; `resolved` otherwise. */
  source: "default" | "resolved";
}>;

function stricterConfidence(base: Confidence, over: Confidence): Confidence {
  return CONFIDENCE_RANK[over] >= CONFIDENCE_RANK[base] ? over : base;
}

/** Combine two review-tier policies into the STRICTER of each axis (narrow-only). */
function stricterReviewTier(base: ReviewTierPolicy, over: ReviewTierPolicy): ReviewTierPolicy {
  if (!over.enabled) return base;
  if (!base.enabled) return over;
  const combineBand = (a: ReviewTierBand, b: ReviewTierBand): ReviewTierBand => ({
    risks: [...new Set([...a.risks, ...b.risks])] as readonly ("low" | "medium" | "high")[],
    // Higher minConfidence escalates more candidates; smaller maxChangedFiles too.
    minConfidence: Math.max(a.minConfidence, b.minConfidence),
    maxChangedFiles: Math.min(a.maxChangedFiles, b.maxChangedFiles),
  });
  return resolveReviewTierPolicy({
    enabled: true,
    escalate: combineBand(base.escalate, over.escalate),
    block: combineBand(base.block, over.block),
  });
}

/**
 * Apply one config layer's escalation/paths ON TOP OF an accumulated PolicyConfig
 * and ReviewTierPolicy, narrowing only. Never widens: booleans OR upward,
 * confidence takes the max, protected paths union, and auto-merge is untouched
 * (config cannot express it).
 */
function narrowInto(
  policy: PolicyConfig,
  reviewTier: ReviewTierPolicy,
  layer: MendpointConfig,
): { policy: PolicyConfig; reviewTier: ReviewTierPolicy } {
  const neverTouchPaths = [...new Set([...policy.neverTouchPaths, ...layer.protectedPaths])];
  return {
    policy: mergePolicy({
      ...policy,
      // autoMergeLowRisk is intentionally NOT read from config: it stays at the
      // accumulated baseline (false by default) and can never be widened here.
      neverTouchPaths,
      requireTwoReviewersForAuth: policy.requireTwoReviewersForAuth || layer.escalation.requireTwoReviewersForAuth,
      notificationsOnly: policy.notificationsOnly || layer.escalation.notificationsOnly,
      minConfidenceForEdit: stricterConfidence(policy.minConfidenceForEdit, layer.escalation.minConfidence),
    }),
    reviewTier: layer.escalation.reviewTier ? stricterReviewTier(reviewTier, layer.escalation.reviewTier) : reviewTier,
  };
}

/**
 * Resolve the effective config for a run: layer repo config OVER tenant defaults
 * OVER the platform defaults, narrowing only. With neither config present the
 * result is byte-identical to today's platform defaults.
 *
 * Precedence (lowest → highest): platform defaults → tenantDefaults → fileConfig.
 * A higher layer may only narrow further; it can never re-widen a lower layer.
 */
export function resolveEffectiveConfig(input: {
  fileConfig?: MendpointConfig | null;
  tenantDefaults?: MendpointConfig | null;
  /** Select an environment by name to apply its protection. */
  environment?: string;
}): EffectiveConfig {
  const layers = [input.tenantDefaults, input.fileConfig].filter((layer): layer is MendpointConfig => Boolean(layer));

  let policy = mergePolicy();
  let reviewTier = DEFAULT_REVIEW_TIER_POLICY;
  const environments: MendpointEnvironment[] = [];
  const codingStandards: MendpointCodingStandard[] = [];
  const roleRestrictions: Record<string, MendpointRolePermissions> = {};
  let workflows: MendpointWorkflows = { allowedRecipes: null, allowedAgents: null, branchTargets: null, draftOnly: true };

  for (const layer of layers) {
    const narrowed = narrowInto(policy, reviewTier, layer);
    policy = narrowed.policy;
    reviewTier = narrowed.reviewTier;
    for (const env of layer.environments) {
      const at = environments.findIndex((existing) => existing.name === env.name);
      if (at >= 0) environments[at] = env;
      else environments.push(env);
    }
    for (const std of layer.codingStandards) {
      const at = codingStandards.findIndex((existing) => existing.id === std.id);
      if (at >= 0) codingStandards[at] = std;
      else codingStandards.push(std);
    }
    // Workflow allow-lists narrow: a higher layer replaces a lower one, and any
    // declared list is stricter than `null` (no restriction). draftOnly floor holds.
    workflows = {
      allowedRecipes: layer.workflows.allowedRecipes ?? workflows.allowedRecipes,
      allowedAgents: layer.workflows.allowedAgents ?? workflows.allowedAgents,
      branchTargets: layer.workflows.branchTargets ?? workflows.branchTargets,
      draftOnly: true,
    };
    // Role restrictions intersect: a higher layer can only further narrow the set
    // a lower layer already restricted to.
    for (const [role, perms] of Object.entries(layer.permissions.roles)) {
      const prior = roleRestrictions[role];
      roleRestrictions[role] = prior
        ? {
            trigger: perms.trigger.filter((perm) => prior.trigger.includes(perm)),
            approve: perms.approve.filter((perm) => prior.approve.includes(perm)),
          }
        : perms;
    }
  }

  let selectedEnvironment: MendpointEnvironment | null = null;
  if (input.environment !== undefined) {
    selectedEnvironment = environments.find((env) => env.name === input.environment) ?? null;
    // A protected environment forces two-reviewer escalation (narrow-only).
    if (selectedEnvironment?.protected) {
      policy = mergePolicy({ ...policy, requireTwoReviewersForAuth: true });
    }
  }

  return deepFreeze({
    environments,
    selectedEnvironment,
    codingStandards,
    workflows,
    policy,
    reviewTierPolicy: reviewTier,
    roleRestrictions,
    source: layers.length === 0 && selectedEnvironment === null ? "default" : "resolved",
  });
}

/**
 * The minimal policy override diff for adoption at the existing enforcement seam
 * (the pipeline's `policyOverrides` fed to `evaluatePolicy`). Returns only the
 * keys that DIFFER from the platform default, so with no config it returns `{}`
 * and behavior stays byte-identical. Never emits `autoMergeLowRisk`.
 */
export function effectivePolicyOverrides(effective: EffectiveConfig): Partial<PolicyConfig> {
  const overrides: Partial<PolicyConfig> = {};
  if (effective.policy.requireTwoReviewersForAuth !== DEFAULT_POLICY.requireTwoReviewersForAuth) {
    overrides.requireTwoReviewersForAuth = effective.policy.requireTwoReviewersForAuth;
  }
  if (effective.policy.notificationsOnly !== DEFAULT_POLICY.notificationsOnly) {
    overrides.notificationsOnly = effective.policy.notificationsOnly;
  }
  if (effective.policy.minConfidenceForEdit !== DEFAULT_POLICY.minConfidenceForEdit) {
    overrides.minConfidenceForEdit = effective.policy.minConfidenceForEdit;
  }
  const extraPaths = effective.policy.neverTouchPaths.filter((path) => !DEFAULT_POLICY.neverTouchPaths.includes(path));
  if (extraPaths.length > 0) {
    overrides.neverTouchPaths = [...DEFAULT_POLICY.neverTouchPaths, ...extraPaths];
  }
  return overrides;
}

/**
 * The permissions a role may actually use after config narrowing. If the config
 * did not restrict the role, returns the full platform RBAC grants for it. The
 * result is always a SUBSET of `permissionsFor(role)` — config can never widen.
 */
export function permittedRolePermissions(
  effective: EffectiveConfig,
  role: Role,
): MendpointRolePermissions {
  const grants = permissionsFor(role);
  const restriction = effective.roleRestrictions[role];
  if (!restriction) return { trigger: grants, approve: grants };
  return {
    trigger: restriction.trigger.filter((perm) => grants.includes(perm)),
    approve: restriction.approve.filter((perm) => grants.includes(perm)),
  };
}

/**
 * Whether `role` may perform `action` (`trigger`/`approve`) with `perm` under the
 * effective config. Always false when RBAC itself does not grant `perm` to `role`.
 */
export function roleMayUse(
  effective: EffectiveConfig,
  role: Role,
  action: "trigger" | "approve",
  perm: Permission,
): boolean {
  return permittedRolePermissions(effective, role)[action].includes(perm);
}

/**
 * The coding-standard refs that must be injected into the agent/planner context,
 * so the agent preserves the customer's conventions. Reaches the agent context as
 * `"<id>:<ref>"` tags.
 */
export function codingStandardContext(effective: EffectiveConfig): string[] {
  return effective.codingStandards.map((standard) => `${standard.id}:${standard.ref}`);
}

/** Whether a recipe id is allowed to run under the effective workflow config. */
export function isRecipeAllowed(effective: EffectiveConfig, recipeId: string): boolean {
  return effective.workflows.allowedRecipes === null || effective.workflows.allowedRecipes.includes(recipeId);
}

/** Whether an agent name is allowed to act under the effective workflow config. */
export function isAgentAllowed(effective: EffectiveConfig, agent: string): boolean {
  return effective.workflows.allowedAgents === null || effective.workflows.allowedAgents.includes(agent);
}
