import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, linkSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const POST_TRAINED_PROOF_VERSION = "2026-08-30.v1" as const;
export const POST_TRAINED_PROOF_MAX_INPUT_BYTES = 1024 * 1024;
export const POST_TRAINED_PROOF_MAX_RESPONSE_BYTES = 1024 * 1024;

type Stage = Readonly<{ idempotencyKey: string; body: Record<string, unknown> }>;
type JsonRecord = Record<string, unknown>;

export type PostTrainedLifecycleProofInput = Readonly<{
  version: typeof POST_TRAINED_PROOF_VERSION;
  apiBaseUrl: string;
  timeoutMs: number;
  training: Stage;
  evaluation: Stage;
  canary: Stage;
  registration: Stage;
  eligibility: Readonly<{ body: JsonRecord }>;
  rollback: Readonly<{ idempotencyKey: string; reason: string }>;
}>;

export type PostTrainedLifecycleProofReport = Readonly<{
  version: typeof POST_TRAINED_PROOF_VERSION;
  inputDigest: string;
  apiOrigin: string;
  tenantId: string;
  adapterId: string;
  trainingJobId: string;
  evaluationId: string;
  canaryId: string;
  adapterDigest: string;
  evaluationArtifactId: string;
  evaluation: Readonly<{ successRate: number; regressionRate: number }>;
  canary: Readonly<{ servingRevision: string; observedAt: string; evidenceRefs: readonly string[] }>;
  lifecycleRevision: number;
  proofCheckpoint: Readonly<{
    eventId: string;
    eventHash: string;
    eventSequence: number;
    eligibilityObservationDigest: string;
    observedAt: string;
  }>;
  rollbackLifecycleRevision: number;
  eligibleBeforeRollback: true;
  rolledBack: true;
  eligibleAfterRollback: false;
  rollbackReason: "lifecycle_not_servable";
  proofDigest: string;
  proofKeyId: string;
  proofMac: string;
}>;

type ProofDependencies = Readonly<{
  apiKey: string;
  apiBaseUrl: string;
  proofSigningKeyBase64: string;
  proofSigningKeyId: string;
  proofVerificationKeyringJson: string;
  fetch?: typeof fetch;
}>;

type ProofVerificationKey = Readonly<{
  status: "retained" | "revoked";
  key?: Buffer;
}>;

type ProofAuthority = Readonly<{
  signingKey: Buffer;
  signingKeyId: string;
  verificationKeys: ReadonlyMap<string, ProofVerificationKey>;
}>;

function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function record(value: unknown, code = "post_trained_response_invalid"): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as JsonRecord;
}

function requiredText(value: unknown, code = "post_trained_response_invalid"): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2_000) throw new Error(code);
  return value;
}

function rate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("post_trained_response_invalid");
  }
  return value;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function identifier(value: unknown): string {
  const candidate = requiredText(value, "post_trained_identifier_invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(candidate)) {
    throw new Error("post_trained_identifier_invalid");
  }
  return candidate;
}

function exactRecord(value: unknown, allowed: readonly string[], code: string): JsonRecord {
  const item = record(value, code);
  const allowedKeys = new Set(allowed);
  if (Object.keys(item).some((name) => !allowedKeys.has(name))) throw new Error(code);
  return item;
}

function normalizedSecretName(value: string): string {
  return value.normalize("NFKC").replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function decodeProofKey(value: unknown): Buffer {
  const encoded = requiredText(value, "post_trained_proof_authority_invalid");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new Error("post_trained_proof_authority_invalid");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length < 32 || key.length > 128 || key.toString("base64") !== encoded) {
    throw new Error("post_trained_proof_authority_invalid");
  }
  return key;
}

function proofAuthority(dependencies: ProofDependencies): ProofAuthority {
  const signingKeyId = identifier(dependencies.proofSigningKeyId);
  const signingKey = decodeProofKey(dependencies.proofSigningKeyBase64);
  const serialized = dependencies.proofVerificationKeyringJson;
  if (typeof serialized !== "string" || !serialized.trim() || serialized.length > 128 * 1024) {
    throw new Error("post_trained_proof_authority_invalid");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); }
  catch { throw new Error("post_trained_proof_authority_invalid"); }
  const root = exactRecord(parsed, ["schemaVersion", "keys"], "post_trained_proof_authority_invalid");
  if (root.schemaVersion !== 1) throw new Error("post_trained_proof_authority_invalid");
  const entries = record(root.keys, "post_trained_proof_authority_invalid");
  if (Object.keys(entries).length > 32) throw new Error("post_trained_proof_authority_invalid");
  const verificationKeys = new Map<string, ProofVerificationKey>();
  const material = new Set<string>([signingKey.toString("base64")]);
  for (const [candidateKeyId, candidate] of Object.entries(entries)) {
    const keyId = identifier(candidateKeyId);
    if (keyId !== candidateKeyId || keyId === signingKeyId) throw new Error("post_trained_proof_authority_invalid");
    const entry = exactRecord(candidate, ["status", "keyBase64"], "post_trained_proof_authority_invalid");
    if (entry.status === "revoked") {
      if (entry.keyBase64 !== undefined) throw new Error("post_trained_proof_authority_invalid");
      verificationKeys.set(keyId, Object.freeze({ status: "revoked" }));
      continue;
    }
    if (entry.status !== "retained") throw new Error("post_trained_proof_authority_invalid");
    const key = decodeProofKey(entry.keyBase64);
    const encoded = key.toString("base64");
    if (material.has(encoded)) throw new Error("post_trained_proof_authority_invalid");
    material.add(encoded);
    verificationKeys.set(keyId, Object.freeze({ status: "retained", key }));
  }
  return Object.freeze({ signingKey, signingKeyId, verificationKeys });
}

