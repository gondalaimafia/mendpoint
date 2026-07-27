"use client";

import { useState } from "react";
import { apiBase } from "../../../lib/api";

export function PlanEditor({
  runId,
  plan,
}: {
  runId: string;
  plan: { title?: string; goal?: string };
}) {
  const [title, setTitle] = useState(plan.title ?? "");
  const [goal, setGoal] = useState(plan.goal ?? "");
  const [msg, setMsg] = useState("");

  async function save() {
    setMsg("saving…");
    try {
      const res = await fetch(
        `${apiBase()}/platform/plans/${encodeURIComponent(runId)}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-role": "engineer",
            "x-tenant-id": "default",
            "x-user-id": "hitl-ui",
          },
          body: JSON.stringify({ title, goal }),
        },
      );
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? res.statusText);
      setMsg("saved");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div style={{ display: "grid", gap: "0.5rem", marginBottom: "1rem" }}>
      <label>
        Title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={{ width: "100%" }}
        />
      </label>
      <label>
        Goal
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={3}
          style={{ width: "100%" }}
        />
      </label>
      <button type="button" onClick={save}>
        Save plan (HITL)
      </button>
      {msg && <p className="muted small">{msg}</p>}
    </div>
  );
}
