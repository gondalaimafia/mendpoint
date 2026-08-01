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

export default async function BillingPage() {
  let plans: Plan[] = [];
  let tenants: Tenant[] = [];
  let error: string | null = null;
  const [plansResult, tenantsResult] = await Promise.allSettled([
    apiGet<Plan[]>("/billing/plans"),
    apiGet<Tenant[]>("/tenants"),
  ]);
  if (plansResult.status === "fulfilled") plans = plansResult.value;
  if (tenantsResult.status === "fulfilled") tenants = tenantsResult.value;
  error = [
    plansResult.status === "rejected" ? String(plansResult.reason) : null,
    tenantsResult.status === "rejected" ? String(tenantsResult.reason) : null,
  ].filter(Boolean).join(". ") || null;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Billing & workspaces</h1>
        <p className="muted">
          Multi-tenant plans (stub). No real charges — plan changes are immediate for local demos.
          SSO and invoices are enterprise roadmap.
        </p>
      </div>

      {error && (
        <div className="card">
          <p className="error">{error}</p>
        </div>
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
            <PlanPicker tenantId={t.id} currentPlan={t.plan} plans={plans.map((p) => p.id)} />
          </div>
        ))}
        {!tenants.length && <p className="muted">No tenants yet.</p>}
      </section>
    </div>
  );
}
