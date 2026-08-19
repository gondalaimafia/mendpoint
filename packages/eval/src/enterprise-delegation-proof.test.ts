import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MENDPOINT_SOFTWARE_ATTESTATION_PREDICATE_V1,
  createSoftwareAttestationStatementV1,
  signSoftwareAttestation,
  type SoftwareAttestationSigner,
  type SoftwareAttestationTrustPolicy,
} from "@mendpoint/contract";
import {
  evaluateDelegatedPrAcceptance,
  type DelegatedPrAcceptanceAuthority,
  type DelegatedPrAcceptanceContract,
  type DelegatedPrProof,
  type DelegatedPrTrialEvidence,
} from "./enterprise-delegation-proof.js";

const hex = (character: string): string => character.repeat(64);
const digest = (value: string): string => `sha256:${Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64)}`;
const revision = (character: string): string => character.repeat(40);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
  value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => [key, canonical(child)])) : value;
const contentSha = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

const contract: DelegatedPrAcceptanceContract = Object.freeze({
  schemaVersion: 1, product: "fettler", tenantId: "tenant-canary", mendpointRevision: revision("a"),
  authorityManifest: { artifactId: "authority-1", sha256: hex("0") },
  taskArtifact: { artifactId: "task-1", sha256: hex("1") },
  repository: {
    repositoryId: "repo-canary", remoteRepositoryId: 67890, installationId: 12345,
    owner: "gondalaimafia", name: "mendpoint-canary", baseBranch: "main", sourceRevision: revision("b"),
    sourceArtifact: { artifactId: "source-1", sha256: hex("2") },
    snapshotArtifact: { artifactId: "snapshot-1", sha256: hex("3") }, treeDigest: digest("tree"),
  },
  approvedModel: { providerId: "provider-1", endpointHost: "models.example.test", model: "approved-model", pricingDigest: digest("pricing") },
  verification: {
    executionAuthorityId: "fettler-worker-1",
    authorityId: "verifier-1", authorityDigest: digest("verifier"),
    failToPassCommandDigest: digest("fail-command"), passToPassCommandDigest: digest("pass-command"),
    policyArtifact: { artifactId: "policy-1", sha256: hex("4") }, requiredCheckIdentities: ["check:1:test"],
    failToPassIdentities: ["test:target"],
    sandboxBackend: "fly-sandbox",
  },
  attestationProducer: { principalId: "service:fettler", service: "fettler-worker", trustedKeyIds: ["delegation-key"] },
  workflow: {
    repository: "gondalaimafia/mendpoint", workflowPath: ".github/workflows/fettler-enterprise-proof.yml",
    workflowRevision: revision("a"), environment: "fettler-production",
  },
  requiredRepetitions: 3, maximumTotalCostUsd: 2, maximumTrialDurationMs: 120_000, maximumProofAgeMs: 300_000,
  allowedChangedPaths: ["src/client.ts"],
});

const pair = generateKeyPairSync("ed25519");
const signer: SoftwareAttestationSigner = {
  keyId: "delegation-key", algorithm: "ed25519",
  async sign(bytes) { return signBytes(null, bytes, pair.privateKey); },
};
const trustPolicy: SoftwareAttestationTrustPolicy = {
  async resolve(keyId) {
    return keyId === "delegation-key" ? {
      keyId, algorithm: "ed25519", publicKey: pair.publicKey, principalId: "service:fettler",
      service: "fettler-worker", tenantIds: [contract.tenantId],
      predicateTypes: [MENDPOINT_SOFTWARE_ATTESTATION_PREDICATE_V1],
      validFrom: "2026-08-18T10:00:00.000Z", validUntil: "2026-08-18T14:00:00.000Z", revokedAt: null,
    } : null;
  },
};

const proof: DelegatedPrProof = {
  schemaVersion: 1, proofId: "proof-1", generatedAt: "2026-08-18T12:05:00.000Z",
  workflow: { ...contract.workflow, runId: "workflow-1", runAttempt: 1 },
  trials: [1, 2, 3].map((trial) => ({ trial, tenantId: contract.tenantId, runId: `run-${trial}`, correlationId: `corr-${trial}` })),
};

