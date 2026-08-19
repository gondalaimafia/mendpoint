import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendDomainEvent,
  createDb,
  insertArtifactManifest,
  insertEvidenceRecord,
  insertPrincipal,
  insertTenant,
  type AppDb,
} from "@mendpoint/db";
import {
  createSoftwareAttestationStatementV1,
  signSoftwareAttestation,
  type DsseEnvelope,
} from "@mendpoint/contract";
import {
  delegatedPrAttestationScope,
  type DelegatedPrAcceptanceContract,
  type DelegatedPrTrialEvidence,
} from "./enterprise-delegation-proof.js";

const mocked = vi.hoisted(() => ({ inventory: null as unknown }));
vi.mock("@mendpoint/pipeline", () => ({
  getVerifiedFettlerDelegationEvidence: vi.fn(async () => mocked.inventory),
}));

import {
  createStoredDelegatedPrTrialAuthority,
  delegatedPrTrialBundleId,
  DELEGATED_PR_TRIAL_ASSEMBLER,
  DELEGATED_PR_TRIAL_BUNDLE_KIND,
  DELEGATED_PR_TRIAL_BUNDLE_MEDIA_TYPE,
} from "./delegated-pr-trial-authority.js";

const roots: string[] = [];
const databases: AppDb[] = [];
const hex = (value: string) => value.repeat(64);
const revision = (value: string) => value.repeat(40);
const artifact = (name: string, value: string = name[0] ?? "a") => ({ artifactId: name, sha256: hex(value) });

