import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { AgentStep, ToolName } from "./types.js";
import {
  decodeWardenRuntimeState,
  projectWardenCheckpointPayload,
  validateWardenRuntimeStateTransition,
  type WardenPrivateRuntimeStateV1,
} from "./runtime-state.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HMAC_DIGEST = /^hmac-sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const GIT_REVISION = /^[a-f0-9]{40}$/;
const DIAGNOSTIC_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const RELATIVE_PATH = /^(?![A-Za-z]:)(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).{1,1000}$/;
const MAX_STEPS = 256;
const MAX_EVIDENCE_FILES = 512;
const MAX_DIRECTORIES = 512;
const MAX_SEARCHES = 512;
const MAX_CHANGED_FILES = 256;
const MAX_ACTION_FINGERPRINTS = 512;
const MAX_PRIVATE_RUNTIME_STATE_BYTES = 64 * 1024 * 1024;
const COUNTER_KEYS = [
  "mutationCount",
  "toolCalls",
  "verifierCalls",
  "modelCalls",
  "modelSuccessfulCalls",
  "modelFailedCalls",
  "promptTokens",
  "completionTokens",
  "totalTokens",
  "costUsd",
  "observedBytes",
  "searchBytes",
  "changedBytes",
  "groundedMutations",
  "blockedMutations",
] as const;

export type WardenCheckpointBinding = Readonly<{
  schemaVersion: 1;
  tenantId: string;
  jobId: string;
  attemptId: string;
  repositoryId: string;
  snapshotId: string;
  revision: string;
  sourceManifestSha256: string;
  allowedPathsDigest: string;
  verificationProfileDigest: string;
  modelPolicyDigest: string;
}>;

export type WardenCheckpointStep = Readonly<{
  step: number;
  tool: ToolName;
  ok: boolean;
  summary: string;
  error?: string;
  plannerSource: NonNullable<AgentStep["plannerSource"]>;
  callDigest: string;
  resultDigest: string;
}>;

export type WardenCheckpointSourceEvidence = Readonly<{
  path: string;
  digest: string;
  bytes: number;
  totalChars: number;
  ranges: readonly Readonly<{ start: number; end: number }>[];
  fullyObserved: boolean;
}>;

export type WardenCheckpointCounters = Readonly<{
  mutationCount: number;
  toolCalls: number;
  verifierCalls: number;
  modelCalls: number;
  modelSuccessfulCalls: number;
  modelFailedCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  observedBytes: number;
  searchBytes: number;
  changedBytes: number;
  groundedMutations: number;
  blockedMutations: number;
}>;

export type WardenCheckpointPayload = Readonly<{
  schemaVersion: 1;
  binding: WardenCheckpointBinding;
  generation: number;
  writerLeaseGeneration: number;
  workspaceName: string;
  workspaceDigest: string;
  runtimeStateCommitment: string;
  phase: "agent_running" | "verification_feedback" | "terminal";
  nextStep: number;
  steps: readonly WardenCheckpointStep[];
  sourceEvidence: readonly WardenCheckpointSourceEvidence[];
  observedDirectories: readonly string[];
  searchDigests: readonly string[];
  changedFiles: readonly Readonly<{ path: string; digest: string }>[];
  actionFingerprints: readonly Readonly<{
    callDigest: string;
    resultDigest: string;
    mutationCount: number;
  }>[];
  counters: WardenCheckpointCounters;
  previousEnvelopeDigest: string | null;
  createdAt: string;
}>;

export type WardenCheckpointEnvelope = Readonly<{
  schemaVersion: 1;
  algorithm: "HMAC-SHA256";
  payload: WardenCheckpointPayload;
  payloadDigest: string;
  authenticationTag: string;
}>;

export type WardenSealedRuntimeState = Readonly<{
  schemaVersion: 1;
  algorithm: "AES-256-GCM";
  runtimeSchemaVersion: 1;
  codec: "opaque-bytes-v1";
  keyId: string;
  checkpointPayloadDigest: string;
  runtimeStateCommitment: string;
  plaintextBytes: number;
  nonce: string;
  ciphertext: string;
  authenticationTag: string;
}>;

export type WardenCheckpointJournalRecord = Readonly<{
  envelope: WardenCheckpointEnvelope | null;
  sealedRuntimeState: WardenSealedRuntimeState | null;
  activeWriterLeaseGeneration: number;
}>;

export type WardenCheckpointJournal = Readonly<{
  read: (binding: WardenCheckpointBinding) => Promise<WardenCheckpointJournalRecord>;
  compareAndSwap: (input: Readonly<{
    binding: WardenCheckpointBinding;
    expectedPayloadDigest: string | null;
    expectedActiveWriterLeaseGeneration: number;
    nextEnvelope: WardenCheckpointEnvelope;
    nextSealedRuntimeState: WardenSealedRuntimeState;
  }>) => Promise<boolean>;
}>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`
  ).join(",")}}`;
}