function key(value: unknown): string {
  const candidate = requiredText(value, "post_trained_idempotency_invalid");
  if (candidate.length > 200 || /[\r\n]/u.test(candidate)) {
    throw new Error("post_trained_idempotency_invalid");
  }
  return candidate;
}

function assertNoCredentials(value: unknown, depth = 0): void {
  if (depth > 20) throw new Error("post_trained_input_too_deep");
  if (Array.isArray(value)) {
    for (const item of value) assertNoCredentials(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [name, child] of Object.entries(value as JsonRecord)) {
    const normalized = normalizedSecretName(name);
    if (["token", "secret"].includes(normalized) || /(?:authorization|apikey|accesstoken|refreshtoken|bearertoken|clientsecret|privatekey|webhooksecret|password|credential|githubtoken)/u.test(normalized)) {
      throw new Error("post_trained_input_contains_credentials");
    }
    assertNoCredentials(child, depth + 1);
  }
}

function assertStringArray(value: unknown): void {
  if (!Array.isArray(value) || value.length > 256 || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 2_000)) {
    throw new Error("post_trained_stage_schema_invalid");
  }
}

function assertExactNestedSchemas(input: JsonRecord): void {
  const training = exactRecord(record(input.training).body, ["jobId", "adapterId", "baseModelId", "datasetId", "purpose", "residencyRegion", "trainingCorpusArtifactIds", "validationArtifactId", "holdoutArtifactId", "splitManifestDigest", "recipe"], "post_trained_stage_schema_invalid");
  assertStringArray(training.trainingCorpusArtifactIds);
  exactRecord(training.recipe, ["epochs", "maximumExamples", "seed"], "post_trained_stage_schema_invalid");

  const evaluation = exactRecord(record(input.evaluation).body, ["evaluationId", "trainingJobId", "adapterId", "baseline", "evaluator", "policy"], "post_trained_stage_schema_invalid");
  exactRecord(evaluation.baseline, ["executorId", "revision"], "post_trained_stage_schema_invalid");
  exactRecord(evaluation.evaluator, ["harnessVersion", "graderVersion"], "post_trained_stage_schema_invalid");
  exactRecord(evaluation.policy, ["minimumSuccessRate", "maximumRegressionRate", "maximumSecurityRegressions"], "post_trained_stage_schema_invalid");

  exactRecord(record(input.canary).body, ["canaryId", "trainingJobId", "evaluationId", "adapterId"], "post_trained_stage_schema_invalid");
  const registration = exactRecord(record(input.registration).body, ["adapterId", "trainingJobId", "lifecycle", "consent", "descriptor"], "post_trained_stage_schema_invalid");
  const lifecycle = exactRecord(registration.lifecycle, ["tenantId", "adapterId", "state", "revision", "baseModel", "artifactDigest", "trainingDataset", "heldOutEvaluation", "promotionThresholds", "approvedInfrastructure", "servingRevision", "monitoringWindow", "rollbackTarget", "approver", "canaryEvidence", "evidenceRefs", "history"], "post_trained_stage_schema_invalid");
  exactRecord(lifecycle.baseModel, ["modelId", "license", "evidenceRef"], "post_trained_stage_schema_invalid");
  const dataset = exactRecord(lifecycle.trainingDataset, ["datasetId", "lineageRefs", "consent", "sufficiency"], "post_trained_stage_schema_invalid");
  assertStringArray(dataset.lineageRefs);
  const datasetConsent = exactRecord(dataset.consent, ["status", "evidenceRefs"], "post_trained_stage_schema_invalid");
  assertStringArray(datasetConsent.evidenceRefs);
  const datasetSufficiency = exactRecord(dataset.sufficiency, ["representative", "sampleCount", "minimumSampleCount", "evidenceRefs"], "post_trained_stage_schema_invalid");
  assertStringArray(datasetSufficiency.evidenceRefs);
  if (lifecycle.heldOutEvaluation !== undefined) exactRecord(lifecycle.heldOutEvaluation, ["reportRef", "passed", "successRate", "regressionRate"], "post_trained_stage_schema_invalid");
  if (lifecycle.promotionThresholds !== undefined) exactRecord(lifecycle.promotionThresholds, ["minimumSuccessRate", "maximumRegressionRate"], "post_trained_stage_schema_invalid");
  if (lifecycle.approvedInfrastructure !== undefined) exactRecord(lifecycle.approvedInfrastructure, ["approved", "marker", "evidenceRef"], "post_trained_stage_schema_invalid");
  if (lifecycle.monitoringWindow !== undefined) exactRecord(lifecycle.monitoringWindow, ["startsAt", "endsAt"], "post_trained_stage_schema_invalid");
  if (lifecycle.rollbackTarget !== undefined) exactRecord(lifecycle.rollbackTarget, ["servingRevision", "artifactDigest"], "post_trained_stage_schema_invalid");
  if (lifecycle.approver !== undefined) exactRecord(lifecycle.approver, ["principalId", "approvedAt", "evidenceRef"], "post_trained_stage_schema_invalid");
  if (lifecycle.canaryEvidence !== undefined) assertStringArray(exactRecord(lifecycle.canaryEvidence, ["passed", "observedAt", "evidenceRefs"], "post_trained_stage_schema_invalid").evidenceRefs);
  assertStringArray(lifecycle.evidenceRefs);
  if (!Array.isArray(lifecycle.history)) throw new Error("post_trained_stage_schema_invalid");
  for (const event of lifecycle.history) assertStringArray(exactRecord(event, ["revision", "from", "to", "actorId", "occurredAt", "evidenceRefs"], "post_trained_stage_schema_invalid").evidenceRefs);

  assertStringArray(exactRecord(registration.consent, ["tenantId", "datasetId", "revision", "status", "evidenceRefs", "checkedAt", "expiresAt"], "post_trained_stage_schema_invalid").evidenceRefs);
  const descriptor = exactRecord(registration.descriptor, ["executorId", "providerId", "kind", "version", "deployment", "capabilities", "tools", "regions", "price", "limits", "health", "license", "maximumDataClassification", "maximumRisk", "qualityScore", "estimatedLatencyMs", "estimatedCostUsd"], "post_trained_stage_schema_invalid");
  assertStringArray(descriptor.capabilities);
  assertStringArray(descriptor.tools);
  assertStringArray(descriptor.regions);
  exactRecord(descriptor.price, ["version", "currency", "effectiveAt"], "post_trained_stage_schema_invalid");
  exactRecord(descriptor.limits, ["maximumInputTokens", "maximumOutputTokens", "maximumConcurrentTasks"], "post_trained_stage_schema_invalid");
  exactRecord(descriptor.health, ["status", "checkedAt", "evidenceRef"], "post_trained_stage_schema_invalid");
  exactRecord(descriptor.license, ["id", "commercialUse", "redistribution"], "post_trained_stage_schema_invalid");

  const eligibility = exactRecord(input.eligibility, ["body"], "post_trained_stage_schema_invalid");
  const eligibilityBody = exactRecord(eligibility.body, ["task"], "post_trained_stage_schema_invalid");
  const task = exactRecord(eligibilityBody.task, ["taskId", "tenantId", "kind", "goal", "idempotencyKey", "inputArtifactIds", "requiredCapabilities", "allowedTools", "context", "verification", "fallbackPolicy", "privacy", "risk", "quality", "latency", "budget"], "post_trained_stage_schema_invalid");
  assertStringArray(task.inputArtifactIds);
  assertStringArray(task.requiredCapabilities);
  assertStringArray(task.allowedTools);
  exactRecord(task.context, ["estimatedInputTokens", "maximumOutputTokens"], "post_trained_stage_schema_invalid");
  assertStringArray(exactRecord(task.verification, ["requiredChecks", "requireAll", "onFailure"], "post_trained_stage_schema_invalid").requiredChecks);
  const fallbackPolicy = exactRecord(task.fallbackPolicy, ["enabled", "maxAttempts", "sameExecutorRetries", "retryableFailures", "fallbackFailures"], "post_trained_stage_schema_invalid");
  assertStringArray(fallbackPolicy.retryableFailures);
  assertStringArray(fallbackPolicy.fallbackFailures);
  exactRecord(task.privacy, ["classification", "requiredRegion"], "post_trained_stage_schema_invalid");
  exactRecord(task.quality, ["minimumScore"], "post_trained_stage_schema_invalid");
  exactRecord(task.latency, ["maximumMs"], "post_trained_stage_schema_invalid");
  exactRecord(task.budget, ["maximumUsd"], "post_trained_stage_schema_invalid");
}

