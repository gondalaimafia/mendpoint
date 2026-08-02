import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PilotReadinessChecklist, pilotReadinessItems } from "./pilot-readiness-checklist";
import type { PilotContractSummary } from "./pilot-success-contract";

const contract = {
  id: "pilot-one",
  version: 1,
  title: "Payments pilot",
  status: "approved",
  contentSha256: "a".repeat(64),
  approval: null,
  definition: {
    providerChange: { provider: "Payments", changeClass: "breaking", description: "Move v1 to v2." },
    repositories: [{ owner: "customer", name: "checkout", branch: "main", scope: "adapter" }],
    thresholds: [],
    owners: [{ responsibility: "technical_reviewer", principalId: "reviewer-one" }],
    supportResponses: [{ severity: "critical", responseMinutes: 30, coverage: "Pilot window" }],
    privacy: { dataCategories: [], retentionDays: 30, processingRegions: [], deletionProcedure: "purge" },
    rollback: { trigger: "regression", procedure: "restore", ownerPrincipalId: "owner", recoveryMinutes: 60 },
    weeklyReview: { dayOfWeek: "Wednesday", timeUtc: "16:00", ownerPrincipalId: "owner", agenda: [] },
    conversionDecision: { decisionDueAt: "2026-09-01T16:00:00.000Z", ownerPrincipalId: "owner", criteria: [] },
  },
} satisfies PilotContractSummary;

describe("pilot readiness checklist", () => {
  it("shows all twelve evidence gates without treating a contract as live infrastructure proof", () => {
    const input = {
      identityVerified: false,
      agreementRecorded: false,
      installationReady: true,
      repositorySnapshotReady: true,
      policyRecorded: false,
      verificationCommandsRecorded: false,
      canaryVerified: false,
      baselineRecorded: false,
      contracts: [contract],
    } as const;
    const items = pilotReadinessItems(input);
    expect(items).toHaveLength(12);
    expect(items.filter((item) => item.ready).map((item) => item.label)).toEqual([
      "Repository scope",
      "Exact snapshot",
      "Repository permissions",
      "Accountable owners",
      "Support response",
      "Rollback plan",
    ]);
    const html = renderToStaticMarkup(<PilotReadinessChecklist {...input} />);
    expect(html).toContain("6 of 12 ready");
    expect(html).toContain("Needs evidence: Private canary");
  });
});
