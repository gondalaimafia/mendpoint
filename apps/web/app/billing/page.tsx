import { apiGet } from "../../lib/api";
import { PlanPicker } from "./plan-picker";

type Plan = {
  id: string;
  name: string;
  priceMonthlyUsd: number | null;
  seatLimit: number;
  features: string[];
};

type Tenant = {
  id: string;
  slug: string;
  name: string;
  plan: string;
  billingStatus: string;
  seatLimit: number;
  createdAt: string;
};

type UsageEntry = {
  id: string;
  entryType: "reservation" | "settlement" | "release" | "adjustment" | "credit";
  taskId: string;
  campaignId: string | null;
  reservedMcuMicrosDelta: number;
  consumedMcuMicrosDelta: number;
  invoiceReference: string | null;
  reason: string;
  createdAt: string;
};

type UsageResponse = {
  summary: {
    entitlement: {
      quotaMcuMicros: number;
      periodStart: string;
      periodEnd: string;
    } | null;
    reservedMcuMicros: number;
    consumedMcuMicros: number;
    creditedMcuMicros: number;
    availableMcuMicros: number | null;
    billableMoneyMicros: number | null;
    currency: string | null;
  };
  entries: UsageEntry[];
  reconciliation: { ok: boolean; checked: number; error?: string };
};

type GrossMarginResponse = {
  complete: boolean;
  currency: string | null;
  netRevenueMoneyMicros: number | null;
  actualCostMoneyMicros: number;
  exactGrossMarginMoneyMicros: number | null;
  unattributedRevenueMoneyMicros: number;
  incompleteAttributions: Array<{ code: string; taskId: string | null }>;
};

type BillingConfig = {
  manualPlanChangesEnabled: boolean;
  externalCollection: "disabled";
};

function mcu(value: number | null): string {
  return value === null ? "Not configured" : (value / 1_000_000).toFixed(3);
}

function money(value: number | null, currency: string | null): string {
  if (value === null || !currency) return "Not configured";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(value / 1_000_000);
}

