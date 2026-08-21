/**
 * Stateless-versus-persistent context benchmark (spec v3 §11.21, §36.1;
 * docs/missions/CURRENT_STATE.md; docs/memory/MEMORY_PRECEDENCE.md).
 *
 * WHAT THIS MEASURES, AND WHAT IT DELIBERATELY DOES NOT.
 * -----------------------------------------------------
 * Two arms run over ONE fixed cohort of migration tasks. The task, the agent
 * model, and the grader are identical across arms. The ONLY thing that differs
 * is the context each arm inherits:
 *
 *   - Arm "stateless"  — sees only the immediate instruction and current files.
 *   - Arm "persistent" — additionally sees the compiled envelope: prior mission
 *     decisions, exceptions, reviewer corrections, verification results, and
 *     organization memory, expressed as KnowledgeItems in the persistent bucket.
 *
 * The agent is a PURE, ARM-BLIND function of (public hazard, available items).
 * It never receives the arm name and never receives the sealed answer key. The
 * arm only decides which items are *available*; the decision rule is the same.
 * So any measured difference between arms is attributable to inherited context
 * and nothing else. If a difference ever appeared from another variable, that
 * would be the Graphify failure (a label leak that manufactured the headline)
 * repeating, and the controls below exist to make that impossible.
 *
 * This harness is DETERMINISTIC and requires no live model. That is a
 * deliberate scope choice, not a shortcut: it measures a MECHANISM under a
 * perfect-attention agent model — "if the resolving knowledge is reachable in
 * an arm's context, the agent applies it; otherwise it falls to the naive
 * default." The deterministic result is therefore a CEILING on what persistent
 * context can buy, not a claim that a real model realizes any of it. Time to
 * completion, model tokens, and cost require a live model and are reported as
 * an explicit not-measured with a stated reason, never as zero. Under spec v3
 * §36.1 no number here is a Mendpoint product claim; see the research doc.
 *
 * HONESTY PROPERTIES BUILT IN (each has a test that dies if the control is
 * removed; see context-benchmark.test.ts):
 *   - An arm that graded nothing reports not-measured, never a flattering 1/0.
 *   - Arm "stateless" cannot recover a persistent item by any route.
 *   - Every metric returns an explicit not-measured on a zero denominator, and
 *     every gate treats not-measured as FAIL.
 *   - Inflated irrelevant / stale / duplicated context is COUNTED as such (and
 *     shown to inflate tokens while changing no outcome), never silently
 *     dropped. Conflicting context is counted distinctly and shown to be able
 *     to make the persistent arm WORSE.
 *   - Case identifiers carry no signal: the report is invariant under id
 *     renaming and case reordering.
 */
import { createHash } from "node:crypto";
import {
  resolveOrganizationDecision,
  type PrecedenceInput,
  type PrecedenceLayerName,
} from "@mendpoint/pipeline";

// ---------------------------------------------------------------------------
// Public cohort types (no answer material — these are what an arm may see).
// ---------------------------------------------------------------------------

/** The two arms. The agent never sees this value; only availability differs. */
export type ArmId = "stateless" | "persistent";
export const ARM_IDS: readonly ArmId[] = ["stateless", "persistent"] as const;

/**
 * A KnowledgeItem is one piece of context an arm may carry. It recommends an
 * option for the hazard(s) that share its resolutionKey. It is NEVER the answer
 * key: `recommends` is what this item tells the agent to do, which may be right,
 * wrong (conflicting), or beside the point (irrelevant). Correctness lives only
 * in the sealed truth and is known only to the grader.
 */
export interface KnowledgeItem {
  itemId: string;
  /** Opaque token; a hazard consults items sharing its resolutionKey. */
  resolutionKey: string;
  /** The option this item advises. Not necessarily the correct option. */
  recommends: string;
  /** Which precedence layer this item speaks for (drives resolveOrganizationDecision). */
  layer: PrecedenceLayerName;
  /** "immediate" is visible to BOTH arms; "persistent" only to the persistent arm. */
  bucket: "immediate" | "persistent";
  /** A stale item is excluded from resolution (MEMORY_PRECEDENCE: STALE -> excluded). */
  status: "active" | "stale";
  /** Synthetic, deterministic token cost of carrying this item. */
  tokens: number;
}

