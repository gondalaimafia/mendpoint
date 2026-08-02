"use client";

import { useState } from "react";

type FormState = "idle" | "submitting" | "success" | "error";

export function DesignPartnerApplicationForm() {
  const [state, setState] = useState<FormState>("idle");
  const [message, setMessage] = useState("");
  const [startedAt] = useState(() => Date.now());

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setState("submitting");
    setMessage("Submitting your application");
    try {
      const form = new FormData(formElement);
      const response = await fetch("/api/design-partners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          workEmail: form.get("workEmail"),
          company: form.get("company"),
          role: form.get("role"),
          providerChange: form.get("providerChange"),
          repositoryScope: form.get("repositoryScope"),
          successMetric: form.get("successMetric"),
          authorized: form.get("authorized") === "on",
          consent: form.get("consent") === "on",
          website: form.get("website"),
          startedAt,
        }),
      });
      const result = await response.json().catch(() => null) as {
        applicationId?: string;
        error?: string;
      } | null;
      if (!response.ok || !result?.applicationId) {
        setState("error");
        setMessage(
          result?.error === "rate_limited"
            ? "Too many requests. Please wait and try again."
            : "We could not submit the application. Check the fields and try again.",
        );
        return;
      }
      formElement.reset();
      setState("success");
      setMessage(`Application received. Reference ${result.applicationId}.`);
    } catch {
      setState("error");
      setMessage("We could not reach the application service. Please try again.");
    }
  }

  if (state === "success") {
    return (
      <section className="public-callout success-callout" role="status">
        <h2>Application received</h2>
        <p>{message}</p>
        <p>The pilot owner will review scope and respond through the work email you provided.</p>
      </section>
    );
  }

  return (
    <form className="application-form" onSubmit={submit} aria-describedby="application-boundary">
      <div className="form-grid">
        <label>
          Name
          <input className="input" name="name" autoComplete="name" required maxLength={120} />
        </label>
        <label>
          Work email
          <input className="input" name="workEmail" type="email" autoComplete="email" required maxLength={254} />
        </label>
        <label>
          Company
          <input className="input" name="company" autoComplete="organization" required maxLength={160} />
        </label>
        <label>
          Role
          <input className="input" name="role" autoComplete="organization-title" required maxLength={120} />
        </label>
      </div>
      <label>
        Provider change to validate
        <textarea className="input" name="providerChange" required minLength={20} maxLength={2000} rows={5} />
      </label>
      <label>
        Approved repository scope
        <textarea className="input" name="repositoryScope" required minLength={20} maxLength={2000} rows={5} />
      </label>
      <label>
        Measurable success criterion
        <textarea className="input" name="successMetric" required minLength={20} maxLength={1200} rows={4} />
      </label>
      <label className="honeypot" aria-hidden="true">
        Website
        <input name="website" tabIndex={-1} autoComplete="off" />
      </label>
      <label className="check-row">
        <input name="authorized" type="checkbox" required />
        <span>I am authorized to discuss the company and repository scope described here.</span>
      </label>
      <label className="check-row">
        <input name="consent" type="checkbox" required />
        <span>I agree that Mendpoint may use this information to evaluate and respond to this application.</span>
      </label>
      <p id="application-boundary" className="public-note">
        Read the privacy notice before submitting. Do not include confidential source material or credentials.
      </p>
      <button className="btn primary" type="submit" disabled={state === "submitting"}>
        {state === "submitting" ? "Submitting" : "Submit application"}
      </button>
      {message && <p className={state === "error" ? "error" : "muted"} role="status">{message}</p>}
    </form>
  );
}
