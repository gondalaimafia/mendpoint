/**
 * Failure -> eval: the machine-readable record of a validated failure.
 *
 * A `RegressionCase` is the durable, reviewable artifact that sits between a
 * diagnosed failure and a permanent regression scenario. It carries everything a
 * later reader needs to trust the case without re-running the original
 * investigation:
 *
 *   - provenance      WHERE the failure was validated (a report line, a run, a
 *                     commit) so the claim is auditable.
 *   - governance      the redaction/data-provenance certification that lets the
 *                     case enter a COMMITTED suite (see `governance.ts`). A
 *                     failure found on a real customer repo may not be committed
 *                     until it has been reduced to a synthetic reproduction that
 *                     provably carries no customer code, secrets, or PII.
 *   - reproduction    a deterministic `build()` that materializes the reproducing
 *                     repository IN MEMORY (never the shared corpus, never a
 *                     hand-copied answer key) plus the machine-readable ground
 *                     truth the real graders score against.
 *   - expectation     `status` records what the CURRENT shipped engine does with
 *                     the case at authoring time: `fixed` (the product now does
 *                     the safe thing — the case guards the fix from regressing) or
 *                     `open` (the product is still wrong — the case fails honestly
 *                     and flips green the day the fix lands). `status` is
 *                     documentation of intent; the grader, not this field, decides
 *                     pass/fail at run time.
 *
 * The record is deliberately NOT a training example: it holds labels and a repo
 * builder, never model reasoning. It is the same discipline `evals/datasets`
 * follows (a reference to the input, not raw model internals).
 */
import type { GroundTruth, Product } from "../ground-truth/schema.js";
import type { SyntheticRepo } from "../mutations/engine.js";

/** How the answer key is sourced, for the governance gate. */
export type DataProvenance =
  /** Authored/procedural synthetic content; no customer material at any point. */
  | "synthetic"
  /** Reduced from a real failure to a synthetic reproduction, then certified. */
  | "redacted-from-customer";

export interface RegressionProvenance {
  /**
   * Where the failure was validated, precise enough to audit. Examples:
   * `"oss-validation:VALIDATION-REPORT.md#5 (K7-vendored)"`,
   * `"readiness-run:evals/reports/readiness-scorecard.md"`.
   */
  source: string;
  /** Short commit the failure was validated against. */
  validatedAtCommit: string;
  /** ISO date the failure was validated. */
  validatedOn: string;
  /** One-line human description of the failure. */
  note: string;
}

export interface RegressionGovernance {
  /** Where the reproducing repo's content comes from. */
  dataProvenance: DataProvenance;
  /**
   * Certified free of customer code, secrets, and PII. A committed case MUST be
   * `true`; the governance gate refuses to admit a case that is not.
   */
  containsCustomerData: false;
  /**
   * For `redacted-from-customer`, a reference to the redaction record (who
   * reduced it and how it was verified clean). Absent for `synthetic`.
   */
  redactionRef?: string;
  /** Why this case is safe to commit and distribute. */
  rationale: string;
}

/** What the shipped engine does with the case at authoring time. */
export type RegressionStatus = "fixed" | "open";

/** The reproducible task plus its machine-readable answer key. */
export interface RegressionReproduction {
  /** The in-memory reproducing repository (files + optional spec pair). */
  repo: SyntheticRepo;
  /** Provider slug hint for the Fettler path (Fettler cases only). */
  slug?: string;
  /**
   * The answer key, minus the identity/provenance fields the builder fills in
   * (`scenario_id`, `dataset_split`, `tags`, `difficulty_rationale`). Everything
   * a grader keys on — `correct_behavior`, `expected_findings`,
   * `false_positive_traps`, `recipe_expectation` — is supplied here.
   */
  groundTruth: Omit<
    GroundTruth,
    "scenario_id" | "dataset_split" | "tags" | "difficulty_rationale"
  > & { difficulty_rationale?: string };
}

export interface RegressionCase {
  /** Stable id; becomes the scenario id (prefixed `reg-`). */
  id: string;
  /** The capability the failure belongs to (matches a readiness-gate name). */
  capability: string;
  product: Product;
  provenance: RegressionProvenance;
  governance: RegressionGovernance;
  status: RegressionStatus;
  /** For `fixed` cases, the change that fixed it (e.g. `"#174"`). */
  fixedBy?: string;
  /** Deterministically materialize the reproducing repo + answer key. */
  build: () => RegressionReproduction;
}

/**
 * Validate a case's static shape (not its data-provenance — that is the
 * governance gate's job). Returns problems; empty means well-formed.
 */
export function validateRegressionCase(c: RegressionCase): string[] {
  const problems: string[] = [];
  if (!c.id || !/^reg-[a-z0-9-]+$/.test(c.id)) {
    problems.push(`id must match /^reg-[a-z0-9-]+$/ (got '${c.id}')`);
  }
  if (c.product !== "fettler" && c.product !== "regauge") {
    problems.push(`product must be fettler|regauge (got '${c.product}')`);
  }
  if (!c.capability) problems.push("capability must be set");
  if (c.status !== "fixed" && c.status !== "open") {
    problems.push(`status must be fixed|open (got '${c.status}')`);
  }
  if (c.status === "fixed" && !c.fixedBy) {
    problems.push(`a 'fixed' case must record fixedBy (what fixed it)`);
  }
  for (const [k, v] of [
    ["provenance.source", c.provenance?.source],
    ["provenance.validatedAtCommit", c.provenance?.validatedAtCommit],
    ["provenance.validatedOn", c.provenance?.validatedOn],
    ["provenance.note", c.provenance?.note],
  ] as const) {
    if (typeof v !== "string" || !v.length) problems.push(`${k} must be a non-empty string`);
  }
  return problems;
}
