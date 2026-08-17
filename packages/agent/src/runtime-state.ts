import { createHash } from "node:crypto";
import {
  createWardenRuntimeStateCommitment,
  type WardenCheckpointBinding,
  type WardenCheckpointPayload,
  type WardenCheckpointSourceEvidence,
} from "./checkpoint.js";
import { ABSENT_FILE_EVIDENCE_DIGEST, validatedToolCall } from "./agent.js";
import type { AgentStep, ToolName } from "./types.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const RELATIVE_PATH = /^(?![A-Za-z]:)(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).{1,1000}$/;
const MAX_RUNTIME_BYTES = 64 * 1024 * 1024;
const MAX_COLLECTION = 512;
const MAX_MANIFEST_ENTRIES = 50_000;

export type WardenRuntimeJson =
  | null
  | boolean
  | number
  | string
  | readonly WardenRuntimeJson[]
  | Readonly<{ [key: string]: WardenRuntimeJson }>;

export type WardenRuntimeManifestEntry = Readonly<{
  path: string;
  digest: string;
  bytes: number;
}>;

export type WardenRuntimeEvent = Readonly<{
  category: "tool" | "verifier";
  tool: ToolName;
  plannerSource: NonNullable<AgentStep["plannerSource"]>;
  executed: boolean;
  ok: boolean;
  summaryCode: string;
  errorCode?: string;
  effectId?: string;
  modelEffectId?: string;
  modelPlannedCall?: WardenRuntimeJson;
  call: WardenRuntimeJson;
  result: WardenRuntimeJson;
  mutation: boolean;
}>;

export type WardenRuntimeModelCall = Readonly<{
  status: "succeeded" | "failed";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}>;

export type WardenRuntimePendingEffect =
  | Readonly<{ kind: "none" }>
  | Readonly<{
    kind: "model" | "tool" | "verifier" | "artifact";
    state: "prepared" | "dispatched" | "completed";
    effectId: string;
    requestDigest: string;
    resultDigest?: string;
  }>;

export type WardenRuntimeEffectReceipt = Readonly<{
  kind: "model" | "tool" | "verifier" | "artifact";
  effectId: string;
  requestDigest: string;
  resultDigest: string;
  plannedCallDigest?: string;
  modelAccounting?: WardenRuntimeModelCall;
}>;

