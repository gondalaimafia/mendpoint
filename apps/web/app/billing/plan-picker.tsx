"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export function PlanPicker({
  tenantId,
  currentPlan,
  plans,
  enabled,
}: {
  tenantId: string;
  currentPlan: string;
  plans: string[];
  enabled: boolean;
}) {
  const router = useRouter();
  const [plan, setPlan] = useState(currentPlan);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${API_URL}/tenants/${tenantId}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setMsg(`Now on ${data.plan}`);
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="plan-picker">
      <select value={plan} onChange={(e) => setPlan(e.target.value)} className="input" disabled={!enabled}>
        {plans.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <button type="button" className="btn" onClick={save} disabled={!enabled || busy || plan === currentPlan}>
        {busy ? "…" : "Set plan"}
      </button>
      {!enabled && <span className="muted small">Plan changes require an approved manual contract.</span>}
      {msg && <span className="muted small">{msg}</span>}
    </div>
  );
}
