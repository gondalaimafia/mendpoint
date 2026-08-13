import React from "react";
import { Badge } from "../../components/ds/index.js";

export type DashboardRateMetric = {
  value: number | null;
  numerator: number;
  denominator: number;
  basis: "measured";
  reason?: string;
};

export type DashboardUnavailableMetric = {
  value: null;
  basis: "unavailable";
  reason: string;
};

export type SelfServeDashboard = {
  tenantId: string;
  window: { since: string | null; until: string | null };
  adoption: {
    reposConnected: number;
    providersMonitored: number;
    monitoredApis: number;
    totalRuns: number;
    activeUsers: number;
    runsByDay: Array<{ date: string; runs: number }>;
    teams: DashboardUnavailableMetric;
  };
  outcomes: {
    prsOpened: number;
    prsMerged: number;
    prsClosed: number;
    prsOpen: number;
    mergeRate: DashboardRateMetric;
    candidatesApproved: number;
    candidatesRejected: number;
    candidateApprovalRate: DashboardRateMetric;
    abstainedRuns: number;
    outOfScopeRuns: number;
  };
  reliability: {
    runsSucceeded: number;
    runsFailed: number;
    runSuccessRate: DashboardRateMetric;
    retries: number;
    verificationPassRate: DashboardUnavailableMetric;
    introducedVsPreexistingFailures: DashboardUnavailableMetric;
  };
  cost: {
    measuredUsd: {
      totalUsd: number | null;
      perRunUsd: number | null;
      measuredRuns: number;
      totalRuns: number;
      basis: "measured";
      reason?: string;
      note?: string;
    };
    mcu:
      | {
          basis: "measured";
          consumedMcuMicros: number;
          reservedMcuMicros: number;
          availableMcuMicros: number | null;
          billableMoneyMicros: number | null;
          currency: string | null;
          note: string;
        }
      | { basis: "unavailable"; reason: string };
  };
  developerSatisfaction: {
    responses: number;
    averageRating: number | null;
    positive: number;
    negative: number;
    neutral: number;
    scale: "1-5";
    basis: "measured" | "unavailable";
    reason?: string;
  };
  gaps: Array<{ field: string; reason: string }>;
  provenance: Record<string, string>;
  computedAt: string;
};

function pct(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "no data yet";
  return `${(n * 100).toFixed(1)}%`;
}

function usd(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "not measured";
  return `$${n.toFixed(4)}`;
}

