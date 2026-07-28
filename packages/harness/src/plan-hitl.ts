/**
 * HITL plan edit — load/save/patch plan JSON for human-in-the-loop.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentPlan, PlanStep } from "@mendpoint/orchestrator";
import { runDir, savePlan, loadPlan } from "./trajectory.js";

export type PlanPatch = {
  title?: string;
  goal?: string;
  /** Replace step notes/status by step id */
  steps?: Array<{
    id: string;
    title?: string;
    notes?: string;
    status?: PlanStep["status"];
    action?: string;
  }>;
  /** Append new steps */
  addSteps?: Array<Partial<PlanStep> & { title: string; action: string }>;
};

export function listPlans(baseDir: string): Array<{ runId: string; title?: string; steps: number }> {
  const root = join(baseDir, "runs");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const p = runDir(baseDir, d.name).planPath;
      if (!existsSync(p)) return [];
      try {
        const plan = JSON.parse(readFileSync(p, "utf8")) as AgentPlan;
        return [{
          runId: d.name,
          title: plan.title,
          steps: plan.steps?.length ?? 0,
        }];
      } catch {
        return [];
      }
    });
}

export function getPlan(baseDir: string, runId: string): AgentPlan {
  return loadPlan(runDir(baseDir, runId));
}

export function applyPlanPatch(
  plan: AgentPlan,
  patch: PlanPatch,
): AgentPlan {
  let next: AgentPlan = {
    ...plan,
    title: patch.title ?? plan.title,
    goal: patch.goal ?? plan.goal,
    steps: [...plan.steps],
  };
  if (patch.steps?.length) {
    next = {
      ...next,
      steps: next.steps.map((s) => {
        const p = patch.steps!.find((x) => x.id === s.id);
        if (!p) return s;
        return {
          ...s,
          title: p.title ?? s.title,
          notes: p.notes ?? s.notes,
          status: p.status ?? s.status,
          action: p.action ?? s.action,
        };
      }),
    };
  }
  if (patch.addSteps?.length) {
    const added: PlanStep[] = patch.addSteps.map((s, i) => ({
      id: s.id ?? `hitl-${Date.now()}-${i}`,
      title: s.title,
      action: s.action,
      status: s.status ?? "pending",
      successCriteria: s.successCriteria ?? [],
      notes: s.notes,
      ref: s.ref,
      evidence: s.evidence,
    }));
    next = { ...next, steps: [...next.steps, ...added] };
  }
  return next;
}

export function savePlanHitl(
  baseDir: string,
  runId: string,
  patch: PlanPatch,
): AgentPlan {
  const paths = runDir(baseDir, runId);
  const plan = applyPlanPatch(loadPlan(paths), patch);
  savePlan(paths, plan);
  // audit trail
  const audit = join(paths.root, "plan-hitl.jsonl");
  writeFileSync(
    audit,
    // append-like: read+write for simplicity on short files
    (existsSync(audit) ? readFileSync(audit, "utf8") : "") +
      JSON.stringify({ ts: new Date().toISOString(), patch }) +
      "\n",
    "utf8",
  );
  return plan;
}

export function createDraftPlan(
  baseDir: string,
  plan: AgentPlan,
  runId?: string,
): { runId: string; plan: AgentPlan } {
  const id = runId ?? plan.id ?? `plan-${Date.now().toString(36)}`;
  const paths = runDir(baseDir, id);
  mkdirSync(paths.root, { recursive: true });
  savePlan(paths, { ...plan, id: plan.id ?? id });
  return { runId: id, plan: { ...plan, id: plan.id ?? id } };
}
