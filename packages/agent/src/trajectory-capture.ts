/**
 * Warden attempt trajectory capture (Intelligence Ownership Phases 4 + 7).
 *
 * This module builds a serializable OBSERVATION DTO from the live
 * `AgentRunResult` at the point in the attempt engine where the full detail
 * still exists — BEFORE `agentEvidence` reduces `AgentRunResult.steps` to
 * counts. The DTO travels out through `WardenAttemptResult` so the worker (which
 * holds the `@mendpoint/db` handle the agent package cannot import) can persist
 * it with the `packages/db/src/trajectory.ts` primitives.
 *
 * Two hard rules, enforced HERE at the producer:
 *   1. NEVER capture hidden chain-of-thought (spec 8.12). The agent's per-step
 *      `thought` and the model's private reasoning are deliberately dropped. Only
 *      observable inputs (the assembled context) and observable outputs (the
 *      produced change, the tool arguments the model chose, and tool results) are
 *      carried. `reportMarkdown` is NOT captured because its Trace section quotes
 *      `step.thought`.
 *   2. Redaction is the store's job, not skipped here. Every text payload in this
 *      DTO is handed to `putTrajectoryBlob`, which runs `redactSourceForModel` and
 *      fails closed. This module never persists anything itself; it only shapes
 *      observable text so the store can redact and content-address it.
 */
import type { ObservedVerificationCommand } from "@mendpoint/shared";
import type { AgentRunResult, AgentTaskMode, ToolFailureClass, ToolName } from "./types.js";

/** Warden offers this fixed tool universe (mirrors agent.ts TOOL_NAMES). */
const WARDEN_TOOL_UNIVERSE: readonly ToolName[] = [
  "list_dir",
  "read_file",
  "search",
  "write_file",
  "replace_in_file",
  "delete_file",
  "run_command",
  "http_probe",
  "finish",
];

const MUTATION_TOOL_NAMES: ReadonlySet<ToolName> = new Set([
  "write_file",
  "replace_in_file",
  "delete_file",
]);

/**
 * The tools that were actually AVAILABLE to the agent for this task, derived from
 * observable task flags: `http_probe` only when network is allowed, mutation
 * tools only when the run is not a dry run.
 */
export function wardenAvailableTools(
  flags: { allowNetwork?: boolean; dryRun?: boolean },
): readonly string[] {
  return WARDEN_TOOL_UNIVERSE.filter((tool) => {
    if (tool === "http_probe") return flags.allowNetwork === true;
    if (MUTATION_TOOL_NAMES.has(tool)) return flags.dryRun !== true;
    return true;
  });
}

export type WardenCaptureToolStep = Readonly<{
  stepIndex: number;
  toolName: string;
  /** JSON of the observable tool arguments the agent invoked (no thought). */
  args: string;
  /** JSON of the observable tool result (ok/summary/data/error, no thought). */
  result: string;
  ok: boolean;
  error: string | null;
  /** Typed reason for `ok: false`; null on success (never a default). */
  failureClass: ToolFailureClass | null;
  plannerSource: string | null;
}>;

/**
 * The redacted verification projection carried on the capture DTO and persisted
 * as a trajectory verification step. It records a three-state `verdict` derived
 * from the observed {@link ObservedVerificationCommand} `outcome`, so a refusal
 * (`not_verified`) never reads as a test failure. The builder maps observed runs
 * into this shape; the trajectory persister and DB contract read `verdict`.
 */
export type WardenCaptureVerification = Readonly<{
  verdict: string;
  exitCode: number | null;
  command: string | null;
  sandboxBackend: string | null;
}>;

/**
 * Project an observed verification run onto the redacted trajectory verdict
 * vocabulary. The three observed states map one-to-one: `verified` -> "passed",
 * `failed` -> "failed", `not_verified` -> "not_verified". A failure and a
 * refusal therefore stay distinguishable at the persisted layer instead of
 * collapsing into one another.
 */
