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
  | "run_command"
  | "http_probe"
  | "finish";

export type ToolCall = {
  tool: ToolName;
  args: Record<string, unknown>;
  thought?: string;
};

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
}>;

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
}>;

export type AgentModelSourcePolicy = Readonly<{
  approved: boolean;
  tenantId: string;
  policyDigest: string;
  provider: string;
  model: string;
  endpoint: string;
}>;

export type AgentTask = {
  /** Natural language bug report / goal */
  goal: string;
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
  sessionId?: string;
  /** Cooperative cancellation checked around every awaited or mutating phase. */
  shouldContinue?: () => boolean;
};

export type AgentModelBudget = Readonly<{
  maxCalls: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
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
  status: "not_run" | "passed" | "failed" | "simulated" | "invalid";
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
};
