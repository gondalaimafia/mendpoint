import Link from "next/link";
import { apiGet } from "../../../lib/api";
import { PlanEditor } from "./plan-editor";

export const dynamic = "force-dynamic";

type PlanRow = { runId: string; title?: string; steps: number };

export default async function PlansPage({
  searchParams,
}: {
  searchParams?: Promise<{ runId?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  let plans: PlanRow[] = [];
  let plan: unknown = null;
  let error: string | null = null;
  try {
    const list = await apiGet<{ plans: PlanRow[] }>("/platform/plans");
    plans = list.plans ?? [];
    if (sp.runId) {
      plan = await apiGet(`/platform/plans/${encodeURIComponent(sp.runId)}`);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>HITL plans</h1>
      <p className="lead">
        Human-in-the-loop plan edit. PATCH requires role with plan:edit (engineer+).
      </p>
      {error && <div className="card muted">API: {error}</div>}
      <div className="card">
        <ul>
          {plans.map((p) => (
            <li key={p.runId}>
              <Link href={`/platform/plans?runId=${encodeURIComponent(p.runId)}`}>
                {p.title ?? p.runId}
              </Link>{" "}
              <span className="muted small">
                {p.steps} steps · {p.runId}
              </span>
            </li>
          ))}
          {!plans.length && <li className="muted">No plans on disk</li>}
        </ul>
      </div>
      {sp.runId && plan !== null && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <h3>Edit {sp.runId}</h3>
          <PlanEditor runId={sp.runId} plan={plan as { title?: string; goal?: string }} />
          <pre
            style={{
              whiteSpace: "pre-wrap",
              fontSize: "0.8rem",
              maxHeight: 320,
              overflow: "auto",
            }}
          >
            {JSON.stringify(plan, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