/**
 * A Hazard is a decision point. The agent chooses one option. The correct
 * option is NOT here; it is in HazardTruth, held by the grader only.
 */
export interface Hazard {
  hazardId: string;
  resolutionKey: string;
  options: readonly string[];
  /** What the agent picks when NO resolving knowledge is reachable. */
  naiveDefault: string;
  /**
   * Stages this hazard's option must agree with the architecture decision that
   * shares this group. Empty string means "not part of a consistency group".
   */
  consistencyGroup: string;
}

/** A task is a single unit of work (one migration stage or one mission run). */
export interface BenchmarkTask {
  taskId: string;
  /** Stage index within a scenario; verification is aggregated per stage. */
  stage: number;
  /** Immediate instruction tokens (both arms pay this). */
  instructionTokens: number;
  hazards: readonly Hazard[];
  /** Context available to this task, tagged by bucket. */
  context: readonly KnowledgeItem[];
}

export interface BenchmarkScenario {
  scenarioId: string;
  tenantId: string;
  description: string;
  tasks: readonly BenchmarkTask[];
}

// ---------------------------------------------------------------------------
// Sealed answer key (grader-only; never reaches the agent or the stager).
// ---------------------------------------------------------------------------

export interface HazardTruth {
  hazardId: string;
  correctOption: string;
  /**
   * True when THIS hazard's mistake was made and resolved in an earlier stage
   * or mission of the same scenario. This is the denominator of the headline
   * repeated-mistake metric: choosing anything other than correctOption here is
   * repeating a mistake the organization already paid to resolve.
   */
  priorMistakeResolved: boolean;
  /** True when a hard-policy item governs this hazard (a wrong choice violates policy). */
  policyGoverned: boolean;
}

export interface SealedKey {
  cohortDigest: string;
  truth: readonly HazardTruth[];
}

// ---------------------------------------------------------------------------
// Metric type: not-measured is a first-class value carrying a reason. A rate
// over a zero denominator is not-measured, never the flattering 1 or 0.
// ---------------------------------------------------------------------------

export type Metric =
  | { readonly measured: true; readonly value: number }
  | { readonly measured: false; readonly reason: string };

const measured = (value: number): Metric => ({ measured: true, value });
const notMeasured = (reason: string): Metric => ({ measured: false, reason });

/**
 * A rate. Denominator 0 is not-measured with a reason, never 1 and never 0.
 * A non-finite input is not-measured too, so NaN can never read as a score.
 */
export function rate(numerator: number, denominator: number, reason: string): Metric {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return notMeasured(`nonfinite:${reason}`);
  if (denominator === 0) return notMeasured(reason);
  return measured(numerator / denominator);
}

// ---------------------------------------------------------------------------
// Canonicalization and digests (bind the cohort so an empty/truncated cohort
// cannot grade cleanly, exactly as the Graphify harness does).
// ---------------------------------------------------------------------------

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const fail = (code: string): never => {
  throw new Error(code);
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => compareCodeUnits(a, b))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

const digest = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex")}`;

/**
 * The cohort digest binds every PUBLIC field of every hazard, item, and task,
 * canonically ordered so reordering cannot change it. It deliberately excludes
 * all answer material — the sealed key binds the SAME cohortDigest, so the key
 * and cohort are cryptographically paired without the cohort carrying answers.
 */
