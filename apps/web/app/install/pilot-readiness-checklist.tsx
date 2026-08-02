import React from "react";
import type { PilotContractSummary } from "./pilot-success-contract";

export type PilotReadinessInput = Readonly<{
  identityVerified: boolean;
  agreementRecorded: boolean;
  installationReady: boolean;
  repositorySnapshotReady: boolean;
  policyRecorded: boolean;
  verificationCommandsRecorded: boolean;
  canaryVerified: boolean;
  baselineRecorded: boolean;
  contracts: readonly PilotContractSummary[];
}>;

export function pilotReadinessItems(input: PilotReadinessInput) {
  const contract = input.contracts.find((candidate) => candidate.status === "approved") ?? input.contracts[0];
  return [
    { label: "Verified identity", ready: input.identityVerified, detail: "Use an active tenant membership with multifactor identity evidence." },
    { label: "Pilot agreement", ready: input.agreementRecorded, detail: "Retain the approved agreement and data terms." },
    { label: "Repository scope", ready: Boolean(contract?.definition.repositories.length), detail: "Record every owner, repository, branch, and allowed scope." },
    { label: "Exact snapshot", ready: input.repositorySnapshotReady, detail: "Materialize an immutable commit snapshot before execution." },
    { label: "Repository permissions", ready: input.installationReady, detail: "Prove read, write, webhook, and CI access independently." },
    { label: "Execution policy", ready: input.policyRecorded, detail: "Approve commands, risk limits, review rules, and maintenance windows." },
    { label: "Verification commands", ready: input.verificationCommandsRecorded, detail: "Retain baseline and post edit commands with exact evidence." },
    { label: "Private canary", ready: input.canaryVerified, detail: "Complete a draft pull request and restore drill." },
    { label: "Baseline evidence", ready: input.baselineRecorded, detail: "Record initial health, failures, and accepted thresholds." },
    { label: "Accountable owners", ready: Boolean(contract?.definition.owners.length), detail: "Assign customer, technical, privacy, support, and rollback owners." },
    { label: "Support response", ready: Boolean(contract?.definition.supportResponses.length), detail: "Agree severity coverage and response times." },
    { label: "Rollback plan", ready: Boolean(contract?.definition.rollback.procedure), detail: "Record trigger, procedure, owner, and recovery objective." },
  ] as const;
}

export function PilotReadinessChecklist(input: PilotReadinessInput) {
  const items = pilotReadinessItems(input);
  const ready = items.filter((item) => item.ready).length;
  return (
    <section className="card" aria-labelledby="pilot-readiness-heading">
      <div className="row-between">
        <div>
          <h2 id="pilot-readiness-heading">Pilot readiness checklist</h2>
          <p className="muted small">Every item needs retained evidence before a customer repository can execute.</p>
        </div>
        <span className={`badge ${ready === items.length ? "high" : "medium"}`}>{ready} of {items.length} ready</span>
      </div>
      <ol className="stack">
        {items.map((item) => (
          <li key={item.label}>
            <strong>{item.ready ? "Ready" : "Needs evidence"}: {item.label}</strong>
            <div className="muted small">{item.detail}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}
