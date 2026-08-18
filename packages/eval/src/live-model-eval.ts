import { buildLiveModelProvenance, type LiveModelProvenanceRecord } from "@mendpoint/agent";
import {
  resolveLlmConfirmMode,
  type LlmCallObservation,
} from "@mendpoint/code-impact";

export const LIVE_MODEL_EVIDENCE_VERSION = "2026-08-05.v1" as const;

/**
 * Default approved live model. The design-partner preview runs on Meta's Muse
 * Spark contributor tier (an explicit operator opt-in where prompts and
 * completions may be used for provider training). Override with
 * MENDPOINT_LIVE_APPROVED_MODEL so a policy change is a config change.
 */
export const DEFAULT_APPROVED_LIVE_MODEL = "muse-spark-1.2-contributor";

/** Resolve the single approved live model id from configuration. */
export function resolveApprovedLiveModel(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.MENDPOINT_LIVE_APPROVED_MODEL?.trim() || DEFAULT_APPROVED_LIVE_MODEL;
}

/** The approved live provider identity a run's provenance must match exactly. */
export type LiveModelApprovedConfig = Readonly<{
  /** Approved endpoint host (host:port), matched exactly. */
  host: string;
  /** Approved exact model id, matched against the echoed model. */
  model: string;
}>;

/**
 * The live lane is READY (a real, paid model call can and should be made) only
 * when every precondition is satisfied. Otherwise it is SKIPPED with a stated
 * reason and the lane is recorded as "not measured" — the harness never quietly
 * runs the deterministic/heuristic path and reports its numbers as live.
 */
export type LiveLaneReadyConfig = Readonly<{
  status: "ready";
  /** Identity the run's provenance must match exactly. */
  approved: LiveModelApprovedConfig;
  /** Model id the confirm path will request (LLM_CONFIRM_MODEL), if set. */
  requestedModel: string | null;
}>;

export type LiveLaneSkip = Readonly<{
  status: "skipped";
  reason: string;
}>;

export type LiveLaneConfig = LiveLaneReadyConfig | LiveLaneSkip;

/**
 * Decide whether the live-model lane can run from configuration alone (no
 * network). Fails honestly: any missing precondition returns a skip with a
 * stated reason rather than allowing a run that would silently measure the
 * deterministic path.
 *
 * Preconditions:
 *  - MENDPOINT_LIVE_APPROVED_HOST pins the endpoint host the provenance must match.
 *  - The impact confirm path resolves to LIVE mode (LLM_CONFIRM_MODE=live or
 *    LLM_CONFIRM=1) AND an API key is present — otherwise the confirm path would
 *    run the offline heuristic and never call a model.
 */
export function resolveLiveLaneConfig(
  env: NodeJS.ProcessEnv = process.env,
): LiveLaneConfig {
  const model = resolveApprovedLiveModel(env);
  const host = env.MENDPOINT_LIVE_APPROVED_HOST?.trim();
  if (!host) {
    return {
      status: "skipped",
      reason:
        "MENDPOINT_LIVE_APPROVED_HOST is not set; the approved endpoint host must be pinned before a live run (not measured)",
    };
  }
  const mode = resolveLlmConfirmMode(env);
  if (mode !== "live") {
    return {
      status: "skipped",
      reason:
        `impact confirm live mode is not active (resolved '${mode}'): set LLM_CONFIRM_MODE=live ` +
        "(or LLM_CONFIRM=1) and provide an API key (OPENAI_API_KEY or XAI_API_KEY). Refusing to run " +
        "the offline heuristic path and report it as live (not measured)",
    };
  }
  const requestedModel = env.LLM_CONFIRM_MODEL?.trim() || null;
  return { status: "ready", approved: { host, model }, requestedModel };
}

/**
 * Build a machine-verifiable provenance record from a single observed live
 * call. Delegates to the agent's `buildLiveModelProvenance` so the eval lane and
 * the production path attribute calls identically (echoed model, tokens, host,
 * cost, request id).
 */
export function liveModelRecordFromObservation(
  observation: LlmCallObservation,
  priceTable?: Parameters<typeof buildLiveModelProvenance>[0]["priceTable"],
): LiveModelProvenanceRecord {
  return buildLiveModelProvenance({
    url: observation.url,
    headerRequestId: observation.headerRequestId,
    providerId: null,
    body: observation.body,
    ...(priceTable ? { priceTable } : {}),
  });
}

