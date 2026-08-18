"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorGuidanceNote } from "../components/error-guidance-note";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

type AppConfig = {
  appId: string | null;
  appSlug: string;
  appName: string;
  configured: boolean;
  mockMode: boolean;
  permissions: Record<string, string>;
  events: string[];
};

type Installation = {
  id: string;
  installationId: string;
  accountLogin: string;
};

type InstallUrlResponse = { url: string; mock: boolean; state: string };

/**
 * Fetch the GitHub App install URL. Every failure mode of this path returns a
 * parseable JSON error body (401 `web_session_required`, 503
 * `proxy_api_key_not_configured`, 504 `upstream_timeout`), so `res.json()`
 * succeeds even on failure. Without the `res.ok` guard the wizard would treat an
 * error body as a success payload, advance to step 2, and render a dead install
 * link. Mirror `completeMockInstall`, which already checks `res.ok`.
 */
export async function fetchInstallUrlData(apiUrl: string): Promise<InstallUrlResponse> {
  const res = await fetch(`${apiUrl}/github/app/install-url`);
  const data = (await res.json()) as InstallUrlResponse & { error?: string };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

export function InstallWizard({
  config,
  initialInstallations,
}: {
  config: AppConfig;
  initialInstallations: Installation[];
}) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [login, setLogin] = useState("demo-org");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [installState, setInstallState] = useState<string | null>(null);

  async function fetchInstallUrl() {
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const data = await fetchInstallUrlData(API_URL);
      setInstallUrl(data.url);
      setInstallState(data.state);
      setStep(2);
      setMsg(data.mock ? "Mock mode — install completes without GitHub OAuth." : "Open GitHub to install.");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function completeMockInstall() {
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/github/app/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state: installState,
          accountLogin: login,
          accountType: "Organization",
          tenantId: "tenant_default",
          repositories: [{ owner: login, name: "shop-app" }],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setStep(3);
      setMsg(`Installed for ${data.installation?.accountLogin} (id ${data.installation?.installationId})`);
      router.refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Setup wizard</h2>
      <ol className="wizard-steps">
        <li className={step >= 1 ? "active" : ""}>1. Review permissions</li>
        <li className={step >= 2 ? "active" : ""}>2. Install App</li>
        <li className={step >= 3 ? "active" : ""}>3. Done</li>
      </ol>

      <div className="wizard-panel">
        <p>
          <strong>{config.appName}</strong>{" "}
          <span className="muted">
            ({config.mockMode ? "mock install mode" : `app:${config.appSlug}`})
          </span>
        </p>
        <p className="muted small">
          Permissions: {Object.entries(config.permissions).map(([k, v]) => `${k}:${v}`).join(", ")}
        </p>
        <p className="muted small">Events: {config.events.join(", ")}</p>

        {step === 1 && (
          <button type="button" className="btn primary" onClick={fetchInstallUrl} disabled={busy}>
            {busy ? "…" : "Continue"}
          </button>
        )}

        {step === 2 && (
          <div className="stack">
            {installUrl && config.mockMode && (
              <p className="mono small">
                Install URL: <a href={installUrl}>{installUrl}</a>
              </p>
            )}
            {config.mockMode ? (
              <>
                <label>
                  GitHub account login
                  <input
                    value={login}
                    onChange={(e) => setLogin(e.target.value)}
                    className="input"
                  />
                </label>
                <button
                  type="button"
                  className="btn primary"
                  onClick={completeMockInstall}
                  disabled={busy || !login || !installState}
                >
                  {busy ? "Installing…" : "Complete mock install"}
                </button>
              </>
            ) : (
              <a className="btn primary" href={installUrl ?? "#"}>
                Open GitHub install
              </a>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="stack">
            <p className="ok">GitHub App connected.</p>
            <p className="muted">
              Next: open <a href="/consumer">Consumer</a> and run auto-detect, or publish a provider
              change.
            </p>
          </div>
        )}

        {msg && <p className="muted small">{msg}</p>}
        {error != null && <ErrorGuidanceNote error={error} />}
        {initialInstallations.length > 0 && step < 3 && (
          <p className="muted small">
            Already installed: {initialInstallations.map((i) => i.accountLogin).join(", ")}
          </p>
        )}
      </div>
    </section>
  );
}
