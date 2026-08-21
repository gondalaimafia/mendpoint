import { createHash, randomBytes } from "node:crypto";
import {
  appendDomainEvent,
  getAgentRun,
  insertArtifactManifest,
  insertEvidenceRecord,
  verifyDomainEventIntegrity,
  type AppDb,
} from "@mendpoint/db";

export type NotObserved = Readonly<{ status: "not_observed"; reason: string }>;

export type DelegatedPrVerificationExecution = Readonly<{
  authorityId: string;
  authorityDigest: string;
  commandDigest: string;
  sourceDigest: string;
  candidateDigest: string;
  baselineExitCode: number;
  candidateExitCode: number;
  baselineVerdict: "test_failure" | "passed";
  // The runner output is not parsed, so which individual checks were failing is never observed.
  // Typed as NotObserved so this layer cannot echo the configured expectation as if it saw it.
  failingCheckIdentities: NotObserved;
  sandboxBackend: string;
  logsDigest: string;
}>;

export type DelegatedPrVerificationResolution =
  | Readonly<{
      status: "completed";
      executionAuthorityId: string;
      failToPass: DelegatedPrVerificationExecution;
      passToPass: DelegatedPrVerificationExecution;
      completedAt: string;
    }>
  | Readonly<{ status: "failed"; code: string; completedAt: string }>
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "safe_to_run" }>;

export type DelegatedPrVerificationReceipt = Readonly<{
  tenantId: string;
  runId: string;
  candidateArtifactId: string;
  requestDigest: string;
  leaseGeneration: number;
  authorityId: string;
  outcome: DelegatedPrVerificationResolution["status"];
  resultDigest: string;
  observedAt: string;
  signature: string;
}>;

export type DelegatedPrVerificationExchange = Readonly<{
  receipt: DelegatedPrVerificationReceipt;
  result: DelegatedPrVerificationResolution;
}>;

export type DelegatedPrVerifierRequest = Readonly<{
  tenantId: string;
  runId: string;
  correlationId: string;
  candidateArtifact: Readonly<{ artifactId: string; sha256: string }>;
  candidate: Readonly<{
    repositoryId: string;
    snapshotId: string;
    revision: string;
    sourceManifestSha256: string;
    sourceTreeDigest: string;
    candidateTreeDigest: string;
    candidateManifestSha256: string;
    changedPaths: readonly string[];
  }>;
  requestDigest: string;
  leaseGeneration: number;
  authorityId: string;
  authorityDigest: string;
  executionAuthorityId: string;
  policy: DelegatedPrVerificationPolicy;
  signal: AbortSignal;
}>;

export type DelegatedPrVerifier = Readonly<{
  verify(input: DelegatedPrVerifierRequest): Promise<DelegatedPrVerificationExchange>;
  reconcile(input: DelegatedPrVerifierRequest): Promise<DelegatedPrVerificationExchange>;
}>;

export type DelegatedPrVerificationPolicy = Readonly<{
  failToPassCommandDigest: string;
  passToPassCommandDigest: string;
  sandboxBackend: string;
}>;

export type RunDelegatedPrVerificationInput = Readonly<{
  tenantId: string;
  runId: string;
  correlationId: string;
  candidateArtifactId: string;
  idempotencyKey: string;
  requestedAt: string;
}>;

export type DelegatedPrVerificationAuthority = Readonly<{
  candidateProducerPrincipalId: string;
  candidateProducerVersion: string;
  authorityId: string;
  authorityDigest: string;
  executionAuthorityId: string;
  mendpointRevision: string;
  policy: DelegatedPrVerificationPolicy;
}>;

export type DelegatedPrVerificationDependencies = DelegatedPrVerificationAuthority & Readonly<{
  enabled?: boolean;
  workerId: string;
  timeoutMs: number;
  leaseMs: number;
  verifier: DelegatedPrVerifier;
  verifyReceipt(receipt: DelegatedPrVerificationReceipt): boolean;
}>;

type ExecutionWithArtifact = DelegatedPrVerificationExecution & Readonly<{
  artifact: Readonly<{ artifactId: string; sha256: string }>;
  evidenceId: string;
}>;

export type DelegatedPrVerificationResult =
  | Readonly<{
      status: "completed";
      tenantId: string;
      runId: string;
      candidateArtifact: Readonly<{ artifactId: string; sha256: string }>;
      candidateDigest: string;
      failToPass: ExecutionWithArtifact;
      passToPass: ExecutionWithArtifact;
      completedAt: string;
    }>
  | Readonly<{
      status: "failed";
      tenantId: string;
      runId: string;
      candidateArtifact: Readonly<{ artifactId: string; sha256: string }>;
      candidateDigest: string;
      code: string;
      completedAt: string;
    }>;

type CandidateClaims = Readonly<{
  schemaVersion: 1;
  kind: "delegated_pr_candidate";
  tenantId: string;
  runId: string;
  jobId: string;
  repositoryId: string;
  snapshotId: string;
  revision: string;
  sourceManifestSha256: string;
  sourceTreeDigest: string;
  candidateTreeDigest: string;
  candidateManifestSha256: string;
  changedPaths: readonly string[];
  createdAt: string;
}>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const EFFECT_TABLE = `CREATE TABLE IF NOT EXISTS delegated_pr_verification_effects (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  candidate_artifact_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  lease_generation INTEGER NOT NULL,
  lease_expires_at_ms INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('dispatched','settled')),
  receipt_json TEXT,
  PRIMARY KEY (tenant_id, run_id)
) STRICT`;
const MEDIA_TYPE = "application/vnd.mendpoint.delegated-pr-verification-execution+json";
const ACTIVE = new Set<string>();
const PROCESS_INSTANCE_ID = randomBytes(16).toString("hex");
const INFRA_EXIT_CODES = new Set([124, 125, 126, 127, 128, 130, 137, 143]);

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function snapshotPlain<T>(value: T, code: string): T {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 10_000 || depth > 20) throw new Error(code);
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error(code);
      return current;
    }
    if (Array.isArray(current)) {
      if (seen.has(current) || current.length > 2_000) throw new Error(code);
      seen.add(current);
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const copy: unknown[] = [];
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) {
          throw new Error(code);
        }
        copy.push(visit(descriptor.value, depth + 1));
      }
      seen.delete(current);
      return copy;
    }
    if (typeof current !== "object" || current === undefined) throw new Error(code);
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null || seen.has(current)) throw new Error(code);
    seen.add(current);
    const copy: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))
      .sort(([left], [right]) => compareCodeUnits(left, right))) {
      if (!("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) throw new Error(code);
      copy[key] = visit(descriptor.value, depth + 1);
    }
    seen.delete(current);
    return copy;
  };
  return deepFreeze(visit(value, 0) as T);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return canonical(Object.keys(value).sort(compareCodeUnits)) === canonical([...keys].sort(compareCodeUnits));
}

