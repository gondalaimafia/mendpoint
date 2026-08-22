import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as ed25519Sign,
  timingSafeEqual,
} from "node:crypto";
import {
  completeJob,
  insertArtifactManifest,
  type AppDb,
  type JobRow,
} from "@mendpoint/db";
import {
  recordDelegatedPrCleanup,
  type DelegatedPrCleanupExecutor,
  type RecordedDelegatedPrCleanup,
} from "@mendpoint/pipeline";
import type { SoftwareAttestationSigner } from "@mendpoint/contract";
import {
  resolveDelegatedPrCleanupAuthority,
  type DelegatedPrCleanupAuthority,
  type ResolveDelegatedPrCleanupAuthorityInput,
} from "./delegated-pr-cleanup-authority.js";
import { WARDEN_CANDIDATE_CLEANUP_JOB_TYPE } from "./warden-candidate-observation.js";

type CleanupRecorder = typeof recordDelegatedPrCleanup;

export type DelegatedPrCleanupJobDependencies = Readonly<{
  actorPrincipalId: string;
  signer: SoftwareAttestationSigner;
  cleanupExactDraft: DelegatedPrCleanupExecutor;
  resolveRepository: ResolveDelegatedPrCleanupAuthorityInput["resolveRepository"];
  producerVersion: string;
  keyValidFrom?: string;
  keyValidUntil?: string;
  allowedTenantIds?: readonly string[];
  now?: () => string;
  resolveAuthority?: typeof resolveDelegatedPrCleanupAuthority;
  recordCleanup?: CleanupRecorder;
}>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function ensureAuthorityArtifact(
  db: AppDb,
  input: Readonly<{
    id: string;
    tenantId: string;
    kind: "delegated_pr_task" | "delegated_pr_cleanup_policy";
    content: string;
    producerPrincipalId: string;
    createdAt: string;
  }>,
): void {
  const digest = sha256(input.content);
  const existing = db.raw.prepare(
    "SELECT kind, sha256, content_text, producer_principal_id, created_at FROM artifact_manifests WHERE tenant_id = ? AND id = ?",
  ).get(input.tenantId, input.id) as Readonly<{
    kind: string; sha256: string; content_text: string | null; producer_principal_id: string; created_at: string;
  }> | undefined;
  if (existing) {
    if (existing.kind !== input.kind || existing.sha256 !== digest || existing.content_text !== input.content ||
        existing.producer_principal_id !== input.producerPrincipalId ||
        !Number.isFinite(Date.parse(existing.created_at)) || existing.created_at > input.createdAt) {
      throw new Error("delegated_pr_cleanup_job_authority_artifact_conflict");
    }
    return;
  }
  insertArtifactManifest(db, {
    id: input.id,
    tenantId: input.tenantId,
    kind: input.kind,
    schemaVersion: 1,
    sha256: digest,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(input.content, "utf8"),
    storageRef: `sqlite://artifact_manifests/${input.id}#content_text`,
    content: input.content,
    producerPrincipalId: input.producerPrincipalId,
    createdAt: input.createdAt,
  });
}

function artifactIds(job: JobRow): Readonly<{ taskId: string; policyId: string }> {
  const root = sha256(`${job.tenant_id}\0${job.id}`);
  return Object.freeze({
    taskId: `delegated_cleanup_task_${root.slice(0, 40)}`,
    policyId: `delegated_cleanup_policy_${root.slice(0, 40)}`,
  });
}

function materializeAuthorityArtifacts(db: AppDb, job: JobRow, authority: DelegatedPrCleanupAuthority) {
  const ids = artifactIds(job);
  const common = {
    schemaVersion: 1,
    tenantId: authority.tenantId,
    repositoryId: authority.repositoryId,
    runId: authority.runId,
    correlationId: authority.correlationId,
    deliveryRecordId: authority.deliveryRecordId,
    cycleId: authority.cycleId,
    cleanupJobId: job.id,
    operationId: authority.cleanup.operationId,
  };
  ensureAuthorityArtifact(db, {
    id: ids.taskId,
    tenantId: authority.tenantId,
    kind: "delegated_pr_task",
    content: canonical({ ...common, kind: "delegated_pr_task", action: "record_exact_draft_cleanup" }),
    producerPrincipalId: authority.actorPrincipalId,
    createdAt: authority.resolvedAt,
  });
  ensureAuthorityArtifact(db, {
    id: ids.policyId,
    tenantId: authority.tenantId,
    kind: "delegated_pr_cleanup_policy",
    content: canonical({ ...common, kind: "delegated_pr_cleanup_policy", headDisposition: "retain_exact",
      deleteAuthority: false, mergeAuthority: false, deployAuthority: false }),
    producerPrincipalId: authority.actorPrincipalId,
    createdAt: authority.resolvedAt,
  });
  return ids;
}