export type WardenPrivateRuntimeStateV1 = Readonly<{
  schemaVersion: 1;
  binding: WardenCheckpointBinding;
  generation: number;
  writerLeaseGeneration: number;
  workspaceName: string;
  phase: WardenCheckpointPayload["phase"];
  previousEnvelopeDigest: string | null;
  createdAt: string;
  executorDigest: string;
  sourceManifest: readonly WardenRuntimeManifestEntry[];
  workspaceManifest: readonly WardenRuntimeManifestEntry[];
  events: readonly WardenRuntimeEvent[];
  sourceEvidence: readonly WardenCheckpointSourceEvidence[];
  observedDirectories: readonly string[];
  searches: readonly WardenRuntimeJson[];
  modelCalls: readonly WardenRuntimeModelCall[];
  sourceCounters: Readonly<{
    observedBytes: number;
    searchBytes: number;
    changedBytes: number;
    groundedMutations: number;
    blockedMutations: number;
  }>;
  privateState: WardenRuntimeJson;
  privateHistory: readonly WardenRuntimeJson[];
  rollbackPreimages: readonly Readonly<{
    path: string;
    existed: boolean;
    blobDigest?: string;
  }>[];
  blobs: readonly Readonly<{
    digest: string;
    bytes: number;
    contentBase64: string;
  }>[];
  effectReceipts: readonly WardenRuntimeEffectReceipt[];
  pendingEffect: WardenRuntimePendingEffect;
}>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`
  ).join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function createWardenRuntimeMutationOperationDigest(
  tool: "write_file" | "replace_in_file" | "delete_file",
  targetPath: string,
  args: Readonly<Record<string, WardenRuntimeJson>>,
): string {
  return sha256(canonical({ schemaVersion: 1, tool, targetPath, args }));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value: object, expected: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(code);
  }
}

function nonnegative(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
}

function positive(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
}

function validPath(value: string, code: string): void {
  if (typeof value !== "string" || value.includes("\\") || !RELATIVE_PATH.test(value)) {
    throw new Error(code);
  }
}

function validDigest(value: string, code: string): void {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(code);
}

function validateJson(value: unknown, depth = 0): asserts value is WardenRuntimeJson {
  if (depth > 64) throw new Error("warden_runtime_state_json_invalid");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("warden_runtime_state_json_invalid");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new Error("warden_runtime_state_json_invalid");
    for (const item of value) validateJson(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("warden_runtime_state_json_invalid");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 10_000) throw new Error("warden_runtime_state_json_invalid");
  for (const [key, item] of entries) {
    if (!key || key.length > 256 || item === undefined) {
      throw new Error("warden_runtime_state_json_invalid");
    }
    validateJson(item, depth + 1);
  }
}

function jsonRecord(value: WardenRuntimeJson, code: string): Record<string, WardenRuntimeJson> {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(code);
  return value as Record<string, WardenRuntimeJson>;
}

function validateModelCall(call: WardenRuntimeModelCall): void {
  exactKeys(call, [
    "status", "promptTokens", "completionTokens", "totalTokens", "costUsd",
  ], "warden_runtime_state_accounting_invalid");
  nonnegative(call.promptTokens, "warden_runtime_state_accounting_invalid");
  nonnegative(call.completionTokens, "warden_runtime_state_accounting_invalid");
  nonnegative(call.totalTokens, "warden_runtime_state_accounting_invalid");
  if (call.totalTokens !== call.promptTokens + call.completionTokens ||
      !Number.isFinite(call.costUsd) || call.costUsd < 0 ||
      (call.status !== "succeeded" && call.status !== "failed")) {
    throw new Error("warden_runtime_state_accounting_invalid");
  }
}

function modelResultFromBytes(content: Uint8Array): Readonly<{
  plannedCallDigest: string;
  accounting: WardenRuntimeModelCall;
}> {
  const code = "warden_runtime_state_model_result_invalid";
  let parsed: WardenRuntimeJson;
  try {
    parsed = JSON.parse(Buffer.from(content).toString("utf8")) as WardenRuntimeJson;
  } catch {
    throw new Error(code);
  }
  validateJson(parsed);
  const result = jsonRecord(parsed, code);
  exactKeys(result, ["call", "accounting", ...(result.telemetry === undefined ? [] : ["telemetry"])], code);
  const call = validatedToolCall(result.call);
  if (!call || canonical(call) !== canonical(result.call)) throw new Error(code);
  const accounting = result.accounting as WardenRuntimeModelCall;
  try {
    validateModelCall(accounting);
  } catch {
    throw new Error(code);
  }
  if (accounting.status !== "succeeded") throw new Error(code);
  if (result.telemetry !== undefined) {
    const telemetry = jsonRecord(result.telemetry, code);
    exactKeys(telemetry, ["responseBytes", "provenance"], code);
    if (!Number.isSafeInteger(telemetry.responseBytes) || (telemetry.responseBytes as number) < 0 ||
        !Array.isArray(telemetry.provenance)) {
      throw new Error(code);
    }
  }
  return { plannedCallDigest: sha256(canonical(call)), accounting };
}

function effectEventResultFromBytes(content: Uint8Array): WardenRuntimeJson {
  const code = "warden_runtime_state_effect_event_invalid";
  let parsed: WardenRuntimeJson;
  try {
    parsed = JSON.parse(Buffer.from(content).toString("utf8")) as WardenRuntimeJson;
  } catch {
    throw new Error(code);
  }
  validateJson(parsed);
  const envelope = jsonRecord(parsed, code);
  exactKeys(envelope, ["result", ...(envelope.mutation === undefined ? [] : ["mutation"])], code);
  const result = jsonRecord(envelope.result, code);
  exactKeys(result, [
    "ok", "tool", "summary",
    ...(result.data === undefined ? [] : ["data"]),
    ...(result.error === undefined ? [] : ["error"]),
  ], code);
  if (typeof result.ok !== "boolean" || typeof result.summary !== "string" ||
      !( ["list_dir", "read_file", "search", "write_file", "replace_in_file", "delete_file",
        "run_command", "http_probe", "finish"] as const).includes(result.tool as ToolName) ||
      (result.error !== undefined && typeof result.error !== "string")) {
    throw new Error(code);
  }
  if (envelope.mutation !== undefined) {
    const mutation = jsonRecord(envelope.mutation, code);
    const deletion = mutation.postAbsent === true;
    exactKeys(mutation, deletion
      ? ["path", "preExisted", "preDigest", "preContentBase64", "postAbsent"]
      : ["path", "preExisted", "preDigest", "preContentBase64",
        "postDigest", "postContentBase64"], code);
    if (typeof mutation.path !== "string" || typeof mutation.preExisted !== "boolean" ||
        (mutation.preDigest !== null && typeof mutation.preDigest !== "string") ||
        (mutation.preContentBase64 !== null && typeof mutation.preContentBase64 !== "string") ||
        mutation.preExisted !== (mutation.preDigest !== null) ||
        mutation.preExisted !== (mutation.preContentBase64 !== null) ||
        (deletion && mutation.preExisted !== true) ||
        (!deletion && (typeof mutation.postDigest !== "string" ||
          typeof mutation.postContentBase64 !== "string"))) {
      throw new Error(code);
    }
    validPath(mutation.path, code);
    if (!deletion) {
      validDigest(mutation.postDigest as string, code);
      const post = Buffer.from(mutation.postContentBase64 as string, "base64");
      if (post.toString("base64") !== mutation.postContentBase64 ||
          sha256(post) !== mutation.postDigest) throw new Error(code);
    }
    if (mutation.preExisted) {
      validDigest(mutation.preDigest as string, code);
      const pre = Buffer.from(mutation.preContentBase64 as string, "base64");
      if (pre.toString("base64") !== mutation.preContentBase64 ||
          sha256(pre) !== mutation.preDigest) throw new Error(code);
    }
  }
  return envelope.result!;
}

function mutationIdentity(event: WardenRuntimeEvent): Readonly<{ path: string; digest: string }> {
  const code = "warden_runtime_state_event_invalid";
  const call = jsonRecord(event.call, code);
  if (call.tool !== event.tool) throw new Error(code);
  exactKeys(call, [
    "tool", "args", "intent", ...(call.thought === undefined ? [] : ["thought"]),
  ], code);
  if (call.tool !== event.tool || (call.thought !== undefined && typeof call.thought !== "string")) {
    throw new Error(code);
  }
  const args = jsonRecord(call.args!, code);
  const expectedArgs = event.tool === "write_file"
    ? ["path", "content"]
    : event.tool === "delete_file"
      ? ["path"]
      : ["path", "from", "to", ...(args.global === undefined ? [] : ["global"] )];
  exactKeys(args, expectedArgs, code);
  if (typeof args.path !== "string" ||
      (event.tool === "write_file" && typeof args.content !== "string") ||
      (event.tool === "replace_in_file" &&
        (typeof args.from !== "string" || typeof args.to !== "string" ||
          (args.global !== undefined && typeof args.global !== "boolean")))) {
    throw new Error(code);
  }
  validPath(args.path, code);
  const intent = jsonRecord(call.intent!, code);
  exactKeys(intent, [
    "schemaVersion", "hypothesis", "targetPath", "targetSymbol", "targetDigest",
    "evidenceRefs", "precondition", "expectedObservation", "postcondition", "rollback",
    "confidence", "risk", "stopCondition", "assessmentSource", "operationDigest",
    "expectedResultDigest",
  ], code);
  if (intent.schemaVersion !== 1 || intent.targetPath !== args.path ||
      typeof intent.operationDigest !== "string" ||
      typeof intent.expectedResultDigest !== "string") {
    throw new Error(code);
  }
  validDigest(intent.operationDigest, code);
  validDigest(intent.expectedResultDigest, code);
  if (intent.operationDigest !== createWardenRuntimeMutationOperationDigest(
    event.tool as "write_file" | "replace_in_file" | "delete_file",
    args.path,
    args,
  )) {
    throw new Error(code);
  }
  if ((event.tool === "delete_file") !==
      (intent.expectedResultDigest === ABSENT_FILE_EVIDENCE_DIGEST)) {
    throw new Error(code);
  }
  const result = jsonRecord(event.result, code);
  exactKeys(result, [
    "ok", "tool", "summary",
    ...(result.data === undefined ? [] : ["data"]),
    ...(result.error === undefined ? [] : ["error"]),
  ], code);
  if (result.ok !== true || result.tool !== event.tool || typeof result.summary !== "string" ||
      (result.error !== undefined && typeof result.error !== "string")) {
    throw new Error(code);
  }
  const data = jsonRecord(result.data!, code);
  if (data.path !== args.path) throw new Error(code);
  return { path: args.path, digest: intent.expectedResultDigest };
}

function validateBinding(binding: WardenCheckpointBinding): void {
  exactKeys(binding, [
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
  ], "warden_runtime_state_binding_invalid");
  if (binding.schemaVersion !== 1 || ![binding.tenantId, binding.jobId, binding.attemptId,
    binding.repositoryId, binding.snapshotId].every((value) => IDENTIFIER.test(value)) ||
    !/^[a-f0-9]{40}$/.test(binding.revision)) {
    throw new Error("warden_runtime_state_binding_invalid");
  }
  validDigest(binding.sourceManifestSha256, "warden_runtime_state_binding_invalid");
  validDigest(binding.allowedPathsDigest, "warden_runtime_state_binding_invalid");
  validDigest(binding.verificationProfileDigest, "warden_runtime_state_binding_invalid");
  validDigest(binding.modelPolicyDigest, "warden_runtime_state_binding_invalid");
}

function validateManifest(
  entries: readonly WardenRuntimeManifestEntry[],
  code: string,
): void {
  if (!Array.isArray(entries) || entries.length > MAX_MANIFEST_ENTRIES) throw new Error(code);
  const paths = new Set<string>();
  for (const entry of entries) {
    exactKeys(entry, ["path", "digest", "bytes"], code);
    validPath(entry.path, code);
    validDigest(entry.digest, code);
    nonnegative(entry.bytes, code);
    const pathKey = entry.path.toLowerCase();
    if (paths.has(pathKey)) throw new Error(code);
    paths.add(pathKey);
  }
}

function validateEvidence(entries: readonly WardenCheckpointSourceEvidence[]): void {
  if (!Array.isArray(entries) || entries.length > MAX_COLLECTION) {
    throw new Error("warden_runtime_state_source_evidence_invalid");
  }
  const paths = new Set<string>();
  for (const entry of entries) {
    exactKeys(entry, [
      "path", "digest", "bytes", "totalChars", "ranges", "fullyObserved",
    ], "warden_runtime_state_source_evidence_invalid");
    validPath(entry.path, "warden_runtime_state_source_evidence_invalid");
    validDigest(entry.digest, "warden_runtime_state_source_evidence_invalid");
    nonnegative(entry.bytes, "warden_runtime_state_source_evidence_invalid");
    nonnegative(entry.totalChars, "warden_runtime_state_source_evidence_invalid");
    if (typeof entry.fullyObserved !== "boolean" || paths.has(entry.path) ||
        !Array.isArray(entry.ranges) || entry.ranges.length > MAX_COLLECTION) {
      throw new Error("warden_runtime_state_source_evidence_invalid");
    }
    paths.add(entry.path);
    let priorEnd = 0;
    for (const range of entry.ranges) {
      exactKeys(range, ["start", "end"], "warden_runtime_state_source_evidence_invalid");
      nonnegative(range.start, "warden_runtime_state_source_evidence_invalid");
      nonnegative(range.end, "warden_runtime_state_source_evidence_invalid");
      if (range.end < range.start || range.start < priorEnd || range.end > entry.totalChars) {
        throw new Error("warden_runtime_state_source_evidence_invalid");
      }
      priorEnd = range.end;
    }
    const full = entry.totalChars === 0 ||
      (entry.ranges.length === 1 && entry.ranges[0]!.start === 0 &&
        entry.ranges[0]!.end === entry.totalChars);
    if (entry.fullyObserved !== full) {
      throw new Error("warden_runtime_state_source_evidence_invalid");
    }
  }
}

function validateEvent(event: WardenRuntimeEvent): void {
  exactKeys(event, [
    "category", "tool", "plannerSource", "executed", "ok", "summaryCode",
    ...(event.errorCode === undefined ? [] : ["errorCode"]),
    ...(event.effectId === undefined ? [] : ["effectId"]),
    ...(event.modelEffectId === undefined ? [] : ["modelEffectId"]),
    ...(event.modelPlannedCall === undefined ? [] : ["modelPlannedCall"]),
    "call", "result", "mutation",
  ], "warden_runtime_state_event_invalid");
  if (!(["tool", "verifier"] as const).includes(event.category) ||
      !(["model", "heuristic", "system"] as const).includes(event.plannerSource) ||
      typeof event.executed !== "boolean" || typeof event.ok !== "boolean" ||
      typeof event.mutation !== "boolean" || !CODE.test(event.summaryCode) ||
      (event.errorCode !== undefined && !CODE.test(event.errorCode)) ||
      (event.effectId !== undefined && (!event.executed || !IDENTIFIER.test(event.effectId))) ||
      (event.modelEffectId !== undefined &&
        (event.plannerSource !== "model" || !event.executed || !IDENTIFIER.test(event.modelEffectId))) ||
      (event.modelPlannedCall !== undefined && event.modelEffectId === undefined) ||
      !(["list_dir", "read_file", "search", "write_file", "replace_in_file", "delete_file",
        "run_command", "http_probe", "finish"] as const).includes(event.tool)) {
    throw new Error("warden_runtime_state_event_invalid");
  }
  if (event.mutation && (!event.executed || !event.ok ||
      (event.tool !== "write_file" && event.tool !== "replace_in_file" &&
        event.tool !== "delete_file"))) {
    throw new Error("warden_runtime_state_event_invalid");
  }
  validateJson(event.call);
  validateJson(event.result);
  if (event.modelPlannedCall !== undefined) validateJson(event.modelPlannedCall);
  const call = jsonRecord(event.call, "warden_runtime_state_event_invalid");
  if (call.tool !== event.tool) {
    throw new Error("warden_runtime_state_event_invalid");
  }
  if (event.mutation) mutationIdentity(event);
}

function validatePendingEffect(effect: WardenRuntimePendingEffect): void {
  if (effect.kind === "none") {
    exactKeys(effect, ["kind"], "warden_runtime_state_pending_effect_invalid");
    return;
  }
  exactKeys(effect, [
    "kind", "state", "effectId", "requestDigest",
    ...(effect.resultDigest === undefined ? [] : ["resultDigest"]),
  ], "warden_runtime_state_pending_effect_invalid");
  if (!(["model", "tool", "verifier", "artifact"] as const).includes(effect.kind) ||
      !(["prepared", "dispatched", "completed"] as const).includes(effect.state) ||
      !IDENTIFIER.test(effect.effectId)) {
    throw new Error("warden_runtime_state_pending_effect_invalid");
  }
  validDigest(effect.requestDigest, "warden_runtime_state_pending_effect_invalid");
  if (effect.resultDigest !== undefined) {
    validDigest(effect.resultDigest, "warden_runtime_state_pending_effect_invalid");
  }
  if ((effect.state === "completed") !== (effect.resultDigest !== undefined)) {
    throw new Error("warden_runtime_state_pending_effect_invalid");
  }
}

function validateEffectReceipt(receipt: WardenRuntimeEffectReceipt): void {
  exactKeys(receipt, [
    "kind", "effectId", "requestDigest", "resultDigest",
    ...(receipt.plannedCallDigest === undefined ? [] : ["plannedCallDigest"]),
    ...(receipt.modelAccounting === undefined ? [] : ["modelAccounting"]),
  ], "warden_runtime_state_effect_receipt_invalid");
  if (!( ["model", "tool", "verifier", "artifact"] as const).includes(receipt.kind) ||
      !IDENTIFIER.test(receipt.effectId)) {
    throw new Error("warden_runtime_state_effect_receipt_invalid");
  }
  validDigest(receipt.requestDigest, "warden_runtime_state_effect_receipt_invalid");
  validDigest(receipt.resultDigest, "warden_runtime_state_effect_receipt_invalid");
  if ((receipt.kind === "model") !== (receipt.plannedCallDigest !== undefined) ||
      (receipt.kind === "model") !== (receipt.modelAccounting !== undefined)) {
    throw new Error("warden_runtime_state_effect_receipt_invalid");
  }
  if (receipt.plannedCallDigest !== undefined) {
    validDigest(receipt.plannedCallDigest, "warden_runtime_state_effect_receipt_invalid");
    validateModelCall(receipt.modelAccounting!);
  }
}

function validateState(state: WardenPrivateRuntimeStateV1): void {
  exactKeys(state, [
    "schemaVersion", "binding", "generation", "writerLeaseGeneration", "workspaceName",
    "phase", "previousEnvelopeDigest", "createdAt", "executorDigest", "sourceManifest",
    "workspaceManifest", "events", "sourceEvidence", "observedDirectories", "searches",
    "modelCalls", "sourceCounters", "privateState", "privateHistory",
    "rollbackPreimages", "blobs", "effectReceipts", "pendingEffect",
  ], "warden_runtime_state_invalid");
  if (state.schemaVersion !== 1) throw new Error("warden_runtime_state_invalid");
  validateBinding(state.binding);
  positive(state.generation, "warden_runtime_state_generation_invalid");
  positive(state.writerLeaseGeneration, "warden_runtime_state_lease_invalid");
  if (!WORKSPACE.test(state.workspaceName) ||
      !(["agent_running", "verification_feedback", "terminal"] as const).includes(state.phase) ||
      (state.previousEnvelopeDigest !== null && !DIGEST.test(state.previousEnvelopeDigest)) ||
      !Number.isFinite(Date.parse(state.createdAt)) ||
      new Date(state.createdAt).toISOString() !== state.createdAt) {
    throw new Error("warden_runtime_state_invalid");
  }
  validDigest(state.executorDigest, "warden_runtime_state_invalid");
  validateManifest(state.sourceManifest, "warden_runtime_state_source_manifest_invalid");
  if (createWardenRuntimeManifestDigest(state.sourceManifest) !==
      state.binding.sourceManifestSha256) {
    throw new Error("warden_runtime_state_source_manifest_invalid");
  }
  validateManifest(state.workspaceManifest, "warden_runtime_state_workspace_manifest_invalid");
  if (state.events.length > 256) throw new Error("warden_runtime_state_event_invalid");
  for (const event of state.events) validateEvent(event);
  validateEvidence(state.sourceEvidence);
  const sourceEntries = new Map(state.sourceManifest.map((entry) => [entry.path, entry]));
  for (const evidence of state.sourceEvidence) {
    const sourceEntry = sourceEntries.get(evidence.path);
    if (!sourceEntry || sourceEntry.digest !== evidence.digest ||
        sourceEntry.bytes !== evidence.bytes) {
      throw new Error("warden_runtime_state_source_evidence_invalid");
    }
  }
  if (state.observedDirectories.length > MAX_COLLECTION ||
      new Set(state.observedDirectories).size !== state.observedDirectories.length) {
    throw new Error("warden_runtime_state_directories_invalid");
  }
  for (const path of state.observedDirectories) validPath(path, "warden_runtime_state_directories_invalid");
  if (state.searches.length > MAX_COLLECTION) throw new Error("warden_runtime_state_searches_invalid");
  for (const search of state.searches) validateJson(search);
  if (state.modelCalls.length > 256) throw new Error("warden_runtime_state_accounting_invalid");
  for (const call of state.modelCalls) {
    validateModelCall(call);
  }
  exactKeys(state.sourceCounters, [
    "observedBytes", "searchBytes", "changedBytes", "groundedMutations", "blockedMutations",
  ], "warden_runtime_state_counters_invalid");
  for (const value of Object.values(state.sourceCounters)) {
    nonnegative(value, "warden_runtime_state_counters_invalid");
  }
  validateJson(state.privateState);
  if (!state.privateState || Array.isArray(state.privateState) || typeof state.privateState !== "object") {
    throw new Error("warden_runtime_state_private_invalid");
  }
  if (!Array.isArray(state.privateHistory) || state.privateHistory.length > MAX_COLLECTION) {
    throw new Error("warden_runtime_state_private_invalid");
  }
  for (const entry of state.privateHistory) validateJson(entry);
  if (!Array.isArray(state.rollbackPreimages) ||
      state.rollbackPreimages.length > MAX_COLLECTION) {
    throw new Error("warden_runtime_state_rollback_invalid");
  }
  const rollbackPaths = new Set<string>();
  for (const preimage of state.rollbackPreimages) {
    exactKeys(preimage, [
      "path", "existed", ...(preimage.blobDigest === undefined ? [] : ["blobDigest"]),
    ], "warden_runtime_state_rollback_invalid");
    validPath(preimage.path, "warden_runtime_state_rollback_invalid");
    const pathKey = preimage.path.toLowerCase();
    if (rollbackPaths.has(pathKey) || typeof preimage.existed !== "boolean" ||
        preimage.existed !== (preimage.blobDigest !== undefined)) {
      throw new Error("warden_runtime_state_rollback_invalid");
    }
    if (preimage.blobDigest !== undefined) {
      validDigest(preimage.blobDigest, "warden_runtime_state_rollback_invalid");
    }
    rollbackPaths.add(pathKey);
  }
  if (state.blobs.length > MAX_COLLECTION) throw new Error("warden_runtime_state_blob_invalid");
  const blobDigests = new Set<string>();
  const blobContents = new Map<string, Uint8Array>();
  for (const blob of state.blobs) {
    exactKeys(blob, ["digest", "bytes", "contentBase64"], "warden_runtime_state_blob_invalid");
    validDigest(blob.digest, "warden_runtime_state_blob_invalid");
    nonnegative(blob.bytes, "warden_runtime_state_blob_invalid");
    const content = Buffer.from(blob.contentBase64, "base64");
    if (content.toString("base64") !== blob.contentBase64 || content.byteLength !== blob.bytes ||
        sha256(content) !== blob.digest || blobDigests.has(blob.digest)) {
      throw new Error("warden_runtime_state_blob_invalid");
    }
    blobDigests.add(blob.digest);
    blobContents.set(blob.digest, content);
  }
  if (!Array.isArray(state.effectReceipts) || state.effectReceipts.length > MAX_COLLECTION) {
    throw new Error("warden_runtime_state_effect_receipt_invalid");
  }
  const effectIds = new Set<string>();
  for (const receipt of state.effectReceipts) {
    validateEffectReceipt(receipt);
    if (effectIds.has(receipt.effectId)) {
      throw new Error("warden_runtime_state_effect_receipt_invalid");
    }
    effectIds.add(receipt.effectId);
    if (receipt.kind === "model") {
      const content = blobContents.get(receipt.resultDigest);
      if (!content) throw new Error("warden_runtime_state_model_result_invalid");
      const result = modelResultFromBytes(content);
      if (result.plannedCallDigest !== receipt.plannedCallDigest ||
          canonical(result.accounting) !== canonical(receipt.modelAccounting)) {
        throw new Error("warden_runtime_state_model_result_invalid");
      }
    }
  }
  const runtimeEffectEvents = new Map<string, WardenRuntimeEvent>();
  for (const event of state.events) {
    if (event.effectId === undefined) continue;
    if (runtimeEffectEvents.has(event.effectId)) {
      throw new Error("warden_runtime_state_effect_event_invalid");
    }
    runtimeEffectEvents.set(event.effectId, event);
  }
  for (const receipt of state.effectReceipts) {
    if (receipt.kind !== "tool" && receipt.kind !== "verifier") continue;
    const event = runtimeEffectEvents.get(receipt.effectId);
    const requestBlob = blobContents.get(receipt.requestDigest);
    const resultBlob = blobContents.get(receipt.resultDigest);
    if (!event || !requestBlob || !resultBlob ||
        event.category !== (receipt.kind === "verifier" ? "verifier" : "tool") ||
        canonical(effectEventResultFromBytes(resultBlob)) !== canonical(event.result)) {
      throw new Error("warden_runtime_state_effect_event_invalid");
    }
    let request: unknown;
    try {
      request = JSON.parse(Buffer.from(requestBlob).toString("utf8"));
    } catch {
      throw new Error("warden_runtime_state_effect_event_invalid");
    }
    const requestRecord = jsonRecord(request as WardenRuntimeJson,
      "warden_runtime_state_effect_event_invalid");
    if (!Object.hasOwn(requestRecord, "call") ||
        canonical(requestRecord.call) !== canonical(event.call)) {
      throw new Error("warden_runtime_state_effect_event_invalid");
    }
    if ((Object.hasOwn(requestRecord, "plannerSource") &&
          requestRecord.plannerSource !== event.plannerSource) ||
        (Object.hasOwn(requestRecord, "modelEffectId") &&
          requestRecord.modelEffectId !== (event.modelEffectId ?? null)) ||
        (Object.hasOwn(requestRecord, "modelPlannedCall") &&
          canonical(requestRecord.modelPlannedCall) !==
            canonical(event.modelPlannedCall ?? null))) {
      throw new Error("warden_runtime_state_effect_event_invalid");
    }
  }
  const modelReceipts = new Map(state.effectReceipts
    .filter((receipt) => receipt.kind === "model")
    .map((receipt) => [receipt.effectId, receipt]));
  const usedModelEffects = new Set<string>();
  let legacyModelEvents = 0;
  for (const event of state.events) {
    if (event.plannerSource !== "model" || !event.executed) continue;
    if (event.modelEffectId === undefined) {
      legacyModelEvents++;
      continue;
    }
    const receipt = modelReceipts.get(event.modelEffectId);
    if (!receipt || usedModelEffects.has(event.modelEffectId) ||
        sha256(canonical(event.modelPlannedCall ?? event.call)) !== receipt.plannedCallDigest) {
      throw new Error("warden_runtime_state_model_event_invalid");
    }
    usedModelEffects.add(event.modelEffectId);
  }
  const successfulModelCalls = state.modelCalls.filter((call) => call.status === "succeeded").length;
  if (successfulModelCalls !== modelReceipts.size + legacyModelEvents) {
    throw new Error("warden_runtime_state_accounting_invalid");
  }
  validatePendingEffect(state.pendingEffect);
  if (state.pendingEffect.kind !== "none" && effectIds.has(state.pendingEffect.effectId)) {
    throw new Error("warden_runtime_state_pending_effect_invalid");
  }
  if (state.phase === "terminal" && state.pendingEffect.kind !== "none") {
    throw new Error("warden_runtime_state_terminal_effect_unresolved");
  }
  for (const evidence of state.sourceEvidence) {
    if (!blobDigests.has(evidence.digest)) {
      throw new Error("warden_runtime_state_blob_reference_missing");
    }
  }
  const sourceByPath = sourceEntries;
  for (const entry of state.workspaceManifest) {
    if (sourceByPath.get(entry.path)?.digest !== entry.digest && !blobDigests.has(entry.digest)) {
      throw new Error("warden_runtime_state_blob_reference_missing");
    }
  }
  for (const preimage of state.rollbackPreimages) {
    if (preimage.blobDigest !== undefined && !blobDigests.has(preimage.blobDigest)) {
      throw new Error("warden_runtime_state_blob_reference_missing");
    }
  }
  if (state.pendingEffect.kind !== "none") {
    if (!blobDigests.has(state.pendingEffect.requestDigest) ||
        (state.pendingEffect.resultDigest !== undefined &&
          !blobDigests.has(state.pendingEffect.resultDigest))) {
      throw new Error("warden_runtime_state_blob_reference_missing");
    }
  }
  for (const receipt of state.effectReceipts) {
    if (!blobDigests.has(receipt.requestDigest) || !blobDigests.has(receipt.resultDigest)) {
      throw new Error("warden_runtime_state_blob_reference_missing");
    }
  }
  const mutationTargets = new Map<string, Readonly<{ path: string; digest: string }>>();
  for (const event of state.events) {
    if (event.mutation) {
      const identity = mutationIdentity(event);
      mutationTargets.set(identity.path.toLowerCase(), identity);
    }
  }
  if (mutationTargets.size !== state.rollbackPreimages.length) {
    throw new Error("warden_runtime_state_rollback_invalid");
  }
  for (const sourceEntry of state.sourceManifest) {
    if (!state.workspaceManifest.some((entry) => entry.path === sourceEntry.path) &&
        mutationTargets.get(sourceEntry.path.toLowerCase())?.digest !==
          ABSENT_FILE_EVIDENCE_DIGEST) {
      throw new Error("warden_runtime_state_workspace_manifest_invalid");
    }
  }
  for (const identity of mutationTargets.values()) {
    const preimage = state.rollbackPreimages.find(
      (entry) => entry.path.toLowerCase() === identity.path.toLowerCase(),
    );
    const sourceEntry = sourceEntries.get(identity.path);
    if (!preimage || preimage.path !== identity.path ||
        (sourceEntry === undefined
          ? preimage.existed || preimage.blobDigest !== undefined
          : !preimage.existed || preimage.blobDigest !== sourceEntry.digest)) {
      throw new Error("warden_runtime_state_rollback_invalid");
    }
  }
}

function normalizeState(state: WardenPrivateRuntimeStateV1): WardenPrivateRuntimeStateV1 {
  return {
    ...state,
    sourceManifest: [...state.sourceManifest].sort((a, b) => compareCodeUnits(a.path, b.path)),
    workspaceManifest: [...state.workspaceManifest].sort((a, b) => compareCodeUnits(a.path, b.path)),
    sourceEvidence: [...state.sourceEvidence].sort((a, b) => compareCodeUnits(a.path, b.path)),
    observedDirectories: [...state.observedDirectories].sort(compareCodeUnits),
    searches: [...state.searches].sort((a, b) => compareCodeUnits(canonical(a), canonical(b))),
    rollbackPreimages: [...state.rollbackPreimages]
      .sort((a, b) => compareCodeUnits(a.path, b.path)),
    blobs: [...state.blobs].sort((a, b) => compareCodeUnits(a.digest, b.digest)),
  };
}

export function encodeWardenRuntimeState(state: WardenPrivateRuntimeStateV1): Uint8Array {
  validateState(state);
  const encoded = Buffer.from(canonical(normalizeState(state)), "utf8");
  if (encoded.byteLength < 1 || encoded.byteLength > MAX_RUNTIME_BYTES) {
    throw new Error("warden_runtime_state_size_invalid");
  }
  return encoded;
}

export function decodeWardenRuntimeState(
  encoded: Uint8Array,
  expectedBinding: WardenCheckpointBinding,
): WardenPrivateRuntimeStateV1 {
  if (!(encoded instanceof Uint8Array) || encoded.byteLength < 1 ||
      encoded.byteLength > MAX_RUNTIME_BYTES) {
    throw new Error("warden_runtime_state_size_invalid");
  }
  let parsed: WardenPrivateRuntimeStateV1;
  try {
    parsed = JSON.parse(Buffer.from(encoded).toString("utf8")) as WardenPrivateRuntimeStateV1;
  } catch {
    throw new Error("warden_runtime_state_invalid");
  }
  validateState(parsed);
  const normalized = normalizeState(parsed);
  if (!Buffer.from(encodeWardenRuntimeState(normalized)).equals(Buffer.from(encoded))) {
    throw new Error("warden_runtime_state_noncanonical");
  }
  validateBinding(expectedBinding);
  if (canonical(normalized.binding) !== canonical(expectedBinding)) {
    throw new Error("warden_runtime_state_binding_mismatch");
  }
  return normalized;
}

export function createWardenRuntimeManifestDigest(
  entries: readonly WardenRuntimeManifestEntry[],
): string {
  validateManifest(entries, "warden_runtime_state_source_manifest_invalid");
  return sha256(canonical([...entries].sort((a, b) => compareCodeUnits(a.path, b.path))));
}

export function validateWardenRuntimeStateTransition(
  current: WardenPrivateRuntimeStateV1,
  next: WardenPrivateRuntimeStateV1,
): void {
  const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
  const prefix = (left: readonly unknown[], right: readonly unknown[]): boolean =>
    left.length <= right.length && left.every((value, index) => same(value, right[index]));
  const retained = (left: readonly unknown[], right: readonly unknown[]): boolean => {
    const counts = new Map<string, number>();
    for (const value of right) {
      const key = canonical(value);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const value of left) {
      const key = canonical(value);
      const count = counts.get(key) ?? 0;
      if (count < 1) return false;
      counts.set(key, count - 1);
    }
    return true;
  };
  const reject = (field: string): never => {
    throw new Error(`warden_runtime_state_transition_invalid:${field}`);
  };
  if (next.generation !== current.generation + 1) reject("generation");
  if (!same(next.binding, current.binding)) reject("binding");
  if (next.workspaceName !== current.workspaceName) reject("workspace");
  if (next.executorDigest !== current.executorDigest) reject("executor");
  if (next.phase === "terminal" && current.phase !== "agent_running") {
    reject("phase");
  }
  if (current.phase === "terminal" && next.phase !== "terminal") {
    reject("phase");
  }
  if (!same(next.sourceManifest, current.sourceManifest)) reject("source_manifest");
  if (!prefix(current.events, next.events)) reject("events");
  if (!prefix(current.modelCalls, next.modelCalls)) reject("model_calls");
  if (!prefix(current.privateHistory, next.privateHistory)) reject("private_history");
  if (!same(current.privateState, next.privateState) &&
      !same(next.privateHistory[current.privateHistory.length], current.privateState)) {
    reject("private_state");
  }
  if (!retained(current.sourceEvidence, next.sourceEvidence)) reject("source_evidence");
  if (!retained(current.observedDirectories, next.observedDirectories)) reject("directories");
  if (!retained(current.searches, next.searches)) reject("searches");
  if (!retained(current.rollbackPreimages, next.rollbackPreimages)) reject("rollback");
  if (!retained(current.blobs, next.blobs)) reject("blobs");
  if (!prefix(current.effectReceipts, next.effectReceipts)) reject("effect_receipts");
  const currentEffect = current.pendingEffect;
  const nextEffect = next.pendingEffect;
  const appendedReceipts = next.effectReceipts.slice(current.effectReceipts.length);
  const appendedSuccessfulModelCalls = next.modelCalls.slice(current.modelCalls.length)
    .filter((call) => call.status === "succeeded");
  const appendedModelCalls = next.modelCalls.slice(current.modelCalls.length);
  const appendedModelReceipts = appendedReceipts.filter((receipt) => receipt.kind === "model");
  const appendedModelEvents = next.events.slice(current.events.length)
    .filter((event) => event.plannerSource === "model" && event.executed);
  const currentModelReceipts = new Map(current.effectReceipts
    .filter((receipt) => receipt.kind === "model")
    .map((receipt) => [receipt.effectId, receipt]));
  const usedModelEffectIds = new Set(current.events
    .filter((event) => event.modelEffectId !== undefined)
    .map((event) => event.modelEffectId!));
  for (const event of appendedModelEvents) {
    if (event.modelEffectId === undefined) continue;
    const receipt = currentModelReceipts.get(event.modelEffectId);
    if (!receipt || usedModelEffectIds.has(event.modelEffectId) ||
        jsonRecord(event.call, "warden_runtime_state_event_invalid").tool !== event.tool ||
        sha256(canonical(event.modelPlannedCall ?? event.call)) !== receipt.plannedCallDigest) {
      reject("model_event");
    }
    usedModelEffectIds.add(event.modelEffectId);
  }
  const appendedLegacyModelEvents = appendedModelEvents
    .filter((event) => event.modelEffectId === undefined).length;
  const appendedUnexecutedModelEvents = next.events.slice(current.events.length)
    .filter((event) => event.plannerSource === "model" && !event.executed).length;
  const receiptConsumptionInvalid = appendedModelReceipts.length > 0 &&
    (appendedModelCalls.length !== appendedModelReceipts.length ||
      appendedSuccessfulModelCalls.length !== appendedModelReceipts.length ||
      appendedModelEvents.length !== 0);
  const receiptAccountingInvalid = appendedModelReceipts.some((receipt, index) =>
    canonical(receipt.modelAccounting) !== canonical(appendedModelCalls[index])
  );
  const legacyOrToolStepInvalid = appendedModelReceipts.length === 0 &&
    appendedLegacyModelEvents !== appendedSuccessfulModelCalls.length;
  if (appendedUnexecutedModelEvents > 0 || receiptConsumptionInvalid ||
      receiptAccountingInvalid || legacyOrToolStepInvalid) {
    reject("model_calls");
  }
  if (currentEffect.kind === "none") {
    if (appendedReceipts.length !== 0 ||
        (nextEffect.kind !== "none" && nextEffect.state !== "prepared")) {
      throw new Error("warden_runtime_state_pending_effect_transition_invalid");
    }
    return;
  }
  const sameIdentity = nextEffect.kind !== "none" &&
    nextEffect.kind === currentEffect.kind && nextEffect.effectId === currentEffect.effectId &&
    nextEffect.requestDigest === currentEffect.requestDigest;
  if (currentEffect.state === "prepared") {
    if (appendedReceipts.length !== 0 || !sameIdentity ||
        (nextEffect.state !== "prepared" && nextEffect.state !== "dispatched")) {
      throw new Error("warden_runtime_state_pending_effect_transition_invalid");
    }
    return;
  }
  if (currentEffect.state === "dispatched") {
    if (appendedReceipts.length !== 0 || !sameIdentity ||
        (nextEffect.state !== "dispatched" && nextEffect.state !== "completed")) {
      throw new Error("warden_runtime_state_pending_effect_transition_invalid");
    }
    return;
  }
  if (nextEffect.kind === "none") {
    const receipt = appendedReceipts[0];
    const appendedEvents = next.events.slice(current.events.length);
    const resultBlob = next.blobs.find((blob) => blob.digest === currentEffect.resultDigest);
    const effectEventInvalid = currentEffect.kind === "tool" || currentEffect.kind === "verifier"
      ? appendedEvents.length !== 1 ||
        appendedEvents[0]?.effectId !== currentEffect.effectId ||
        appendedEvents[0]?.category !== (currentEffect.kind === "verifier" ? "verifier" : "tool") ||
        !appendedEvents[0]?.executed ||
        !resultBlob || canonical(effectEventResultFromBytes(
          Buffer.from(resultBlob.contentBase64, "base64"),
        )) !== canonical(appendedEvents[0]?.result)
      : appendedEvents.some((event) => event.effectId === currentEffect.effectId);
    if (appendedReceipts.length !== 1 || receipt?.kind !== currentEffect.kind ||
        receipt.effectId !== currentEffect.effectId ||
        receipt.requestDigest !== currentEffect.requestDigest ||
        receipt.resultDigest !== currentEffect.resultDigest || effectEventInvalid) {
      throw new Error("warden_runtime_state_pending_effect_transition_invalid");
    }
    return;
  }
  if (appendedReceipts.length !== 0 || !sameIdentity || nextEffect.state !== "completed" ||
      nextEffect.resultDigest !== currentEffect.resultDigest) {
    throw new Error("warden_runtime_state_pending_effect_transition_invalid");
  }
}

export function projectWardenCheckpointPayload(
  state: WardenPrivateRuntimeStateV1,
  key: Uint8Array,
): WardenCheckpointPayload {
  const encoded = encodeWardenRuntimeState(state);
  const normalized = decodeWardenRuntimeState(encoded, state.binding);
  if (createWardenRuntimeManifestDigest(normalized.sourceManifest) !==
      normalized.binding.sourceManifestSha256) {
    throw new Error("warden_runtime_state_source_manifest_invalid");
  }
  const source = new Map(normalized.sourceManifest.map((entry) => [entry.path, entry]));
  const workspace = new Map(normalized.workspaceManifest.map((entry) => [entry.path, entry]));
  for (const evidence of normalized.sourceEvidence) {
    const sourceEntry = source.get(evidence.path);
    if (!sourceEntry || sourceEntry.digest !== evidence.digest || sourceEntry.bytes !== evidence.bytes) {
      throw new Error("warden_runtime_state_source_evidence_invalid");
    }
  }
  const changedFiles = [...new Set([...source.keys(), ...workspace.keys()])]
    .filter((path) => source.get(path)?.digest !== workspace.get(path)?.digest)
    .map((path) => ({
      path,
      digest: workspace.get(path)?.digest ?? ABSENT_FILE_EVIDENCE_DIGEST,
    }))
    .sort((a, b) => compareCodeUnits(a.path, b.path));
  const executed = normalized.events.filter((event) => event.executed);
  const successfulMutationCount = executed.filter((event) => event.mutation).length;
  if (normalized.sourceCounters.groundedMutations !== successfulMutationCount) {
    throw new Error("warden_runtime_state_counters_invalid");
  }
  const finalMutationDigests = new Map<string, string>();
  for (const event of executed) {
    if (event.mutation) {
      const identity = mutationIdentity(event);
      finalMutationDigests.set(identity.path, identity.digest);
    }
  }
  const changedByPath = new Map(changedFiles.map((entry) => [entry.path, entry.digest]));
  if (changedFiles.some((entry) => finalMutationDigests.get(entry.path) !== entry.digest) ||
      [...finalMutationDigests].some(([path, finalDigest]) =>
        !changedByPath.has(path) && source.get(path)?.digest !== finalDigest
      )) {
    throw new Error("warden_runtime_state_mutation_manifest_mismatch");
  }
  let mutationCount = 0;
  const actionFingerprints: WardenCheckpointPayload["actionFingerprints"][number][] = [];
  const steps = executed.map((event, step) => {
    const callDigest = sha256(canonical(event.call));
    const resultDigest = sha256(canonical(event.result));
    if (event.mutation) {
      mutationCount++;
      actionFingerprints.push({ callDigest, resultDigest, mutationCount });
    }
    return {
      step,
      tool: event.tool,
      ok: event.ok,
      summary: event.summaryCode,
      ...(event.errorCode === undefined ? {} : { error: event.errorCode }),
      plannerSource: event.plannerSource,
      callDigest,
      resultDigest,
    };
  });
  const promptTokens = normalized.modelCalls.reduce((sum, call) => sum + call.promptTokens, 0);
  const completionTokens = normalized.modelCalls.reduce((sum, call) => sum + call.completionTokens, 0);
  const totalTokens = normalized.modelCalls.reduce((sum, call) => sum + call.totalTokens, 0);
  const costUsd = normalized.modelCalls.reduce((sum, call) => sum + call.costUsd, 0);
  return Object.freeze({
    schemaVersion: 1,
    binding: normalized.binding,
    generation: normalized.generation,
    writerLeaseGeneration: normalized.writerLeaseGeneration,
    workspaceName: normalized.workspaceName,
    workspaceDigest: createWardenRuntimeManifestDigest(normalized.workspaceManifest),
    runtimeStateCommitment: createWardenRuntimeStateCommitment(
      encoded,
      key,
      normalized.binding,
      normalized.workspaceName,
      normalized.generation,
    ),
    phase: normalized.phase,
    nextStep: steps.length,
    steps: Object.freeze(steps),
    sourceEvidence: Object.freeze([...normalized.sourceEvidence]),
    observedDirectories: Object.freeze([...normalized.observedDirectories]),
    searchDigests: Object.freeze(normalized.searches.map((search) => sha256(canonical(search))).sort()),
    changedFiles: Object.freeze(changedFiles),
    actionFingerprints: Object.freeze(actionFingerprints),
    counters: Object.freeze({
      mutationCount,
      toolCalls: executed.length,
      verifierCalls: executed.filter((event) => event.category === "verifier").length,
      modelCalls: normalized.modelCalls.length,
      modelSuccessfulCalls: normalized.modelCalls.filter((call) => call.status === "succeeded").length,
      modelFailedCalls: normalized.modelCalls.filter((call) => call.status === "failed").length,
      promptTokens,
      completionTokens,
      totalTokens,
      costUsd,
      ...normalized.sourceCounters,
    }),
    previousEnvelopeDigest: normalized.previousEnvelopeDigest,
    createdAt: normalized.createdAt,
  });
}
