import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { REGAUGE_MISSION_EVIDENCE_MAX_BYTES } from "@mendpoint/shared";
import {
  createTransformerAttemptCompletionDigest,
  createTransformerAttemptCompletionPayload,
  openTransformerAttemptCompletionPayload,
  type TransformerAttemptCompletionIntent,
} from "./attempt-completion.js";

const PROTOCOL = "mendpoint.transformer.attempt-checkpoint.v1";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const STORAGE_KEY = /^(?![A-Za-z]:)(?![\/])(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,1000}$/;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_ENCODED_BYTES = Math.ceil(MAX_STATE_BYTES / 3) * 4 + 16;
const MAX_WORKSPACE_ARCHIVE_BYTES = 72 * 1024 * 1024;
const MAX_EFFECT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const STAGES = [
  "source_loaded",
  "recipe_applied",
  "verification",
  "adaptive",
  "candidate_sealed",
  "completion_prepared",
  "terminal",
] as const;
const EFFECT_KINDS = [
  "model", "verifier", "workspace_publish", "candidate_publish", "coordinator_complete",
] as const;
const COORDINATOR_COMPLETION_SLOT = /^coordinator:completion:([a-f0-9]{64})$/;

export type TransformerAttemptCheckpointStage = typeof STAGES[number];
export type TransformerAttemptCheckpointEffectKind = typeof EFFECT_KINDS[number];

export type TransformerAttemptCheckpointBinding = Readonly<{
  schemaVersion: 1;
  tenantId: string;
  environment: string;
  campaignId: string;
  unitId: string;
  repositoryId: string;
  snapshotId: string;
  sourceRevision: string;
  sourceManifestDigest: string;
  candidateRevision: string;
  candidateDigest: string;
  candidateManifestDigest: string;
  recipeDigest: string;
  constraintDigest: string;
  executorDigest: string;
  verificationPlanDigest: string;
  requiredVerificationCount: number;
}>;

export type TransformerAttemptCheckpointLease = Readonly<{
  attemptNumber: number;
  generation: number;
  tokenDigest: string;
}>;

export type TransformerWorkspaceManifestEntry = Readonly<{
  path: string;
  digest: string;
  bytes: number;
  mode: "file" | "executable";
}>;

export type TransformerEncryptedArtifact = Readonly<{
  schemaVersion: 1;
  storageKey: string;
  ciphertextDigest: string;
  payloadDigest: string;
  bytes: number;
  keyId: string;
  nonceBase64: string;
  authenticationTagBase64: string;
  codec: "aes-256-gcm-v1";
}>;

export type TransformerMissionArtifactRegistrationBinding =
  | Readonly<{
      schemaVersion: 1;
      attemptId: string;
      sourceSnapshotId: string;
      candidateArtifactId: string;
      candidateManifestDigest: string;
      candidateManifestPath: string;
      executionArtifactId: string;
      executionEvidenceDigest: string;
      executionEvidencePath: string;
      executionSchemaVersion: number;
    }>
  | Readonly<{
      schemaVersion: 2;
      episodeId: string;
      attemptId: string;
      sourceSnapshotId: string;
      candidateArtifactId: string;
      candidateManifestDigest: string;
      candidateManifestArtifact: TransformerEncryptedArtifact;
      executionArtifactId: string;
      executionEvidenceDigest: string;
      executionEvidenceArtifact: TransformerEncryptedArtifact;
      executionSchemaVersion: number;
    }>;

export type TransformerWorkspaceArtifact = TransformerEncryptedArtifact & Readonly<{
  kind: "content_addressed_archive";
  manifestDigest: string;
  filesDigest: string;
}>;

export type TransformerWorkspaceArtifactFile = Readonly<{
  path: string;
  content: Uint8Array;
  mode: "file" | "executable";
}>;

export type TransformerCandidateSeal = Readonly<{
  schemaVersion: 1;
  candidateRevision: string;
  candidateDigest: string;
  workspaceManifestDigest: string;
  workspacePayloadDigest: string;
  sealDigest: string;
}>;

export type TransformerModelEffectResult = Readonly<{
  schemaVersion: 1;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  wallTimeMs: number;
  responseDigest: string;
  responseBase64: string;
}>;

export type TransformerVerifierEffectResult = Readonly<{
  schemaVersion: 1;
  status: "passed" | "failed";
  outputDigest: string;
  outputBase64: string;
}>;

export type TransformerCoordinatorEffectResult = Readonly<{
  schemaVersion: 1;
  status: "accepted" | "rejected";
  completionDigest: string;
}>;

export type TransformerCoordinatorCompletionRequest = Readonly<{
  episodeId: string;
  seal: TransformerCandidateSeal;
  completionDigest: string;
  completionIntent: TransformerAttemptCompletionIntent;
  artifactRegistration?: TransformerMissionArtifactRegistrationBinding;
}>;

type EffectCommon = Readonly<{
  kind: TransformerAttemptCheckpointEffectKind;
  effectId: string;
  slot: string;
  idempotencyKey: string;
  requestDigest: string;
  requestArtifact: TransformerEncryptedArtifact;
}>;

export type TransformerAttemptCheckpointEffect =
  | Readonly<{ kind: "none" }>
  | (EffectCommon & Readonly<{ state: "prepared" | "dispatched" }>)
  | (EffectCommon & Readonly<{
    state: "completed";
    resultArtifact: TransformerEncryptedArtifact | TransformerWorkspaceArtifact;
  }>);

export type TransformerAttemptCheckpointEffectReceipt = EffectCommon & Readonly<{
  resultArtifact: TransformerEncryptedArtifact | TransformerWorkspaceArtifact;
}>;

export type TransformerAttemptCheckpointState = Readonly<{
  schemaVersion: 1;
  episodeId: string;
  binding: TransformerAttemptCheckpointBinding;
  generation: number;
  attemptNumber: number;
  writerLeaseGeneration: number;
  writerLeaseTokenDigest: string;
  stage: TransformerAttemptCheckpointStage;
  commandCursor: number;
  verificationPlan: readonly Readonly<{
    index: number;
    commandId: string;
    commandDigest: string;
  }>[];
  workspaceManifest: readonly TransformerWorkspaceManifestEntry[];
  workspaceArtifact: TransformerWorkspaceArtifact;
  verificationReceipts: readonly Readonly<{
    sequence: number;
    round: number;
    index: number;
    commandId: string;
    commandDigest: string;
    workspaceManifestDigest: string;
    status: "passed" | "failed";
    outputDigest: string;
  }>[];
  accounting: Readonly<{
    plannerCalls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
    wallTimeMs: number;
  }>;
  completedEffects: readonly TransformerAttemptCheckpointEffectReceipt[];
  pendingEffect: TransformerAttemptCheckpointEffect;
  candidateSeal: TransformerCandidateSeal | null;
  previousCheckpointDigest: string | null;
  createdAt: string;
}>;

export type TransformerAttemptCheckpointEnvelope = Readonly<{
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  keyId: string;
  episodeId: string;
  generation: number;
  writerLeaseGeneration: number;
  writerLeaseTokenDigest: string;
  stateDigest: string;
  nonceBase64: string;
  ciphertextBase64: string;
  authenticationTagBase64: string;
}>;

export type TransformerAttemptCheckpointJournal = Readonly<{
  read(episodeId: string): Promise<TransformerAttemptCheckpointEnvelope | null>;
  readLease(episodeId: string): Promise<TransformerAttemptCheckpointLease | null>;
  readArtifact(storageKey: string): Promise<Uint8Array | null>;
  compareAndSwap(input: Readonly<{
    episodeId: string;
    expectedStateDigest: string | null;
    activeLease: TransformerAttemptCheckpointLease;
    next: TransformerAttemptCheckpointEnvelope;
  }>): Promise<boolean>;
}>;

export type TransformerPreparedAttemptCheckpointAdvance =
  | Readonly<{
    kind: "replay";
    envelope: TransformerAttemptCheckpointEnvelope;
  }>
  | Readonly<{
    kind: "advance";
    operation: Readonly<{
      episodeId: string;
      expectedStateDigest: string;
      activeLease: TransformerAttemptCheckpointLease;
      next: TransformerAttemptCheckpointEnvelope;
    }>;
  }>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((entry) =>
    `${JSON.stringify(entry)}:${canonical(record[entry])}`
  ).join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exactKeys(value: object, expected: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) {
    throw new Error(code);
  }
}

function natural(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
}

function positive(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
}

function requireDigest(value: string, code: string): void {
  if (!DIGEST.test(value)) throw new Error(code);
}

function requireKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new Error("transformer_attempt_checkpoint_key_invalid");
  }
  return Buffer.from(key);
}

function keyId(key: Uint8Array): string {
  return sha256(Buffer.concat([Buffer.from(`${PROTOCOL}:key-id`, "utf8"), requireKey(key)])).slice(7, 23);
}

function validPath(path: string): boolean {
  const parts = typeof path === "string" ? path.split("/") : [];
  if (typeof path !== "string" || path.length < 1 || path.length > 1000 ||
      path !== path.normalize("NFC") || path.includes("\\") || path.includes(":") ||
      path.includes("//") ||
      path.includes("/./") || path.startsWith("./") || path.endsWith("/") ||
      /[\u0000-\u001f\u007f<>"|?*]/.test(path) || /^[A-Za-z]:/.test(path) || path.startsWith("/") ||
      parts.some((part) => part.length > 255 || part === ".." || part.endsWith(".") ||
        part.endsWith(" ") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
        /^(?:conin\$|conout\$)(?:\.|$)/i.test(part))) {
    return false;
  }
  return true;
}

function validateBinding(binding: TransformerAttemptCheckpointBinding): void {
  exactKeys(binding, [
    "schemaVersion", "tenantId", "environment", "campaignId", "unitId", "repositoryId",
    "snapshotId", "sourceRevision", "sourceManifestDigest", "candidateRevision",
    "candidateDigest", "candidateManifestDigest", "recipeDigest", "constraintDigest", "executorDigest",
    "verificationPlanDigest", "requiredVerificationCount",
  ], "transformer_attempt_checkpoint_binding_invalid");
  if (binding.schemaVersion !== 1 ||
      ![binding.tenantId, binding.environment, binding.campaignId, binding.unitId,
        binding.repositoryId, binding.snapshotId].every((value) => ID.test(value)) ||
      !/^[a-f0-9]{40}$/.test(binding.sourceRevision) ||
      !/^[a-f0-9]{40}$/.test(binding.candidateRevision)) {
    throw new Error("transformer_attempt_checkpoint_binding_invalid");
  }
  for (const value of [binding.sourceManifestDigest, binding.candidateDigest,
    binding.candidateManifestDigest,
    binding.recipeDigest, binding.constraintDigest, binding.executorDigest,
    binding.verificationPlanDigest]) {
    requireDigest(value, "transformer_attempt_checkpoint_binding_invalid");
  }
  positive(binding.requiredVerificationCount, "transformer_attempt_checkpoint_binding_invalid");
}

function validateLease(lease: TransformerAttemptCheckpointLease): void {
  exactKeys(lease, ["attemptNumber", "generation", "tokenDigest"],
    "transformer_attempt_checkpoint_lease_invalid");
  positive(lease.attemptNumber, "transformer_attempt_checkpoint_lease_invalid");
  positive(lease.generation, "transformer_attempt_checkpoint_lease_invalid");
  requireDigest(lease.tokenDigest, "transformer_attempt_checkpoint_lease_invalid");
}

export function createTransformerEpisodeId(binding: TransformerAttemptCheckpointBinding): string {
  validateBinding(binding);
  return `tfepisode_${sha256(canonical(binding)).slice(7, 39)}`;
}

export function createTransformerAttemptEffectIdentity(
  episodeId: string,
  kind: TransformerAttemptCheckpointEffectKind,
  slot: string,
  requestDigest: string,
): Readonly<{ effectId: string; idempotencyKey: string }> {
  if (!ID.test(episodeId) || !EFFECT_KINDS.includes(kind) || !ID.test(slot)) {
    throw new Error("transformer_attempt_checkpoint_effect_invalid");
  }
  requireDigest(requestDigest, "transformer_attempt_checkpoint_effect_invalid");
  const effectId = `tfeffect_${sha256(canonical({
    protocol: `${PROTOCOL}:effect-id`, episodeId, kind, slot, requestDigest,
  })).slice(7, 39)}`;
  return {
    effectId,
    idempotencyKey: `tfidem_${sha256(canonical({
      protocol: `${PROTOCOL}:idempotency`, episodeId, effectId,
    })).slice(7, 39)}`,
  };
}

function normalizedManifest(manifest: readonly TransformerWorkspaceManifestEntry[]):
readonly TransformerWorkspaceManifestEntry[] {
  return [...manifest].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function createTransformerWorkspaceManifestDigest(
  manifest: readonly TransformerWorkspaceManifestEntry[],
): string {
  return sha256(canonical(normalizedManifest(manifest)));
}

export function createTransformerWorkspaceManifest(
  files: readonly TransformerWorkspaceArtifactFile[],
): readonly TransformerWorkspaceManifestEntry[] {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_ENTRIES) {
    throw new Error("transformer_attempt_checkpoint_workspace_artifact_invalid");
  }
  const seen = new Set<string>();
  const manifest = files.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file) ||
        !validPath(file.path) || !(file.content instanceof Uint8Array) ||
        (file.mode !== "file" && file.mode !== "executable") ||
        seen.has(file.path.toLowerCase())) {
      throw new Error("transformer_attempt_checkpoint_workspace_artifact_invalid");
    }
    seen.add(file.path.toLowerCase());
    return Object.freeze({
      path: file.path,
      digest: sha256(file.content),
      bytes: file.content.byteLength,
      mode: file.mode,
    });
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return Object.freeze(manifest);
}

