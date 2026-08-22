import { apiGet } from "../../../lib/api";
import { DashboardView, type SelfServeDashboard } from "./dashboard-view";

export const dynamic = "force-dynamic";

export default async function SelfServeDashboardPage() {
  let m: SelfServeDashboard | null = null;
  let error: string | null = null;
  try {
    m = await apiGet<SelfServeDashboard>("/metrics/dashboard");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Self-serve dashboard</h1>
      <p className="lead">
        Tenant-scoped adoption, task outcomes, reliability, cost, and developer satisfaction,
        computed only from recorded rows. Dimensions with no faithful source are shown as not
        instrumented, never zero-filled or estimated. Pull your own numbers with the exports below.
      </p>
      <p className="command-actions" aria-label="Exports">
        <a className="btn" href="/api/metrics/dashboard/export?format=csv">
          Export CSV
        </a>
        <a className="btn" href="/api/metrics/dashboard/export?format=json">
          Export JSON
        </a>
      </p>
      {error && (
        <div className="card">
          <p className="muted">API unavailable: {error}</p>
        </div>
      )}
      {m && <DashboardView m={m} />}
    </div>
  );
}
