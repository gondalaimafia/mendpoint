"use client";

import { useEffect, useState } from "react";
import { safeLocalReturn } from "../../lib/safe-return";

export default function AccessPage() {
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [next, setNext] = useState("/console");
  const [identityEnabled, setIdentityEnabled] = useState<boolean | null>(null);
  const [samlEnabled, setSamlEnabled] = useState<boolean | null>(null);
  const returningFromGitHub = next.startsWith("/github/setup?");

  useEffect(() => {
    const candidate = new URLSearchParams(window.location.search).get("next");
    setNext(safeLocalReturn(candidate));
    void fetch("/api/oidc/config", { cache: "no-store" })
      .then(async (response) => response.json())
      .then((body: { enabled?: boolean }) => setIdentityEnabled(body.enabled === true))
      .catch(() => setIdentityEnabled(false));
    void fetch("/api/saml/config", { cache: "no-store" })
      .then(async (response) => response.json())
      .then((body: { enabled?: boolean }) => setSamlEnabled(body.enabled === true))
      .catch(() => setSamlEnabled(false));
  }, []);

  async function signIn() {
    setMessage("Signing in");
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) {
      setMessage("Access denied");
      return;
    }
    window.location.assign(safeLocalReturn(next));
  }

  return (
    <div className="page">
      <section className="card" style={{ maxWidth: 480, margin: "4rem auto" }}>
        <h1>Operator access</h1>
        <p className="muted">
          {returningFromGitHub
            ? "GitHub installation returned. Sign in to finish connecting it."
            : "Company identity is required to approve or reject a migration candidate."}
        </p>
        {identityEnabled === true ? (
          <a className="btn primary" href={`/api/oidc/start?next=${encodeURIComponent(next)}`}>
            Sign in with company identity
          </a>
        ) : identityEnabled === false && samlEnabled !== true ? (
          <p className="muted small">
            Company identity is not configured for this private preview. Human decisions are unavailable.
          </p>
        ) : identityEnabled === null ? (
          <p className="muted small">Checking company identity</p>
        ) : null}
        {samlEnabled === true && (
          <a className="btn primary" href={`/api/saml/start?next=${encodeURIComponent(next)}`}>
            Sign in with SAML SSO
          </a>
        )}
        <hr />
        <p className="muted small">
          Preview access is read only for human decisions.
        </p>
        <label>
          Access token
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <button
          className="btn"
          type="button"
          onClick={signIn}
          disabled={!token}
        >
          Sign in
        </button>
        {message && <p className="muted small">{message}</p>}
      </section>
    </div>
  );
}