export function createTransformerVerificationPlanDigest(
  plan: readonly Readonly<{ index: number; commandId: string; commandDigest: string }>[],
): string {
  return sha256(canonical(plan));
}

function validateEncryptedArtifact(artifact: TransformerEncryptedArtifact, code: string): void {
  exactKeys(artifact, [
    "schemaVersion", "storageKey", "ciphertextDigest", "payloadDigest", "bytes", "keyId",
    "nonceBase64", "authenticationTagBase64", "codec",
  ], code);
  if (artifact.schemaVersion !== 1 || artifact.codec !== "aes-256-gcm-v1" ||
      !STORAGE_KEY.test(artifact.storageKey) || !validPath(artifact.storageKey) ||
      !/^[a-f0-9]{16}$/.test(artifact.keyId) ||
      !artifact.storageKey.endsWith(`/${artifact.ciphertextDigest.slice(7)}.bin`)) {
    throw new Error(code);
  }
  requireDigest(artifact.ciphertextDigest, code);
  requireDigest(artifact.payloadDigest, code);
  positive(artifact.bytes, code);
  const nonce = Buffer.from(artifact.nonceBase64, "base64");
  const tag = Buffer.from(artifact.authenticationTagBase64, "base64");
  if (nonce.byteLength !== 12 || tag.byteLength !== 16 ||
      nonce.toString("base64") !== artifact.nonceBase64 ||
      tag.toString("base64") !== artifact.authenticationTagBase64) {
    throw new Error(code);
  }
}

export function requireTransformerMissionArtifactRegistrationBinding(
  value: TransformerMissionArtifactRegistrationBinding,
): TransformerMissionArtifactRegistrationBinding {
  const code = "transformer_mission_artifact_registration_invalid";
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const common = value as TransformerMissionArtifactRegistrationBinding;
  const commonKeys = [
    "schemaVersion", "attemptId", "sourceSnapshotId", "candidateArtifactId",
    "candidateManifestDigest", "executionArtifactId", "executionEvidenceDigest",
    "executionSchemaVersion",
  ];
  if (common.schemaVersion === 1) {
    exactKeys(common, [...commonKeys, "candidateManifestPath", "executionEvidencePath"], code);
    if (!validPath(common.candidateManifestPath) || !validPath(common.executionEvidencePath)) {
      throw new Error(code);
    }
  } else if (common.schemaVersion === 2) {
    exactKeys(common, [...commonKeys, "episodeId", "candidateManifestArtifact", "executionEvidenceArtifact"], code);
    validateEncryptedArtifact(common.candidateManifestArtifact, code);
    validateEncryptedArtifact(common.executionEvidenceArtifact, code);
    if (common.candidateManifestArtifact.payloadDigest !== common.candidateManifestDigest ||
        common.executionEvidenceArtifact.payloadDigest !== common.executionEvidenceDigest) {
      throw new Error(code);
    }
  } else {
    throw new Error(code);
  }
  if (!ID.test(common.attemptId) || !ID.test(common.sourceSnapshotId) ||
      (common.schemaVersion === 2 && !ID.test(common.episodeId)) ||
      !/^tcman_[a-f0-9]{64}$/.test(common.candidateArtifactId) ||
      !/^tre_execution_[a-f0-9]{64}$/.test(common.executionArtifactId) ||
      !DIGEST.test(common.candidateManifestDigest) || !DIGEST.test(common.executionEvidenceDigest) ||
      !Number.isSafeInteger(common.executionSchemaVersion) || common.executionSchemaVersion < 1) {
    throw new Error(code);
  }
  return Object.freeze({ ...common });
}

export function createTransformerMissionArtifactRegistrationPayload(
  value: TransformerMissionArtifactRegistrationBinding,
): Uint8Array {
  return Buffer.from(canonical(requireTransformerMissionArtifactRegistrationBinding(value)), "utf8");
}

export function openTransformerMissionArtifactRegistrationPayload(
  value: Uint8Array,
): TransformerMissionArtifactRegistrationBinding {
  try {
    const source = Buffer.from(value);
    const parsed = requireTransformerMissionArtifactRegistrationBinding(
      JSON.parse(source.toString("utf8")) as TransformerMissionArtifactRegistrationBinding,
    );
    if (canonical(parsed) !== source.toString("utf8")) throw new Error("noncanonical");
    return parsed;
  } catch {
    throw new Error("transformer_mission_artifact_registration_invalid");
  }
}

function validateWorkspaceArtifact(artifact: TransformerWorkspaceArtifact): void {
  exactKeys(artifact, [
    "schemaVersion", "kind", "storageKey", "ciphertextDigest", "payloadDigest",
    "manifestDigest", "filesDigest", "bytes", "keyId", "nonceBase64", "authenticationTagBase64",
    "codec",
  ], "transformer_attempt_checkpoint_workspace_artifact_invalid");
  if (artifact.kind !== "content_addressed_archive") {
    throw new Error("transformer_attempt_checkpoint_workspace_artifact_invalid");
  }
  requireDigest(artifact.manifestDigest, "transformer_attempt_checkpoint_workspace_artifact_invalid");
  requireDigest(artifact.filesDigest, "transformer_attempt_checkpoint_workspace_artifact_invalid");
  const { kind: _kind, manifestDigest: _manifestDigest, filesDigest: _filesDigest, ...base } = artifact;
  validateEncryptedArtifact(base, "transformer_attempt_checkpoint_workspace_artifact_invalid");
}

function artifactAad(input: Readonly<{
  purpose: "workspace" | "effect-request" | "effect-result" | "mission-evidence";
  tenantId: string;
  episodeId: string;
  keyId: string;
  payloadDigest: string;
  manifestDigest?: string;
  filesDigest?: string;
  effectId?: string;
  artifactId?: string;
}>): Buffer {
  return Buffer.from(canonical({ protocol: `${PROTOCOL}:artifact`, ...input }), "utf8");
}

export function createTransformerMissionEvidenceArtifact(
  scope: Readonly<{ tenantId: string; episodeId: string; artifactId: string }>,
  payload: Uint8Array,
  key: Uint8Array,
): Readonly<{ artifact: TransformerEncryptedArtifact; bytes: Uint8Array }> {
  if (!ID.test(scope.tenantId) || !ID.test(scope.episodeId) || !ID.test(scope.artifactId) ||
      !(payload instanceof Uint8Array) || payload.byteLength < 1 ||
      payload.byteLength > REGAUGE_MISSION_EVIDENCE_MAX_BYTES) {
    throw new Error("transformer_mission_evidence_artifact_invalid");
  }
  return encryptArtifact(
    `tenants/${scope.tenantId}/episodes/${scope.episodeId}/mission-evidence/${scope.artifactId}`,
    payload,
    key,
    { purpose: "mission-evidence", ...scope },
  );
}

export function openTransformerMissionEvidenceArtifact(
  artifact: TransformerEncryptedArtifact,
  bytes: Uint8Array,
  key: Uint8Array,
  scope: Readonly<{ tenantId: string; episodeId: string; artifactId: string }>,
): Uint8Array {
  if (!ID.test(scope.tenantId) || !ID.test(scope.episodeId) || !ID.test(scope.artifactId)) {
    throw new Error("transformer_mission_evidence_artifact_invalid");
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 ||
      bytes.byteLength > REGAUGE_MISSION_EVIDENCE_MAX_BYTES ||
      artifact.bytes > REGAUGE_MISSION_EVIDENCE_MAX_BYTES) {
    throw new Error("transformer_mission_evidence_artifact_invalid");
  }
  return decryptArtifact(artifact, bytes, key, { purpose: "mission-evidence", ...scope });
}

function encryptArtifact(
  prefix: string,
  payload: Uint8Array,
  key: Uint8Array,
  aadInput: Omit<Parameters<typeof artifactAad>[0], "keyId" | "payloadDigest">,
): Readonly<{ artifact: TransformerEncryptedArtifact; bytes: Uint8Array }> {
  const payloadDigest = sha256(payload);
  const id = keyId(key);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", requireKey(key), nonce);
  cipher.setAAD(artifactAad({ ...aadInput, keyId: id, payloadDigest }));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const ciphertextDigest = sha256(ciphertext);
  const artifact: TransformerEncryptedArtifact = {
    schemaVersion: 1,
    storageKey: `${prefix}/${ciphertextDigest.slice(7)}.bin`,
    ciphertextDigest,
    payloadDigest,
    bytes: ciphertext.byteLength,
    keyId: id,
    nonceBase64: nonce.toString("base64"),
    authenticationTagBase64: cipher.getAuthTag().toString("base64"),
    codec: "aes-256-gcm-v1",
  };
  validateEncryptedArtifact(artifact, "transformer_attempt_checkpoint_artifact_invalid");
  return { artifact, bytes: ciphertext };
}

function decryptArtifact(
  artifact: TransformerEncryptedArtifact,
  bytes: Uint8Array,
  key: Uint8Array,
  aadInput: Omit<Parameters<typeof artifactAad>[0], "keyId" | "payloadDigest">,
): Buffer {
  validateEncryptedArtifact(artifact, "transformer_attempt_checkpoint_artifact_invalid");
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== artifact.bytes ||
      sha256(bytes) !== artifact.ciphertextDigest || artifact.keyId !== keyId(key)) {
    throw new Error("transformer_attempt_checkpoint_artifact_mismatch");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      requireKey(key),
      Buffer.from(artifact.nonceBase64, "base64"),
    );
    decipher.setAAD(artifactAad({
      ...aadInput,
      keyId: artifact.keyId,
      payloadDigest: artifact.payloadDigest,
    }));
    decipher.setAuthTag(Buffer.from(artifact.authenticationTagBase64, "base64"));
    const payload = Buffer.concat([decipher.update(bytes), decipher.final()]);
    if (sha256(payload) !== artifact.payloadDigest) {
      throw new Error("transformer_attempt_checkpoint_artifact_mismatch");
    }
    return payload;
  } catch {
    throw new Error("transformer_attempt_checkpoint_artifact_authentication_failed");
  }
}

export function createTransformerWorkspaceArtifact(
  scope: Readonly<{ tenantId: string; episodeId: string }>,
  files: readonly TransformerWorkspaceArtifactFile[],
  key: Uint8Array,
): Readonly<{
  artifact: TransformerWorkspaceArtifact;
  bytes: Uint8Array;
  manifest: readonly TransformerWorkspaceManifestEntry[];
}> {
  if (!ID.test(scope.tenantId) || !ID.test(scope.episodeId) ||
      !Array.isArray(files) || files.length < 1 || files.length > MAX_ENTRIES) {
    throw new Error("transformer_attempt_checkpoint_workspace_artifact_invalid");
  }
  const seen = new Set<string>();
  const encodedEntries = files.map((file) => {
    if (!validPath(file.path) || !(file.content instanceof Uint8Array) ||
        (file.mode !== "file" && file.mode !== "executable") ||
        seen.has(file.path.toLowerCase())) {
      throw new Error("transformer_attempt_checkpoint_workspace_artifact_invalid");
    }
    seen.add(file.path.toLowerCase());
    return {
      path: file.path,
      mode: file.mode,
      contentBase64: Buffer.from(file.content).toString("base64"),
    };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const payload = Buffer.from(canonical(encodedEntries), "utf8");
  if (payload.byteLength > MAX_WORKSPACE_ARCHIVE_BYTES) {
    throw new Error("transformer_attempt_checkpoint_workspace_artifact_invalid");
  }
  const manifest = createTransformerWorkspaceManifest(encodedEntries.map((entry) => ({
    path: entry.path,
    content: Buffer.from(entry.contentBase64, "base64"),
    mode: entry.mode,
  })));
  const manifestDigest = createTransformerWorkspaceManifestDigest(manifest);
  const filesDigest = sha256(encodedEntries.map((entry) => {
    const content = Buffer.from(entry.contentBase64, "base64");
    const text = content.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(content)) {
      throw new Error("transformer_attempt_checkpoint_workspace_artifact_invalid");
    }
    return `${entry.path.length}:${entry.path}${text.length}:${text}`;
  }).join(""));
  const encrypted = encryptArtifact(
    `transformer/${scope.tenantId}/${scope.episodeId}/workspaces`,
    payload,
    key,
    { purpose: "workspace", ...scope, manifestDigest, filesDigest },
  );
  const artifact: TransformerWorkspaceArtifact = {
    ...encrypted.artifact,
    kind: "content_addressed_archive",
    manifestDigest,
    filesDigest,
  };
  validateWorkspaceArtifact(artifact);
  return { artifact, bytes: encrypted.bytes, manifest };
}

export function createTransformerEffectResultArtifact(
  scope: Readonly<{ tenantId: string; episodeId: string; effectId: string }>,
  payload: Uint8Array,
  key: Uint8Array,
): Readonly<{ artifact: TransformerEncryptedArtifact; bytes: Uint8Array }> {
  if (!ID.test(scope.tenantId) || !ID.test(scope.episodeId) || !ID.test(scope.effectId)) {
    throw new Error("transformer_attempt_checkpoint_artifact_invalid");
  }
  return encryptArtifact(
    `transformer/${scope.tenantId}/${scope.episodeId}/effects/results/${scope.effectId}`,
    payload,
    key,
    { purpose: "effect-result", ...scope },
  );
}

export function createTransformerEffectRequestArtifact(
  scope: Readonly<{ tenantId: string; episodeId: string; effectId: string }>,
  payload: Uint8Array,
  key: Uint8Array,
): Readonly<{ artifact: TransformerEncryptedArtifact; bytes: Uint8Array }> {
  if (!ID.test(scope.tenantId) || !ID.test(scope.episodeId) || !ID.test(scope.effectId)) {
    throw new Error("transformer_attempt_checkpoint_artifact_invalid");
  }
  return encryptArtifact(
    `transformer/${scope.tenantId}/${scope.episodeId}/effects/requests/${scope.effectId}`,
    payload,
    key,
    { purpose: "effect-request", ...scope },
  );
}

function validatePortableOutput(base64: string, expectedDigest: string, code: string): void {
  requireDigest(expectedDigest, code);
  if (typeof base64 !== "string" || base64.length < 1) throw new Error(code);
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_EFFECT_OUTPUT_BYTES ||
      bytes.toString("base64") !== base64 || sha256(bytes) !== expectedDigest) {
    throw new Error(code);
  }
}