function validateRuntimeProjection(
  runtimeState: Uint8Array,
  payload: WardenCheckpointPayload,
  key: Uint8Array,
  expectedBinding: WardenCheckpointBinding,
): WardenPrivateRuntimeStateV1 {
  let projected: WardenCheckpointPayload;
  let decoded: WardenPrivateRuntimeStateV1;
  try {
    decoded = decodeWardenRuntimeState(runtimeState, expectedBinding);
    projected = projectWardenCheckpointPayload(decoded, key);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("warden_runtime_state_")) {
      throw new Error("warden_checkpoint_runtime_projection_mismatch");
    }
    throw error;
  }
  if (canonical(projected) !== canonical(payload)) {
    throw new Error("warden_checkpoint_runtime_projection_mismatch");
  }
  return decoded;
}

function exactKeys(value: object, expected: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(code);
  }
}

function positiveInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
}

function nonnegativeInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
}

function validText(value: string, max: number, code: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(code);
}

function validDigest(value: string, code: string): void {
  if (!DIGEST.test(value)) throw new Error(code);
}

function validRelativePath(value: string, code: string): void {
  if (!RELATIVE_PATH.test(value) || value.includes("\\")) throw new Error(code);
}

function validateBinding(value: WardenCheckpointBinding): void {
  exactKeys(value, [
    "schemaVersion",
    "tenantId",
    "jobId",
    "attemptId",
    "repositoryId",
    "snapshotId",
    "revision",
    "sourceManifestSha256",
    "allowedPathsDigest",
    "verificationProfileDigest",
    "modelPolicyDigest",
  ], "warden_checkpoint_binding_invalid");
  if (value.schemaVersion !== 1) throw new Error("warden_checkpoint_binding_invalid");
  for (const id of [
    value.tenantId,
    value.jobId,
    value.attemptId,
    value.repositoryId,
    value.snapshotId,
  ]) {
    if (!IDENTIFIER.test(id)) throw new Error("warden_checkpoint_binding_invalid");
  }
  if (!GIT_REVISION.test(value.revision)) throw new Error("warden_checkpoint_binding_invalid");
  validDigest(value.sourceManifestSha256, "warden_checkpoint_binding_invalid");
  validDigest(value.allowedPathsDigest, "warden_checkpoint_binding_invalid");
  validDigest(value.verificationProfileDigest, "warden_checkpoint_binding_invalid");
  validDigest(value.modelPolicyDigest, "warden_checkpoint_binding_invalid");
}

function validateStep(value: WardenCheckpointStep): void {
  exactKeys(value, [
    "step",
    "tool",
    "ok",
    "summary",
    ...(value.error === undefined ? [] : ["error"]),
    "plannerSource",
    "callDigest",
    "resultDigest",
  ], "warden_checkpoint_step_invalid");
  if (!Number.isFinite(value.step) || value.step < 0 || value.step > 10_000) {
    throw new Error("warden_checkpoint_step_invalid");
  }
  if (![
    "list_dir",
    "read_file",
    "search",
    "write_file",
    "replace_in_file",
    "run_command",
    "http_probe",
    "finish",
  ].includes(value.tool)) throw new Error("warden_checkpoint_step_invalid");
  if (typeof value.ok !== "boolean") throw new Error("warden_checkpoint_step_invalid");
  if (typeof value.summary !== "string" || !DIAGNOSTIC_CODE.test(value.summary)) {
    throw new Error("warden_checkpoint_step_invalid");
  }
  if (value.error !== undefined &&
      (typeof value.error !== "string" || !DIAGNOSTIC_CODE.test(value.error))) {
    throw new Error("warden_checkpoint_step_invalid");
  }
  if (!["model", "heuristic", "system"].includes(value.plannerSource)) {
    throw new Error("warden_checkpoint_step_invalid");
  }
  validDigest(value.callDigest, "warden_checkpoint_step_invalid");
  validDigest(value.resultDigest, "warden_checkpoint_step_invalid");
}

