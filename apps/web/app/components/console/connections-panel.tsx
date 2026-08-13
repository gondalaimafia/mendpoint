"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, SectionLabel, StatusPill } from "../ds/index.js";

/**
 * Connections surface (S3-connectors) rendered inside `/settings` only when the
 * self-serve flag is on. Lists the tenant's CI/CD, ticketing, and documentation
 * connectors with connect / verify / disconnect, shows verification status, and
 * surfaces the API's actionable `errorHint` on failure. All calls go through the
 * `/api` proxy, which carries the session's tenant scope; a tenant never sees
 * another tenant's connectors.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

type CredentialField = Readonly<{ key: string; label: string; required: boolean; secret: boolean }>;
type CatalogEntry = Readonly<{ kind: string; provider: string; label: string; fields: readonly CredentialField[] }>;
type Connector = Readonly<{
  id: string;
  kind: string;
  provider: string;
  displayName: string;
  mode: string;
  credentialConfigured: boolean;
  healthStatus: "unverified" | "verified" | "failed" | "revoked";
  verified: boolean;
  available: boolean;
  errorCode: string | null;
  errorHint: string | null;
  lastVerifiedAt: string | null;
}>;

const KIND_LABEL: Record<string, string> = {
  ci: "CI / CD",
  ticketing: "Ticketing",
  docs: "Documentation",
};

function healthTone(status: Connector["healthStatus"]): "neutral" | "danger" | "warn" | "emerald" {
  if (status === "verified") return "emerald";
  if (status === "failed") return "danger";
  if (status === "revoked") return "warn";
  return "neutral";
}

export function ConnectionsPanel() {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string>("");
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState<"mock" | "real">("mock");
  const [token, setToken] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});

  const active = useMemo(
    () => catalog.find((entry) => `${entry.kind}:${entry.provider}` === selected),
    [catalog, selected],
  );

  const refresh = useCallback(async () => {
    try {
      const [catalogRes, listRes] = await Promise.all([
        fetch(`${API_URL}/self-serve/connectors/catalog`, { headers: { accept: "application/json" } }),
        fetch(`${API_URL}/self-serve/connectors`, { headers: { accept: "application/json" } }),
      ]);
      if (catalogRes.ok) {
        const body = (await catalogRes.json()) as { families: CatalogEntry[] };
        setCatalog(body.families);
        if (!selected && body.families.length > 0) {
          setSelected(`${body.families[0]!.kind}:${body.families[0]!.provider}`);
        }
      }
      if (listRes.ok) {
        const body = (await listRes.json()) as { connectors: Connector[] };
        setConnectors(body.connectors);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, [selected]);

  useEffect(() => {
    void refresh();
    // Load once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect() {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        kind: active.kind,
        provider: active.provider,
        displayName,
        mode,
      };
      if (token.trim() !== "") payload.token = token;
      for (const field of active.fields) {
        if (field.secret) continue;
        const value = fields[field.key];
        if (value && value.trim() !== "") payload[field.key] = value;
      }
      const res = await fetch(`${API_URL}/self-serve/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error((body as { error?: string }).error ?? "connect failed");
      setDisplayName("");
      setToken("");
      setFields({});
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/self-serve/connectors/${id}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const body = (await res.json()) as { health?: { errorHint?: string | null } };
      if (!res.ok && body.health?.errorHint) setError(body.health.errorHint);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(id: string) {
    setBusy(true);
    setError(null);
    try {
      await fetch(`${API_URL}/self-serve/connectors/${id}`, { method: "DELETE" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ds-panel ds-panel--pad ds-settings__card">
      <div className="section-label section-label--muted">CONNECTIONS</div>
      <p className="ds-field__hint">
        Connect your CI/CD, ticketing, and documentation tools through guided setup. Mock mode needs no
        credentials; real mode stores secrets encrypted and requires a verified health check before use.
      </p>

      <div className="ds-form" style={{ marginTop: 16 }}>
        {!loaded && <p className="ds-field__hint">Loading connections…</p>}
        {loaded && connectors.length === 0 && (
          <p className="ds-field__hint">No connections yet. Add one below.</p>
        )}
        {connectors.map((connector) => (
          <div key={connector.id} className="ds-field" data-connector-id={connector.id}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <SectionLabel tone="muted">{KIND_LABEL[connector.kind] ?? connector.kind}</SectionLabel>
              <strong>{connector.displayName}</strong>
              <span className="ds-field__hint">{connector.provider}</span>
              <Badge tone={healthTone(connector.healthStatus)}>{connector.healthStatus}</Badge>
              {connector.available ? (
                <StatusPill status="merged" label="available" />
              ) : (
                <StatusPill status="pending" label="unavailable" />
              )}
              <button
                type="button"
                className="ds-btn ds-btn--outline"
                disabled={busy || connector.healthStatus === "revoked"}
                onClick={() => void verify(connector.id)}
              >
                Verify
              </button>
              <button
                type="button"
                className="ds-btn ds-btn--ghost"
                disabled={busy || connector.healthStatus === "revoked"}
                onClick={() => void disconnect(connector.id)}
              >
                Disconnect
              </button>
            </div>
            {connector.errorHint && <span className="ds-field__hint">{connector.errorHint}</span>}
          </div>
        ))}
      </div>

      <div className="ds-form" style={{ marginTop: 20 }}>
        <div className="section-label section-label--muted">ADD A CONNECTION</div>
        <div className="ds-field">
          <label className="ds-field__label" htmlFor="connector-provider">
            Provider
          </label>
          <select
            id="connector-provider"
            className="ds-select"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {catalog.map((entry) => (
              <option key={`${entry.kind}:${entry.provider}`} value={`${entry.kind}:${entry.provider}`}>
                {(KIND_LABEL[entry.kind] ?? entry.kind) + " — " + entry.label}
              </option>
            ))}
          </select>
        </div>
        <div className="ds-field">
          <label className="ds-field__label" htmlFor="connector-name">
            Display name
          </label>
          <input
            id="connector-name"
            className="ds-input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Acme production CI"
          />
        </div>
        <div className="ds-field">
          <label className="ds-field__label" htmlFor="connector-mode">
            Mode
          </label>
          <select
            id="connector-mode"
            className="ds-select"
            value={mode}
            onChange={(e) => setMode(e.target.value === "real" ? "real" : "mock")}
          >
            <option value="mock">Mock (no credentials)</option>
            <option value="real">Real (credential-gated)</option>
          </select>
        </div>
        {mode === "real" &&
          active?.fields.map((field) =>
            field.secret ? (
              <div className="ds-field" key={field.key}>
                <label className="ds-field__label" htmlFor="connector-token">
                  {field.label}
                </label>
                <input
                  id="connector-token"
                  className="ds-input ds-input--mono"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="off"
                />
              </div>
            ) : (
              <div className="ds-field" key={field.key}>
                <label className="ds-field__label" htmlFor={`connector-${field.key}`}>
                  {field.label}
                  {field.required ? "" : " (optional)"}
                </label>
                <input
                  id={`connector-${field.key}`}
                  className="ds-input"
                  value={fields[field.key] ?? ""}
                  onChange={(e) => setFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
                />
              </div>
            ),
          )}
        <div className="ds-form-foot">
          <button
            type="button"
            className="ds-btn ds-btn--primary"
            disabled={busy || displayName.trim() === "" || !active}
            onClick={() => void connect()}
          >
            Connect
          </button>
        </div>
      </div>

      {error && <p className="ds-field__hint" role="alert">{error}</p>}
    </section>
  );
}