function toCaptureVerification(observed: ObservedVerificationCommand): WardenCaptureVerification {
  return Object.freeze({
    verdict:
      observed.outcome === "verified"
        ? "passed"
        : observed.outcome === "failed"
          ? "failed"
          : "not_verified",
    exitCode: observed.exitCode,
    command: observed.command,
    sandboxBackend: observed.sandboxBackend,
  });
}

export type WardenCaptureModelProvenanceRecord = Readonly<{
  /** Exact model echoed by the provider response body (never the requested id). */
  model: string;
  providerId: string | null;
  host: string;
  protocol: string;
  bodyRequestId: string | null;
  headerRequestId: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
}>;

/**
 * The serializable observation of one Warden attempt. Carried on
 * `WardenAttemptResult.capture` and consumed only by the worker's trajectory
 * persister. Every string field is redacted by the store before it is written.
 */
export type WardenAttemptCapture = Readonly<{
  schemaVersion: 1;
  product: "fettler";
  /** "repair" | "feature". */
  taskKind: string;
  /** The task / goal in natural language. */
  taskSummary: string;
  /** The agent session id (run id). */
  runId: string | null;
  availableTools: readonly string[];
  /** Observable assembled context handed to the run (references + seed, no CoT). */
  assembledContext: string;
  /** Observable produced output (the change + outcome, never reportMarkdown). */
  output: string;
  /** The model that ACTUALLY answered (provider echo), or null for a heuristic run. */
  modelId: string | null;
  /** True when at least one model call was measured (never a fabricated zero). */
  modelMeasured: boolean;
  modelProvenance: readonly WardenCaptureModelProvenanceRecord[];
  toolSteps: readonly WardenCaptureToolStep[];
  verifications: readonly WardenCaptureVerification[];
  sandboxBackend: string | null;
  /** "candidate_ready" or "rejected:<code>". */
  finalOutcome: string;
  costUsd: number | null;
  costMeasured: boolean;
  latencyMs: number | null;
}>;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? "null";
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

function toolStepsFrom(agent: AgentRunResult): WardenCaptureToolStep[] {
  return agent.steps.map((entry, index) => {
    // Observable action only. `entry.thought` and `entry.call.thought` (hidden
    // reasoning) and `entry.call.intent` (planner hypothesis text) are dropped.
    const args = safeJson(entry.call.args);
    const result = safeJson({
      ok: entry.result.ok,
      summary: entry.result.summary,
      data: entry.result.data,
      error: entry.result.error ?? null,
      failureClass: entry.result.failureClass ?? null,
    });
    return Object.freeze({
      stepIndex: index,
      toolName: entry.call.tool,
      args,
      result,
      ok: entry.result.ok,
      error: entry.result.error ?? null,
      failureClass: entry.result.failureClass ?? null,
      plannerSource: entry.plannerSource ?? null,
    });
  });
}

function modelProvenanceFrom(agent: AgentRunResult): WardenCaptureModelProvenanceRecord[] {
  return agent.metrics.model.provenance.map((record) =>
    Object.freeze({
      model: record.model,
      providerId: record.providerId,
      host: record.host,
      protocol: record.protocol,
      bodyRequestId: record.bodyRequestId,
      headerRequestId: record.headerRequestId,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      totalTokens: record.totalTokens,
      costUsd: record.costUsd,
    }),
  );
}

/**
 * Build the observable assembled-context packet. This is what the run was given
 * to work from, expressed as references (paths, digests, searches, byte counts)
 * plus the caller-supplied error seed — never raw source and never reasoning.
 */
function assembledContextFrom(input: {
  goal: string;
  taskMode: AgentTaskMode;
  errorLog?: string | null;
  verifyCommand: string;
  availableTools: readonly string[];
  agent: AgentRunResult;
}): string {
  const context = input.agent.metrics.sourceContext;
  return safeJson({
    goal: input.goal,
    taskMode: input.taskMode,
    errorLog: input.errorLog ?? null,
    verifyCommand: input.verifyCommand,
    availableTools: input.availableTools,
    observedFiles: context.observedFiles,
    observedDirectories: context.observedDirectories,
    searches: context.searches,
    evidenceDigests: context.evidenceDigests,
    observedBytes: context.observedBytes,
    promptEvidenceBytes: context.promptEvidenceBytes,
    truncatedObservations: context.truncatedObservations,
  });
}