function validateModelEffectResult(result: TransformerModelEffectResult): void {
  exactKeys(result, [
    "schemaVersion", "promptTokens", "completionTokens", "totalTokens", "costUsd", "wallTimeMs",
    "responseDigest", "responseBase64",
  ], "transformer_attempt_checkpoint_model_result_invalid");
  if (result.schemaVersion !== 1) {
    throw new Error("transformer_attempt_checkpoint_model_result_invalid");
  }
  positive(result.promptTokens, "transformer_attempt_checkpoint_model_result_invalid");
  positive(result.completionTokens, "transformer_attempt_checkpoint_model_result_invalid");
  positive(result.totalTokens, "transformer_attempt_checkpoint_model_result_invalid");
  positive(result.wallTimeMs, "transformer_attempt_checkpoint_model_result_invalid");
  if (result.totalTokens !== result.promptTokens + result.completionTokens ||
      !Number.isFinite(result.costUsd) || result.costUsd <= 0) {
    throw new Error("transformer_attempt_checkpoint_model_result_invalid");
  }
  validatePortableOutput(
    result.responseBase64,
    result.responseDigest,
    "transformer_attempt_checkpoint_model_result_invalid",
  );
}

export function createTransformerModelEffectResultArtifact(
  scope: Readonly<{ tenantId: string; episodeId: string; effectId: string }>,
  result: TransformerModelEffectResult,
  key: Uint8Array,
): Readonly<{ artifact: TransformerEncryptedArtifact; bytes: Uint8Array }> {
  validateModelEffectResult(result);
  return createTransformerEffectResultArtifact(
    scope,
    Buffer.from(canonical(result), "utf8"),
    key,
  );
}

function parseModelEffectResult(payload: Uint8Array): TransformerModelEffectResult {
  let result: TransformerModelEffectResult;
  try {
    result = JSON.parse(Buffer.from(payload).toString("utf8")) as TransformerModelEffectResult;
  } catch {
    throw new Error("transformer_attempt_checkpoint_model_result_invalid");
  }
  validateModelEffectResult(result);
  if (canonical(result) !== Buffer.from(payload).toString("utf8")) {
    throw new Error("transformer_attempt_checkpoint_model_result_invalid");
  }
  return result;
}

function validateVerifierEffectResult(result: TransformerVerifierEffectResult): void {
  exactKeys(result, ["schemaVersion", "status", "outputDigest", "outputBase64"],
    "transformer_attempt_checkpoint_verifier_result_invalid");
  if (result.schemaVersion !== 1 || (result.status !== "passed" && result.status !== "failed")) {
    throw new Error("transformer_attempt_checkpoint_verifier_result_invalid");
  }
  requireDigest(result.outputDigest, "transformer_attempt_checkpoint_verifier_result_invalid");
  validatePortableOutput(
    result.outputBase64,
    result.outputDigest,
    "transformer_attempt_checkpoint_verifier_result_invalid",
  );
}

export function createTransformerVerifierEffectResultArtifact(
  scope: Readonly<{ tenantId: string; episodeId: string; effectId: string }>,
  result: TransformerVerifierEffectResult,
  key: Uint8Array,
): Readonly<{ artifact: TransformerEncryptedArtifact; bytes: Uint8Array }> {
  validateVerifierEffectResult(result);
  return createTransformerEffectResultArtifact(
    scope,
    Buffer.from(canonical(result), "utf8"),
    key,
  );
}

function parseVerifierEffectResult(payload: Uint8Array): TransformerVerifierEffectResult {
  let result: TransformerVerifierEffectResult;
  try {
    result = JSON.parse(Buffer.from(payload).toString("utf8")) as TransformerVerifierEffectResult;
  } catch {
    throw new Error("transformer_attempt_checkpoint_verifier_result_invalid");
  }
  validateVerifierEffectResult(result);
  if (canonical(result) !== Buffer.from(payload).toString("utf8")) {
    throw new Error("transformer_attempt_checkpoint_verifier_result_invalid");
  }
  return result;
}

function validateCoordinatorEffectResult(result: TransformerCoordinatorEffectResult): void {
  exactKeys(result, ["schemaVersion", "status", "completionDigest"],
    "transformer_attempt_checkpoint_coordinator_result_invalid");
  if (result.schemaVersion !== 1 ||
      (result.status !== "accepted" && result.status !== "rejected")) {
    throw new Error("transformer_attempt_checkpoint_coordinator_result_invalid");
  }
  requireDigest(result.completionDigest,
    "transformer_attempt_checkpoint_coordinator_result_invalid");
}

export function createTransformerCoordinatorEffectResultArtifact(
  scope: Readonly<{ tenantId: string; episodeId: string; effectId: string }>,
  result: TransformerCoordinatorEffectResult,
  key: Uint8Array,
): Readonly<{ artifact: TransformerEncryptedArtifact; bytes: Uint8Array }> {
  validateCoordinatorEffectResult(result);
  return createTransformerEffectResultArtifact(
    scope,
    Buffer.from(canonical(result), "utf8"),
    key,
  );
}

function parseCoordinatorEffectResult(payload: Uint8Array): TransformerCoordinatorEffectResult {
  let result: TransformerCoordinatorEffectResult;
  try {
    result = JSON.parse(Buffer.from(payload).toString("utf8")) as TransformerCoordinatorEffectResult;
  } catch {
    throw new Error("transformer_attempt_checkpoint_coordinator_result_invalid");
  }
  validateCoordinatorEffectResult(result);
  if (canonical(result) !== Buffer.from(payload).toString("utf8")) {
    throw new Error("transformer_attempt_checkpoint_coordinator_result_invalid");
  }
  return result;
}

export function verifyTransformerEffectResultArtifact(
  artifact: TransformerEncryptedArtifact,
  bytes: Uint8Array,
  key: Uint8Array,
  scope: Readonly<{ tenantId: string; episodeId: string; effectId: string }>,
): Uint8Array {
  return decryptArtifact(artifact, bytes, key, { purpose: "effect-result", ...scope });
}

export function verifyTransformerEffectRequestArtifact(
  artifact: TransformerEncryptedArtifact,
  bytes: Uint8Array,
  key: Uint8Array,
  scope: Readonly<{ tenantId: string; episodeId: string; effectId: string }>,
): Uint8Array {
  return decryptArtifact(artifact, bytes, key, { purpose: "effect-request", ...scope });
}

export function openTransformerModelEffectResultArtifact(
  artifact: TransformerEncryptedArtifact,
  bytes: Uint8Array,
  key: Uint8Array,
  scope: Readonly<{ tenantId: string; episodeId: string; effectId: string }>,
): TransformerModelEffectResult {
  return parseModelEffectResult(verifyTransformerEffectResultArtifact(
    artifact, bytes, key, scope,
  ));
}

export function openTransformerVerifierEffectResultArtifact(
  artifact: TransformerEncryptedArtifact,
  bytes: Uint8Array,
  key: Uint8Array,
  scope: Readonly<{ tenantId: string; episodeId: string; effectId: string }>,
): TransformerVerifierEffectResult {
  return parseVerifierEffectResult(verifyTransformerEffectResultArtifact(
    artifact, bytes, key, scope,
  ));
}

export function openTransformerCoordinatorEffectResultArtifact(
  artifact: TransformerEncryptedArtifact,
  bytes: Uint8Array,
  key: Uint8Array,
  scope: Readonly<{ tenantId: string; episodeId: string; effectId: string }>,
): TransformerCoordinatorEffectResult {
  return parseCoordinatorEffectResult(verifyTransformerEffectResultArtifact(
    artifact, bytes, key, scope,
  ));
}

export function createTransformerWorkspaceTransitionDigest(
  current: TransformerWorkspaceArtifact,
  next: TransformerWorkspaceArtifact,
): string {
  return sha256(createTransformerWorkspaceTransitionRequest(current, next));
}

export function createTransformerWorkspaceTransitionRequest(
  current: TransformerWorkspaceArtifact,
  next: TransformerWorkspaceArtifact,
): Uint8Array {
  validateWorkspaceArtifact(current);
  validateWorkspaceArtifact(next);
  return Buffer.from(canonical({
    protocol: `${PROTOCOL}:workspace-transition`,
    current,
    next,
  }), "utf8");
}

export function openTransformerWorkspaceTransitionRequest(
  artifact: TransformerEncryptedArtifact,
  bytes: Uint8Array,
  key: Uint8Array,
  scope: Readonly<{ tenantId: string; episodeId: string; effectId: string }>,
): Readonly<{
  current: TransformerWorkspaceArtifact;
  next: TransformerWorkspaceArtifact;
}> {
  const payload = verifyTransformerEffectRequestArtifact(artifact, bytes, key, scope);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch {
    throw new Error("transformer_attempt_checkpoint_workspace_transition_invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("transformer_attempt_checkpoint_workspace_transition_invalid");
  }
  exactKeys(
    parsed,
    ["protocol", "current", "next"],
    "transformer_attempt_checkpoint_workspace_transition_invalid",
  );
  const request = parsed as {
    protocol: string;
    current: TransformerWorkspaceArtifact;
    next: TransformerWorkspaceArtifact;
  };
  if (request.protocol !== `${PROTOCOL}:workspace-transition` ||
      canonical(request) !== Buffer.from(payload).toString("utf8")) {
    throw new Error("transformer_attempt_checkpoint_workspace_transition_invalid");
  }
  validateWorkspaceArtifact(request.current);
  validateWorkspaceArtifact(request.next);
  return Object.freeze({
    current: Object.freeze({ ...request.current }),
    next: Object.freeze({ ...request.next }),
  });
}

export function createTransformerCandidateSeal(
  binding: TransformerAttemptCheckpointBinding,
  workspaceArtifact: TransformerWorkspaceArtifact,
): TransformerCandidateSeal {
  validateBinding(binding);
  validateWorkspaceArtifact(workspaceArtifact);
  if (binding.candidateDigest !== workspaceArtifact.filesDigest ||
      binding.candidateManifestDigest !== workspaceArtifact.manifestDigest) {
    throw new Error("transformer_attempt_checkpoint_candidate_seal_invalid");
  }
  const body = {
    schemaVersion: 1 as const,
    candidateRevision: binding.candidateRevision,
    candidateDigest: binding.candidateDigest,
    workspaceManifestDigest: workspaceArtifact.manifestDigest,
    workspacePayloadDigest: workspaceArtifact.payloadDigest,
  };
  return {
    ...body,
    sealDigest: sha256(createTransformerCandidateSealPayload(binding, workspaceArtifact)),
  };
}

export function createTransformerCandidateSealPayload(
  binding: TransformerAttemptCheckpointBinding,
  workspaceArtifact: TransformerWorkspaceArtifact,
): Uint8Array {
  validateBinding(binding);
  validateWorkspaceArtifact(workspaceArtifact);
  if (binding.candidateDigest !== workspaceArtifact.filesDigest ||
      binding.candidateManifestDigest !== workspaceArtifact.manifestDigest) {
    throw new Error("transformer_attempt_checkpoint_candidate_seal_invalid");
  }
  return Buffer.from(canonical({
    protocol: `${PROTOCOL}:candidate-seal`,
    schemaVersion: 1,
    candidateRevision: binding.candidateRevision,
    candidateDigest: binding.candidateDigest,
    workspaceManifestDigest: workspaceArtifact.manifestDigest,
    workspacePayloadDigest: workspaceArtifact.payloadDigest,
  }), "utf8");
}

function validateCandidateSeal(
  seal: TransformerCandidateSeal,
  binding: TransformerAttemptCheckpointBinding,
  workspaceArtifact: TransformerWorkspaceArtifact,
): void {
  exactKeys(seal, [
    "schemaVersion", "candidateRevision", "candidateDigest", "workspaceManifestDigest",
    "workspacePayloadDigest", "sealDigest",
  ], "transformer_attempt_checkpoint_candidate_seal_invalid");
  requireDigest(seal.sealDigest, "transformer_attempt_checkpoint_candidate_seal_invalid");
  if (canonical(seal) !== canonical(createTransformerCandidateSeal(binding, workspaceArtifact))) {
    throw new Error("transformer_attempt_checkpoint_candidate_seal_invalid");
  }
}

export function createTransformerCoordinatorCompletionRequestDigest(
  episodeId: string,
  seal: TransformerCandidateSeal,
  completionIntent: TransformerAttemptCompletionIntent,
  artifactRegistration?: TransformerMissionArtifactRegistrationBinding,
): string {
  return sha256(createTransformerCoordinatorCompletionRequest(
    episodeId,
    seal,
    completionIntent,
    artifactRegistration,
  ));
}

export function createTransformerCoordinatorCompletionRequest(
  episodeId: string,
  seal: TransformerCandidateSeal,
  completionIntent: TransformerAttemptCompletionIntent,
  artifactRegistration?: TransformerMissionArtifactRegistrationBinding,
): Uint8Array {
  const normalizedIntent = openTransformerAttemptCompletionPayload(
    createTransformerAttemptCompletionPayload(completionIntent),
  );
  validateCoordinatorCompletionRequestBinding(episodeId, seal, normalizedIntent);
  const completionDigest = createTransformerAttemptCompletionDigest(normalizedIntent);
  const registration = artifactRegistration === undefined
    ? undefined
    : requireTransformerMissionArtifactRegistrationBinding(artifactRegistration);
  return Buffer.from(canonical({
    protocol: `${PROTOCOL}:coordinator-completion`,
    episodeId,
    seal,
    completionDigest,
    completionIntent: normalizedIntent,
    ...(registration === undefined ? {} : { artifactRegistration: registration }),
  }), "utf8");
}

function validateCoordinatorCompletionRequestBinding(
  episodeId: string,
  seal: TransformerCandidateSeal,
  completionIntent: TransformerAttemptCompletionIntent,
): void {
  if (!ID.test(episodeId) || completionIntent.episodeId !== episodeId) {
    throw new Error("transformer_attempt_checkpoint_terminal_invalid");
  }
  exactKeys(seal, [
    "schemaVersion", "candidateRevision", "candidateDigest", "workspaceManifestDigest",
    "workspacePayloadDigest", "sealDigest",
  ], "transformer_attempt_checkpoint_terminal_invalid");
  if (seal.schemaVersion !== 1 ||
      seal.candidateRevision !== completionIntent.candidateRevision ||
      seal.candidateDigest !== completionIntent.candidateDigest ||
      seal.sealDigest !== completionIntent.candidateSealDigest) {
    throw new Error("transformer_attempt_checkpoint_terminal_invalid");
  }
  for (const value of [
    seal.candidateDigest,
    seal.workspaceManifestDigest,
    seal.workspacePayloadDigest,
    seal.sealDigest,
  ]) {
    requireDigest(value, "transformer_attempt_checkpoint_terminal_invalid");
  }
}

export function openTransformerCoordinatorCompletionRequest(
  payload: Uint8Array,
): TransformerCoordinatorCompletionRequest {
  try {
    const source = Buffer.from(payload);
    const parsed = JSON.parse(source.toString("utf8")) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("transformer_attempt_checkpoint_terminal_invalid");
    }
    const hasArtifactRegistration = Object.hasOwn(parsed, "artifactRegistration");
    exactKeys(parsed, [
      "protocol", "episodeId", "seal", "completionDigest", "completionIntent",
      ...(hasArtifactRegistration ? ["artifactRegistration"] : []),
    ], "transformer_attempt_checkpoint_terminal_invalid");
    if (parsed.protocol !== `${PROTOCOL}:coordinator-completion` ||
        typeof parsed.episodeId !== "string") {
      throw new Error("transformer_attempt_checkpoint_terminal_invalid");
    }
    const completionIntent = openTransformerAttemptCompletionPayload(
      Buffer.from(canonical(parsed.completionIntent), "utf8"),
    );
    const seal = parsed.seal as TransformerCandidateSeal;
    const artifactRegistration = hasArtifactRegistration
      ? requireTransformerMissionArtifactRegistrationBinding(
          parsed.artifactRegistration as TransformerMissionArtifactRegistrationBinding,
        )
      : undefined;
    validateCoordinatorCompletionRequestBinding(parsed.episodeId, seal, completionIntent);
    const completionDigest = createTransformerAttemptCompletionDigest(completionIntent);
    if (parsed.completionDigest !== completionDigest || canonical(parsed) !== source.toString("utf8")) {
      throw new Error("transformer_attempt_checkpoint_terminal_invalid");
    }
    return Object.freeze({
      episodeId: parsed.episodeId,
      seal: Object.freeze({ ...seal }),
      completionDigest,
      completionIntent,
      ...(artifactRegistration === undefined ? {} : { artifactRegistration }),
    });
  } catch {
    throw new Error("transformer_attempt_checkpoint_terminal_invalid");
  }
}

