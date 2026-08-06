import { createHash } from "node:crypto";
import { redactSourceForModel } from "@mendpoint/agent";
import { recipeFilesDigest, type RecipeFiles, type RecipeReference } from "./recipe.js";

/**
 * Adaptive inspect/edit/verify/retry loop for the Transformer.
 *
 * The deterministic recipe runs first (recipe-first); this engine only engages
 * when the recipe's objective verification gate fails. It then runs a bounded
 * per-unit state machine — INSPECT the verifier failure and the files it
 * implicates, EDIT a source-grounded mutation, VERIFY by re-running the same
 * objective gate, and RETRY with escalating context (each retry may pull in
 * more related files) — mirroring the large-scale-change practice cited in the
 * capability taxonomy (Google LSC, Airbnb ts-migrate / Enzyme→RTL).
 *
 * Safety parity with Warden is enforced here rather than assumed: every edit is
 * read-before-write with an exact content fence (a mutation is rejected if the
 * file changed since it was observed), mutations are confined to an allowed path
 * set, reads/context are bounded, and untrusted repository content is redacted
 * before it is handed to a model. The redaction primitive is reused from
 * @mendpoint/agent (`redactSourceForModel`) so it stays in lockstep with Warden.
 */

export type AdaptiveRepairBounds = Readonly<{
  /** Maximum adaptive iterations spent on a single work unit. */
  maxIterationsPerUnit: number;
  /** Maximum adaptive iterations across the whole attempt (all units). */
  maxTotalIterations: number;
  /** Wall-clock ceiling for the loop, in milliseconds. */
  wallClockBudgetMs: number;
  /** Maximum model (planner) calls the loop may make. */
  maxModelCalls: number;
  /** Maximum redacted context bytes handed to the planner per prompt. */
  maxContextBytesPerPrompt: number;
}>;

export const DEFAULT_ADAPTIVE_REPAIR_BOUNDS: AdaptiveRepairBounds = Object.freeze({
  maxIterationsPerUnit: 4,
  maxTotalIterations: 12,
  wallClockBudgetMs: 120_000,
  maxModelCalls: 8,
  maxContextBytesPerPrompt: 32_768,
});

const HARD_ADAPTIVE_BOUNDS: AdaptiveRepairBounds = Object.freeze({
  maxIterationsPerUnit: 100,
  maxTotalIterations: 1_000,
  wallClockBudgetMs: 3_600_000,
  maxModelCalls: 500,
  maxContextBytesPerPrompt: 1_000_000,
});

export type AdaptiveVerifierResult = Readonly<{
  passed: boolean;
  /** Identifier of the first failing objective check (null when passed). */
  failingCommandId: string | null;
  /** Raw, untrusted verifier output. Redacted before it reaches a planner. */
  output: string;
  /** Paths the verifier output implicates, used to seed adaptive context. */
  implicatedPaths: readonly string[];
}>;

/** The objective gate: re-run the same verification the recipe used. */
export type AdaptiveGate = (files: RecipeFiles) => Promise<AdaptiveVerifierResult>;

export type AdaptiveEdit = Readonly<{
  path: string;
  /** Digest of the file content the planner observed (exact content fence). */
  observedContentDigest: string;
  nextContent: string;
}>;

export type AdaptiveRepairPlan = Readonly<{
  edits: readonly AdaptiveEdit[];
  /** Related files to pull into the next iteration's context (escalation). */
  requestContextPaths?: readonly string[];
  /** The planner concedes the site cannot be fixed within scope. */
  markUnfixable?: boolean;
  rationale?: string;
}>;

export type AdaptiveRepairPlannerUsage = Readonly<{
  /** Honest-measurement flag: true only when a model was actually called. */
  modelCalled: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  model?: string;
}>;

export type AdaptiveRepairContextFile = Readonly<{
  path: string;
  /** Redacted, bounded content. */
  content: string;
  digest: string;
  truncated: boolean;
}>;