export async function runDelegatedPrCleanupJob(
  db: AppDb,
  job: JobRow,
  dependencies: DelegatedPrCleanupJobDependencies,
): Promise<RecordedDelegatedPrCleanup> {
  if (job.type !== WARDEN_CANDIDATE_CLEANUP_JOB_TYPE || job.status !== "running" ||
      !job.lease_owner || job.lease_generation < 1) {
    throw new Error("delegated_pr_cleanup_job_invalid");
  }
  const resolved = await (dependencies.resolveAuthority ?? resolveDelegatedPrCleanupAuthority)(db, {
    job,
    actorPrincipalId: dependencies.actorPrincipalId,
    resolveRepository: dependencies.resolveRepository,
    now: dependencies.now,
  });
  if (resolved.cleanup.headDisposition !== "retain_exact") {
    throw new Error("delegated_pr_cleanup_job_delete_authority_forbidden");
  }
  if (dependencies.allowedTenantIds && !dependencies.allowedTenantIds.includes(resolved.tenantId)) {
    throw new Error("delegated_pr_cleanup_job_tenant_not_authorized");
  }
  if (dependencies.keyValidFrom || dependencies.keyValidUntil) {
    const resolvedAt = Date.parse(resolved.resolvedAt);
    const validFrom = Date.parse(dependencies.keyValidFrom ?? "");
    const validUntil = Date.parse(dependencies.keyValidUntil ?? "");
    if (!Number.isFinite(resolvedAt) || !Number.isFinite(validFrom) || !Number.isFinite(validUntil) ||
        resolvedAt < validFrom || resolvedAt >= validUntil) {
      throw new Error("delegated_pr_cleanup_runtime_key_invalid");
    }
  }
  const artifacts = materializeAuthorityArtifacts(db, job, resolved);
  const recorded = await (dependencies.recordCleanup ?? recordDelegatedPrCleanup)(db, {
    tenantId: resolved.tenantId,
    runId: resolved.runId,
    correlationId: resolved.correlationId,
    actorPrincipalId: resolved.actorPrincipalId,
    deliveryRecordId: resolved.deliveryRecordId,
    cycleId: resolved.cycleId,
    idempotencyKey: job.id,
    observedAt: resolved.resolvedAt,
    cleanup: resolved.cleanup,
    artifacts: {
      sourceIds: [artifacts.taskId],
      snapshotId: resolved.snapshotId,
      candidateId: resolved.candidateArtifactId,
      verificationIds: [...resolved.verificationArtifactIds],
      policyId: artifacts.policyId,
      deliveryId: resolved.observationArtifactId,
    },
  }, {
    enabled: true,
    cleanupExactDraft: dependencies.cleanupExactDraft,
    signer: dependencies.signer,
    producerService: "mendpoint-delegated-cleanup",
    producerVersion: dependencies.producerVersion,
    authorizeActor: (_db, input) => input.actorPrincipalId === resolved.actorPrincipalId &&
      input.tenantId === resolved.tenantId && input.runId === resolved.runId &&
      input.deliveryRecordId === resolved.deliveryRecordId && input.cycleId === resolved.cycleId &&
      input.cleanup.operationId === resolved.cleanup.operationId,
  });
  const completedAt = dependencies.now?.() ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(completedAt)) || new Date(Date.parse(completedAt)).toISOString() !== completedAt ||
      completedAt < resolved.resolvedAt) {
    throw new Error("delegated_pr_cleanup_job_completion_time_invalid");
  }
  if (!completeJob(db, job.id, {
    cleanupId: recorded.cleanupId,
    cleanupArtifactId: recorded.cleanupArtifactId,
    attestationId: recorded.attestation.attestationId,
    headDisposition: recorded.cleanup.branchState,
  }, completedAt, { workerId: job.lease_owner, leaseGeneration: job.lease_generation })) {
    throw new Error("delegated_pr_cleanup_job_lease_lost");
  }
  return recorded;
}

