/**
 * Spec-first planner: OpenAPI structural diff / surfaces → plan-of-record.
 * Every step maps to a spec change before (or as) code is touched.
 */
import type { ImpactableSurface, StructuralDiff } from "@mendpoint/shared";
import { addStep, emptyPlan, type AgentPlan } from "./plan.js";

export type SpecPlanInput = {
  providerSlug: string;
  providerName?: string;
  fromVersion?: string;
  toVersion?: string;
  diff: StructuralDiff;
  surfaces: ImpactableSurface[];
  goal?: string;
};

function actionForSurface(s: ImpactableSurface): string {
  const id = `${s.canonicalId} ${s.op} ${s.migrationStrategy}`;
  if (/rename|field_renamed/i.test(id) || s.migrationStrategy.includes("rename")) {
    return "spec.evolve_field";
  }
  if (/removed|delete/i.test(id) || s.severity === "breaking") {
    return "spec.breaking_change";
  }
  if (/added|new_capability|path_added/i.test(id)) {
    return "spec.add_capability";
  }
  return "spec.evolve";
}

/**
 * Build a durable JSON plan where each step is grounded in a surface from the OpenAPI diff.
 */
export function planFromSpecDiff(input: SpecPlanInput): AgentPlan {
  const name = input.providerName ?? input.providerSlug;
  const ver =
    input.fromVersion && input.toVersion
      ? `${input.fromVersion} → ${input.toVersion}`
      : input.diff.summary;
  let plan = emptyPlan({
    kind: "spec_diff",
    title: `Warden spec plan: ${name} (${ver})`,
    goal:
      input.goal ??
      `Evolve ${name} API and migrate consumers safely for: ${input.diff.summary}`,
    agent: "warden",
    metadata: {
      providerSlug: input.providerSlug,
      risk: input.diff.risk,
      surfaceCount: input.surfaces.length,
      planOfRecord: "openapi_diff",
    },
  });

  plan = addStep(plan, {
    title: "Lock OpenAPI/Proto plan-of-record",
    action: "spec.lock_diff",
    successCriteria: [
      "Structural diff computed",
      "Surfaces enumerated with severity",
      "No code edits before plan steps complete or human approves",
    ],
    notes: input.diff.summary,
  });

  for (const s of input.surfaces.slice(0, 40)) {
    const label =
      s.explanation ||
      s.canonicalId ||
      [s.path, s.field].filter(Boolean).join(" ") ||
      "surface";
    plan = addStep(plan, {
      title: String(label).slice(0, 120),
      action: actionForSurface(s),
      ref: s.canonicalId || s.id,
      successCriteria: [
        s.severity === "breaking"
          ? "Consumer impact assessed via registry"
          : "Spec change documented",
        `Migration strategy: ${s.migrationStrategy}`,
        "Success criteria observable via contract tests or impact findings",
      ],
      notes: `severity=${s.severity}`,
    });
  }

  plan = addStep(plan, {
    title: "Run contract-conformance + breaking-change gates",
    action: "gate.contract_suite",
    successCriteria: [
      "oas-diff / surface checks pass or explicit break approved",
      "Contract suite green or waivers recorded",
    ],
  });

  plan = addStep(plan, {
    title: "Fan-out consumer impact + generate reviewable PRs",
    action: "impact.fanout_prs",
    successCriteria: [
      "Consumers for affected surfaces listed",
      "PRs opened with human review (never auto-merge by default)",
    ],
  });

  plan = addStep(plan, {
    title: "API design review (read-only critic)",
    action: "critic.api_reviewer",
    successCriteria: [
      "Idempotency, pagination, error taxonomy, versioning scored",
      "Blocking issues attached to plan or waived by API owner",
    ],
  });

  return plan;
}
