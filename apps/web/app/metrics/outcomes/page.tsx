import { apiGet } from "../../../lib/api";
import { OutcomeMetricsView, type OutcomeMetrics } from "./outcome-metrics-view";

export const dynamic = "force-dynamic";

export default async function OutcomeMetricsPage() {
  let m: OutcomeMetrics | null = null;
  let error: string | null = null;
  try {
    m = await apiGet<OutcomeMetrics>("/metrics/outcomes");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Customer outcome metrics</h1>
      <p className="lead">
        Tenant-scoped outcomes computed only from recorded runs. Metrics that cannot be
        computed truthfully are shown as &ldquo;no data yet&rdquo; or &ldquo;not measurable
        yet&rdquo; with the reason, never zero-filled or estimated as real.
      </p>
      {error && (
        <div className="card">
          <p className="muted">API unavailable: {error}</p>
        </div>
      )}
      {m && <OutcomeMetricsView m={m} />}
    </div>
  );
}
