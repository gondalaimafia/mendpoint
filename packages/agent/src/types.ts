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
};

export type AgentTask = {
  /** Natural language bug report / goal */
  goal: string;
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
  sessionId?: string;
  /** Cooperative cancellation checked around every awaited or mutating phase. */
  shouldContinue?: () => boolean;
};

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
};
