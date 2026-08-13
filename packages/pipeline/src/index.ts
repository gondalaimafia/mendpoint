import {
  createDb,
  getConsumer,
  getConsumerRepo,
  getConnectedRepository,
  getGitHubInstallationByInstallationId,
  getScmConnection,
  listConnectedRepositories,
  getProviderBySlug,
  listMonitoredForProvider,
  listVersionsForProvider,
  getPoliciesMap,
  getPr,
  insertSuppressedPattern,
  isPatternSuppressed,
  recordAudit,
  getOrInsertApiChange,
  insertImpactFinding,
  insertMigrationPr,
  updateMigrationPrStatus,
  updateMigrationPrDelivery,
  listConsumersForProvider,
  listFindingsForChange,
  listPrsForChange,
  appendDomainEvent,
  insertArtifactManifest,
  insertEvidenceRecord,
  getPrincipalBySubject,
  insertPrincipal,
  registrySummaryMarkdown,
  recordCapabilityAdoptionOpportunity,
  type AppDb,
} from "@mendpoint/db";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { normalizeChange } from "@mendpoint/change-intel";
import { analyzeCapabilityAdoption, analyzeImpact, reportToFindings } from "@mendpoint/code-impact";
import { notifyCapabilityAdoptionOpportunity } from "@mendpoint/notify";
import { generateMigration } from "@mendpoint/generation";
import {
  createAppDelivery,
  createGitHubDelivery,
  loadAppCredentials,
  OctokitGitHubDelivery,
  resolveGitHubTenantAccountBinding,
  type GitHubDelivery,
} from "@mendpoint/github";
import { evaluatePolicy, type PolicyConfig } from "@mendpoint/policy";
import {
  applyBrandPack,
  ensureWardenFooter,
  getBrandPack,
  getBrandPackForProvider,
} from "@mendpoint/branding";
import {
  applyActions,
  rollbackPristineFiles,
  runRepairSession,
  type PristineFile,
} from "@mendpoint/repair";
import { planFromSpecDiff, planToMarkdown } from "@mendpoint/orchestrator";
import {
  evaluateVerificationWaiver,
  evaluatePrGates,
  reviewOpenApiDesign,
  type ContractCase,
  type VerificationWaiver,
} from "@mendpoint/contract";
import { createWardenDraftPrPackage } from "./warden-pr-package.js";
export * from "./warden-campaign-executor.js";
export * from "./software-attestation-operation.js";
export * from "./post-trained-application.js";
export * from "./post-trained-training.js";
import {
  getGraphLearnDb,
  ingestControlPlane,
  ingestSpecDiff,
  ingestImpactFindings,
  labelPrOutcome,
  runGraphQuery,
  formatQueryForPlanner,
  type GraphLearnDb,
} from "@mendpoint/graph-learn";
import {
  newId,
  nowIso,
  type ImpactReport,
  type StructuralDiff,
} from "@mendpoint/shared";

function trustId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\0")).digest("hex")}`;
}

function textDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function resolveRepositoryRevision(
  repoRoot: string,
  snapshotContent: string,
): { revisionKind: "git_commit" | "content_manifest"; resolvedSha: string } {
  let revision: string;
  try {
    revision = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().toLowerCase();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) {
      throw new Error("structured_pr_repository_revision_invalid");
    }
    return { revisionKind: "git_commit", resolvedSha: revision };
  } catch {
    return { revisionKind: "content_manifest", resolvedSha: textDigest(snapshotContent) };
  }
}

function configuredPrincipals(value: unknown, fallback: string): string[] {
  if (value === undefined) return [fallback];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (principal): principal is string =>
      typeof principal === "string" && principal.trim() === principal && principal.length > 0,
  );
}

function persistJsonArtifact(
  db: AppDb,
  input: {
    tenantId: string;
    kind: string;
    mediaType: string;
    value: unknown;
    producerPrincipalId: string;
    createdAt: string;
  },
) {
  const content = JSON.stringify(input.value);
  const sha256 = textDigest(content);
  const id = trustId("artifact", input.tenantId, input.kind, sha256);
  return insertArtifactManifest(db, {
    id,
    tenantId: input.tenantId,
    kind: input.kind,
    schemaVersion: 1,
    sha256,
    mediaType: input.mediaType,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    storageRef: `sqlite://artifact_manifests/${id}#content_text`,
    content,
    producerPrincipalId: input.producerPrincipalId,
    createdAt: input.createdAt,
  }).row;
}


export type PipelineInput = {
  /** Authenticated tenant boundary for all consumer reads and writes. */
  tenantId: string;
  providerSlug: string;
  fromVersionLabel?: string;
  toVersionLabel?: string;
  consumerIds?: string[];
  db?: AppDb;
  graphDb?: GraphLearnDb;
  github?: GitHubDelivery;
  persistIndex?: boolean;
  /** First-party brand pack id, or true to auto-pick by provider */
  brandPackId?: string | true;
  /** Provider rollout severity override */
  severity?: "required" | "recommended" | "optional";
  /** Force notification-only (no PR) for this run */
  notificationsOnly?: boolean;
  /** migrate | adopt — default from change risk */
  mode?: "migrate" | "adopt";
  /**
   * Run agentic repair on consumer repo after draft edits (before/alongside PR).
   * Env: AGENTIC_REPAIR=1 also enables.
   */
  agenticRepair?: boolean;
  repairVerifyCommands?: string[];
  /** Recorded contract evidence required before PR delivery. */
  contractCases?: ContractCase[];
  /** Explicit security scan result required before PR delivery. */
  securityScanOk?: boolean;
  /** Signed human waiver for one tenant, run, and verification check. */
  verificationWaiver?: {
    runId: string;
    waiver: VerificationWaiver;
    signingKey: string | Uint8Array;
  };
  /** Cooperative cancellation checked before each customer mutation or delivery. */
  shouldContinue?: () => boolean;
};

export type PipelineReport = {
  changeId: string;
  risk: string;
  summary: string;
  diff: StructuralDiff;
  surfaces: number;
  consumers: Array<{
    consumerId: string;
    name: string;
    findings: number;
    candidates: number;
    confirmed: number;
    overallConfidence?: string;
    prId?: string;
    prStatus?: string;
    prUrl?: string;
    deliveryError?: string;
    impactReport?: ImpactReport;
    repair?: {
      sessionId: string;
      ok: boolean;
      attempts: number;
      edits: number;
    };
  }>;
};

type PipelineDeliveryResolution = {
  delivery: GitHubDelivery;
  githubRepositoryId?: string;
  githubInstallationId?: string;
  githubAccountId?: string;
  assertRepositoryIdentity?: () => Promise<void>;
};

function resolvePipelineConnectedRepository(
  db: AppDb,
  tenantId: string,
  consumer: { github_owner: string; github_repo: string },
  repo?: {
    scm_connection_id: string | null;
    connected_repository_id: string | null;
  },
) {
  if (!repo?.scm_connection_id || !repo.connected_repository_id) {
    throw new Error("github_connected_repository_identity_required");
  }
  const connected = getConnectedRepository(db, repo.connected_repository_id, tenantId);
  if (
    !connected ||
    connected.status !== "ready" ||
    connected.connection_id !== repo.scm_connection_id
  ) {
    throw new Error("github_connected_repository_identity_mismatch");
  }
  const connection = getScmConnection(db, repo.scm_connection_id, tenantId);
  if (!connection || connection.revoked_at || connection.provider !== "github") {
    throw new Error("github_app_connection_revoked");
  }
  if (
    connected.owner.toLowerCase() !== consumer.github_owner.toLowerCase() ||
    connected.name.toLowerCase() !== consumer.github_repo.toLowerCase()
  ) {
    throw new Error("github_connected_repository_name_mismatch");
  }
  if (!/^[1-9][0-9]{0,19}$/.test(connected.remote_id)) {
    throw new Error("github_repository_id_invalid");
  }
  const repositoryId = Number(connected.remote_id);
  if (!Number.isSafeInteger(repositoryId)) {
    throw new Error("github_repository_id_invalid");
  }
  return { connected, connection, repositoryId };
}

