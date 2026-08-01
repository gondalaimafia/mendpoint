export type CapabilityProduct = "warden" | "transformer";
export type CapabilityTier = "common" | "edge" | "adversarial" | "recovery";
export type CapabilityOperation = "diagnose" | "repair" | "plan" | "diff" | "safe_handoff";

export type CapabilityCaseBase = {
  id: string;
  corpusVersion: "2026-08-01.v1";
  product: CapabilityProduct;
  tier: CapabilityTier;
  category: string;
  operation: CapabilityOperation;
  critical: boolean;
  sourceRefs: string[];
};

export type WardenCapabilityCase = CapabilityCaseBase & {
  product: "warden";
  input: { goal: string; errorLog?: string };
  expected: { modeId: string; clientFixable: boolean };
};

export type TransformerCompatibilityCase = CapabilityCaseBase & {
  product: "transformer";
  operation: "plan";
  input: { changeKind: string };
  expected: { severity: "additive" | "dangerous" | "breaking" | "security_required" };
};

export type TransformerBehaviorScenario =
  | "linear_dag"
  | "diamond_dag"
  | "duplicate_id"
  | "unknown_dependency"
  | "self_dependency"
  | "cycle"
  | "empty_dag"
  | "same_repo_serialized"
  | "stable_replan"
  | "complete_coverage"
  | "object_key_order"
  | "missing_vs_null"
  | "array_order"
  | "nan_vs_null"
  | "cyclic_output";

export type TransformerBehaviorCase = CapabilityCaseBase & {
  product: "transformer";
  operation: "plan" | "diff";
  input: { scenario: TransformerBehaviorScenario };
  expected: { pass: true };
};

export type TransformerCapabilityCase =
  | TransformerCompatibilityCase
  | TransformerBehaviorCase;