function assertExactInputSchema(value: JsonRecord): void {
  for (const name of ["training", "evaluation", "canary", "registration"]) {
    exactRecord(value[name], ["idempotencyKey", "body"], "post_trained_stage_schema_invalid");
  }
  exactRecord(value.rollback, ["idempotencyKey", "reason"], "post_trained_stage_schema_invalid");
  assertExactNestedSchemas(value);
}

function parseStage(value: unknown): Stage {
  const item = exactRecord(value, ["idempotencyKey", "body"], "post_trained_stage_schema_invalid");
  return Object.freeze({
    idempotencyKey: key(item.idempotencyKey),
    body: record(item.body, "post_trained_stage_invalid"),
  });
}

function validateInput(parsed: unknown): PostTrainedLifecycleProofInput {
  assertNoCredentials(parsed);
  const value = exactRecord(parsed, ["version", "apiBaseUrl", "timeoutMs", "training", "evaluation", "canary", "registration", "eligibility", "rollback"], "post_trained_input_schema_invalid");
  if (value.version !== POST_TRAINED_PROOF_VERSION) throw new Error("post_trained_version_invalid");
  assertExactInputSchema(value);
  const timeoutMs = value.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 300_000) {
    throw new Error("post_trained_timeout_invalid");
  }
  const rollback = record(value.rollback, "post_trained_stage_invalid");
  const reason = requiredText(rollback.reason, "post_trained_rollback_reason_invalid");
  if (reason.length > 2_000 || /[\r\n]/u.test(reason)) throw new Error("post_trained_rollback_reason_invalid");
  return Object.freeze({
    version: POST_TRAINED_PROOF_VERSION,
    apiBaseUrl: requiredText(value.apiBaseUrl, "post_trained_api_url_invalid"),
    timeoutMs: timeoutMs as number,
    training: parseStage(value.training),
    evaluation: parseStage(value.evaluation),
    canary: parseStage(value.canary),
    registration: parseStage(value.registration),
    eligibility: Object.freeze({
      body: record(record(value.eligibility, "post_trained_stage_invalid").body, "post_trained_stage_invalid"),
    }),
    rollback: Object.freeze({ idempotencyKey: key(rollback.idempotencyKey), reason }),
  });
}

