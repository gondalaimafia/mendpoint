/**
 * Declared task-ownership lifecycle (task brief §1).
 *
 * This is deliberately NOT a fourth state machine. The repository already
 * enforces two: `agent_runs.status` — a de-facto lifecycle applied ad hoc by
 * conditional UPDATE in `apps/api/src/warden-candidate-review.ts`, with no
 * declared machine and no CHECK constraint — and the ten-state Fettler CI cycle
 * machine in `warden-ci-reentry.ts`. This module adds NO stored state and NO new
 * column. It is a declared VIEW that names the ownership phase a task is in,
 * derived from the statuses those machines already persist, plus a pure
 * transition validator over that view. Callers read it to reason about "who owns
 * this task right now — the agent, a human, or nobody (terminal)" without
 * re-deriving that ad hoc at each call site.
 *
 * Fail closed. A status this module does not recognize maps to `unknown`, never
 * to a benign owner, and `unknown` is `indeterminate` ownership. "We could not
 * determine ownership" must never collapse into "the agent may proceed" — that
 * two-into-one collapse is the dominant defect class this repository fights.
 */

/** The ownership phases of a task, spanning the agent/human/agent handoff. */
export type TaskOwnershipState =
  | "unassigned"
  | "agent_assigned"
  | "agent_working"
  | "human_review_required"
  | "human_assigned"
  | "human_working"
  | "agent_resume"
  | "complete"
  | "blocked"
  | "failed"
  | "cancelled"
  | "escalated"
  | "unknown";

/** Who holds a task in a given ownership phase. `indeterminate` is fail-closed. */
export type OwnershipHolder = "agent" | "human" | "terminal" | "indeterminate";

const AGENT_STATES: ReadonlySet<TaskOwnershipState> = new Set([
  "agent_assigned",
  "agent_working",
  "agent_resume",
]);

const HUMAN_STATES: ReadonlySet<TaskOwnershipState> = new Set([
  "human_review_required",
  "human_assigned",
  "human_working",
  "escalated",
]);

const TERMINAL_STATES: ReadonlySet<TaskOwnershipState> = new Set([
  "complete",
  "blocked",
  "failed",
  "cancelled",
]);

/**
 * Who owns a task in this phase. `unassigned` and `unknown` are `indeterminate`
 * — never an agent or a human — so a caller cannot mistake "we don't know" for
 * "the agent owns it and may run".
 */
export function ownershipHolder(state: TaskOwnershipState): OwnershipHolder {
  if (AGENT_STATES.has(state)) return "agent";
  if (HUMAN_STATES.has(state)) return "human";
  if (TERMINAL_STATES.has(state)) return "terminal";
  return "indeterminate";
}

/**
 * Map an `agent_runs.status` value to its ownership phase. An unrecognized
 * status is `unknown` (fail closed), NOT a benign default. Deleting the
 * `default` arm below — or pointing it at a benign state — makes
 * `unrecognized agent-run status is unknown, never agent-owned` fail.
 */
export function ownershipStateForAgentRunStatus(status: string): TaskOwnershipState {
  switch (status) {
    case "queued":
      return "agent_assigned";
    case "running":
      return "agent_working";
    case "candidate_ready":
      return "human_review_required";
    case "candidate_approved":
    case "no_action":
    case "ok":
      return "complete";
    case "candidate_rejected":
      return "blocked";
    // A superseded candidate is the agent-resume handoff: a regenerated run has
    // taken over from it.
    case "candidate_superseded":
      return "agent_resume";
    case "candidate_expired":
    case "candidate_corrupt":
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "unknown";
  }
}

/**
 * Map a Fettler CI cycle status (`warden-ci-reentry.ts`) to its ownership phase.
 * A `paused` cycle is escalated to a human; `exhausted` is a terminal blocker.
 * Fail closed on any status this module does not recognize.
 */
export function ownershipStateForCiCycleStatus(status: string): TaskOwnershipState {
  switch (status) {
    case "observation_pending":
    case "checks_running":
    case "checks_failed":
    case "repair_pending":
    case "update_pending":
      return "agent_working";
    case "candidate_ready":
    case "awaiting_review":
      return "human_review_required";
    case "succeeded":
      return "complete";
    case "paused":
      return "escalated";
    case "exhausted":
      return "blocked";
    default:
      return "unknown";
  }
}

// Declared allowed transitions across the ownership view. A transition NOT
// listed here is rejected. `unknown` is absent as both a source and a target:
// nothing may enter or leave the indeterminate phase through a declared
// transition, so a lost status can never be "transitioned" into a benign one.
const ALLOWED_TRANSITIONS: ReadonlyMap<TaskOwnershipState, ReadonlySet<TaskOwnershipState>> = new Map([
  ["unassigned", new Set<TaskOwnershipState>(["agent_assigned", "cancelled"])],
  ["agent_assigned", new Set<TaskOwnershipState>(["agent_working", "failed", "cancelled"])],
  ["agent_working", new Set<TaskOwnershipState>([
    "human_review_required", "escalated", "complete", "blocked", "failed", "cancelled",
  ])],
  ["human_review_required", new Set<TaskOwnershipState>([
    "human_assigned", "agent_resume", "complete", "blocked", "escalated", "cancelled",
  ])],
  ["human_assigned", new Set<TaskOwnershipState>([
    "human_working", "human_review_required", "cancelled",
  ])],
  ["human_working", new Set<TaskOwnershipState>([
    "agent_resume", "complete", "blocked", "escalated", "human_review_required", "cancelled",
  ])],
  ["agent_resume", new Set<TaskOwnershipState>([
    "agent_working", "human_review_required", "complete", "failed", "cancelled",
  ])],
  ["escalated", new Set<TaskOwnershipState>([
    "human_assigned", "human_working", "agent_resume", "blocked", "cancelled",
  ])],
  // A blocker or a failure can be resolved and resumed; both may be cancelled.
  ["blocked", new Set<TaskOwnershipState>(["agent_resume", "cancelled"])],
  ["failed", new Set<TaskOwnershipState>(["agent_resume", "cancelled"])],
  // Fully terminal.
  ["complete", new Set<TaskOwnershipState>()],
  ["cancelled", new Set<TaskOwnershipState>()],
]);

/** Whether the ownership view permits a `from -> to` transition. */
export function isTaskOwnershipTransitionAllowed(
  from: TaskOwnershipState,
  to: TaskOwnershipState,
): boolean {
  return ALLOWED_TRANSITIONS.get(from)?.has(to) ?? false;
}

/**
 * Assert a transition is permitted, throwing `task_ownership_transition_invalid`
 * otherwise. Used to gate the resume handoff: a task may only be resumed from a
 * phase the ownership view says can hand back to an agent.
 */
export function assertTaskOwnershipTransition(
  from: TaskOwnershipState,
  to: TaskOwnershipState,
): void {
  if (!isTaskOwnershipTransitionAllowed(from, to)) {
    throw new Error("task_ownership_transition_invalid");
  }
}

/** Whether an agent may legitimately resume a task in this ownership phase. */
export function isAgentResumeEligible(from: TaskOwnershipState): boolean {
  return isTaskOwnershipTransitionAllowed(from, "agent_resume");
}
