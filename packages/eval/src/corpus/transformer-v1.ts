import {
  MIGRATION_COMPATIBILITY_RULES,
  type MigrationChangeKind,
  type MigrationSeverity,
} from "@mendpoint/transformer";
import type {
  CapabilityTier,
  TransformerBehaviorCase,
  TransformerBehaviorScenario,
  TransformerCapabilityCase,
  TransformerCompatibilityCase,
} from "./types.js";

type CompatibilityExpectation = readonly [
  kind: MigrationChangeKind,
  tier: CapabilityTier,
  severity: MigrationSeverity,
  critical?: boolean,
];

const COMPATIBILITY_EXPECTATIONS: readonly CompatibilityExpectation[] = [
  ["rest_add_optional_request_field", "common", "additive"],
  ["rest_add_response_field", "common", "dangerous"],
  ["rest_remove_field", "common", "breaking"],
  ["rest_rename_field", "common", "breaking"],
  ["rest_add_required_request_field", "common", "breaking"],
  ["rest_change_field_type", "common", "breaking"],
  ["rest_change_default", "edge", "breaking"],
  ["rest_reduce_pagination_default", "edge", "breaking"],
  ["rest_add_response_enum_value", "edge", "dangerous"],
  ["rest_change_auth_requirement", "edge", "breaking", true],
  ["graphql_add_field", "common", "additive"],
  ["graphql_remove_field", "common", "breaking"],
  ["graphql_add_enum_value", "edge", "dangerous"],
  ["graphql_add_interface_implementation", "edge", "dangerous"],
  ["graphql_nullable_to_non_null", "common", "breaking"],
  ["protobuf_add_optional_field", "common", "additive"],
  ["protobuf_change_field_number", "edge", "breaking", true],
  ["protobuf_move_definition_file", "edge", "breaking"],
  ["protobuf_change_field_type", "edge", "breaking", true],
  ["database_add_nullable_column", "common", "additive"],
  ["database_add_not_null_constraint", "common", "dangerous"],
  ["database_rename_column", "common", "breaking"],
  ["database_change_column_type", "edge", "breaking", true],
  ["dependency_major_upgrade", "common", "breaking"],
  ["runtime_major_upgrade", "common", "breaking"],
  ["kubernetes_remove_api_version", "edge", "breaking", true],
  ["kubernetes_advance_storage_version", "edge", "dangerous", true],
  ["terraform_change_state_schema", "edge", "dangerous", true],
  ["webhook_remove_payload_field", "edge", "breaking"],
  ["webhook_change_signature_scheme", "edge", "breaking", true],
  ["oauth_remove_insecure_flow", "edge", "security_required", true],
  ["oauth_expand_scope", "adversarial", "security_required", true],
] as const;

const compatibilityCases: TransformerCompatibilityCase[] = COMPATIBILITY_EXPECTATIONS.map(
  ([changeKind, tier, severity, critical = false]) => {
    const rule = MIGRATION_COMPATIBILITY_RULES.find((candidate) => candidate.kind === changeKind);
    if (!rule) throw new Error(`Missing Transformer compatibility rule: ${changeKind}`);
    return {
      id: `transformer.compatibility.${changeKind}`,
      corpusVersion: "2026-08-01.v1",
      product: "transformer",
      tier,
      category: "compatibility",
      operation: "plan",
      critical,
      sourceRefs: [rule.sourceRef],
      input: { changeKind },
      expected: { severity },
    };
  },
);

const BEHAVIOR_EXPECTATIONS: readonly [
  scenario: TransformerBehaviorScenario,
  tier: CapabilityTier,
  category: "graph" | "differential",
  critical?: boolean,
][] = [
  ["linear_dag", "common", "graph"],
  ["diamond_dag", "common", "graph"],
  ["duplicate_id", "adversarial", "graph", true],
  ["unknown_dependency", "adversarial", "graph", true],
  ["self_dependency", "adversarial", "graph", true],
  ["cycle", "adversarial", "graph", true],
  ["empty_dag", "edge", "graph", true],
  ["same_repo_serialized", "edge", "graph", true],
  ["stable_replan", "recovery", "graph", true],
  ["complete_coverage", "recovery", "graph", true],
  ["object_key_order", "common", "differential"],
  ["missing_vs_null", "edge", "differential", true],
  ["array_order", "edge", "differential"],
  ["nan_vs_null", "edge", "differential", true],
  ["cyclic_output", "adversarial", "differential", true],
] as const;

const behaviorCases: TransformerBehaviorCase[] = BEHAVIOR_EXPECTATIONS.map(
  ([scenario, tier, category, critical = false]) => ({
    id: `transformer.${category}.${scenario}`,
    corpusVersion: "2026-08-01.v1",
    product: "transformer",
    tier,
    category,
    operation: category === "graph" ? "plan" : "diff",
    critical,
    sourceRefs: category === "graph"
      ? ["https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches"]
      : ["https://google.aip.dev/180"],
    input: { scenario },
    expected: { pass: true },
  }),
);

export const TRANSFORMER_CAPABILITY_CASES: readonly TransformerCapabilityCase[] = [
  ...compatibilityCases,
  ...behaviorCases,
];