export type LiveModelGrade = Readonly<{
  id: string;
  passed: boolean;
  expected: string;
  observed: string;
}>;

export type LiveModelGradeResult = Readonly<{
  version: typeof LIVE_MODEL_EVIDENCE_VERSION;
  passed: boolean;
  grades: readonly LiveModelGrade[];
}>;

export type LiveModelGradeInput = Readonly<{
  approved: LiveModelApprovedConfig;
  provenance: readonly LiveModelProvenanceRecord[];
  /** Planner source of every model-driven step in the graded run. */
  plannerSources: readonly string[];
  /** Whether the harness injected a scripted planner for this scenario. */
  scriptedPlannerInjected: boolean;
}>;

function grade(
  id: string,
  passed: boolean,
  expected: unknown,
  observed: unknown,
): LiveModelGrade {
  const render = (value: unknown) =>
    typeof value === "string" ? value : JSON.stringify(value);
  return Object.freeze({ id, passed, expected: render(expected), observed: render(observed) });
}

function hasRequestId(record: LiveModelProvenanceRecord): boolean {
  return Boolean(
    (record.bodyRequestId && record.bodyRequestId.length > 0) ||
    (record.headerRequestId && record.headerRequestId.length > 0),
  );
}

/**
 * Machine verification for the live_model evidence lane.
 *
 * Passes ONLY when every condition holds: the provider host and echoed model
 * match the approved identity exactly, every call carries a nonempty request
 * id, token usage is nonzero and internally consistent, transport was https,
 * cost was computed, the graded steps were planned by the live model, and no
 * scripted planner was injected. Any failure fails the lane closed — the
 * caller must never downgrade to another lane.
 */
export function gradeLiveModelProvenance(
  input: LiveModelGradeInput,
): LiveModelGradeResult {
  const records = input.provenance;
  const hasRecords = records.length > 0;
  const observedHosts = records.map((record) => record.host);
  const observedModels = records.map((record) => record.model);

  const grades: readonly LiveModelGrade[] = Object.freeze([
    grade("provenance.present", hasRecords, "at least one call", records.length),
    grade(
      "provider.host_match",
      hasRecords && records.every((record) => record.host === input.approved.host),
      input.approved.host,
      observedHosts,
    ),
    grade(
      "model.exact_echo",
      hasRecords && records.every((record) => record.model === input.approved.model),
      input.approved.model,
      observedModels,
    ),
    grade(
      "request_id.present",
      hasRecords && records.every(hasRequestId),
      "nonempty body or header request id per call",
      records.map((record) => ({
        body: record.bodyRequestId,
        header: record.headerRequestId,
      })),
    ),
    grade(
      "tokens.nonzero",
      hasRecords && records.every((record) =>
        record.promptTokens > 0 && record.completionTokens > 0 && record.totalTokens > 0),
      "prompt, completion, and total tokens all greater than zero",
      records.map((record) => ({
        prompt: record.promptTokens,
        completion: record.completionTokens,
        total: record.totalTokens,
      })),
    ),
    grade(
      "tokens.consistent",
      hasRecords && records.every((record) =>
        record.totalTokens <= 0 ||
        record.promptTokens + record.completionTokens === record.totalTokens),
      "prompt + completion === total when total present",
      records.map((record) => ({
        sum: record.promptTokens + record.completionTokens,
        total: record.totalTokens,
      })),
    ),
    grade(
      "transport.https",
      hasRecords && records.every((record) => record.protocol === "https:"),
      "https:",
      records.map((record) => record.protocol),
    ),
    grade(
      "cost.present",
      hasRecords && records.every((record) => record.costUsd !== null),
      "computed cost for every call",
      records.map((record) => record.costUsd),
    ),
    grade(
      "planner.model_source",
      input.plannerSources.length > 0 &&
        input.plannerSources.every((source) => source === "model"),
      "every graded step planned by the live model",
      input.plannerSources,
    ),
    grade(
      "planner.no_scripted_injection",
      input.scriptedPlannerInjected === false,
      "no scripted planner injected",
      input.scriptedPlannerInjected,
    ),
  ]);

  return Object.freeze({
    version: LIVE_MODEL_EVIDENCE_VERSION,
    passed: grades.every((candidate) => candidate.passed),
    grades,
  });
}