function validateSourceEvidence(value: WardenCheckpointSourceEvidence): void {
  exactKeys(value, [
    "path",
    "digest",
    "bytes",
    "totalChars",
    "ranges",
    "fullyObserved",
  ], "warden_checkpoint_source_evidence_invalid");
  validRelativePath(value.path, "warden_checkpoint_source_evidence_invalid");
  validDigest(value.digest, "warden_checkpoint_source_evidence_invalid");
  nonnegativeInteger(value.bytes, "warden_checkpoint_source_evidence_invalid");
  nonnegativeInteger(value.totalChars, "warden_checkpoint_source_evidence_invalid");
  if (!Array.isArray(value.ranges) || value.ranges.length > 256) {
    throw new Error("warden_checkpoint_source_evidence_invalid");
  }
  let priorEnd = 0;
  for (const range of value.ranges) {
    exactKeys(range, ["start", "end"], "warden_checkpoint_source_evidence_invalid");
    nonnegativeInteger(range.start, "warden_checkpoint_source_evidence_invalid");
    nonnegativeInteger(range.end, "warden_checkpoint_source_evidence_invalid");
    if (range.start < priorEnd || range.end < range.start || range.end > value.totalChars) {
      throw new Error("warden_checkpoint_source_evidence_invalid");
    }
    priorEnd = range.end;
  }
  if (typeof value.fullyObserved !== "boolean") {
    throw new Error("warden_checkpoint_source_evidence_invalid");
  }
  const coversAll = value.totalChars === 0 ||
    (value.ranges.length === 1 && value.ranges[0]!.start === 0 && value.ranges[0]!.end === value.totalChars);
  if (value.fullyObserved !== coversAll) {
    throw new Error("warden_checkpoint_source_evidence_invalid");
  }
}

function validateCounters(value: WardenCheckpointCounters): void {
  exactKeys(value, COUNTER_KEYS, "warden_checkpoint_counters_invalid");
  for (const key of COUNTER_KEYS) {
    if (key === "costUsd") continue;
    nonnegativeInteger(value[key], "warden_checkpoint_counters_invalid");
  }
  if (!Number.isFinite(value.costUsd) || value.costUsd < 0 || value.costUsd > 1_000_000) {
    throw new Error("warden_checkpoint_counters_invalid");
  }
  if (value.totalTokens !== value.promptTokens + value.completionTokens) {
    throw new Error("warden_checkpoint_counters_invalid");
  }
  if (value.modelSuccessfulCalls + value.modelFailedCalls > value.modelCalls) {
    throw new Error("warden_checkpoint_counters_invalid");
  }
}

function validatePayload(value: WardenCheckpointPayload): void {
  exactKeys(value, [
    "schemaVersion",
    "binding",
    "generation",
    "writerLeaseGeneration",
    "workspaceName",
    "workspaceDigest",
    "runtimeStateCommitment",
    "phase",
    "nextStep",
    "steps",
    "sourceEvidence",
    "observedDirectories",
    "searchDigests",
    "changedFiles",
    "actionFingerprints",
    "counters",
    "previousEnvelopeDigest",
    "createdAt",
  ], "warden_checkpoint_payload_invalid");
  if (value.schemaVersion !== 1) throw new Error("warden_checkpoint_payload_invalid");
  validateBinding(value.binding);
  positiveInteger(value.generation, "warden_checkpoint_generation_invalid");
  positiveInteger(value.writerLeaseGeneration, "warden_checkpoint_lease_invalid");
  if (!WORKSPACE_NAME.test(value.workspaceName)) throw new Error("warden_checkpoint_workspace_invalid");
  validDigest(value.workspaceDigest, "warden_checkpoint_workspace_invalid");
  if (!HMAC_DIGEST.test(value.runtimeStateCommitment)) {
    throw new Error("warden_checkpoint_runtime_state_invalid");
  }
  if (!["agent_running", "verification_feedback", "terminal"].includes(value.phase)) {
    throw new Error("warden_checkpoint_phase_invalid");
  }
  nonnegativeInteger(value.nextStep, "warden_checkpoint_next_step_invalid");
  if (!Array.isArray(value.steps) || value.steps.length > MAX_STEPS) {
    throw new Error("warden_checkpoint_steps_invalid");
  }
  value.steps.forEach(validateStep);
  if (!Array.isArray(value.sourceEvidence) || value.sourceEvidence.length > MAX_EVIDENCE_FILES) {
    throw new Error("warden_checkpoint_source_evidence_invalid");
  }
  value.sourceEvidence.forEach(validateSourceEvidence);
  if (!Array.isArray(value.observedDirectories) || value.observedDirectories.length > MAX_DIRECTORIES) {
    throw new Error("warden_checkpoint_directories_invalid");
  }
  for (const path of value.observedDirectories) validRelativePath(path, "warden_checkpoint_directories_invalid");
  if (!Array.isArray(value.searchDigests) || value.searchDigests.length > MAX_SEARCHES) {
    throw new Error("warden_checkpoint_searches_invalid");
  }
  value.searchDigests.forEach((digest) => validDigest(digest, "warden_checkpoint_searches_invalid"));
  if (!Array.isArray(value.changedFiles) || value.changedFiles.length > MAX_CHANGED_FILES) {
    throw new Error("warden_checkpoint_changed_files_invalid");
  }
  for (const file of value.changedFiles) {
    exactKeys(file, ["path", "digest"], "warden_checkpoint_changed_files_invalid");
    validRelativePath(file.path, "warden_checkpoint_changed_files_invalid");
    validDigest(file.digest, "warden_checkpoint_changed_files_invalid");
  }
  if (!Array.isArray(value.actionFingerprints) || value.actionFingerprints.length > MAX_ACTION_FINGERPRINTS) {
    throw new Error("warden_checkpoint_actions_invalid");
  }
  for (const action of value.actionFingerprints) {
    exactKeys(action, ["callDigest", "resultDigest", "mutationCount"], "warden_checkpoint_actions_invalid");
    validDigest(action.callDigest, "warden_checkpoint_actions_invalid");
    validDigest(action.resultDigest, "warden_checkpoint_actions_invalid");
    nonnegativeInteger(action.mutationCount, "warden_checkpoint_actions_invalid");
  }
  validateCounters(value.counters);
  if (value.previousEnvelopeDigest !== null) {
    validDigest(value.previousEnvelopeDigest, "warden_checkpoint_previous_digest_invalid");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) ||
      !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error("warden_checkpoint_time_invalid");
  }
}