export default async function BillingPage() {
  let plans: Plan[] = [];
  let tenants: Tenant[] = [];
  let usage: UsageResponse | null = null;
  let grossMargin: GrossMarginResponse | null = null;
  let config: BillingConfig | null = null;
  let error: string | null = null;
  const [plansResult, tenantsResult, usageResult, grossMarginResult, configResult] = await Promise.allSettled([
    apiGet<Plan[]>("/billing/plans"),
    apiGet<Tenant[]>("/tenants"),
    apiGet<UsageResponse>("/billing/usage"),
    apiGet<{ data: GrossMarginResponse }>("/billing/gross-margin"),
    apiGet<BillingConfig>("/billing/config"),
  ]);
  if (plansResult.status === "fulfilled") plans = plansResult.value;
  if (tenantsResult.status === "fulfilled") tenants = tenantsResult.value;
  if (usageResult.status === "fulfilled") usage = usageResult.value;
  if (grossMarginResult.status === "fulfilled") grossMargin = grossMarginResult.value.data;
  if (configResult.status === "fulfilled") config = configResult.value;
  error = [
    plansResult.status === "rejected" ? String(plansResult.reason) : null,
    tenantsResult.status === "rejected" ? String(tenantsResult.reason) : null,
    usageResult.status === "rejected" ? String(usageResult.reason) : null,
    grossMarginResult.status === "rejected" ? String(grossMarginResult.reason) : null,
    configResult.status === "rejected" ? String(configResult.reason) : null,
  ].filter(Boolean).join(". ") || null;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Billing & workspaces</h1>
        <p className="muted">
          Review plan access, quota, reservations, settled migration compute units, credits, and invoice references.
          External payment processing and tax handling are not configured.
        </p>
      </div>

      {error && (
        <div className="card">
          <p className="error">{error}</p>
        </div>
      )}

      {usage && (
        <>
          <section className="metrics-strip" aria-label="Current usage period">
            <div className="metric-card">
              <span className="metric-label">Reserved MCU</span>
              <strong>{mcu(usage.summary.reservedMcuMicros)}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Consumed MCU</span>
              <strong>{mcu(usage.summary.consumedMcuMicros)}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Available MCU</span>
              <strong>{mcu(usage.summary.availableMcuMicros)}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Current billable usage</span>
              <strong>{money(usage.summary.billableMoneyMicros, usage.summary.currency)}</strong>
            </div>
          </section>

          <section className="card">
            <div className="row-between">
              <div>
                <h2>Usage ledger</h2>
                <p className="muted small">
                  Integrity check: {usage.reconciliation.ok ? "passed" : "needs review"}, {usage.reconciliation.checked} entries checked
                </p>
              </div>
              <span className={`badge ${usage.reconciliation.ok ? "high" : "breaking"}`}>
                {usage.reconciliation.ok ? "Reconciled" : "Mismatch"}
              </span>
            </div>
            {usage.entries.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Type</th>
                      <th>Task</th>
                      <th>Reserved</th>
                      <th>Consumed</th>
                      <th>Invoice</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.entries.map((entry) => (
                      <tr key={entry.id}>
                        <td>{new Date(entry.createdAt).toLocaleString()}</td>
                        <td>{entry.entryType}</td>
                        <td><code>{entry.taskId}</code></td>
                        <td>{mcu(entry.reservedMcuMicrosDelta)}</td>
                        <td>{mcu(entry.consumedMcuMicrosDelta)}</td>
                        <td>{entry.invoiceReference ?? "Pending"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">No usage has been recorded for this workspace.</p>
            )}
          </section>
        </>
      )}

      {grossMargin && (
        <section className="card">
          <div className="row-between">
            <div>
              <h2>Gross margin reconciliation</h2>
              <p className="muted small">
                Revenue and actual execution cost are joined only when task attribution is complete.
              </p>
            </div>
            <span className={`badge ${grossMargin.complete ? "high" : "breaking"}`}>
              {grossMargin.complete ? "Complete" : "Attribution needed"}
            </span>
          </div>
          <dl className="kv">
            <dt>Net revenue</dt>
            <dd>{money(grossMargin.netRevenueMoneyMicros, grossMargin.currency)}</dd>
            <dt>Actual cost</dt>
            <dd>{money(grossMargin.actualCostMoneyMicros, grossMargin.currency)}</dd>
            <dt>Exact gross margin</dt>
            <dd>{money(grossMargin.exactGrossMarginMoneyMicros, grossMargin.currency)}</dd>
            <dt>Unattributed revenue</dt>
            <dd>{money(grossMargin.unattributedRevenueMoneyMicros, grossMargin.currency)}</dd>
          </dl>
          {!grossMargin.complete && (
            <p className="muted small">
              {grossMargin.incompleteAttributions.length} attribution issue{grossMargin.incompleteAttributions.length === 1 ? "" : "s"} must be resolved before margin is reported.
            </p>
          )}
        </section>
      )}

      <section className="grid">
        {plans.map((p) => (
          <div className="card" key={p.id}>
            <h3>{p.name}</h3>
            <p className="lead">
              {p.priceMonthlyUsd == null
                ? "Custom"
                : p.priceMonthlyUsd === 0
                  ? "Free"
                  : `$${p.priceMonthlyUsd}/mo`}
            </p>
            <p className="muted small">Up to {p.seatLimit} seats</p>
            <ul>
              {p.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Workspaces</h2>
        {tenants.map((t) => (
          <div key={t.id} className="row-between tenant-row">
            <div>
              <strong>{t.name}</strong>
              <div className="muted small">
                {t.slug} · plan <code>{t.plan}</code> · {t.billingStatus} · seats {t.seatLimit}
              </div>
            </div>
            <PlanPicker
              tenantId={t.id}
              currentPlan={t.plan}
              plans={plans.map((p) => p.id)}
              enabled={config?.manualPlanChangesEnabled === true}
            />
          </div>
        ))}
        {!tenants.length && <p className="muted">No tenants yet.</p>}
      </section>
    </div>
  );
}