function mcuFromMicros(micros: number): string {
  return (micros / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function BasisBadge({ basis }: { basis: "measured" | "unavailable" | "proxy" }) {
  if (basis === "measured") return <Badge tone="emerald">measured</Badge>;
  if (basis === "proxy") return <Badge tone="accent">proxy</Badge>;
  return <Badge tone="warn">not instrumented</Badge>;
}

export function DashboardView({ m }: { m: SelfServeDashboard }) {
  const { adoption, outcomes, reliability, cost, developerSatisfaction } = m;
  return (
    <>
      <section className="surface" aria-label="Adoption">
        <div className="section-head">
          <div>
            <p className="eyebrow">Adoption</p>
            <h2>Connected footprint and usage</h2>
          </div>
        </div>
        <div className="metric-grid">
          <div className="metric-card">
            <span className="metric-label">Repos connected</span>
            <strong>{adoption.reposConnected}</strong>
            <span className="metric-detail">{adoption.monitoredApis} monitored APIs</span>
          </div>
          <div className="metric-card">
            <span className="metric-label">Providers monitored</span>
            <strong>{adoption.providersMonitored}</strong>
            <span className="metric-detail">distinct API providers</span>
          </div>
          <div className="metric-card">
            <span className="metric-label">Runs</span>
            <strong>{adoption.totalRuns}</strong>
            <span className="metric-detail">{adoption.runsByDay.length} active days</span>
          </div>
          <div className="metric-card">
            <span className="metric-label">Active users</span>
            <strong>{adoption.activeUsers}</strong>
            <span className="metric-detail">
              <BasisBadge basis="unavailable" /> teams not instrumented
            </span>
          </div>
        </div>
      </section>

      <section className="surface" aria-label="Task outcomes">
        <div className="section-head">
          <div>
            <p className="eyebrow">Task outcomes</p>
            <h2>Pull requests and reviewed candidates</h2>
          </div>
        </div>
        <div className="metric-grid">
          <div className="metric-card">
            <span className="metric-label">PRs opened</span>
            <strong>{outcomes.prsOpened}</strong>
            <span className="metric-detail">
              merged {outcomes.prsMerged} · closed {outcomes.prsClosed} · open {outcomes.prsOpen}
            </span>
          </div>
          <div className="metric-card">
            <span className="metric-label">Merge rate</span>
            <strong>{pct(outcomes.mergeRate.value)}</strong>
            <span className="metric-detail">merged / (merged + closed)</span>
          </div>
          <div className="metric-card">
            <span className="metric-label">Candidate approval</span>
            <strong>{pct(outcomes.candidateApprovalRate.value)}</strong>
            <span className="metric-detail">
              approved {outcomes.candidatesApproved} · rejected {outcomes.candidatesRejected}
            </span>
          </div>
          <div className="metric-card">
            <span className="metric-label">Abstained / out of scope</span>
            <strong>{outcomes.abstainedRuns + outcomes.outOfScopeRuns}</strong>
            <span className="metric-detail">
              abstained {outcomes.abstainedRuns} · no-action {outcomes.outOfScopeRuns}
            </span>
          </div>
        </div>
      </section>

      <section className="surface" aria-label="Reliability">
        <div className="section-head">
          <div>
            <p className="eyebrow">Reliability</p>
            <h2>Run success and retries</h2>
          </div>
        </div>
        <div className="metric-grid">
          <div className="metric-card">
            <span className="metric-label">Run success rate</span>
            <strong>{pct(reliability.runSuccessRate.value)}</strong>
            <span className="metric-detail">
              ok {reliability.runsSucceeded} · failed {reliability.runsFailed}
            </span>
          </div>
          <div className="metric-card">
            <span className="metric-label">Retries</span>
            <strong>{reliability.retries}</strong>
            <span className="metric-detail">jobs re-attempted</span>
          </div>
          <div className="metric-card">
            <span className="metric-label">Verification pass rate</span>
            <strong>not instrumented</strong>
            <span className="metric-detail">
              <BasisBadge basis="unavailable" /> gated pre-delivery, not persisted
            </span>
          </div>
          <div className="metric-card">
            <span className="metric-label">Introduced vs pre-existing</span>
            <strong>not instrumented</strong>
            <span className="metric-detail">
              <BasisBadge basis="unavailable" /> transient in the executor
            </span>
          </div>
        </div>
      </section>

      <section className="surface" aria-label="Cost">
        <div className="section-head">
          <div>
            <p className="eyebrow">Cost</p>
            <h2>Measured spend and metered usage</h2>
          </div>
        </div>
        <div className="metric-grid">
          <div className="metric-card">
            <span className="metric-label">Measured cost</span>
            <strong>{usd(cost.measuredUsd.totalUsd)}</strong>
            <span className="metric-detail">
              <BasisBadge basis="measured" /> {cost.measuredUsd.measuredRuns} of{" "}
              {cost.measuredUsd.totalRuns} runs measured
            </span>
          </div>
          <div className="metric-card">
            <span className="metric-label">Cost per run</span>
            <strong>{usd(cost.measuredUsd.perRunUsd)}</strong>
            <span className="metric-detail">averaged over measured runs</span>
          </div>
          <div className="metric-card">
            <span className="metric-label">MCU consumed</span>
            {cost.mcu.basis === "measured" ? (
              <>
                <strong>{mcuFromMicros(cost.mcu.consumedMcuMicros)}</strong>
                <span className="metric-detail">
                  <BasisBadge basis="measured" /> reserved {mcuFromMicros(cost.mcu.reservedMcuMicros)}
                </span>
              </>
            ) : (
              <>
                <strong>not provisioned</strong>
                <span className="metric-detail">
                  <BasisBadge basis="unavailable" /> no usage entitlement
                </span>
              </>
            )}
          </div>
          <div className="metric-card">
            <span className="metric-label">Billable</span>
            {cost.mcu.basis === "measured" && cost.mcu.billableMoneyMicros !== null ? (
              <strong>
                {(cost.mcu.billableMoneyMicros / 1_000_000).toFixed(2)} {cost.mcu.currency ?? ""}
              </strong>
            ) : (
              <strong>not measured</strong>
            )}
            <span className="metric-detail">from the usage ledger</span>
          </div>
        </div>
        {cost.measuredUsd.reason && <p className="muted small">{cost.measuredUsd.reason}</p>}
        {cost.measuredUsd.note && <p className="muted small">{cost.measuredUsd.note}</p>}
      </section>

      <section className="surface" aria-label="Developer satisfaction">
        <div className="section-head">
          <div>
            <p className="eyebrow">Developer satisfaction</p>
            <h2>From submitted ratings only</h2>
          </div>
        </div>
        {developerSatisfaction.basis === "measured" ? (
          <div className="metric-grid">
            <div className="metric-card">
              <span className="metric-label">Average rating</span>
              <strong>
                {developerSatisfaction.averageRating === null
                  ? "no data yet"
                  : `${developerSatisfaction.averageRating.toFixed(2)} / 5`}
              </strong>
              <span className="metric-detail">
                <BasisBadge basis="measured" /> {developerSatisfaction.responses} responses
              </span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Positive</span>
              <strong>{developerSatisfaction.positive}</strong>
              <span className="metric-detail">rated 4 or 5</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Negative</span>
              <strong>{developerSatisfaction.negative}</strong>
              <span className="metric-detail">rated 1 or 2</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Neutral</span>
              <strong>{developerSatisfaction.neutral}</strong>
              <span className="metric-detail">rated 3</span>
            </div>
          </div>
        ) : (
          <div className="empty-state compact">
            <p>
              <BasisBadge basis="unavailable" /> {developerSatisfaction.reason}
            </p>
            <p className="muted small">
              Ratings are captured only when a reviewer submits one, so this stays empty until real
              feedback arrives — it is never inferred.
            </p>
          </div>
        )}
      </section>

      <section className="surface" aria-label="Data sources">
        <div className="section-head">
          <div>
            <p className="eyebrow">Provenance</p>
            <h2>Every number traces to a real field</h2>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(m.provenance).map(([field, src]) => (
              <tr key={field}>
                <td>
                  <code>{field}</code>
                </td>
                <td className="muted small">{src}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="muted small">Computed {m.computedAt}</p>
    </>
  );
}
