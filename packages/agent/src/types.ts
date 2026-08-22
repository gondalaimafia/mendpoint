/**
 * Warden — Mendpoint's debug agent for API-related bugs.
 * Tool-using loop: observe → think → act → verify. Never auto-merges.
 */

export type ToolName =
  | "list_dir"
  | "read_file"
  | "search"
  | "write_file"
  | "replace_in_file"
  | "delete_file"
  | "run_command"
  | "http_probe"
  | "finish";

export type ToolCall = {
  tool: ToolName;
  args: Record<string, unknown>;
  thought?: string;
  /** Required, state-bound justification for every planner or model mutation. */
  intent?: AgentExecutionIntent;
};

export type AgentExecutionIntentRisk = "low" | "medium" | "high" | "critical";

export type AgentExecutionIntentEvidence = Readonly<{
  path: string;
  digest: string;
}>;

/**
 * Versioned evidence contract that authorizes one exact repository mutation.
 * The runtime supplies `assessmentSource`; planners cannot self-attribute it.
 */
export type AgentExecutionIntent = Readonly<{
  schemaVersion: 1;
  hypothesis: string;
  targetPath: string;
  targetSymbol: string | null;
  targetDigest: string;
  evidenceRefs: readonly AgentExecutionIntentEvidence[];
  precondition: string;
  expectedObservation: string;
  postcondition: string;
  rollback: string;
  confidence: number;
  risk: AgentExecutionIntentRisk;
  stopCondition: string;
  assessmentSource: "model" | "heuristic";
  /** Runtime-created digest of the exact mutation tool, target, and arguments. */
  operationDigest?: string;
  /** Runtime-created digest of the exact bytes expected after the mutation. */
  expectedResultDigest?: string;
}>;

export type ToolResult = {
  ok: boolean;
  tool: ToolName;
  summary: string;
  data?: unknown;
  error?: string;
};

export type AgentStep = {
  step: number;
  thought: string;
  call: ToolCall;
  result: ToolResult;
  plannerSource?: "model" | "heuristic" | "system";
};

export type AgentMissionPlanActionStatus = "planned" | "succeeded" | "failed";

export type AgentMissionPlanRevision = Readonly<{
  revision: number;
  parentRevision: number | null;
  plannerEffectId: string;
  plannerRequestDigest: string;
  hypothesis: string;
  evidenceRefs: readonly AgentExecutionIntentEvidence[];
  verifierFeedbackDigest: string | null;
  confidence: number | null;
  risk: AgentExecutionIntentRisk | null;
  acceptanceChecks: Readonly<{
    precondition: string;
    expectedObservation: string;
    postcondition: string;
    stopCondition: string;
  }>;
  action: Readonly<{
    tool: ToolName;
    targetPath: string | null;
    callDigest: string;
    status: AgentMissionPlanActionStatus;
    resultDigest?: string;
  }>;
}>;

export type AgentMissionPlan = Readonly<{
  schemaVersion: 1;
  goalDigest: string;
  activeRevision: number;
  outcome: "in_progress" | "verified" | "failed";
  blockerReason: string | null;
  revisions: readonly AgentMissionPlanRevision[];
}>;

export type AgentPlannerObservation = Readonly<{
  step: number;
  tool: ToolName;
  ok: boolean;
  summary: string;
  error?: string;
  /** Redacted, bounded, and explicitly untrusted source or tool evidence. */
  evidence?: string;
}>;

export type AgentPlannerInput = Readonly<{
  schemaVersion: 1;
  taskMode: AgentTaskMode;
  goal: string;
  errorLog?: string;
  verifyCommand: string;
  diagnosedModes: readonly Readonly<{
    id: string;
    category: string;
    title: string;
    clientFix: string;
  }>[];
  recentSteps: readonly AgentPlannerObservation[];
  /** Current bounded candidate-state digests available for execution intent citation. */
  observedEvidenceDigests?: readonly AgentExecutionIntentEvidence[];
}>;

export type AgentTaskMode = "repair" | "feature";

export type AgentPlannerUsage = Readonly<{
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  model?: string;
  modelRevision?: string;
}>;