function keyMaterial(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new Error("warden_checkpoint_key_invalid");
  }
  return createHmac("sha256", Buffer.from(key))
    .update("mendpoint:warden-checkpoint:v1", "utf8")
    .digest();
}

function payloadDigest(payload: WardenCheckpointPayload): string {
  return `sha256:${createHash("sha256").update(canonical(payload), "utf8").digest("hex")}`;
}

function authenticationTag(
  payload: WardenCheckpointPayload,
  digest: string,
  key: Uint8Array,
): string {
  return `hmac-sha256:${createHmac("sha256", keyMaterial(key))
    .update(`${digest}\0${canonical(payload)}`, "utf8")
    .digest("hex")}`;
}

function signWardenCheckpointEnvelope(
  payload: WardenCheckpointPayload,
  key: Uint8Array,
): WardenCheckpointEnvelope {
  validatePayload(payload);
  const digest = payloadDigest(payload);
  return Object.freeze({
    schemaVersion: 1,
    algorithm: "HMAC-SHA256",
    payload,
    payloadDigest: digest,
    authenticationTag: authenticationTag(payload, digest, key),
  });
}

export function createWardenCheckpointEnvelope(
  payload: WardenCheckpointPayload,
  key: Uint8Array,
): WardenCheckpointEnvelope {
  validatePayload(payload);
  if (payload.generation !== 1 ||
      payload.previousEnvelopeDigest !== null ||
      payload.phase !== "agent_running" ||
      payload.nextStep !== 0 ||
      payload.steps.length !== 0 ||
      payload.sourceEvidence.length !== 0 ||
      payload.observedDirectories.length !== 0 ||
      payload.searchDigests.length !== 0 ||
      payload.changedFiles.length !== 0 ||
      payload.actionFingerprints.length !== 0 ||
      COUNTER_KEYS.some((counter) => payload.counters[counter] !== 0)) {
    throw new Error("warden_checkpoint_genesis_invalid");
  }
  return signWardenCheckpointEnvelope(payload, key);
}

function authenticateWardenCheckpointEnvelope(
  envelope: WardenCheckpointEnvelope,
  key: Uint8Array,
  expectedBinding: WardenCheckpointBinding,
): WardenCheckpointPayload {
  exactKeys(envelope, [
    "schemaVersion",
    "algorithm",
    "payload",
    "payloadDigest",
    "authenticationTag",
  ], "warden_checkpoint_envelope_invalid");
  if (envelope.schemaVersion !== 1 || envelope.algorithm !== "HMAC-SHA256") {
    throw new Error("warden_checkpoint_envelope_invalid");
  }
  validatePayload(envelope.payload);
  validateBinding(expectedBinding);
  const digest = payloadDigest(envelope.payload);
  if (digest !== envelope.payloadDigest) {
    throw new Error("warden_checkpoint_payload_digest_mismatch");
  }
  const expectedTag = authenticationTag(envelope.payload, digest, key);
  const actualBytes = Buffer.from(envelope.authenticationTag, "utf8");
  const expectedBytes = Buffer.from(expectedTag, "utf8");
  if (actualBytes.byteLength !== expectedBytes.byteLength ||
      !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error("warden_checkpoint_authentication_failed");
  }
  if (canonical(envelope.payload.binding) !== canonical(expectedBinding)) {
    throw new Error("warden_checkpoint_binding_mismatch");
  }
  return envelope.payload;
}

export function verifyWardenCheckpointEnvelope(
  envelope: WardenCheckpointEnvelope,
  key: Uint8Array,
  expectedBinding: WardenCheckpointBinding,
  expectedWriterLeaseGeneration: number,
): WardenCheckpointPayload {
  const payload = authenticateWardenCheckpointEnvelope(envelope, key, expectedBinding);
  positiveInteger(expectedWriterLeaseGeneration, "warden_checkpoint_lease_mismatch");
  if (payload.writerLeaseGeneration !== expectedWriterLeaseGeneration) {
    throw new Error("warden_checkpoint_lease_mismatch");
  }
  return payload;
}