export function cohortDigest(scenarios: readonly BenchmarkScenario[]): `sha256:${string}` {
  const canonical = [...scenarios]
    .map((scenario) => ({
      scenarioId: scenario.scenarioId,
      tenantId: scenario.tenantId,
      tasks: [...scenario.tasks]
        .map((task) => ({
          taskId: task.taskId,
          stage: task.stage,
          instructionTokens: task.instructionTokens,
          hazards: [...task.hazards]
            .map((h) => ({
              hazardId: h.hazardId,
              resolutionKey: h.resolutionKey,
              options: [...h.options].sort(compareCodeUnits),
              naiveDefault: h.naiveDefault,
              consistencyGroup: h.consistencyGroup,
            }))
            .sort((a, b) => compareCodeUnits(a.hazardId, b.hazardId)),
          context: [...task.context]
            .map((i) => ({
              itemId: i.itemId,
              resolutionKey: i.resolutionKey,
              recommends: i.recommends,
              layer: i.layer,
              bucket: i.bucket,
              status: i.status,
              tokens: i.tokens,
            }))
            .sort((a, b) => compareCodeUnits(a.itemId, b.itemId)),
        }))
        .sort((a, b) => compareCodeUnits(a.taskId, b.taskId)),
    }))
    .sort((a, b) => compareCodeUnits(a.scenarioId, b.scenarioId));
  return digest(canonical);
}

// ---------------------------------------------------------------------------
// Arm availability + leak-proofing. This is the load-bearing control.
// ---------------------------------------------------------------------------

/**
 * The items an arm may see for a task. This is the SINGLE route by which context
 * reaches an arm; there is no other. Arm "stateless" gets ONLY the immediate
 * bucket, so the persistent envelope is unreachable to it by construction — its
 * choices are a pure function of the immediate bucket, provably independent of
 * whether a persistent bucket even exists (the strip-invariance leak test). Arm
 * "persistent" gets everything. Deleting the stateless filter makes both the
 * filter test and the strip-invariance test fail, and the artifact-level leak
 * gate (evaluateGates G3) catches any leak that reaches a staged choice.
 */
export function availableItems(task: BenchmarkTask, arm: ArmId): readonly KnowledgeItem[] {
  return arm === "stateless" ? task.context.filter((i) => i.bucket === "immediate") : task.context;
}

// ---------------------------------------------------------------------------
// The agent: pure, arm-blind, truth-blind. Given a hazard's public fields and
// the items reachable to it, it picks an option using the REAL product
// precedence resolver. It has no `arm` parameter and no access to HazardTruth,
// so it cannot condition on either.
// ---------------------------------------------------------------------------

/** Build the precedence input for one hazard from its reachable, active items. */
function precedenceInputFor(
  tenantId: string,
  hazard: Hazard,
  items: readonly KnowledgeItem[],
): { input: PrecedenceInput; byLayer: Map<PrecedenceLayerName, KnowledgeItem> } {
  // Only non-stale items whose resolutionKey matches this hazard participate.
  // Stale items are excluded, mirroring MEMORY_PRECEDENCE (STALE -> excluded).
  const matching = items
    .filter((i) => i.status === "active" && i.resolutionKey === hazard.resolutionKey)
    .sort((a, b) => compareCodeUnits(a.itemId, b.itemId));
  const byLayer = new Map<PrecedenceLayerName, KnowledgeItem>();
  for (const item of matching) {
    // At most one item per layer participates; the first by canonical id wins,
    // deterministically, so the choice never depends on input ordering.
    if (!byLayer.has(item.layer)) byLayer.set(item.layer, item);
  }
  const input: PrecedenceInput = { tenantId };
  const hp = byLayer.get("hard_policy");
  const md = byLayer.get("mission_decision");
  const co = byLayer.get("confirmed_org_memory");
  const up = byLayer.get("user_preference");
  const ic = byLayer.get("inferred_candidate");
  return {
    input: {
      ...input,
      ...(hp ? { hardPolicy: { tenantId, id: hp.itemId, directive: hp.recommends } } : {}),
      ...(md ? { missionDecision: { tenantId, id: md.itemId, directive: md.recommends } } : {}),
      ...(co
        ? { confirmedOrgMemory: { tenantId, memoryId: co.itemId, recordId: co.itemId, status: "ACTIVE", statement: co.recommends } }
        : {}),
      ...(up ? { userPreference: { tenantId, id: up.itemId, directive: up.recommends } } : {}),
      ...(ic
        ? { inferredCandidate: { tenantId, memoryId: ic.itemId, recordId: ic.itemId, status: "MEMORY_CANDIDATE", statement: ic.recommends } }
        : {}),
    },
    byLayer,
  };
}

