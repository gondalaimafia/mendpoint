"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export function DetectButton({ consumerId }: { consumerId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${API_URL}/consumers/${consumerId}/detect`, {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(json));
      const names = (json.detected as Array<{ slug: string }>)?.map((d) => d.slug).join(", ");
      setMsg(
        names
          ? `Detected: ${names} (${json.linked?.filter((l: { created: boolean }) => l.created).length ?? 0} new monitors)`
          : "No known vendors detected in lockfiles/imports.",
      );
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" disabled={busy} onClick={run}>
        {busy ? "Detecting…" : "Auto-detect APIs"}
      </button>
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