export function createPipelineDeliveryResolver(input: PipelineInput, db: AppDb) {
  if (input.github) {
    return (): PipelineDeliveryResolution => ({ delivery: input.github! });
  }
  const mode = process.env.GITHUB_MODE ?? "mock";
  if (mode !== "real") {
    const mock = createGitHubDelivery(mode);
    return (): PipelineDeliveryResolution => ({ delivery: mock });
  }
  const appCredentials = loadAppCredentials();
  const legacyToken = process.env.GITHUB_TOKEN?.trim();
  const legacy = legacyToken ? new OctokitGitHubDelivery(legacyToken) : null;
  const appDeliveries = new Map<string, GitHubDelivery>();
  return (
    consumer: {
      installation_id: string | null;
      github_delivery_mode: "app" | "legacy_pat" | "revoked";
      github_owner: string;
      github_repo: string;
    },
    repo?: {
      scm_connection_id: string | null;
      connected_repository_id: string | null;
    },
  ): PipelineDeliveryResolution => {
    const repository = resolvePipelineConnectedRepository(
      db,
      input.tenantId,
      consumer,
      repo,
    );
    const installationId = consumer.installation_id;
    if (!installationId) {
      if (consumer.github_delivery_mode === "revoked") {
        throw new Error("github_app_installation_revoked");
      }
      if (consumer.github_delivery_mode === "legacy_pat" && legacy) {
        if (process.env.MENDPOINT_DEPLOYMENT_PROFILE?.trim().toLowerCase() === "customer") {
          throw new Error("github_pat_customer_profile_forbidden");
        }
        if (process.env.MENDPOINT_DEPLOYMENT_CLASS?.trim() !== "disposable_canary") {
          throw new Error("github_pat_disposable_canary_required");
        }
        if (process.env.MENDPOINT_TENANT_ID?.trim() !== input.tenantId) {
          throw new Error("github_pat_tenant_not_pinned");
        }
        const pinned = listConnectedRepositories(db, input.tenantId).filter((candidate) => {
          if (candidate.status !== "ready") return false;
          const candidateConnection = getScmConnection(
            db,
            candidate.connection_id,
            input.tenantId,
          );
          return Boolean(
            candidateConnection &&
            candidateConnection.provider === "github" &&
            !candidateConnection.revoked_at &&
            candidateConnection.credential_ref === "env://GITHUB_TOKEN",
          );
        });
        if (
          repository.connection.credential_ref !== "env://GITHUB_TOKEN" ||
          pinned.length !== 1 ||
          pinned[0]?.id !== repository.connected.id
        ) {
          throw new Error("github_pat_repository_not_pinned");
        }
        return {
          delivery: legacy,
          githubRepositoryId: repository.connected.remote_id,
          assertRepositoryIdentity: () =>
            legacy.assertRepositoryIdentity(
              repository.connected.owner,
              repository.connected.name,
              repository.repositoryId,
            ),
        };
      }
      throw new Error("github_app_installation_required");
    }
    if (consumer.github_delivery_mode !== "app") {
      throw new Error("github_app_delivery_mode_mismatch");
    }
    if (!/^[1-9][0-9]{0,19}$/.test(installationId)) {
      throw new Error("github_app_installation_invalid");
    }
    const numericInstallationId = Number(installationId);
    if (!Number.isSafeInteger(numericInstallationId)) {
      throw new Error("github_app_installation_invalid");
    }
    if (!appCredentials) {
      throw new Error("github_app_credentials_required_for_bound_consumer");
    }
    const verified = getGitHubInstallationByInstallationId(db, installationId);
    if (!verified || verified.tenant_id !== input.tenantId) {
      throw new Error("github_app_installation_tenant_mismatch");
    }
    if (!verified.account_id) {
      throw new Error("github_app_installation_account_identity_required");
    }
    const expectedAccountId = resolveGitHubTenantAccountBinding(input.tenantId);
    if (!expectedAccountId) {
      throw new Error("github_app_tenant_account_binding_required");
    }
    if (verified.account_id !== expectedAccountId) {
      throw new Error("github_app_installation_account_identity_mismatch");
    }
    if (verified.suspended_at) {
      throw new Error("github_app_installation_suspended");
    }
    if (verified.deleted_at) {
      throw new Error("github_app_installation_deleted");
    }
    if (
      verified.repository_selection !== "selected" &&
      verified.repository_selection !== "all"
    ) {
      throw new Error("github_app_installation_evidence_invalid");
    }
    let permissions: Record<string, string>;
    let repositories: Array<{ id?: number; owner?: string; name?: string }>;
    try {
      permissions = JSON.parse(verified.permissions_json ?? "null") as Record<string, string>;
      repositories = JSON.parse(verified.repositories_json ?? "null") as Array<{
        id?: number;
        owner?: string;
        name?: string;
      }>;
    } catch {
      throw new Error("github_app_installation_evidence_invalid");
    }
    if (!permissions || !repositories || !Array.isArray(repositories)) {
      throw new Error("github_app_installation_evidence_invalid");
    }
    for (const [name, access] of Object.entries({
      metadata: "read",
      contents: "write",
      pull_requests: "write",
      checks: "read",
    })) {
      if (permissions[name] !== access && permissions[name] !== "write") {
        throw new Error("github_app_permissions_incomplete");
      }
    }
    const authorizedRepository = repositories.find(
      (candidate) =>
        candidate.owner?.toLowerCase() === consumer.github_owner.toLowerCase() &&
        candidate.name?.toLowerCase() === consumer.github_repo.toLowerCase() &&
        candidate.id === repository.repositoryId,
    );
    if (!authorizedRepository?.id) {
      const sameName = repositories.some(
        (candidate) =>
          candidate.owner?.toLowerCase() === consumer.github_owner.toLowerCase() &&
          candidate.name?.toLowerCase() === consumer.github_repo.toLowerCase(),
      );
      throw new Error(
        sameName
          ? "github_app_repository_identity_mismatch"
          : "github_app_repository_not_authorized",
      );
    }
    if (repository.connection.external_account_id !== installationId) {
      throw new Error("github_app_connection_mismatch");
    }
    const key = `${appCredentials.appId}:${installationId}:${authorizedRepository.id}`;
    let delivery = appDeliveries.get(key);
    if (!delivery) {
      delivery = createAppDelivery(
        numericInstallationId,
        appCredentials,
        [authorizedRepository.id],
      );
      appDeliveries.set(key, delivery);
    }
    return {
      delivery,
      githubRepositoryId: repository.connected.remote_id,
      githubInstallationId: installationId,
      githubAccountId: verified.account_id,
    };
  };
}

/**
 * Core product agent GRAPH (graph engineering), not one overloaded loop:
 * change_intel → index → candidates → expand (fan-out) → confirm → generate → verify → review_gate
 * Topology: wardenProductGraph() in @mendpoint/orchestrator. Each stage is a specialized node.
 * @see docs/GRAPH_ENGINEERING.md
 */