function parseInput(raw: Buffer): PostTrainedLifecycleProofInput {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); }
  catch { throw new Error("post_trained_input_invalid"); }
  return validateInput(parsed);
}

export function postTrainedLifecycleProofInputDigest(input: PostTrainedLifecycleProofInput): string {
  return digest(canonicalJson(validateInput(input)));
}

function readInput(pathValue: string): Readonly<{ input: PostTrainedLifecycleProofInput; raw: Buffer }> {
  const path = resolve(pathValue);
  let stat;
  try { stat = lstatSync(path); }
  catch { throw new Error("post_trained_input_unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("post_trained_input_not_regular");
  if (stat.size < 1 || stat.size > POST_TRAINED_PROOF_MAX_INPUT_BYTES) {
    throw new Error("post_trained_input_size_invalid");
  }
  const raw = readFileSync(path);
  if (raw.length < 1 || raw.length > POST_TRAINED_PROOF_MAX_INPUT_BYTES) {
    throw new Error("post_trained_input_size_invalid");
  }
  return Object.freeze({ input: parseInput(raw), raw });
}

function parseBase(value: string): URL {
  let base: URL;
  try { base = new URL(value); }
  catch { throw new Error("post_trained_api_url_invalid"); }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) ||
      base.username || base.password || base.search || base.hash) {
    throw new Error("post_trained_api_url_invalid");
  }
  base.pathname = `${base.pathname.replace(/\/+$/u, "")}/`;
  return base;
}

async function requestJson(
  transport: typeof fetch,
  base: URL,
  apiKey: string,
  timeoutMs: number,
  path: string,
  body: unknown,
  idempotency?: string,
): Promise<JsonRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("post_trained_request_failed")), { once: true });
  });
  try {
    const response = await Promise.race([transport(new URL(path, base), {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
        ...(idempotency ? { "idempotency-key": idempotency } : {}),
      },
      body: JSON.stringify(body),
    }), aborted]);
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new Error("post_trained_redirect_refused");
    }
    const location = response.headers.get("location");
    if (location) {
      let located: URL;
      try { located = new URL(location, base); }
      catch { throw new Error("post_trained_location_invalid"); }
      if (located.origin !== base.origin) throw new Error("post_trained_location_invalid");
    }
    const declaredHeader = response.headers.get("content-length");
    if (declaredHeader !== null) {
      const declared = Number(declaredHeader);
      if (!Number.isSafeInteger(declared) || declared < 0) throw new Error("post_trained_response_invalid");
      if (declared > POST_TRAINED_PROOF_MAX_RESPONSE_BYTES) throw new Error("post_trained_response_too_large");
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      while (true) {
        const part = await Promise.race([reader.read(), aborted]);
        if (part.done) break;
        total += part.value.byteLength;
        if (total > POST_TRAINED_PROOF_MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("post_trained_response_too_large");
        }
        chunks.push(part.value);
      }
    }
    const raw = reader ? Buffer.concat(chunks, total).toString("utf8") : await response.text();
    if (Buffer.byteLength(raw) > POST_TRAINED_PROOF_MAX_RESPONSE_BYTES) {
      throw new Error("post_trained_response_too_large");
    }
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new Error("post_trained_response_invalid"); }
    if (!response.ok) {
      const code = record(value).error;
      const safe = typeof code === "string" && /^[a-z0-9_.:-]{1,160}$/u.test(code) ? code : "unknown";
      throw new Error(`post_trained_http_${response.status}:${safe}`);
    }
    return record(value);
  } catch (error) {
    if (error instanceof Error && /^post_trained_/u.test(error.message)) throw error;
    throw new Error("post_trained_request_failed");
  } finally {
    clearTimeout(timer);
  }
}

