"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

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
  const [installUrl, setInstallUrl] = useState<string | null>(null);

  async function fetchInstallUrl() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${API_URL}/github/app/install-url`);
      const data = (await res.json()) as { url: string; mock: boolean };
      setInstallUrl(data.url);
      setStep(2);
      setMsg(data.mock ? "Mock mode — install completes without GitHub OAuth." : "Open GitHub to install.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function completeMockInstall() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${API_URL}/github/app/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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
      setMsg(e instanceof Error ? e.message : String(e));
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
            {installUrl && (
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
                  disabled={busy || !login}
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
        {initialInstallations.length > 0 && step < 3 && (
          <p className="muted small">
            Already installed: {initialInstallations.map((i) => i.accountLogin).join(", ")}
          </p>
        )}
      </div>
    </section>
  );
}