export type AgentPlannerOutput = Readonly<{
  call: unknown;
  usage?: AgentPlannerUsage;
}>;

export type AgentPlanner = (
  input: AgentPlannerInput,
  options: Readonly<{ signal: AbortSignal }>,
) => Promise<AgentPlannerOutput>;

export type AgentSourceContextBudget = Readonly<{
  maxFileBytes: number;
  maxTotalReadBytes: number;
  maxSearchFiles: number;
  maxSearchBytes: number;
  maxSearchHits: number;
  maxPromptEvidenceBytes: number;
  maxChangedFiles: number;
  maxChangedBytes: number;
  /**
   * Maximum directory recursion depth for the search and list walkers. Optional
   * for backward compatibility; walkers fall back to a safe default when unset.
   * Driven from the attempt tree-depth limit so raising the file ceiling also
   * raises search coverage instead of silently truncating deep trees.
   */
  maxSearchDepth?: number;
}>;

export type AgentModelSourcePolicy = Readonly<{
  approved: boolean;
  tenantId: string;
  policyDigest: string;
  provider: string;
  model: string;
  endpoint: string;
}>;

export type AgentExternalModelReservation = Readonly<{
  reservationId: string;
  callIndex: number;
  requestDigest: string;
  provider: string;
  configuredModel: string;
  endpointHost: string;
  maximumInputTokens: number;
  maximumOutputTokens: number;
  maximumTotalTokens: number;
  maximumCostUsd: number;
}>;

export type AgentExternalModelSettlement = Readonly<{
  reservationId: string;
  status: "succeeded" | "failed";
  actualModel?: string | null;
  bodyRequestId?: string | null;
  headerRequestId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number | null;
  errorCode?: string;
}>;

export type AgentExternalModelAccounting = Readonly<{
  executionScopeId: string;
  maximumCostUsd: number;
  reserve: (reservation: AgentExternalModelReservation) => Promise<void>;
  settle: (settlement: AgentExternalModelSettlement) => Promise<void>;
}>;

/**
 * Compiled inherited context, injected into the model system prompt at the model
 * seam (`llmSuggestTool`). The agent is DB-free, so this is produced UPSTREAM by
 * the Mission Context Compiler (`@mendpoint/pipeline`) and travels in on the task.
 *
 * `promptBody` is the compiler's already-bounded, section-labelled rendering of
 * the inherited-context envelope. The agent NEVER trusts it: it re-verifies the
 * digest and byte bound, then wraps it in an explicit untrusted-data frame before
 * it can reach a model (`renderInheritedContextSystemBlock`). It carries only
 * references and digests of the context that was supplied, never model reasoning.
 */
export type InheritedContextInjection = Readonly<{
  schemaVersion: "mendpoint.inherited-context.v1";
  /** sha256 of `promptBody`, re-checked at the seam; a mismatch drops the block. */
  digest: string;
  /** Compiler-rendered, bounded, section-labelled context text. */
  promptBody: string;
  /** Number of envelope sections rendered into `promptBody` (diagnostics only). */
  sectionCount: number;
  /** UTF-8 byte length of `promptBody`, re-checked against the seam ceiling. */
  byteLength: number;
}>;

