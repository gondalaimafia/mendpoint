import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardView, type SelfServeDashboard } from "./dashboard-view";

// Overrides replace top-level dimensions wholesale (shallow merge).
function baseDashboard(overrides: Partial<SelfServeDashboard> = {}): SelfServeDashboard {
  return { ...baseDashboardData, ...overrides };
}

const baseDashboardData: SelfServeDashboard = {
  tenantId: "tenant-a",
  window: { since: null, until: null },
  adoption: {
    reposConnected: 2,
    providersMonitored: 2,
    monitoredApis: 3,
    totalRuns: 5,
    activeUsers: 2,
    runsByDay: [{ date: "2026-08-01", runs: 5 }],
    teams: { value: null, basis: "unavailable", reason: "no team grouping in the schema" },
  },
  outcomes: {
    prsOpened: 3,
    prsMerged: 1,
    prsClosed: 1,
    prsOpen: 1,
    mergeRate: { value: 0.5, numerator: 1, denominator: 2, basis: "measured" },
    candidatesApproved: 1,
    candidatesRejected: 1,
    candidateApprovalRate: { value: 0.5, numerator: 1, denominator: 2, basis: "measured" },
    abstainedRuns: 1,
    outOfScopeRuns: 1,
  },
  reliability: {
    runsSucceeded: 2,
    runsFailed: 1,
    runSuccessRate: { value: 2 / 3, numerator: 2, denominator: 3, basis: "measured" },
    retries: 1,
    verificationPassRate: { value: null, basis: "unavailable", reason: "not persisted" },
    introducedVsPreexistingFailures: { value: null, basis: "unavailable", reason: "transient" },
  },
  cost: {
    measuredUsd: {
      totalUsd: 0.2,
      perRunUsd: 0.1,
      measuredRuns: 2,
      totalRuns: 3,
      basis: "measured",
      note: "Averaged over the 2 of 3 metered runs with measured cost.",
    },
    mcu: { basis: "unavailable", reason: "No usage entitlement is provisioned for this tenant." },
  },
  developerSatisfaction: {
    responses: 2,
    averageRating: 4,
    positive: 1,
    negative: 0,
    neutral: 1,
    scale: "1-5",
    basis: "measured",
  },
  gaps: [],
  provenance: { "adoption.reposConnected": "count of consumers WHERE tenant_id = tenant" },
  computedAt: "2026-08-11T00:00:00.000Z",
};

describe("DashboardView", () => {
  it("renders measured headline numbers across dimensions", () => {
    const html = renderToStaticMarkup(<DashboardView m={baseDashboard()} />);
    expect(html).toContain("Repos connected");
    expect(html).toContain("50.0%"); // merge rate
    expect(html).toContain("$0.2000"); // measured cost
    expect(html).toContain("Developer satisfaction");
    expect(html).toContain("4.00 / 5");
  });

  it("labels unavailable dimensions as not instrumented instead of zeroing", () => {
    const html = renderToStaticMarkup(<DashboardView m={baseDashboard()} />);
    expect(html).toContain("not instrumented");
    expect(html).toContain("not provisioned"); // MCU with no entitlement
  });

  it("shows an honest empty state for satisfaction with no responses", () => {
    const html = renderToStaticMarkup(
      <DashboardView
        m={baseDashboard({
          developerSatisfaction: {
            responses: 0,
            averageRating: null,
            positive: 0,
            negative: 0,
            neutral: 0,
            scale: "1-5",
            basis: "unavailable",
            reason: "No developer-satisfaction signals captured for this tenant in the window.",
          },
        })}
      />,
    );
    expect(html).toContain("No developer-satisfaction signals captured");
    expect(html).toContain("never inferred");
  });

  it("renders the provenance table", () => {
    const html = renderToStaticMarkup(<DashboardView m={baseDashboard()} />);
    expect(html).toContain("adoption.reposConnected");
    expect(html).toContain("count of consumers");
  });
});
