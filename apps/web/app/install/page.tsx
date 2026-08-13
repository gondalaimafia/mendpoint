import React from "react";
import { apiGet } from "../../lib/api";
import { selfServeOnboardingEnabled } from "../../lib/proxy-auth";
import { InstallWizard } from "./wizard";
import {
  PilotSuccessContractPanel,
  type PilotContractSummary,
} from "./pilot-success-contract";
import { PilotReadinessChecklist } from "./pilot-readiness-checklist";
import { OnboardingSteps, type OnboardingStatus } from "../onboarding/onboarding-steps";

type AppConfig = {
  appId: string | null;
  appSlug: string;
  appName: string;
  configured: boolean;
  mockMode: boolean;
  installEnabled: boolean;
  disabledReason: string | null;
  permissions: Record<string, string>;
  events: string[];
};

type Installation = {
  id: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  updatedAt: string;
};

type ScmReadiness = {
  connections?: Array<{
    revokedAt: string | null;
    health: null | {
      configured: boolean;
      authenticated: boolean;
      readAccess: boolean;
      writeAccess: boolean;
      webhookOk: boolean;
      ciVisible: boolean;
    };
  }>;
  repositories?: Array<{
    snapshots: Array<{ exactCommit: string; available: boolean }>;
  }>;
};

export default async function InstallPage() {
  // Self-serve first-run: when the full self-serve stack is on, the guided
  // onboarding flow replaces the operator wizard + evidence checklist as the
  // customer's entry point. The operator artifacts below stay intact for the
  // pilot path and render byte-for-byte unchanged whenever the flag is off.
  if (selfServeOnboardingEnabled()) {
    let onboarding: OnboardingStatus | null = null;
    try {
      onboarding = await apiGet<OnboardingStatus>("/self-serve/onboarding");
    } catch {
      onboarding = null;
    }
    if (onboarding) return <OnboardingSteps status={onboarding} />;
  }

  let config: AppConfig | null = null;
  let installations: Installation[] = [];
  let pilotContracts: PilotContractSummary[] = [];
  let scm: ScmReadiness | null = null;
  let error: string | null = null;
  const [configResult, installationsResult, pilotContractsResult, scmResult] = await Promise.allSettled([
    apiGet<AppConfig>("/github/app/config"),
    apiGet<Installation[]>("/github/app/installations"),
    apiGet<{ data: PilotContractSummary[] }>("/pilot-success-contracts"),
    apiGet<ScmReadiness>("/platform/scm"),
  ]);
  if (configResult.status === "fulfilled") config = configResult.value;
  if (installationsResult.status === "fulfilled") installations = installationsResult.value;
  if (pilotContractsResult.status === "fulfilled") pilotContracts = pilotContractsResult.value.data;
  if (scmResult.status === "fulfilled") scm = scmResult.value;
  error = [
    configResult.status === "rejected" ? String(configResult.reason) : null,
    installationsResult.status === "rejected" ? String(installationsResult.reason) : null,
    pilotContractsResult.status === "rejected" ? String(pilotContractsResult.reason) : null,
    scmResult.status === "rejected" ? String(scmResult.reason) : null,
  ].filter(Boolean).join(". ") || null;
  const decisionDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Install Mendpoint</h1>
        <p className="muted">
          Pilot pull request delivery uses an approved repository scoped GitHub token.
          GitHub App installation remains experimental.
        </p>
      </div>

      {error && (
        <div className="card">
          <p className="error">API offline: {error}</p>
        </div>
      )}

      {config?.installEnabled && (
        <InstallWizard config={config} initialInstallations={installations} />
      )}
      {config && !config.installEnabled && (
        <section className="card">
          <h2>GitHub App installation unavailable</h2>
          <p className="muted">{config.disabledReason}</p>
        </section>
      )}

      <PilotSuccessContractPanel
        initialContracts={pilotContracts}
        defaultRepositoryOwner={installations[0]?.accountLogin ?? "customer"}
        defaultDecisionDate={decisionDate}
      />

      <PilotReadinessChecklist
        identityVerified={false}
        agreementRecorded={false}
        installationReady={Boolean(scm?.connections?.some((connection) =>
          !connection.revokedAt &&
          connection.health?.configured &&
          connection.health.authenticated &&
          connection.health.readAccess &&
          connection.health.writeAccess &&
          connection.health.webhookOk &&
          connection.health.ciVisible
        ))}
        repositorySnapshotReady={Boolean(scm?.repositories?.some((repository) =>
          repository.snapshots.some((snapshot) => snapshot.available && /^[a-f0-9]{40,64}$/.test(snapshot.exactCommit))
        ))}
        policyRecorded={false}
        verificationCommandsRecorded={false}
        canaryVerified={false}
        baselineRecorded={false}
        contracts={pilotContracts}
      />

      <section className="card">
        <h2>Existing installations</h2>
        {installations.length === 0 ? (
          <p className="muted">No GitHub App installations are recorded.</p>
        ) : (
          <table className="table">
            <caption className="sr-only">Existing GitHub App installations</caption>
            <thead>
              <tr>
                <th>Account</th>
                <th>Installation ID</th>
                <th>Type</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {installations.map((i) => (
                <tr key={i.id}>
                  <td>
                    <strong>{i.accountLogin}</strong>
                  </td>
                  <td className="mono">{i.installationId}</td>
                  <td>{i.accountType}</td>
                  <td className="mono">{new Date(i.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
