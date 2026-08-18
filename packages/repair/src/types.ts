/**
 * Agentic repair product layer — types.
 * Loop: observe failure → diagnose → plan edits → apply → verify → repeat (bounded).
 * Never auto-merges; never touches denylisted paths without policy.
 */

export type FailureKind =
  | "type_error"
  | "undefined_symbol"
  | "missing_module"
  | "test_assert"
  | "syntax_error"
  | "lint"
  | "api_rename_leftover"
  | "fixme_mendpoint"
  | "unknown";

export type FailureObservation = {
  kind: FailureKind;
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  symbol?: string;
  suggestion?: string;
  raw?: string;
};

export type RepairAction =
  | {
      type: "replace_in_file";
      filePath: string;
      from: string;
      to: string;
      global?: boolean;
      reason: string;
    }
  | {
      type: "write_file";
      filePath: string;
      content: string;
      reason: string;
    }
  | {
      type: "patch_line";
      filePath: string;
      line: number;
      newLine: string;
      reason: string;
    }
  | {
      type: "remove_fixme";
      filePath: string;
      reason: string;
    };

/**
 * Accounting record for a repair model call. `planRepairsWithLlm` egresses to a
 * model outside the agent's reserve/settle boundary (repair cannot import
 * `@mendpoint/agent` without a dependency cycle), so the previously discarded
 * facts of the call — the model that ACTUALLY answered (provider echo) and its
 * token usage — are captured here and carried on the plan. This makes the call
 * observable and accountable in the persisted repair session result instead of a
 * silent, unmetered egress.
 */
export type RepairModelProvenance = {
  /** Exact `model` echoed by the response body, never the requested id. */
  model: string | null;
  host: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** True when the response reported usage (never a fabricated measured zero). */
  measured: boolean;
};

export type RepairPlan = {
  attempt: number;
  observations: FailureObservation[];
  actions: RepairAction[];
  strategy: "deterministic" | "llm" | "hybrid";
  summary: string;
  /** Present only for LLM/hybrid plans that made a model call (accounting). */
  modelProvenance?: RepairModelProvenance;
};

export type AppliedEdit = {
  filePath: string;
  original: string;
  updated: string;
  reason: string;
  /** Whether the path existed before the repair session started. */
  existed?: boolean;
};

export type VerifyResult = {
  ok: boolean;
  commands: string[];
  output: string;
  failures: FailureObservation[];
};

export type RepairSessionResult = {
  sessionId: string;
  ok: boolean;
  /** Dry runs are proposals only and are never verified repairs. */
  simulated: boolean;
  stopReason:
    | "verified"
    | "already_green"
    | "simulated"
    | "no_actions"
    | "no_edits"
    | "repeated_failure"
    | "repeated_actions"
    | "max_attempts"
    | "policy_violation"
    | "lease_lost";
  attempts: number;
  maxAttempts: number;
  plans: RepairPlan[];
  edits: AppliedEdit[];
  failureFingerprints: string[];
  actionFingerprints: string[];
  finalVerify?: VerifyResult;
  /** PR comment body for human review */
  reportMarkdown: string;
  policyNotes: string[];
};

export type RepairSessionInput = {
  sessionId?: string;
  repoRoot: string;
  /** Verify commands (e.g. npm test, tsc --noEmit) */
  verifyCommands?: string[];
  maxAttempts?: number;
  /** Maximum planned actions in one attempt. Hard-clamped by the repair core. */
  maxActionsPerAttempt?: number;
  /** Maximum distinct files changed by the complete session. */
  maxFilesChanged?: number;
  /** Maximum applied edit records across the complete session. */
  maxTotalEdits?: number;
  /** Structural renames still pending in tree */
  renameMap?: Record<string, string>;
  /** Optional LLM endpoint for hybrid repairs */
  useLlm?: boolean;
  dryRun?: boolean;
  /** Path denylist substrings */
  neverTouchPaths?: string[];
  /** Initial failure log if already known */
  seedFailureLog?: string;
  /** Allow writing outside findings (default true within neverTouch) */
  allowBroadSearch?: boolean;
  /** Cooperative cancellation checked around every awaited or mutating phase. */
  shouldContinue?: () => boolean;
};