/**
 * Build the observable produced-output packet. For a succeeded attempt this is
 * the outcome plus the exact changed-file contents (the store redacts them). It
 * deliberately excludes `reportMarkdown`, which embeds `step.thought`.
 */
function outputFrom(input: {
  agent: AgentRunResult;
  status: "succeeded" | "rejected";
  code?: string | null;
  changedPaths?: readonly string[];
  candidateDigest?: string | null;
  changedFiles?: readonly { path: string; content: string }[];
}): string {
  const agent = input.agent;
  return safeJson({
    ok: input.status === "succeeded",
    status: input.status,
    ...(input.code ? { code: input.code } : {}),
    stoppedReason: agent.stoppedReason,
    filesChanged: [...agent.filesChanged].sort(),
    changedPaths: input.changedPaths ? [...input.changedPaths] : [],
    candidateDigest: input.candidateDigest ?? null,
    verifier: {
      command: agent.verifier.command ?? null,
      source: agent.verifier.source,
      status: agent.verifier.status,
    },
    changedFiles: input.changedFiles ? [...input.changedFiles] : [],
  });
}

/**
 * Assemble the capture DTO from the live agent result. Pure and defensive: it
 * never throws (any per-field failure degrades to a safe default) so building the
 * capture can never break the attempt hot path.
 */
export function buildWardenAttemptCapture(input: {
  agent: AgentRunResult;
  goal: string;
  taskMode: AgentTaskMode;
  errorLog?: string | null;
  verifyCommand: string;
  availableTools: readonly string[];
  runId: string | null;
  sandboxBackend: string | null;
  status: "succeeded" | "rejected";
  code?: string | null;
  changedPaths?: readonly string[];
  candidateDigest?: string | null;
  changedFiles?: readonly { path: string; content: string }[];
  verifications?: readonly ObservedVerificationCommand[];
}): WardenAttemptCapture {
  const agent = input.agent;
  const model = agent.metrics.model;
  const measured = model.calls > 0;
  const provenance = modelProvenanceFrom(agent);
  // The model that ACTUALLY answered: the provider-echoed model from the last
  // live provenance record. Null for a heuristic-only run.
  const lastProvenance = provenance.length ? provenance[provenance.length - 1] : undefined;
  const modelId = lastProvenance ? lastProvenance.model : null;
  return Object.freeze({
    schemaVersion: 1,
    product: "fettler",
    taskKind: input.taskMode,
    taskSummary: input.goal,
    runId: input.runId,
    availableTools: Object.freeze([...input.availableTools]),
    assembledContext: assembledContextFrom({
      goal: input.goal,
      taskMode: input.taskMode,
      errorLog: input.errorLog,
      verifyCommand: input.verifyCommand,
      availableTools: input.availableTools,
      agent,
    }),
    output: outputFrom({
      agent,
      status: input.status,
      code: input.code,
      changedPaths: input.changedPaths,
      candidateDigest: input.candidateDigest,
      changedFiles: input.changedFiles,
    }),
    modelId,
    modelMeasured: measured,
    modelProvenance: Object.freeze(provenance),
    toolSteps: Object.freeze(toolStepsFrom(agent)),
    verifications: Object.freeze((input.verifications ?? []).map(toCaptureVerification)),
    sandboxBackend: input.sandboxBackend,
    finalOutcome:
      input.status === "succeeded" ? "candidate_ready" : `rejected:${input.code ?? "unknown"}`,
    costUsd: measured ? model.costUsd : null,
    costMeasured: measured,
    latencyMs: Number.isFinite(agent.metrics.durationMs) ? agent.metrics.durationMs : null,
  });
}
