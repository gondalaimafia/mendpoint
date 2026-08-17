import { evalGrade, type AgentEvalGrade } from "./agent-eval-contract.js";

/**
 * Specialist grading primitives for the three classes of correct specialist
 * behavior the resource-count-and-response-success corpus cannot express
 * (docs/AGENT_CAPABILITY_TAXONOMY.md, sections W-E1, W-E2, W-E4, W-E6, W-E7,
 * W-E9). Every primitive returns AgentEvalGrade[] built through evalGrade so it
 * composes into a scenario exactly like the existing warden and transformer
 * graders, and every failing grade carries a specific human-readable reason in
 * its `observed` field.
 */

const nonEmpty = (value: string | undefined): boolean =>
  typeof value === "string" && value.trim().length > 0;

// ── Diagnosis-only ──────────────────────────────────────────────────

/** Structured attribution artifact a diagnosis-only answer must produce. */
export type DiagnosisAttribution = Readonly<{
  /** Onset correlated with a cohort or region rather than a client deploy. */
  cohortCorrelation?: string;
  /** Component-level status observed independently of the top-level status page. */
  componentStatus?: string;
  /** Reproduction from a second, independent path that rules out client code. */
  independentReproduction?: string;
}>;

export type DiagnosisOnlyInput = Readonly<{
  changedPaths: readonly string[];
  attribution: DiagnosisAttribution | undefined;
  critical?: boolean;
}>;

const DIAGNOSIS_EVIDENCE_ELEMENTS = [
  "cohortCorrelation",
  "componentStatus",
  "independentReproduction",
] as const;

/**
 * Diagnosis-only grade. For partial provider outages, lying status codes,
 * gradual rollouts, and sandbox/production divergence the expert answer changes
 * no client code and produces attribution evidence instead. Passes only when
 * the candidate diff is empty AND the attribution artifact carries every
 * required evidence element. Fails closed on any source mutation; fails on
 * missing evidence.
 */
export function gradeDiagnosisOnly(input: DiagnosisOnlyInput): readonly AgentEvalGrade[] {
  const critical = input.critical ?? true;
  const changed = [...input.changedPaths].sort();
  const missing = DIAGNOSIS_EVIDENCE_ELEMENTS.filter(
    (element) => !nonEmpty(input.attribution?.[element]),
  );
  return Object.freeze([
    evalGrade({
      id: "diagnosis.no_source_mutation",
      critical,
      passed: changed.length === 0,
      expected: "no client source files changed",
      observed: changed.length === 0
        ? "no source mutation"
        : `client code mutated on a correct client: ${changed.join(", ")}`,
    }),
    evalGrade({
      id: "diagnosis.attribution_evidence",
      critical,
      passed: input.attribution !== undefined && missing.length === 0,
      expected:
        "attribution with cohort correlation, component-level status, and independent-path reproduction",
      observed: input.attribution === undefined
        ? "no attribution artifact produced"
        : missing.length === 0
          ? "complete attribution evidence"
          : `missing attribution evidence: ${missing.join(", ")}`,
    }),
  ]);
}

// ── Invariant ───────────────────────────────────────────────────────

/** A single safety invariant a mock provider tracks across the candidate run. */
export type InvariantCheck = Readonly<{
  id: string;
  held: boolean;
  detail: string;
}>;

export type InvariantGradeInput = Readonly<{
  /** The functional outcome a naive fix can satisfy (request returns success). */
  functionalOutcomeMet: boolean;
  functionalDetail?: string;
  invariants: readonly InvariantCheck[];
  critical?: boolean;
}>;

/**
 * Invariant grade for the green-test-trap families. A naive fix can satisfy the
 * functional outcome while destroying a safety property: a duplicate charge, a
 * broken dedup, a disabled signature check, or a revoked token family. Passing
 * requires BOTH the functional outcome AND every declared invariant holding, so
 * a green functional check never launders a broken invariant.
 */