function isNotObserved(value: unknown): value is NotObserved {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !exactKeys(value, ["status", "reason"])) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.status === "not_observed" && typeof record.reason === "string" &&
    record.reason.length > 0 && record.reason.length <= 256;
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024 &&
    !value.includes("\0") && !value.includes("\\") && !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function validateInput(
  input: RunDelegatedPrVerificationInput,
  dependencies: DelegatedPrVerificationDependencies,
): void {
  const policy = dependencies.policy;
  const ids = [input.tenantId, input.runId, input.correlationId, input.candidateArtifactId,
    input.idempotencyKey, dependencies.workerId, dependencies.candidateProducerPrincipalId,
    dependencies.authorityId, dependencies.executionAuthorityId, policy.sandboxBackend];
  if (!exactKeys(input, ["tenantId", "runId", "correlationId", "candidateArtifactId",
    "idempotencyKey", "requestedAt"]) || ids.some((value) => !ID.test(value)) ||
    !timestamp(input.requestedAt) || !REVISION.test(dependencies.candidateProducerVersion) ||
    !REVISION.test(dependencies.mendpointRevision) || !DIGEST.test(dependencies.authorityDigest) ||
    !DIGEST.test(policy.failToPassCommandDigest) || !DIGEST.test(policy.passToPassCommandDigest) ||
    !Number.isSafeInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 1 ||
    !Number.isSafeInteger(dependencies.leaseMs) || dependencies.leaseMs < dependencies.timeoutMs * 2 ||
    dependencies.authorityId === dependencies.candidateProducerPrincipalId ||
    dependencies.authorityId === dependencies.executionAuthorityId ||
    typeof dependencies.verifier?.verify !== "function" || typeof dependencies.verifier.reconcile !== "function" ||
    typeof dependencies.verifyReceipt !== "function") {
    throw new Error("delegated_pr_verification_input_invalid");
  }
}

function snapshotDependencies(
  unsafe: DelegatedPrVerificationDependencies,
): DelegatedPrVerificationDependencies {
  const verifier = unsafe?.verifier;
  const verify = verifier?.verify;
  const reconcile = verifier?.reconcile;
  const receiptReceiver = unsafe;
  const verifyReceipt = unsafe?.verifyReceipt;
  if (!verifier || typeof verify !== "function" || typeof reconcile !== "function" ||
      typeof verifyReceipt !== "function") {
    throw new Error("delegated_pr_verification_dependencies_invalid");
  }
  return Object.freeze({
    enabled: unsafe.enabled,
    workerId: unsafe.workerId,
    timeoutMs: unsafe.timeoutMs,
    leaseMs: unsafe.leaseMs,
    candidateProducerPrincipalId: unsafe.candidateProducerPrincipalId,
    candidateProducerVersion: unsafe.candidateProducerVersion,
    authorityId: unsafe.authorityId,
    authorityDigest: unsafe.authorityDigest,
    executionAuthorityId: unsafe.executionAuthorityId,
    mendpointRevision: unsafe.mendpointRevision,
    policy: snapshotPlain(unsafe.policy, "delegated_pr_verification_dependencies_invalid"),
    verifier: Object.freeze({
      verify: (input: DelegatedPrVerifierRequest) => Reflect.apply(verify, verifier, [input]),
      reconcile: (input: DelegatedPrVerifierRequest) => Reflect.apply(reconcile, verifier, [input]),
    }),
    verifyReceipt: (receipt: DelegatedPrVerificationReceipt) =>
      Reflect.apply(verifyReceipt, receiptReceiver, [receipt]),
  });
}