async function trial(number: number): Promise<DelegatedPrTrialEvidence> {
  const minute = `0${number}`;
  const candidate = { artifactId: `candidate-${number}`, sha256: hex(String(number)) };
  const fail = { artifactId: `fail-${number}`, sha256: digest(`fail-${number}`).slice(7) };
  const pass = { artifactId: `pass-${number}`, sha256: digest(`pass-${number}`).slice(7) };
  const delivery = { artifactId: `delivery-${number}`, sha256: digest(`delivery-${number}`).slice(7) };
  const rollback = { artifactId: `rollback-${number}`, sha256: digest(`rollback-${number}`).slice(7) };
  const evidence: Omit<DelegatedPrTrialEvidence, "attestation"> = {
    trial: number, tenantId: contract.tenantId, runId: `run-${number}`, correlationId: `corr-${number}`, jobId: `job-${number}`,
    workflow: { ...proof.workflow },
    attestedArtifacts: {
      workflow: { artifactId: `workflow-${number}`, sha256: digest(`workflow-${number}`).slice(7) },
      model: { artifactId: `model-${number}`, sha256: digest(`model-${number}`).slice(7) },
      accounting: { artifactId: `accounting-${number}`, sha256: digest(`accounting-${number}`).slice(7) },
      approvalAudit: { artifactId: `approval-audit-${number}`, sha256: digest(`approval-audit-${number}`).slice(7) },
      githubObservation: { artifactId: `github-${number}`, sha256: digest(`github-${number}`).slice(7) },
      verification: { artifactId: `verification-${number}`, sha256: digest(`verification-${number}`).slice(7) },
      cleanup: { artifactId: `cleanup-claims-${number}`, sha256: digest(`cleanup-claims-${number}`).slice(7) },
      timeline: { artifactId: `timeline-${number}`, sha256: digest(`timeline-${number}`).slice(7) },
      changedPaths: { artifactId: `paths-${number}`, sha256: digest(`paths-${number}`).slice(7) },
    },
    startedAt: `2026-08-18T12:${minute}:00.000Z`, executionCompletedAt: `2026-08-18T12:${minute}:50.000Z`,
    finalizedAt: `2026-08-18T12:${minute}:55.000Z`,
    source: {
      repositoryId: contract.repository.repositoryId, remoteRepositoryId: contract.repository.remoteRepositoryId,
      installationId: contract.repository.installationId, owner: contract.repository.owner, name: contract.repository.name,
      baseBranch: contract.repository.baseBranch, revision: contract.repository.sourceRevision,
      sourceArtifact: contract.repository.sourceArtifact, snapshotArtifact: contract.repository.snapshotArtifact,
      treeDigest: contract.repository.treeDigest, taskArtifact: contract.taskArtifact,
    },
    model: {
      provenance: [{ model: contract.approvedModel.model, providerId: contract.approvedModel.providerId,
        host: contract.approvedModel.endpointHost, protocol: "https:", bodyRequestId: `request-${number}`,
        headerRequestId: `request-${number}`, promptTokens: 1000, completionTokens: 200, totalTokens: 1200, costUsd: 0.25,
        monotonicTimestampMs: number * 1_000 }],
      plannerSources: ["model"], scriptedPlannerInjected: false, pricingDigest: contract.approvedModel.pricingDigest,
      settledAt: `2026-08-18T12:${minute}:10.000Z`,
    },
    // Durable run metering ends when the candidate is ready. Human review,
    // delivery, and cleanup extend the trial timeline but must not be invented
    // as model execution time.
    meter: { costMeasured: true, costUsd: 0.25, inputTokens: 1000, outputTokens: 200, durationMs: 20_000 },
    candidate: { artifact: candidate, commitSha: String(number).repeat(40), treeDigest: digest(`candidate-tree-${number}`),
      changedPaths: ["src/client.ts"], createdAt: `2026-08-18T12:${minute}:20.000Z` },
    verification: {
      executionAuthorityId: contract.verification.executionAuthorityId,
      failToPass: { artifact: fail, authorityId: contract.verification.authorityId, authorityDigest: contract.verification.authorityDigest,
        commandDigest: contract.verification.failToPassCommandDigest, sourceDigest: contract.repository.treeDigest,
        candidateDigest: candidate.sha256, baselineExitCode: 1, candidateExitCode: 0, baselineVerdict: "test_failure",
        failingCheckIdentities: ["test:target"], sandboxBackend: "fly-sandbox", logsDigest: digest(`fail-logs-${number}`) },
      passToPass: { artifact: pass, authorityId: contract.verification.authorityId, authorityDigest: contract.verification.authorityDigest,
        commandDigest: contract.verification.passToPassCommandDigest, sourceDigest: contract.repository.treeDigest,
        candidateDigest: candidate.sha256, baselineExitCode: 0, candidateExitCode: 0, baselineVerdict: "passed",
        failingCheckIdentities: [], sandboxBackend: "fly-sandbox", logsDigest: digest(`pass-logs-${number}`) },
      completedAt: `2026-08-18T12:${minute}:30.000Z`,
    },
    approval: {
      auditEventId: `audit-${number}`, requestId: `approval-request-${number}`,
      membershipEvidenceId: `membership-${number}`, auditChainVerified: true, action: "agent.candidate.approved",
      principalId: "human:reviewer", principalKind: "human", authMethod: "oidc", apiKeyId: null,
      trustPrincipalId: "human:reviewer", candidateDigest: candidate.sha256,
      sealArtifact: { artifactId: `approval-${number}`, sha256: digest(`approval-${number}`).slice(7) },
      approvedAt: `2026-08-18T12:${minute}:35.000Z`,
    },
    delivery: {
      provider: "github", publisher: "github_app", installationId: contract.repository.installationId,
      remoteRepositoryId: contract.repository.remoteRepositoryId, repositoryId: contract.repository.repositoryId,
      owner: contract.repository.owner, name: contract.repository.name, baseBranch: contract.repository.baseBranch,
      headBranch: `mendpoint/fettler-${number}`, pullRequestNumber: 100 + number, candidateDigest: candidate.sha256,
      changedPaths: ["src/client.ts"], treeDigest: digest(`candidate-tree-${number}`),
      remoteTreeSha: String(number + 3).repeat(40),
      artifact: delivery, matchingOpenDrafts: 1, observedAt: `2026-08-18T12:${minute}:40.000Z`,
      observation: { state: "draft", baseRevision: contract.repository.sourceRevision, headRevision: String(number).repeat(40),
        checks: "success", checkRevision: String(number).repeat(40), approvals: 0, approvalRevision: null,
        conversationsResolved: true, failures: [], checkIdentities: ["check:1:test"],
        checkResults: [{ identity: "check:1:test", state: "success" }],
        repositoryId: contract.repository.remoteRepositoryId, installationId: contract.repository.installationId,
        matchingOpenDrafts: 1, changedPaths: ["src/client.ts"], remoteTreeSha: String(number + 3).repeat(40),
        reviewFeedback: { verdict: "none", changeRequests: [], comments: [] }, evidenceRefs: [`github-observation-${number}`] },
    },
    cleanup: { pullRequestState: "closed", branchState: "retained_exact", headRevision: String(number).repeat(40),
      baseRevision: contract.repository.sourceRevision, openTrialPullRequests: 0, rollbackArtifact: rollback,
      observedAt: `2026-08-18T12:${minute}:45.000Z`, evidenceRefs: [`cleanup-${number}`] },
  };
  const { artifact: _deliveryArtifact, ...deliveryClaims } = evidence.delivery;
  const attested = evidence.attestedArtifacts as Record<string, { artifactId: string; sha256: string }>;
  const values: Record<string, unknown> = {
    workflow: evidence.workflow, model: evidence.model, accounting: evidence.meter, approvalAudit: evidence.approval,
    githubObservation: deliveryClaims, verification: evidence.verification, cleanup: evidence.cleanup,
    timeline: { startedAt: evidence.startedAt, modelSettledAt: evidence.model.settledAt,
      candidateCreatedAt: evidence.candidate.createdAt, verificationCompletedAt: evidence.verification.completedAt,
      approvedAt: evidence.approval.approvedAt, deliveredAt: evidence.delivery.observedAt,
      cleanedAt: evidence.cleanup.observedAt, executionCompletedAt: evidence.executionCompletedAt,
      finalizedAt: evidence.finalizedAt }, changedPaths: evidence.candidate.changedPaths,
  };
  for (const [key, value] of Object.entries(values)) attested[key]!.sha256 = contentSha(value);
  const statement = createSoftwareAttestationStatementV1({
    attestationId: `attestation-${number}`,
    scope: { tenantId: contract.tenantId, repositoryId: contract.repository.repositoryId, runId: evidence.runId,
      correlationId: evidence.correlationId, sourceArtifacts: [contract.authorityManifest, contract.taskArtifact,
        contract.repository.sourceArtifact, evidence.attestedArtifacts.workflow, evidence.attestedArtifacts.model,
        evidence.attestedArtifacts.accounting, evidence.attestedArtifacts.approvalAudit,
        evidence.attestedArtifacts.githubObservation, evidence.attestedArtifacts.verification,
        evidence.attestedArtifacts.cleanup, evidence.attestedArtifacts.timeline,
        evidence.attestedArtifacts.changedPaths, evidence.approval.sealArtifact],
      snapshotArtifact: contract.repository.snapshotArtifact, candidateArtifact: candidate,
      verificationArtifacts: [fail, pass], policyArtifact: contract.verification.policyArtifact,
      deliveryArtifact: delivery, rollbackArtifact: rollback, waiverArtifact: null },
    producer: { principalId: "service:fettler", service: "fettler-worker", version: contract.mendpointRevision },
    outcome: "passed", issuedAt: `2026-08-18T12:${minute}:55.000Z`,
  });
  return { ...evidence, attestation: await signSoftwareAttestation(statement, signer) };
}