export type AdaptiveRepairPlannerInput = Readonly<{
  schemaVersion: 1;
  unitId: string;
  goal: string;
  recipe: RecipeReference;
  iteration: number;
  failingCommandId: string | null;
  /** Redacted verifier output. */
  verifierOutput: string;
  /** Redacted, bounded context files. */
  context: readonly AdaptiveRepairContextFile[];
  allowedMutationPaths: readonly string[];
  priorChangedPaths: readonly string[];
}>;

export type AdaptiveRepairPlannerOutput = Readonly<{
  plan: AdaptiveRepairPlan;
  usage?: AdaptiveRepairPlannerUsage;
}>;

export type AdaptiveRepairPlanner = (
  input: AdaptiveRepairPlannerInput,
  options: Readonly<{ signal?: AbortSignal }>,
) => Promise<AdaptiveRepairPlannerOutput>;

export type AdaptiveBoundExhaustion =
  | "iterations_per_unit"
  | "total_iterations"
  | "wall_clock"
  | "model_calls";

export type AdaptiveUnfixableReason =
  | "iterations_per_unit_exhausted"
  | "total_iterations_exhausted"
  | "wall_clock_exhausted"
  | "model_calls_exhausted"
  | "planner_marked_unfixable"
  | "planner_error"
  | "fence_violation"
  | "path_not_allowed"
  | "no_progress"
  | "pre_existing_failure";

export type AdaptiveBestAttempt = Readonly<{
  iteration: number;
  changedPaths: readonly string[];
  candidateDigest: string;
  remainingFailingCommandId: string | null;
  remainingVerifierOutputDigest: string;
}>;

export type AdaptiveUnfixableMarker = Readonly<{
  schemaVersion: 1;
  kind: "transformer.adaptive.unfixable";
  unitId: string;
  reason: AdaptiveUnfixableReason;
  boundExhausted: AdaptiveBoundExhaustion | null;
  failingCommandId: string | null;
  /** Digest of the last verifier output (raw output is never persisted). */
  verifierOutputDigest: string;
  iterationsUsed: number;
  bestAttempt: AdaptiveBestAttempt | null;
}>;

export type AdaptiveRepairUsage = Readonly<{
  /** True only when at least one model call was actually made. */
  measured: boolean;
  modelCalls: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}>;

export type AdaptiveRepairOutcome =
  | Readonly<{ status: "not_engaged"; iterationsUsed: 0; usage: AdaptiveRepairUsage }>
  | Readonly<{
      status: "converged";
      files: RecipeFiles;
      outputDigest: string;
      changedPaths: readonly string[];
      iterationsUsed: number;
      usage: AdaptiveRepairUsage;
    }>
  | Readonly<{
      status: "pre_existing_failure";
      marker: AdaptiveUnfixableMarker;
      /** Unchanged recipe output — the migration is not blamed. */
      files: RecipeFiles;
      iterationsUsed: number;
      usage: AdaptiveRepairUsage;
    }>
  | Readonly<{
      status: "unfixable";
      marker: AdaptiveUnfixableMarker;
      /** Rolled back to the pre-adaptive recipe output (no partial edits). */
      files: RecipeFiles;
      /** Best failing attempt, carried for human escalation (null if none). */
      bestAttemptFiles: RecipeFiles | null;
      iterationsUsed: number;
      usage: AdaptiveRepairUsage;
      boundExhausted: AdaptiveBoundExhaustion | null;
    }>;

