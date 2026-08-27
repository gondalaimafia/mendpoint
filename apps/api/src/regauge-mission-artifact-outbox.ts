import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  getPrincipalBySubject,
  resolveMissionForRegaugeCampaign,
  type AppDb,
} from "@mendpoint/db";
import {
  createTransformerMissionEvidenceArtifact,
  openTransformerMissionEvidenceArtifact,
  type TransformerMissionArtifactAdoptionCandidate,
  type TransformerMissionArtifactRegistration,
  type TransformerMissionArtifactRegistrationBinding,
  type TransformerPilotExecutionStore,
} from "@mendpoint/transformer";
import {
  registerRegaugeMissionArtifactOutbox,
} from "@mendpoint/worker/transformer-pilot-lane";
import type {
  TransformerCheckpointArtifactBackend,
} from "@mendpoint/worker/transformer-checkpoint-artifacts";
import {
  createS3CompatibleTransformerArtifactBackend,
} from "@mendpoint/worker/transformer-shared-artifact-backends";
import { createSigV4S3ArtifactTransport } from "@mendpoint/worker/transformer-s3-transport";
import { resolveTransformerS3Config } from "@mendpoint/worker/transformer-production-profile";
import { REGAUGE_MISSION_EVIDENCE_MAX_BYTES, resolveRenamedEnv } from "@mendpoint/shared";

const BOOTSTRAP_PRINCIPAL_SUBJECT = "service:regauge-production-bootstrap";

export type RegaugeMissionArtifactRuntime = Readonly<{
  backend: TransformerCheckpointArtifactBackend;
  encryptionKey: Uint8Array;
  legacyDataRoot: string;
}>;

export function createRegaugeMissionArtifactRuntime(
  env: NodeJS.ProcessEnv,
): RegaugeMissionArtifactRuntime {
  if (resolveRenamedEnv(env, "MENDPOINT_REGAUGE_ARTIFACT_BACKEND") !== "s3") {
    throw new Error("regauge_mission_artifact_s3_required");
  }
  const key = decodeKey(required(
    resolveRenamedEnv(env, "MENDPOINT_REGAUGE_CHECKPOINT_KEY"),
    "regauge_mission_artifact_checkpoint_key_required",
  ));
  const s3 = resolveTransformerS3Config(env);
  return Object.freeze({
    encryptionKey: key,
    legacyDataRoot: absoluteDirectory(
      required(env.MENDPOINT_DATA_DIR, "regauge_mission_artifact_data_root_required"),
    ),
    backend: createS3CompatibleTransformerArtifactBackend({
      bucket: required(s3.bucket, "regauge_mission_artifact_s3_bucket_required"),
      keyPrefix: required(
        resolveRenamedEnv(env, "MENDPOINT_REGAUGE_S3_PREFIX"),
        "regauge_mission_artifact_s3_prefix_required",
      ),
      maxStoredBytes: REGAUGE_MISSION_EVIDENCE_MAX_BYTES,
    }, createSigV4S3ArtifactTransport({
      endpoint: required(s3.endpoint, "regauge_mission_artifact_s3_endpoint_required"),
      region: required(s3.region, "regauge_mission_artifact_s3_region_required"),
      accessKeyId: required(s3.accessKeyId, "regauge_mission_artifact_s3_access_key_required"),
      secretAccessKey: required(s3.secretAccessKey, "regauge_mission_artifact_s3_secret_required"),
      ...(s3.sessionToken?.trim() ? { sessionToken: s3.sessionToken.trim() } : {}),
      timeoutMs: 30_000,
    })),
  });
}

export async function drainRegaugeMissionArtifactOutbox(input: Readonly<{
  db: AppDb;
  store: TransformerPilotExecutionStore;
  tenantId: string;
  runtime: RegaugeMissionArtifactRuntime;
  limit?: number;
}>): Promise<Readonly<{ registered: number; skipped: number }>> {
  const principal = getPrincipalBySubject(
    input.db,
    input.tenantId,
    "service",
    BOOTSTRAP_PRINCIPAL_SUBJECT,
  );
  if (!principal || principal.kind !== "service" || principal.tenant_id !== input.tenantId) {
    throw new Error("regauge_service_principal_tenant_invalid");
  }
  let registered = 0;
  let skipped = await adoptLegacyMissionArtifactRegistrations(input);
  for (const registration of input.store.listPendingMissionArtifactRegistrations(
    input.tenantId,
    input.limit ?? 25,
  )) {
    if (!resolveMissionForRegaugeCampaign(
      input.db,
      registration.tenantId,
      registration.campaignId,
    )) {
      input.store.completeMissionArtifactRegistration(registration);
      skipped += 1;
      continue;
    }
    await markRegistrationReferenced(registration, input.runtime);
    const content = await readRegistrationContent(
      registration,
      input.runtime,
    );
    const result = registerRegaugeMissionArtifactOutbox(
      input.db,
      registration,
      principal.id,
      content,
    );
    input.store.completeMissionArtifactRegistration(registration);
    if (result.status === "registered") registered += 1;
    else skipped += 1;
  }
  return Object.freeze({ registered, skipped });
}