async function fixture(): Promise<{ authority: DelegatedPrAcceptanceAuthority; evidence: DelegatedPrTrialEvidence[] }> {
  const evidence = await Promise.all([trial(1), trial(2), trial(3)]);
  return { evidence, authority: {
    loadTrial: vi.fn(async (ref) => evidence[ref.trial - 1] ?? null),
    manifest: vi.fn(async () => contract.authorityManifest),
    now: vi.fn(async () => "2026-08-18T12:05:00.000Z"),
  } };
}

describe("delegated PR acceptance", () => {
  it("accepts three authority-loaded, signed, exact live draft trials", async () => {
    const { authority } = await fixture();
    const report = await evaluateDelegatedPrAcceptance({ proof, contract, authority, trustPolicy });
    expect(report).toMatchObject({ delegatedPrAccepted: true, allTrialsAccepted: true, trialCount: 3, totalCostUsd: 0.75, findings: [] });
    expect(report.proofDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(authority.loadTrial).toHaveBeenCalledTimes(3);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it("fails closed without proof or authority evidence", async () => {
    const { authority } = await fixture();
    expect(await evaluateDelegatedPrAcceptance({ proof: null, contract, authority, trustPolicy }))
      .toMatchObject({ delegatedPrAccepted: false, proofDigest: null, findings: [{ code: "delegated_pr_proof_missing", severity: "P0" }] });
    const missing = { loadTrial: vi.fn(async () => null), manifest: vi.fn(async () => contract.authorityManifest),
      now: vi.fn(async () => "2026-08-18T12:05:00.000Z") };
    expect((await evaluateDelegatedPrAcceptance({ proof, contract, authority: missing, trustPolicy })).findings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "delegated_pr_authority_missing", severity: "P0" })]));
  });

  it.each([
    ["live model", (value: DelegatedPrTrialEvidence) => { (value.model.provenance[0] as { host: string }).host = "wrong.example"; }, "delegated_pr_live_model_invalid"],
    ["accounting", (value: DelegatedPrTrialEvidence) => { (value.meter as { costUsd: number }).costUsd = 0.2; }, "delegated_pr_accounting_mismatch"],
    ["verification", (value: DelegatedPrTrialEvidence) => { (value.verification.failToPass as { candidateExitCode: number }).candidateExitCode = 1; }, "delegated_pr_verification_invalid"],
    ["OIDC approval", (value: DelegatedPrTrialEvidence) => { (value.approval as { apiKeyId: string | null }).apiKeyId = "key"; }, "delegated_pr_approval_invalid"],
    ["real draft", (value: DelegatedPrTrialEvidence) => { (value.delivery as { matchingOpenDrafts: number }).matchingOpenDrafts = 2; }, "delegated_pr_delivery_invalid"],
    ["cleanup", (value: DelegatedPrTrialEvidence) => { (value.cleanup as { headRevision: string }).headRevision = "f".repeat(40); }, "delegated_pr_cleanup_invalid"],
  ])("rejects invalid %s authority", async (_label, mutate, code) => {
    const { evidence, authority } = await fixture(); mutate(evidence[0]!);
    const report = await evaluateDelegatedPrAcceptance({ proof, contract, authority, trustPolicy });
    expect(report.delegatedPrAccepted).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code, trial: 1 }));
  });

  it("rejects a tampered or untrusted DSSE attestation", async () => {
    const { evidence, authority } = await fixture();
    evidence[0] = { ...evidence[0]!, attestation: {
      ...evidence[0]!.attestation,
      payload: Buffer.from("{}").toString("base64"),
    } };
    const report = await evaluateDelegatedPrAcceptance({ proof, contract, authority, trustPolicy });
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "delegated_pr_attestation_invalid", severity: "P0", trial: 1 }));
  });

  it("rejects mutable workflow revisions, replayed provider receipts, and unsafe paths", async () => {
    await expect(evaluateDelegatedPrAcceptance({ proof, contract: { ...contract, workflow: { ...contract.workflow, workflowRevision: "main" } },
      authority: { loadTrial: async () => null, manifest: async () => contract.authorityManifest,
        now: async () => "2026-08-18T12:05:00.000Z" }, trustPolicy }))
      .rejects.toThrow("delegated_pr_acceptance_contract_invalid");
    const { evidence, authority } = await fixture();
    (evidence[1]!.model.provenance[0] as { bodyRequestId: string }).bodyRequestId = "request-1";
    (evidence[2]!.candidate.changedPaths as string[])[0] = "../secret";
    const report = await evaluateDelegatedPrAcceptance({ proof, contract, authority, trustPolicy });
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "delegated_pr_replay_identity_conflict" }),
      expect.objectContaining({ code: "delegated_pr_candidate_invalid" }),
    ]));
  });

  it("accepts one provider request id repeated across body and header aliases", async () => {
    const { authority } = await fixture();
    const report = await evaluateDelegatedPrAcceptance({ proof, contract, authority, trustPolicy });
    expect(report.delegatedPrAccepted).toBe(true);
    expect(report.findings).not.toContainEqual(expect.objectContaining({ code: "delegated_pr_replay_identity_conflict" }));
  });

  it("rejects empty GitHub evidence references and protected workflow identity drift", async () => {
    const { evidence, authority } = await fixture();
    (evidence[0]!.delivery.observation.evidenceRefs as string[])[0] = "";
    (evidence[1]!.workflow as { environment: string }).environment = "unprotected";
    const report = await evaluateDelegatedPrAcceptance({ proof, contract, authority, trustPolicy });
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "delegated_pr_delivery_invalid", trial: 1 }),
      expect.objectContaining({ code: "delegated_pr_authority_binding_mismatch", trial: 2 }),
      expect.objectContaining({ code: "delegated_pr_attested_artifact_mismatch", trial: 2 }),
    ]));
  });

  it("rejects an unpinned authority manifest and caller-backdated verification time", async () => {
    const { authority } = await fixture();
    await expect(evaluateDelegatedPrAcceptance({ proof, contract, authority: {
      ...authority, manifest: async () => ({ artifactId: "foreign", sha256: hex("f") }),
    }, trustPolicy })).rejects.toThrow("delegated_pr_authority_manifest_mismatch");
    await expect(evaluateDelegatedPrAcceptance({ proof, contract, authority: {
      ...authority, now: async () => "2026-08-18T11:00:00.000Z",
    }, trustPolicy })).rejects.toThrow("delegated_pr_acceptance_proof_invalid");
  });

  it("rejects negative accounting and repeated approval or artifact authority", async () => {
    const { evidence, authority } = await fixture();
    (evidence[0]!.model.provenance[0] as { costUsd: number }).costUsd = -0.25;
    (evidence[0]!.meter as { costUsd: number }).costUsd = -0.25;
    (evidence[1]!.approval as { auditEventId: string }).auditEventId = evidence[0]!.approval.auditEventId;
    (evidence[1]!.approval as { sealArtifact: { artifactId: string; sha256: string } }).sealArtifact =
      evidence[0]!.approval.sealArtifact;
    const report = await evaluateDelegatedPrAcceptance({ proof, contract, authority, trustPolicy });
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "delegated_pr_accounting_mismatch", trial: 1 }),
      expect.objectContaining({ code: "delegated_pr_replay_identity_conflict", trial: 2 }),
    ]));
  });

  it("rejects mock verification infrastructure, incomplete check results, and remote tree drift", async () => {
    const { evidence, authority } = await fixture();
    (evidence[0]!.verification.failToPass as { sandboxBackend: string }).sandboxBackend = "mock";
    (evidence[1]!.delivery.observation.checkResults as unknown[]).length = 0;
    (evidence[2]!.delivery as { treeDigest: string }).treeDigest = digest("foreign-tree");
    const report = await evaluateDelegatedPrAcceptance({ proof, contract, authority, trustPolicy });
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "delegated_pr_verification_invalid", trial: 1 }),
      expect.objectContaining({ code: "delegated_pr_delivery_invalid", trial: 2 }),
      expect.objectContaining({ code: "delegated_pr_delivery_invalid", trial: 3 }),
    ]));
  });

  it("rejects GitHub observation authority that drifts from the delivered repository and tree", async () => {
    const { evidence, authority } = await fixture();
    Object.assign(evidence[0]!.delivery.observation, {
      repositoryId: contract.repository.remoteRepositoryId + 1,
      installationId: contract.repository.installationId,
      matchingOpenDrafts: 1,
      changedPaths: ["src/client.ts"],
      remoteTreeSha: "f".repeat(40),
    });
    const report = await evaluateDelegatedPrAcceptance({ proof, contract, authority, trustPolicy });
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "delegated_pr_delivery_invalid",
      trial: 1,
    }));
  });

  it("passes frozen proof references to the authority and snapshots returned evidence", async () => {
    const evidence = await Promise.all([trial(1), trial(2), trial(3)]);
    const authority: DelegatedPrAcceptanceAuthority = {
      manifest: async () => contract.authorityManifest,
      now: async () => "2026-08-18T12:05:00.000Z",
      async loadTrial(ref) {
        expect(Object.isFrozen(ref)).toBe(true);
        return evidence[ref.trial - 1] ?? null;
      },
    };
    const report = await evaluateDelegatedPrAcceptance({ proof, contract, authority, trustPolicy });
    (evidence[0]!.candidate.changedPaths as string[])[0] = "attacker.ts";
    expect(report.delegatedPrAccepted).toBe(true);
    expect(report.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects stale proofs, signer drift, unsafe exits, execution-authority drift, and unsigned claim changes", async () => {
    const stale = await fixture();
    await expect(evaluateDelegatedPrAcceptance({ proof, contract, authority: {
      ...stale.authority, now: async () => "2026-08-18T12:10:00.001Z",
    }, trustPolicy })).rejects.toThrow("delegated_pr_acceptance_proof_invalid");

    const signerDrift = await fixture();
    const signerReport = await evaluateDelegatedPrAcceptance({ proof, contract: {
      ...contract, attestationProducer: { ...contract.attestationProducer, trustedKeyIds: ["different-key"] },
    }, authority: signerDrift.authority, trustPolicy });
    expect(signerReport.findings).toContainEqual(expect.objectContaining({ code: "delegated_pr_attestation_invalid" }));

    const drift = await fixture();
    (drift.evidence[0]!.verification as { executionAuthorityId: string }).executionAuthorityId = "other-worker";
    (drift.evidence[1]!.verification.failToPass as { baselineExitCode: number }).baselineExitCode = 124;
    (drift.evidence[2]!.cleanup as { openTrialPullRequests: number }).openTrialPullRequests = 0.5;
    const report = await evaluateDelegatedPrAcceptance({ proof, contract, authority: drift.authority, trustPolicy });
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "delegated_pr_verification_invalid", trial: 1 }),
      expect.objectContaining({ code: "delegated_pr_attested_artifact_mismatch", trial: 1 }),
      expect.objectContaining({ code: "delegated_pr_verification_invalid", trial: 2 }),
      expect.objectContaining({ code: "delegated_pr_cleanup_invalid", trial: 3 }),
    ]));
  });

  it("rejects a fresh proof wrapper around stale trial evidence", async () => {
    const { evidence, authority } = await fixture();
    (evidence[0] as { finalizedAt: string }).finalizedAt = "2026-08-18T11:00:00.000Z";

    const report = await evaluateDelegatedPrAcceptance({ proof, contract, authority, trustPolicy });

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "delegated_pr_trial_stale",
      severity: "P1",
      trial: 1,
    }));
  });
});