export type DelegatedPrCleanupRuntimeConfig = Readonly<{
  actorPrincipalId: string;
  signer: SoftwareAttestationSigner;
  producerVersion: string;
  allowedTenantIds: readonly string[];
  keyValidFrom: string;
  keyValidUntil: string;
}>;

export function delegatedPrCleanupRuntimeConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  now: () => number = Date.now,
): DelegatedPrCleanupRuntimeConfig | undefined {
  const enabled = env.MENDPOINT_DELEGATED_PR_CLEANUP_ENABLED?.trim() ?? "0";
  if (enabled === "0") return undefined;
  if (enabled !== "1") throw new Error("delegated_pr_cleanup_runtime_enabled_invalid");
  const keyId = env.MENDPOINT_DELEGATED_PR_ATTESTATION_KEY_ID?.trim();
  const privateDer = env.MENDPOINT_DELEGATED_PR_ATTESTATION_PRIVATE_KEY_PKCS8_BASE64?.trim();
  const publicDer = env.MENDPOINT_DELEGATED_PR_ATTESTATION_PUBLIC_KEY_SPKI_BASE64?.trim();
  const actorPrincipalId = env.MENDPOINT_DELEGATED_PR_ATTESTATION_PRINCIPAL_ID?.trim();
  const service = env.MENDPOINT_DELEGATED_PR_ATTESTATION_SERVICE?.trim();
  const validFrom = env.MENDPOINT_DELEGATED_PR_ATTESTATION_KEY_VALID_FROM?.trim();
  const validUntil = env.MENDPOINT_DELEGATED_PR_ATTESTATION_KEY_VALID_UNTIL?.trim();
  const producerVersion = env.MENDPOINT_RELEASE_REVISION?.trim();
  const allowedTenantIds = env.MENDPOINT_DELEGATED_PR_ATTESTATION_TENANT_IDS
    ?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  if (![keyId, privateDer, publicDer, actorPrincipalId, validFrom, validUntil, producerVersion]
      .every((value) => Boolean(value)) || service !== "mendpoint-delegated-cleanup" ||
      allowedTenantIds.length < 1 || new Set(allowedTenantIds).size !== allowedTenantIds.length ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(actorPrincipalId!) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(producerVersion!)) {
    throw new Error("delegated_pr_cleanup_runtime_config_invalid");
  }
  const validFromMs = Date.parse(validFrom!);
  const validUntilMs = Date.parse(validUntil!);
  const observed = now();
  if (!Number.isFinite(validFromMs) || !Number.isFinite(validUntilMs) || validFromMs >= validUntilMs ||
      !Number.isFinite(observed) || observed < validFromMs || observed >= validUntilMs) {
    throw new Error("delegated_pr_cleanup_runtime_key_invalid");
  }
  try {
    const privateKey = createPrivateKey({ key: Buffer.from(privateDer!, "base64"), format: "der", type: "pkcs8" });
    const publicKey = createPublicKey({ key: Buffer.from(publicDer!, "base64"), format: "der", type: "spki" });
    const derived = Buffer.from(createPublicKey(privateKey).export({ format: "der", type: "spki" }));
    const configured = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
    if (derived.length !== configured.length || !timingSafeEqual(derived, configured)) {
      throw new Error("delegated_pr_cleanup_runtime_key_invalid");
    }
    return Object.freeze({
      actorPrincipalId: actorPrincipalId!,
      signer: Object.freeze({ keyId: keyId!, algorithm: "ed25519" as const,
        sign: (bytes: Uint8Array) => {
          const signingAt = now();
          if (!Number.isFinite(signingAt) || signingAt < validFromMs || signingAt >= validUntilMs) {
            throw new Error("delegated_pr_cleanup_runtime_key_invalid");
          }
          return new Uint8Array(ed25519Sign(null, bytes, privateKey));
        } }),
      producerVersion: producerVersion!,
      allowedTenantIds: Object.freeze([...allowedTenantIds].sort()),
      keyValidFrom: validFrom!,
      keyValidUntil: validUntil!,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "delegated_pr_cleanup_runtime_key_invalid") throw error;
    throw new Error("delegated_pr_cleanup_runtime_key_invalid");
  }
}