export async function runChangePipeline(input: PipelineInput): Promise<PipelineReport> {
  if (!input.tenantId.trim()) throw new Error("tenantId is required");
  const db = input.db ?? createDb();
  const deliveryFor = createPipelineDeliveryResolver(input, db);
  const pipelinePrincipal = insertPrincipal(db, {
    id: trustId("principal", input.tenantId, "warden-pipeline"),
    tenantId: input.tenantId,
    kind: "service",
    subject: "warden-pipeline",
    displayName: "Warden pipeline",
    audience: "pipeline",
    createdAt: nowIso(),
  });

  const provider = getProviderBySlug(db, input.providerSlug);
  if (!provider) throw new Error(`Unknown provider: ${input.providerSlug}`);

  const versions = listVersionsForProvider(db, provider.id);
  if (versions.length < 2) {
    throw new Error(`Provider ${input.providerSlug} needs at least 2 API versions`);
  }

  const from = input.fromVersionLabel
    ? versions.find((v) => v.version_label === input.fromVersionLabel)
    : versions[versions.length - 2];
  const to = input.toVersionLabel
    ? versions.find((v) => v.version_label === input.toVersionLabel)
    : versions[versions.length - 1];
  if (!from) {
    throw new Error(
      `Unknown from version ${input.fromVersionLabel} for provider ${input.providerSlug}`,
    );
  }
  if (!to) {
    throw new Error(
      `Unknown to version ${input.toVersionLabel} for provider ${input.providerSlug}`,
    );
  }
  if (from.id === to.id) {
    throw new Error(`Pipeline versions must be distinct for provider ${input.providerSlug}`);
  }

  const sourceArtifacts = [from, to].map((version) => {
    const id = trustId("artifact", input.tenantId, "api-version", version.id);
    return insertArtifactManifest(db, {
      id,
      tenantId: input.tenantId,
      kind: "change-source-openapi",
      schemaVersion: 1,
      sha256: textDigest(version.openapi_json),
      mediaType: "application/json",
      sizeBytes: Buffer.byteLength(version.openapi_json, "utf8"),
      storageRef: `sqlite://artifact_manifests/${id}#content_text`,
      content: version.openapi_json,
      producerPrincipalId: pipelinePrincipal.id,
      createdAt: nowIso(),
    }).row;
  });

  const oldSpec = JSON.parse(from.openapi_json);
  const newSpec = JSON.parse(to.openapi_json);

  // Stage 0–1: Structured Change Normalizer → Impactable Surfaces
  const { diff, surfaces } = normalizeChange(oldSpec, newSpec, {
    providerSlug: provider.slug,
    providerNotes: to.changelog_md ?? undefined,
  });

  const severity =
    input.severity ??
    (diff.risk === "breaking" ? "required" : diff.risk === "new_capability" ? "optional" : "recommended");

  const changeResult = getOrInsertApiChange(db, {
    id: newId(),
    providerId: provider.id,
    fromVersionId: from.id,
    toVersionId: to.id,
    risk: diff.risk,
    summary: diff.summary,
    severity,
    diffJson: JSON.stringify({ ...diff, surfaces, severity }),
    createdAt: nowIso(),
  });
  const changeId = changeResult.change.id;

  // Spec-first plan-of-record (Warden matrix P0)
  const specPlan = planFromSpecDiff({
    providerSlug: provider.slug,
    providerName: provider.name,
    fromVersion: from.version_label,
    toVersion: to.version_label,
    diff,
    surfaces,
  });
  const registryHits = listConsumersForProvider(db, provider.slug, input.tenantId);
  const registryMd = registrySummaryMarkdown(registryHits, provider.slug);
  const apiReview = reviewOpenApiDesign(newSpec);
  const gates = evaluatePrGates({
    oldSpec,
    newSpec,
    providerSlug: provider.slug,
    contractCases: input.contractCases,
    securityScanOk: input.securityScanOk,
  });
  // Provider breaking changes are the reason migration PRs exist. Delivery
  // fails closed on missing runtime contract/security evidence, while the
  // source-spec breaking-change result remains visible in the PR report.
  const deliveryEvidenceOk = gates.gates
    .filter((gate) => gate.id === "contract-suite" || gate.id === "security-scan")
    .every((gate) => gate.ok);

  appendDomainEvent(db, {
    id: trustId("event", input.tenantId, changeId, "normalized"),
    tenantId: input.tenantId,
    schemaVersion: 1,
    eventType: "change.normalized",
    aggregateType: "api_change",
    aggregateId: changeId,
    actorPrincipalId: pipelinePrincipal.id,
    correlationId: changeId,
    idempotencyKey: `api_change:${changeId}:normalized:v1`,
    payload: {
      providerSlug: provider.slug,
      fromArtifactId: sourceArtifacts[0].id,
      toArtifactId: sourceArtifacts[1].id,
      risk: diff.risk,
      surfaces: surfaces.length,
      gatesPassed: gates.ok,
    },
    createdAt: nowIso(),
  });

  // Dimension 6: graph learning substrate ingest + blast-radius query for planner
  const gldb = input.graphDb ?? getGraphLearnDb();
  const graphProviderSlug = `${input.tenantId}:${provider.slug}`;
  ingestControlPlane(gldb, {
    provider: {
      id: `${input.tenantId}:${provider.id}`,
      slug: graphProviderSlug,
      name: provider.name,
    },
    consumers: registryHits.map((h) => ({
      id: `${input.tenantId}:${h.consumerId}`,
      name: h.consumerName,
      githubOwner: h.githubOwner,
      githubRepo: h.githubRepo,
    })),
    monitors: registryHits.map((h) => ({
      consumerId: `${input.tenantId}:${h.consumerId}`,
      providerId: `${input.tenantId}:${provider.id}`,
    })),
  });
  ingestSpecDiff(gldb, {
    providerSlug: graphProviderSlug,
    changeId,
    diff,
    surfaces,
  });
  const blast = runGraphQuery(gldb, {
    op: "blast_radius",
    nodeId: `change:${changeId}`,
    maxHops: 2,
  });
  const graphRagMd = formatQueryForPlanner(blast);

  recordAudit(db, {
    tenantId: input.tenantId,
    actor: "pipeline",
    action: "change.normalized",
    resourceType: "api_change",
    resourceId: changeId,
    metadata: {
      risk: diff.risk,
      summary: diff.summary,
      surfaceCount: surfaces.length,
      planId: specPlan.id,
      planSteps: specPlan.steps.length,
      registryConsumers: registryHits.length,
      gateOk: gates.ok,
      apiReviewScore: apiReview.score,
      graphNodes: blast.nodes.length,
      graphEdges: blast.edges.length,
    },
  });

  let monitored = listMonitoredForProvider(db, provider.id, input.tenantId);
  if (input.consumerIds?.length) {
    monitored = monitored.filter((m) => input.consumerIds!.includes(m.consumer_id));
  }

  const report: PipelineReport = {
    changeId,
    risk: diff.risk,
    summary: diff.summary,
    diff,
    surfaces: surfaces.length,
    consumers: [],
  };
  const findingKeys = new Set(
    listFindingsForChange(db, changeId, input.tenantId).map(
      (finding) =>
        `${finding.consumer_id}\u0000${finding.file_path}\u0000${finding.line_start}\u0000${finding.line_end}\u0000${finding.symbol}`,
    ),
  );
  const nonRetryableStatuses = new Set([
    "draft",
    "open",
    "closed",
    "merged",
    "notification_only",
    "low_confidence",
  ]);
  const existingPrByConsumer = new Map(
    listPrsForChange(db, changeId, input.tenantId)
      .filter((pr) => nonRetryableStatuses.has(pr.status))
      .map((pr) => [pr.consumer_id, pr]),
  );
  const retryablePrByConsumer = new Map(
    listPrsForChange(db, changeId, input.tenantId)
      .filter((pr) =>
        ["delivery_pending", "delivery_failed", "gates_failed"].includes(pr.status),
      )
      .map((pr) => [pr.consumer_id, pr]),
  );
  const assertActive = () => {
    if (input.shouldContinue?.() === false) {
      throw new Error("lease_lost_during_pipeline");
    }
  };
  // Linked consumers (with local repos) for the capability-adoption pass below.
  const capabilityConsumers: Array<{
    consumerId: string;
    consumerName: string;
    repoRoot: string;
  }> = [];

  for (const mon of monitored) {
    assertActive();
    const consumer = getConsumer(db, mon.consumer_id, input.tenantId);
    const repo = getConsumerRepo(db, mon.consumer_id, input.tenantId);
    if (!consumer || !repo) continue;
    capabilityConsumers.push({
      consumerId: consumer.id,
      consumerName: consumer.name,
      repoRoot: repo.local_path,
    });
    const existingPr = existingPrByConsumer.get(consumer.id);
    if (existingPr) {
      const existingFindings = [...findingKeys].filter((key) =>
        key.startsWith(`${consumer.id}\u0000`),
      ).length;
      report.consumers.push({
        consumerId: consumer.id,
        name: consumer.name,
        findings: existingFindings,
        candidates: 0,
        confirmed: 0,
        prId: existingPr.id,
        prStatus: existingPr.status,
        prUrl: existingPr.github_pr_url ?? undefined,
      });
      continue;
    }

    // Stages 2–6: Index → Candidates → Expand → Confirm → ImpactReport
    const impactReport = await analyzeImpact(repo.local_path, surfaces, {
      persistIndex: input.persistIndex ?? true,
    });
    assertActive();

    const rawFindings = reportToFindings(impactReport);
    ingestImpactFindings(gldb, {
      changeId,
      consumerId: `${input.tenantId}:${consumer.id}`,
      findings: rawFindings.map((f) => ({
        filePath: f.filePath,
        symbol: f.symbol,
        confidence: f.confidence,
      })),
    });
    // Phase C: feedback learning — drop suppressed patterns (closed PRs taught us)
    const findings = rawFindings.filter((f) => {
      const keys = [f.symbol, f.filePath, f.fixHint ?? "", ...(f.relatedOps ?? [])];
      return !keys.some((k) =>
        k
          ? isPatternSuppressed(db, k, {
            consumerId: consumer.id,
            providerSlug: provider.slug,
            tenantId: input.tenantId,
            })
          : false,
      );
    });
    const suppressedCount = rawFindings.length - findings.length;
    for (const f of findings) {
      const findingKey = `${consumer.id}\u0000${f.filePath}\u0000${f.lineStart}\u0000${f.lineEnd}\u0000${f.symbol}`;
      if (findingKeys.has(findingKey)) continue;
      insertImpactFinding(db, {
        id: newId(),
        changeId,
        consumerId: consumer.id,
        filePath: f.filePath,
        lineStart: f.lineStart,
        lineEnd: f.lineEnd,
        symbol: f.symbol,
        confidence: f.confidence,
        evidenceJson: JSON.stringify(f),
      });
      findingKeys.add(findingKey);
    }


    recordAudit(db, {
      tenantId: input.tenantId,
      actor: "pipeline",
      action: "impact.analyzed",
      resourceType: "consumer",
      resourceId: consumer.id,
      metadata: {
        changeId,
        findings: findings.length,
        suppressedByLearning: suppressedCount,
        candidates: impactReport.candidateCount,
        confirmed: impactReport.confirmedCount,
        lowNotifications: impactReport.lowConfidenceNotifications.length,
        overallConfidence: impactReport.overallConfidence,
      },
    });


    const hasActionable = findings.length > 0 && impactReport.overallConfidence !== "low";
    const mode =
      input.mode ??
      (diff.risk === "new_capability" || severity === "optional" ? "adopt" : "migrate");
    let draft = generateMigration({
      providerName: provider.name,
      providerSlug: provider.slug,
      change: diff,
      findings,
      repoRoot: repo.local_path,
      impactReport,
      mode,
    });

    // Phase E: first-party branded packaging (optional)
    const brandPack =
      input.brandPackId === true
        ? getBrandPackForProvider(provider.slug)
        : typeof input.brandPackId === "string"
          ? getBrandPack(input.brandPackId)
          : process.env.BRAND_PACK === "auto"
            ? getBrandPackForProvider(provider.slug)
            : process.env.BRAND_PACK
              ? getBrandPack(process.env.BRAND_PACK)
              : undefined;
    let brandLabels: string[] = [];
    if (brandPack) {
      const branded = applyBrandPack(brandPack, { title: draft.title, body: draft.body });
      draft = { ...draft, title: branded.title, body: branded.body };
      brandLabels = branded.labels;
    } else {
      draft = { ...draft, body: ensureWardenFooter(draft.body) };
    }

    // Phase B: policy engine — never auto-merge; denylist paths; auth labels
    const policyMap = getPoliciesMap(db, consumer.id, input.tenantId);
    const policyOverrides: Partial<PolicyConfig> = {};
    if (policyMap.auto_merge_low_risk === true) policyOverrides.autoMergeLowRisk = true;
    if (Array.isArray(policyMap.never_touch_paths)) {
      policyOverrides.neverTouchPaths = policyMap.never_touch_paths as string[];
    }
    if (policyMap.notifications_only === true || input.notificationsOnly === true) {
      policyOverrides.notificationsOnly = true;
    }
    // Optional severity: never force PR for optional without findings of medium+
    if (severity === "optional" && impactReport.overallConfidence === "low") {
      policyOverrides.notificationsOnly = true;
    }

    const decision = evaluatePolicy(draft, findings, {
      policy: policyOverrides,
      risk: draft.risk,
    });

    const allLabels = [...new Set([...decision.labels, ...brandLabels])];

    recordAudit(db, {
      tenantId: input.tenantId,
      actor: "pipeline",
      action: "policy.evaluated",
      resourceType: "consumer",
      resourceId: consumer.id,
      metadata: {
        allowPr: decision.allowPr,
        allowAutoMerge: decision.allowAutoMerge,
        blockedFiles: decision.blockedFiles,
        labels: allLabels,
        brandPackId: brandPack?.id ?? null,
        reasons: decision.reasons,
      },
    });

    // Enforce: never claim auto-merge in PR body; attach plan + registry + gates + critic
    const prBody = [
      draft.body,
      "",
      planToMarkdown(specPlan),
      "",
      registryMd,
      "",
      graphRagMd,
      "",
      gates.reportMarkdown,
      "",
      apiReview.markdown,
      "",
      "### Policy",
      `- **Severity:** ${severity}`,
      "- **Auto-merge:** disabled (draft package requires human merge)",
      ...decision.reasons.map((r) => `- ${r}`),
      decision.blockedFiles.length
        ? `- **Blocked paths:** ${decision.blockedFiles.join(", ")}`
        : "",
      `- **Labels:** ${allLabels.join(", ")}`,
      brandPack ? `- **Brand pack:** ${brandPack.displayName}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    let status: string = hasActionable && decision.allowPr ? "open" : "low_confidence";
    let prUrl: string | undefined;
    let prNumber: number | undefined;
    let prBodyFinal = prBody;
    let deliveryError: string | undefined;

    // Build rename map from structural diff for agentic repair
    const renameMap: Record<string, string> = {};
    for (const e of diff.entries) {
      if (e.op === "request_field_renamed" && e.fromField && e.toField) {
        renameMap[e.fromField] = e.toField;
      }
    }

    let repairMeta: { sessionId: string; ok: boolean; attempts: number; edits: number } | undefined;
    let repairBlockedDelivery = false;
    const wantRepair =
      input.agenticRepair === true ||
      process.env.AGENTIC_REPAIR === "1" ||
      process.env.AGENTIC_REPAIR === "true";

    if (
      wantRepair &&
      !policyOverrides.notificationsOnly &&
      decision.allowedEdits.length > 0
    ) {
      // Stage generated edits through the same canonical containment boundary as repair.
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const pristineFiles = new Map<string, PristineFile>();
      applyActions(
        decision.allowedEdits.map((edit) => ({
          type: "write_file" as const,
          filePath: edit.path,
          content: edit.updated,
          reason: "generated migration draft",
        })),
        {
          repoRoot: repo.local_path,
          neverTouchPaths: policyOverrides.neverTouchPaths,
          maxActions: decision.allowedEdits.length,
          maxFilesChanged: decision.allowedEdits.length,
          pristineFiles,
        },
      );
      const captureRepairPristine = (
        edits: Array<{
          filePath: string;
          original: string;
          existed?: boolean;
        }>,
      ) => {
        for (const edit of edits) {
          if (pristineFiles.has(edit.filePath)) continue;
          pristineFiles.set(edit.filePath, {
            filePath: edit.filePath,
            absolutePath: join(repo.local_path, edit.filePath),
            existed: edit.existed ?? true,
            content: edit.original,
          });
        }
      };
      const rollbackAll = () =>
        rollbackPristineFiles(repo.local_path, pristineFiles);
      try {
        const repair = await runRepairSession({
          repoRoot: repo.local_path,
          renameMap,
          maxAttempts: Number(process.env.AGENTIC_REPAIR_ATTEMPTS ?? 3),
          verifyCommands: input.repairVerifyCommands ?? [],
          useLlm: process.env.LLM_REPAIR === "1",
          neverTouchPaths: policyOverrides.neverTouchPaths,
          allowBroadSearch: false,
          shouldContinue: input.shouldContinue,
        });
        repairMeta = {
          sessionId: repair.sessionId,
          ok: repair.ok,
          attempts: repair.attempts,
          edits: repair.edits.length,
        };
        captureRepairPristine(repair.edits);
        if (!repair.ok) {
          repairBlockedDelivery = true;
          rollbackAll();
        } else {
          // Refresh allowed edits from disk only after verification succeeds.
          for (const ed of decision.allowedEdits) {
            const abs = join(repo.local_path, ed.path);
            try {
              ed.updated = readFileSync(abs, "utf8");
            } catch {
              /* keep */
            }
          }
          for (const re of repair.edits) {
            if (!decision.allowedEdits.some((e) => e.path === re.filePath)) {
              decision.allowedEdits.push({
                path: re.filePath,
                original: re.original,
                updated: re.updated,
              });
            }
          }
          // Delivery uses the captured edit payloads. Keep the checkout clean
          // regardless of later SCM success or failure.
          rollbackAll();
        }
        prBodyFinal = [prBody, "", repair.reportMarkdown].join("\n");
        recordAudit(db, {
          tenantId: input.tenantId,
          actor: "repair",
          action: repair.ok ? "repair.ok" : "repair.failed",
          resourceType: "consumer",
          resourceId: consumer.id,
          metadata: repairMeta,
        });
      } catch (e) {
        repairBlockedDelivery = true;
        rollbackAll();
        recordAudit(db, {
          tenantId: input.tenantId,
          actor: "repair",
          action: "repair.error",
          resourceType: "consumer",
          resourceId: consumer.id,
          metadata: { error: e instanceof Error ? e.message : String(e) },
        });
      }
    }

    const waiverEvaluation = input.verificationWaiver
      ? evaluateVerificationWaiver({
          waiver: input.verificationWaiver.waiver,
          context: {
            tenantId: input.tenantId,
            runId: input.verificationWaiver.runId,
            checkId: "delivery-verification",
          },
          now: nowIso(),
          signingKey: input.verificationWaiver.signingKey,
          policy: { requireHumanActor: true },
        })
      : null;
    const verificationAccepted = deliveryEvidenceOk || waiverEvaluation?.accepted === true;
    let shouldDeliver =
      hasActionable &&
      decision.allowPr &&
      verificationAccepted &&
      decision.allowedEdits.length > 0 &&
      !policyOverrides.notificationsOnly &&
      !repairBlockedDelivery;

    if (repairBlockedDelivery) {
      status = "repair_failed";
    } else if (!verificationAccepted) {
      status = "gates_failed";
    } else if (policyOverrides.notificationsOnly) {
      status = "notification_only";
      recordAudit(db, {
        tenantId: input.tenantId,
        actor: "pipeline",
        action: "pipeline.notification_only",
        resourceType: "consumer",
        resourceId: consumer.id,
        metadata: { changeId, findings: findings.length, severity },
      });
    } else if (!decision.allowPr || !hasActionable) {
      status = "low_confidence";
    }

    const retryablePr = retryablePrByConsumer.get(consumer.id);
    const prId = retryablePr?.id ?? newId();
    const candidateContent = JSON.stringify({
      schemaVersion: 1,
      changeId,
      consumerId: consumer.id,
      baseBranch: repo.default_branch,
      branchName: draft.branchName,
      edits: decision.allowedEdits.map((edit) => ({
        path: edit.path,
        content: edit.updated,
      })),
    });
    const candidateArtifactId = trustId(
      "artifact",
      input.tenantId,
      prId,
      "candidate",
      textDigest(candidateContent),
    );
    insertArtifactManifest(db, {
      id: candidateArtifactId,
      tenantId: input.tenantId,
      kind: "candidate-edit",
      schemaVersion: 1,
      sha256: textDigest(candidateContent),
      mediaType: "application/vnd.mendpoint.candidate+json",
      sizeBytes: Buffer.byteLength(candidateContent, "utf8"),
      storageRef: `sqlite://artifact_manifests/${candidateArtifactId}#content_text`,
      content: candidateContent,
      producerPrincipalId: pipelinePrincipal.id,
      createdAt: nowIso(),
    });
    let waiverArtifactId: string | null = null;
    if (waiverEvaluation?.accepted && input.verificationWaiver) {
      const waiverContent = JSON.stringify(input.verificationWaiver.waiver);
      waiverArtifactId = trustId(
        "artifact",
        input.tenantId,
        input.verificationWaiver.waiver.waiverId,
        input.verificationWaiver.waiver.integrity.digest,
      );
      const waiverPrincipal =
        getPrincipalBySubject(
          db,
          input.tenantId,
          input.verificationWaiver.waiver.issuedBy.kind,
          input.verificationWaiver.waiver.issuedBy.id,
        ) ??
        insertPrincipal(db, {
          id: trustId(
            "principal",
            input.tenantId,
            input.verificationWaiver.waiver.issuedBy.kind,
            input.verificationWaiver.waiver.issuedBy.id,
          ),
          tenantId: input.tenantId,
          kind: input.verificationWaiver.waiver.issuedBy.kind,
          subject: input.verificationWaiver.waiver.issuedBy.id,
          displayName: input.verificationWaiver.waiver.issuedBy.id,
          createdAt: nowIso(),
        });
      insertArtifactManifest(db, {
        id: waiverArtifactId,
        tenantId: input.tenantId,
        kind: "verification-waiver",
        schemaVersion: 1,
        sha256: textDigest(waiverContent),
        mediaType: "application/vnd.mendpoint.verification-waiver+json",
        sizeBytes: Buffer.byteLength(waiverContent, "utf8"),
        storageRef: `sqlite://artifact_manifests/${waiverArtifactId}#content_text`,
        content: waiverContent,
        producerPrincipalId: waiverPrincipal.id,
        createdAt: nowIso(),
      });
    }
    const verificationContent = JSON.stringify({
      schemaVersion: 1,
      changeId,
      consumerId: consumer.id,
      gates: gates.gates,
      gateReport: gates.reportMarkdown,
      repair: repairMeta ?? null,
      deliveryEvidenceOk,
      verificationAccepted,
      waiver: waiverEvaluation
        ? {
            status: waiverEvaluation.status,
            waiverId: input.verificationWaiver?.waiver.waiverId ?? null,
            artifactId: waiverArtifactId,
          }
        : null,
      repairBlockedDelivery,
    });
    const verificationArtifactId = trustId(
      "artifact",
      input.tenantId,
      prId,
      "verification",
      textDigest(verificationContent),
    );
    insertArtifactManifest(db, {
      id: verificationArtifactId,
      tenantId: input.tenantId,
      kind: "verification-result",
      schemaVersion: 1,
      sha256: textDigest(verificationContent),
      mediaType: "application/vnd.mendpoint.verification+json",
      sizeBytes: Buffer.byteLength(verificationContent, "utf8"),
      storageRef: `sqlite://artifact_manifests/${verificationArtifactId}#content_text`,
      content: verificationContent,
      producerPrincipalId: pipelinePrincipal.id,
      createdAt: nowIso(),
    });
    const evidenceId = trustId(
      "evidence",
      input.tenantId,
      prId,
      candidateArtifactId,
      verificationArtifactId,
    );
    insertEvidenceRecord(db, {
      id: evidenceId,
      tenantId: input.tenantId,
      subjectType: "migration_pr",
      subjectId: prId,
      artifactId: verificationArtifactId,
      inputArtifactId: candidateArtifactId,
      producerPrincipalId: pipelinePrincipal.id,
      tool: "mendpoint-pr-gates",
      toolVersion: "1",
      verdict:
        verificationAccepted && !repairBlockedDelivery
          ? deliveryEvidenceOk
            ? "passed"
            : "waived"
          : "failed",
      createdAt: nowIso(),
    });
    prBodyFinal = [
      prBodyFinal,
      "",
      "### Immutable evidence",
      `- Candidate artifact: \`${candidateArtifactId}\``,
      `- Verification artifact: \`${verificationArtifactId}\``,
      waiverArtifactId ? `- Waiver artifact: \`${waiverArtifactId}\`` : "",
      `- Evidence record: \`${evidenceId}\``,
    ].filter(Boolean).join("\n");
    appendDomainEvent(db, {
      id: trustId("event", input.tenantId, prId, candidateArtifactId),
      tenantId: input.tenantId,
      schemaVersion: 1,
      eventType: "migration_pr.candidate_recorded",
      aggregateType: "migration_pr",
      aggregateId: prId,
      actorPrincipalId: pipelinePrincipal.id,
      correlationId: changeId,
      causationId: trustId("event", input.tenantId, changeId, "normalized"),
      idempotencyKey: `migration_pr:${prId}:candidate:${candidateArtifactId}`,
      payload: {
        candidateArtifactId,
        verificationArtifactId,
        evidenceId,
        verificationPassed: deliveryEvidenceOk && !repairBlockedDelivery,
        verificationWaived:
          !deliveryEvidenceOk && waiverEvaluation?.accepted === true && !repairBlockedDelivery,
        waiverArtifactId,
      },
      createdAt: nowIso(),
    });
    let structuredPackageArtifactId: string | null = null;
    if (shouldDeliver) {
      try {
        const packageCreatedAt = retryablePr?.created_at ?? nowIso();
        const snapshotFiles = decision.allowedEdits
          .map((edit) => ({ path: edit.path, sha256: textDigest(edit.original) }))
          .sort((left, right) => left.path.localeCompare(right.path));
        const snapshotIdentity = JSON.stringify({
          repositoryId: `${consumer.github_owner}/${consumer.github_repo}`,
          baseBranch: repo.default_branch,
          files: snapshotFiles,
        });
        const repositoryRevision = resolveRepositoryRevision(repo.local_path, snapshotIdentity);
        const { resolvedSha, revisionKind } = repositoryRevision;
        const snapshotManifest = {
          schemaVersion: 1,
          repositoryId: `${consumer.github_owner}/${consumer.github_repo}`,
          baseBranch: repo.default_branch,
          revisionKind,
          resolvedSha,
          files: snapshotFiles,
        };
        const snapshotArtifact = persistJsonArtifact(db, {
          tenantId: input.tenantId,
          kind: "repository-snapshot-manifest",
          mediaType: "application/vnd.mendpoint.repository-snapshot+json",
          value: snapshotManifest,
          producerPrincipalId: pipelinePrincipal.id,
          createdAt: packageCreatedAt,
        });
        const packageFindings = decision.allowedEdits.map((edit) => {
          const findingId = trustId("finding", input.tenantId, prId, edit.path);
          const evidenceArtifact = persistJsonArtifact(db, {
            tenantId: input.tenantId,
            kind: "warden-edit-evidence",
            mediaType: "application/vnd.mendpoint.warden-edit-evidence+json",
            value: {
              schemaVersion: 1,
              findingId,
              path: edit.path,
              originalSha256: textDigest(edit.original),
              candidateSha256: textDigest(edit.updated),
              findings: findings
                .filter((finding) => finding.filePath === edit.path)
                .map((finding) => ({
                  symbol: finding.symbol,
                  lineStart: finding.lineStart,
                  lineEnd: finding.lineEnd,
                  confidence: finding.confidence,
                  evidence: finding.evidence,
                })),
              repair: repairMeta ?? null,
            },
            producerPrincipalId: pipelinePrincipal.id,
            createdAt: packageCreatedAt,
          });
          return {
            tenantId: input.tenantId,
            findingId,
            evidenceArtifactIds: [evidenceArtifact.id],
          };
        });
        const policyArtifact = persistJsonArtifact(db, {
          tenantId: input.tenantId,
          kind: "warden-policy-decision",
          mediaType: "application/vnd.mendpoint.warden-policy+json",
          value: {
            schemaVersion: 1,
            policyId: `consumer:${consumer.id}`,
            allowPr: decision.allowPr,
            allowAutoMerge: false,
            allowAutoDeploy: false,
            reasons: decision.reasons,
            blockedFiles: decision.blockedFiles,
          },
          producerPrincipalId: pipelinePrincipal.id,
          createdAt: packageCreatedAt,
        });
        const fallbackOwner = `github-owner:${consumer.github_owner}`;
        const ownerPrincipalIds = configuredPrincipals(
          policyMap.pr_owner_principal_ids,
          fallbackOwner,
        );
        const reviewerPrincipalIds = configuredPrincipals(
          policyMap.pr_reviewer_principal_ids,
          fallbackOwner,
        );
        const requiredReviewerCount =
          policyMap.required_reviewer_count === undefined
            ? 1
            : Number(policyMap.required_reviewer_count);
        const ownershipArtifact = persistJsonArtifact(db, {
          tenantId: input.tenantId,
          kind: "warden-reviewer-ownership",
          mediaType: "application/vnd.mendpoint.reviewer-ownership+json",
          value: {
            schemaVersion: 1,
            repositoryId: `${consumer.github_owner}/${consumer.github_repo}`,
            ownerPrincipalIds,
            reviewerPrincipalIds,
            source:
              policyMap.pr_owner_principal_ids === undefined &&
              policyMap.pr_reviewer_principal_ids === undefined
                ? "repository-owner-fallback"
                : "tenant-policy",
          },
          producerPrincipalId: pipelinePrincipal.id,
          createdAt: packageCreatedAt,
        });
        const reviewArtifact = persistJsonArtifact(db, {
          tenantId: input.tenantId,
          kind: "warden-review-requirements",
          mediaType: "application/vnd.mendpoint.review-requirements+json",
          value: {
            schemaVersion: 1,
            requiredReviewerCount,
            reviewerPrincipalIds,
            mergeAuthority: "human_only",
          },
          producerPrincipalId: pipelinePrincipal.id,
          createdAt: packageCreatedAt,
        });
        const rollbackInstructions =
          "Close the draft pull request and restore the exact files from the recorded repository snapshot before retrying.";
        const rollbackArtifact = persistJsonArtifact(db, {
          tenantId: input.tenantId,
          kind: "warden-rollback-plan",
          mediaType: "application/vnd.mendpoint.rollback-plan+json",
          value: {
            schemaVersion: 1,
            strategy: "close_draft",
            instructions: rollbackInstructions,
            snapshotArtifactId: snapshotArtifact.id,
            resolvedSha,
            paths: decision.allowedEdits.map((edit) => edit.path).sort(),
          },
          producerPrincipalId: pipelinePrincipal.id,
          createdAt: packageCreatedAt,
        });
        const verificationResults = gates.gates
          .filter((gate) => gate.id === "contract-suite" || gate.id === "security-scan")
          .map((gate) => ({
            checkId: gate.id,
            status: (gate.ok ? "passed" : "waived") as "passed" | "waived",
            evidenceRecordIds: [evidenceId],
          }));
        const packageId = trustId(
          "package",
          input.tenantId,
          prId,
          candidateArtifactId,
          verificationArtifactId,
          ownershipArtifact.id,
        );
        const structured = createWardenDraftPrPackage({
          packageId,
          tenantId: input.tenantId,
          pullRequestId: prId,
          createdAt: packageCreatedAt,
          summary: diff.summary,
          rationale: impactReport.strategySummary,
          risks: [
            `Change risk: ${draft.risk}`,
            `Impact confidence: ${draft.confidence}`,
            ...decision.reasons,
          ].filter((value, index, values) => value.length > 0 && values.indexOf(value) === index),
          source: {
            artifacts: sourceArtifacts.map((artifact) => ({
              tenantId: input.tenantId,
              id: artifact.id,
            })),
          },
          snapshot: {
            tenantId: input.tenantId,
            snapshotId: snapshotArtifact.id,
            repositoryId: `${consumer.github_owner}/${consumer.github_repo}`,
            revisionKind,
            resolvedSha,
            manifestSha256: snapshotArtifact.sha256,
          },
          findings: packageFindings,
          candidate: {
            tenantId: input.tenantId,
            artifactId: candidateArtifactId,
            sha256: textDigest(candidateContent),
            predecessorArtifactId: null,
            edits: decision.allowedEdits.map((edit, index) => ({
              editId: trustId("edit", input.tenantId, prId, edit.path, textDigest(edit.updated)),
              path: edit.path,
              findingIds: [packageFindings[index]!.findingId],
            })),
          },
          verification: {
            tenantId: input.tenantId,
            artifactIds: [verificationArtifactId],
            evidenceRecordIds: [evidenceId],
            verdict: deliveryEvidenceOk ? "passed" : "waived",
            waiverArtifactId,
            results: verificationResults,
          },
          generation: {
            kind: repairMeta?.ok ? "model" : "recipe",
            executorId: repairMeta?.ok ? "warden-repair" : "warden-migration",
            version: "1",
          },
          policy: {
            tenantId: input.tenantId,
            artifactId: policyArtifact.id,
            policyId: `consumer:${consumer.id}`,
            version: policyArtifact.sha256,
            decision: "allow",
          },
          ownership: {
            tenantId: input.tenantId,
            codeownersArtifactId: ownershipArtifact.id,
            ownerPrincipalIds,
          },
          review: {
            tenantId: input.tenantId,
            requirementsArtifactId: reviewArtifact.id,
            requiredReviewerCount,
            reviewerPrincipalIds,
          },
          rollback: {
            tenantId: input.tenantId,
            artifactId: rollbackArtifact.id,
            strategy: "close_draft",
            verificationEvidenceRecordIds: [evidenceId],
            instructions: rollbackInstructions,
          },
          delivery: { mode: "draft", autoMerge: false, autoDeploy: false },
        });
        const packageArtifact = persistJsonArtifact(db, {
          tenantId: input.tenantId,
          kind: "structured-pr-package",
          mediaType: "application/vnd.mendpoint.structured-pr-package+json",
          value: structured.package,
          producerPrincipalId: pipelinePrincipal.id,
          createdAt: packageCreatedAt,
        });
        structuredPackageArtifactId = packageArtifact.id;
        prBodyFinal = [
          prBodyFinal,
          `- Structured package artifact: \`${packageArtifact.id}\``,
          "",
          structured.markdown,
        ].join("\n");
        appendDomainEvent(db, {
          id: trustId("event", input.tenantId, prId, packageArtifact.id),
          tenantId: input.tenantId,
          schemaVersion: 1,
          eventType: "migration_pr.package_recorded",
          aggregateType: "migration_pr",
          aggregateId: prId,
          actorPrincipalId: pipelinePrincipal.id,
          correlationId: changeId,
          causationId: trustId("event", input.tenantId, prId, candidateArtifactId),
          idempotencyKey: `migration_pr:${prId}:package:${packageArtifact.id}`,
          payload: {
            packageArtifactId: packageArtifact.id,
            packageId: structured.package.packageId,
            digest: structured.package.integrity.digest,
            delivery: structured.package.delivery,
          },
          createdAt: packageCreatedAt,
        });
      } catch (error) {
        shouldDeliver = false;
        status = "package_failed";
        deliveryError = error instanceof Error ? error.message : String(error);
        prBodyFinal = [
          prBodyFinal,
          "",
          "### Structured package status",
          "Delivery blocked because the required immutable review package could not be created.",
        ].join("\n");
      }
    }
    if (retryablePr) {
      updateMigrationPrDelivery(db, prId, {
        status: shouldDeliver ? "delivery_pending" : status,
        body: prBodyFinal,
      });
    } else {
      insertMigrationPr(db, {
        id: prId,
        changeId,
        consumerId: consumer.id,
        title: draft.title,
        body: prBodyFinal,
        branchName: draft.branchName,
        status: shouldDeliver ? "delivery_pending" : status,
        risk: draft.risk,
        patchUnified: draft.patch,
        githubPrNumber: prNumber ?? null,
        githubPrUrl: prUrl ?? null,
        createdAt: nowIso(),
        resolvedAt: null,
      });
    }
    if (shouldDeliver) {
      assertActive();
      try {
        const resolution = deliveryFor(consumer, repo);
        await resolution.assertRepositoryIdentity?.();
        updateMigrationPrDelivery(db, prId, {
          status: "delivery_pending",
          body: prBodyFinal,
          ...(resolution.githubRepositoryId
            ? { githubRepositoryId: resolution.githubRepositoryId }
            : {}),
          ...(resolution.githubInstallationId
            ? { githubInstallationId: resolution.githubInstallationId }
            : {}),
          ...(resolution.githubAccountId
            ? { githubAccountId: resolution.githubAccountId }
            : {}),
        });
        const github = resolution.delivery;
        await github.createBranch(
          consumer.github_owner,
          consumer.github_repo,
          draft.branchName,
          repo.default_branch,
        );
        assertActive();
        await github.commitFiles(
          consumer.github_owner,
          consumer.github_repo,
          draft.branchName,
          draft.title,
          decision.allowedEdits.map((e) => ({ path: e.path, content: e.updated })),
        );
        assertActive();
        const pr = await github.openPullRequest(
          consumer.github_owner,
          consumer.github_repo,
          draft.branchName,
          draft.title,
          prBodyFinal,
          repo.default_branch,
        );
        assertActive();
        prUrl = pr.url;
        prNumber = pr.number;
        status = "draft";
        updateMigrationPrDelivery(db, prId, {
          status,
          githubPrNumber: prNumber,
          githubPrUrl: prUrl,
          body: prBodyFinal,
        });
      } catch (error) {
        status = "delivery_failed";
        deliveryError = error instanceof Error ? error.message : String(error);
        updateMigrationPrDelivery(db, prId, { status });
      }
    }

    recordAudit(db, {
      tenantId: input.tenantId,
      actor: "pipeline",
      action:
        status === "low_confidence"
          ? "pr.low_confidence"
          : status === "notification_only"
            ? "pr.notification_only"
            : status === "gates_failed"
              ? "pr.gates_failed"
              : status === "repair_failed"
                ? "pr.repair_failed"
                : status === "package_failed"
                  ? "pr.package_failed"
                : status === "delivery_failed"
                  ? "pr.delivery_failed"
                  : "pr.draft_opened",
      resourceType: "migration_pr",
      resourceId: prId,
      metadata: {
        product: "warden",
        prUrl,
        findings: findings.length,
        strategy: impactReport.strategySummary,
        repair: repairMeta ?? null,
        brandPackId: brandPack?.id ?? null,
        structuredPackageArtifactId,
        deliveryError: deliveryError ?? null,
      },
    });
    appendDomainEvent(db, {
      id: trustId("event", input.tenantId, prId, status, candidateArtifactId),
      tenantId: input.tenantId,
      schemaVersion: 1,
      eventType: `migration_pr.${status}`,
      aggregateType: "migration_pr",
      aggregateId: prId,
      actorPrincipalId: pipelinePrincipal.id,
      correlationId: changeId,
      causationId: trustId("event", input.tenantId, prId, candidateArtifactId),
      idempotencyKey: `migration_pr:${prId}:status:${status}:candidate:${candidateArtifactId}`,
      payload: {
        status,
        prUrl: prUrl ?? null,
        deliveryError: deliveryError ?? null,
        candidateArtifactId,
        verificationArtifactId,
      },
      createdAt: nowIso(),
    });

    report.consumers.push({
      consumerId: consumer.id,
      name: consumer.name,
      findings: findings.length,
      candidates: impactReport.candidateCount,
      confirmed: impactReport.confirmedCount,
      overallConfidence: impactReport.overallConfidence,
      prId,
      prStatus: status,
      prUrl,
      deliveryError,
      impactReport,
      repair: repairMeta,
    });
  }

  // Capability-adoption alerts (G1f). Read-only analysis + idempotent persistence
  // + Slack-gated notify. Runs AFTER the delivery loop and is fully best-effort:
  // any failure here is recorded and swallowed so it can never affect
  // change-detection, PR generation, or delivery. Detection short-circuits (no
  // indexing cost) when the change introduces no additive capabilities.
  try {
    const opportunities = analyzeCapabilityAdoption(diff, capabilityConsumers, {
      providerSlug: provider.slug,
      providerNotes: to.changelog_md ?? undefined,
    });
    for (const opp of opportunities) {
      recordCapabilityAdoptionOpportunity(db, {
        tenantId: input.tenantId,
        changeId,
        providerSlug: provider.slug,
        capabilityId: opp.capability.capabilityId,
        op: opp.capability.op,
        endpoint: opp.capability.endpoint,
        path: opp.capability.path ?? null,
        method: opp.capability.method ?? null,
        field: opp.capability.field ?? null,
        linkedConsumerCount: opp.linkedConsumerCount,
        adoptingCount: opp.adoptingCount,
        nonAdoptingCount: opp.nonAdoptingCount,
        adoptionRate: opp.adoptionRate,
        priority: opp.priority,
        adoptingConsumers: opp.adoptingConsumers,
        nonAdoptingConsumers: opp.nonAdoptingConsumers,
        suggestedAction: opp.suggestedAction,
        valueBasis: opp.valueBasis,
      });
      void notifyCapabilityAdoptionOpportunity({
        provider: provider.slug,
        capability: opp.capability.endpoint,
        endpoint: opp.capability.endpoint,
        adoptingConsumers: opp.adoptingConsumers.map((c) => c.consumerName),
        nonAdoptingConsumers: opp.nonAdoptingConsumers.map((c) => c.consumerName),
        suggestedAction: opp.suggestedAction,
        priority: opp.priority,
      }).catch(() => undefined);
    }
    if (opportunities.length) {
      recordAudit(db, {
        tenantId: input.tenantId,
        actor: "pipeline",
        action: "capability.opportunities",
        resourceType: "api_change",
        resourceId: changeId,
        metadata: {
          product: "warden",
          count: opportunities.length,
          capabilities: opportunities.map((o) => o.capability.endpoint),
        },
      });
    }
  } catch (error) {
    try {
      recordAudit(db, {
        tenantId: input.tenantId,
        actor: "pipeline",
        action: "capability.opportunities_failed",
        resourceType: "api_change",
        resourceId: changeId,
        metadata: { error: error instanceof Error ? error.message : String(error) },
      });
    } catch {
      /* capability-adoption alerts must never break the delivery loop */
    }
  }

  return report;
}

