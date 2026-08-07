import { createHash } from "node:crypto";
import { redactSourceForModel } from "@mendpoint/agent";
import { recipeFilesDigest, type RecipeFiles, type RecipeReference } from "./recipe.js";
import {
  MAX_ADAPTIVE_REVIEW_FILE_BYTES,
  MAX_ADAPTIVE_REVIEW_TOTAL_BYTES,
} from "./adaptive-review-limits.js";

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
  /** Maximum planner invocations, including deterministic planners. */
  maxPlannerCalls: number;
  /** Maximum planner invocations that may call an external model. */
  maxModelCalls: number;
  /** Maximum redacted context bytes handed to the planner per prompt. */
  maxContextBytesPerPrompt: number;
  /** Maximum UTF-8 bytes in any one adaptive candidate file. */
  maxCandidateFileBytes: number;
  /** Maximum aggregate UTF-8 bytes in an adaptive candidate file set. */
  maxCandidateBytes: number;
}>;

export const DEFAULT_ADAPTIVE_REPAIR_BOUNDS: AdaptiveRepairBounds = Object.freeze({
  maxIterationsPerUnit: 4,
  maxTotalIterations: 12,
  wallClockBudgetMs: 120_000,
  maxPlannerCalls: 8,
  maxModelCalls: 8,
  maxContextBytesPerPrompt: 32_768,
  maxCandidateFileBytes: MAX_ADAPTIVE_REVIEW_FILE_BYTES,
  maxCandidateBytes: MAX_ADAPTIVE_REVIEW_TOTAL_BYTES,
});

