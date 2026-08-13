"use client";

import { useState } from "react";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function signUp() {
    setBusy(true);
    setMessage("Creating your workspace");
    try {
      const response = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, workspaceName }),
      });
      if (response.status === 409) {
        setMessage("An account already exists for this email.");
        return;
      }
      if (!response.ok) {
        setMessage("Signup is unavailable right now.");
        return;
      }
      window.location.assign("/console");
    } catch {
      setMessage("Signup is unavailable right now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <section className="card" style={{ maxWidth: 480, margin: "4rem auto" }}>
        <h1>Create your workspace</h1>
        <p className="muted">
          Start a new Mendpoint workspace. You become its owner and receive an API key.
        </p>
        <label>
          Work email
          <input
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          Workspace name
          <input
            className="input"
            type="text"
            autoComplete="organization"
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
          />
        </label>
        <button
          className="btn primary"
          type="button"
          onClick={signUp}
          disabled={busy || !email}
        >
          Create workspace
        </button>
        {message && <p className="muted small">{message}</p>}
      </section>
    </div>
  );
}