export type PrFeedbackOpts = {
  tenantId: string;
  graphDb?: GraphLearnDb;
  /** A/B arm — overrides body tag / env default */
  experiment?: "control" | "treatment" | string;
  /** Plan-of-record id for EXECUTED_PLAN edges */
  planId?: string;
};

/** Parse experiment arm from PR body tags or env. */
export function resolveExperimentArm(
  body: string | undefined | null,
  explicit?: string,
): string {
  if (explicit) return explicit;
  const m = body?.match(
    /\[experiment:\s*(control|treatment|a|b|learned|baseline)\]/i,
  );
  if (m) {
    const v = m[1]!.toLowerCase();
    if (v === "a" || v === "baseline") return "control";
    if (v === "b" || v === "learned") return "treatment";
    return v;
  }
  const env = process.env.MENDPOINT_EXPERIMENT_DEFAULT?.toLowerCase();
  if (env === "control" || env === "treatment") return env;
  // Untagged: explicit control (A/B measureAbLift is tagged-only by default)
  return "control";
}

export function resolvePlanIdFromPr(
  body: string | undefined | null,
  explicit?: string,
): string | undefined {
  if (explicit) return explicit;
  const m = body?.match(/\[plan:\s*([a-zA-Z0-9_-]+)\]/);
  return m?.[1];
}

