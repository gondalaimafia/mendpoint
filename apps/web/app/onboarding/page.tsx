import { notFound } from "next/navigation";
import React from "react";
import { apiGet } from "../../lib/api";
import { selfServeOnboardingEnabled } from "../../lib/proxy-auth";
import { OnboardingSteps, type OnboardingStatus } from "./onboarding-steps";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  // The guided flow only exists when the full self-serve stack is on. Off ⇒ 404,
  // so the operator /install page stays the only first-run surface.
  if (!selfServeOnboardingEnabled()) notFound();

  let status: OnboardingStatus | null = null;
  let error: string | null = null;
  try {
    status = await apiGet<OnboardingStatus>("/self-serve/onboarding");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (!status) {
    return (
      <div className="page">
        <div className="page-header">
          <h1>Get started with Mendpoint</h1>
          <p className="muted">
            We could not load your onboarding status right now. Refresh in a moment, or create your
            workspace to begin.
          </p>
        </div>
        <section className="card">
          <p className="muted small">{error ?? "Onboarding status is unavailable."}</p>
          <a className="btn primary" href="/signup">Create workspace</a>
        </section>
      </div>
    );
  }

  return <OnboardingSteps status={status} />;
}