const HARD_ADAPTIVE_BOUNDS: AdaptiveRepairBounds = Object.freeze({
  maxIterationsPerUnit: 100,
  maxTotalIterations: 1_000,
  wallClockBudgetMs: 3_600_000,
  maxPlannerCalls: 500,
  maxModelCalls: 500,
  maxContextBytesPerPrompt: 1_000_000,
  maxCandidateFileBytes: MAX_ADAPTIVE_REVIEW_FILE_BYTES,
  maxCandidateBytes: MAX_ADAPTIVE_REVIEW_TOTAL_BYTES,
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
export type AdaptiveGate = (
  files: RecipeFiles,
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<AdaptiveVerifierResult>;

export type AdaptiveEdit = Readonly<{
  path: string;
  /** Digest of the file content the planner observed (exact content fence). */
  observedContentDigest: string;
  nextContent: string;
  rationale?: string;
  semanticCategory?: AdaptiveSemanticCategory;
  risk?: AdaptiveReviewRisk;
  /** Whole-number confidence percentage from 0 through 100. */
  confidence?: number;
}>;

export type AdaptiveSemanticCategory =
  | "behavior"
  | "tests"
  | "configuration"
  | "dependencies"
  | "security"
  | "documentation"
  | "other";

export type AdaptiveReviewRisk = "low" | "medium" | "high";

export type AdaptiveRepairReviewEvidence = Readonly<{
  edits: readonly Readonly<{
    path: string;
    rationale: string;
    semanticCategory: AdaptiveSemanticCategory;
    risk: AdaptiveReviewRisk;
    confidence: number;
  }>[];
  verification: Readonly<{
    passed: true;
    commandId: string;
    summary: string;
    outputDigest: string;
  }>;
  overallRisk: AdaptiveReviewRisk;
  confidence: number;
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
  /** Durable campaign headroom available before this planner invocation. */
  budget?: AdaptiveRepairPlannerBudget;
}>;

export type AdaptiveRepairPlannerBudget = Readonly<{
  plannerCalls: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  actualCostUsd: number;
}>;

export type AdaptiveRepairPlannerOutput = Readonly<{
  plan: AdaptiveRepairPlan;
  usage?: AdaptiveRepairPlannerUsage;
}>;

export type AdaptiveExternalModelReservation = Readonly<{
  reservationId: string;
  requestDigest: string;
  provider: string;
  configuredModel: string;
  deployment: string;
  executionRegion: string;
  maximumDataClassification: "public" | "internal" | "confidential" | "restricted";
  endpointHost: string;
  maximumInputTokens: number;
  maximumOutputTokens: number;
  maximumTotalTokens: number;
  maximumCostUsd: number;
}>;

export type AdaptiveExternalModelSettlement = Readonly<{
  reservationId: string;
  status: "succeeded" | "failed" | "over_budget";
  actualModel?: string;
  bodyRequestId?: string | null;
  headerRequestId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number | null;
  errorCode?: string;
}>;

export type AdaptiveExternalModelAccounting = Readonly<{
  /** Stable for retries within one exact attempt lease and different across leases. */
  executionScopeId: string;
  reserve(input: AdaptiveExternalModelReservation): Promise<void>;
  settle(input: AdaptiveExternalModelSettlement): Promise<void>;
}>;

export type AdaptiveRepairPlanner = (
  input: AdaptiveRepairPlannerInput,
  options: Readonly<{
    signal?: AbortSignal;
    externalModelAccounting?: AdaptiveExternalModelAccounting;
  }>,
) => Promise<AdaptiveRepairPlannerOutput>;

export type AdaptiveBoundExhaustion =
  | "iterations_per_unit"
  | "total_iterations"
  | "wall_clock"
  | "planner_calls"
  | "model_calls";

export type AdaptiveUnfixableReason =
  | "iterations_per_unit_exhausted"
  | "total_iterations_exhausted"
  | "wall_clock_exhausted"
  | "planner_calls_exhausted"
  | "model_calls_exhausted"
  | "planner_marked_unfixable"
  | "planner_error"
  | "fence_violation"
  | "path_not_allowed"
  | "output_too_large"
  | "cancelled"
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
  /** True only when every planner call supplied internally consistent accounting. */
  complete: boolean;
  /** Independently counted planner invocations, including non-model planners. */
  plannerCalls: number;
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
      /** The first failing objective check that triggered adaptation. */
      triggeredByFailingCommandId: string | null;
      review: AdaptiveRepairReviewEvidence;
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
  onUsageCheckpoint?(usage: AdaptiveRepairUsage): Promise<void>;
  /** Campaign-wide headroom remaining when this loop starts. */
  resourceBudget?: AdaptiveRepairPlannerBudget;
  /** Durable lease-fenced accounting used by planners that call an external model. */
  externalModelAccounting?: AdaptiveExternalModelAccounting;
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

function inferredSemanticCategory(path: string): AdaptiveSemanticCategory {
  const lower = path.toLowerCase();
  if (/(^|\/)(test|tests|spec|specs|__tests__)(\/|$)|\.(test|spec)\./.test(lower)) return "tests";
  if (/(^|\/)(package-lock\.json|package\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(lower)) return "dependencies";
  if (/(^|\/)(readme|docs?)(\.|\/|$)/.test(lower)) return "documentation";
  if (/(^|\/)(security|auth|policy)(\.|\/|$)/.test(lower)) return "security";
  if (/\.(json|ya?ml|toml|ini|config\.[cm]?[jt]s)$/.test(lower) || lower.startsWith(".github/")) return "configuration";
  return "behavior";
}

function normalizedEditReview(
  edit: AdaptiveEdit,
  planRationale: string | undefined,
  failingCommandId: string | null,
): AdaptiveRepairReviewEvidence["edits"][number] {
  const rationale = edit.rationale ?? planRationale ??
    `Update ${edit.path} to satisfy ${failingCommandId ?? "the objective verification"}.`;
  if (!rationale.trim() || Buffer.byteLength(rationale, "utf8") > 2_000) {
    throw new AdaptiveMutationError("fence_violation", `adaptive_review_rationale_invalid:${edit.path}`);
  }
  const semanticCategory = edit.semanticCategory ?? inferredSemanticCategory(edit.path);
  if (!["behavior", "tests", "configuration", "dependencies", "security", "documentation", "other"].includes(semanticCategory)) {
    throw new AdaptiveMutationError("fence_violation", `adaptive_review_category_invalid:${edit.path}`);
  }
  const risk = edit.risk ?? "medium";
  if (!["low", "medium", "high"].includes(risk)) {
    throw new AdaptiveMutationError("fence_violation", `adaptive_review_risk_invalid:${edit.path}`);
  }
  const confidence = edit.confidence ?? 50;
  if (!Number.isSafeInteger(confidence) || confidence < 0 || confidence > 100) {
    throw new AdaptiveMutationError("fence_violation", `adaptive_review_confidence_invalid:${edit.path}`);
  }
  return Object.freeze({ path: edit.path, rationale, semanticCategory, risk, confidence });
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
  constructor(
    readonly reason: "fence_violation" | "path_not_allowed" | "output_too_large",
    message: string,
  ) {
    super(message);
    this.name = "AdaptiveMutationError";
  }
}

class AdaptiveControlError extends Error {
  constructor(readonly reason: "wall_clock" | "cancelled") {
    super(reason === "wall_clock" ? "adaptive_wall_clock_exhausted" : "adaptive_cancelled");
    this.name = "AdaptiveControlError";
  }
}

async function runBoundedOperation<T>(input: Readonly<{
  operation: (signal: AbortSignal) => Promise<T>;
  signal?: AbortSignal;
  remainingMs: number;
}>): Promise<T> {
  if (input.signal?.aborted) throw new AdaptiveControlError("cancelled");
  if (!Number.isFinite(input.remainingMs) || input.remainingMs <= 0) {
    throw new AdaptiveControlError("wall_clock");
  }

  const controller = new AbortController();
  let disposition: "wall_clock" | "cancelled" = "wall_clock";
  const forwardCancellation = () => {
    disposition = "cancelled";
    controller.abort(input.signal?.reason);
  };
  input.signal?.addEventListener("abort", forwardCancellation, { once: true });
  const timeout = setTimeout(() => {
    disposition = "wall_clock";
    controller.abort(new Error("adaptive_wall_clock_exhausted"));
  }, Math.max(1, Math.ceil(input.remainingMs)));

  let rejectOnAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(new AdaptiveControlError(disposition));
    controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([input.operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", forwardCancellation);
    if (rejectOnAbort) controller.signal.removeEventListener("abort", rejectOnAbort);
  }
}

function candidateBytes(files: Record<string, string>, bounds: AdaptiveRepairBounds): void {
  let total = 0;
  for (const [path, content] of Object.entries(files)) {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > bounds.maxCandidateFileBytes) {
      throw new AdaptiveMutationError("output_too_large", `adaptive_candidate_file_too_large:${path}`);
    }
    total += bytes;
    if (total > bounds.maxCandidateBytes) {
      throw new AdaptiveMutationError("output_too_large", "adaptive_candidate_too_large");
    }
  }
}

function applyEdits(
  working: Record<string, string>,
  edits: readonly AdaptiveEdit[],
  allowed: ReadonlySet<string>,
  bounds: AdaptiveRepairBounds,
): Record<string, string> {
  const next = { ...working };
  for (const edit of edits) {
    if (!allowed.has(edit.path)) {
      throw new AdaptiveMutationError("path_not_allowed", `adaptive_path_not_allowed:${edit.path}`);
    }
    const current = next[edit.path];
    // Read-before-write exact content fence: reject if the file changed since
    // the planner observed it. An explicitly allowlisted absent path is observed
    // as empty, which permits bounded new-file creation without weakening the
    // fence for existing content.
    if (edit.observedContentDigest !== sha256(current ?? "")) {
      throw new AdaptiveMutationError("fence_violation", `adaptive_fence_violation:${edit.path}`);
    }
    if (typeof edit.nextContent !== "string") {
      throw new AdaptiveMutationError("fence_violation", `adaptive_content_invalid:${edit.path}`);
    }
    next[edit.path] = edit.nextContent;
  }
  candidateBytes(next, bounds);
  return next;
}

function emptyUsage(): {
  complete: boolean;
  plannerCalls: number;
  measured: boolean;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
} {
  return {
    complete: true,
    plannerCalls: 0,
    measured: false,
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

function finalizeUsage(usage: ReturnType<typeof emptyUsage>): AdaptiveRepairUsage {
  if (!usage.complete) {
    return Object.freeze({
      complete: false,
      plannerCalls: usage.plannerCalls,
      measured: false,
      modelCalls: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      costUsd: null,
    });
  }
  return Object.freeze({
    complete: true,
    plannerCalls: usage.plannerCalls,
    measured: usage.modelCalls > 0,
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
  if (!reported) {
    usage.complete = false;
    return;
  }
  if (!reported.modelCalled) return;
  const promptTokens = reported.promptTokens;
  const completionTokens = reported.completionTokens;
  const totalTokens = reported.totalTokens;
  const costUsd = reported.costUsd;
  if (
    !Number.isSafeInteger(promptTokens) || promptTokens! < 0 ||
    !Number.isSafeInteger(completionTokens) || completionTokens! < 0 ||
    !Number.isSafeInteger(totalTokens) || totalTokens! < 0 ||
    totalTokens !== promptTokens! + completionTokens! ||
    typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0
  ) {
    usage.complete = false;
    return;
  }
  usage.measured = true;
  usage.modelCalls += 1;
  usage.promptTokens += promptTokens!;
  usage.completionTokens += completionTokens!;
  usage.totalTokens += totalTokens!;
  usage.costUsd += costUsd;
}

function reasonForBound(bound: AdaptiveBoundExhaustion): AdaptiveUnfixableReason {
  switch (bound) {
    case "iterations_per_unit":
      return "iterations_per_unit_exhausted";
    case "total_iterations":
      return "total_iterations_exhausted";
    case "wall_clock":
      return "wall_clock_exhausted";
    case "planner_calls":
      return "planner_calls_exhausted";
    case "model_calls":
      return "model_calls_exhausted";
  }
}

function remainingPlannerBudget(
  budget: AdaptiveRepairPlannerBudget | undefined,
  usage: ReturnType<typeof emptyUsage>,
  bounds: AdaptiveRepairBounds,
): AdaptiveRepairPlannerBudget | undefined {
  if (!budget) return undefined;
  return Object.freeze({
    plannerCalls: Math.max(
      0,
      Math.min(budget.plannerCalls, bounds.maxPlannerCalls) - usage.plannerCalls,
    ),
    modelCalls: Math.max(
      0,
      Math.min(budget.modelCalls, bounds.maxModelCalls) - usage.modelCalls,
    ),
    inputTokens: Math.max(0, budget.inputTokens - usage.promptTokens),
    outputTokens: Math.max(0, budget.outputTokens - usage.completionTokens),
    totalTokens: Math.max(0, budget.totalTokens - usage.totalTokens),
    actualCostUsd: Math.max(0, budget.actualCostUsd - usage.costUsd),
  });
}

export async function runAdaptiveRepairLoop(
  input: RunAdaptiveRepairLoopInput,
): Promise<AdaptiveRepairOutcome> {
  const bounds = resolveBounds(input.bounds);
  const now = input.now ?? Date.now;
  const started = now();
  const allowed = new Set(input.allowedMutationPaths);
  if (allowed.size === 0) throw new Error("adaptive_allowed_paths_required");
  normalizeFiles(Object.fromEntries([...allowed].map((path) => [path, ""])));
  const priorTotal = Math.max(0, input.priorTotalIterations ?? 0);
  const usage = emptyUsage();

  const recipeFiles = Object.freeze({ ...input.recipeFiles });
  let working = normalizeFiles(recipeFiles);
  normalizeFiles(input.sourceFiles);

  const remainingMs = () => bounds.wallClockBudgetMs - (now() - started);
  const controlOutcome = (
    control: AdaptiveControlError,
    failure: AdaptiveVerifierResult | null = null,
  ): AdaptiveRepairOutcome => {
    const wallClock = control.reason === "wall_clock";
    const marker: AdaptiveUnfixableMarker = Object.freeze({
      schemaVersion: 1,
      kind: "transformer.adaptive.unfixable",
      unitId: input.unitId,
      reason: wallClock ? "wall_clock_exhausted" : "cancelled",
      boundExhausted: wallClock ? "wall_clock" : null,
      failingCommandId: failure?.failingCommandId ?? null,
      verifierOutputDigest: sha256(failure?.output ?? ""),
      iterationsUsed: 0,
      bestAttempt: null,
    });
    return Object.freeze({
      status: "unfixable",
      marker,
      files: recipeFiles,
      bestAttemptFiles: null,
      iterationsUsed: 0,
      usage: finalizeUsage(usage),
      boundExhausted: wallClock ? "wall_clock" : null,
    });
  };

  try {
    candidateBytes(working, bounds);
  } catch (error) {
    if (!(error instanceof AdaptiveMutationError) || error.reason !== "output_too_large") {
      throw error;
    }
    const marker: AdaptiveUnfixableMarker = Object.freeze({
      schemaVersion: 1,
      kind: "transformer.adaptive.unfixable",
      unitId: input.unitId,
      reason: "output_too_large",
      boundExhausted: null,
      failingCommandId: null,
      verifierOutputDigest: sha256(""),
      iterationsUsed: 0,
      bestAttempt: null,
    });
    return Object.freeze({
      status: "unfixable",
      marker,
      files: recipeFiles,
      bestAttemptFiles: null,
      iterationsUsed: 0,
      usage: finalizeUsage(usage),
      boundExhausted: null,
    });
  }

  let initial: AdaptiveVerifierResult;
  try {
    initial = await runBoundedOperation({
      operation: async (signal) => await input.gate(recipeFiles, { signal }),
      signal: input.signal,
      remainingMs: remainingMs(),
    });
  } catch (error) {
    if (error instanceof AdaptiveControlError) return controlOutcome(error);
    throw error;
  }
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
    let baseline: AdaptiveVerifierResult;
    try {
      baseline = await runBoundedOperation({
        operation: async (signal) => await input.baselineGate!(input.sourceFiles, { signal }),
        signal: input.signal,
        remainingMs: remainingMs(),
      });
    } catch (error) {
      if (error instanceof AdaptiveControlError) return controlOutcome(error, initial);
      throw error;
    }
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
  const reviewByPath = new Map<string, AdaptiveRepairReviewEvidence["edits"][number]>();
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
    if (usage.plannerCalls >= bounds.maxPlannerCalls) {
      boundExhausted = "planner_calls";
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
      const budget = remainingPlannerBudget(input.resourceBudget, usage, bounds);
      usage.plannerCalls += 1;
      output = await runBoundedOperation({
        operation: async (signal) => await input.planner(
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
            ...(budget ? { budget } : {}),
          }),
          {
            signal,
            ...(input.externalModelAccounting
              ? { externalModelAccounting: input.externalModelAccounting }
              : {}),
          },
        ),
        signal: input.signal,
        remainingMs: remainingMs(),
      });
    } catch (error) {
      usage.complete = false;
      if (error instanceof AdaptiveControlError) {
        if (error.reason === "wall_clock") boundExhausted = "wall_clock";
        else unfixableReason = "cancelled";
        break;
      }
      unfixableReason = "planner_error";
      break;
    }
    if (remainingMs() <= 0) {
      boundExhausted = "wall_clock";
      break;
    }
    accumulateUsage(usage, output.usage);
    if (usage.modelCalls > bounds.maxModelCalls) {
      boundExhausted = "model_calls";
    }
    if (input.onUsageCheckpoint) {
      try {
        await input.onUsageCheckpoint(finalizeUsage(usage));
      } catch (error) {
        throw error;
      }
    }
    if (boundExhausted === "model_calls") break;

    const plan = output.plan;
    if (plan.markUnfixable) {
      unfixableReason = "planner_marked_unfixable";
      break;
    }

    let candidate: Record<string, string>;
    try {
      candidate = applyEdits(working, plan.edits, allowed, bounds);
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

    for (const edit of plan.edits) {
      if (working[edit.path] !== candidate[edit.path]) {
        reviewByPath.set(edit.path, normalizedEditReview(edit, plan.rationale, lastFailure.failingCommandId));
      }
    }

    let result: AdaptiveVerifierResult;
    try {
      result = await runBoundedOperation({
        operation: async (signal) => await input.gate(candidate, { signal }),
        signal: input.signal,
        remainingMs: remainingMs(),
      });
    } catch (error) {
      if (error instanceof AdaptiveControlError) {
        if (error.reason === "wall_clock") boundExhausted = "wall_clock";
        else unfixableReason = "cancelled";
        break;
      }
      throw error;
    }
    if (result.passed) {
      const changedPaths = changedPathsBetween(recipeFiles, candidate);
      const files = Object.freeze({ ...candidate });
      const edits = changedPaths.map((path) => {
        const review = reviewByPath.get(path);
        if (!review) throw new Error(`adaptive_review_evidence_missing:${path}`);
        return review;
      });
      const riskRank = { low: 0, medium: 1, high: 2 } as const;
      const overallRisk = edits.reduce<AdaptiveReviewRisk>(
        (highest, edit) => riskRank[edit.risk] > riskRank[highest] ? edit.risk : highest,
        "low",
      );
      return Object.freeze({
        status: "converged",
        files,
        outputDigest: recipeFilesDigest(files),
        changedPaths: Object.freeze(changedPaths),
        triggeredByFailingCommandId: initial.failingCommandId,
        review: Object.freeze({
          edits: Object.freeze(edits),
          verification: Object.freeze({
            passed: true,
            commandId: initial.failingCommandId ?? "objective-verification",
            summary: "The objective verification passed on the final adaptive candidate.",
            outputDigest: sha256(result.output),
          }),
          overallRisk,
          confidence: edits.reduce((minimum, edit) => Math.min(minimum, edit.confidence), 100),
        }),
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