function loadCandidate(
  db: AppDb,
  input: RunDelegatedPrVerificationInput,
  dependencies: DelegatedPrVerificationAuthority,
): Readonly<{ claims: CandidateClaims; artifact: Readonly<{ artifactId: string; sha256: string }> }> {
  const row = db.raw.prepare(
    `SELECT * FROM artifact_manifests WHERE tenant_id = ? AND id = ? AND kind = 'delegated_pr_candidate'
       AND schema_version = 1 AND media_type = 'application/vnd.mendpoint.delegated-pr-candidate+json'`,
  ).get(input.tenantId, input.candidateArtifactId) as
    | { id: string; sha256: string; size_bytes: number; content_text: string | null;
        producer_principal_id: string | null; created_at: string }
    | undefined;
  if (!row?.content_text || row.producer_principal_id !== dependencies.candidateProducerPrincipalId ||
      !SHA256.test(row.sha256) || sha256(row.content_text) !== row.sha256 ||
      Buffer.byteLength(row.content_text, "utf8") !== row.size_bytes) {
    throw new Error("delegated_pr_verification_candidate_invalid");
  }
  let claims: CandidateClaims;
  try { claims = snapshotPlain(JSON.parse(row.content_text), "delegated_pr_verification_candidate_invalid") as CandidateClaims; }
  catch { throw new Error("delegated_pr_verification_candidate_invalid"); }
  const paths = Array.isArray(claims.changedPaths) ? [...claims.changedPaths] : [];
  if (!exactKeys(claims, ["schemaVersion", "kind", "tenantId", "runId", "jobId", "repositoryId",
    "snapshotId", "revision", "sourceManifestSha256", "sourceTreeDigest", "candidateTreeDigest",
    "candidateManifestSha256", "changedPaths", "createdAt"]) || canonical(claims) !== row.content_text ||
    claims.schemaVersion !== 1 || claims.kind !== "delegated_pr_candidate" ||
    claims.tenantId !== input.tenantId || claims.runId !== input.runId || !ID.test(claims.jobId) ||
    !ID.test(claims.repositoryId) || !ID.test(claims.snapshotId) || !REVISION.test(claims.revision) ||
    !SHA256.test(claims.sourceManifestSha256) || !DIGEST.test(claims.sourceTreeDigest) ||
    !DIGEST.test(claims.candidateTreeDigest) || !DIGEST.test(claims.candidateManifestSha256) ||
    !timestamp(claims.createdAt) || paths.length === 0 || paths.some((path) => !validPath(path)) ||
    new Set(paths).size !== paths.length || paths.some((path, index) =>
      index > 0 && compareCodeUnits(paths[index - 1]!, path) >= 0)) {
    throw new Error("delegated_pr_verification_candidate_invalid");
  }
  const evidence = db.raw.prepare(
    `SELECT * FROM evidence_records WHERE tenant_id = ? AND subject_type = 'delegated_pr_candidate'
       AND subject_id = ? ORDER BY created_at, id`,
  ).all(input.tenantId, input.runId) as Array<{
    id: string; artifact_id: string; input_artifact_id: string | null; producer_principal_id: string | null;
    tool: string; tool_version: string | null; commit_sha: string | null; verdict: string; created_at: string;
  }>;
  if (evidence.length !== 1 || evidence[0]!.artifact_id !== row.id || evidence[0]!.input_artifact_id !== null ||
      evidence[0]!.producer_principal_id !== dependencies.candidateProducerPrincipalId ||
      evidence[0]!.tool !== "mendpoint-candidate-authority" ||
      evidence[0]!.tool_version !== dependencies.candidateProducerVersion ||
      evidence[0]!.commit_sha !== dependencies.candidateProducerVersion || evidence[0]!.verdict !== "passed" ||
      !timestamp(evidence[0]!.created_at)) {
    throw new Error("delegated_pr_verification_candidate_evidence_invalid");
  }
  if (Date.parse(input.requestedAt) < Date.parse(evidence[0]!.created_at)) {
    throw new Error("delegated_pr_verification_candidate_state_invalid");
  }
  const events = db.raw.prepare(
    `SELECT actor_principal_id, correlation_id, payload_json FROM domain_events
       WHERE tenant_id = ? AND aggregate_type = 'fettler_delegated_candidate'
       AND aggregate_id = ? AND event_type = 'fettler_delegated_candidate.promoted'`,
  ).all(input.tenantId, input.runId) as Array<{
    actor_principal_id: string; correlation_id: string; payload_json: string;
  }>;
  if (events.length !== 1 || events[0]!.actor_principal_id !== dependencies.candidateProducerPrincipalId ||
      events[0]!.correlation_id !== input.correlationId || !verifyDomainEventIntegrity(db, input.tenantId).ok) {
    throw new Error("delegated_pr_verification_candidate_event_invalid");
  }
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(events[0]!.payload_json) as Record<string, unknown>; }
  catch { throw new Error("delegated_pr_verification_candidate_event_invalid"); }
  if (!exactKeys(payload, ["requestDigest", "tenantId", "runId", "correlationId", "artifactId",
      "evidenceId", "observedAt"]) || payload.artifactId !== row.id || payload.runId !== input.runId ||
      payload.tenantId !== input.tenantId || payload.correlationId !== input.correlationId ||
      payload.evidenceId !== evidence[0]!.id || !timestamp(payload.observedAt) ||
      payload.observedAt !== evidence[0]!.created_at) {
    throw new Error("delegated_pr_verification_candidate_event_invalid");
  }
  const run = getAgentRun(db, input.runId, input.tenantId);
  if (!run || run.ok !== 1 || run.job_id !== claims.jobId) {
    throw new Error("delegated_pr_verification_candidate_state_invalid");
  }
  let result: Record<string, unknown>;
  let changedPaths: unknown;
  try {
    result = JSON.parse(run.result_json ?? "") as Record<string, unknown>;
    changedPaths = JSON.parse(run.files_changed_json ?? "");
  } catch {
    throw new Error("delegated_pr_verification_candidate_state_invalid");
  }
  const source = result?.source && typeof result.source === "object" && !Array.isArray(result.source)
    ? result.source as Record<string, unknown> : null;
  const artifacts = result?.artifacts && typeof result.artifacts === "object" && !Array.isArray(result.artifacts)
    ? result.artifacts as Record<string, unknown> : null;
  const snapshot = db.raw.prepare(
    `SELECT repository_id, resolved_sha, manifest_sha256 FROM repository_snapshots
       WHERE tenant_id = ? AND id = ?`,
  ).get(input.tenantId, claims.snapshotId) as
    | { repository_id: string; resolved_sha: string; manifest_sha256: string }
    | undefined;
  if (!snapshot || snapshot.repository_id !== claims.repositoryId || snapshot.resolved_sha !== claims.revision ||
      snapshot.manifest_sha256 !== claims.sourceManifestSha256 || source?.repositoryId !== claims.repositoryId ||
      source.snapshotId !== claims.snapshotId || source.revision !== claims.revision ||
      source.manifestSha256 !== claims.sourceManifestSha256 || artifacts?.sourceDigest !== claims.sourceTreeDigest ||
      artifacts.candidateDigest !== claims.candidateTreeDigest ||
      artifacts.candidateManifestSha256 !== claims.candidateManifestSha256 ||
      canonical(changedPaths) !== canonical(claims.changedPaths)) {
    throw new Error("delegated_pr_verification_candidate_state_invalid");
  }
  return deepFreeze({ claims, artifact: { artifactId: row.id, sha256: row.sha256 } });
}

function assertDispatchState(
  db: AppDb,
  input: RunDelegatedPrVerificationInput,
  candidate: Readonly<{ claims: CandidateClaims }>,
): void {
  const run = getAgentRun(db, input.runId, input.tenantId);
  if (!run || run.status !== "candidate_ready" || run.ok !== 1 ||
      run.job_id !== candidate.claims.jobId || run.finished_at !== candidate.claims.createdAt) {
    throw new Error("delegated_pr_verification_candidate_state_invalid");
  }
}

export function delegatedPrVerificationResultDigest(result: DelegatedPrVerificationResolution): string {
  return `sha256:${sha256(canonical(result))}`;
}

function requestDigest(
  input: RunDelegatedPrVerificationInput,
  candidate: Readonly<{ claims: CandidateClaims; artifact: Readonly<{ artifactId: string; sha256: string }> }>,
  dependencies: DelegatedPrVerificationAuthority,
): string {
  return `sha256:${sha256(canonical({
    schemaVersion: 1,
    tenantId: input.tenantId,
    runId: input.runId,
    correlationId: input.correlationId,
    candidateArtifact: candidate.artifact,
    candidateTreeDigest: candidate.claims.candidateTreeDigest,
    idempotencyKey: input.idempotencyKey,
    authorityId: dependencies.authorityId,
    authorityDigest: dependencies.authorityDigest,
    executionAuthorityId: dependencies.executionAuthorityId,
    mendpointRevision: dependencies.mendpointRevision,
    policy: dependencies.policy,
  }))}`;
}

function sqliteNow(db: AppDb): number {
  return (db.raw.prepare(
    "SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now_ms",
  ).get() as { now_ms: number }).now_ms;
}