function expectBinding(actual: unknown, expected: string): void {
  if (actual !== expected) throw new Error("post_trained_stage_binding_mismatch");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const item = value as JsonRecord;
  return `{${Object.keys(item).filter((name) => item[name] !== undefined).sort()
    .map((name) => `${JSON.stringify(name)}:${canonicalJson(item[name])}`).join(",")}}`;
}

export async function executePostTrainedLifecycleProof(
  input: PostTrainedLifecycleProofInput,
  inputDigest: string,
  dependencies: ProofDependencies,
): Promise<PostTrainedLifecycleProofReport> {
  input = validateInput(input);
  if (inputDigest !== postTrainedLifecycleProofInputDigest(input)) throw new Error("post_trained_input_digest_mismatch");
  const requestedBase = parseBase(input.apiBaseUrl);
  const base = parseBase(requiredText(dependencies.apiBaseUrl, "post_trained_api_url_invalid"));
  if (requestedBase.href !== base.href) throw new Error("post_trained_api_url_untrusted");
  const apiKey = requiredText(dependencies.apiKey, "post_trained_api_key_required");
  const authority = proofAuthority(dependencies);
  const transport = dependencies.fetch ?? fetch;
  const trainingJobId = identifier(input.training.body.jobId);
  const adapterId = identifier(input.training.body.adapterId);
  const sourceLifecycle = record(input.registration.body.lifecycle, "post_trained_registration_invalid");
  const tenantId = identifier(sourceLifecycle.tenantId);
  expectBinding(sourceLifecycle.adapterId, adapterId);
  expectBinding(input.registration.body.adapterId, adapterId);
  expectBinding(input.registration.body.trainingJobId, trainingJobId);
  const sourceConsent = record(input.registration.body.consent, "post_trained_registration_invalid");
  expectBinding(sourceConsent.tenantId, tenantId);
  const eligibilityTask = record(input.eligibility.body.task, "post_trained_stage_invalid");
  expectBinding(eligibilityTask.tenantId, tenantId);

  const training = await requestJson(transport, base, apiKey, input.timeoutMs,
    "advanced-ai/post-trained/training-jobs", input.training.body, input.training.idempotencyKey);
  expectBinding(training.tenantId, tenantId);
  expectBinding(training.jobId, trainingJobId);
  expectBinding(training.adapterId, adapterId);
  if (training.status !== "completed") throw new Error("post_trained_training_not_completed");
  const adapterDigest = requiredText(training.adapterDigest);
  if (!/^sha256:[a-f0-9]{64}$/u.test(adapterDigest)) throw new Error("post_trained_adapter_digest_invalid");

  const evaluationId = identifier(input.evaluation.body.evaluationId);
  expectBinding(input.evaluation.body.trainingJobId, trainingJobId);
  expectBinding(input.evaluation.body.adapterId, adapterId);
  const evaluation = await requestJson(transport, base, apiKey, input.timeoutMs,
    "advanced-ai/post-trained/evaluations", input.evaluation.body, input.evaluation.idempotencyKey);
  expectBinding(evaluation.tenantId, tenantId);
  expectBinding(evaluation.evaluationId, evaluationId);
  expectBinding(evaluation.trainingJobId, trainingJobId);
  expectBinding(evaluation.adapterId, adapterId);
  if (evaluation.status !== "passed") throw new Error("post_trained_evaluation_not_passed");
  const evaluationArtifactId = identifier(evaluation.reportArtifactId);
  const successRate = rate(evaluation.successRate);
  const regressionRate = rate(evaluation.regressionRate);
  if (evaluation.overlapCount !== 0) throw new Error("post_trained_evaluation_overlap_detected");

  const canaryId = identifier(input.canary.body.canaryId);
  expectBinding(input.canary.body.trainingJobId, trainingJobId);
  expectBinding(input.canary.body.evaluationId, evaluationId);
  expectBinding(input.canary.body.adapterId, adapterId);
  const canary = await requestJson(transport, base, apiKey, input.timeoutMs,
    "advanced-ai/post-trained/canaries", input.canary.body, input.canary.idempotencyKey);
  expectBinding(canary.tenantId, tenantId);
  expectBinding(canary.canaryId, canaryId);
  expectBinding(canary.adapterId, adapterId);
  if (canary.status !== "passed") throw new Error("post_trained_canary_not_passed");
  const servingRevision = requiredText(canary.servingRevision);
  const observedAt = requiredText(canary.observedAt);
  if (!canonicalTimestamp(observedAt) || Date.parse(observedAt) > Date.now()) {
    throw new Error("post_trained_response_invalid");
  }
  if (!Array.isArray(canary.evidenceRefs) || !canary.evidenceRefs.length || canary.evidenceRefs.length > 64 ||
      canary.evidenceRefs.some((value) => typeof value !== "string" || !value.trim() || value.length > 2_000)) {
    throw new Error("post_trained_response_invalid");
  }
  const evidenceRefs = Object.freeze([...new Set(canary.evidenceRefs as string[])].sort());

  const registrationBody = {
    ...input.registration.body,
    adapterId,
    trainingJobId,
    lifecycle: {
      ...sourceLifecycle,
      artifactDigest: adapterDigest,
      heldOutEvaluation: { reportRef: evaluationArtifactId, passed: true, successRate, regressionRate },
      canaryEvidence: { passed: true, observedAt, evidenceRefs },
    },
  };
  const registered = await requestJson(transport, base, apiKey, input.timeoutMs,
    "advanced-ai/post-trained/adapters", registrationBody, input.registration.idempotencyKey);
  expectBinding(registered.tenantId, tenantId);
  expectBinding(registered.adapterId, adapterId);
  expectBinding(registered.trainingJobId, trainingJobId);
  const lifecycle = record(registered.lifecycle);
  expectBinding(lifecycle.artifactDigest, adapterDigest);
  expectBinding(lifecycle.servingRevision, servingRevision);
  const registeredEvaluation = record(lifecycle.heldOutEvaluation);
  expectBinding(registeredEvaluation.reportRef, evaluationArtifactId);
  if (registeredEvaluation.passed !== true || registeredEvaluation.successRate !== successRate ||
      registeredEvaluation.regressionRate !== regressionRate) {
    throw new Error("post_trained_stage_binding_mismatch");
  }
  const registeredCanary = record(lifecycle.canaryEvidence);
  expectBinding(registeredCanary.observedAt, observedAt);
  if (registeredCanary.passed !== true || canonicalJson(registeredCanary.evidenceRefs) !== canonicalJson(evidenceRefs)) {
    throw new Error("post_trained_stage_binding_mismatch");
  }
  const sourceRevision = sourceLifecycle.revision;
  if (!Number.isSafeInteger(sourceRevision) || (sourceRevision as number) < 1 ||
      !Number.isSafeInteger(lifecycle.revision) ||
      !["monitored", "rolled_back"].includes(lifecycle.state as string)) {
    throw new Error("post_trained_registration_not_monitored");
  }
  const resumedAfterRollback = lifecycle.state === "rolled_back";
  if ((!resumedAfterRollback && lifecycle.revision !== sourceRevision) ||
      (resumedAfterRollback && lifecycle.revision !== (sourceRevision as number) + 1)) {
    throw new Error("post_trained_registration_revision_invalid");
  }

  const rollbackPath = `advanced-ai/post-trained/adapters/${encodeURIComponent(adapterId)}/rollback`;
  const rollbackRequest = { expectedArtifactDigest: adapterDigest, reason: input.rollback.reason, idempotencyKey: input.rollback.idempotencyKey };
  const checkpoint = await requestJson(transport, base, apiKey, input.timeoutMs,
    `advanced-ai/post-trained/adapters/${encodeURIComponent(adapterId)}/proof-checkpoints`,
    { inputDigest, task: input.eligibility.body.task, rollback: rollbackRequest }, input.rollback.idempotencyKey);
  expectBinding(checkpoint.adapterId, adapterId);
  expectBinding(checkpoint.inputDigest, inputDigest);
  expectBinding(checkpoint.eligibilityRequestDigest, digest(canonicalJson(input.eligibility.body)));
  expectBinding(checkpoint.rollbackRequestDigest, digest(canonicalJson(rollbackRequest)));
  if (checkpoint.eligible !== true) throw new Error("post_trained_adapter_not_eligible");
  if (!/^sha256:[a-f0-9]{64}$/u.test(requiredText(checkpoint.eligibilityObservationDigest)) ||
      !/^[a-f0-9]{64}$/u.test(requiredText(checkpoint.eventHash)) || !Number.isSafeInteger(checkpoint.eventSequence) ||
      (checkpoint.eventSequence as number) < 1 || !canonicalTimestamp(checkpoint.observedAt)) {
    throw new Error("post_trained_proof_checkpoint_invalid");
  }
  const eligiblePath = `advanced-ai/post-trained/adapters/${encodeURIComponent(adapterId)}/eligibility`;
  const rolledBack = await requestJson(transport, base, apiKey, input.timeoutMs, rollbackPath,
    { expectedArtifactDigest: adapterDigest, reason: input.rollback.reason }, input.rollback.idempotencyKey);
  expectBinding(rolledBack.tenantId, tenantId);
  expectBinding(rolledBack.adapterId, adapterId);
  const rollbackLifecycle = record(rolledBack.lifecycle);
  expectBinding(rollbackLifecycle.artifactDigest, adapterDigest);
  if (rollbackLifecycle.state !== "rolled_back") throw new Error("post_trained_rollback_not_applied");
  if (!Number.isSafeInteger(rollbackLifecycle.revision) || rollbackLifecycle.revision !== (sourceRevision as number) + 1) {
    throw new Error("post_trained_rollback_revision_invalid");
  }

  const afterRollback = await requestJson(transport, base, apiKey, input.timeoutMs, eligiblePath, input.eligibility.body);
  expectBinding(afterRollback.adapterId, adapterId);
  if (afterRollback.eligible !== false || afterRollback.reason !== "lifecycle_not_servable") {
    throw new Error("post_trained_rollback_not_enforced");
  }

  const report = Object.freeze({
    version: POST_TRAINED_PROOF_VERSION,
    inputDigest,
    apiOrigin: base.origin,
    tenantId,
    adapterId,
    trainingJobId,
    evaluationId,
    canaryId,
    adapterDigest,
    evaluationArtifactId,
    evaluation: Object.freeze({ successRate, regressionRate }),
    canary: Object.freeze({ servingRevision, observedAt, evidenceRefs }),
    lifecycleRevision: sourceRevision as number,
    proofCheckpoint: Object.freeze({ eventId: identifier(checkpoint.eventId), eventHash: checkpoint.eventHash as string, eventSequence: checkpoint.eventSequence as number, eligibilityObservationDigest: checkpoint.eligibilityObservationDigest as string, observedAt: checkpoint.observedAt as string }),
    rollbackLifecycleRevision: rollbackLifecycle.revision as number,
    eligibleBeforeRollback: true,
    rolledBack: true,
    eligibleAfterRollback: false,
    rollbackReason: "lifecycle_not_servable",
  });
  const authenticatedBody = Object.freeze({ ...report, proofKeyId: authority.signingKeyId });
  const proofDigest = digest(canonicalJson(authenticatedBody));
  const proofMac = createHmac("sha256", authority.signingKey)
    .update(`${proofDigest}\0${canonicalJson(authenticatedBody)}`)
    .digest("hex");
  return Object.freeze({ ...authenticatedBody, proofDigest, proofMac });
}

