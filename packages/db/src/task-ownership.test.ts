import { describe, expect, it } from "vitest";
import {
  assertTaskOwnershipTransition,
  isAgentResumeEligible,
  isTaskOwnershipTransitionAllowed,
  ownershipHolder,
  ownershipStateForAgentRunStatus,
  ownershipStateForCiCycleStatus,
} from "./task-ownership.js";

describe("task ownership view", () => {
  it("maps the live agent_runs statuses onto ownership phases", () => {
    expect(ownershipStateForAgentRunStatus("queued")).toBe("agent_assigned");
    expect(ownershipStateForAgentRunStatus("running")).toBe("agent_working");
    expect(ownershipStateForAgentRunStatus("candidate_ready")).toBe("human_review_required");
    expect(ownershipStateForAgentRunStatus("candidate_approved")).toBe("complete");
    expect(ownershipStateForAgentRunStatus("candidate_rejected")).toBe("blocked");
    expect(ownershipStateForAgentRunStatus("candidate_superseded")).toBe("agent_resume");
    expect(ownershipStateForAgentRunStatus("failed")).toBe("failed");
    expect(ownershipStateForAgentRunStatus("cancelled")).toBe("cancelled");
  });

  it("maps the CI cycle statuses onto ownership phases (paused escalates to a human)", () => {
    expect(ownershipStateForCiCycleStatus("repair_pending")).toBe("agent_working");
    expect(ownershipStateForCiCycleStatus("awaiting_review")).toBe("human_review_required");
    expect(ownershipStateForCiCycleStatus("paused")).toBe("escalated");
    expect(ownershipStateForCiCycleStatus("exhausted")).toBe("blocked");
    expect(ownershipStateForCiCycleStatus("succeeded")).toBe("complete");
  });

  // CONTROL A — fail-closed status mapping. An unrecognized status must be
  // `unknown` / `indeterminate`, never an agent-owned phase. Deleting the
  // `default: return "unknown"` arm (pointing it at a benign state) makes this die.
  it("CONTROL A: an unrecognized status is unknown and indeterminate, never agent-owned", () => {
    expect(ownershipStateForAgentRunStatus("garbage_status")).toBe("unknown");
    expect(ownershipStateForCiCycleStatus("garbage_status")).toBe("unknown");
    expect(ownershipHolder("unknown")).toBe("indeterminate");
    expect(ownershipHolder("unassigned")).toBe("indeterminate");
    expect(ownershipHolder("unknown")).not.toBe("agent");
  });

  it("classifies ownership holders", () => {
    expect(ownershipHolder("agent_working")).toBe("agent");
    expect(ownershipHolder("agent_resume")).toBe("agent");
    expect(ownershipHolder("human_review_required")).toBe("human");
    expect(ownershipHolder("escalated")).toBe("human");
    expect(ownershipHolder("complete")).toBe("terminal");
    expect(ownershipHolder("blocked")).toBe("terminal");
  });

  // CONTROL B — the resume transition is only legal after a human step. A run
  // still `agent_working` (never stopped for a human) cannot be "resumed";
  // `human_review_required`, `blocked`, `failed`, and `escalated` can hand back.
  it("CONTROL B: agent resume is eligible only after a human/terminal step, not from agent_working", () => {
    expect(isAgentResumeEligible("human_review_required")).toBe(true);
    expect(isAgentResumeEligible("blocked")).toBe(true);
    expect(isAgentResumeEligible("failed")).toBe(true);
    expect(isAgentResumeEligible("escalated")).toBe(true);
    expect(isAgentResumeEligible("agent_working")).toBe(false);
    expect(isAgentResumeEligible("unknown")).toBe(false);
    expect(isAgentResumeEligible("unassigned")).toBe(false);
  });

  it("permits the happy-path lifecycle transitions and rejects illegal ones", () => {
    expect(isTaskOwnershipTransitionAllowed("unassigned", "agent_assigned")).toBe(true);
    expect(isTaskOwnershipTransitionAllowed("agent_assigned", "agent_working")).toBe(true);
    expect(isTaskOwnershipTransitionAllowed("agent_working", "human_review_required")).toBe(true);
    expect(isTaskOwnershipTransitionAllowed("human_review_required", "agent_resume")).toBe(true);
    expect(isTaskOwnershipTransitionAllowed("agent_resume", "agent_working")).toBe(true);
    expect(isTaskOwnershipTransitionAllowed("agent_working", "complete")).toBe(true);
    // Illegal: skipping the human step, and any transition out of a terminal.
    expect(isTaskOwnershipTransitionAllowed("agent_working", "agent_resume")).toBe(false);
    expect(isTaskOwnershipTransitionAllowed("complete", "agent_working")).toBe(false);
    expect(isTaskOwnershipTransitionAllowed("cancelled", "agent_resume")).toBe(false);
    // Nothing enters or leaves the indeterminate phase by a declared transition.
    expect(isTaskOwnershipTransitionAllowed("unknown", "agent_working")).toBe(false);
    expect(isTaskOwnershipTransitionAllowed("agent_working", "unknown")).toBe(false);
  });

  it("assertTaskOwnershipTransition throws on an illegal transition", () => {
    expect(() => assertTaskOwnershipTransition("human_review_required", "agent_resume")).not.toThrow();
    expect(() => assertTaskOwnershipTransition("agent_working", "agent_resume")).toThrow(
      "task_ownership_transition_invalid",
    );
  });
});