export async function applyPrFeedback(
  db: AppDb,
  prId: string,
  outcome: "merged" | "closed" | "modified",
  opts: PrFeedbackOpts,
) {
  const replayId = (kind: string, value = "") =>
    `feedback:${createHash("sha256")
      .update([opts.tenantId, prId, outcome, kind, value].join("\u0000"))
      .digest("hex")}`;
  const pr = getPr(db, prId, opts.tenantId);
  if (!pr) throw new Error(`Unknown migration PR ${prId} for tenant`);
  const status = outcome === "modified" ? "open" : outcome;
  const resolvedAt = outcome === "merged" || outcome === "closed" ? nowIso() : null;
  updateMigrationPrStatus(db, prId, status, resolvedAt);
  recordAudit(db, {
    id: replayId("pr_feedback"),
    tenantId: opts.tenantId,
    actor: "consumer",
    action: `pr.feedback.${outcome}`,
    resourceType: "migration_pr",
    resourceId: prId,
  });

  const experiment = resolveExperimentArm(pr.body, opts.experiment);
  const planId = resolvePlanIdFromPr(pr.body, opts.planId);
  const graphDb = opts.graphDb ?? getGraphLearnDb();

  // Dimension 6: label outcome edges with experiment + plan attribution
  if (pr && (outcome === "merged" || outcome === "closed")) {
    try {
      labelPrOutcome(graphDb, {
        prId,
        changeId: pr.change_id,
        consumerId: pr.consumer_id,
        outcome: outcome === "merged" ? "merged" : "closed",
        title: pr.title,
        experiment,
        planId,
      });
    } catch {
      /* non-fatal */
    }
  }

  // Phase C learning: closed PRs suppress similar symbols for this consumer
  if (outcome === "closed") {
    if (pr) {
      const patterns = extractPatternsFromPrBody(pr.body);
      for (const pattern of patterns) {
        insertSuppressedPattern(db, {
          id: replayId("suppressed_pattern", pattern),
          tenantId: opts.tenantId,
          consumerId: pr.consumer_id,
          pattern,
          reason: "closed_pr_feedback",
          sourcePrId: prId,
          createdAt: nowIso(),
        });
      }
      try {
        labelPrOutcome(graphDb, {
          prId,
          changeId: pr.change_id,
          consumerId: pr.consumer_id,
          outcome: "broke",
          title: pr.title,
          experiment,
          planId,
        });
      } catch {
        /* */
      }
      recordAudit(db, {
        id: replayId("patterns_suppressed"),
        tenantId: opts.tenantId,
        actor: "learning",
        action: "patterns.suppressed",
        resourceType: "migration_pr",
        resourceId: prId,
        metadata: {
          patterns,
          count: patterns.length,
          graphLabeled: true,
          experiment,
          planId,
        },
      });
    }
  }
}

/** Pull symbol-like tokens from PR evidence lines for suppression. */
export function extractPatternsFromPrBody(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\*\*([^*]+)\*\*/g)) {
    const t = m[1]!.trim();
    if (t.length >= 3 && t.length < 80 && !/risk|confidence|agent/i.test(t)) {
      out.add(t);
    }
  }
  for (const m of body.matchAll(/`([^`]{3,60})`/g)) {
    const t = m[1]!;
    if (/amount_|max_tokens|starting_after|X-API|\/v\d+|charges\.|customers\./i.test(t)) {
      out.add(t);
    }
  }
  return [...out].slice(0, 20);
}