function validateExistingReport(value: unknown, authority: ProofAuthority): PostTrainedLifecycleProofReport {
  const report = record(value, "post_trained_output_conflict");
  const expectedKeys = [
    "adapterDigest", "adapterId", "apiOrigin", "canary", "canaryId", "eligibleAfterRollback",
    "eligibleBeforeRollback", "evaluation", "evaluationArtifactId", "evaluationId", "inputDigest",
    "lifecycleRevision", "proofCheckpoint", "proofDigest", "proofKeyId", "proofMac", "rollbackLifecycleRevision", "rollbackReason", "rolledBack",
    "tenantId", "trainingJobId", "version",
  ];
  if (Object.keys(report).sort().join("\0") !== expectedKeys.sort().join("\0")) {
    throw new Error("post_trained_output_conflict");
  }
  const proofDigest = report.proofDigest;
  const proofMac = report.proofMac;
  if (typeof proofDigest !== "string" || typeof proofMac !== "string" || typeof report.proofKeyId !== "string") {
    throw new Error("post_trained_output_conflict");
  }
  let verificationKey: Buffer;
  if (report.proofKeyId === authority.signingKeyId) {
    verificationKey = authority.signingKey;
  } else {
    const retained = authority.verificationKeys.get(report.proofKeyId);
    if (!retained) throw new Error("post_trained_proof_key_unknown");
    if (retained.status === "revoked") throw new Error("post_trained_proof_key_revoked");
    if (!retained.key) throw new Error("post_trained_proof_authority_invalid");
    verificationKey = retained.key;
  }
  const { proofDigest: ignored, proofMac: ignoredMac, ...body } = report;
  void ignored;
  void ignoredMac;
  if (proofDigest !== digest(canonicalJson(body))) throw new Error("post_trained_output_conflict");
  const expectedMac = createHmac("sha256", verificationKey)
    .update(`${proofDigest}\0${canonicalJson(body)}`)
    .digest();
  if (!/^[a-f0-9]{64}$/u.test(proofMac)) throw new Error("post_trained_output_conflict");
  const suppliedMac = Buffer.from(proofMac, "hex");
  if (suppliedMac.length !== expectedMac.length || !timingSafeEqual(suppliedMac, expectedMac)) {
    throw new Error("post_trained_output_conflict");
  }
  const parsed = report as unknown as PostTrainedLifecycleProofReport;
  const evaluation = record(parsed.evaluation, "post_trained_output_conflict");
  const canary = record(parsed.canary, "post_trained_output_conflict");
  const checkpoint = record(parsed.proofCheckpoint, "post_trained_output_conflict");
  if (parsed.version !== POST_TRAINED_PROOF_VERSION ||
      typeof parsed.inputDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(parsed.inputDigest) ||
      typeof parsed.apiOrigin !== "string" ||
      [parsed.tenantId, parsed.adapterId, parsed.trainingJobId, parsed.evaluationId, parsed.canaryId, parsed.evaluationArtifactId]
        .some((item) => typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(item)) ||
      typeof parsed.adapterDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(parsed.adapterDigest) ||
      rate(evaluation.successRate) !== evaluation.successRate || rate(evaluation.regressionRate) !== evaluation.regressionRate ||
      typeof canary.servingRevision !== "string" || !canary.servingRevision.trim() ||
      !canonicalTimestamp(canary.observedAt) ||
      !Array.isArray(canary.evidenceRefs) || canary.evidenceRefs.length < 1 || canary.evidenceRefs.length > 64 ||
      canary.evidenceRefs.some((item) => typeof item !== "string" || !item.trim() || item.length > 2_000) ||
      !Number.isSafeInteger(parsed.lifecycleRevision) || parsed.lifecycleRevision < 1 ||
      !identifier(checkpoint.eventId) || typeof checkpoint.eventHash !== "string" || !/^[a-f0-9]{64}$/u.test(checkpoint.eventHash) ||
      !Number.isSafeInteger(checkpoint.eventSequence) || (checkpoint.eventSequence as number) < 1 ||
      typeof checkpoint.eligibilityObservationDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(checkpoint.eligibilityObservationDigest) || !canonicalTimestamp(checkpoint.observedAt) ||
      !Number.isSafeInteger(parsed.rollbackLifecycleRevision) || parsed.rollbackLifecycleRevision <= parsed.lifecycleRevision ||
      parsed.eligibleBeforeRollback !== true || parsed.rolledBack !== true ||
      parsed.eligibleAfterRollback !== false || parsed.rollbackReason !== "lifecycle_not_servable") {
    throw new Error("post_trained_output_conflict");
  }
  return Object.freeze(parsed);
}