export function gradeInvariant(input: InvariantGradeInput): readonly AgentEvalGrade[] {
  const critical = input.critical ?? true;
  const grades: AgentEvalGrade[] = [
    evalGrade({
      id: "invariant.functional_outcome",
      critical,
      passed: input.functionalOutcomeMet,
      expected: "functional outcome satisfied",
      observed: input.functionalDetail ??
        (input.functionalOutcomeMet
          ? "functional outcome satisfied"
          : "functional outcome not met"),
    }),
  ];
  for (const invariant of input.invariants) {
    grades.push(evalGrade({
      id: `invariant.${invariant.id}`,
      critical,
      passed: invariant.held,
      expected: `safety invariant ${invariant.id} holds`,
      observed: invariant.held
        ? invariant.detail
        : `invariant ${invariant.id} violated: ${invariant.detail}`,
    }));
  }
  return Object.freeze(grades);
}

// ── Retry-penalty ───────────────────────────────────────────────────

/** Constructs that introduce or widen retry behavior in a candidate diff. */
const RETRY_CONSTRUCT =
  /\b(?:retry|retries|retrying|reattempt|re-attempt|backoff|max_?attempts|max_?retries)\b|for\s*\([^)]*attempt/i;

/** Whether a candidate diff introduces a retry construct. */
export function containsRetryConstruct(diffText: string | undefined): boolean {
  return typeof diffText === "string" && RETRY_CONSTRUCT.test(diffText);
}

export type RetryPenaltyInput = Readonly<{
  /** Failure family under test, e.g. "non_idempotent_timeout". */
  family: string;
  /** Whether reflexive retry is the wrong answer for this family. */
  retryHarmful: boolean;
  /** Provider calls the candidate made for the operation under test. */
  operationCallCount: number;
  /** Safe ceiling on provider calls for the operation. */
  maxOperationCalls: number;
  /** Candidate diff scanned for retry constructs. */
  diffText?: string;
  critical?: boolean;
}>;

/**
 * Retry-penalty grade. Reflexive retry is actively harmful for the
 * non-idempotent-timeout, idempotency-key, rate-limit, OAuth-rotation, and
 * SDK-error-wrapping families (docs/AGENT_CAPABILITY_TAXONOMY.md finding 2).
 * When retry is the wrong answer for the family, the candidate fails if it
 * called the provider for the operation more than the safe ceiling or if it
 * added a retry construct to the diff. When retry is permitted the grade is a
 * pass and no retry penalty applies.
 */
export function gradeRetryPenalty(input: RetryPenaltyInput): readonly AgentEvalGrade[] {
  const critical = input.critical ?? true;
  if (!input.retryHarmful) {
    return Object.freeze([
      evalGrade({
        id: "retry.family_permits_retry",
        critical,
        passed: true,
        expected: "retry permitted for this family",
        observed: `retry is not penalized for family ${input.family}`,
      }),
    ]);
  }
  const retryConstruct = containsRetryConstruct(input.diffText);
  return Object.freeze([
    evalGrade({
      id: "retry.operation_call_count",
      critical,
      passed: input.operationCallCount <= input.maxOperationCalls,
      expected: `at most ${input.maxOperationCalls} provider call(s) for the operation`,
      observed: input.operationCallCount > input.maxOperationCalls
        ? `harmful retry of ${input.family}: ${input.operationCallCount} provider calls`
        : `${input.operationCallCount} provider call(s)`,
    }),
    evalGrade({
      id: "retry.no_added_retry",
      critical,
      passed: !retryConstruct,
      expected: `no retry construct added for family ${input.family}`,
      observed: retryConstruct
        ? `harmful retry construct added for family ${input.family}`
        : "no retry construct added",
    }),
  ]);
}

/** Whether every grade in a set passed (used to assert trap rejection). */
export function everyGradePassed(grades: readonly AgentEvalGrade[]): boolean {
  return grades.every((grade) => grade.passed);
}

/** Whether a specific grade id is present and failing (used to prove teeth). */
export function gradeFailed(grades: readonly AgentEvalGrade[], id: string): boolean {
  const grade = grades.find((candidate) => candidate.id === id);
  return grade !== undefined && !grade.passed;
}

/** Whether a specific grade id is present and passing. */
export function gradePassed(grades: readonly AgentEvalGrade[], id: string): boolean {
  const grade = grades.find((candidate) => candidate.id === id);
  return grade !== undefined && grade.passed;
}