async function adoptLegacyMissionArtifactRegistrations(input: Readonly<{
  db: AppDb;
  store: TransformerPilotExecutionStore;
  tenantId: string;
  runtime: RegaugeMissionArtifactRuntime;
  limit?: number;
}>): Promise<number> {
  let skipped = 0;
  for (const candidate of input.store.listMissionArtifactAdoptionCandidates(
    input.tenantId,
    input.limit ?? 25,
  )) {
    if (!resolveMissionForRegaugeCampaign(
      input.db,
      candidate.tenantId,
      candidate.campaignId,
    )) {
      input.store.completeMissionArtifactAdoption(candidate);
      skipped += 1;
      continue;
    }
    const registration = await publishLegacyRegistration(candidate, input.runtime);
    input.store.adoptMissionArtifactRegistration({ candidate, registration });
    await markRegistrationReferenced(registration, input.runtime);
  }
  return skipped;
}

async function markRegistrationReferenced(
  registration: TransformerMissionArtifactRegistrationBinding,
  runtime: RegaugeMissionArtifactRuntime,
): Promise<void> {
  if (registration.schemaVersion !== 2) {
    throw new Error("regauge_mission_artifact_legacy_adoption_required");
  }
  await Promise.all([
    runtime.backend.mark(registration.candidateManifestArtifact.storageKey, "referenced"),
    runtime.backend.mark(registration.executionEvidenceArtifact.storageKey, "referenced"),
  ]);
}

async function publishLegacyRegistration(
  candidate: TransformerMissionArtifactAdoptionCandidate,
  runtime: RegaugeMissionArtifactRuntime,
): Promise<Extract<TransformerMissionArtifactRegistrationBinding, { schemaVersion: 2 }>> {
  const scopePath = [
    segment("tenant", candidate.tenantId),
    segment("campaign", candidate.campaignId),
    segment("unit", candidate.unitId),
    segment("attempt", candidate.attemptId),
  ];
  const candidatePath = safeFile(join(
    runtime.legacyDataRoot,
    "transformer-candidates",
    ...scopePath,
    "manifest.json",
  ), runtime.legacyDataRoot);
  const executionPath = safeFile(join(
    runtime.legacyDataRoot,
    "transformer-evidence",
    ...scopePath,
    `${candidate.executionArtifactId}.json`,
  ), runtime.legacyDataRoot);
  const candidateBytes = readLegacyEvidence(candidatePath);
  const executionBytes = readLegacyEvidence(executionPath);
  const candidateDigest = sha256(candidateBytes);
  const executionDigest = sha256(executionBytes);
  let candidateRecord: Record<string, unknown>;
  let executionRecord: Record<string, unknown>;
  try {
    candidateRecord = JSON.parse(Buffer.from(candidateBytes).toString("utf8")) as Record<string, unknown>;
    executionRecord = JSON.parse(Buffer.from(executionBytes).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("regauge_mission_artifact_legacy_evidence_invalid");
  }
  const scope = candidateRecord.scope as Record<string, unknown> | undefined;
  const source = candidateRecord.source as Record<string, unknown> | undefined;
  const executionEvidence = candidateRecord.executionEvidence as Record<string, unknown> | undefined;
  const fence = executionRecord.fence as Record<string, unknown> | undefined;
  if (!scope || !source || !executionEvidence || !fence ||
      candidateRecord.schemaVersion !== 1 || candidateRecord.kind !== "transformer.candidate" ||
      scope?.tenantId !== candidate.tenantId || scope.campaignId !== candidate.campaignId ||
      scope.unitId !== candidate.unitId || scope.attemptId !== candidate.attemptId ||
      source?.snapshotId !== candidate.sourceSnapshotId ||
      candidate.candidateArtifactId !== `tcman_${candidateDigest.slice("sha256:".length)}` ||
      executionEvidence?.id !== candidate.executionArtifactId ||
      executionEvidence.digest !== executionDigest ||
      executionRecord.kind !== "transformer.recipe.execution" ||
      executionRecord.evidenceId !== candidate.executionArtifactId ||
      fence?.tenantId !== candidate.tenantId || fence.campaignId !== candidate.campaignId ||
      fence.unitId !== candidate.unitId || fence.attemptId !== candidate.attemptId ||
      !Number.isSafeInteger(executionRecord.schemaVersion) || Number(executionRecord.schemaVersion) < 1) {
    throw new Error("regauge_mission_artifact_legacy_evidence_invalid");
  }
  const candidateArtifact = createTransformerMissionEvidenceArtifact({
    tenantId: candidate.tenantId,
    episodeId: candidate.episodeId,
    artifactId: candidate.candidateArtifactId,
  }, candidateBytes, runtime.encryptionKey);
  const executionArtifact = createTransformerMissionEvidenceArtifact({
    tenantId: candidate.tenantId,
    episodeId: candidate.episodeId,
    artifactId: candidate.executionArtifactId,
  }, executionBytes, runtime.encryptionKey);
  for (const artifact of [candidateArtifact, executionArtifact]) {
    await runtime.backend.mark(artifact.artifact.storageKey, "pending");
    const created = await runtime.backend.createOnly(artifact.artifact.storageKey, artifact.bytes);
    const readback = await runtime.backend.read(artifact.artifact.storageKey);
    if ((created !== "created" && created !== "exists") || readback === null ||
        sha256(readback) !== artifact.artifact.ciphertextDigest) {
      throw new Error("regauge_mission_artifact_shared_publish_invalid");
    }
  }
  return Object.freeze({
    schemaVersion: 2,
    episodeId: candidate.episodeId,
    attemptId: candidate.attemptId,
    sourceSnapshotId: candidate.sourceSnapshotId,
    candidateArtifactId: candidate.candidateArtifactId,
    candidateManifestDigest: candidateDigest,
    candidateManifestArtifact: candidateArtifact.artifact,
    executionArtifactId: candidate.executionArtifactId,
    executionEvidenceDigest: executionDigest,
    executionEvidenceArtifact: executionArtifact.artifact,
    executionSchemaVersion: Number(executionRecord.schemaVersion),
  });
}

async function readRegistrationContent(
  registration: TransformerMissionArtifactRegistration,
  runtime: RegaugeMissionArtifactRuntime,
): Promise<Readonly<{ candidateContent: string; executionContent: string }>> {
  if (registration.schemaVersion !== 2) {
    throw new Error("regauge_mission_artifact_legacy_adoption_required");
  }
  const [candidateBytes, executionBytes] = await Promise.all([
    runtime.backend.read(registration.candidateManifestArtifact.storageKey),
    runtime.backend.read(registration.executionEvidenceArtifact.storageKey),
  ]);
  if (candidateBytes === null || executionBytes === null) {
    throw new Error("regauge_mission_artifact_shared_evidence_missing");
  }
  const candidate = openTransformerMissionEvidenceArtifact(
    registration.candidateManifestArtifact,
    candidateBytes,
    runtime.encryptionKey,
    {
      tenantId: registration.tenantId,
      episodeId: registration.episodeId,
      artifactId: registration.candidateArtifactId,
    },
  );
  const execution = openTransformerMissionEvidenceArtifact(
    registration.executionEvidenceArtifact,
    executionBytes,
    runtime.encryptionKey,
    {
      tenantId: registration.tenantId,
      episodeId: registration.episodeId,
      artifactId: registration.executionArtifactId,
    },
  );
  return Object.freeze({
    candidateContent: Buffer.from(candidate).toString("utf8"),
    executionContent: Buffer.from(execution).toString("utf8"),
  });
}

function required(value: string | undefined, code: string): string {
  if (!value?.trim()) throw new Error(code);
  return value.trim();
}

function decodeKey(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== 32 || bytes.toString("base64") !== value) {
    throw new Error("regauge_mission_artifact_checkpoint_key_invalid");
  }
  return new Uint8Array(bytes);
}

