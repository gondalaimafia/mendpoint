import { createHash, randomUUID } from "node:crypto";
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
  rollbackLifecycleRevision: number;
  eligibleBeforeRollback: true;
  rolledBack: true;
  eligibleAfterRollback: false;
  rollbackReason: "lifecycle_not_servable";
  proofDigest: string;
}>;

type ProofDependencies = Readonly<{ apiKey: string; fetch?: typeof fetch }>;

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
    if (/^(?:authorization|api[_-]?key|token|secret|password)$/iu.test(name)) {
      throw new Error("post_trained_input_contains_credentials");
    }
    assertNoCredentials(child, depth + 1);
  }
}

function parseStage(value: unknown): Stage {
  const item = record(value, "post_trained_stage_invalid");
  return Object.freeze({
    idempotencyKey: key(item.idempotencyKey),
    body: record(item.body, "post_trained_stage_invalid"),
  });
}

function parseInput(raw: Buffer): PostTrainedLifecycleProofInput {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); }
  catch { throw new Error("post_trained_input_invalid"); }
  assertNoCredentials(parsed);
  const value = record(parsed, "post_trained_input_invalid");
  if (value.version !== POST_TRAINED_PROOF_VERSION) throw new Error("post_trained_version_invalid");
  const timeoutMs = value.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 300_000) {
    throw new Error("post_trained_timeout_invalid");
  }
  const rollback = record(value.rollback, "post_trained_stage_invalid");
  const reason = requiredText(rollback.reason, "post_trained_rollback_reason_invalid");
  if (reason.length > 2_000) throw new Error("post_trained_rollback_reason_invalid");
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
  const apiKey = requiredText(dependencies.apiKey, "post_trained_api_key_required");
  const base = parseBase(input.apiBaseUrl);
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
  if (lifecycle.state !== "monitored" || !Number.isSafeInteger(lifecycle.revision)) {
    throw new Error("post_trained_registration_not_monitored");
  }

  const eligiblePath = `advanced-ai/post-trained/adapters/${encodeURIComponent(adapterId)}/eligibility`;
  const eligible = await requestJson(transport, base, apiKey, input.timeoutMs, eligiblePath, input.eligibility.body);
  expectBinding(eligible.adapterId, adapterId);
  if (eligible.eligible !== true) throw new Error("post_trained_adapter_not_eligible");

  const rollbackPath = `advanced-ai/post-trained/adapters/${encodeURIComponent(adapterId)}/rollback`;
  const rolledBack = await requestJson(transport, base, apiKey, input.timeoutMs, rollbackPath,
    { expectedArtifactDigest: adapterDigest, reason: input.rollback.reason }, input.rollback.idempotencyKey);
  expectBinding(rolledBack.tenantId, tenantId);
  expectBinding(rolledBack.adapterId, adapterId);
  const rollbackLifecycle = record(rolledBack.lifecycle);
  expectBinding(rollbackLifecycle.artifactDigest, adapterDigest);
  if (rollbackLifecycle.state !== "rolled_back") throw new Error("post_trained_rollback_not_applied");
  if (!Number.isSafeInteger(rollbackLifecycle.revision) || (rollbackLifecycle.revision as number) <= (lifecycle.revision as number)) {
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
    lifecycleRevision: lifecycle.revision as number,
    rollbackLifecycleRevision: rollbackLifecycle.revision as number,
    eligibleBeforeRollback: true,
    rolledBack: true,
    eligibleAfterRollback: false,
    rollbackReason: "lifecycle_not_servable",
  });
  return Object.freeze({ ...report, proofDigest: digest(canonicalJson(report)) });
}

function validateExistingReport(value: unknown): PostTrainedLifecycleProofReport {
  const report = record(value, "post_trained_output_conflict");
  const expectedKeys = [
    "adapterDigest", "adapterId", "apiOrigin", "canary", "canaryId", "eligibleAfterRollback",
    "eligibleBeforeRollback", "evaluation", "evaluationArtifactId", "evaluationId", "inputDigest",
    "lifecycleRevision", "proofDigest", "rollbackLifecycleRevision", "rollbackReason", "rolledBack",
    "tenantId", "trainingJobId", "version",
  ];
  if (Object.keys(report).sort().join("\0") !== expectedKeys.sort().join("\0")) {
    throw new Error("post_trained_output_conflict");
  }
  const proofDigest = report.proofDigest;
  if (typeof proofDigest !== "string") throw new Error("post_trained_output_conflict");
  const { proofDigest: ignored, ...body } = report;
  void ignored;
  if (proofDigest !== digest(canonicalJson(body))) throw new Error("post_trained_output_conflict");
  const parsed = report as unknown as PostTrainedLifecycleProofReport;
  const evaluation = record(parsed.evaluation, "post_trained_output_conflict");
  const canary = record(parsed.canary, "post_trained_output_conflict");
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
      !Number.isSafeInteger(parsed.rollbackLifecycleRevision) || parsed.rollbackLifecycleRevision <= parsed.lifecycleRevision ||
      parsed.eligibleBeforeRollback !== true || parsed.rolledBack !== true ||
      parsed.eligibleAfterRollback !== false || parsed.rollbackReason !== "lifecycle_not_servable") {
    throw new Error("post_trained_output_conflict");
  }
  return Object.freeze(parsed);
}

function existingReport(path: string, inputDigest: string, apiOrigin: string): PostTrainedLifecycleProofReport | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > POST_TRAINED_PROOF_MAX_INPUT_BYTES) {
    throw new Error("post_trained_output_conflict");
  }
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("post_trained_output_conflict"); }
  const report = validateExistingReport(value);
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
  const { input, raw } = readInput(inputFile);
  const inputDigest = digest(raw);
  const replay = existingReport(outputFile, inputDigest, parseBase(input.apiBaseUrl).origin);
  if (replay) return replay;
  const report = await executePostTrainedLifecycleProof(input, inputDigest, dependencies);
  const temporary = resolve(dirname(outputFile), `.${randomUUID()}.post-trained-proof.tmp`);
  try {
    writeFileSync(temporary, `${canonicalJson(report)}\n`, { flag: "wx" });
    linkSync(temporary, outputFile);
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
    const report = await persistPostTrainedLifecycleProof(args.input, args.output, { apiKey: env.MENDPOINT_API_KEY ?? "" });
    io.stdout(`${JSON.stringify({ ok: true, inputDigest: report.inputDigest, adapterId: report.adapterId, output: resolve(args.output) })}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${JSON.stringify({ ok: false, error: safeError(error) })}\n`);
    return 1;
  }
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) process.exitCode = await runPostTrainedLifecycleProofCli(process.argv.slice(2));