export function createTransformerCoordinatorCompletionSlot(completionDigest: string): string {
  requireDigest(completionDigest, "transformer_attempt_checkpoint_terminal_invalid");
  return `coordinator:completion:${completionDigest.slice("sha256:".length)}`;
}

function coordinatorCompletionDigestFromSlot(slot: string): string | null {
  const matched = COORDINATOR_COMPLETION_SLOT.exec(slot);
  return matched ? `sha256:${matched[1]}` : null;
}

export function createTransformerCandidatePublicationRequestDigest(
  episodeId: string,
  seal: TransformerCandidateSeal,
): string {
  return sha256(createTransformerCandidatePublicationRequest(episodeId, seal));
}

export function createTransformerCandidatePublicationRequest(
  episodeId: string,
  seal: TransformerCandidateSeal,
): Uint8Array {
  if (!ID.test(episodeId)) throw new Error("transformer_attempt_checkpoint_candidate_seal_invalid");
  return Buffer.from(canonical({
    protocol: `${PROTOCOL}:candidate-publication`, episodeId, candidateSeal: seal,
  }), "utf8");
}

function decodeTransformerWorkspaceArtifact(
  artifact: TransformerWorkspaceArtifact,
  bytes: Uint8Array,
  key: Uint8Array,
  scope: Readonly<{ tenantId: string; episodeId: string }>,
): Readonly<{
  manifest: readonly TransformerWorkspaceManifestEntry[];
  files: readonly TransformerWorkspaceArtifactFile[];
}> {
  validateWorkspaceArtifact(artifact);
  const {
    kind: _kind,
    manifestDigest: _manifestDigest,
    filesDigest: _filesDigest,
    ...base
  } = artifact;
  const payload = decryptArtifact(base, bytes, key, {
    purpose: "workspace",
    ...scope,
    manifestDigest: artifact.manifestDigest,
    filesDigest: artifact.filesDigest,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("transformer_attempt_checkpoint_workspace_artifact_invalid");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_ENTRIES) {
    throw new Error("transformer_attempt_checkpoint_workspace_artifact_invalid");
  }
  if (canonical(parsed) !== payload.toString("utf8")) {
    throw new Error("transformer_attempt_checkpoint_workspace_artifact_invalid");
  }
  const manifest: TransformerWorkspaceManifestEntry[] = [];
  const files: TransformerWorkspaceArtifactFile[] = [];
  const paths = new Set<string>();
  for (const raw of parsed) {
    if (raw === null || typeof raw !== "object") {
      throw new Error("transformer_attempt_checkpoint_workspace_artifact_invalid");
    }
    exactKeys(raw, ["path", "mode", "contentBase64"], "transformer_attempt_checkpoint_workspace_artifact_invalid");
    const entry = raw as { path: string; mode: "file" | "executable"; contentBase64: string };
    if (!validPath(entry.path) || (entry.mode !== "file" && entry.mode !== "executable") ||
        paths.has(entry.path.toLowerCase())) {
      throw new Error("transformer_attempt_checkpoint_workspace_artifact_invalid");
    }
    const content = Buffer.from(entry.contentBase64, "base64");
    if (content.toString("base64") !== entry.contentBase64) {
      throw new Error("transformer_attempt_checkpoint_workspace_artifact_invalid");
    }
    paths.add(entry.path.toLowerCase());
    manifest.push({ path: entry.path, digest: sha256(content), bytes: content.byteLength, mode: entry.mode });
    files.push({ path: entry.path, content, mode: entry.mode });
  }
  const normalized = normalizedManifest(manifest);
  if (createTransformerWorkspaceManifestDigest(normalized) !== artifact.manifestDigest) {
    throw new Error("transformer_attempt_checkpoint_workspace_artifact_mismatch");
  }
  const filesDigest = sha256((parsed as readonly { path: string; contentBase64: string }[])
    .map((entry) => {
      const content = Buffer.from(entry.contentBase64, "base64");
      const text = content.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(content)) {
        throw new Error("transformer_attempt_checkpoint_workspace_artifact_invalid");
      }
      return `${entry.path.length}:${entry.path}${text.length}:${text}`;
    })
    .join(""));
  if (filesDigest !== artifact.filesDigest) {
    throw new Error("transformer_attempt_checkpoint_workspace_artifact_mismatch");
  }
  return { manifest: normalized, files };
}

export function verifyTransformerWorkspaceArtifact(
  artifact: TransformerWorkspaceArtifact,
  bytes: Uint8Array,
  key: Uint8Array,
  scope: Readonly<{ tenantId: string; episodeId: string }>,
): readonly TransformerWorkspaceManifestEntry[] {
  return decodeTransformerWorkspaceArtifact(artifact, bytes, key, scope).manifest;
}

export function openTransformerWorkspaceArtifact(
  artifact: TransformerWorkspaceArtifact,
  bytes: Uint8Array,
  key: Uint8Array,
  scope: Readonly<{ tenantId: string; episodeId: string }>,
): readonly TransformerWorkspaceArtifactFile[] {
  return decodeTransformerWorkspaceArtifact(artifact, bytes, key, scope).files;
}

function validateEffect(
  effect: TransformerAttemptCheckpointEffect,
  episodeId: string,
  tenantId: string,
): void {
  if (effect.kind === "none") {
    exactKeys(effect, ["kind"], "transformer_attempt_checkpoint_effect_invalid");
    return;
  }
  exactKeys(effect, [
    "kind", "state", "effectId", "slot", "idempotencyKey", "requestDigest", "requestArtifact",
    ...(effect.state === "completed" ? ["resultArtifact"] : []),
  ], "transformer_attempt_checkpoint_effect_invalid");
  if (!EFFECT_KINDS.includes(effect.kind) || !ID.test(effect.effectId) ||
      !ID.test(effect.slot) || !ID.test(effect.idempotencyKey) ||
      (effect.state !== "prepared" && effect.state !== "dispatched" && effect.state !== "completed")) {
    throw new Error("transformer_attempt_checkpoint_effect_invalid");
  }
  const slotValid =
    (effect.kind === "model" && /^planner:[0-9]+$/.test(effect.slot)) ||
    (effect.kind === "verifier" && /^verification:sha256:[a-f0-9]{64}:[0-9]+:[0-9]+$/.test(effect.slot)) ||
    (effect.kind === "workspace_publish" && /^workspace:sha256:[a-f0-9]{64}:[0-9]+$/.test(effect.slot)) ||
    (effect.kind === "candidate_publish" && effect.slot === "candidate:seal") ||
    (effect.kind === "coordinator_complete" &&
      coordinatorCompletionDigestFromSlot(effect.slot) !== null);
  if (!slotValid) throw new Error("transformer_attempt_checkpoint_effect_invalid");
  requireDigest(effect.requestDigest, "transformer_attempt_checkpoint_effect_invalid");
  validateEncryptedArtifact(effect.requestArtifact, "transformer_attempt_checkpoint_effect_invalid");
  if (effect.requestArtifact.payloadDigest !== effect.requestDigest ||
      !effect.requestArtifact.storageKey.startsWith(
        `transformer/${tenantId}/${episodeId}/effects/requests/${effect.effectId}/`,
      )) {
    throw new Error("transformer_attempt_checkpoint_effect_invalid");
  }
  const identity = createTransformerAttemptEffectIdentity(
    episodeId, effect.kind, effect.slot, effect.requestDigest,
  );
  if (effect.effectId !== identity.effectId || effect.idempotencyKey !== identity.idempotencyKey) {
    throw new Error("transformer_attempt_checkpoint_effect_invalid");
  }
  if (effect.state === "completed") {
    if (effect.kind === "workspace_publish") {
      validateWorkspaceArtifact(effect.resultArtifact as TransformerWorkspaceArtifact);
      if (!(effect.resultArtifact as TransformerWorkspaceArtifact).storageKey.startsWith(
        `transformer/${tenantId}/${episodeId}/workspaces/`,
      )) {
        throw new Error("transformer_attempt_checkpoint_effect_invalid");
      }
    } else {
      validateEncryptedArtifact(
        effect.resultArtifact as TransformerEncryptedArtifact,
        "transformer_attempt_checkpoint_effect_invalid",
      );
      if (!(effect.resultArtifact as TransformerEncryptedArtifact).storageKey.startsWith(
        `transformer/${tenantId}/${episodeId}/effects/results/${effect.effectId}/`,
      )) {
        throw new Error("transformer_attempt_checkpoint_effect_invalid");
      }
    }
  }
}

function validateManifest(manifest: readonly TransformerWorkspaceManifestEntry[]): void {
  if (!Array.isArray(manifest) || manifest.length < 1 || manifest.length > MAX_ENTRIES) {
    throw new Error("transformer_attempt_checkpoint_manifest_invalid");
  }
  const paths = new Set<string>();
  for (const entry of manifest) {
    exactKeys(entry, ["path", "digest", "bytes", "mode"], "transformer_attempt_checkpoint_manifest_invalid");
    const pathKey = entry.path.toLowerCase();
    if (!validPath(entry.path) || paths.has(pathKey)) {
      throw new Error("transformer_attempt_checkpoint_manifest_invalid");
    }
    if (entry.mode !== "file" && entry.mode !== "executable") {
      throw new Error("transformer_attempt_checkpoint_manifest_invalid");
    }
    paths.add(pathKey);
    requireDigest(entry.digest, "transformer_attempt_checkpoint_manifest_invalid");
    natural(entry.bytes, "transformer_attempt_checkpoint_manifest_invalid");
  }
}

