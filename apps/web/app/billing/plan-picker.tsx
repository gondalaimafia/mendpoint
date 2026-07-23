"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function PlanPicker({
  tenantId,
  currentPlan,
  plans,
}: {
  tenantId: string;
  currentPlan: string;
  plans: string[];
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
      <select value={plan} onChange={(e) => setPlan(e.target.value)} className="input">
        {plans.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <button type="button" className="btn" onClick={save} disabled={busy || plan === currentPlan}>
        {busy ? "…" : "Set plan"}
      </button>
      {msg && <span className="muted small">{msg}</span>}
    </div>
  );
}
