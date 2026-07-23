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

export type RepairPlan = {
  attempt: number;
  observations: FailureObservation[];
  actions: RepairAction[];
  strategy: "deterministic" | "llm" | "hybrid";
  summary: string;
};

export type AppliedEdit = {
  filePath: string;
  original: string;
  updated: string;
  reason: string;
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
  attempts: number;
  maxAttempts: number;
  plans: RepairPlan[];
  edits: AppliedEdit[];
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
};
