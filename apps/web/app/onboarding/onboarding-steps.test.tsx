import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OnboardingSteps, type OnboardingStatus } from "./onboarding-steps";

// The step action components pull in next/navigation; stub the router so the
// client forms render under SSR.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

function status(overrides: Partial<OnboardingStatus> = {}): OnboardingStatus {
  return {
    tenantId: "tenant-a",
    workspaceName: "Acme",
    plan: "free",
    completedSteps: 1,
    totalSteps: 5,
    steps: [
      {
        id: "workspace",
        title: "Create your workspace",
        summary: "Your tenant.",
        why: "Isolation.",
        state: "done",
        detail: "Workspace Acme is on the free plan.",
        blockedReason: null,
        action: { kind: "none", label: "", href: null },
        meta: { plan: "free" },
      },
      {
        id: "connect",
        title: "Connect a repository",
        summary: "Link your repo.",
        why: "Real code.",
        state: "next",
        detail: "No repository connected yet.",
        blockedReason: null,
        action: { kind: "connect", label: "Connect repository", href: null },
        meta: null,
      },
      {
        id: "spec",
        title: "Add an API spec",
        summary: "Point at a provider.",
        why: "Impact scans.",
        state: "blocked",
        detail: "No monitored provider yet.",
        blockedReason: 'Finish "Connect a repository" first, then this step unlocks.',
        action: { kind: "none", label: "", href: null },
        meta: null,
      },
      {
        id: "scan",
        title: "Run the first scan",
        summary: "Kick off a scan.",
        why: "Find breakage.",
        state: "blocked",
        detail: "No scan has run yet.",
        blockedReason: 'Finish "Connect a repository" first, then this step unlocks.',
        action: { kind: "none", label: "", href: null },
        meta: null,
      },
      {
        id: "review",
        title: "Review the first pull request",
        summary: "Open the PR.",
        why: "Stay in control.",
        state: "done",
        detail: 'Pull request "Migrate to v2" is ready for review.',
        blockedReason: null,
        action: { kind: "link", label: "Review pull request", href: "/consumer/prs/pr-1" },
        meta: { prId: "pr-1" },
      },
    ],
    ...overrides,
  };
}

describe("OnboardingSteps guided first-run flow", () => {
  it("renders the connect action for the actionable next step", () => {
    const html = renderToStaticMarkup(<OnboardingSteps status={status()} />);
    expect(html).toContain("Get started with Mendpoint");
    expect(html).toContain("1 of 5 steps complete");
    // The connect step is next, so its form action renders.
    expect(html).toContain("Repository owner");
    expect(html).toContain("Connect repository");
  });

  it("shows an actionable fix on a blocked step and hides its action", () => {
    const html = renderToStaticMarkup(<OnboardingSteps status={status()} />);
    // The blocked scan step shows the fix, not a raw API error string.
    expect(html).toContain("Finish &quot;Connect a repository&quot; first, then this step unlocks.");
    expect(html).not.toContain("no monitored providers to scan");
    expect(html).not.toContain("Run first scan");
  });

  it("links a completed review step to its pull request review page", () => {
    const html = renderToStaticMarkup(<OnboardingSteps status={status()} />);
    expect(html).toContain('href="/consumer/prs/pr-1"');
    expect(html).toContain("Review pull request");
  });

  it("renders the scan action only when the scan step is the next step", () => {
    const scanNext = status({
      completedSteps: 3,
      steps: status().steps.map((step) => {
        if (step.id === "spec") return { ...step, state: "done" as const };
        if (step.id === "connect") return { ...step, state: "done" as const };
        if (step.id === "scan") {
          return { ...step, state: "next" as const, action: { kind: "scan" as const, label: "Run first scan", href: null } };
        }
        return step;
      }),
    });
    const html = renderToStaticMarkup(<OnboardingSteps status={scanNext} />);
    expect(html).toContain("Run first scan");
  });
});