/**
 * Choose an option for one hazard. Arm-blind and truth-blind. When no knowledge
 * is reachable, the agent falls to the naive default (this is what produces a
 * repeated mistake in the stateless arm). When knowledge is reachable, the REAL
 * `resolveOrganizationDecision` picks the governing layer and the agent follows
 * that layer's recommendation.
 */
export function chooseOption(tenantId: string, hazard: Hazard, items: readonly KnowledgeItem[]): string {
  const { input, byLayer } = precedenceInputFor(tenantId, hazard, items);
  const resolved = resolveOrganizationDecision(input);
  if (resolved.winner === "none") return hazard.naiveDefault;
  const governing = byLayer.get(resolved.winner);
  // Defensive: resolver named a layer we did not supply. Treat as no-knowledge
  // rather than inventing an answer.
  return governing ? governing.recommends : hazard.naiveDefault;
}

// ---------------------------------------------------------------------------
// Staging: run the agent for both arms over the cohort. The stager NEVER
// receives the sealed key, so a staged choice cannot depend on the answer.
// ---------------------------------------------------------------------------

export interface StagedChoice {
  scenarioId: string;
  taskId: string;
  hazardId: string;
  arm: ArmId;
  chosenOption: string;
  /** Items reachable to the arm for this hazard's task (for accounting). */
  reachableItemIds: readonly string[];
}

export interface StagedBenchmark {
  schemaVersion: "mendpoint.context-benchmark-staged.v1";
  cohortDigest: string;
  choices: readonly StagedChoice[];
}

export function stageBenchmark(scenarios: readonly BenchmarkScenario[]): StagedBenchmark {
  const cd = cohortDigest(scenarios);
  const choices: StagedChoice[] = [];
  for (const scenario of scenarios) {
    for (const task of scenario.tasks) {
      for (const arm of ARM_IDS) {
        const items = availableItems(task, arm);
        for (const hazard of task.hazards) {
          choices.push({
            scenarioId: scenario.scenarioId,
            taskId: task.taskId,
            hazardId: hazard.hazardId,
            arm,
            chosenOption: chooseOption(scenario.tenantId, hazard, items),
            reachableItemIds: items.map((i) => i.itemId).sort(compareCodeUnits),
          });
        }
      }
    }
  }
  return { schemaVersion: "mendpoint.context-benchmark-staged.v1", cohortDigest: cd, choices };
}

// ---------------------------------------------------------------------------
// Per-arm metrics. Everything is computed by the grader, which alone holds the
// sealed key. Rates over empty denominators are not-measured.
// ---------------------------------------------------------------------------

/** Classification of the persistent items an arm carries beyond the immediate bucket. */
export interface ContextQuality {
  /** Persistent items whose resolutionKey matches a hazard in the same task. */
  relevant: number;
  /** Persistent items whose resolutionKey matches NO hazard in the same task. */
  irrelevant: number;
  /** Persistent items marked stale (excluded from resolution). */
  stale: number;
  /**
   * Persistent, active items that match a hazard but recommend an option that
   * is NOT that hazard's correct option — context that misleads. Counted
   * distinctly from stale. (Grader-only: correctness comes from the sealed key.)
   */
  conflicting: number;
  /** Extra copies of an item already present (same key+layer+recommends+status). */
  duplicated: number;
  /** Total persistent items, so the five categories reconcile against it. */
  total: number;
  /** Synthetic tokens carried by the persistent items (the cost of the envelope). */
  tokens: number;
}