afterEach(() => {
  mocked.inventory = null;
  for (const db of databases.splice(0)) db.raw.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex")}`;
}

const contract: DelegatedPrAcceptanceContract = Object.freeze({
  schemaVersion: 1,
  product: "fettler",
  tenantId: "tenant-a",
  mendpointRevision: revision("f"),
  authorityManifest: artifact("authority-manifest", "1"),
  taskArtifact: artifact("task-artifact", "2"),
  repository: {
    repositoryId: "repo-a",
    remoteRepositoryId: 99,
    installationId: 88,
    owner: "acme",
    name: "repo",
    baseBranch: "main",
    sourceRevision: revision("a"),
    sourceArtifact: artifact("source-artifact", "3"),
    snapshotArtifact: artifact("snapshot-a", "4"),
    treeDigest: `sha256:${hex("5")}`,
  },
  approvedModel: {
    providerId: "openai",
    endpointHost: "api.openai.com",
    model: "muse-1.2",
    pricingDigest: `sha256:${hex("6")}`,
  },
  verification: {
    executionAuthorityId: "sandbox-a",
    authorityId: "verifier-a",
    authorityDigest: `sha256:${hex("7")}`,
    failToPassCommandDigest: `sha256:${hex("8")}`,
    passToPassCommandDigest: `sha256:${hex("9")}`,
    policyArtifact: artifact("policy-artifact", "a"),
    requiredCheckIdentities: ["check:1:test"],
    failToPassIdentities: ["test:provider"],
    sandboxBackend: "fly_machines",
  },
  attestationProducer: {
    principalId: "trial-service",
    service: "mendpoint-delegated-trial",
    trustedKeyIds: ["trial-key"],
  },
  workflow: {
    repository: "gondalaimafia/mendpoint",
    workflowPath: ".github/workflows/delegated-proof.yml",
    workflowRevision: revision("e"),
    environment: "production-delegation",
  },
  requiredRepetitions: 3,
  maximumTotalCostUsd: 1,
  maximumTrialDurationMs: 600_000,
  maximumProofAgeMs: 3_600_000,
  allowedChangedPaths: ["src/client.ts"],
});

function provenance() {
  return [{
    providerId: "openai",
    bodyRequestId: "request-body-a",
    headerRequestId: "request-header-a",
    model: "muse-1.2",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    host: "api.openai.com",
    protocol: "https:",
    costUsd: 0.12,
    monotonicTimestampMs: 100,
  }];
}

function placeholderEnvelope(): DsseEnvelope {
  return { payloadType: "application/vnd.in-toto+json", payload: "e30=", signatures: [{ keyid: "trial-key", sig: "AA==" }] };
}

function trial(): DelegatedPrTrialEvidence {
  const candidate = artifact("candidate-artifact", "c");
  const fail = artifact("fail-artifact", "7");
  const pass = artifact("pass-artifact", "8");
  const deliveryArtifact = artifact("delivery-artifact", "9");
  const cleanupArtifact = artifact("cleanup-artifact", "b");
  const attested = {
    workflow: artifact("workflow-claims", "1"),
    model: artifact("model-claims", "2"),
    accounting: artifact("accounting-claims", "3"),
    approvalAudit: artifact("approval-claims", "4"),
    githubObservation: artifact("github-claims", "5"),
    verification: artifact("verification-claims", "6"),
    cleanup: artifact("cleanup-claims", "7"),
    timeline: artifact("timeline-claims", "8"),
    changedPaths: artifact("paths-claims", "9"),
  };
  return {
    trial: 1,
    tenantId: "tenant-a",
    runId: "run-a",
    correlationId: "corr-a",
    jobId: "job-a",
    workflow: { ...contract.workflow, runId: "workflow-run", runAttempt: 1 },
    attestedArtifacts: attested,
    startedAt: "2026-08-18T12:00:00.000Z",
    executionCompletedAt: "2026-08-18T12:09:30.000Z",
    finalizedAt: "2026-08-18T12:10:00.000Z",
    source: {
      repositoryId: "repo-a",
      remoteRepositoryId: 99,
      installationId: 88,
      owner: "acme",
      name: "repo",
      baseBranch: "main",
      revision: revision("a"),
      sourceArtifact: contract.repository.sourceArtifact,
      snapshotArtifact: contract.repository.snapshotArtifact,
      treeDigest: contract.repository.treeDigest,
      taskArtifact: contract.taskArtifact,
    },
    model: {
      provenance: provenance(),
      plannerSources: ["model"],
      scriptedPlannerInjected: false,
      pricingDigest: contract.approvedModel.pricingDigest,
      settledAt: "2026-08-18T12:00:30.000Z",
    },
    meter: { costMeasured: true, costUsd: 0.12, inputTokens: 100, outputTokens: 50, durationMs: 600_000 },
    candidate: {
      artifact: candidate,
      commitSha: revision("b"),
      treeDigest: `sha256:${hex("d")}`,
      changedPaths: ["src/client.ts"],
      createdAt: "2026-08-18T12:02:00.000Z",
    },
    verification: {
      executionAuthorityId: "sandbox-a",
      failToPass: {
        artifact: fail,
        authorityId: "verifier-a",
        authorityDigest: contract.verification.authorityDigest,
        commandDigest: contract.verification.failToPassCommandDigest,
        sourceDigest: contract.repository.treeDigest,
        candidateDigest: candidate.sha256,
        baselineExitCode: 1,
        candidateExitCode: 0,
        baselineVerdict: "test_failure",
        failingCheckIdentities: ["test:provider"],
        sandboxBackend: "fly_machines",
        logsDigest: `sha256:${hex("e")}`,
      },
      passToPass: {
        artifact: pass,
        authorityId: "verifier-a",
        authorityDigest: contract.verification.authorityDigest,
        commandDigest: contract.verification.passToPassCommandDigest,
        sourceDigest: contract.repository.treeDigest,
        candidateDigest: candidate.sha256,
        baselineExitCode: 0,
        candidateExitCode: 0,
        baselineVerdict: "passed",
        failingCheckIdentities: [],
        sandboxBackend: "fly_machines",
        logsDigest: `sha256:${hex("f")}`,
      },
      completedAt: "2026-08-18T12:03:00.000Z",
    },
    approval: {
      auditEventId: "audit-approval",
      requestId: "oidc-request-a",
      membershipEvidenceId: "membership-a",
      auditChainVerified: true,
      action: "agent.candidate.approved",
      principalId: "human-a",
      principalKind: "human",
      authMethod: "oidc",
      apiKeyId: null,
      trustPrincipalId: "human-a",
      candidateDigest: candidate.sha256,
      sealArtifact: { artifactId: "approvals/seal.json", sha256: hex("d") },
      approvedAt: "2026-08-18T12:04:00.000Z",
    },
    delivery: {
      provider: "github",
      publisher: "github_app",
      installationId: 88,
      remoteRepositoryId: 99,
      repositoryId: "repo-a",
      owner: "acme",
      name: "repo",
      baseBranch: "main",
      headBranch: "mendpoint/run-a",
      pullRequestNumber: 41,
      candidateDigest: candidate.sha256,
      artifact: deliveryArtifact,
      changedPaths: ["src/client.ts"],
      treeDigest: `sha256:${hex("d")}`,
      matchingOpenDrafts: 1,
      observedAt: "2026-08-18T12:05:00.000Z",
      observation: {
        state: "draft",
        baseRevision: revision("a"),
        headRevision: revision("b"),
        checks: "success",
        checkRevision: revision("b"),
        approvals: 1,
        approvalRevision: revision("b"),
        conversationsResolved: true,
        failures: [],
        checkIdentities: ["check:1:test"],
        checkResults: [{ identity: "check:1:test", state: "success" }],
        reviewFeedback: { verdict: "none", changeRequests: [], comments: [] },
        evidenceRefs: ["github:observation-a"],
      },
    },
    cleanup: {
      pullRequestState: "closed",
      branchState: "retained_exact",
      headRevision: revision("b"),
      baseRevision: revision("a"),
      openTrialPullRequests: 0,
      rollbackArtifact: cleanupArtifact,
      observedAt: "2026-08-18T12:09:00.000Z",
      evidenceRefs: ["github:cleanup-a"],
    },
    attestation: placeholderEnvelope(),
  };
}

function contentArtifact(artifactId: string, value: unknown) {
  const content = JSON.stringify(value);
  return {
    artifact: { artifactId, sha256: createHash("sha256").update(content).digest("hex") },
    content,
  };
}

function bindAuthorityArtifacts(value: DelegatedPrTrialEvidence): Readonly<{
  trial: DelegatedPrTrialEvidence;
  contents: Readonly<Record<string, Readonly<{ content: string; kind: string; producer: string }>>>;
}> {
  const candidateClaims = {
    schemaVersion: 1,
    kind: "delegated_pr_candidate",
    tenantId: value.tenantId,
    runId: value.runId,
    changedPaths: value.candidate.changedPaths,
  };
  const candidate = contentArtifact(value.candidate.artifact.artifactId, candidateClaims);
  const verification = (role: "fail_to_pass" | "pass_to_pass", execution: typeof value.verification.failToPass) => {
    const { artifact: _artifact, ...executionClaims } = execution;
    return contentArtifact(execution.artifact.artifactId, {
      schemaVersion: 1,
      kind: "delegated_pr_verification_execution",
      role,
      tenantId: value.tenantId,
      runId: value.runId,
      candidateArtifact: candidate.artifact,
      execution: { ...executionClaims, candidateDigest: candidate.artifact.sha256 },
    });
  };
  const fail = verification("fail_to_pass", value.verification.failToPass);
  const pass = verification("pass_to_pass", value.verification.passToPass);
  const delivery = contentArtifact(value.delivery.artifact.artifactId, value.delivery.observation);
  const cleanup = contentArtifact(value.cleanup.rollbackArtifact.artifactId, {
    schemaVersion: 1,
    kind: "delegated_pr_cleanup_rollback",
    cleanupId: "cleanup-a",
  });
  const trialValue: DelegatedPrTrialEvidence = {
    ...value,
    candidate: { ...value.candidate, artifact: candidate.artifact },
    verification: {
      ...value.verification,
      failToPass: { ...value.verification.failToPass, artifact: fail.artifact, candidateDigest: candidate.artifact.sha256 },
      passToPass: { ...value.verification.passToPass, artifact: pass.artifact, candidateDigest: candidate.artifact.sha256 },
    },
    approval: { ...value.approval, candidateDigest: candidate.artifact.sha256 },
    delivery: { ...value.delivery, artifact: delivery.artifact, candidateDigest: candidate.artifact.sha256 },
    cleanup: { ...value.cleanup, rollbackArtifact: cleanup.artifact },
  };
  const { artifact: _deliveryArtifact, ...deliveryClaims } = trialValue.delivery;
  const attestedClaims = {
    workflow: trialValue.workflow,
    model: trialValue.model,
    accounting: trialValue.meter,
    approvalAudit: trialValue.approval,
    githubObservation: deliveryClaims,
    verification: trialValue.verification,
    cleanup: trialValue.cleanup,
    timeline: {
      startedAt: trialValue.startedAt,
      modelSettledAt: trialValue.model.settledAt,
      candidateCreatedAt: trialValue.candidate.createdAt,
      verificationCompletedAt: trialValue.verification.completedAt,
      approvedAt: trialValue.approval.approvedAt,
      deliveredAt: trialValue.delivery.observedAt,
      cleanedAt: trialValue.cleanup.observedAt,
      executionCompletedAt: trialValue.executionCompletedAt,
      finalizedAt: trialValue.finalizedAt,
    },
    changedPaths: trialValue.candidate.changedPaths,
  };
  const attestedEntries = Object.fromEntries(Object.entries(attestedClaims).map(([key, claims]) => {
    const ref = trialValue.attestedArtifacts[key as keyof typeof trialValue.attestedArtifacts];
    const bound = contentArtifact(ref.artifactId, claims);
    return [key, bound];
  })) as Record<keyof typeof attestedClaims, ReturnType<typeof contentArtifact>>;
  const fullyBoundTrial = {
    ...trialValue,
    attestedArtifacts: Object.fromEntries(Object.entries(attestedEntries)
      .map(([key, entry]) => [key, entry.artifact])) as DelegatedPrTrialEvidence["attestedArtifacts"],
  };
  return {
    trial: fullyBoundTrial,
    contents: {
      [candidate.artifact.artifactId]: { content: candidate.content, kind: "delegated_pr_candidate", producer: "trial-service" },
      [fail.artifact.artifactId]: { content: fail.content, kind: "delegated_pr_verification_execution", producer: "verifier-a" },
      [pass.artifact.artifactId]: { content: pass.content, kind: "delegated_pr_verification_execution", producer: "verifier-a" },
      [delivery.artifact.artifactId]: { content: delivery.content, kind: "delegated_pr_github_observation", producer: "trial-service" },
      [cleanup.artifact.artifactId]: { content: cleanup.content, kind: "delegated_pr_cleanup_rollback", producer: "trial-service" },
      ...Object.fromEntries(Object.values(attestedEntries).map((entry) => [entry.artifact.artifactId, {
        content: entry.content,
        kind: "delegated_pr_attested_claim",
        producer: "trial-service",
      }])),
    },
  };
}

function inventoryFor(
  value: DelegatedPrTrialEvidence,
  bindingContract: DelegatedPrAcceptanceContract = contract,
) {
  return {
    tenantId: value.tenantId,
    runId: value.runId,
    auditIntegrity: { ok: true, checked: 2 },
    agentRun: { status: "observed", value: {
      id: value.runId,
      job_id: value.jobId,
      result_json: JSON.stringify({
        artifacts: { candidateDigest: value.candidate.artifact.sha256, candidateManifestSha256: hex("f") },
        agent: { metrics: { model: { provenance: value.model.provenance } } },
      }),
      files_changed_json: JSON.stringify(value.candidate.changedPaths),
      created_at: value.startedAt,
      finished_at: value.candidate.createdAt,
    } },
    job: { status: "observed", value: { id: value.jobId } },
    trajectory: { status: "observed", value: { trajectory: {}, steps: [{ stepKind: "model_call", plannerSource: "model" }] } },
    modelReservations: { status: "observed", value: [{ settled_at: value.model.settledAt }] },
    routingLedger: { status: "observed", value: [{}] },
    runMeter: { status: "observed", value: {
      createdAt: value.startedAt,
      candidateReadyAt: value.candidate.createdAt,
      costMeasured: true,
      costUsd: value.meter.costUsd,
      inputTokens: value.meter.inputTokens,
      outputTokens: value.meter.outputTokens,
      durationMs: value.meter.durationMs,
    } },
    approval: { status: "observed", value: {
      auditEvents: [{ id: value.approval.auditEventId }],
      reviewerPrincipalId: value.approval.principalId,
      trustPrincipalId: value.approval.trustPrincipalId,
      authMethod: "oidc",
      membershipEvidenceId: value.approval.membershipEvidenceId,
      reviewedAt: value.approval.approvedAt,
      requestIds: [value.approval.requestId],
      seal: { path: value.approval.sealArtifact.artifactId, sha256: `sha256:${value.approval.sealArtifact.sha256}` },
      candidate: { digest: value.candidate.artifact.sha256, candidateManifestSha256: hex("f") },
    } },
    candidateDelivery: { status: "observed", value: {
      delivery: {
        repositoryId: value.delivery.repositoryId,
        snapshotId: value.source.snapshotArtifact.artifactId,
        baseBranch: value.delivery.baseBranch,
        expectedBaseRevision: value.source.revision,
        branchName: value.delivery.headBranch,
        commitSha: value.candidate.commitSha,
        draftPrNumber: value.delivery.pullRequestNumber,
        draftPrUrl: `https://github.com/${value.delivery.owner}/${value.delivery.name}/pull/${value.delivery.pullRequestNumber}`,
        deliveredAt: value.delivery.observedAt,
      },
      auditEvents: [{ id: "audit-delivery" }],
      auditReason: null,
    } },
    ci: { status: "observed", value: [{ cycle: {
      remoteRepositoryId: value.delivery.remoteRepositoryId,
      installationId: value.delivery.installationId,
    }, observations: [{
      evidenceArtifactId: value.delivery.artifact.artifactId,
      evidenceDigest: `sha256:${value.delivery.artifact.sha256}`,
      headSha: value.candidate.commitSha,
      verdict: "success",
      observedAt: value.delivery.observedAt,
    }] }] },
    terminalOutcome: { status: "observed", value: { outcome: "closed_unmerged" } },
    cleanup: { status: "observed", value: {
      cleanupId: "cleanup-a",
      artifact: value.cleanup.rollbackArtifact,
      attestationId: "cleanup-attestation",
      signerKeyIds: ["cleanup-key"],
      observedAt: value.cleanup.observedAt,
      cleanup: {
        pullRequestNumber: value.delivery.pullRequestNumber,
        pullRequestUrl: `https://github.com/${value.delivery.owner}/${value.delivery.name}/pull/${value.delivery.pullRequestNumber}`,
        pullRequestState: "closed",
        branchState: "retained_exact",
        headSha: value.cleanup.headRevision,
        baseSha: value.cleanup.baseRevision,
        openPullRequestsForHead: 0,
        evidenceRefs: value.cleanup.evidenceRefs,
      },
      attestationScope: {
        tenantId: value.tenantId,
        repositoryId: value.source.repositoryId,
        runId: value.runId,
        correlationId: value.correlationId,
        sourceArtifacts: [bindingContract.authorityManifest, bindingContract.taskArtifact, value.source.sourceArtifact],
        snapshotArtifact: value.source.snapshotArtifact,
        candidateArtifact: value.candidate.artifact,
        verificationArtifacts: [value.verification.failToPass.artifact, value.verification.passToPass.artifact],
        policyArtifact: bindingContract.verification.policyArtifact,
        deliveryArtifact: value.delivery.artifact,
        rollbackArtifact: value.cleanup.rollbackArtifact,
        waiverArtifact: null,
      },
    } },
  };
}

async function fixture(options: Readonly<{ skipArtifactId?: string }> = {}) {
  const root = mkdtempSync(join(tmpdir(), "delegated-trial-authority-"));
  roots.push(root);
  const db = createDb(join(root, "authority.sqlite"));
  databases.push(db);
  insertTenant(db, { id: "tenant-a", slug: "tenant-a", name: "Tenant A", createdAt: "2026-08-18T12:00:00.000Z" });
  insertPrincipal(db, {
    id: "trial-service",
    tenantId: "tenant-a",
    kind: "service",
    subject: "delegated-trial-controller",
    displayName: "Delegated trial controller",
    createdAt: "2026-08-18T12:00:00.000Z",
  });
  insertPrincipal(db, {
    id: "verifier-a",
    tenantId: "tenant-a",
    kind: "service",
    subject: "independent-verifier",
    displayName: "Independent verifier",
    createdAt: "2026-08-18T12:00:00.000Z",
  });
  const manifestContent = JSON.stringify({ schemaVersion: 1, kind: "delegated_pr_acceptance_authority" });
  insertArtifactManifest(db, {
    id: contract.authorityManifest.artifactId,
    tenantId: "tenant-a",
    kind: "delegated_pr_acceptance_authority",
    schemaVersion: 1,
    sha256: createHash("sha256").update(manifestContent).digest("hex"),
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(manifestContent),
    storageRef: "sqlite://authority-manifest",
    content: manifestContent,
    producerPrincipalId: "trial-service",
    createdAt: "2026-08-18T12:00:00.000Z",
  });
  const resolvedContract = { ...contract, authorityManifest: {
    artifactId: contract.authorityManifest.artifactId,
    sha256: createHash("sha256").update(manifestContent).digest("hex"),
  } } as DelegatedPrAcceptanceContract;
  const bound = bindAuthorityArtifacts(trial());
  let evidence = bound.trial;
  for (const [artifactId, entry] of Object.entries(bound.contents)) {
    if (artifactId === options.skipArtifactId) continue;
    insertArtifactManifest(db, {
      id: artifactId,
      tenantId: "tenant-a",
      kind: entry.kind,
      schemaVersion: 1,
      sha256: createHash("sha256").update(entry.content).digest("hex"),
      mediaType: "application/json",
      sizeBytes: Buffer.byteLength(entry.content),
      storageRef: `sqlite://${artifactId}`,
      content: entry.content,
      producerPrincipalId: entry.producer,
      createdAt: "2026-08-18T12:03:00.000Z",
    });
  }
  for (const [role, execution] of [
    ["fail_to_pass", evidence.verification.failToPass],
    ["pass_to_pass", evidence.verification.passToPass],
  ] as const) {
    insertEvidenceRecord(db, {
      id: `verification-evidence-${role}`,
      tenantId: "tenant-a",
      subjectType: "delegated_pr_verification",
      subjectId: `${evidence.runId}:${role}`,
      artifactId: execution.artifact.artifactId,
      inputArtifactId: evidence.candidate.artifact.artifactId,
      producerPrincipalId: "verifier-a",
      tool: "mendpoint-independent-verifier",
      toolVersion: resolvedContract.verification.authorityDigest,
      commitSha: resolvedContract.mendpointRevision,
      verdict: "passed",
      createdAt: evidence.verification.completedAt,
    });
  }
  const keys = generateKeyPairSync("ed25519");
  const signer = {
    keyId: "trial-key",
    algorithm: "ed25519" as const,
    sign: (bytes: Uint8Array) => new Uint8Array(sign(null, bytes, keys.privateKey)),
  };
  const statement = createSoftwareAttestationStatementV1({
    attestationId: "trial-attestation-a",
    scope: delegatedPrAttestationScope(resolvedContract, evidence),
    producer: {
      principalId: "trial-service",
      service: "mendpoint-delegated-trial",
      version: revision("f"),
    },
    outcome: "passed",
    issuedAt: evidence.finalizedAt,
  });
  evidence = { ...evidence, attestation: await signSoftwareAttestation(statement, signer) };
  mocked.inventory = inventoryFor(evidence, resolvedContract);
  const trustPolicy = {
    resolve: () => ({
      keyId: "trial-key",
      algorithm: "ed25519" as const,
      publicKey: keys.publicKey,
      principalId: "trial-service",
      service: "mendpoint-delegated-trial",
      tenantIds: ["tenant-a"],
      predicateTypes: ["https://mendpoint.ai/attestations/software/v1"],
      validFrom: "2026-08-18T00:00:00.000Z",
      validUntil: "2026-08-20T00:00:00.000Z",
      revokedAt: null,
    }),
  };
  const authority = createStoredDelegatedPrTrialAuthority(db, {
    contract: resolvedContract,
    producerPrincipalId: "trial-service",
    producerService: "mendpoint-delegated-trial",
    producerVersion: revision("f"),
    verifiedAt: "2026-08-18T12:11:00.000Z",
    maximumCleanupAgeMs: 60 * 60 * 1000,
    cleanupTrustPolicy: trustPolicy,
    trialTrustPolicy: trustPolicy,
  });
  return { db, authority, evidence, resolvedContract, trustPolicy };
}

function persistBundle(db: AppDb, value: DelegatedPrTrialEvidence, options: Readonly<{
  producerPrincipalId?: string;
  eventTrialDigest?: string;
  commitSha?: string | null;
  assembledAt?: string;
}> = {}): string {
  const trialDigest = digest(value);
  const bundleId = delegatedPrTrialBundleId({
    tenantId: value.tenantId,
    runId: value.runId,
    correlationId: value.correlationId,
    trial: value.trial,
    trialDigest,
  });
  const assembledAt = options.assembledAt ?? "2026-08-18T12:10:30.000Z";
  const content = JSON.stringify({
    schemaVersion: 1,
    kind: DELEGATED_PR_TRIAL_BUNDLE_KIND,
    bundleId,
    trialDigest,
    assembledAt,
    trial: value,
  });
  insertArtifactManifest(db, {
    id: bundleId,
    tenantId: value.tenantId,
    kind: DELEGATED_PR_TRIAL_BUNDLE_KIND,
    schemaVersion: 1,
    sha256: createHash("sha256").update(content).digest("hex"),
    mediaType: DELEGATED_PR_TRIAL_BUNDLE_MEDIA_TYPE,
    sizeBytes: Buffer.byteLength(content),
    storageRef: `sqlite://${bundleId}`,
    content,
    producerPrincipalId: options.producerPrincipalId ?? "trial-service",
    createdAt: assembledAt,
  });
  const evidenceId = `trial-evidence-${value.trial}`;
  insertEvidenceRecord(db, {
    id: evidenceId,
    tenantId: value.tenantId,
    subjectType: "delegated_pr_trial",
    subjectId: `${value.runId}:${value.trial}`,
    artifactId: bundleId,
    inputArtifactId: value.cleanup.rollbackArtifact.artifactId,
    producerPrincipalId: options.producerPrincipalId ?? "trial-service",
    tool: DELEGATED_PR_TRIAL_ASSEMBLER,
    toolVersion: revision("f"),
    commitSha: options.commitSha === undefined ? revision("f") : options.commitSha,
    verdict: "passed",
    createdAt: assembledAt,
  });
  appendDomainEvent(db, {
    id: `trial-event-${value.trial}`,
    tenantId: value.tenantId,
    schemaVersion: 1,
    eventType: "delegated_pr_trial.assembled",
    aggregateType: "delegated_pr_trial",
    aggregateId: bundleId,
    actorPrincipalId: options.producerPrincipalId ?? "trial-service",
    correlationId: value.correlationId,
    idempotencyKey: `delegated-pr-trial:${bundleId}`,
    payload: {
      bundleId,
      artifactId: bundleId,
      evidenceId,
      trialDigest: options.eventTrialDigest ?? trialDigest,
      tenantId: value.tenantId,
      runId: value.runId,
      correlationId: value.correlationId,
      jobId: value.jobId,
      trial: value.trial,
      cleanupArtifactId: value.cleanup.rollbackArtifact.artifactId,
      assembledAt,
    },
    createdAt: assembledAt,
  });
  return bundleId;
}

describe("stored delegated PR trial authority", () => {
  it("returns no trial until the signed bundle, passed evidence, and chained event all exist", async () => {
    const { authority, evidence } = await fixture();
    await expect(authority.loadTrial({ tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a", trial: 1 }))
      .resolves.toBeNull();
    expect(evidence.runId).toBe("run-a");
  });

  it("loads one immutable trusted bundle and rechecks the durable run and cleanup bindings", async () => {
    const { db, authority, evidence } = await fixture();
    persistBundle(db, evidence);
    const loaded = await authority.loadTrial({
      tenantId: "tenant-a",
      runId: "run-a",
      correlationId: "corr-a",
      trial: 1,
    });
    expect(loaded).toEqual(evidence);
    expect(Object.isFrozen(loaded)).toBe(true);

    const inventory = mocked.inventory as ReturnType<typeof inventoryFor>;
    inventory.candidateDelivery.value.delivery.draftPrNumber = 42;
    await expect(authority.loadTrial({ tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a", trial: 1 }))
      .rejects.toThrow("delegated_pr_trial_review_delivery_mismatch");
  });

  it("rejects a bundle when the event or durable delivery changes after assembly", async () => {
    const { db, authority, evidence } = await fixture();
    // A syntactically valid event that lies about the trial digest is rejected
    // before the evaluator can consume the bundle.
    persistBundle(db, evidence, { eventTrialDigest: `sha256:${hex("0")}` });
    await expect(authority.loadTrial({ tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a", trial: 1 }))
      .rejects.toThrow("delegated_pr_trial_event_corrupt");
  });

  it("rejects signed-bundle claim drift that disagrees with independent verification artifacts", async () => {
    const { db, authority, evidence } = await fixture();
    const forged = structuredClone(evidence);
    (forged.verification.failToPass as { baselineExitCode: number }).baselineExitCode = 2;
    persistBundle(db, forged);
    await expect(authority.loadTrial({ tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a", trial: 1 }))
      .rejects.toThrow("delegated_pr_trial_verification_artifact_invalid");
  });

  it("rejects an otherwise durable bundle when its trusted DSSE signature is altered", async () => {
    const { db, authority, evidence } = await fixture();
    const forged = structuredClone(evidence);
    (forged.attestation.signatures[0] as { sig: string }).sig = "AA==";
    persistBundle(db, forged);
    await expect(authority.loadTrial({ tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a", trial: 1 }))
      .rejects.toThrow(/software_attestation_signature_invalid|software_attestation_threshold_not_met/);
  });

  it("rejects durable run, delivery, or repository timing drift after the signed trial is assembled", async () => {
    const { db, authority, evidence } = await fixture();
    persistBundle(db, evidence);
    const inventory = mocked.inventory as ReturnType<typeof inventoryFor>;
    inventory.runMeter.value.candidateReadyAt = "2026-08-18T12:02:01.000Z";
    await expect(authority.loadTrial({ tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a", trial: 1 }))
      .rejects.toThrow("delegated_pr_trial_execution_timeline_mismatch");

    inventory.runMeter.value.candidateReadyAt = evidence.candidate.createdAt;
    inventory.candidateDelivery.value.delivery.draftPrUrl = "https://github.com/acme/other/pull/41";
    await expect(authority.loadTrial({ tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a", trial: 1 }))
      .rejects.toThrow("delegated_pr_trial_delivery_identity_mismatch");
  });

  it("rejects a cryptographically valid signer that the acceptance contract did not approve", async () => {
    const { db, evidence, resolvedContract, trustPolicy } = await fixture();
    persistBundle(db, evidence);
    const unapprovedContract = {
      ...resolvedContract,
      attestationProducer: { ...resolvedContract.attestationProducer, trustedKeyIds: ["different-key"] },
    } as DelegatedPrAcceptanceContract;
    const authority = createStoredDelegatedPrTrialAuthority(db, {
      contract: unapprovedContract,
      producerPrincipalId: "trial-service",
      producerService: "mendpoint-delegated-trial",
      producerVersion: revision("f"),
      verifiedAt: "2026-08-18T12:11:00.000Z",
      maximumCleanupAgeMs: 60 * 60 * 1000,
      cleanupTrustPolicy: trustPolicy,
      trialTrustPolicy: trustPolicy,
    });
    await expect(authority.loadTrial({ tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a", trial: 1 }))
      .rejects.toThrow("delegated_pr_trial_attestation_invalid");
  });

  it("rejects a signed trial whose claimed evidence artifact is not durably content addressed", async () => {
    const { db, authority, evidence } = await fixture({ skipArtifactId: "accounting-claims" });
    persistBundle(db, evidence);
    await expect(authority.loadTrial({ tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a", trial: 1 }))
      .rejects.toThrow("delegated_pr_trial_claim_artifact_invalid");
  });

  it("rejects an assembler record without the exact code revision or with a pre-finalization timestamp", async () => {
    const missingRevision = await fixture();
    persistBundle(missingRevision.db, missingRevision.evidence, { commitSha: null });
    await expect(missingRevision.authority.loadTrial({
      tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a", trial: 1,
    })).rejects.toThrow("delegated_pr_trial_evidence_invalid");

    const early = await fixture();
    persistBundle(early.db, early.evidence, { assembledAt: "2026-08-18T12:09:59.000Z" });
    await expect(early.authority.loadTrial({
      tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a", trial: 1,
    })).rejects.toThrow("delegated_pr_trial_evidence_invalid");
  });

  it("never crosses tenants and validates the content addressed authority manifest", async () => {
    const { authority, resolvedContract } = await fixture();
    await expect(authority.loadTrial({ tenantId: "tenant-b", runId: "run-a", correlationId: "corr-a", trial: 1 }))
      .resolves.toBeNull();
    await expect(authority.manifest()).resolves.toEqual(resolvedContract.authorityManifest);
    await expect(authority.now()).resolves.toBe("2026-08-18T12:11:00.000Z");
  });
});
