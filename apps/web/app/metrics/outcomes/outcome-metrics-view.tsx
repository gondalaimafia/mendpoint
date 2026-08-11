import React from "react";

export type MetricBasis = "measured" | "proxy" | "unavailable";

export type RateMetric = {
  value: number | null;
  numerator: number;
  denominator: number;
  basis: MetricBasis;
  reason?: string;
};

export type OutcomeMetrics = {
  tenantId: string;
  window: { since: string | null; until: string | null };
  totalRuns: number;
  candidateProducingRuns: number;
  acceptedCandidates: number;
  acceptedCandidateRate: RateMetric;
  escapedRegressionRate: {
    value: null;
    basis: "unavailable";
    reason: string;
    nearestProxy: RateMetric & { name: string; note: string };
  };
  humanInterventionRate: RateMetric;
  costPerAcceptedPr: {
    value: number | null;
    currency: "USD";
    acceptedCount: number;
    measuredAcceptedCount: number;
    totalMeasuredCostUsd: number | null;
    basis: "measured";
    reason?: string;
    note?: string;
  };
  timeToCandidate: {
    p50Ms: number | null;
    p95Ms: number | null;
    sampleSize: number;
    excludedReviewedRuns: number;
    basis: "measured";
    reason?: string;
    note: string;
  };
  externalBaseline: {
    disclaimer: string;
    headToHeadMeasured: boolean;
    references: Array<{
      id: string;
      source: string;
      system: string;
      benchmark: string;
      metric: string;
      value: number;
      unit: "rate";
      asOf: string;
      evidenceQuality: string;
      comparability: string;
      sourceUrl: string;
      note: string;
    }>;
  };
  computedAt: string;
};

function pct(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "no data yet";
  return `${(n * 100).toFixed(1)}%`;
}

function duration(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return "no data yet";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)} s`;
  return `${(s / 60).toFixed(1)} min`;
}

function usd(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "no data yet";
  return `$${n.toFixed(4)}`;
}

function BasisTag({ basis }: { basis: MetricBasis }) {
  const label =
    basis === "measured" ? "measured" : basis === "proxy" ? "proxy" : "not measurable yet";
  return <span className={`badge ${basis}`}>{label}</span>;
}

export function OutcomeMetricsView({ m }: { m: OutcomeMetrics }) {
  const cost = m.costPerAcceptedPr;
  const ttc = m.timeToCandidate;
  return (
    <>
      <div className="grid">
        <div className="card">
          <h3>Accepted-candidate rate</h3>
          <p style={{ fontSize: "1.75rem", margin: 0 }}>{pct(m.acceptedCandidateRate.value)}</p>
          <p className="muted small">
            <BasisTag basis={m.acceptedCandidateRate.basis} /> approved{" "}
            {m.acceptedCandidateRate.numerator} / {m.acceptedCandidateRate.denominator}{" "}
            candidate-producing runs
          </p>
          {m.acceptedCandidateRate.reason && (
            <p className="muted small">{m.acceptedCandidateRate.reason}</p>
          )}
        </div>

        <div className="card">
          <h3>Escaped-regression rate</h3>
          <p style={{ fontSize: "1.75rem", margin: 0 }}>not measurable yet</p>
          <p className="muted small">
            <BasisTag basis="unavailable" /> {m.escapedRegressionRate.reason}
          </p>
          <p className="muted small">
            Nearest recorded signal (proxy, not an escape measure) —{" "}
            <strong>{m.escapedRegressionRate.nearestProxy.name}</strong>:{" "}
            {pct(m.escapedRegressionRate.nearestProxy.value)}. {m.escapedRegressionRate.nearestProxy.note}
          </p>
        </div>

        <div className="card">
          <h3>Human-intervention rate</h3>
          <p style={{ fontSize: "1.75rem", margin: 0 }}>{pct(m.humanInterventionRate.value)}</p>
          <p className="muted small">
            <BasisTag basis={m.humanInterventionRate.basis} /> {m.humanInterventionRate.numerator} /{" "}
            {m.humanInterventionRate.denominator} runs required a human action
          </p>
          {m.humanInterventionRate.reason && (
            <p className="muted small">{m.humanInterventionRate.reason}</p>
          )}
        </div>

        <div className="card">
          <h3>Cost per accepted PR</h3>
          <p style={{ fontSize: "1.75rem", margin: 0 }}>{usd(cost.value)}</p>
          <p className="muted small">
            <BasisTag basis="measured" /> measured for {cost.measuredAcceptedCount} of{" "}
            {cost.acceptedCount} accepted
          </p>
          {cost.reason && <p className="muted small">{cost.reason}</p>}
          {cost.note && <p className="muted small">{cost.note}</p>}
        </div>

        <div className="card">
          <h3>Time-to-candidate</h3>
          <p style={{ fontSize: "1.75rem", margin: 0 }}>
            p50 {duration(ttc.p50Ms)} · p95 {duration(ttc.p95Ms)}
          </p>
          <p className="muted small">
            <BasisTag basis="measured" /> n={ttc.sampleSize}, excluded reviewed {ttc.excludedReviewedRuns}
          </p>
          {ttc.reason && <p className="muted small">{ttc.reason}</p>}
          <p className="muted small">{ttc.note}</p>
        </div>

        <div className="card">
          <h3>Runs in window</h3>
          <p style={{ fontSize: "1.75rem", margin: 0 }}>{m.totalRuns}</p>
          <p className="muted small">
            candidate-producing {m.candidateProducingRuns} · accepted {m.acceptedCandidates}
          </p>
        </div>
      </div>

      <h2>External baseline reference</h2>
      <p className="muted small">{m.externalBaseline.disclaimer}</p>
      <table>
        <thead>
          <tr>
            <th>System</th>
            <th>Benchmark</th>
            <th>Metric</th>
            <th>Reported</th>
            <th>Evidence</th>
            <th>Comparability</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {m.externalBaseline.references.map((r) => (
            <tr key={r.id}>
              <td>{r.system}</td>
              <td>{r.benchmark}</td>
              <td>{r.metric}</td>
              <td>
                {(r.value * 100).toFixed(2)}%{" "}
                <span className="badge external">external reference, not our measurement</span>
              </td>
              <td>{r.evidenceQuality}</td>
              <td>{r.comparability}</td>
              <td>
                <a href={r.sourceUrl} target="_blank" rel="noreferrer">
                  source ↗
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Computed {m.computedAt}</p>
    </>
  );
}
