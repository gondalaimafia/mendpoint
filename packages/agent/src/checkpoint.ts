import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { AgentStep, ToolName } from "./types.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DIAGNOSTIC_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const RELATIVE_PATH = /^(?![A-Za-z]:)(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).{1,1000}$/;
const MAX_STEPS = 256;
const MAX_EVIDENCE_FILES = 512;
const MAX_DIRECTORIES = 512;
const MAX_SEARCHES = 512;
const MAX_CHANGED_FILES = 256;
const MAX_ACTION_FINGERPRINTS = 512;

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

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`
  ).join(",")}}`;
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
  validText(value.revision, 255, "warden_checkpoint_binding_invalid");
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
  const keys = [
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
  exactKeys(value, keys, "warden_checkpoint_counters_invalid");
  for (const key of keys) {
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

export function createWardenCheckpointEnvelope(
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

export function verifyWardenCheckpointEnvelope(
  envelope: WardenCheckpointEnvelope,
  key: Uint8Array,
  expectedBinding: WardenCheckpointBinding,
  expectedWriterLeaseGeneration: number,
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
  positiveInteger(expectedWriterLeaseGeneration, "warden_checkpoint_lease_mismatch");
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
  if (envelope.payload.writerLeaseGeneration !== expectedWriterLeaseGeneration) {
    throw new Error("warden_checkpoint_lease_mismatch");
  }
  return envelope.payload;
}