export type RunAdaptiveRepairLoopInput = Readonly<{
  unitId: string;
  goal: string;
  recipe: RecipeReference;
  /** Pre-recipe source, used for the pre-existing-failure baseline. */
  sourceFiles: RecipeFiles;
  /** Deterministic recipe output; the adaptive loop starts from here. */
  recipeFiles: RecipeFiles;
  /** Exact set of paths the loop may mutate (nothing outside it). */
  allowedMutationPaths: readonly string[];
  /** The objective gate adaptive must satisfy on the migrated output. */
  gate: AdaptiveGate;
  /**
   * Optional pre-migration regression gate. When provided and it already fails
   * on the untouched source, the failure predates the migration and the unit is
   * classified pre-existing rather than counted as a migration regression. A
   * migration's own verification is expected to fail on pre-migration source, so
   * that check must never be used here.
   */
  baselineGate?: AdaptiveGate;
  planner: AdaptiveRepairPlanner;
  bounds?: Partial<AdaptiveRepairBounds>;
  /** Iterations already spent by earlier units this attempt. */
  priorTotalIterations?: number;
  /** Injectable clock for deterministic wall-clock tests. */
  now?: () => number;
  signal?: AbortSignal;
}>;

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function resolveBounds(bounds: Partial<AdaptiveRepairBounds> | undefined): AdaptiveRepairBounds {
  const merged = { ...DEFAULT_ADAPTIVE_REPAIR_BOUNDS, ...bounds };
  for (const key of Object.keys(DEFAULT_ADAPTIVE_REPAIR_BOUNDS) as (keyof AdaptiveRepairBounds)[]) {
    const value = merged[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > HARD_ADAPTIVE_BOUNDS[key]) {
      throw new Error(`adaptive_bound_invalid:${key}`);
    }
  }
  return Object.freeze(merged);
}

function normalizeFiles(files: RecipeFiles): Record<string, string> {
  // recipeFilesDigest validates every path and content shape; call it once so
  // an invalid working set fails closed before any planning or mutation.
  recipeFilesDigest(files);
  return { ...files };
}

function changedPathsBetween(before: RecipeFiles, after: Record<string, string>): string[] {
  const paths = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const path of paths) {
    if (before[path] !== after[path]) changed.push(path);
  }
  return changed.sort();
}

function assembleContext(
  working: Record<string, string>,
  contextPaths: readonly string[],
  maxBytes: number,
): AdaptiveRepairContextFile[] {
  const context: AdaptiveRepairContextFile[] = [];
  let used = 0;
  for (const path of [...new Set(contextPaths)].sort()) {
    const raw = working[path];
    if (raw === undefined) continue;
    const remaining = maxBytes - used;
    if (remaining <= 0) break;
    const redaction = redactSourceForModel(raw, Math.min(maxBytes, remaining));
    if (redaction.excluded) continue;
    const text = redaction.text;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > remaining) continue;
    used += bytes;
    context.push(
      Object.freeze({
        path,
        content: text,
        digest: sha256(raw),
        truncated: redaction.truncated,
      }),
    );
  }
  return context;
}

function redactVerifierOutput(output: string, maxBytes: number): string {
  const redaction = redactSourceForModel(output, Math.max(1, Math.min(maxBytes, 8_192)));
  return redaction.excluded ? "" : redaction.text;
}

function readableContextSeed(
  implicated: readonly string[],
  working: Record<string, string>,
): Set<string> {
  return new Set(implicated.filter((path) => working[path] !== undefined));
}

class AdaptiveMutationError extends Error {
  constructor(readonly reason: "fence_violation" | "path_not_allowed", message: string) {
    super(message);
    this.name = "AdaptiveMutationError";
  }
}

function applyEdits(
  working: Record<string, string>,
  edits: readonly AdaptiveEdit[],
  allowed: ReadonlySet<string>,
): Record<string, string> {
  const next = { ...working };
  for (const edit of edits) {
    if (!allowed.has(edit.path)) {
      throw new AdaptiveMutationError("path_not_allowed", `adaptive_path_not_allowed:${edit.path}`);
    }
    const current = next[edit.path];
    if (current === undefined) {
      throw new AdaptiveMutationError("path_not_allowed", `adaptive_path_absent:${edit.path}`);
    }
    // Read-before-write exact content fence: reject if the file changed since
    // the planner observed it.
    if (edit.observedContentDigest !== sha256(current)) {
      throw new AdaptiveMutationError("fence_violation", `adaptive_fence_violation:${edit.path}`);
    }
    if (typeof edit.nextContent !== "string") {
      throw new AdaptiveMutationError("fence_violation", `adaptive_content_invalid:${edit.path}`);
    }
    next[edit.path] = edit.nextContent;
  }
  return next;
}

