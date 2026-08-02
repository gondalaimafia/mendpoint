"use client";

import { useEffect, useState } from "react";

export default function AccessPage() {
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [next, setNext] = useState("/console");
  const [identityEnabled, setIdentityEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    const candidate = new URLSearchParams(window.location.search).get("next");
    setNext(candidate?.startsWith("/") && !candidate.startsWith("//") ? candidate : "/console");
    void fetch("/api/oidc/config", { cache: "no-store" })
      .then(async (response) => response.json())
      .then((body: { enabled?: boolean }) => setIdentityEnabled(body.enabled === true))
      .catch(() => setIdentityEnabled(false));
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
    window.location.assign(next.startsWith("/") && !next.startsWith("//") ? next : "/console");
  }

  return (
    <div className="page">
      <section className="card" style={{ maxWidth: 480, margin: "4rem auto" }}>
        <h1>Operator access</h1>
        <p className="muted">
          Company identity is required to approve or reject a migration candidate.
        </p>
        {identityEnabled === true ? (
          <a className="btn primary" href={`/api/oidc/start?next=${encodeURIComponent(next)}`}>
            Sign in with company identity
          </a>
        ) : identityEnabled === false ? (
          <p className="muted small">
            Company identity is not configured for this private preview. Human decisions are unavailable.
          </p>
        ) : (
          <p className="muted small">Checking company identity</p>
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