export interface ArmMetrics {
  arm: ArmId;
  /** Number of hazards graded for this arm (the master denominator). */
  hazardsGraded: number;
  taskCorrectness: Metric;
  migrationConsistency: Metric;
  /** HEADLINE: rate at which previously-resolved mistakes are repeated. */
  repeatedMistakeRate: Metric;
  repeatedMistakeCount: number;
  priorlyResolvedHazards: number;
  /** Distinct instructions (resolutionKeys) that had to be re-issued. */
  repeatedInstructions: number;
  humanCorrections: number;
  verificationSuccess: Metric;
  stagesPassed: number;
  stagesTotal: number;
  policyViolations: number;
  policyGovernedHazards: number;
  contextTokens: number;
  retrievalCalls: number;
  /** Live-model-only facets. Always not-measured in the deterministic harness. */
  timeToCompletionMs: Metric;
  modelCalls: 0;
  modelTokens: Metric;
  costUsd: Metric;
  contextQuality: ContextQuality;
}

const NOT_MEASURED_LIVE = "requires_live_model_not_run_in_deterministic_harness";

function classifyContextQuality(scenario: BenchmarkScenario, truth: Map<string, HazardTruth>): ContextQuality {
  let relevant = 0;
  let irrelevant = 0;
  let stale = 0;
  let conflicting = 0;
  let duplicated = 0;
  let total = 0;
  let tokens = 0;
  for (const task of scenario.tasks) {
    const taskKeys = new Set(task.hazards.map((h) => h.resolutionKey));
    const seen = new Set<string>();
    for (const item of task.context) {
      if (item.bucket !== "persistent") continue;
      total += 1;
      tokens += item.tokens;
      const fingerprint = `${item.resolutionKey} ${item.layer} ${item.recommends} ${item.status}`;
      if (seen.has(fingerprint)) {
        duplicated += 1;
      } else {
        seen.add(fingerprint);
      }
      if (item.status === "stale") {
        stale += 1;
        continue;
      }
      if (!taskKeys.has(item.resolutionKey)) {
        irrelevant += 1;
        continue;
      }
      // Active, relevant by key. Is it conflicting (recommends the wrong option
      // for a hazard it addresses)? Correctness is the sealed key's to know.
      const conflictsWithSome = task.hazards.some(
        (h) => h.resolutionKey === item.resolutionKey && truth.get(h.hazardId)?.correctOption !== item.recommends,
      );
      if (conflictsWithSome) conflicting += 1;
      else relevant += 1;
    }
  }
  return { relevant, irrelevant, stale, conflicting, duplicated, total, tokens };
}

// ---------------------------------------------------------------------------
// Grader: joins staged choices to the sealed key and produces the report.
// ---------------------------------------------------------------------------

export interface BenchmarkReport {
  schemaVersion: "mendpoint.context-benchmark.v1";
  contentDigest: `sha256:${string}`;
  cohortDigest: string;
  stagedDigest: `sha256:${string}`;
  keyDigest: `sha256:${string}`;
  cohort: { scenarios: number; tasks: number; hazards: number };
  arms: Record<ArmId, ArmMetrics>;
  /** Delta = stateless repeats minus persistent repeats (positive means persistent helped). */
  headline: {
    statelessRepeatedMistakeRate: Metric;
    persistentRepeatedMistakeRate: Metric;
    repeatsAvoidedByPersistentContext: Metric;
  };
  modelCalls: 0;
  notMeasuredReason: string;
}

function stageVerification(
  scenario: BenchmarkScenario,
  choiceByHazard: Map<string, string>,
  truth: Map<string, HazardTruth>,
): { passed: number; total: number } {
  // A stage's verification passes only when every hazard in it was chosen
  // correctly. A stage with no hazards is not a measured stage.
  const byStage = new Map<number, Hazard[]>();
  for (const task of scenario.tasks) {
    const list = byStage.get(task.stage) ?? [];
    for (const h of task.hazards) list.push(h);
    byStage.set(task.stage, list);
  }
  let passed = 0;
  let total = 0;
  for (const [, hazards] of byStage) {
    if (hazards.length === 0) continue;
    total += 1;
    const ok = hazards.every((h) => choiceByHazard.get(`${scenario.scenarioId} ${h.hazardId}`) === truth.get(h.hazardId)?.correctOption);
    if (ok) passed += 1;
  }
  return { passed, total };
}