function verificationRound(
  receipts: TransformerAttemptCheckpointState["verificationReceipts"],
  workspaceManifestDigest: string,
): number {
  let roundCount = 0;
  let previousWorkspaceDigest: string | null = null;
  for (const receipt of receipts) {
    if (receipt.workspaceManifestDigest !== previousWorkspaceDigest) {
      if (receipt.workspaceManifestDigest === workspaceManifestDigest) roundCount += 1;
      previousWorkspaceDigest = receipt.workspaceManifestDigest;
    }
  }
  return receipts.at(-1)?.workspaceManifestDigest === workspaceManifestDigest
    ? roundCount - 1
    : roundCount;
}

function validateState(state: TransformerAttemptCheckpointState): void {
  exactKeys(state, [
    "schemaVersion", "episodeId", "binding", "generation", "attemptNumber",
    "writerLeaseGeneration", "writerLeaseTokenDigest", "stage", "commandCursor",
    "verificationPlan", "workspaceManifest", "workspaceArtifact", "verificationReceipts", "accounting",
    "completedEffects", "pendingEffect", "candidateSeal", "previousCheckpointDigest", "createdAt",
  ], "transformer_attempt_checkpoint_state_invalid");
  validateBinding(state.binding);
  if (state.schemaVersion !== 1 || state.episodeId !== createTransformerEpisodeId(state.binding)) {
    throw new Error("transformer_attempt_checkpoint_state_invalid");
  }
  positive(state.generation, "transformer_attempt_checkpoint_generation_invalid");
  positive(state.attemptNumber, "transformer_attempt_checkpoint_attempt_invalid");
  positive(state.writerLeaseGeneration, "transformer_attempt_checkpoint_lease_invalid");
  requireDigest(state.writerLeaseTokenDigest, "transformer_attempt_checkpoint_lease_invalid");
  natural(state.commandCursor, "transformer_attempt_checkpoint_cursor_invalid");
  if (!STAGES.includes(state.stage) ||
      (state.previousCheckpointDigest !== null && !DIGEST.test(state.previousCheckpointDigest)) ||
      !Number.isFinite(Date.parse(state.createdAt)) || new Date(state.createdAt).toISOString() !== state.createdAt) {
    throw new Error("transformer_attempt_checkpoint_state_invalid");
  }
  validateManifest(state.workspaceManifest);
  validateWorkspaceArtifact(state.workspaceArtifact);
  if (createTransformerWorkspaceManifestDigest(state.workspaceManifest) !== state.workspaceArtifact.manifestDigest) {
    throw new Error("transformer_attempt_checkpoint_workspace_artifact_mismatch");
  }
  if (!state.workspaceArtifact.storageKey.startsWith(
    `transformer/${state.binding.tenantId}/${state.episodeId}/workspaces/`,
  )) {
    throw new Error("transformer_attempt_checkpoint_workspace_artifact_invalid");
  }
  if (!Array.isArray(state.verificationPlan) ||
      state.verificationPlan.length !== state.binding.requiredVerificationCount) {
    throw new Error("transformer_attempt_checkpoint_verification_plan_invalid");
  }
  for (let index = 0; index < state.verificationPlan.length; index += 1) {
    const planned = state.verificationPlan[index]!;
    exactKeys(planned, ["index", "commandId", "commandDigest"],
      "transformer_attempt_checkpoint_verification_plan_invalid");
    if (planned.index !== index || !ID.test(planned.commandId)) {
      throw new Error("transformer_attempt_checkpoint_verification_plan_invalid");
    }
    requireDigest(planned.commandDigest, "transformer_attempt_checkpoint_verification_plan_invalid");
  }
  if (createTransformerVerificationPlanDigest(state.verificationPlan) !==
      state.binding.verificationPlanDigest) {
    throw new Error("transformer_attempt_checkpoint_verification_plan_invalid");
  }
  if (!Array.isArray(state.verificationReceipts) ||
      state.verificationReceipts.length > MAX_ENTRIES) {
    throw new Error("transformer_attempt_checkpoint_cursor_invalid");
  }
  let groupWorkspaceDigest: string | null = null;
  let groupRound = -1;
  let groupIndex = 0;
  const workspaceRounds = new Map<string, number>();
  for (let index = 0; index < state.verificationReceipts.length; index += 1) {
    const receipt = state.verificationReceipts[index]!;
    exactKeys(receipt, [
      "sequence", "round", "index", "commandId", "commandDigest", "workspaceManifestDigest", "status",
      "outputDigest",
    ],
      "transformer_attempt_checkpoint_receipt_invalid");
    if (receipt.workspaceManifestDigest !== groupWorkspaceDigest) {
      const currentWorkspaceDigest = receipt.workspaceManifestDigest;
      groupWorkspaceDigest = currentWorkspaceDigest;
      groupRound = workspaceRounds.get(currentWorkspaceDigest) ?? 0;
      workspaceRounds.set(currentWorkspaceDigest, groupRound + 1);
      groupIndex = 0;
    }
    if (receipt.sequence !== index || receipt.round !== groupRound || receipt.index !== groupIndex ||
        !ID.test(receipt.commandId) ||
        (receipt.status !== "passed" && receipt.status !== "failed") ||
        receipt.commandId !== state.verificationPlan[groupIndex]?.commandId ||
        receipt.commandDigest !== state.verificationPlan[groupIndex]?.commandDigest) {
      throw new Error("transformer_attempt_checkpoint_receipt_invalid");
    }
    requireDigest(receipt.commandDigest, "transformer_attempt_checkpoint_receipt_invalid");
    requireDigest(receipt.workspaceManifestDigest, "transformer_attempt_checkpoint_receipt_invalid");
    requireDigest(receipt.outputDigest, "transformer_attempt_checkpoint_receipt_invalid");
    groupIndex += 1;
  }
  let currentWorkspaceReceiptCount = 0;
  for (let index = state.verificationReceipts.length - 1; index >= 0; index -= 1) {
    if (state.verificationReceipts[index]!.workspaceManifestDigest !==
        state.workspaceArtifact.manifestDigest) break;
    currentWorkspaceReceiptCount += 1;
  }
  if (state.commandCursor !== currentWorkspaceReceiptCount ||
      state.commandCursor > state.binding.requiredVerificationCount) {
    throw new Error("transformer_attempt_checkpoint_cursor_invalid");
  }
  exactKeys(state.accounting, [
    "plannerCalls", "promptTokens", "completionTokens", "totalTokens", "costUsd", "wallTimeMs",
  ], "transformer_attempt_checkpoint_accounting_invalid");
  for (const value of [state.accounting.plannerCalls, state.accounting.promptTokens,
    state.accounting.completionTokens, state.accounting.totalTokens, state.accounting.wallTimeMs]) {
    natural(value, "transformer_attempt_checkpoint_accounting_invalid");
  }
  if (state.accounting.totalTokens !== state.accounting.promptTokens + state.accounting.completionTokens ||
      !Number.isFinite(state.accounting.costUsd) || state.accounting.costUsd < 0) {
    throw new Error("transformer_attempt_checkpoint_accounting_invalid");
  }
  if (!Array.isArray(state.completedEffects) || state.completedEffects.length > MAX_ENTRIES) {
    throw new Error("transformer_attempt_checkpoint_effect_invalid");
  }
  const effectIds = new Set<string>();
  const effectSlots = new Set<string>();
  for (const receipt of state.completedEffects) {
    exactKeys(receipt, [
      "kind", "effectId", "slot", "idempotencyKey", "requestDigest", "requestArtifact",
      "resultArtifact",
    ],
      "transformer_attempt_checkpoint_effect_invalid");
    if (!EFFECT_KINDS.includes(receipt.kind) || !ID.test(receipt.effectId) ||
        !ID.test(receipt.slot) || !ID.test(receipt.idempotencyKey) ||
        effectIds.has(receipt.effectId) ||
        (receipt.kind !== "workspace_publish" && effectSlots.has(receipt.slot))) {
      throw new Error("transformer_attempt_checkpoint_effect_invalid");
    }
    effectIds.add(receipt.effectId);
    if (receipt.kind !== "workspace_publish") effectSlots.add(receipt.slot);
    requireDigest(receipt.requestDigest, "transformer_attempt_checkpoint_effect_invalid");
    const identity = createTransformerAttemptEffectIdentity(
      state.episodeId, receipt.kind, receipt.slot, receipt.requestDigest,
    );
    if (receipt.effectId !== identity.effectId || receipt.idempotencyKey !== identity.idempotencyKey) {
      throw new Error("transformer_attempt_checkpoint_effect_invalid");
    }
    if (receipt.kind === "workspace_publish") {
      validateWorkspaceArtifact(receipt.resultArtifact as TransformerWorkspaceArtifact);
    } else {
      validateEncryptedArtifact(
        receipt.resultArtifact as TransformerEncryptedArtifact,
        "transformer_attempt_checkpoint_effect_invalid",
      );
    }
    validateEffect({ ...receipt, state: "completed" }, state.episodeId, state.binding.tenantId);
  }
  const knownWorkspaceDigests = new Set<string>([
    state.binding.sourceManifestDigest,
    state.workspaceArtifact.manifestDigest,
    ...state.completedEffects
      .filter((effect) => effect.kind === "workspace_publish")
      .map((effect) => (effect.resultArtifact as TransformerWorkspaceArtifact).manifestDigest),
  ]);
  if (state.verificationReceipts.some((receipt) =>
    !knownWorkspaceDigests.has(receipt.workspaceManifestDigest)
  )) {
    throw new Error("transformer_attempt_checkpoint_receipt_invalid");
  }
  validateEffect(state.pendingEffect, state.episodeId, state.binding.tenantId);
  if (state.pendingEffect.kind !== "none") {
    const effect = state.pendingEffect;
    const stageValid =
      (effect.kind === "model" && state.stage === "adaptive") ||
      (effect.kind === "verifier" &&
        (state.stage === "verification" || state.stage === "adaptive")) ||
      (effect.kind === "workspace_publish" &&
        (state.stage === "source_loaded" || state.stage === "recipe_applied" || state.stage === "adaptive")) ||
      (effect.kind === "candidate_publish" && state.stage === "adaptive") ||
      (effect.kind === "coordinator_complete" && state.stage === "completion_prepared");
    if (!stageValid) throw new Error("transformer_attempt_checkpoint_effect_invalid");
    if (effect.kind === "coordinator_complete") {
      const completionDigest = coordinatorCompletionDigestFromSlot(effect.slot);
      if (completionDigest === null || state.candidateSeal === null) {
        throw new Error("transformer_attempt_checkpoint_effect_invalid");
      }
    }
    if (effect.kind === "verifier") {
      const round = verificationRound(
        state.verificationReceipts,
        state.workspaceArtifact.manifestDigest,
      );
      if (effect.slot !==
          `verification:${state.workspaceArtifact.manifestDigest}:${round}:${state.commandCursor}` ||
          effect.requestDigest !== state.verificationPlan[state.commandCursor]?.commandDigest) {
        throw new Error("transformer_attempt_checkpoint_effect_invalid");
      }
    }
    if (effect.kind === "workspace_publish") {
      const ordinal = state.completedEffects.filter((receipt) =>
        receipt.kind === "workspace_publish"
      ).length;
      const destination = effect.state === "completed"
        ? (effect.resultArtifact as TransformerWorkspaceArtifact).manifestDigest
        : effect.slot.split(":").slice(1, 3).join(":");
      if (effect.slot !== `workspace:${destination}:${ordinal}`) {
        throw new Error("transformer_attempt_checkpoint_effect_invalid");
      }
    }
  }
  if (state.pendingEffect.kind === "workspace_publish" && state.pendingEffect.state === "completed" &&
      !(state.pendingEffect.resultArtifact as TransformerWorkspaceArtifact).storageKey.startsWith(
        `transformer/${state.binding.tenantId}/${state.episodeId}/workspaces/`,
      )) {
    throw new Error("transformer_attempt_checkpoint_effect_invalid");
  }
  if (state.pendingEffect.kind !== "none" &&
      (effectIds.has(state.pendingEffect.effectId) ||
       (state.pendingEffect.kind !== "workspace_publish" && effectSlots.has(state.pendingEffect.slot)))) {
    throw new Error("transformer_attempt_checkpoint_effect_invalid");
  }
  if (state.stage === "terminal") {
    const completions = state.completedEffects.filter((receipt) =>
      receipt.kind === "coordinator_complete" &&
      coordinatorCompletionDigestFromSlot(receipt.slot) !== null
    );
    const completion = completions[0];
    const completionDigest = completion
      ? coordinatorCompletionDigestFromSlot(completion.slot)
      : null;
    if (state.pendingEffect.kind !== "none" || state.candidateSeal === null ||
        state.commandCursor !== state.binding.requiredVerificationCount ||
        state.verificationReceipts.slice(-state.commandCursor).some((receipt) =>
          receipt.workspaceManifestDigest !== state.workspaceArtifact.manifestDigest ||
          receipt.status !== "passed"
        ) ||
        completions.length !== 1 || completion === undefined || completionDigest === null ||
        completion.requestArtifact.payloadDigest !== completion.requestDigest) {
      throw new Error("transformer_attempt_checkpoint_terminal_invalid");
    }
  }
  if (state.candidateSeal !== null) {
    validateCandidateSeal(state.candidateSeal, state.binding, state.workspaceArtifact);
    if (state.commandCursor !== state.binding.requiredVerificationCount ||
        state.verificationReceipts.slice(-state.commandCursor).some((receipt) =>
          receipt.workspaceManifestDigest !== state.workspaceArtifact.manifestDigest ||
          receipt.status !== "passed"
        )) {
      throw new Error("transformer_attempt_checkpoint_candidate_seal_invalid");
    }
  }
  if (STAGES.indexOf(state.stage) >= STAGES.indexOf("candidate_sealed") &&
      state.candidateSeal === null) {
    throw new Error("transformer_attempt_checkpoint_stage_invalid");
  }
}

