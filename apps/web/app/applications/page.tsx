"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./applications.module.css";

type ApplicationMetadata = {
  id: string;
  status: "new";
  purposeCode: string;
  consentVersion: string;
  consentGranted: true;
  authorizationConfirmed: true;
  createdAt: string;
  retentionExpiresAt: string;
  payloadState: "available" | "erased";
  erasedAt: string | null;
  erasureReasonCode: string | null;
};

type PrivatePayload = {
  contact: { name: string; workEmail: string; company: string; role: string };
  application: { providerChange: string; repositoryScope: string; successMetric: string };
};

type ApiEnvelope<T> = { data: T };

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  headers.set("X-Request-Id", crypto.randomUUID());
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  const result = await response.json().catch(() => null) as ApiEnvelope<T> | { error?: unknown } | null;
  if (!response.ok || !result || !("data" in result)) {
    throw new Error(response.status === 410 ? "Applicant details are no longer available." : "The application request failed.");
  }
  return result.data;
}

function displayDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
    .format(new Date(value));
}

export default function ApplicationsPage() {
  const [applications, setApplications] = useState<ApplicationMetadata[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [payload, setPayload] = useState<PrivatePayload | null>(null);
  const [purposeCode, setPurposeCode] = useState("application_review");
  const [erasureReason, setErasureReason] = useState("applicant_request");
  const [eraseArmed, setEraseArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Loading applications");

  const load = useCallback(async () => {
    setMessage("Loading applications");
    try {
      const result = await requestJson<ApplicationMetadata[]>("/api/design-partner-applications?limit=100");
      setApplications(result);
      setSelectedId((current) => current && result.some((item) => item.id === current)
        ? current
        : result[0]?.id ?? null);
      setMessage(result.length === 0 ? "No applications are waiting." : "");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Applications could not be loaded.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = applications.find((item) => item.id === selectedId) ?? null;

  async function reveal() {
    if (!selected) return;
    setBusy(true);
    setMessage("Recording access and retrieving applicant details");
    try {
      const result = await requestJson<{ application: ApplicationMetadata; payload: PrivatePayload }>(
        `/api/design-partner-applications/${encodeURIComponent(selected.id)}/reveals`,
        { method: "POST", body: JSON.stringify({ purposeCode }) },
      );
      setPayload(result.payload);
      setApplications((items) => items.map((item) => item.id === result.application.id ? result.application : item));
      setMessage("Access recorded. Applicant details are visible for this session.");
    } catch (error) {
      setPayload(null);
      setMessage(error instanceof Error ? error.message : "Applicant details could not be retrieved.");
    } finally {
      setBusy(false);
    }
  }

  async function erase() {
    if (!selected) return;
    if (!eraseArmed) {
      setEraseArmed(true);
      setMessage("Confirm erasure to permanently remove access to applicant details.");
      return;
    }
    setBusy(true);
    try {
      const result = await requestJson<{ application: ApplicationMetadata }>(
        `/api/design-partner-applications/${encodeURIComponent(selected.id)}/erasures`,
        { method: "POST", body: JSON.stringify({ reasonCode: erasureReason }) },
      );
      setApplications((items) => items.map((item) => item.id === result.application.id ? result.application : item));
      setPayload(null);
      setEraseArmed(false);
      setMessage("Applicant details were erased. Audit metadata remains available.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Applicant details could not be erased.");
    } finally {
      setBusy(false);
    }
  }

  async function purgeExpired() {
    setBusy(true);
    try {
      const result = await requestJson<{ purgedCount: number }>(
        "/api/design-partner-applications/retention-purges",
        { method: "POST", body: JSON.stringify({ limit: 100 }) },
      );
      setPayload(null);
      setMessage(`${result.purgedCount} expired application payload${result.purgedCount === 1 ? " was" : "s were"} erased.`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Expired applicant details could not be purged.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`workspace-page ${styles.page}`}>
      <header className={styles.header}>
        <div>
          <p className="eyebrow">Acquisition queue</p>
          <h1>Design partner applications</h1>
          <p className="lead">Review qualified applicants, record every sensitive access, and enforce retention.</p>
        </div>
        <button className="btn" type="button" onClick={purgeExpired} disabled={busy}>Purge expired details</button>
      </header>

      <p className={styles.notice} role="status" aria-live="polite">{message}</p>

      <div className={styles.layout}>
        <section className={`surface ${styles.queue}`} aria-labelledby="application-queue-title">
          <div className="section-head">
            <div>
              <p className="eyebrow">Queue</p>
              <h2 id="application-queue-title">Received applications</h2>
            </div>
            <span>{applications.length}</span>
          </div>
          {applications.length === 0 ? (
            <div className="empty-state"><p>No applications are waiting.</p></div>
          ) : (
            <ol className={styles.list}>
              {applications.map((application) => (
                <li key={application.id}>
                  <button
                    type="button"
                    className={application.id === selectedId ? styles.selected : undefined}
                    onClick={() => {
                      setSelectedId(application.id);
                      setPayload(null);
                      setEraseArmed(false);
                    }}
                    aria-pressed={application.id === selectedId}
                  >
                    <strong>{application.id}</strong>
                    <span>Received {displayDate(application.createdAt)}</span>
                    <span className={application.payloadState === "available" ? styles.available : styles.erased}>
                      {application.payloadState === "available" ? "Details available" : "Details erased"}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className={`surface ${styles.detail}`} aria-labelledby="application-detail-title">
          {!selected ? (
            <div className="empty-state"><p>Select an application to review its retention and access state.</p></div>
          ) : (
            <>
              <div className="section-head">
                <div>
                  <p className="eyebrow">Application detail</p>
                  <h2 id="application-detail-title">{selected.id}</h2>
                </div>
                <span className={selected.payloadState === "available" ? styles.available : styles.erased}>
                  {selected.payloadState}
                </span>
              </div>
              <dl className={styles.metadata}>
                <div><dt>Received</dt><dd>{displayDate(selected.createdAt)}</dd></div>
                <div><dt>Retention expires</dt><dd>{displayDate(selected.retentionExpiresAt)}</dd></div>
                <div><dt>Consent record</dt><dd>{selected.consentVersion}</dd></div>
                <div><dt>Authorization</dt><dd>{selected.authorizationConfirmed ? "Confirmed" : "Missing"}</dd></div>
              </dl>

              {selected.payloadState === "available" && !payload && (
                <div className={styles.accessPanel}>
                  <label htmlFor="reveal-purpose">Reason for access</label>
                  <select id="reveal-purpose" className="input" value={purposeCode} onChange={(event) => setPurposeCode(event.target.value)}>
                    <option value="application_review">Application review</option>
                    <option value="applicant_follow_up">Applicant follow up</option>
                    <option value="privacy_request">Privacy request</option>
                  </select>
                  <button className="btn primary" type="button" onClick={reveal} disabled={busy}>
                    Record access and reveal details
                  </button>
                </div>
              )}

              {payload && (
                <div className={styles.payload}>
                  <section>
                    <h3>Applicant</h3>
                    <dl className={styles.metadata}>
                      <div><dt>Name</dt><dd>{payload.contact.name}</dd></div>
                      <div><dt>Work email</dt><dd>{payload.contact.workEmail}</dd></div>
                      <div><dt>Company</dt><dd>{payload.contact.company}</dd></div>
                      <div><dt>Role</dt><dd>{payload.contact.role}</dd></div>
                    </dl>
                  </section>
                  <section><h3>Provider change</h3><p>{payload.application.providerChange}</p></section>
                  <section><h3>Repository scope</h3><p>{payload.application.repositoryScope}</p></section>
                  <section><h3>Success criterion</h3><p>{payload.application.successMetric}</p></section>
                </div>
              )}

              {selected.payloadState === "available" ? (
                <div className={styles.erasurePanel}>
                  <label htmlFor="erasure-reason">Erasure reason</label>
                  <select id="erasure-reason" className="input" value={erasureReason} onChange={(event) => setErasureReason(event.target.value)}>
                    <option value="applicant_request">Applicant request</option>
                    <option value="operator_request">Operator decision</option>
                    <option value="retention_expired">Retention expired</option>
                  </select>
                  <button className="btn" type="button" onClick={erase} disabled={busy}>
                    {eraseArmed ? "Confirm permanent erasure" : "Erase applicant details"}
                  </button>
                  {eraseArmed && <button className="btn" type="button" onClick={() => setEraseArmed(false)}>Cancel</button>}
                </div>
              ) : (
                <p className={styles.erasedMessage}>Sensitive details are no longer recoverable. The consent, retention, and erasure record remains.</p>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