export function gradeBenchmark(
  scenarios: readonly BenchmarkScenario[],
  staged: StagedBenchmark,
  key: SealedKey,
): BenchmarkReport {
  // Bind the cohort three ways so a truncated cohort cannot grade cleanly.
  const cd = cohortDigest(scenarios);
  if (staged.cohortDigest !== cd || key.cohortDigest !== cd) fail("context_benchmark_cohort_mismatch");
  if (staged.schemaVersion !== "mendpoint.context-benchmark-staged.v1") fail("context_benchmark_staged_schema_invalid");

  const allHazards = scenarios.flatMap((s) => s.tasks.flatMap((t) => t.hazards.map((h) => ({ scenario: s, hazard: h }))));
  if (allHazards.length === 0) fail("context_benchmark_empty_cohort");

  const truth = new Map(key.truth.map((t) => [t.hazardId, t]));
  // Every hazard must have exactly one truth row and vice versa. A missing or
  // extra truth row is a key/cohort mismatch, not a silently ungraded hazard.
  if (key.truth.length !== allHazards.length || !allHazards.every(({ hazard }) => truth.has(hazard.hazardId))) {
    fail("context_benchmark_key_mismatch");
  }

  const choiceByArmHazard = new Map<string, string>();
  const reachableByArmTask = new Map<string, readonly string[]>();
  for (const c of staged.choices) {
    choiceByArmHazard.set(`${c.arm} ${c.scenarioId} ${c.hazardId}`, c.chosenOption);
    reachableByArmTask.set(`${c.arm} ${c.scenarioId} ${c.taskId}`, c.reachableItemIds);
  }

  const arms = {} as Record<ArmId, ArmMetrics>;
  for (const arm of ARM_IDS) {
    let hazardsGraded = 0;
    let correct = 0;
    let repeatedMistakeCount = 0;
    let priorlyResolvedHazards = 0;
    let humanCorrections = 0;
    let policyViolations = 0;
    let policyGovernedHazards = 0;
    let contextTokens = 0;
    let retrievalCalls = 0;
    const repeatedInstructionKeys = new Set<string>();
    const consistencyGroups = new Map<string, { anchor: string | null; consistent: boolean; total: number }>();
    let stagesPassed = 0;
    let stagesTotal = 0;

    const choiceByHazardForVerification = new Map<string, string>();

    for (const scenario of scenarios) {
      for (const task of scenario.tasks) {
        // Context cost is charged once per task from the arm's reachable set.
        const reachable = reachableByArmTask.get(`${arm} ${scenario.scenarioId} ${task.taskId}`) ?? [];
        const reachableSet = new Set(reachable);
        contextTokens += task.instructionTokens + task.context.filter((i) => reachableSet.has(i.itemId)).reduce((sum, i) => sum + i.tokens, 0);
        retrievalCalls += reachable.length;

        for (const hazard of task.hazards) {
          const chosen = choiceByArmHazard.get(`${arm} ${scenario.scenarioId} ${hazard.hazardId}`);
          if (chosen === undefined) throw new Error("context_benchmark_arm_missing_choice");
          choiceByHazardForVerification.set(`${scenario.scenarioId} ${hazard.hazardId}`, chosen);
          const t = truth.get(hazard.hazardId)!;
          hazardsGraded += 1;
          const isCorrect = chosen === t.correctOption;
          if (isCorrect) correct += 1;
          else humanCorrections += 1; // a wrong choice at a review gate needs a human correction

          if (t.priorMistakeResolved) {
            priorlyResolvedHazards += 1;
            if (!isCorrect) {
              repeatedMistakeCount += 1;
              repeatedInstructionKeys.add(hazard.resolutionKey);
            }
          }
          if (t.policyGoverned) {
            policyGovernedHazards += 1;
            if (!isCorrect) policyViolations += 1;
          }
          if (hazard.consistencyGroup) {
            const g = consistencyGroups.get(hazard.consistencyGroup) ?? { anchor: null, consistent: true, total: 0 };
            g.total += 1;
            // The anchor is the correct option of the group (the architecture
            // decision). A choice is consistent iff it matches the anchor.
            g.anchor = g.anchor ?? t.correctOption;
            if (chosen !== g.anchor) g.consistent = false;
            consistencyGroups.set(hazard.consistencyGroup, g);
          }
        }
      }
      const verify = stageVerification(scenario, choiceByHazardForVerification, truth);
      stagesPassed += verify.passed;
      stagesTotal += verify.total;
    }

    const consistentGroups = [...consistencyGroups.values()].filter((g) => g.consistent).length;

    // Context quality is a property of the persistent envelope; the stateless
    // arm carries none, so its breakdown is all zero (it inflates nothing).
    const contextQuality =
      arm === "persistent"
        ? scenarios.reduce<ContextQuality>(
            (acc, s) => {
              const q = classifyContextQuality(s, truth);
              return {
                relevant: acc.relevant + q.relevant,
                irrelevant: acc.irrelevant + q.irrelevant,
                stale: acc.stale + q.stale,
                conflicting: acc.conflicting + q.conflicting,
                duplicated: acc.duplicated + q.duplicated,
                total: acc.total + q.total,
                tokens: acc.tokens + q.tokens,
              };
            },
            { relevant: 0, irrelevant: 0, stale: 0, conflicting: 0, duplicated: 0, total: 0, tokens: 0 },
          )
        : { relevant: 0, irrelevant: 0, stale: 0, conflicting: 0, duplicated: 0, total: 0, tokens: 0 };

    arms[arm] = {
      arm,
      hazardsGraded,
      taskCorrectness: rate(correct, hazardsGraded, "no_hazards_graded"),
      migrationConsistency: rate(consistentGroups, consistencyGroups.size, "no_consistency_groups"),
      repeatedMistakeRate: rate(repeatedMistakeCount, priorlyResolvedHazards, "no_previously_resolved_mistakes"),
      repeatedMistakeCount,
      priorlyResolvedHazards,
      repeatedInstructions: repeatedInstructionKeys.size,
      humanCorrections,
      verificationSuccess: rate(stagesPassed, stagesTotal, "no_verifiable_stages"),
      stagesPassed,
      stagesTotal,
      policyViolations,
      policyGovernedHazards,
      contextTokens,
      retrievalCalls,
      timeToCompletionMs: notMeasured(NOT_MEASURED_LIVE),
      modelCalls: 0,
      modelTokens: notMeasured(NOT_MEASURED_LIVE),
      costUsd: notMeasured(NOT_MEASURED_LIVE),
      contextQuality,
    };
  }

  const statelessRate = arms.stateless.repeatedMistakeRate;
  const persistentRate = arms.persistent.repeatedMistakeRate;
  const repeatsAvoided: Metric =
    statelessRate.measured && persistentRate.measured
      ? measured(arms.stateless.repeatedMistakeCount - arms.persistent.repeatedMistakeCount)
      : notMeasured("repeated_mistake_rate_not_measured_for_both_arms");

  const reportWithoutDigest = {
    schemaVersion: "mendpoint.context-benchmark.v1" as const,
    cohortDigest: cd,
    stagedDigest: digest(staged),
    keyDigest: digest(key),
    cohort: {
      scenarios: scenarios.length,
      tasks: scenarios.reduce((n, s) => n + s.tasks.length, 0),
      hazards: allHazards.length,
    },
    arms,
    headline: {
      statelessRepeatedMistakeRate: statelessRate,
      persistentRepeatedMistakeRate: persistentRate,
      repeatsAvoidedByPersistentContext: repeatsAvoided,
    },
    modelCalls: 0 as const,
    notMeasuredReason: NOT_MEASURED_LIVE,
  };
  return { ...reportWithoutDigest, contentDigest: digest(reportWithoutDigest) };
}