function normalize(state: TransformerAttemptCheckpointState): TransformerAttemptCheckpointState {
  return { ...state, workspaceManifest: normalizedManifest(state.workspaceManifest) };
}

function encodeState(state: TransformerAttemptCheckpointState): Buffer {
  validateState(state);
  const encoded = Buffer.from(canonical(normalize(state)), "utf8");
  if (encoded.byteLength < 1 || encoded.byteLength > MAX_STATE_BYTES) {
    throw new Error("transformer_attempt_checkpoint_size_invalid");
  }
  return encoded;
}

function aad(input: Readonly<{
  keyId: string;
  episodeId: string;
  generation: number;
  writerLeaseGeneration: number;
  writerLeaseTokenDigest: string;
  stateDigest: string;
}>): Buffer {
  return Buffer.from(canonical({ protocol: PROTOCOL, ...input }), "utf8");
}

function seal(state: TransformerAttemptCheckpointState, key: Uint8Array): TransformerAttemptCheckpointEnvelope {
  const encoded = encodeState(state);
  const stateDigest = sha256(encoded);
  const id = keyId(key);
  const nonce = randomBytes(12);
  const metadata = {
    keyId: id,
    episodeId: state.episodeId,
    generation: state.generation,
    writerLeaseGeneration: state.writerLeaseGeneration,
    writerLeaseTokenDigest: state.writerLeaseTokenDigest,
    stateDigest,
  };
  const cipher = createCipheriv("aes-256-gcm", requireKey(key), nonce);
  cipher.setAAD(aad(metadata));
  const ciphertext = Buffer.concat([cipher.update(encoded), cipher.final()]);
  return Object.freeze({
    schemaVersion: 1,
    protocol: PROTOCOL,
    ...metadata,
    nonceBase64: nonce.toString("base64"),
    ciphertextBase64: ciphertext.toString("base64"),
    authenticationTagBase64: cipher.getAuthTag().toString("base64"),
  });
}

function openAuthenticatedTransformerAttemptCheckpoint(
  envelope: TransformerAttemptCheckpointEnvelope,
  key: Uint8Array,
): TransformerAttemptCheckpointState {
  exactKeys(envelope, [
    "schemaVersion", "protocol", "keyId", "episodeId", "generation", "writerLeaseGeneration",
    "writerLeaseTokenDigest", "stateDigest", "nonceBase64", "ciphertextBase64", "authenticationTagBase64",
  ], "transformer_attempt_checkpoint_envelope_invalid");
  if (envelope.schemaVersion !== 1 || envelope.protocol !== PROTOCOL ||
      envelope.keyId !== keyId(key) || !ID.test(envelope.episodeId) ||
      !/^[a-f0-9]{16}$/.test(envelope.keyId) || !DIGEST.test(envelope.stateDigest) ||
      !DIGEST.test(envelope.writerLeaseTokenDigest) ||
      !Number.isSafeInteger(envelope.generation) || envelope.generation < 1 ||
      !Number.isSafeInteger(envelope.writerLeaseGeneration) || envelope.writerLeaseGeneration < 1 ||
      envelope.ciphertextBase64.length > MAX_ENCODED_BYTES) {
    throw new Error("transformer_attempt_checkpoint_envelope_invalid");
  }
  const nonce = Buffer.from(envelope.nonceBase64, "base64");
  const ciphertext = Buffer.from(envelope.ciphertextBase64, "base64");
  const tag = Buffer.from(envelope.authenticationTagBase64, "base64");
  if (nonce.byteLength !== 12 || tag.byteLength !== 16 ||
      nonce.toString("base64") !== envelope.nonceBase64 ||
      ciphertext.toString("base64") !== envelope.ciphertextBase64 ||
      tag.toString("base64") !== envelope.authenticationTagBase64 ||
      ciphertext.byteLength > MAX_STATE_BYTES) {
    throw new Error("transformer_attempt_checkpoint_envelope_invalid");
  }
  let encoded: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", requireKey(key), nonce);
    decipher.setAAD(aad({
      keyId: envelope.keyId,
      episodeId: envelope.episodeId,
      generation: envelope.generation,
      writerLeaseGeneration: envelope.writerLeaseGeneration,
      writerLeaseTokenDigest: envelope.writerLeaseTokenDigest,
      stateDigest: envelope.stateDigest,
    }));
    decipher.setAuthTag(tag);
    encoded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("transformer_attempt_checkpoint_authentication_failed");
  }
  if (sha256(encoded) !== envelope.stateDigest) {
    throw new Error("transformer_attempt_checkpoint_authentication_failed");
  }
  let parsed: TransformerAttemptCheckpointState;
  try {
    parsed = JSON.parse(encoded.toString("utf8")) as TransformerAttemptCheckpointState;
  } catch {
    throw new Error("transformer_attempt_checkpoint_state_invalid");
  }
  validateState(parsed);
  const normalized = normalize(parsed);
  if (!encodeState(normalized).equals(encoded)) {
    throw new Error("transformer_attempt_checkpoint_noncanonical");
  }
  if (normalized.episodeId !== envelope.episodeId || normalized.generation !== envelope.generation ||
      normalized.writerLeaseGeneration !== envelope.writerLeaseGeneration ||
      normalized.writerLeaseTokenDigest !== envelope.writerLeaseTokenDigest) {
    throw new Error("transformer_attempt_checkpoint_envelope_mismatch");
  }
  return deepFreeze(structuredClone(normalized));
}

export function openTransformerAttemptCheckpoint(
  envelope: TransformerAttemptCheckpointEnvelope,
  key: Uint8Array,
  expectedBinding: TransformerAttemptCheckpointBinding,
): TransformerAttemptCheckpointState {
  const state = openAuthenticatedTransformerAttemptCheckpoint(envelope, key);
  validateBinding(expectedBinding);
  if (canonical(state.binding) !== canonical(expectedBinding)) {
    throw new Error("transformer_attempt_checkpoint_binding_mismatch");
  }
  return state;
}

export function openTransformerAttemptCheckpointForDraftDelivery(
  envelope: TransformerAttemptCheckpointEnvelope,
  key: Uint8Array,
  expectedBinding: TransformerAttemptCheckpointBinding,
): TransformerAttemptCheckpointState {
  const state = openAuthenticatedTransformerAttemptCheckpoint(envelope, key);
  validateBinding(expectedBinding);
  // Delivery reads a completed artifact but executes no recipe or verifier code.
  // The executor revision may therefore be historical; every other authority field stays exact.
  const deliveryBinding = {
    ...expectedBinding,
    executorDigest: state.binding.executorDigest,
  } satisfies TransformerAttemptCheckpointBinding;
  if (canonical(state.binding) !== canonical(deliveryBinding)) {
    throw new Error("transformer_attempt_checkpoint_binding_mismatch");
  }
  return state;
}

