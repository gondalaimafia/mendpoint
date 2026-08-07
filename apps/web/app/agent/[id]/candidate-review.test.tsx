import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CandidateReviewDecisionPanel } from "./candidate-review.js";

describe("Warden candidate review decisions", () => {
  it("shows company sign in and no decisions under preview access", () => {
    const html = renderToStaticMarkup(
      <CandidateReviewDecisionPanel
        runId="run-a"
        humanIdentity={false}
        busy={false}
        error={null}
        onDecision={() => {}}
      />,
    );

    expect(html).toContain("Preview access is read only");
    expect(html).toContain("Sign in with company identity");
    expect(html).toContain("/access?next=%2Fagent%2Frun-a");
    expect(html).not.toContain("Approve candidate");
    expect(html).not.toContain("Reject and delete");
  });

  it("requires rationale and exposes approve, regenerate, and reject decisions", () => {
    const html = renderToStaticMarkup(
      <CandidateReviewDecisionPanel
        runId="run-1"
        humanIdentity={true}
        busy={false}
        error={null}
        rationale="Keep the public API stable"
        onRationaleChange={() => {}}
        onDecision={() => {}}
      />,
    );
    expect(html).toContain("Review rationale");
    expect(html).toContain("Approve candidate");
    expect(html).toContain("Request regeneration");
    expect(html).toContain("Reject and delete");
  });
});