function existingReport(path: string, inputDigest: string, apiOrigin: string, authority: ProofAuthority): PostTrainedLifecycleProofReport | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > POST_TRAINED_PROOF_MAX_INPUT_BYTES) {
    throw new Error("post_trained_output_conflict");
  }
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("post_trained_output_conflict"); }
  const report = validateExistingReport(value, authority);
  if (report.version !== POST_TRAINED_PROOF_VERSION || report.inputDigest !== inputDigest ||
      report.apiOrigin !== apiOrigin || report.rolledBack !== true || report.eligibleAfterRollback !== false) {
    throw new Error("post_trained_output_conflict");
  }
  return Object.freeze(report);
}

export async function persistPostTrainedLifecycleProof(
  inputPath: string,
  outputPath: string,
  dependencies: ProofDependencies,
): Promise<PostTrainedLifecycleProofReport> {
  const inputFile = resolve(inputPath);
  const outputFile = resolve(outputPath);
  if (inputFile === outputFile) throw new Error("post_trained_output_must_differ");
  const { input } = readInput(inputFile);
  const inputDigest = postTrainedLifecycleProofInputDigest(input);
  const requestedBase = parseBase(input.apiBaseUrl);
  const protectedBase = parseBase(requiredText(dependencies.apiBaseUrl, "post_trained_api_url_invalid"));
  if (requestedBase.href !== protectedBase.href) throw new Error("post_trained_api_url_untrusted");
  const authority = proofAuthority(dependencies);
  const replay = existingReport(outputFile, inputDigest, protectedBase.origin, authority);
  if (replay) return replay;
  const report = await executePostTrainedLifecycleProof(input, inputDigest, dependencies);
  const temporary = resolve(dirname(outputFile), `.${randomUUID()}.post-trained-proof.tmp`);
  try {
    writeFileSync(temporary, `${canonicalJson(report)}\n`, { flag: "wx" });
    try {
      linkSync(temporary, outputFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const winner = existingReport(outputFile, inputDigest, protectedBase.origin, authority);
      if (!winner || canonicalJson(winner) !== canonicalJson(report)) throw new Error("post_trained_output_conflict");
      rmSync(temporary, { force: true });
      return winner;
    }
    rmSync(temporary);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return report;
}

function parseArgs(argv: readonly string[]): Readonly<{ input: string; output: string }> | null {
  const values = new Map<string, string>();
  for (const value of argv) {
    const match = /^--(input|output)=(.+)$/u.exec(value);
    if (!match || values.has(match[1]!)) return null;
    values.set(match[1]!, match[2]!);
  }
  const input = values.get("input");
  const output = values.get("output");
  return input && output ? Object.freeze({ input, output }) : null;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^post_trained_[a-z0-9_:.-]+$/u.test(message) ? message : "post_trained_proof_failed";
}

export async function runPostTrainedLifecycleProofCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: Readonly<{ stdout: (value: string) => void; stderr: (value: string) => void }> = {
    stdout: (value: string) => { process.stdout.write(value); },
    stderr: (value: string) => { process.stderr.write(value); },
  },
): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    io.stderr(`${JSON.stringify({ ok: false, error: "post_trained_arguments_invalid" })}\n`);
    return 2;
  }
  try {
    const report = await persistPostTrainedLifecycleProof(args.input, args.output, {
      apiKey: env.MENDPOINT_API_KEY ?? "",
      apiBaseUrl: env.MENDPOINT_API_BASE_URL ?? "",
      proofSigningKeyBase64: env.MENDPOINT_ADAPTER_PROOF_SIGNING_KEY_B64 ?? "",
      proofSigningKeyId: env.MENDPOINT_ADAPTER_PROOF_SIGNING_KEY_ID ?? "",
      proofVerificationKeyringJson: env.MENDPOINT_ADAPTER_PROOF_VERIFICATION_KEYRING_JSON ?? "",
    });
    io.stdout(`${JSON.stringify({ ok: true, inputDigest: report.inputDigest, adapterId: report.adapterId, output: resolve(args.output) })}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${JSON.stringify({ ok: false, error: safeError(error) })}\n`);
    return 1;
  }
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) process.exitCode = await runPostTrainedLifecycleProofCli(process.argv.slice(2));
