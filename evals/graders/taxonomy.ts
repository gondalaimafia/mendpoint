/**
 * Phase 6 — Gap taxonomy.
 *
 * Every failure the suite records is classified into exactly one category so
 * failures can be aggregated, prioritized, and traced back to a subsystem. The
 * list is the spec's taxonomy, expressed as a typed enum, plus a documented
 * mapping from a grader outcome to a category.
 *
 * The categories are deliberately about ROOT CAUSE LOCATION, not symptom.
 * FALSE_POSITIVE / FALSE_NEGATIVE are kept as their own categories because a
 * report reader wants the raw precision/recall failure surfaced directly, but a
 * diagnosis pass is expected to reclassify them into the deeper cause (e.g. a
 * false negative on Python is usually LANGUAGE_SUPPORT_FAILURE).
 */

export const FAILURE_CATEGORIES = [
  "PARSING_FAILURE",
  "LANGUAGE_SUPPORT_FAILURE",
  "REPOSITORY_MAPPING_FAILURE",
  "ARCHITECTURE_INFERENCE_FAILURE",
  "GRAPH_CONSTRUCTION_FAILURE",
  "DEPENDENCY_DISCOVERY_FAILURE",
  "RETRIEVAL_FAILURE",
  "CONTEXT_SELECTION_FAILURE",
  "PROMPT_FAILURE",
  "REASONING_FAILURE",
  "TOOL_SELECTION_FAILURE",
  "TOOL_EXECUTION_FAILURE",
  "MODEL_ROUTING_FAILURE",
  "MODEL_CAPABILITY_FAILURE",
  "CONFIDENCE_CALIBRATION_FAILURE",
  "ROOT_CAUSE_FAILURE",
  "BLAST_RADIUS_FAILURE",
  "REMEDIATION_FAILURE",
  "PATCH_FAILURE",
  "TEST_GENERATION_FAILURE",
  "FALSE_POSITIVE",
  "FALSE_NEGATIVE",
  "UX_PRESENTATION_FAILURE",
  "PERFORMANCE_FAILURE",
  "COST_FAILURE",
  // Extensions beyond the spec's starter list, added because the corpus
  // surfaced outcomes the starter list did not name cleanly.
  "ABSTENTION_FAILURE", // failed to abstain (acted) or abstained when it should act
  "SCALE_FAILURE", // aborted / truncated / degraded on large repositories
  "ROBUSTNESS_FAILURE", // crashed or corrupted on binary / non-UTF-8 / symlink input
  "COVERAGE_GAP", // no shipped capability covers the family (not a defect, a gap)
  "HARNESS_LIMITATION", // the eval harness cannot yet observe this dimension
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** Severity ladder from the spec's prioritization section. */
export type Severity = "P0" | "P1" | "P2" | "P3" | "P4";

/**
 * The abstract outcomes a deterministic grader can emit. The runner maps a
 * grader result to a (category, severity) pair using {@link classifyOutcome}.
 */
export type GraderOutcome =
  | "missed_all_findings" // recall 0 where findings were expected
  | "missed_some_findings" // partial recall
  | "flagged_trap" // touched an explicit false-positive trap
  | "flagged_extra" // flagged files that are neither expected nor traps
  | "acted_when_should_abstain" // produced an edit/confident finding on an abstain/no_op scenario
  | "abstained_when_should_act" // produced nothing where action was required
  | "scan_aborted" // scanner failed to complete (cap/abort)
  | "scan_crashed" // scanner threw / corrupted input
  | "no_shipped_capability" // coverage gap: nothing matches the family
  | "dimension_unobservable"; // harness cannot measure the graded dimension

/** Documented mapping: grader outcome -> failure category + default severity. */
export function classifyOutcome(outcome: GraderOutcome): {
  category: FailureCategory;
  severity: Severity;
  rationale: string;
} {
  switch (outcome) {
    case "missed_all_findings":
      return {
        category: "FALSE_NEGATIVE",
        severity: "P1",
        rationale:
          "Recall 0 where impacted files exist — the primary value proposition (finding what breaks) failed. Diagnose to a deeper cause (often LANGUAGE_SUPPORT_FAILURE or DEPENDENCY_DISCOVERY_FAILURE).",
      };
    case "missed_some_findings":
      return {
        category: "FALSE_NEGATIVE",
        severity: "P2",
        rationale:
          "Partial recall — some impacted sites found, others missed. Usually GRAPH_CONSTRUCTION_FAILURE or CONTEXT_SELECTION_FAILURE on the missed hops.",
      };
    case "flagged_trap":
      return {
        category: "FALSE_POSITIVE",
        severity: "P0",
        rationale:
          "Touched a deliberate distractor (unrelated same-spelling field, vendored/generated code). Corrupting unrelated code is materially incorrect advice.",
      };
    case "flagged_extra":
      return {
        category: "FALSE_POSITIVE",
        severity: "P2",
        rationale:
          "Flagged files outside the expected+acceptable set. Reduces trust; diagnose to CONFIDENCE_CALIBRATION_FAILURE or REASONING_FAILURE.",
      };
    case "acted_when_should_abstain":
      return {
        category: "ABSTENTION_FAILURE",
        severity: "P0",
        rationale:
          "Produced a confident finding/edit on an ambiguous, already-migrated, or unsafe-to-automate repo. This is the most dangerous class: confidently-wrong advice.",
      };
    case "abstained_when_should_act":
      return {
        category: "ABSTENTION_FAILURE",
        severity: "P1",
        rationale:
          "Produced nothing where a clear migration was required. Misses the value proposition; distinct from a coverage gap because a capability exists.",
      };
    case "scan_aborted":
      return {
        category: "SCALE_FAILURE",
        severity: "P1",
        rationale:
          "Scanner hit a cap or aborted before completing the walk. Large-repo degradation is a product gap.",
      };
    case "scan_crashed":
      return {
        category: "ROBUSTNESS_FAILURE",
        severity: "P1",
        rationale:
          "Scanner threw or corrupted input (binary, non-UTF-8, symlink). Must degrade gracefully, never crash or corrupt.",
      };
    case "no_shipped_capability":
      return {
        category: "COVERAGE_GAP",
        severity: "P1",
        rationale:
          "No shipped recipe/analyzer covers the migration family. Correct shipped behavior is abstention-by-absence; the gap is the finding, not a defect.",
      };
    case "dimension_unobservable":
      return {
        category: "HARNESS_LIMITATION",
        severity: "P3",
        rationale:
          "The graded dimension (e.g. verification honesty, token cost, model routing) is not exposed by the path the runner exercises. Recorded honestly rather than fabricated.",
      };
  }
}
