"use client";

import { useState } from "react";

export default function AccessPage() {
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");

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
    const next = new URLSearchParams(window.location.search).get("next");
    window.location.assign(next?.startsWith("/") ? next : "/console");
  }

  return (
    <div className="page">
      <section className="card" style={{ maxWidth: 480, margin: "4rem auto" }}>
        <h1>Operator access</h1>
        <p className="muted">
          Enter the configured preview access token. Human approvals require a verified identity session.
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
          className="btn primary"
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