function runtimeCommitmentKey(key: Uint8Array): Buffer {
  return createHmac("sha256", Buffer.from(key))
    .update("mendpoint:warden-private-runtime-state-commitment-key:v1", "utf8")
    .digest();
}

export function createWardenRuntimeStateCommitment(
  value: Uint8Array,
  key: Uint8Array,
  binding: WardenCheckpointBinding,
  workspaceName: string,
  generation: number,
): string {
  keyMaterial(key);
  validateBinding(binding);
  if (!(value instanceof Uint8Array) || value.byteLength < 1 ||
      value.byteLength > MAX_PRIVATE_RUNTIME_STATE_BYTES ||
      !WORKSPACE_NAME.test(workspaceName)) {
    throw new Error("warden_checkpoint_runtime_state_invalid");
  }
  positiveInteger(generation, "warden_checkpoint_generation_invalid");
  return `hmac-sha256:${createHmac("sha256", runtimeCommitmentKey(key))
    .update(canonical({ binding, workspaceName, generation }), "utf8")
    .update("\0", "utf8")
    .update(value)
    .digest("hex")}`;
}

function runtimeStateKey(key: Uint8Array, checkpointPayloadDigest: string): Buffer {
  return createHmac("sha256", Buffer.from(key))
    .update("mendpoint:warden-private-runtime-state:v1\0", "utf8")
    .update(checkpointPayloadDigest, "utf8")
    .digest();
}

function runtimeStateAad(
  checkpoint: WardenCheckpointEnvelope,
  metadata: Readonly<{
    runtimeStateCommitment: string;
    plaintextBytes: number;
    keyId: string;
  }>,
): Buffer {
  return Buffer.from(canonical({
    schemaVersion: 1,
    runtimeSchemaVersion: 1,
    codec: "opaque-bytes-v1",
    keyId: metadata.keyId,
    checkpointPayloadDigest: checkpoint.payloadDigest,
    binding: checkpoint.payload.binding,
    generation: checkpoint.payload.generation,
    previousEnvelopeDigest: checkpoint.payload.previousEnvelopeDigest,
    writerLeaseGeneration: checkpoint.payload.writerLeaseGeneration,
    workspaceDigest: checkpoint.payload.workspaceDigest,
    runtimeStateCommitment: metadata.runtimeStateCommitment,
    plaintextBytes: metadata.plaintextBytes,
  }), "utf8");
}