function claimEffect(
  db: AppDb,
  input: RunDelegatedPrVerificationInput,
  digest: string,
  ownerId: string,
  leaseMs: number,
): Readonly<{ owned: boolean; dispatch: boolean; generation: number }> {
  db.raw.exec(EFFECT_TABLE);
  if (db.raw.isTransaction) throw new Error("delegated_pr_verification_ambient_transaction");
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const now = sqliteNow(db);
    const row = db.raw.prepare(
      `SELECT candidate_artifact_id, request_digest, owner_id, lease_generation,
       lease_expires_at_ms, phase FROM delegated_pr_verification_effects
       WHERE tenant_id = ? AND run_id = ?`,
    ).get(input.tenantId, input.runId) as
      | { candidate_artifact_id: string; request_digest: string; owner_id: string;
          lease_generation: number; lease_expires_at_ms: number; phase: string }
      | undefined;
    if (!row) {
      db.raw.prepare(
        `INSERT INTO delegated_pr_verification_effects
         (tenant_id, run_id, candidate_artifact_id, request_digest, owner_id, lease_generation,
          lease_expires_at_ms, phase) VALUES (?, ?, ?, ?, ?, 1, ?, 'dispatched')`,
      ).run(input.tenantId, input.runId, input.candidateArtifactId, digest, ownerId, now + leaseMs);
      db.raw.exec("COMMIT");
      return { owned: true, dispatch: true, generation: 1 };
    }
    if (row.candidate_artifact_id !== input.candidateArtifactId || row.request_digest !== digest) {
      throw new Error("delegated_pr_verification_idempotency_conflict");
    }
    if (row.phase === "settled") {
      db.raw.exec("COMMIT");
      return { owned: false, dispatch: false, generation: row.lease_generation };
    }
    if (row.owner_id === ownerId && row.lease_expires_at_ms > now) {
      db.raw.exec("COMMIT");
      return { owned: true, dispatch: false, generation: row.lease_generation };
    }
    if (row.lease_expires_at_ms > now) {
      db.raw.exec("COMMIT");
      return { owned: false, dispatch: false, generation: row.lease_generation };
    }
    const generation = row.lease_generation + 1;
    const changed = db.raw.prepare(
      `UPDATE delegated_pr_verification_effects SET owner_id = ?, lease_generation = ?,
       lease_expires_at_ms = ? WHERE tenant_id = ? AND run_id = ? AND request_digest = ?
       AND phase = 'dispatched' AND lease_generation = ? AND lease_expires_at_ms <= ?`,
    ).run(ownerId, generation, now + leaseMs, input.tenantId, input.runId, digest,
      row.lease_generation, now).changes;
    if (changed !== 1) throw new Error("delegated_pr_verification_checkpoint_conflict");
    db.raw.exec("COMMIT");
    return { owned: true, dispatch: false, generation };
  } catch (error) {
    if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

async function bounded<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("delegated_pr_verification_timeout"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function verifierRequest(
  input: RunDelegatedPrVerificationInput,
  candidate: Readonly<{ claims: CandidateClaims; artifact: Readonly<{ artifactId: string; sha256: string }> }>,
  digest: string,
  generation: number,
  dependencies: DelegatedPrVerificationDependencies,
  signal: AbortSignal,
): DelegatedPrVerifierRequest {
  const claims = candidate.claims;
  return Object.freeze({
    tenantId: input.tenantId,
    runId: input.runId,
    correlationId: input.correlationId,
    candidateArtifact: candidate.artifact,
    candidate: Object.freeze({
      repositoryId: claims.repositoryId,
      snapshotId: claims.snapshotId,
      revision: claims.revision,
      sourceManifestSha256: claims.sourceManifestSha256,
      sourceTreeDigest: claims.sourceTreeDigest,
      candidateTreeDigest: claims.candidateTreeDigest,
      candidateManifestSha256: claims.candidateManifestSha256,
      changedPaths: Object.freeze([...claims.changedPaths]),
    }),
    requestDigest: digest,
    leaseGeneration: generation,
    authorityId: dependencies.authorityId,
    authorityDigest: dependencies.authorityDigest,
    executionAuthorityId: dependencies.executionAuthorityId,
    policy: dependencies.policy,
    signal,
  });
}

function validateExecution(
  execution: DelegatedPrVerificationExecution,
  role: "fail_to_pass" | "pass_to_pass",
  candidate: CandidateClaims,
  dependencies: DelegatedPrVerificationAuthority,
): void {
  const expectedCommand = role === "fail_to_pass"
    ? dependencies.policy.failToPassCommandDigest : dependencies.policy.passToPassCommandDigest;
  const validCommon = exactKeys(execution, ["authorityId", "authorityDigest", "commandDigest",
    "sourceDigest", "candidateDigest", "baselineExitCode", "candidateExitCode", "baselineVerdict",
    "failingCheckIdentities", "sandboxBackend", "logsDigest"]) &&
    execution.authorityId === dependencies.authorityId &&
    execution.authorityDigest === dependencies.authorityDigest && execution.commandDigest === expectedCommand &&
    execution.sourceDigest === candidate.sourceTreeDigest && execution.candidateDigest === candidate.candidateTreeDigest &&
    execution.sandboxBackend === dependencies.policy.sandboxBackend && DIGEST.test(execution.logsDigest) &&
    Number.isSafeInteger(execution.baselineExitCode) && Number.isSafeInteger(execution.candidateExitCode) &&
    !INFRA_EXIT_CODES.has(execution.baselineExitCode) && !INFRA_EXIT_CODES.has(execution.candidateExitCode) &&
    // Reject any execution that claims to have observed which checks were failing: this verifier
    // does not parse runner output, so the field must carry the not_observed sentinel, never a list.
    isNotObserved(execution.failingCheckIdentities);
  const validRole = role === "fail_to_pass"
    ? execution.baselineVerdict === "test_failure" && execution.baselineExitCode > 0 &&
      execution.candidateExitCode === 0
    : execution.baselineVerdict === "passed" && execution.baselineExitCode === 0 &&
      execution.candidateExitCode === 0;
  if (!validCommon || !validRole) throw new Error("delegated_pr_verification_result_invalid");
}

function validateExchange(
  unsafe: DelegatedPrVerificationExchange,
  input: RunDelegatedPrVerificationInput,
  candidate: Readonly<{ claims: CandidateClaims; artifact: Readonly<{ artifactId: string; sha256: string }> }>,
  digest: string,
  generation: number,
  dependencies: DelegatedPrVerificationDependencies,
): DelegatedPrVerificationExchange {
  const exchange = snapshotPlain(unsafe, "delegated_pr_verification_receipt_invalid");
  const receipt = exchange.receipt;
  const result = exchange.result;
  if (!receipt || !result || receipt.tenantId !== input.tenantId || receipt.runId !== input.runId ||
      receipt.candidateArtifactId !== candidate.artifact.artifactId || receipt.requestDigest !== digest ||
      receipt.leaseGeneration !== generation || receipt.authorityId !== dependencies.authorityId ||
      receipt.outcome !== result.status || receipt.resultDigest !== delegatedPrVerificationResultDigest(result) ||
      !timestamp(receipt.observedAt) || typeof receipt.signature !== "string" || !receipt.signature.trim() ||
      !dependencies.verifyReceipt(receipt)) {
    throw new Error("delegated_pr_verification_receipt_invalid");
  }
  if (result.status === "completed") {
    if (!exactKeys(result, ["status", "executionAuthorityId", "failToPass", "passToPass", "completedAt"]) ||
        result.executionAuthorityId !== dependencies.executionAuthorityId || !timestamp(result.completedAt) ||
        result.completedAt !== receipt.observedAt || Date.parse(result.completedAt) < Date.parse(input.requestedAt)) {
      throw new Error("delegated_pr_verification_result_invalid");
    }
    validateExecution(result.failToPass, "fail_to_pass", candidate.claims, dependencies);
    validateExecution(result.passToPass, "pass_to_pass", candidate.claims, dependencies);
  } else if (result.status === "failed") {
    if (!exactKeys(result, ["status", "code", "completedAt"]) || typeof result.code !== "string" ||
        !result.code.trim() || result.code.length > 256 || !timestamp(result.completedAt) ||
        result.completedAt !== receipt.observedAt || Date.parse(result.completedAt) < Date.parse(input.requestedAt)) {
      throw new Error("delegated_pr_verification_result_invalid");
    }
  } else if (!exactKeys(result, ["status"])) {
    throw new Error("delegated_pr_verification_result_invalid");
  }
  return exchange;
}

function assertLease(
  db: AppDb,
  input: RunDelegatedPrVerificationInput,
  digest: string,
  ownerId: string,
  generation: number,
): void {
  const row = db.raw.prepare(
    `SELECT 1 FROM delegated_pr_verification_effects WHERE tenant_id = ? AND run_id = ?
       AND candidate_artifact_id = ? AND request_digest = ? AND owner_id = ? AND lease_generation = ?
       AND phase = 'dispatched' AND lease_expires_at_ms > ?`,
  ).get(input.tenantId, input.runId, input.candidateArtifactId, digest, ownerId, generation, sqliteNow(db));
  if (!row) throw new Error("delegated_pr_verification_lease_lost");
}

function executionArtifact(
  input: RunDelegatedPrVerificationInput,
  candidate: Readonly<{ claims: CandidateClaims; artifact: Readonly<{ artifactId: string; sha256: string }> }>,
  role: "fail_to_pass" | "pass_to_pass",
  execution: DelegatedPrVerificationExecution,
  executionAuthorityId: string,
) {
  const content = canonical({
    schemaVersion: 1,
    kind: "delegated_pr_verification_execution",
    role,
    tenantId: input.tenantId,
    runId: input.runId,
    candidateArtifact: candidate.artifact,
    executionAuthorityId,
    execution,
  });
  const digest = sha256(content);
  return Object.freeze({
    role,
    content,
    sha256: digest,
    artifactId: `delegated_verification_${digest.slice(0, 40)}`,
    evidenceId: `evidence_delegated_verification_${digest.slice(0, 40)}`,
    execution,
  });
}

function settleCompleted(
  db: AppDb,
  input: RunDelegatedPrVerificationInput,
  candidate: Readonly<{ claims: CandidateClaims; artifact: Readonly<{ artifactId: string; sha256: string }> }>,
  digest: string,
  ownerId: string,
  generation: number,
  receipt: DelegatedPrVerificationReceipt,
  result: Extract<DelegatedPrVerificationResolution, { status: "completed" }>,
  dependencies: DelegatedPrVerificationDependencies,
): void {
  const executions = [
    executionArtifact(input, candidate, "fail_to_pass", result.failToPass, result.executionAuthorityId),
    executionArtifact(input, candidate, "pass_to_pass", result.passToPass, result.executionAuthorityId),
  ] as const;
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    assertLease(db, input, digest, ownerId, generation);
    for (const execution of executions) {
      insertArtifactManifest(db, {
        id: execution.artifactId,
        tenantId: input.tenantId,
        kind: "delegated_pr_verification_execution",
        schemaVersion: 1,
        sha256: execution.sha256,
        mediaType: MEDIA_TYPE,
        sizeBytes: Buffer.byteLength(execution.content, "utf8"),
        storageRef: `sqlite://artifact_manifests/${execution.artifactId}#content_text`,
        content: execution.content,
        producerPrincipalId: dependencies.authorityId,
        createdAt: result.completedAt,
      });
      insertEvidenceRecord(db, {
        id: execution.evidenceId,
        tenantId: input.tenantId,
        subjectType: "delegated_pr_verification",
        subjectId: `${input.runId}:${execution.role}`,
        artifactId: execution.artifactId,
        inputArtifactId: candidate.artifact.artifactId,
        producerPrincipalId: dependencies.authorityId,
        tool: "mendpoint-independent-verifier",
        toolVersion: dependencies.authorityDigest,
        commitSha: dependencies.mendpointRevision,
        verdict: "passed",
        createdAt: result.completedAt,
      });
    }
    appendDomainEvent(db, {
      id: `event_${sha256(`${input.tenantId}\0${input.runId}\0${digest}\0completed`)}`,
      tenantId: input.tenantId,
      schemaVersion: 1,
      eventType: "fettler_delegated_verification.completed",
      aggregateType: "fettler_delegated_verification",
      aggregateId: input.runId,
      actorPrincipalId: dependencies.authorityId,
      correlationId: input.correlationId,
      idempotencyKey: `delegated-pr-verification:${input.idempotencyKey}:completed`,
      payload: {
        requestDigest: digest,
        candidateArtifact: candidate.artifact,
        candidateDigest: candidate.claims.candidateTreeDigest,
        executionAuthorityId: result.executionAuthorityId,
        failToPassArtifactId: executions[0].artifactId,
        failToPassEvidenceId: executions[0].evidenceId,
        passToPassArtifactId: executions[1].artifactId,
        passToPassEvidenceId: executions[1].evidenceId,
        completedAt: result.completedAt,
      },
      createdAt: result.completedAt,
    });
    const changed = db.raw.prepare(
      `UPDATE delegated_pr_verification_effects SET phase = 'settled', receipt_json = ?
       WHERE tenant_id = ? AND run_id = ? AND request_digest = ? AND owner_id = ?
       AND lease_generation = ? AND phase = 'dispatched'`,
    ).run(canonical(receipt), input.tenantId, input.runId, digest, ownerId, generation).changes;
    if (changed !== 1) throw new Error("delegated_pr_verification_checkpoint_conflict");
    db.raw.exec("COMMIT");
  } catch (error) {
    if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function settleFailed(
  db: AppDb,
  input: RunDelegatedPrVerificationInput,
  candidate: Readonly<{ claims: CandidateClaims; artifact: Readonly<{ artifactId: string; sha256: string }> }>,
  digest: string,
  ownerId: string,
  generation: number,
  receipt: DelegatedPrVerificationReceipt,
  result: Extract<DelegatedPrVerificationResolution, { status: "failed" }>,
  dependencies: DelegatedPrVerificationDependencies,
): void {
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    assertLease(db, input, digest, ownerId, generation);
    appendDomainEvent(db, {
      id: `event_${sha256(`${input.tenantId}\0${input.runId}\0${digest}\0failed`)}`,
      tenantId: input.tenantId,
      schemaVersion: 1,
      eventType: "fettler_delegated_verification.failed",
      aggregateType: "fettler_delegated_verification",
      aggregateId: input.runId,
      actorPrincipalId: dependencies.authorityId,
      correlationId: input.correlationId,
      idempotencyKey: `delegated-pr-verification:${input.idempotencyKey}:failed`,
      payload: { requestDigest: digest, candidateArtifact: candidate.artifact,
        candidateDigest: candidate.claims.candidateTreeDigest, code: result.code, completedAt: result.completedAt },
      createdAt: result.completedAt,
    });
    const changed = db.raw.prepare(
      `UPDATE delegated_pr_verification_effects SET phase = 'settled', receipt_json = ?
       WHERE tenant_id = ? AND run_id = ? AND request_digest = ? AND owner_id = ?
       AND lease_generation = ? AND phase = 'dispatched'`,
    ).run(canonical(receipt), input.tenantId, input.runId, digest, ownerId, generation).changes;
    if (changed !== 1) throw new Error("delegated_pr_verification_checkpoint_conflict");
    db.raw.exec("COMMIT");
  } catch (error) {
    if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function readTerminal(
  db: AppDb,
  input: RunDelegatedPrVerificationInput,
  candidate: Readonly<{ claims: CandidateClaims; artifact: Readonly<{ artifactId: string; sha256: string }> }>,
  digest: string,
  dependencies: DelegatedPrVerificationAuthority,
): DelegatedPrVerificationResult | undefined {
  const events = db.raw.prepare(
    `SELECT event_type, actor_principal_id, correlation_id, payload_json FROM domain_events
       WHERE tenant_id = ? AND aggregate_type = 'fettler_delegated_verification' AND aggregate_id = ?
       AND event_type IN ('fettler_delegated_verification.completed','fettler_delegated_verification.failed')`,
  ).all(input.tenantId, input.runId) as Array<{
    event_type: string; actor_principal_id: string; correlation_id: string; payload_json: string;
  }>;
  if (events.length === 0) return undefined;
  if (events.length !== 1 || !verifyDomainEventIntegrity(db, input.tenantId).ok) {
    throw new Error("delegated_pr_verification_event_corrupt");
  }
  const event = events[0]!;
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(event.payload_json) as Record<string, unknown>; }
  catch { throw new Error("delegated_pr_verification_event_corrupt"); }
  if (event.actor_principal_id !== dependencies.authorityId || event.correlation_id !== input.correlationId ||
      payload.requestDigest !== digest || canonical(payload.candidateArtifact) !== canonical(candidate.artifact) ||
      payload.candidateDigest !== candidate.claims.candidateTreeDigest || !timestamp(payload.completedAt)) {
    throw new Error("delegated_pr_verification_idempotency_conflict");
  }
  if (event.event_type.endsWith(".failed")) {
    if (!exactKeys(payload, ["requestDigest", "candidateArtifact", "candidateDigest", "code", "completedAt"]) ||
        typeof payload.code !== "string") throw new Error("delegated_pr_verification_event_corrupt");
    return deepFreeze({ status: "failed", tenantId: input.tenantId, runId: input.runId,
      candidateArtifact: candidate.artifact, candidateDigest: candidate.claims.candidateTreeDigest,
      code: payload.code, completedAt: payload.completedAt });
  }
  if (!exactKeys(payload, ["requestDigest", "candidateArtifact", "candidateDigest", "executionAuthorityId",
      "failToPassArtifactId", "failToPassEvidenceId", "passToPassArtifactId", "passToPassEvidenceId",
      "completedAt"]) || payload.executionAuthorityId !== dependencies.executionAuthorityId) {
    throw new Error("delegated_pr_verification_event_corrupt");
  }
  const readExecution = (role: "fail_to_pass" | "pass_to_pass"): ExecutionWithArtifact => {
    const artifactId = String(payload[role === "fail_to_pass" ? "failToPassArtifactId" : "passToPassArtifactId"]);
    const evidenceId = String(payload[role === "fail_to_pass" ? "failToPassEvidenceId" : "passToPassEvidenceId"]);
    const row = db.raw.prepare(
      `SELECT * FROM artifact_manifests WHERE tenant_id = ? AND id = ?
       AND kind = 'delegated_pr_verification_execution' AND schema_version = 1 AND media_type = ?`,
    ).get(input.tenantId, artifactId, MEDIA_TYPE) as
      | { sha256: string; size_bytes: number; content_text: string | null; producer_principal_id: string | null }
      | undefined;
    if (!row?.content_text || row.producer_principal_id !== dependencies.authorityId || !SHA256.test(row.sha256) ||
        sha256(row.content_text) !== row.sha256 || Buffer.byteLength(row.content_text, "utf8") !== row.size_bytes) {
      throw new Error("delegated_pr_verification_artifact_corrupt");
    }
    let content: Record<string, unknown>;
    try { content = JSON.parse(row.content_text) as Record<string, unknown>; }
    catch { throw new Error("delegated_pr_verification_artifact_corrupt"); }
    const execution = content.execution as DelegatedPrVerificationExecution;
    if (canonical(content) !== row.content_text || content.schemaVersion !== 1 ||
        content.kind !== "delegated_pr_verification_execution" || content.role !== role ||
        content.tenantId !== input.tenantId || content.runId !== input.runId ||
        content.executionAuthorityId !== dependencies.executionAuthorityId ||
        canonical(content.candidateArtifact) !== canonical(candidate.artifact)) {
      throw new Error("delegated_pr_verification_artifact_corrupt");
    }
    validateExecution(execution, role, candidate.claims, dependencies);
    const evidence = db.raw.prepare(
      `SELECT * FROM evidence_records WHERE tenant_id = ? AND id = ? AND subject_type = 'delegated_pr_verification'
       AND subject_id = ?`,
    ).get(input.tenantId, evidenceId, `${input.runId}:${role}`) as
      | { artifact_id: string; input_artifact_id: string | null; producer_principal_id: string | null;
          tool: string; tool_version: string | null; commit_sha: string | null; verdict: string }
      | undefined;
    if (!evidence || evidence.artifact_id !== artifactId || evidence.input_artifact_id !== candidate.artifact.artifactId ||
        evidence.producer_principal_id !== dependencies.authorityId ||
        evidence.tool !== "mendpoint-independent-verifier" || evidence.tool_version !== dependencies.authorityDigest ||
        evidence.commit_sha !== dependencies.mendpointRevision || evidence.verdict !== "passed") {
      throw new Error("delegated_pr_verification_evidence_corrupt");
    }
    return deepFreeze({ ...execution, artifact: { artifactId, sha256: row.sha256 }, evidenceId });
  };
  return deepFreeze({
    status: "completed",
    tenantId: input.tenantId,
    runId: input.runId,
    candidateArtifact: candidate.artifact,
    candidateDigest: candidate.claims.candidateTreeDigest,
    failToPass: readExecution("fail_to_pass"),
    passToPass: readExecution("pass_to_pass"),
    completedAt: payload.completedAt,
  });
}

export type ReadDelegatedPrVerificationTerminalInput = Readonly<{
  tenantId: string;
  runId: string;
  correlationId: string;
  candidateArtifactId: string;
  idempotencyKey: string;
  completedAt: string;
}>;

export type DeriveDelegatedPrVerificationAuthorityInput = Readonly<{
  tenantId: string;
  runId: string;
  candidateArtifactId: string;
  failToPassArtifactId: string;
  passToPassArtifactId: string;
}>;

export function deriveDelegatedPrVerificationAuthority(
  db: AppDb,
  unsafeInput: DeriveDelegatedPrVerificationAuthorityInput,
): DelegatedPrVerificationAuthority {
  const input = snapshotPlain(unsafeInput, "delegated_pr_verification_authority_invalid");
  if (!exactKeys(input, ["tenantId", "runId", "candidateArtifactId", "failToPassArtifactId",
    "passToPassArtifactId"]) || [input.tenantId, input.runId, input.candidateArtifactId,
      input.failToPassArtifactId, input.passToPassArtifactId].some((value) => !ID.test(value)) ||
      input.failToPassArtifactId === input.passToPassArtifactId) {
    throw new Error("delegated_pr_verification_authority_invalid");
  }
  const candidate = db.raw.prepare(
    `SELECT producer_principal_id FROM artifact_manifests WHERE tenant_id = ? AND id = ?
       AND kind = 'delegated_pr_candidate' AND schema_version = 1`,
  ).get(input.tenantId, input.candidateArtifactId) as { producer_principal_id: string | null } | undefined;
  const candidateEvidence = db.raw.prepare(
    `SELECT producer_principal_id, tool, tool_version, commit_sha, verdict FROM evidence_records
       WHERE tenant_id = ? AND subject_type = 'delegated_pr_candidate' AND subject_id = ?
       AND artifact_id = ? ORDER BY created_at, id`,
  ).all(input.tenantId, input.runId, input.candidateArtifactId) as Array<{
    producer_principal_id: string | null; tool: string; tool_version: string | null;
    commit_sha: string | null; verdict: string;
  }>;
  const candidateRecord = candidateEvidence[0];
  if (!candidate?.producer_principal_id || candidateEvidence.length !== 1 || !candidateRecord ||
      candidateRecord.producer_principal_id !== candidate.producer_principal_id ||
      candidateRecord.tool !== "mendpoint-candidate-authority" || candidateRecord.verdict !== "passed" ||
      !candidateRecord.tool_version || candidateRecord.tool_version !== candidateRecord.commit_sha ||
      !REVISION.test(candidateRecord.tool_version)) {
    throw new Error("delegated_pr_verification_authority_invalid");
  }
  const execution = (artifactId: string, role: "fail_to_pass" | "pass_to_pass") => {
    const row = db.raw.prepare(
      `SELECT sha256, size_bytes, content_text, producer_principal_id FROM artifact_manifests
         WHERE tenant_id = ? AND id = ? AND kind = 'delegated_pr_verification_execution'
         AND schema_version = 1 AND media_type = ?`,
    ).get(input.tenantId, artifactId, MEDIA_TYPE) as
      | { sha256: string; size_bytes: number; content_text: string | null; producer_principal_id: string | null }
      | undefined;
    if (!row?.content_text || !row.producer_principal_id || !SHA256.test(row.sha256) ||
        sha256(row.content_text) !== row.sha256 || Buffer.byteLength(row.content_text, "utf8") !== row.size_bytes) {
      throw new Error("delegated_pr_verification_authority_invalid");
    }
    let content: Record<string, unknown>;
    try { content = JSON.parse(row.content_text) as Record<string, unknown>; }
    catch { throw new Error("delegated_pr_verification_authority_invalid"); }
    const observed = content.execution as DelegatedPrVerificationExecution;
    if (canonical(content) !== row.content_text || content.schemaVersion !== 1 ||
        content.kind !== "delegated_pr_verification_execution" || content.role !== role ||
        content.tenantId !== input.tenantId || content.runId !== input.runId || !observed ||
        observed.authorityId !== row.producer_principal_id || !ID.test(String(content.executionAuthorityId ?? "")) ||
        !DIGEST.test(observed.authorityDigest) || !DIGEST.test(observed.commandDigest) ||
        !ID.test(observed.sandboxBackend)) {
      throw new Error("delegated_pr_verification_authority_invalid");
    }
    const evidence = db.raw.prepare(
      `SELECT producer_principal_id, tool, tool_version, commit_sha, verdict FROM evidence_records
         WHERE tenant_id = ? AND subject_type = 'delegated_pr_verification' AND subject_id = ?
         AND artifact_id = ? AND input_artifact_id = ? ORDER BY created_at, id`,
    ).all(input.tenantId, `${input.runId}:${role}`, artifactId, input.candidateArtifactId) as Array<{
      producer_principal_id: string | null; tool: string; tool_version: string | null;
      commit_sha: string | null; verdict: string;
    }>;
    const record = evidence[0];
    if (evidence.length !== 1 || !record || record.producer_principal_id !== row.producer_principal_id ||
        record.tool !== "mendpoint-independent-verifier" || record.tool_version !== observed.authorityDigest ||
        !record.commit_sha || !REVISION.test(record.commit_sha) || record.verdict !== "passed") {
      throw new Error("delegated_pr_verification_authority_invalid");
    }
    return Object.freeze({
      authorityId: observed.authorityId,
      authorityDigest: observed.authorityDigest,
      commandDigest: observed.commandDigest,
      executionAuthorityId: String(content.executionAuthorityId),
      sandboxBackend: observed.sandboxBackend,
      mendpointRevision: record.commit_sha,
    });
  };
  const failToPass = execution(input.failToPassArtifactId, "fail_to_pass");
  const passToPass = execution(input.passToPassArtifactId, "pass_to_pass");
  if (failToPass.authorityId !== passToPass.authorityId ||
      failToPass.authorityDigest !== passToPass.authorityDigest ||
      failToPass.executionAuthorityId !== passToPass.executionAuthorityId ||
      failToPass.sandboxBackend !== passToPass.sandboxBackend ||
      failToPass.mendpointRevision !== passToPass.mendpointRevision) {
    throw new Error("delegated_pr_verification_authority_invalid");
  }
  return deepFreeze({
    candidateProducerPrincipalId: candidate.producer_principal_id,
    candidateProducerVersion: candidateRecord.tool_version,
    authorityId: failToPass.authorityId,
    authorityDigest: failToPass.authorityDigest,
    executionAuthorityId: failToPass.executionAuthorityId,
    mendpointRevision: failToPass.mendpointRevision,
    policy: {
      failToPassCommandDigest: failToPass.commandDigest,
      passToPassCommandDigest: passToPass.commandDigest,
      sandboxBackend: failToPass.sandboxBackend,
    },
  });
}

export function readDelegatedPrVerificationTerminal(
  db: AppDb,
  unsafeInput: ReadDelegatedPrVerificationTerminalInput,
  unsafeAuthority: DelegatedPrVerificationAuthority,
): DelegatedPrVerificationResult | undefined {
  const input = snapshotPlain(unsafeInput, "delegated_pr_verification_authority_invalid");
  const authority = snapshotPlain(unsafeAuthority, "delegated_pr_verification_authority_invalid");
  if (!exactKeys(input, ["tenantId", "runId", "correlationId", "candidateArtifactId",
    "idempotencyKey", "completedAt"]) ||
      !exactKeys(authority, ["candidateProducerPrincipalId", "candidateProducerVersion", "authorityId",
        "authorityDigest", "executionAuthorityId", "mendpointRevision", "policy"]) ||
      !exactKeys(authority.policy, ["failToPassCommandDigest", "passToPassCommandDigest", "sandboxBackend"]) ||
      [input.tenantId, input.runId, input.correlationId, input.candidateArtifactId, input.idempotencyKey,
        authority.candidateProducerPrincipalId, authority.authorityId, authority.executionAuthorityId,
        authority.policy.sandboxBackend].some((value) => !ID.test(value)) ||
      !timestamp(input.completedAt) || !REVISION.test(authority.candidateProducerVersion) ||
      !REVISION.test(authority.mendpointRevision) || !DIGEST.test(authority.authorityDigest) ||
      !DIGEST.test(authority.policy.failToPassCommandDigest) ||
      !DIGEST.test(authority.policy.passToPassCommandDigest) ||
      authority.authorityId === authority.candidateProducerPrincipalId ||
      authority.authorityId === authority.executionAuthorityId) {
    throw new Error("delegated_pr_verification_authority_invalid");
  }
  const runInput: RunDelegatedPrVerificationInput = Object.freeze({
    tenantId: input.tenantId,
    runId: input.runId,
    correlationId: input.correlationId,
    candidateArtifactId: input.candidateArtifactId,
    idempotencyKey: input.idempotencyKey,
    requestedAt: input.completedAt,
  });
  const principal = db.raw.prepare(
    `SELECT id FROM principals WHERE tenant_id = ? AND id = ? AND kind = 'service'
       AND created_at <= ? AND (expires_at IS NULL OR expires_at > ?)
       AND (revoked_at IS NULL OR revoked_at > ?)`,
  ).get(input.tenantId, authority.authorityId, input.completedAt, input.completedAt, input.completedAt);
  if (!principal) throw new Error("delegated_pr_verification_authority_invalid");
  const candidate = loadCandidate(db, runInput, authority);
  const digest = requestDigest(runInput, candidate, authority);
  return readTerminal(db, runInput, candidate, digest, authority);
}

export async function runDelegatedPrVerification(
  db: AppDb,
  unsafeInput: RunDelegatedPrVerificationInput,
  unsafeDependencies: DelegatedPrVerificationDependencies,
): Promise<DelegatedPrVerificationResult> {
  const input = snapshotPlain(unsafeInput, "delegated_pr_verification_input_invalid");
  const dependencies = snapshotDependencies(unsafeDependencies);
  if (dependencies.enabled !== true) throw new Error("delegated_pr_verification_disabled");
  validateInput(input, dependencies);
  const candidate = loadCandidate(db, input, dependencies);
  if (Date.parse(input.requestedAt) < Date.parse(candidate.claims.createdAt)) {
    throw new Error("delegated_pr_verification_candidate_state_invalid");
  }
  const verifierPrincipal = db.raw.prepare(
    `SELECT id FROM principals WHERE tenant_id = ? AND id = ? AND kind = 'service'
       AND created_at <= ? AND (expires_at IS NULL OR expires_at > ?)
       AND (revoked_at IS NULL OR revoked_at > ?)`,
  ).get(input.tenantId, dependencies.authorityId, input.requestedAt, input.requestedAt, input.requestedAt);
  if (!verifierPrincipal) throw new Error("delegated_pr_verification_authority_invalid");
  const digest = requestDigest(input, candidate, dependencies);
  const terminal = readTerminal(db, input, candidate, digest, dependencies);
  if (terminal) return terminal;
  assertDispatchState(db, input, candidate);
  const ownerId = `${dependencies.workerId}:${PROCESS_INSTANCE_ID}`;
  const activeKey = `${input.tenantId}\0${input.runId}\0${ownerId}`;
  if (ACTIVE.has(activeKey)) throw new Error("delegated_pr_verification_lease_held");
  ACTIVE.add(activeKey);
  try {
    const claim = claimEffect(db, input, digest, ownerId, dependencies.leaseMs);
    if (!claim.owned) {
      const settled = readTerminal(db, input, candidate, digest, dependencies);
      if (settled) return settled;
      throw new Error("delegated_pr_verification_lease_held");
    }
    const invoke = (kind: "verify" | "reconcile") => bounded(dependencies.timeoutMs, (signal) => {
      const request = verifierRequest(input, candidate, digest, claim.generation, dependencies, signal);
      return kind === "verify" ? dependencies.verifier.verify(request) : dependencies.verifier.reconcile(request);
    });
    let exchange = validateExchange(
      await invoke(claim.dispatch ? "verify" : "reconcile"),
      input, candidate, digest, claim.generation, dependencies,
    );
    if (exchange.result.status === "safe_to_run") {
      exchange = validateExchange(
        await invoke("verify"), input, candidate, digest, claim.generation, dependencies,
      );
    }
    if (exchange.result.status === "pending") throw new Error("delegated_pr_verification_outcome_unknown");
    if (exchange.result.status === "safe_to_run") throw new Error("delegated_pr_verification_result_invalid");
    if (exchange.result.status === "failed") {
      settleFailed(db, input, candidate, digest, ownerId, claim.generation,
        exchange.receipt, exchange.result, dependencies);
    } else {
      settleCompleted(db, input, candidate, digest, ownerId, claim.generation,
        exchange.receipt, exchange.result, dependencies);
    }
    const result = readTerminal(db, input, candidate, digest, dependencies);
    if (!result) throw new Error("delegated_pr_verification_persistence_failed");
    return result;
  } finally {
    ACTIVE.delete(activeKey);
  }
}