export type AgentTask = {
  /** Natural language bug report / goal */
  goal: string;
  /** Explicit execution contract. Missing remains repair for compatibility. */
  taskMode?: AgentTaskMode;
  /** Tenant binding required for any externally transmitted source context. */
  tenantId?: string;
  /** Working directory (repo or subfolder) */
  repoRoot: string;
  /** Command that should pass when fixed (exit 0) */
  verifyCommand?: string;
  /** Optional seed error log */
  errorLog?: string;
  maxSteps?: number;
  dryRun?: boolean;
  neverTouchPaths?: string[];
  /** Paths the agent may inspect and search but must never mutate. */
  readOnlyPaths?: string[];
  /** Allow network for http_probe (default false in tests) */
  allowNetwork?: boolean;
  /** Optional LLM planner */
  useLlm?: boolean;
  /** Provider independent planner used by production adapters and eval harnesses. */
  planner?: AgentPlanner;
  /** Require a successful model plan instead of falling back to heuristics. */
  modelRequired?: boolean;
  /** Allow redacted source excerpts in the model evidence packet. Default false. */
  allowModelSource?: boolean;
  /** Required authorization evidence whenever source leaves the execution boundary. */
  modelSourcePolicy?: AgentModelSourcePolicy;
  /** Fail closed repository and context ceilings. */
  sourceContextBudget?: Partial<AgentSourceContextBudget>;
  /** Require source observation and exact content fencing before mutation. Default true. */
  requireSourceObservation?: boolean;
  /** Fail closed limits for the optional model planner. */
  modelBudget?: Partial<AgentModelBudget>;
  /** Durable reserve/settle boundary required before externally approved model calls. */
  externalModelAccounting?: AgentExternalModelAccounting;
  sessionId?: string;
  /**
   * Compiled inherited context to inject into the model system prompt. Produced
   * upstream by the Mission Context Compiler. Injection is gated behind a
   * default-off switch (`MENDPOINT_INHERITED_CONTEXT`) and re-verified at the
   * seam; when absent, the prompt is byte-for-byte today's constant.
   */
  inheritedContext?: InheritedContextInjection;
  /** Cooperative cancellation checked around every awaited or mutating phase. */
  shouldContinue?: () => boolean;
};

export type AgentModelBudget = Readonly<{
  maxCalls: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  maxOutputTokens: number;
}>;

/**
 * Machine-verifiable provenance for a single successful live provider call.
 * Every field is captured from what actually happened on the wire (not from
 * the request we intended), so a live evidence lane can prove the call.
 */
export type LiveModelProvenanceRecord = Readonly<{
  /** Gateway provider id that served the call (null for legacy default path). */
  providerId: string | null;
  /** OpenAI-compatible response body `id` (null when the body omits it). */
  bodyRequestId: string | null;
  /** `x-request-id` response header (null when the provider omits it). */
  headerRequestId: string | null;
  /** Exact `model` echoed by the response body, never the requested id. */
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Host of the endpoint actually contacted. */
  host: string;
  /** Transport protocol actually used (must be `https:` to be valid). */
  protocol: string;
  /** Cost from the configured price table, or null for an unpriced model. */
  costUsd: number | null;
  /** Monotonic clock reading (ms) captured when the response was parsed. */
  monotonicTimestampMs: number;
}>;

export type AgentExecutionMetrics = Readonly<{
  durationMs: number;
  toolCalls: number;
  verifierCalls: number;
  model: Readonly<{
    calls: number;
    successfulCalls: number;
    failedCalls: number;
    timeouts: number;
    invalidResponses: number;
    responseBytes: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
    /** Bounded, per-call live provenance records (rolled-up totals above). */
    provenance: readonly LiveModelProvenanceRecord[];
  }>;
  sourceContext: Readonly<{
    observedFiles: readonly string[];
    observedDirectories: readonly string[];
    searches: readonly string[];
    observedBytes: number;
    promptEvidenceBytes: number;
    truncatedObservations: number;
    groundedMutations: number;
    blockedMutations: number;
    evidenceDigests: readonly Readonly<{ path: string; digest: string }>[];
  }>;
}>;

export type AgentVerifierState = {
  command?: string;
  source: "provided" | "discovered" | "none";
  /**
   * `not_verified` means verification was attempted but could not run (containment
   * refused or approval gate) — distinct from `failed` (the command ran and did
   * not pass) and from `not_run` (verification was never attempted).
   */
  status: "not_run" | "passed" | "failed" | "simulated" | "invalid" | "not_verified";
  output?: string;
};

export type AgentRollbackState = {
  performed: boolean;
  restoredFiles: string[];
  failedFiles: string[];
};

export type AgentRunResult = {
  sessionId: string;
  ok: boolean;
  goal: string;
  steps: AgentStep[];
  filesChanged: string[];
  verifyOutput?: string;
  verifier: AgentVerifierState;
  rollback: AgentRollbackState;
  reportMarkdown: string;
  stoppedReason: string;
  metrics: AgentExecutionMetrics;
  /** Authenticated model plan lineage when the durable runtime is active. */
  missionPlan: AgentMissionPlan | null;
};
