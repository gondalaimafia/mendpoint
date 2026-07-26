/**
 * Shared planner/executor harness — JSON plan-of-record with success criteria.
 * Graph engineering: plan is durable state above a single loop run.
 */
import { newId, nowIso } from "@mendpoint/shared";

export type PlanStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type PlanStep = {
  id: string;
  title: string;
  /** Machine-readable action kind */
  action: string;
  /** Success criteria the executor/verifier must observe */
  successCriteria: string[];
  /** Optional link to domain object (surface id, BSG node, etc.) */
  ref?: string;
  status: PlanStepStatus;
  notes?: string;
  evidence?: string;
};

export type AgentPlan = {
  id: string;
  kind: "spec_diff" | "bsg_campaign" | "generic";
  title: string;
  goal: string;
  agent: "warden" | "transformer" | "shared";
  steps: PlanStep[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
};

export type PlanProgress = {
  total: number;
  done: number;
  failed: number;
  pending: number;
  complete: boolean;
};

export function emptyPlan(partial: {
  kind: AgentPlan["kind"];
  title: string;
  goal: string;
  agent: AgentPlan["agent"];
  metadata?: Record<string, unknown>;
}): AgentPlan {
  const t = nowIso();
  return {
    id: newId(),
    kind: partial.kind,
    title: partial.title,
    goal: partial.goal,
    agent: partial.agent,
    steps: [],
    createdAt: t,
    updatedAt: t,
    metadata: partial.metadata,
  };
}

export function addStep(
  plan: AgentPlan,
  step: Omit<PlanStep, "id" | "status"> & { status?: PlanStepStatus },
): AgentPlan {
  const s: PlanStep = {
    id: newId(),
    title: step.title,
    action: step.action,
    successCriteria: step.successCriteria,
    ref: step.ref,
    status: step.status ?? "pending",
    notes: step.notes,
    evidence: step.evidence,
  };
  return {
    ...plan,
    steps: [...plan.steps, s],
    updatedAt: nowIso(),
  };
}

export function updateStep(
  plan: AgentPlan,
  stepId: string,
  patch: Partial<Pick<PlanStep, "status" | "notes" | "evidence">>,
): AgentPlan {
  return {
    ...plan,
    steps: plan.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
    updatedAt: nowIso(),
  };
}

export function planProgress(plan: AgentPlan): PlanProgress {
  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.status === "done").length;
  const failed = plan.steps.filter((s) => s.status === "failed").length;
  const pending = plan.steps.filter((s) => s.status === "pending" || s.status === "running").length;
  return {
    total,
    done,
    failed,
    pending,
    complete: total > 0 && pending === 0 && failed === 0,
  };
}

/** Next pending step (executor pointer). */
export function nextPendingStep(plan: AgentPlan): PlanStep | undefined {
  return plan.steps.find((s) => s.status === "pending");
}

export function planToMarkdown(plan: AgentPlan): string {
  const prog = planProgress(plan);
  const lines = [
    `### Plan: ${plan.title}`,
    "",
    `- **Kind:** ${plan.kind}`,
    `- **Agent:** ${plan.agent}`,
    `- **Goal:** ${plan.goal}`,
    `- **Progress:** ${prog.done}/${prog.total} done` +
      (prog.failed ? `, ${prog.failed} failed` : ""),
    "",
    "| # | Step | Action | Status | Success criteria |",
    "|---|------|--------|--------|------------------|",
    ...plan.steps.map(
      (s, i) =>
        `| ${i + 1} | ${s.title.replace(/\|/g, "/")} | \`${s.action}\` | ${s.status} | ${s.successCriteria.join("; ").replace(/\|/g, "/")} |`,
    ),
    "",
    "_Plan-of-record is editable state for the graph executor. Never auto-merges._",
  ];
  return lines.join("\n");
}