function emptyUsage(): {
  measured: boolean;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
} {
  return {
    measured: false,
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

function finalizeUsage(usage: ReturnType<typeof emptyUsage>): AdaptiveRepairUsage {
  // Honest measurement: usage counts only when the model was actually called.
  // A deterministic (scripted, no-model) run reports nulls, never a fabricated
  // zero presented as a measured cost.
  if (!usage.measured || usage.modelCalls === 0) {
    return Object.freeze({
      measured: false,
      modelCalls: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      costUsd: null,
    });
  }
  return Object.freeze({
    measured: true,
    modelCalls: usage.modelCalls,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
  });
}

function accumulateUsage(
  usage: ReturnType<typeof emptyUsage>,
  reported: AdaptiveRepairPlannerUsage | undefined,
): void {
  if (!reported?.modelCalled) return;
  usage.measured = true;
  usage.modelCalls += 1;
  usage.promptTokens += Math.max(0, reported.promptTokens ?? 0);
  usage.completionTokens += Math.max(0, reported.completionTokens ?? 0);
  usage.totalTokens += Math.max(0, reported.totalTokens ?? 0);
  usage.costUsd += Math.max(0, reported.costUsd ?? 0);
}

function reasonForBound(bound: AdaptiveBoundExhaustion): AdaptiveUnfixableReason {
  switch (bound) {
    case "iterations_per_unit":
      return "iterations_per_unit_exhausted";
    case "total_iterations":
      return "total_iterations_exhausted";
    case "wall_clock":
      return "wall_clock_exhausted";
    case "model_calls":
      return "model_calls_exhausted";
  }
}

export async function runAdaptiveRepairLoop(
  input: RunAdaptiveRepairLoopInput,
): Promise<AdaptiveRepairOutcome> {
  const bounds = resolveBounds(input.bounds);
  const now = input.now ?? Date.now;
  const started = now();
  const allowed = new Set(input.allowedMutationPaths);
  if (allowed.size === 0) throw new Error("adaptive_allowed_paths_required");
  const priorTotal = Math.max(0, input.priorTotalIterations ?? 0);
  const usage = emptyUsage();

  const recipeFiles = Object.freeze({ ...input.recipeFiles });
  let working = normalizeFiles(recipeFiles);
  normalizeFiles(input.sourceFiles);

  const initial = await input.gate(recipeFiles);
  if (initial.passed) {
    // Recipe-first guarantee: the deterministic path already satisfies the gate,
    // so the adaptive loop never engages.
    return Object.freeze({ status: "not_engaged", iterationsUsed: 0, usage: finalizeUsage(usage) });
  }

  // Pre-existing-failure trap (taxonomy flaky/pre-existing lane): if a
  // regression check that must have been green before the migration already
  // fails on the untouched source, the failure predates the migration and must
  // not be blamed on it.
  if (input.baselineGate) {
    const baseline = await input.baselineGate(input.sourceFiles);
    if (!baseline.passed) {
      const marker: AdaptiveUnfixableMarker = Object.freeze({
        schemaVersion: 1,
        kind: "transformer.adaptive.unfixable",
        unitId: input.unitId,
        reason: "pre_existing_failure",
        boundExhausted: null,
        failingCommandId: baseline.failingCommandId,
        verifierOutputDigest: sha256(baseline.output),
        iterationsUsed: 0,
        bestAttempt: null,
      });
      return Object.freeze({
        status: "pre_existing_failure",
        marker,
        files: recipeFiles,
        iterationsUsed: 0,
        usage: finalizeUsage(usage),
      });
    }
  }

  let iterations = 0;
  let lastFailure: AdaptiveVerifierResult = initial;
  let best: AdaptiveBestAttempt | null = null;
  let bestFiles: RecipeFiles | null = null;
  const contextPaths = readableContextSeed(initial.implicatedPaths, working);
  let unfixableReason: AdaptiveUnfixableReason = "no_progress";
  let boundExhausted: AdaptiveBoundExhaustion | null = null;

  for (;;) {
    if (iterations >= bounds.maxIterationsPerUnit) {
      boundExhausted = "iterations_per_unit";
      break;
    }
    if (priorTotal + iterations >= bounds.maxTotalIterations) {
      boundExhausted = "total_iterations";
      break;
    }
    if (now() - started >= bounds.wallClockBudgetMs) {
      boundExhausted = "wall_clock";
      break;
    }
    if (usage.modelCalls >= bounds.maxModelCalls) {
      boundExhausted = "model_calls";
      break;
    }

    const context = assembleContext(working, [...contextPaths], bounds.maxContextBytesPerPrompt);
    const priorChangedPaths = changedPathsBetween(recipeFiles, working);
    iterations += 1;

    let output: AdaptiveRepairPlannerOutput;
    try {
      output = await input.planner(
        Object.freeze({
          schemaVersion: 1,
          unitId: input.unitId,
          goal: input.goal,
          recipe: input.recipe,
          iteration: iterations,
          failingCommandId: lastFailure.failingCommandId,
          verifierOutput: redactVerifierOutput(lastFailure.output, bounds.maxContextBytesPerPrompt),
          context: Object.freeze(context),
          allowedMutationPaths: Object.freeze([...allowed].sort()),
          priorChangedPaths: Object.freeze(priorChangedPaths),
        }),
        { signal: input.signal },
      );
    } catch {
      unfixableReason = "planner_error";
      break;
    }
    accumulateUsage(usage, output.usage);

    const plan = output.plan;
    if (plan.markUnfixable) {
      unfixableReason = "planner_marked_unfixable";
      break;
    }

    let candidate: Record<string, string>;
    try {
      candidate = applyEdits(working, plan.edits, allowed);
    } catch (error) {
      unfixableReason = error instanceof AdaptiveMutationError ? error.reason : "planner_error";
      break;
    }

    let escalated = false;
    for (const path of plan.requestContextPaths ?? []) {
      if (working[path] !== undefined && !contextPaths.has(path)) {
        contextPaths.add(path);
        escalated = true;
      }
    }

    const madeEdit = plan.edits.length > 0 && changedPathsBetween(working, candidate).length > 0;
    if (!madeEdit && !escalated) {
      unfixableReason = "no_progress";
      break;
    }

    if (!madeEdit) {
      // Escalation-only iteration: gather more context, do not re-run the gate
      // on identical files.
      continue;
    }

    const result = await input.gate(candidate);
    if (result.passed) {
      const changedPaths = changedPathsBetween(recipeFiles, candidate);
      const files = Object.freeze({ ...candidate });
      return Object.freeze({
        status: "converged",
        files,
        outputDigest: recipeFilesDigest(files),
        changedPaths: Object.freeze(changedPaths),
        iterationsUsed: iterations,
        usage: finalizeUsage(usage),
      });
    }

    const candidateFiles = Object.freeze({ ...candidate });
    best = Object.freeze({
      iteration: iterations,
      changedPaths: Object.freeze(changedPathsBetween(recipeFiles, candidate)),
      candidateDigest: recipeFilesDigest(candidateFiles),
      remainingFailingCommandId: result.failingCommandId,
      remainingVerifierOutputDigest: sha256(result.output),
    });
    bestFiles = candidateFiles;
    working = candidate;
    lastFailure = result;
    for (const path of result.implicatedPaths) {
      if (working[path] !== undefined) contextPaths.add(path);
    }
  }

  const reason = boundExhausted ? reasonForBound(boundExhausted) : unfixableReason;
  const marker: AdaptiveUnfixableMarker = Object.freeze({
    schemaVersion: 1,
    kind: "transformer.adaptive.unfixable",
    unitId: input.unitId,
    reason,
    boundExhausted,
    failingCommandId: lastFailure.failingCommandId,
    verifierOutputDigest: sha256(lastFailure.output),
    iterationsUsed: iterations,
    bestAttempt: best,
  });
  return Object.freeze({
    status: "unfixable",
    marker,
    // Roll the unit back to its pre-adaptive recipe output — no partial edit is
    // ever left behind.
    files: recipeFiles,
    bestAttemptFiles: bestFiles,
    iterationsUsed: iterations,
    usage: finalizeUsage(usage),
    boundExhausted,
  });
}
