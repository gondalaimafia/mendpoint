import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PilotSuccessContractPanel, type PilotContractSummary } from "./pilot-success-contract";

describe("pilot success contract onboarding panel", () => {
  it("renders contract creation, revision, approval, and immutable evidence status", () => {
    const contract = {
      id: "pilot-one",
      version: 2,
      title: "Payments pilot",
      status: "draft",
      contentSha256: "a".repeat(64),
      approval: null,
      definition: {
        providerChange: { provider: "Payments", changeClass: "breaking", description: "Move v1 to v2." },
        repositories: [{ owner: "customer", name: "checkout", branch: "main", scope: "adapter" }],
        thresholds: [{ metric: "verified migration pull requests", operator: "gte", target: 1, unit: "pull requests" }],
        owners: [{ responsibility: "technical_reviewer", principalId: "reviewer-one" }],
        supportResponses: [{ severity: "critical", responseMinutes: 30, coverage: "Pilot window" }],
        privacy: { dataCategories: ["source"], retentionDays: 30, processingRegions: ["region"], deletionProcedure: "purge" },
        rollback: { trigger: "regression", procedure: "restore", ownerPrincipalId: "owner", recoveryMinutes: 60 },
        weeklyReview: { dayOfWeek: "Wednesday", timeUtc: "16:00", ownerPrincipalId: "owner", agenda: ["thresholds"] },
        conversionDecision: { decisionDueAt: "2026-09-01T16:00:00.000Z", ownerPrincipalId: "owner", criteria: ["pass"] },
      },
    } satisfies PilotContractSummary;

    const html = renderToStaticMarkup(
      <PilotSuccessContractPanel
        initialContracts={[contract]}
        defaultRepositoryOwner="customer"
        defaultDecisionDate="2026-09-01"
      />,
    );
    for (const text of [
      "Pilot success contract",
      "Independent reviewer principal ID",
      "Conversion decision date",
      "Create pilot contract",
      "Create revision",
      "Approve as assigned reviewer",
      "Evidence aaaaaaaaaaaa",
    ]) {
      expect(html).toContain(text);
    }
  });
});
