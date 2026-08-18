/**
 * Phase 9 — the real failures in the repository today, expressed as classifier
 * inputs. These are not hypotheticals: each carries a `FAILURES.md` id and the
 * diagnosis recorded in OWN_VS_RENT.md §T4/§T7/§T12. The test file asserts where
 * each one routes, so the policy is exercised against the actual backlog.
 *
 * References (read-only, by id — we do not import the regression/graders schema):
 *   - recall 79.3% parser defects  → evals/reports/latest.md:27-28,62-70;
 *     evals/FAILURES.md FAIL-010..015 (FALSE_NEGATIVE, per-language 0% recall,
 *     systematically missed JSON fixtures). OWN_VS_RENT §T4: "the measured
 *     failures are not reasoning failures … indexer and language-support gaps."
 *   - vendored false positives      → evals/FAILURES.md FAIL-001/002
 *     (gen-fettler-genvendor-*, FALSE_POSITIVE, vendor/provider-sdk flagged).
 *     OWN_VS_RENT §T7: "a deterministic bug to fix, not intelligence to own."
 *   - internal-API / residual gaps  → evals/FAILURES.md FAIL-019 (COVERAGE_GAP,
 *     regauge-internal-api-rename) and FAIL-003..007 (ABSTENTION_FAILURE,
 *     residual refusal). OWN_VS_RENT §T12: "Fix deterministically; spec §17.4
 *     forbids training around it."
 */
import type { ValidatedFailure } from "./classify.js";

/**
 * The recall-79.3% class. Diagnosed to parser / language-support / dependency
 * gaps — a deterministic defect, explicitly NOT a model limit. Modelled as the
 * symptom (FALSE_NEGATIVE) it is recorded as, plus the diagnosis and the
 * deterministic-defect signal, so the classifier must route it away from training.
 */
export const RECALL_79_PARSER_DEFECT: ValidatedFailure = {
  id: "FAIL-010",
  category: "FALSE_NEGATIVE",
  severity: "P2",
  product: "fettler",
  evidence: {
    diagnosedCause: "LANGUAGE_SUPPORT_FAILURE",
    deterministicDefectSuspected: true,
    refs: [
      "evals/reports/latest.md:27-28 (recall 79.3% < 85% gate)",
      "evals/reports/latest.md:62-70 (per-language 0% recall)",
      "evals/FAILURES.md#FAIL-010 (fettler-python-billing-rename, missed *.json fixtures)",
    ],
  },
};

/**
 * The same class BEFORE anyone has diagnosed it: a raw FALSE_NEGATIVE with no
 * deeper cause. The classifier must refuse to guess (return unknown), not label
 * it MODEL_LIMIT. This is the trap the phase exists to prevent.
 */
export const RECALL_79_UNDIAGNOSED: ValidatedFailure = {
  id: "FAIL-011",
  category: "FALSE_NEGATIVE",
  severity: "P2",
  product: "fettler",
  evidence: {
    refs: ["evals/FAILURES.md#FAIL-011 (fettler-go-ledger-rename)"],
  },
};

/** Vendored false positive: deterministic restraint bug, not intelligence to own. */
export const VENDORED_FALSE_POSITIVE: ValidatedFailure = {
  id: "FAIL-001",
  category: "FALSE_POSITIVE",
  severity: "P0",
  product: "fettler",
  evidence: {
    diagnosedCause: "ABSTENTION_FAILURE",
    deterministicDefectSuspected: true,
    refs: [
      "evals/FAILURES.md#FAIL-001 (gen-fettler-genvendor-vendored-only)",
      "vendor/provider-sdk/index.ts flagged as a distractor",
    ],
  },
};

/** The two open internal-API residual gaps: no recipe covers the family yet. */
export const INTERNAL_API_COVERAGE_GAP: ValidatedFailure = {
  id: "FAIL-019",
  category: "COVERAGE_GAP",
  severity: "P1",
  product: "regauge",
  evidence: {
    refs: [
      "evals/FAILURES.md#FAIL-019 (regauge-internal-api-rename, family 'internal-api-rename')",
    ],
  },
};

/** Residual refusal: a deterministic fail-closed completeness check to fix. */
export const RESIDUAL_REFUSAL_GAP: ValidatedFailure = {
  id: "FAIL-003",
  category: "ABSTENTION_FAILURE",
  severity: "P0",
  product: "regauge",
  evidence: {
    refs: [
      "evals/FAILURES.md#FAIL-003 (gen-regauge-aws-residual, status=applicable; residualPaths=none)",
    ],
  },
};

/**
 * A genuinely model-limited failure with trustworthy reward, stable eval, and no
 * deterministic-defect signal, and no capable alternative model to route to.
 * This is the case the policy DOES allow to reach training — the contrast that
 * proves the guard is discriminating, not blanket.
 */
export const GENUINE_MODEL_LIMIT: ValidatedFailure = {
  id: "reg-model-limit-demo",
  category: "MODEL_CAPABILITY_FAILURE",
  severity: "P2",
  evidence: {
    deterministicDefectSuspected: false,
    alternativeModelAvailable: false,
    training: {
      evalStable: true,
      rewardTrustworthy: true,
      notADeterministicDefect: true,
      governedDataSufficient: true,
    },
    refs: ["synthetic capability probe with a stable holdout and mechanical labels"],
  },
};

/** Every real-repo failure fixture, for iteration in tests and tooling. */
export const REAL_FAILURES: readonly ValidatedFailure[] = [
  RECALL_79_PARSER_DEFECT,
  RECALL_79_UNDIAGNOSED,
  VENDORED_FALSE_POSITIVE,
  INTERNAL_API_COVERAGE_GAP,
  RESIDUAL_REFUSAL_GAP,
];