// ---------------------------------------------------------------------------
// Gates. Each returns PASS / FAIL / NOT_MEASURED, and NOT_MEASURED counts as
// FAIL in the overall verdict. Each gate has a test that constructs an input
// that fails it (context-benchmark.test.ts).
// ---------------------------------------------------------------------------

export type GateStatus = "PASS" | "FAIL" | "NOT_MEASURED";
export interface GateResult {
  id: string;
  status: GateStatus;
  detail: string;
}
export interface GateVerdict {
  overall: "PASS" | "FAIL";
  gates: readonly GateResult[];
}

/**
 * Evaluate the benchmark's acceptance gates. The scenarios are passed so the
 * leak gate can recompute the true persistent-item set and prove no stateless
 * choice reached it; the staged artifact carries what each choice could reach.
 * These gates are NEW and specific to this benchmark; they do not read or move
 * evals/readiness-gates.json or docs/PRODUCT_REQUIREMENTS.json.
 */
export function evaluateGates(
  scenarios: readonly BenchmarkScenario[],
  report: BenchmarkReport,
  staged: StagedBenchmark,
): GateVerdict {
  const gates: GateResult[] = [];

  // G1: no declared arm may have graded nothing. An arm that measured nothing
  // is not a tie or a pass; it is not-measured, which is a FAIL.
  for (const arm of ARM_IDS) {
    const m = report.arms[arm];
    gates.push(
      m.hazardsGraded > 0
        ? { id: `arm_measured_something:${arm}`, status: "PASS", detail: `${m.hazardsGraded} hazards graded` }
        : { id: `arm_measured_something:${arm}`, status: "NOT_MEASURED", detail: "arm graded zero hazards" },
    );
  }

  // G2: the headline must be measured for both arms (repeated-mistake rate over
  // a real denominator). A zero denominator is NOT_MEASURED -> FAIL.
  const hs = report.headline.statelessRepeatedMistakeRate;
  const hp = report.headline.persistentRepeatedMistakeRate;
  gates.push(
    hs.measured && hp.measured
      ? { id: "headline_measured", status: "PASS", detail: "repeated-mistake rate measured for both arms" }
      : { id: "headline_measured", status: "NOT_MEASURED", detail: "repeated-mistake rate not measured for an arm" },
  );

  // G3: leak-proofing. Recompute the set of every persistent item id, then
  // assert that no stateless staged choice reached any of them. A genuine leak
  // (a persistent item mis-bucketed, or a stager that widened the stateless
  // view) is caught here from the artifacts, independent of the stager guard.
  const persistentItemIds = new Set<string>();
  for (const s of scenarios) for (const t of s.tasks) for (const i of t.context) if (i.bucket === "persistent") persistentItemIds.add(i.itemId);
  const leaked = staged.choices
    .filter((c) => c.arm === "stateless")
    .flatMap((c) => c.reachableItemIds)
    .filter((id) => persistentItemIds.has(id));
  gates.push(
    leaked.length === 0
      ? { id: "leak_proof", status: "PASS", detail: "no stateless choice reached a persistent item" }
      : { id: "leak_proof", status: "FAIL", detail: `stateless reached persistent items: ${[...new Set(leaked)].sort().join(",")}` },
  );

  // G4: context accounting reconciles. The four primary categories partition the
  // persistent items (every item lands in exactly one), so they must sum to the
  // total; a junk item can never vanish. stale and conflicting are distinct
  // fields, so they cannot silently merge. duplicated is an overlay count and
  // must not exceed the total.
  const q = report.arms.persistent.contextQuality;
  const partitionOk = q.relevant + q.irrelevant + q.stale + q.conflicting === q.total;
  const overlayOk = q.duplicated >= 0 && q.duplicated <= q.total;
  gates.push(
    partitionOk && overlayOk
      ? { id: "context_quality_reconciles", status: "PASS", detail: `relevant+irrelevant+stale+conflicting=${q.total}, duplicated=${q.duplicated}` }
      : { id: "context_quality_reconciles", status: "FAIL", detail: `categories (${q.relevant}+${q.irrelevant}+${q.stale}+${q.conflicting}) do not partition total ${q.total} or duplicated ${q.duplicated} out of range` },
  );

  const anyNotMeasured = gates.some((g) => g.status === "NOT_MEASURED");
  const anyFail = gates.some((g) => g.status === "FAIL");
  return { overall: anyNotMeasured || anyFail ? "FAIL" : "PASS", gates };
}
