"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export function PublishForm({ providers }: { providers: Array<{ slug: string; name: string }> }) {
  const router = useRouter();
  const [slug, setSlug] = useState(providers[0]?.slug ?? "acme-payments");
  const [versionLabel, setVersionLabel] = useState("");
  const [changelogMd, setChangelogMd] = useState("");
  const [openapiText, setOpenapiText] = useState("");
  const [runPipeline, setRunPipeline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      let openapi: unknown;
      try {
        openapi = JSON.parse(openapiText);
      } catch {
        throw new Error("OpenAPI must be valid JSON");
      }
      const res = await fetch(`${API_URL}/providers/${slug}/publish-version`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versionLabel: versionLabel || `v-${Date.now()}`,
          openapi,
          changelogMd: changelogMd || undefined,
          runPipeline,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(json));
      setMsg(
        json.jobId
          ? `Version ${json.versionLabel} saved. Analysis job ${json.jobId} is queued.`
          : json.pipeline
            ? `Published ${json.versionLabel}. Pipeline change ${json.pipeline.changeId} · ${json.pipeline.consumers?.length ?? 0} consumer(s).`
          : json.pipelineError
            ? `Version saved; pipeline: ${json.pipelineError}`
            : `Version ${json.versionLabel} uploaded (pipeline not run).`,
      );
      router.refresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={submit} style={{ gap: "0.75rem" }}>
      <h3 style={{ margin: 0 }}>Publish OpenAPI version</h3>
      <p className="muted" style={{ margin: 0 }}>
        Upload a new schema and optionally queue impact analysis for monitored consumers.
      </p>
      <label className="muted">
        Provider{" "}
        <select
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          style={{ display: "block", width: "100%", marginTop: 4 }}
        >
          {providers.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name} ({p.slug})
            </option>
          ))}
        </select>
      </label>
      <label className="muted">
        Version label{" "}
        <input
          value={versionLabel}
          onChange={(e) => setVersionLabel(e.target.value)}
          placeholder="2.1.0"
          style={{ display: "block", width: "100%", marginTop: 4 }}
        />
      </label>
      <label className="muted">
        OpenAPI JSON{" "}
        <textarea
          value={openapiText}
          onChange={(e) => setOpenapiText(e.target.value)}
          rows={8}
          placeholder='{ "openapi": "3.0.3", "paths": { ... } }'
          style={{ display: "block", width: "100%", marginTop: 4, fontFamily: "var(--mono)" }}
          required
        />
      </label>
      <label className="muted">
        Changelog (markdown){" "}
        <textarea
          value={changelogMd}
          onChange={(e) => setChangelogMd(e.target.value)}
          rows={3}
          style={{ display: "block", width: "100%", marginTop: 4 }}
        />
      </label>
      <label className="muted" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={runPipeline}
          onChange={(e) => setRunPipeline(e.target.checked)}
        />
        Queue impact analysis after upload
      </label>
      <button className="primary" type="submit" disabled={busy || !providers.length}>
        {busy ? "Publishing…" : "Publish version"}
      </button>
      {msg && <p className="muted">{msg}</p>}
    </form>
  );
}
