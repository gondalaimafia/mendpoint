# Agent configuration-as-code (`mendpoint.yaml`)

Define agent roles, permissions, environments, coding standards, workflows, and
escalation rules for your repositories by committing a config file. No support
ticket required. The file is parsed and strictly validated, then resolved into
the settings that govern a run.

- **File name:** `mendpoint.yaml` (or `.mendpoint/config.yaml`), or `mendpoint.json`.
- **Parser:** `parseMendpointConfig` (strict, fail-closed).
- **Resolver:** `resolveEffectiveConfig` (layers repo config over tenant defaults).
- **Schema version:** `1` (`version: 1` is required).

Everything lives in `@mendpoint/transformer` (`packages/transformer/src/agent-config.ts`).

## The narrow-only invariant

**Config may only NARROW the platform's safety guarantees, never widen them.**

It can require MORE approvals or protect MORE paths, but it can never:

- enable auto-merge,
- bypass human review or draft-only delivery,
- unprotect a path the platform (or a lower layer) already protects, or
- grant a role a permission the platform RBAC does not already give it.

This is enforced in code, not by convention:

| Dimension | How narrowing is enforced |
| --- | --- |
| Auto-merge | The schema has **no** auto-merge field. `escalation.autoMergeLowRisk`/`autoMerge` are rejected as unknown keys, and `effectivePolicyOverrides` never emits `autoMergeLowRisk`. It stays at the platform default (`false`). |
| Draft-only review | `workflows.draftOnly: false` is rejected (`mendpoint_config_draft_only_widen`). Every candidate stays a reviewable draft. |
| Protected paths | `protectedPaths` are **unioned** with the platform denylist and lower layers. Removal cannot be expressed. |
| `minConfidence` | Layers take the **stricter** (max of `low < medium < high`). A laxer value is clamped up, never applied. |
| `requireTwoReviewersForAuth` / `notificationsOnly` | OR-combined across layers. A `true` can never be lowered to `false`. |
| Review-tier bands | Combined into the **stricter** of each axis (higher `minConfidence`, lower `maxChangedFiles`, union of `risks`), then validated monotonic. Tiering only ever raises the required sign-off above the mandatory single-approval floor. |
| RBAC per role | Each granted permission must be in `permissionsFor(role)`; anything else is rejected (`mendpoint_config_permission_widen`). Effective permissions are the **intersection** with RBAC. Roles not mentioned keep their full RBAC grants. |

With **no config present**, the resolved effective config is byte-identical to
today's platform defaults (empty policy overrides, the disabled review-tier
policy, full RBAC). Behavior is unchanged.

## Precedence

Lowest → highest: **platform defaults → tenant defaults → repo `mendpoint.yaml`**.

A higher layer may only narrow further; it can never re-widen a lower layer.
`resolveEffectiveConfig({ tenantDefaults, fileConfig, environment })` applies the
layers in order. Selecting a `protected` environment forces two-reviewer
escalation on top.

## Complete example

```yaml
version: 1

# Environments scope branches; a protected environment forces two-reviewer
# escalation on every run that targets it.
environments:
  - name: staging
    branches: ["staging", "release/*"]
  - name: production
    branches: ["main"]
    protected: true

# Coding standards the agent must preserve. Each ref is a repo-relative path or a
# knowledge-doc id; the refs reach the agent/planner context.
codingStandards:
  - id: api-style-guide
    ref: fixtures/knowledge/api-style-guide.md
  - id: migration-playbook
    ref: fixtures/knowledge/migration-playbook.md

# Which recipes/agents may run, where they may land, and the draft-only floor.
workflows:
  allowedRecipes: ["node-runtime-20-to-22"]
  allowedAgents: ["transformer"]
  branchTargets: ["main", "staging"]
  draftOnly: true            # may be omitted; may NOT be set to false

# Extra paths the agent must never edit (unioned with the platform denylist).
protectedPaths:
  - "migrations/"
  - "billing/"

# Escalation raises the required sign-off; it never lowers it.
escalation:
  requireTwoReviewersForAuth: true
  minConfidence: high        # low | medium | high (only ever raised)
  notificationsOnly: false
  reviewTier:
    enabled: true
    escalate: { risks: ["high"], minConfidence: 60, maxChangedFiles: 20 }
    block:    { risks: [], minConfidence: 25, maxChangedFiles: 50 }

# Per-role permission narrowing. Each permission must already be granted to the
# role by the platform RBAC; config only ever narrows. Roles omitted here keep
# their full RBAC grants.
permissions:
  roles:
    engineer:
      trigger: ["plan:execute"]
      approve: ["plan:edit"]
    viewer:
      trigger: []
      approve: []
```

The JSON form (`mendpoint.json`) is identical in shape and is parsed with
`parseMendpointConfig(text, { format: "json" })`.

## Enforcement seam

`resolveEffectiveConfig` returns an `EffectiveConfig` whose fields plug directly
into the existing enforcement primitives — adoption is a drop-in, and with no
config the values equal today's defaults:

- `effectivePolicyOverrides(effective)` → `Partial<PolicyConfig>` for the
  pipeline's `evaluatePolicy(draft, findings, { policy })` call. Emits only the
  keys that differ from the default; never emits `autoMergeLowRisk`.
- `effective.reviewTierPolicy` → the worker's `classifyReviewTier(input, policy)`.
- `permittedRolePermissions(effective, role)` / `roleMayUse(...)` → narrow the
  RBAC `permissionsFor(role)` set at trigger/approve gates.
- `codingStandardContext(effective)` → `"<id>:<ref>"` tags injected into the
  agent/planner context.
- `isRecipeAllowed(effective, id)` / `isAgentAllowed(effective, name)` → workflow
  allow-list gates.

## Actionable error messages

The parser fails closed. Every failure throws a `MendpointConfigError` carrying
`code`, `path` (where), a problem description (what), and `hint` (how to fix).
The `message` is `"<path>: <problem> — <hint>"` and is safe to surface directly.

Examples:

| Situation | `code` | Message |
| --- | --- | --- |
| Missing version | `mendpoint_config_version_required` | `version: missing required field 'version' — set version: 1` |
| Unsupported version | `mendpoint_config_version_unsupported` | `version: unsupported schema version 2 — this build understands version 1 — set version: 1` |
| Unknown field | `mendpoint_config_unknown_key` | `autoMerge: unknown field 'autoMerge' — remove it — allowed fields here are: version, environments, ...` |
| Wrong type | `mendpoint_config_array_required` | `protectedPaths: expected a list of strings — provide a YAML/JSON array of text values` |
| Bad confidence | `mendpoint_config_min_confidence_invalid` | `escalation.minConfidence: unknown confidence 'extreme' — use one of: low, medium, high` |
| Disabling draft-only | `mendpoint_config_draft_only_widen` | `workflows.draftOnly: draft-only review cannot be disabled by config — remove the field or set it to true ...` |
| Widening RBAC | `mendpoint_config_permission_widen` | `permissions.roles.viewer.trigger[0]: role 'viewer' cannot be granted 'pr:write' — config can only narrow RBAC — remove it ...` |
| Unknown role | `mendpoint_config_role_unknown` | `permissions.roles.superuser: unknown role 'superuser' — use a role defined in the platform RBAC model ...` |
| Non-monotonic tier | `mendpoint_config_review_tier_invalid` | `escalation.reviewTier: invalid review-tier bands (...) — the block band must be at least as strict as the escalate band ...` |
| Malformed YAML/JSON | `mendpoint_config_syntax_invalid` | `mendpoint.yaml: could not parse YAML (...) — fix the syntax so the file parses as a mapping/object` |
