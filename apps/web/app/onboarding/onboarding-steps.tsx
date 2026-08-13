import Link from "next/link";
import React from "react";
import { SectionLabel, StatusPill, type Status } from "../components/ds";
import { ConnectRepositoryAction, RunScanAction } from "./onboarding-actions";

export type OnboardingStepState = "done" | "next" | "blocked";
export type OnboardingActionKind = "none" | "connect" | "scan" | "link" | "coming_next";

export type OnboardingStep = {
  id: string;
  title: string;
  summary: string;
  why: string;
  state: OnboardingStepState;
  detail: string;
  blockedReason: string | null;
  action: { kind: OnboardingActionKind; label: string; href: string | null };
  meta: Record<string, string> | null;
};

export type OnboardingStatus = {
  tenantId: string;
  workspaceName: string;
  plan: string;
  completedSteps: number;
  totalSteps: number;
  steps: OnboardingStep[];
};

const STATE_PILL: Record<OnboardingStepState, { status: Status; label: string; pulse: boolean }> = {
  done: { status: "merged", label: "Done", pulse: false },
  next: { status: "pending", label: "Do this next", pulse: true },
  blocked: { status: "draft", label: "Waiting", pulse: false },
};

function StepAction({ step }: { step: OnboardingStep }) {
  if (step.action.kind === "connect") return <ConnectRepositoryAction />;
  if (step.action.kind === "scan") return <RunScanAction />;
  if (step.action.kind === "coming_next") {
    return (
      <div className="stack">
        <p className="muted small">
          Direct spec publishing is coming next. For now, {step.action.href ? (
            <Link href={step.action.href}>{step.action.label.toLowerCase()}</Link>
          ) : (
            step.action.label.toLowerCase()
          )}{" "}
          on your connected repository to start monitoring a provider.
        </p>
      </div>
    );
  }
  if (step.action.kind === "link" && step.action.href) {
    return (
      <Link className="btn primary" href={step.action.href}>
        {step.action.label}
      </Link>
    );
  }
  return null;
}

/**
 * The guided first-run flow. Every step's state is derived server-side from real
 * tenant-scoped data, so this component only renders what the status says: done,
 * the single actionable next step, or a blocked step with an actionable fix.
 * Shared by /onboarding and the self-serve /install entry.
 */
export function OnboardingSteps({ status }: { status: OnboardingStatus }) {
  return (
    <div className="page">
      <div className="page-header">
        <h1>Get started with Mendpoint</h1>
        <p className="muted">
          Connect a repository, run your first impact scan, and review the first pull request. Each
          step unlocks the next.
        </p>
        <p className="muted small">
          {status.completedSteps} of {status.totalSteps} steps complete
          {status.workspaceName ? ` — workspace ${status.workspaceName}` : ""}
        </p>
      </div>

      {status.steps.map((step, index) => {
        const pill = STATE_PILL[step.state];
        return (
          <section className="card" key={step.id} aria-labelledby={`onboarding-step-${step.id}`}>
            <div className="row-between">
              <SectionLabel tone="muted">Step {index + 1}</SectionLabel>
              <StatusPill status={pill.status} label={pill.label} pulse={pill.pulse} />
            </div>
            <h2 id={`onboarding-step-${step.id}`}>{step.title}</h2>
            <p className="muted">{step.summary}</p>
            <p className="muted small">Why it matters: {step.why}</p>
            <p className={step.state === "done" ? "ok" : "muted small"}>{step.detail}</p>
            {step.state === "blocked" && step.blockedReason && (
              <p className="muted small" role="note">{step.blockedReason}</p>
            )}
            {step.state !== "blocked" && <StepAction step={step} />}
          </section>
        );
      })}
    </div>
  );
}