function runtimeStateKeyId(key: Uint8Array): string {
  return `wdrt_${createHmac("sha256", Buffer.from(key))
    .update("mendpoint:warden-private-runtime-state-key-id:v1", "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

function canonicalBase64(value: string, expectedBytes?: number): Buffer {
  if (typeof value !== "string" || !value.length || value.length >
      Math.ceil(MAX_PRIVATE_RUNTIME_STATE_BYTES * 4 / 3) + 8) {
    throw new Error("warden_checkpoint_runtime_state_invalid");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value ||
      (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)) {
    throw new Error("warden_checkpoint_runtime_state_invalid");
  }
  return decoded;
}

export function sealWardenRuntimeState(
  state: Uint8Array,
  checkpoint: WardenCheckpointEnvelope,
  key: Uint8Array,
  expectedBinding: WardenCheckpointBinding,
): WardenSealedRuntimeState {
  authenticateWardenCheckpointEnvelope(checkpoint, key, expectedBinding);
  if (!(state instanceof Uint8Array) || state.byteLength < 1 ||
      state.byteLength > MAX_PRIVATE_RUNTIME_STATE_BYTES) {
    throw new Error("warden_checkpoint_runtime_state_invalid");
  }
  const commitment = createWardenRuntimeStateCommitment(
    state,
    key,
    checkpoint.payload.binding,
    checkpoint.payload.workspaceName,
    checkpoint.payload.generation,
  );
  if (commitment !== checkpoint.payload.runtimeStateCommitment) {
    throw new Error("warden_checkpoint_runtime_state_mismatch");
  }
  const metadata = {
    runtimeStateCommitment: commitment,
    plaintextBytes: state.byteLength,
    keyId: runtimeStateKeyId(key),
  } as const;
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    runtimeStateKey(key, checkpoint.payloadDigest),
    nonce,
  );
  cipher.setAAD(runtimeStateAad(checkpoint, metadata));
  const ciphertext = Buffer.concat([cipher.update(state), cipher.final()]);
  return Object.freeze({
    schemaVersion: 1,
    algorithm: "AES-256-GCM",
    runtimeSchemaVersion: 1,
    codec: "opaque-bytes-v1",
    keyId: metadata.keyId,
    checkpointPayloadDigest: checkpoint.payloadDigest,
    runtimeStateCommitment: commitment,
    plaintextBytes: state.byteLength,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authenticationTag: cipher.getAuthTag().toString("base64"),
  });
}

export function openWardenRuntimeState(
  sealed: WardenSealedRuntimeState,
  checkpoint: WardenCheckpointEnvelope,
  key: Uint8Array,
  expectedBinding: WardenCheckpointBinding,
  expectedWriterLeaseGeneration: number,
): Uint8Array {
  const payload = authenticateWardenCheckpointEnvelope(checkpoint, key, expectedBinding);
  positiveInteger(expectedWriterLeaseGeneration, "warden_checkpoint_lease_mismatch");
  if (payload.writerLeaseGeneration !== expectedWriterLeaseGeneration) {
    throw new Error("warden_checkpoint_lease_mismatch");
  }
  exactKeys(sealed, [
    "schemaVersion",
    "algorithm",
    "runtimeSchemaVersion",
    "codec",
    "keyId",
    "checkpointPayloadDigest",
    "runtimeStateCommitment",
    "plaintextBytes",
    "nonce",
    "ciphertext",
    "authenticationTag",
  ], "warden_checkpoint_runtime_state_invalid");
  if (sealed.schemaVersion !== 1 || sealed.algorithm !== "AES-256-GCM" ||
      sealed.runtimeSchemaVersion !== 1 || sealed.codec !== "opaque-bytes-v1" ||
      sealed.keyId !== runtimeStateKeyId(key) ||
      sealed.checkpointPayloadDigest !== checkpoint.payloadDigest ||
      sealed.runtimeStateCommitment !== payload.runtimeStateCommitment) {
    throw new Error("warden_checkpoint_runtime_state_mismatch");
  }
  if (!HMAC_DIGEST.test(sealed.runtimeStateCommitment)) {
    throw new Error("warden_checkpoint_runtime_state_invalid");
  }
  nonnegativeInteger(sealed.plaintextBytes, "warden_checkpoint_runtime_state_invalid");
  const nonce = canonicalBase64(sealed.nonce, 12);
  const ciphertext = canonicalBase64(sealed.ciphertext);
  const authenticationTag = canonicalBase64(sealed.authenticationTag, 16);
  if (ciphertext.byteLength < 1 || ciphertext.byteLength > MAX_PRIVATE_RUNTIME_STATE_BYTES) {
    throw new Error("warden_checkpoint_runtime_state_invalid");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      runtimeStateKey(key, checkpoint.payloadDigest),
      nonce,
    );
    decipher.setAAD(runtimeStateAad(checkpoint, sealed));
    decipher.setAuthTag(authenticationTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.byteLength !== sealed.plaintextBytes ||
        createWardenRuntimeStateCommitment(
          plaintext,
          key,
          payload.binding,
          payload.workspaceName,
          payload.generation,
        ) !== sealed.runtimeStateCommitment) {
      throw new Error("warden_checkpoint_runtime_state_authentication_failed");
    }
    validateRuntimeProjection(plaintext, payload, key, expectedBinding);
    return plaintext;
  } catch (error) {
    if (error instanceof Error &&
        error.message === "warden_checkpoint_runtime_state_authentication_failed") {
      throw error;
    }
    throw new Error("warden_checkpoint_runtime_state_authentication_failed");
  }
}

function hasCanonicalPrefix(current: readonly unknown[], next: readonly unknown[]): boolean {
  return current.length <= next.length && current.every((value, index) =>
    canonical(value) === canonical(next[index])
  );
}

function retainsCanonicalMultiset(current: readonly unknown[], next: readonly unknown[]): boolean {
  const counts = new Map<string, number>();
  for (const value of next) {
    const key = canonical(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const value of current) {
    const key = canonical(value);
    const count = counts.get(key) ?? 0;
    if (count < 1) return false;
    counts.set(key, count - 1);
  }
  return true;
}

function preservesSourceEvidence(
  current: readonly WardenCheckpointSourceEvidence[],
  next: readonly WardenCheckpointSourceEvidence[],
): boolean {
  const nextByPath = new Map(next.map((evidence) => [evidence.path, evidence]));
  if (nextByPath.size !== next.length) return false;
  return current.every((evidence) => {
    const candidate = nextByPath.get(evidence.path);
    return candidate !== undefined &&
      candidate.digest === evidence.digest &&
      candidate.bytes === evidence.bytes &&
      candidate.totalChars === evidence.totalChars &&
      (!evidence.fullyObserved || candidate.fullyObserved) &&
      evidence.ranges.every((range) => candidate.ranges.some((candidateRange) =>
        candidateRange.start <= range.start && candidateRange.end >= range.end
      ));
  });
}

function retainsChangedPaths(
  current: readonly Readonly<{ path: string; digest: string }>[],
  next: readonly Readonly<{ path: string; digest: string }>[],
): boolean {
  const nextPaths = new Set(next.map((file) => file.path));
  return nextPaths.size === next.length && current.every((file) => nextPaths.has(file.path));
}

function advanceWardenCheckpointEnvelope(
  currentEnvelope: WardenCheckpointEnvelope,
  nextPayload: WardenCheckpointPayload,
  key: Uint8Array,
  expectedBinding: WardenCheckpointBinding,
  expectedWriterLeaseGeneration: number,
): WardenCheckpointEnvelope {
  const current = authenticateWardenCheckpointEnvelope(currentEnvelope, key, expectedBinding);
  validatePayload(nextPayload);

  if (nextPayload.writerLeaseGeneration !== expectedWriterLeaseGeneration) {
    throw new Error("warden_checkpoint_lease_mismatch");
  }
  if (canonical(nextPayload) === canonical(current)) return currentEnvelope;
  if (current.phase === "terminal") throw new Error("warden_checkpoint_terminal_sealed");
  if (canonical(nextPayload.binding) !== canonical(current.binding)) {
    throw new Error("warden_checkpoint_binding_mismatch");
  }
  if (nextPayload.workspaceName !== current.workspaceName) {
    throw new Error("warden_checkpoint_workspace_mismatch");
  }
  if (nextPayload.generation !== current.generation + 1) {
    throw new Error("warden_checkpoint_generation_mismatch");
  }
  if (nextPayload.previousEnvelopeDigest !== currentEnvelope.payloadDigest) {
    throw new Error("warden_checkpoint_history_mismatch");
  }
  if (COUNTER_KEYS.some((counter) => nextPayload.counters[counter] < current.counters[counter])) {
    throw new Error("warden_checkpoint_budget_regressed");
  }
  const appendedSteps = nextPayload.steps.slice(current.steps.length);
  const successfulMutations = appendedSteps.filter((step) =>
    step.ok && (step.tool === "write_file" || step.tool === "replace_in_file")
  );
  const modelCallDelta = nextPayload.counters.modelCalls - current.counters.modelCalls;
  const modelSuccessDelta = nextPayload.counters.modelSuccessfulCalls -
    current.counters.modelSuccessfulCalls;
  const modelFailureDelta = nextPayload.counters.modelFailedCalls -
    current.counters.modelFailedCalls;
  const appendedActions = nextPayload.actionFingerprints.slice(current.actionFingerprints.length);
  const workspaceChanged = nextPayload.workspaceDigest !== current.workspaceDigest;
  const changedFileStateChanged = canonical(nextPayload.changedFiles) !== canonical(current.changedFiles);
  if (Date.parse(nextPayload.createdAt) < Date.parse(current.createdAt) ||
      nextPayload.nextStep !== current.nextStep + appendedSteps.length ||
      appendedSteps.some((step, index) => step.step !== current.nextStep + index) ||
      nextPayload.counters.toolCalls !== current.counters.toolCalls + appendedSteps.length ||
      modelCallDelta !== modelSuccessDelta + modelFailureDelta ||
      nextPayload.counters.mutationCount !== current.counters.mutationCount + successfulMutations.length ||
      nextPayload.counters.groundedMutations !==
        current.counters.groundedMutations + successfulMutations.length ||
      appendedActions.length !== successfulMutations.length ||
      successfulMutations.some((step, index) =>
        appendedActions[index]?.callDigest !== step.callDigest ||
        appendedActions[index]?.resultDigest !== step.resultDigest ||
        appendedActions[index]?.mutationCount !== current.counters.mutationCount + index + 1
      ) ||
      (successfulMutations.length > 0 && nextPayload.changedFiles.length === 0) ||
      (successfulMutations.length > 0 && !workspaceChanged) ||
      (successfulMutations.length === 0 && (workspaceChanged || changedFileStateChanged)) ||
      !hasCanonicalPrefix(current.steps, nextPayload.steps) ||
      !hasCanonicalPrefix(current.actionFingerprints, nextPayload.actionFingerprints) ||
      !retainsCanonicalMultiset(current.observedDirectories, nextPayload.observedDirectories) ||
      !retainsCanonicalMultiset(current.searchDigests, nextPayload.searchDigests) ||
      !preservesSourceEvidence(current.sourceEvidence, nextPayload.sourceEvidence) ||
      !retainsChangedPaths(current.changedFiles, nextPayload.changedFiles)) {
    throw new Error("warden_checkpoint_history_mismatch");
  }

  return signWardenCheckpointEnvelope(nextPayload, key);
}

function validateJournalRecord(record: WardenCheckpointJournalRecord): void {
  exactKeys(record, [
    "envelope",
    "sealedRuntimeState",
    "activeWriterLeaseGeneration",
  ], "warden_checkpoint_journal_record_invalid");
  positiveInteger(
    record.activeWriterLeaseGeneration,
    "warden_checkpoint_lease_mismatch",
  );
  if ((record.envelope === null) !== (record.sealedRuntimeState === null)) {
    throw new Error("warden_checkpoint_runtime_state_missing");
  }
  if (record.envelope !== null &&
      record.sealedRuntimeState!.checkpointPayloadDigest !== record.envelope.payloadDigest) {
    throw new Error("warden_checkpoint_runtime_state_mismatch");
  }
  if (record.envelope !== null &&
      record.activeWriterLeaseGeneration < record.envelope.payload.writerLeaseGeneration) {
    throw new Error("warden_checkpoint_lease_mismatch");
  }
}

export async function commitWardenCheckpoint(
  journal: WardenCheckpointJournal,
  nextPayload: WardenCheckpointPayload,
  nextRuntimeState: Uint8Array,
  key: Uint8Array,
  expectedBinding: WardenCheckpointBinding,
): Promise<WardenCheckpointEnvelope> {
  validateBinding(expectedBinding);
  validatePayload(nextPayload);
  if (canonical(nextPayload.binding) !== canonical(expectedBinding)) {
    throw new Error("warden_checkpoint_binding_mismatch");
  }
  if (!(nextRuntimeState instanceof Uint8Array) || nextRuntimeState.byteLength < 1 ||
      nextRuntimeState.byteLength > MAX_PRIVATE_RUNTIME_STATE_BYTES) {
    throw new Error("warden_checkpoint_runtime_state_invalid");
  }
  const nextRuntimeStateCommitment = createWardenRuntimeStateCommitment(
    nextRuntimeState,
    key,
    nextPayload.binding,
    nextPayload.workspaceName,
    nextPayload.generation,
  );
  if (nextRuntimeStateCommitment !== nextPayload.runtimeStateCommitment) {
    throw new Error("warden_checkpoint_runtime_state_mismatch");
  }
  const nextDecoded = validateRuntimeProjection(
    nextRuntimeState,
    nextPayload,
    key,
    expectedBinding,
  );
  const currentRecord = await journal.read(expectedBinding);
  validateJournalRecord(currentRecord);
  if (nextPayload.writerLeaseGeneration !== currentRecord.activeWriterLeaseGeneration) {
    throw new Error("warden_checkpoint_lease_mismatch");
  }
  let currentRuntimeState: Uint8Array | null = null;
  if (currentRecord.envelope !== null) {
    currentRuntimeState = openWardenRuntimeState(
      currentRecord.sealedRuntimeState!,
      currentRecord.envelope,
      key,
      expectedBinding,
      currentRecord.envelope.payload.writerLeaseGeneration,
    );
  }

  const nextEnvelope = currentRecord.envelope === null
    ? createWardenCheckpointEnvelope(nextPayload, key)
    : advanceWardenCheckpointEnvelope(
        currentRecord.envelope,
        nextPayload,
        key,
        expectedBinding,
        currentRecord.activeWriterLeaseGeneration,
      );
  if (currentRuntimeState !== null && nextEnvelope !== currentRecord.envelope) {
    const currentDecoded = decodeWardenRuntimeState(currentRuntimeState, expectedBinding);
    validateWardenRuntimeStateTransition(currentDecoded, nextDecoded);
  }
  if (nextEnvelope === currentRecord.envelope) {
    const sealed = currentRecord.sealedRuntimeState!;
    if (sealed.runtimeStateCommitment !== nextRuntimeStateCommitment) {
      throw new Error("warden_checkpoint_runtime_state_mismatch");
    }
    openWardenRuntimeState(
      sealed,
      nextEnvelope,
      key,
      expectedBinding,
      currentRecord.activeWriterLeaseGeneration,
    );
    return nextEnvelope;
  }
  const nextSealedRuntimeState = sealWardenRuntimeState(
    nextRuntimeState,
    nextEnvelope,
    key,
    expectedBinding,
  );

  const committed = await journal.compareAndSwap({
    binding: expectedBinding,
    expectedPayloadDigest: currentRecord.envelope?.payloadDigest ?? null,
    expectedActiveWriterLeaseGeneration: currentRecord.activeWriterLeaseGeneration,
    nextEnvelope,
    nextSealedRuntimeState,
  });
  if (committed) return nextEnvelope;

  const latest = await journal.read(expectedBinding);
  validateJournalRecord(latest);
  if (latest.envelope !== null &&
      latest.activeWriterLeaseGeneration === nextPayload.writerLeaseGeneration) {
    const latestPayload = authenticateWardenCheckpointEnvelope(
      latest.envelope,
      key,
      expectedBinding,
    );
    if (canonical(latestPayload) === canonical(nextPayload) &&
        latest.sealedRuntimeState!.runtimeStateCommitment === nextRuntimeStateCommitment) {
      openWardenRuntimeState(
        latest.sealedRuntimeState!,
        latest.envelope,
        key,
        expectedBinding,
        latest.activeWriterLeaseGeneration,
      );
      return latest.envelope;
    }
  }
  throw new Error("warden_checkpoint_compare_and_swap_conflict");
}
