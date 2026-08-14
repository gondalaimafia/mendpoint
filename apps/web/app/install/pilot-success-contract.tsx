"use client";

import React, { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

type Owner = { responsibility: string; principalId: string };
type PilotDefinition = {
  providerChange: { provider: string; changeClass: string; description: string };
  repositories: Array<{ owner: string; name: string; branch: string; scope: string }>;
  thresholds: Array<{ metric: string; operator: string; target: number; unit: string }>;
  owners: Owner[];
  supportResponses: Array<{ severity: string; responseMinutes: number; coverage: string }>;
  privacy: { dataCategories: string[]; retentionDays: number; processingRegions: string[]; deletionProcedure: string };
  rollback: { trigger: string; procedure: string; ownerPrincipalId: string; recoveryMinutes: number };
  weeklyReview: { dayOfWeek: string; timeUtc: string; ownerPrincipalId: string; agenda: string[] };
  conversionDecision: { decisionDueAt: string; ownerPrincipalId: string; criteria: string[] };
};

export type PilotContractSummary = {
  id: string;
  version: number;
  title: string;
  status: "draft" | "approved";
  contentSha256: string;
  definition: PilotDefinition;
  approval: null | { reviewerPrincipalId: string; rationale: string; createdAt: string };
};

function errorMessage(value: unknown): string {
  if (value && typeof value === "object") {
    const response = value as { error?: string | { message?: string; code?: string } };
    if (typeof response.error === "string") return response.error;
    if (response.error?.message) return response.error.message;
    if (response.error?.code) return response.error.code;
  }
  return "The pilot contract operation could not be completed.";
}

export function PilotSuccessContractPanel({
  initialContracts,
  defaultRepositoryOwner,
  defaultDecisionDate,
}: {
  initialContracts: PilotContractSummary[];
  defaultRepositoryOwner: string;
  defaultDecisionDate: string;
}) {
  const [contracts, setContracts] = useState(initialContracts);
  const [editing, setEditing] = useState<PilotContractSummary | null>(null);
  const [title, setTitle] = useState("First production migration pilot");
  const [provider, setProvider] = useState("Provider API");
  const [changeClass, setChangeClass] = useState("breaking");
  const [description, setDescription] = useState("Migrate one approved provider change with a verified draft pull request.");
  const [repositoryOwner, setRepositoryOwner] = useState(defaultRepositoryOwner || "customer");
  const [repositoryName, setRepositoryName] = useState("application");
  const [reviewerPrincipalId, setReviewerPrincipalId] = useState("");
  const [thresholdTarget, setThresholdTarget] = useState(1);
  const [decisionDate, setDecisionDate] = useState(defaultDecisionDate);
  const [rationale, setRationale] = useState("Scope, thresholds, controls, and conversion criteria are accepted.");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function definition(): PilotDefinition {
    const owner = "current_operator";
    return {
      providerChange: { provider, changeClass, description },
      repositories: [{ owner: repositoryOwner, name: repositoryName, branch: "main", scope: "provider integration and tests" }],
      thresholds: [
        { metric: "verified migration pull requests", operator: "gte", target: thresholdTarget, unit: "pull requests" },
        { metric: "unresolved critical regressions", operator: "eq", target: 0, unit: "regressions" },
      ],
      owners: [
        { responsibility: "customer_owner", principalId: owner },
        { responsibility: "mendpoint_owner", principalId: owner },
        { responsibility: "technical_reviewer", principalId: reviewerPrincipalId },
        { responsibility: "privacy_contact", principalId: owner },
        { responsibility: "rollback_owner", principalId: owner },
      ],
      supportResponses: [
        { severity: "critical", responseMinutes: 30, coverage: "Agreed pilot support window" },
        { severity: "standard", responseMinutes: 240, coverage: "Agreed pilot support window" },
      ],
      privacy: {
        dataCategories: [
          "repository working checkout (deletable on request)",
          "snapshot file metadata, generated patch content, and audit events (append-only, retained)",
        ],
        retentionDays: 30,
        processingRegions: ["agreed pilot region"],
        // Scoped deliberately to what the platform can actually perform. The only
        // byte-deletion path is the on-disk checkout purge; snapshot metadata,
        // patch content, and audit events sit behind BEFORE DELETE triggers and
        // cannot be removed by any code path. Do not widen this wording without
        // building a deletion path for those tables first.
        deletionProcedure:
          "On request, the operator deletes the on-disk working checkout for the repository and returns evidence. " +
          "Retention is not automatically enforced; deletion is operator-initiated. " +
          "Snapshot file metadata, generated patch content, and audit events are append-only and are not removed by this procedure.",
      },
      rollback: {
        trigger: "A critical verification regression or an unauthorized file change.",
        procedure: "Close the draft pull request and restore the recorded repository snapshot.",
        ownerPrincipalId: owner,
        recoveryMinutes: 60,
      },
      weeklyReview: {
        dayOfWeek: "Wednesday",
        timeUtc: "16:00",
        ownerPrincipalId: owner,
        agenda: ["thresholds", "support incidents", "privacy requests", "conversion risks"],
      },
      conversionDecision: {
        decisionDueAt: `${decisionDate}T16:00:00.000Z`,
        ownerPrincipalId: owner,
        criteria: ["All measurable thresholds pass", "Customer and Mendpoint owners accept the operating review"],
      },
    };
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const path = editing
        ? `${API_URL}/pilot-success-contracts/${encodeURIComponent(editing.id)}/revisions`
        : `${API_URL}/pilot-success-contracts`;
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(editing ? { expectedVersion: editing.version } : {}),
          title,
          definition: definition(),
        }),
      });
      const payload = await response.json() as { data?: PilotContractSummary; error?: unknown };
      if (!response.ok || !payload.data) throw new Error(errorMessage(payload));
      setContracts((current) => [payload.data!, ...current.filter((item) => item.id !== payload.data!.id)]);
      setEditing(null);
      setMessage(`Pilot contract version ${payload.data.version} saved for reviewer approval.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function approve(contract: PilotContractSummary) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `${API_URL}/pilot-success-contracts/${encodeURIComponent(contract.id)}/versions/${contract.version}/approvals`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rationale }) },
      );
      const payload = await response.json() as { data?: PilotContractSummary; error?: unknown };
      if (!response.ok || !payload.data) throw new Error(errorMessage(payload));
      setContracts((current) => current.map((item) => item.id === payload.data!.id ? payload.data! : item));
      setMessage(`Pilot contract version ${payload.data.version} approved with immutable evidence.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function startRevision(contract: PilotContractSummary) {
    setEditing(contract);
    setTitle(contract.title);
    setProvider(contract.definition.providerChange.provider);
    setChangeClass(contract.definition.providerChange.changeClass);
    setDescription(contract.definition.providerChange.description);
    setRepositoryOwner(contract.definition.repositories[0]?.owner ?? defaultRepositoryOwner);
    setRepositoryName(contract.definition.repositories[0]?.name ?? "application");
    setReviewerPrincipalId(
      contract.definition.owners.find((owner) => owner.responsibility === "technical_reviewer")?.principalId ?? "",
    );
    setThresholdTarget(contract.definition.thresholds.find((threshold) =>
      threshold.metric === "verified migration pull requests")?.target ?? 1);
    setDecisionDate(contract.definition.conversionDecision.decisionDueAt.slice(0, 10));
    setMessage(`Editing version ${contract.version + 1}. Earlier evidence remains unchanged.`);
  }

  return (
    <section className="card">
      <h2>Pilot success contract</h2>
      <p className="muted">
        Record measurable scope, owners, support, privacy, rollback, weekly review, and the conversion decision before customer access.
      </p>
      <div className="stack">
        <label>Contract title<input className="input" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>Provider<input className="input" value={provider} onChange={(event) => setProvider(event.target.value)} /></label>
        <label>Change class
          <select className="input" value={changeClass} onChange={(event) => setChangeClass(event.target.value)}>
            <option value="breaking">Breaking</option><option value="behavioral">Behavioral</option>
            <option value="deprecation">Deprecation</option><option value="security">Security</option><option value="other">Other</option>
          </select>
        </label>
        <label>Change description<textarea className="input" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <label>Repository owner<input className="input" value={repositoryOwner} onChange={(event) => setRepositoryOwner(event.target.value)} /></label>
        <label>Repository name<input className="input" value={repositoryName} onChange={(event) => setRepositoryName(event.target.value)} /></label>
        <label>Required verified pull requests<input className="input" type="number" min={1} value={thresholdTarget} onChange={(event) => setThresholdTarget(Number(event.target.value))} /></label>
        <label>Independent reviewer principal ID<input className="input" value={reviewerPrincipalId} onChange={(event) => setReviewerPrincipalId(event.target.value)} /></label>
        <label>Conversion decision date<input className="input" type="date" value={decisionDate} onChange={(event) => setDecisionDate(event.target.value)} /></label>
        <button type="button" className="btn primary" disabled={busy || !reviewerPrincipalId} onClick={save}>
          {busy ? "Saving" : editing ? `Save version ${editing.version + 1}` : "Create pilot contract"}
        </button>
      </div>

      {contracts.length > 0 && <div className="stack">
        <h3>Recorded contracts</h3>
        <label>Approval rationale<textarea className="input" value={rationale} onChange={(event) => setRationale(event.target.value)} /></label>
        {contracts.map((contract) => (
          <div className="card" key={contract.id}>
            <p><strong>{contract.title}</strong>: version {contract.version}, {contract.status}</p>
            <p className="mono small">Evidence {contract.contentSha256}</p>
            <div className="actions">
              <button type="button" className="btn" disabled={busy} onClick={() => startRevision(contract)}>Create revision</button>
              {contract.status === "draft" && (
                <button type="button" className="btn primary" disabled={busy || !rationale} onClick={() => approve(contract)}>
                  Approve as assigned reviewer
                </button>
              )}
            </div>
          </div>
        ))}
      </div>}
      {message && <p className="muted small" role="status">{message}</p>}
    </section>
  );
}