function segment(label: string, value: string): string {
  return `${label}-${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32)}`;
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function absoluteDirectory(value: string): string {
  if (!isAbsolute(value)) throw new Error("regauge_mission_artifact_data_root_invalid");
  const path = realpathSync(resolve(value));
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("regauge_mission_artifact_data_root_invalid");
  }
  return path;
}

function safeFile(value: string, root: string): string {
  const requestedPath = resolve(value);
  const requestedStat = lstatSync(requestedPath);
  validateLegacyEvidenceStat(requestedStat);
  const path = realpathSync(requestedPath);
  const normalizedRoot = `${resolve(root).replaceAll("\\", "/")}/`;
  if (!path.replaceAll("\\", "/").startsWith(normalizedRoot)) {
    throw new Error("regauge_mission_artifact_legacy_path_invalid");
  }
  const stat = lstatSync(path);
  validateLegacyEvidenceStat(stat);
  if (requestedStat.dev !== stat.dev || requestedStat.ino !== stat.ino) {
    throw new Error("regauge_mission_artifact_legacy_path_invalid");
  }
  return path;
}

function readLegacyEvidence(path: string): Uint8Array {
  const before = lstatSync(path);
  validateLegacyEvidenceStat(before);
  const bytes = new Uint8Array(readFileSync(path));
  const after = lstatSync(path);
  validateLegacyEvidenceStat(after);
  if (before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || bytes.byteLength !== after.size) {
    throw new Error("regauge_mission_artifact_legacy_evidence_changed");
  }
  return bytes;
}

function validateLegacyEvidenceStat(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("regauge_mission_artifact_legacy_path_invalid");
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 1 ||
      stat.size > REGAUGE_MISSION_EVIDENCE_MAX_BYTES) {
    throw new Error("regauge_mission_artifact_legacy_size_invalid");
  }
}