function prefix(current: readonly unknown[], next: readonly unknown[]): boolean {
  return current.length <= next.length &&
    current.every((entry, index) => canonical(entry) === canonical(next[index]));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sameAccounting(
  left: TransformerAttemptCheckpointState["accounting"],
  right: TransformerAttemptCheckpointState["accounting"],
): boolean {
  return canonical(left) === canonical(right);
}

function sameUsageAccounting(
  left: TransformerAttemptCheckpointState["accounting"],
  right: TransformerAttemptCheckpointState["accounting"],
): boolean {
  return left.plannerCalls === right.plannerCalls &&
    left.promptTokens === right.promptTokens &&
    left.completionTokens === right.completionTokens &&
    left.totalTokens === right.totalTokens &&
    left.costUsd === right.costUsd;
}

function validateTransition(
  current: TransformerAttemptCheckpointState,
  next: TransformerAttemptCheckpointState,
  activeLease: TransformerAttemptCheckpointLease,
  currentDigest: string,
  completedResultPayload: Uint8Array | null,
): void {
  validateLease(activeLease);
  if (next.generation !== current.generation + 1) {
    throw new Error("transformer_attempt_checkpoint_generation_mismatch");
  }
  if (next.writerLeaseGeneration !== activeLease.generation ||
      next.writerLeaseTokenDigest !== activeLease.tokenDigest ||
      next.attemptNumber !== activeLease.attemptNumber ||
      activeLease.generation < current.writerLeaseGeneration ||
      activeLease.attemptNumber < current.attemptNumber) {
    throw new Error("transformer_attempt_checkpoint_lease_mismatch");
  }
  if (canonical(next.binding) !== canonical(current.binding) || next.episodeId !== current.episodeId ||
      canonical(next.verificationPlan) !== canonical(current.verificationPlan) ||
      next.previousCheckpointDigest !== currentDigest || Date.parse(next.createdAt) < Date.parse(current.createdAt)) {
    throw new Error("transformer_attempt_checkpoint_history_mismatch");
  }
  const currentStage = STAGES.indexOf(current.stage);
  const nextStage = STAGES.indexOf(next.stage);
  if (nextStage < currentStage || nextStage > currentStage + 1 ||
      !prefix(current.verificationReceipts, next.verificationReceipts) ||
      !prefix(current.completedEffects, next.completedEffects) ||
      next.verificationReceipts.length - current.verificationReceipts.length > 1) {
    throw new Error("transformer_attempt_checkpoint_stage_mismatch");
  }
  for (const field of ["plannerCalls", "promptTokens", "completionTokens", "totalTokens",
    "costUsd", "wallTimeMs"] as const) {
    if (next.accounting[field] < current.accounting[field]) {
      throw new Error("transformer_attempt_checkpoint_accounting_regressed");
    }
  }
  const appendedEffects = next.completedEffects.slice(current.completedEffects.length);
  const currentEffect = current.pendingEffect;
  const nextEffect = next.pendingEffect;
  const workspaceChanged = canonical(next.workspaceManifest) !== canonical(current.workspaceManifest) ||
    canonical(next.workspaceArtifact) !== canonical(current.workspaceArtifact);
  const candidateSealChanged = canonical(next.candidateSeal) !== canonical(current.candidateSeal);
  const appendedVerifications = next.verificationReceipts.slice(current.verificationReceipts.length);

  if (nextStage > currentStage && next.stage === "recipe_applied" && !workspaceChanged) {
    throw new Error("transformer_attempt_checkpoint_stage_mismatch");
  }

  if (currentEffect.kind === "none") {
    if (appendedEffects.length !== 0 || appendedVerifications.length !== 0 || workspaceChanged ||
        candidateSealChanged || !sameUsageAccounting(next.accounting, current.accounting) ||
        (nextEffect.kind !== "none" && nextEffect.state !== "prepared")) {
      throw new Error("transformer_attempt_checkpoint_effect_transition_invalid");
    }
    if (nextEffect.kind !== "none" &&
        (nextStage !== currentStage || next.commandCursor !== current.commandCursor ||
         !sameAccounting(next.accounting, current.accounting) ||
         canonical(next.candidateSeal) !== canonical(current.candidateSeal))) {
      throw new Error("transformer_attempt_checkpoint_effect_transition_invalid");
    }
    return;
  }

  const sameEffect = nextEffect.kind !== "none" && nextEffect.kind === currentEffect.kind &&
    nextEffect.effectId === currentEffect.effectId &&
    nextEffect.slot === currentEffect.slot &&
    nextEffect.idempotencyKey === currentEffect.idempotencyKey &&
    nextEffect.requestDigest === currentEffect.requestDigest &&
    canonical(nextEffect.requestArtifact) === canonical(currentEffect.requestArtifact);
  if (currentEffect.state === "prepared") {
    if (appendedEffects.length !== 0 || appendedVerifications.length !== 0 || workspaceChanged || !sameEffect ||
        (nextEffect.state !== "prepared" && nextEffect.state !== "dispatched") ||
        nextStage !== currentStage || next.commandCursor !== current.commandCursor ||
        !sameAccounting(next.accounting, current.accounting) ||
        canonical(next.candidateSeal) !== canonical(current.candidateSeal)) {
      throw new Error("transformer_attempt_checkpoint_effect_transition_invalid");
    }
    return;
  }
  if (currentEffect.state === "dispatched") {
    if (appendedEffects.length !== 0 || appendedVerifications.length !== 0 || workspaceChanged || !sameEffect ||
        (nextEffect.state !== "dispatched" && nextEffect.state !== "completed") ||
        nextStage !== currentStage || next.commandCursor !== current.commandCursor ||
        !sameAccounting(next.accounting, current.accounting) ||
        canonical(next.candidateSeal) !== canonical(current.candidateSeal)) {
      throw new Error("transformer_attempt_checkpoint_effect_transition_invalid");
    }
    return;
  }

  if (currentEffect.state !== "completed") {
    throw new Error("transformer_attempt_checkpoint_effect_transition_invalid");
  }

  if (nextEffect.kind !== "none") {
    if (appendedEffects.length !== 0 || appendedVerifications.length !== 0 || workspaceChanged || !sameEffect ||
        nextEffect.state !== "completed" ||
        canonical(nextEffect.resultArtifact) !== canonical(currentEffect.resultArtifact) ||
        nextStage !== currentStage || next.commandCursor !== current.commandCursor ||
        canonical(next.candidateSeal) !== canonical(current.candidateSeal)) {
      throw new Error("transformer_attempt_checkpoint_effect_transition_invalid");
    }
    return;
  }
  const expectedReceipt = {
    kind: currentEffect.kind,
    effectId: currentEffect.effectId,
    slot: currentEffect.slot,
    idempotencyKey: currentEffect.idempotencyKey,
    requestDigest: currentEffect.requestDigest,
    requestArtifact: currentEffect.requestArtifact,
    resultArtifact: currentEffect.resultArtifact,
  };
  if (appendedEffects.length !== 1 || canonical(appendedEffects[0]) !== canonical(expectedReceipt)) {
    throw new Error("transformer_attempt_checkpoint_effect_transition_invalid");
  }
  if (currentEffect.kind === "verifier") {
    if (completedResultPayload === null) {
      throw new Error("transformer_attempt_checkpoint_verifier_result_invalid");
    }
    const result = parseVerifierEffectResult(completedResultPayload);
    const round = verificationRound(
      current.verificationReceipts,
      current.workspaceArtifact.manifestDigest,
    );
    if (appendedVerifications.length !== 1 ||
        appendedVerifications[0]!.sequence !== current.verificationReceipts.length ||
        appendedVerifications[0]!.round !== round ||
        appendedVerifications[0]!.index !== current.commandCursor ||
        appendedVerifications[0]!.workspaceManifestDigest !== current.workspaceArtifact.manifestDigest ||
        appendedVerifications[0]!.status !== result.status ||
        appendedVerifications[0]!.outputDigest !== result.outputDigest ||
        appendedVerifications[0]!.commandDigest !== currentEffect.requestDigest) {
      throw new Error("transformer_attempt_checkpoint_receipt_invalid");
    }
  } else if (appendedVerifications.length !== 0) {
    throw new Error("transformer_attempt_checkpoint_receipt_invalid");
  }
  if (currentEffect.kind === "coordinator_complete") {
    const expectedCompletionDigest = coordinatorCompletionDigestFromSlot(currentEffect.slot);
    const result = completedResultPayload === null
      ? null
      : parseCoordinatorEffectResult(completedResultPayload);
    if (expectedCompletionDigest === null || result === null || result.status !== "accepted" ||
        result.completionDigest !== expectedCompletionDigest) {
      throw new Error("transformer_attempt_checkpoint_coordinator_result_invalid");
    }
  }
  if (currentEffect.kind === "model") {
    if (completedResultPayload === null) {
      throw new Error("transformer_attempt_checkpoint_model_result_invalid");
    }
    const usage = parseModelEffectResult(completedResultPayload);
    if (next.accounting.plannerCalls !== current.accounting.plannerCalls + 1 ||
        next.accounting.promptTokens !== current.accounting.promptTokens + usage.promptTokens ||
        next.accounting.completionTokens !== current.accounting.completionTokens + usage.completionTokens ||
        next.accounting.totalTokens !== current.accounting.totalTokens + usage.totalTokens ||
        next.accounting.costUsd !== current.accounting.costUsd + usage.costUsd ||
        next.accounting.wallTimeMs !== current.accounting.wallTimeMs + usage.wallTimeMs) {
      throw new Error("transformer_attempt_checkpoint_accounting_invalid");
    }
  } else if (!sameUsageAccounting(next.accounting, current.accounting)) {
    throw new Error("transformer_attempt_checkpoint_accounting_invalid");
  }
  if (workspaceChanged && candidateSealChanged) {
    throw new Error("transformer_attempt_checkpoint_effect_transition_invalid");
  }
  if (workspaceChanged) {
    const workspaceOrdinal = current.completedEffects.filter((receipt) =>
      receipt.kind === "workspace_publish"
    ).length;
    if (currentEffect.kind !== "workspace_publish" ||
        currentEffect.slot !== `workspace:${next.workspaceArtifact.manifestDigest}:${workspaceOrdinal}` ||
        currentEffect.requestDigest !== createTransformerWorkspaceTransitionDigest(
          current.workspaceArtifact,
          next.workspaceArtifact,
        ) || canonical(currentEffect.resultArtifact) !== canonical(next.workspaceArtifact)) {
      throw new Error("transformer_attempt_checkpoint_workspace_transition_invalid");
    }
  }
  if (candidateSealChanged &&
      (currentEffect.kind !== "candidate_publish" ||
       currentEffect.slot !== "candidate:seal" || next.candidateSeal === null ||
       currentEffect.requestDigest !== createTransformerCandidatePublicationRequestDigest(
         next.episodeId,
         next.candidateSeal,
       ) || currentEffect.resultArtifact.payloadDigest !== next.candidateSeal.sealDigest)) {
    throw new Error("transformer_attempt_checkpoint_candidate_transition_invalid");
  }
}

function validateGenesis(
  state: TransformerAttemptCheckpointState,
  activeLease: TransformerAttemptCheckpointLease,
): void {
  validateState(state);
  validateLease(activeLease);
  if (state.generation !== 1 || state.attemptNumber !== activeLease.attemptNumber ||
      state.writerLeaseGeneration !== activeLease.generation ||
      state.writerLeaseTokenDigest !== activeLease.tokenDigest || state.stage !== "source_loaded" ||
      state.commandCursor !== 0 || state.verificationReceipts.length !== 0 ||
      state.completedEffects.length !== 0 || state.pendingEffect.kind !== "none" ||
      state.candidateSeal !== null || state.previousCheckpointDigest !== null ||
      state.binding.sourceManifestDigest !== state.workspaceArtifact.manifestDigest ||
      Object.values(state.accounting).some((value) => value !== 0)) {
    throw new Error("transformer_attempt_checkpoint_genesis_invalid");
  }
}

function sameState(
  envelope: TransformerAttemptCheckpointEnvelope,
  state: TransformerAttemptCheckpointState,
  key: Uint8Array,
): boolean {
  try {
    const existing = openTransformerAttemptCheckpoint(envelope, key, state.binding);
    return canonical(existing) === canonical(normalize(state));
  } catch {
    return false;
  }
}

async function verifyWorkspaceStored(
  journal: TransformerAttemptCheckpointJournal,
  state: TransformerAttemptCheckpointState,
  key: Uint8Array,
): Promise<void> {
  const bytes = await journal.readArtifact(state.workspaceArtifact.storageKey);
  if (bytes === null) throw new Error("transformer_attempt_checkpoint_artifact_missing");
  const manifest = verifyTransformerWorkspaceArtifact(
    state.workspaceArtifact,
    bytes,
    key,
    { tenantId: state.binding.tenantId, episodeId: state.episodeId },
  );
  if (canonical(manifest) !== canonical(normalizedManifest(state.workspaceManifest))) {
    throw new Error("transformer_attempt_checkpoint_workspace_artifact_mismatch");
  }
}

async function verifyCompletedEffectStored(
  journal: TransformerAttemptCheckpointJournal,
  state: TransformerAttemptCheckpointState,
  key: Uint8Array,
): Promise<Uint8Array | null> {
  const effect = state.pendingEffect;
  if (effect.kind === "none" || effect.state !== "completed") return null;
  const bytes = await journal.readArtifact(effect.resultArtifact.storageKey);
  if (bytes === null) throw new Error("transformer_attempt_checkpoint_artifact_missing");
  if (effect.kind === "workspace_publish") {
    verifyTransformerWorkspaceArtifact(
      effect.resultArtifact as TransformerWorkspaceArtifact,
      bytes,
      key,
      { tenantId: state.binding.tenantId, episodeId: state.episodeId },
    );
    return null;
  }
  return verifyTransformerEffectResultArtifact(
    effect.resultArtifact as TransformerEncryptedArtifact,
    bytes,
    key,
    { tenantId: state.binding.tenantId, episodeId: state.episodeId, effectId: effect.effectId },
  );
}

async function verifyPendingEffectRequestStored(
  journal: TransformerAttemptCheckpointJournal,
  state: TransformerAttemptCheckpointState,
  key: Uint8Array,
): Promise<Uint8Array | null> {
  const effect = state.pendingEffect;
  if (effect.kind === "none") return null;
  const bytes = await journal.readArtifact(effect.requestArtifact.storageKey);
  if (bytes === null) throw new Error("transformer_attempt_checkpoint_artifact_missing");
  const payload = verifyTransformerEffectRequestArtifact(
    effect.requestArtifact,
    bytes,
    key,
    { tenantId: state.binding.tenantId, episodeId: state.episodeId, effectId: effect.effectId },
  );
  if (effect.kind === "coordinator_complete") {
    const request = openTransformerCoordinatorCompletionRequest(payload);
    const expectedCompletionDigest = coordinatorCompletionDigestFromSlot(effect.slot);
    if (expectedCompletionDigest === null || state.candidateSeal === null ||
        request.episodeId !== state.episodeId ||
        canonical(request.seal) !== canonical(state.candidateSeal) ||
        request.completionDigest !== expectedCompletionDigest ||
        request.completionIntent.tenantId !== state.binding.tenantId ||
        request.completionIntent.campaignId !== state.binding.campaignId ||
        request.completionIntent.unitId !== state.binding.unitId ||
        request.completionIntent.attemptNumber !== state.attemptNumber ||
        request.completionIntent.leaseGeneration !== state.writerLeaseGeneration ||
        request.completionIntent.leaseTokenDigest !== state.writerLeaseTokenDigest ||
        request.completionIntent.sourceRevision !== state.binding.sourceRevision ||
        request.completionIntent.candidateRevision !== state.binding.candidateRevision ||
        request.completionIntent.candidateDigest !== state.binding.candidateDigest) {
      throw new Error("transformer_attempt_checkpoint_effect_invalid");
    }
  }
  return payload;
}

export async function commitTransformerAttemptCheckpointGenesis(
  journal: TransformerAttemptCheckpointJournal,
  state: TransformerAttemptCheckpointState,
  key: Uint8Array,
): Promise<TransformerAttemptCheckpointEnvelope> {
  const activeLease = await journal.readLease(state.episodeId);
  if (activeLease === null) throw new Error("transformer_attempt_checkpoint_lease_mismatch");
  validateGenesis(state, activeLease);
  await verifyWorkspaceStored(journal, state, key);
  const current = await journal.read(state.episodeId);
  if (current !== null) {
    if (sameState(current, state, key)) return current;
    throw new Error("transformer_attempt_checkpoint_genesis_conflict");
  }
  const next = seal(state, key);
  if (await journal.compareAndSwap({
    episodeId: state.episodeId,
    expectedStateDigest: null,
    activeLease,
    next,
  })) {
    return next;
  }
  const raced = await journal.read(state.episodeId);
  if (raced !== null && sameState(raced, state, key)) return raced;
  throw new Error("transformer_attempt_checkpoint_head_conflict");
}

export async function prepareTransformerAttemptCheckpointAdvance(
  journal: TransformerAttemptCheckpointJournal,
  expectedHeadDigest: string,
  nextState: TransformerAttemptCheckpointState,
  key: Uint8Array,
  expectedBinding: TransformerAttemptCheckpointBinding,
): Promise<TransformerPreparedAttemptCheckpointAdvance> {
  requireDigest(expectedHeadDigest, "transformer_attempt_checkpoint_head_invalid");
  if (nextState.stage === "terminal") {
    throw new Error("transformer_attempt_checkpoint_terminal_atomic_required");
  }
  const currentEnvelope = await journal.read(createTransformerEpisodeId(expectedBinding));
  if (currentEnvelope === null || currentEnvelope.stateDigest !== expectedHeadDigest) {
    if (currentEnvelope !== null && sameState(currentEnvelope, nextState, key)) {
      return Object.freeze({ kind: "replay", envelope: currentEnvelope });
    }
    throw new Error("transformer_attempt_checkpoint_head_conflict");
  }
  const current = openTransformerAttemptCheckpoint(currentEnvelope, key, expectedBinding);
  const activeLease = await journal.readLease(current.episodeId);
  if (activeLease === null) throw new Error("transformer_attempt_checkpoint_lease_mismatch");
  validateState(nextState);
  await verifyPendingEffectRequestStored(journal, current, key);
  const completedResultPayload = await verifyCompletedEffectStored(journal, current, key);
  validateTransition(
    current,
    nextState,
    activeLease,
    currentEnvelope.stateDigest,
    completedResultPayload,
  );
  await verifyPendingEffectRequestStored(journal, nextState, key);
  if (canonical(nextState.workspaceArtifact) !== canonical(current.workspaceArtifact)) {
    await verifyWorkspaceStored(journal, nextState, key);
  }
  await verifyCompletedEffectStored(journal, nextState, key);
  const next = seal(nextState, key);
  return Object.freeze({
    kind: "advance",
    operation: Object.freeze({
      episodeId: current.episodeId,
      expectedStateDigest: currentEnvelope.stateDigest,
      activeLease: Object.freeze({ ...activeLease }),
      next,
    }),
  });
}

export async function prepareTransformerAttemptCheckpointTerminalAdvance(
  journal: TransformerAttemptCheckpointJournal,
  expectedHeadDigest: string,
  resultArtifact: TransformerEncryptedArtifact,
  createdAt: string,
  key: Uint8Array,
  expectedBinding: TransformerAttemptCheckpointBinding,
): Promise<TransformerPreparedAttemptCheckpointAdvance> {
  requireDigest(expectedHeadDigest, "transformer_attempt_checkpoint_head_invalid");
  const currentEnvelope = await journal.read(createTransformerEpisodeId(expectedBinding));
  if (currentEnvelope === null || currentEnvelope.stateDigest !== expectedHeadDigest) {
    throw new Error("transformer_attempt_checkpoint_head_conflict");
  }
  const current = openTransformerAttemptCheckpoint(currentEnvelope, key, expectedBinding);
  const activeLease = await journal.readLease(current.episodeId);
  if (activeLease === null) throw new Error("transformer_attempt_checkpoint_lease_mismatch");
  validateLease(activeLease);
  if (current.stage !== "completion_prepared" ||
      current.pendingEffect.kind !== "coordinator_complete" ||
      current.pendingEffect.state !== "dispatched" ||
      current.attemptNumber !== activeLease.attemptNumber ||
      current.writerLeaseGeneration !== activeLease.generation ||
      current.writerLeaseTokenDigest !== activeLease.tokenDigest ||
      !Number.isFinite(Date.parse(createdAt)) || new Date(Date.parse(createdAt)).toISOString() !== createdAt ||
      Date.parse(createdAt) < Date.parse(current.createdAt)) {
    throw new Error("transformer_attempt_checkpoint_terminal_invalid");
  }
  await verifyPendingEffectRequestStored(journal, current, key);
  const completedEffect = {
    ...current.pendingEffect,
    state: "completed" as const,
    resultArtifact,
  };
  const completedState = { ...current, pendingEffect: completedEffect };
  validateState(completedState);
  const completedResultPayload = await verifyCompletedEffectStored(journal, completedState, key);
  const expectedCompletionDigest = coordinatorCompletionDigestFromSlot(current.pendingEffect.slot);
  const result = completedResultPayload === null
    ? null
    : parseCoordinatorEffectResult(completedResultPayload);
  if (expectedCompletionDigest === null || result === null || result.status !== "accepted" ||
      result.completionDigest !== expectedCompletionDigest) {
    throw new Error("transformer_attempt_checkpoint_coordinator_result_invalid");
  }
  const receipt = {
    kind: current.pendingEffect.kind,
    effectId: current.pendingEffect.effectId,
    slot: current.pendingEffect.slot,
    idempotencyKey: current.pendingEffect.idempotencyKey,
    requestDigest: current.pendingEffect.requestDigest,
    requestArtifact: current.pendingEffect.requestArtifact,
    resultArtifact,
  } satisfies TransformerAttemptCheckpointEffectReceipt;
  const terminalState = {
    ...current,
    generation: current.generation + 1,
    stage: "terminal" as const,
    completedEffects: [...current.completedEffects, receipt],
    pendingEffect: { kind: "none" as const },
    previousCheckpointDigest: currentEnvelope.stateDigest,
    createdAt,
  } satisfies TransformerAttemptCheckpointState;
  validateState(terminalState);
  const next = seal(terminalState, key);
  return Object.freeze({
    kind: "advance" as const,
    operation: Object.freeze({
      episodeId: current.episodeId,
      expectedStateDigest: currentEnvelope.stateDigest,
      activeLease: Object.freeze({ ...activeLease }),
      next,
    }),
  });
}

export async function supersedeTransformerAttemptCheckpointCoordinatorCompletion(
  journal: TransformerAttemptCheckpointJournal,
  expectedHeadDigest: string,
  nextEffect: Exclude<TransformerAttemptCheckpointEffect, Readonly<{ kind: "none" }>>,
  createdAt: string,
  key: Uint8Array,
  expectedBinding: TransformerAttemptCheckpointBinding,
): Promise<TransformerAttemptCheckpointEnvelope> {
  requireDigest(expectedHeadDigest, "transformer_attempt_checkpoint_head_invalid");
  const currentEnvelope = await journal.read(createTransformerEpisodeId(expectedBinding));
  if (currentEnvelope === null || currentEnvelope.stateDigest !== expectedHeadDigest) {
    throw new Error("transformer_attempt_checkpoint_head_conflict");
  }
  const current = openTransformerAttemptCheckpoint(currentEnvelope, key, expectedBinding);
  const activeLease = await journal.readLease(current.episodeId);
  if (activeLease === null) throw new Error("transformer_attempt_checkpoint_lease_mismatch");
  validateLease(activeLease);
  const newerLease = activeLease.attemptNumber > current.attemptNumber ||
    (activeLease.attemptNumber === current.attemptNumber &&
      activeLease.generation > current.writerLeaseGeneration);
  if (!newerLease || current.stage !== "completion_prepared" || current.candidateSeal === null ||
      current.pendingEffect.kind !== "coordinator_complete" ||
      (current.pendingEffect.state !== "prepared" && current.pendingEffect.state !== "dispatched") ||
      nextEffect.kind !== "coordinator_complete" || nextEffect.state !== "prepared" ||
      !Number.isFinite(Date.parse(createdAt)) || new Date(Date.parse(createdAt)).toISOString() !== createdAt ||
      Date.parse(createdAt) < Date.parse(current.createdAt)) {
    throw new Error("transformer_attempt_checkpoint_coordinator_takeover_invalid");
  }
  const nextState = {
    ...current,
    generation: current.generation + 1,
    attemptNumber: activeLease.attemptNumber,
    writerLeaseGeneration: activeLease.generation,
    writerLeaseTokenDigest: activeLease.tokenDigest,
    pendingEffect: nextEffect,
    previousCheckpointDigest: currentEnvelope.stateDigest,
    createdAt,
  } satisfies TransformerAttemptCheckpointState;
  validateState(nextState);
  await verifyPendingEffectRequestStored(journal, nextState, key);
  const next = seal(nextState, key);
  if (await journal.compareAndSwap({
    episodeId: current.episodeId,
    expectedStateDigest: currentEnvelope.stateDigest,
    activeLease,
    next,
  })) {
    return next;
  }
  const raced = await journal.read(current.episodeId);
  if (raced !== null && sameState(raced, nextState, key)) return raced;
  throw new Error("transformer_attempt_checkpoint_head_conflict");
}

export async function upgradeTransformerAttemptCheckpointCoordinatorCompletionRequest(
  journal: TransformerAttemptCheckpointJournal,
  expectedHeadDigest: string,
  nextEffect: Exclude<TransformerAttemptCheckpointEffect, Readonly<{ kind: "none" }>>,
  createdAt: string,
  key: Uint8Array,
  expectedBinding: TransformerAttemptCheckpointBinding,
): Promise<TransformerAttemptCheckpointEnvelope> {
  requireDigest(expectedHeadDigest, "transformer_attempt_checkpoint_head_invalid");
  const currentEnvelope = await journal.read(createTransformerEpisodeId(expectedBinding));
  if (currentEnvelope === null || currentEnvelope.stateDigest !== expectedHeadDigest) {
    throw new Error("transformer_attempt_checkpoint_head_conflict");
  }
  const current = openTransformerAttemptCheckpoint(currentEnvelope, key, expectedBinding);
  const activeLease = await journal.readLease(current.episodeId);
  if (activeLease === null) throw new Error("transformer_attempt_checkpoint_lease_mismatch");
  validateLease(activeLease);
  const sameLease = activeLease.attemptNumber === current.attemptNumber &&
    activeLease.generation === current.writerLeaseGeneration &&
    activeLease.tokenDigest === current.writerLeaseTokenDigest;
  const previousEffect = current.pendingEffect;
  if (!sameLease || current.stage !== "completion_prepared" || current.candidateSeal === null ||
      previousEffect.kind !== "coordinator_complete" ||
      (previousEffect.state !== "prepared" && previousEffect.state !== "dispatched") ||
      nextEffect.kind !== "coordinator_complete" || nextEffect.state !== "prepared" ||
      nextEffect.slot !== previousEffect.slot ||
      !Number.isFinite(Date.parse(createdAt)) || new Date(Date.parse(createdAt)).toISOString() !== createdAt ||
      Date.parse(createdAt) < Date.parse(current.createdAt)) {
    throw new Error("transformer_attempt_checkpoint_completion_upgrade_invalid");
  }
  const [previousBytes, nextBytes] = await Promise.all([
    journal.readArtifact(previousEffect.requestArtifact.storageKey),
    journal.readArtifact(nextEffect.requestArtifact.storageKey),
  ]);
  if (previousBytes === null || nextBytes === null) {
    throw new Error("transformer_attempt_checkpoint_artifact_missing");
  }
  const previousPayload = verifyTransformerEffectRequestArtifact(
    previousEffect.requestArtifact,
    previousBytes,
    key,
    { tenantId: current.binding.tenantId, episodeId: current.episodeId, effectId: previousEffect.effectId },
  );
  const nextPayload = verifyTransformerEffectRequestArtifact(
    nextEffect.requestArtifact,
    nextBytes,
    key,
    { tenantId: current.binding.tenantId, episodeId: current.episodeId, effectId: nextEffect.effectId },
  );
  const previousRequest = openTransformerCoordinatorCompletionRequest(previousPayload);
  const nextRequest = openTransformerCoordinatorCompletionRequest(nextPayload);
  if (previousRequest.artifactRegistration !== undefined ||
      nextRequest.artifactRegistration?.schemaVersion !== 2 ||
      canonical({ ...previousRequest, artifactRegistration: undefined }) !==
        canonical({ ...nextRequest, artifactRegistration: undefined })) {
    throw new Error("transformer_attempt_checkpoint_completion_upgrade_invalid");
  }
  const nextState = {
    ...current,
    generation: current.generation + 1,
    pendingEffect: nextEffect,
    previousCheckpointDigest: currentEnvelope.stateDigest,
    createdAt,
  } satisfies TransformerAttemptCheckpointState;
  validateState(nextState);
  await verifyPendingEffectRequestStored(journal, nextState, key);
  const next = seal(nextState, key);
  if (await journal.compareAndSwap({
    episodeId: current.episodeId,
    expectedStateDigest: currentEnvelope.stateDigest,
    activeLease,
    next,
  })) return next;
  const raced = await journal.read(current.episodeId);
  if (raced !== null && sameState(raced, nextState, key)) return raced;
  throw new Error("transformer_attempt_checkpoint_head_conflict");
}

export async function supersedeTransformerAttemptCheckpointFailedVerifier(
  journal: TransformerAttemptCheckpointJournal,
  expectedHeadDigest: string,
  createdAt: string,
  key: Uint8Array,
  expectedBinding: TransformerAttemptCheckpointBinding,
): Promise<TransformerAttemptCheckpointEnvelope> {
  requireDigest(expectedHeadDigest, "transformer_attempt_checkpoint_head_invalid");
  const currentEnvelope = await journal.read(createTransformerEpisodeId(expectedBinding));
  if (currentEnvelope === null || currentEnvelope.stateDigest !== expectedHeadDigest) {
    throw new Error("transformer_attempt_checkpoint_head_conflict");
  }
  const current = openTransformerAttemptCheckpoint(currentEnvelope, key, expectedBinding);
  const activeLease = await journal.readLease(current.episodeId);
  if (activeLease === null) throw new Error("transformer_attempt_checkpoint_lease_mismatch");
  validateLease(activeLease);
  const newerLease = activeLease.attemptNumber > current.attemptNumber ||
    (activeLease.attemptNumber === current.attemptNumber &&
      activeLease.generation > current.writerLeaseGeneration);
  const effect = current.pendingEffect;
  if (!newerLease || current.stage !== "verification" || effect.kind !== "verifier" ||
      effect.state !== "completed" ||
      !Number.isFinite(Date.parse(createdAt)) || new Date(Date.parse(createdAt)).toISOString() !== createdAt ||
      Date.parse(createdAt) < Date.parse(current.createdAt)) {
    throw new Error("transformer_attempt_checkpoint_verifier_retry_invalid");
  }
  const resultBytes = await journal.readArtifact(effect.resultArtifact.storageKey);
  if (resultBytes === null) throw new Error("transformer_attempt_checkpoint_artifact_missing");
  const result = openTransformerVerifierEffectResultArtifact(
    effect.resultArtifact,
    resultBytes,
    key,
    { tenantId: expectedBinding.tenantId, episodeId: current.episodeId, effectId: effect.effectId },
  );
  if (result.status !== "failed") {
    throw new Error("transformer_attempt_checkpoint_verifier_retry_invalid");
  }
  const nextState = {
    ...current,
    generation: current.generation + 1,
    attemptNumber: activeLease.attemptNumber,
    writerLeaseGeneration: activeLease.generation,
    writerLeaseTokenDigest: activeLease.tokenDigest,
    pendingEffect: Object.freeze({
      kind: "verifier" as const,
      state: "prepared" as const,
      effectId: effect.effectId,
      slot: effect.slot,
      idempotencyKey: effect.idempotencyKey,
      requestDigest: effect.requestDigest,
      requestArtifact: effect.requestArtifact,
    }),
    previousCheckpointDigest: currentEnvelope.stateDigest,
    createdAt,
  } satisfies TransformerAttemptCheckpointState;
  validateState(nextState);
  await verifyPendingEffectRequestStored(journal, nextState, key);
  const next = seal(nextState, key);
  if (await journal.compareAndSwap({
    episodeId: current.episodeId,
    expectedStateDigest: currentEnvelope.stateDigest,
    activeLease,
    next,
  })) {
    return next;
  }
  const raced = await journal.read(current.episodeId);
  if (raced !== null && sameState(raced, nextState, key)) return raced;
  throw new Error("transformer_attempt_checkpoint_head_conflict");
}

export async function advanceTransformerAttemptCheckpoint(
  journal: TransformerAttemptCheckpointJournal,
  expectedHeadDigest: string,
  nextState: TransformerAttemptCheckpointState,
  key: Uint8Array,
  expectedBinding: TransformerAttemptCheckpointBinding,
): Promise<TransformerAttemptCheckpointEnvelope> {
  const prepared = await prepareTransformerAttemptCheckpointAdvance(
    journal,
    expectedHeadDigest,
    nextState,
    key,
    expectedBinding,
  );
  if (prepared.kind === "replay") return prepared.envelope;
  if (await journal.compareAndSwap(prepared.operation)) return prepared.operation.next;
  const raced = await journal.read(prepared.operation.episodeId);
  if (raced !== null && sameState(raced, nextState, key)) return raced;
  throw new Error("transformer_attempt_checkpoint_head_conflict");
}
