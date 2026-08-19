import { createHash } from "node:crypto";
import {
  appendDomainEvent,
  getAgentRun,
  insertArtifactManifest,
  insertEvidenceRecord,
  verifyDomainEventIntegrity,
  type AppDb,
} from "@mendpoint/db";

export type ValidatedDelegatedPrCandidate = Readonly<{
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

export type DelegatedPrCandidateAuthority = Readonly<{
  loadExactCandidate(
    db: AppDb,
    input: Readonly<{ tenantId: string; runId: string }>,
  ): Promise<ValidatedDelegatedPrCandidate>;
}>;

export type PromoteDelegatedPrCandidateInput = Readonly<{
  tenantId: string;
  runId: string;
  correlationId: string;
  idempotencyKey: string;
  observedAt: string;
}>;

export type DelegatedPrCandidateOperationDependencies = Readonly<{
  enabled?: boolean;
  authority: DelegatedPrCandidateAuthority;
  producerPrincipalId: string;
  producerVersion: string;
}>;

export type PromotedDelegatedPrCandidate = ValidatedDelegatedPrCandidate & Readonly<{
  artifact: Readonly<{ artifactId: string; sha256: string }>;
  evidenceId: string;
}>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MEDIA_TYPE = "application/vnd.mendpoint.delegated-pr-candidate+json";
const EVENT_TYPE = "fettler_delegated_candidate.promoted";
const TOOL = "mendpoint-candidate-authority";

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

function validTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validPath(value: string): boolean {
  return value.length > 0 && value.length <= 1_024 && !value.includes("\0") &&
    !value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return canonical(Object.keys(value).sort(compareCodeUnits)) === canonical([...keys].sort(compareCodeUnits));
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
    if (nodes > 4_096 || depth > 16) throw new Error(code);
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error(code);
      return current;
    }
    if (Array.isArray(current)) {
      if (seen.has(current) || current.length > 1_000) throw new Error(code);
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

function validateInput(input: PromoteDelegatedPrCandidateInput): void {
  if (!exactKeys(input, ["tenantId", "runId", "correlationId", "idempotencyKey", "observedAt"]) ||
      ![input.tenantId, input.runId, input.correlationId, input.idempotencyKey].every((value) => ID.test(value)) ||
      !validTimestamp(input.observedAt)) {
    throw new Error("delegated_pr_candidate_input_invalid");
  }
}

function validateCandidate(candidate: ValidatedDelegatedPrCandidate): void {
  const ids = [candidate.tenantId, candidate.runId, candidate.jobId, candidate.repositoryId, candidate.snapshotId];
  const paths = Array.isArray(candidate.changedPaths) ? [...candidate.changedPaths] : [];
  if (!exactKeys(candidate, ["tenantId", "runId", "jobId", "repositoryId", "snapshotId", "revision",
    "sourceManifestSha256", "sourceTreeDigest", "candidateTreeDigest", "candidateManifestSha256",
    "changedPaths", "createdAt"]) || !ids.every((value) => typeof value === "string" && ID.test(value)) ||
      !REVISION.test(candidate.revision) || !SHA256.test(candidate.sourceManifestSha256) ||
      !DIGEST.test(candidate.sourceTreeDigest) || !DIGEST.test(candidate.candidateTreeDigest) ||
      !DIGEST.test(candidate.candidateManifestSha256) || !validTimestamp(candidate.createdAt) ||
      paths.length === 0 || paths.length > 1_000 || new Set(paths).size !== paths.length ||
      paths.some((path) => typeof path !== "string" || !validPath(path)) ||
      paths.some((path, index) => index > 0 && compareCodeUnits(paths[index - 1]!, path) >= 0)) {
    throw new Error("delegated_pr_candidate_authority_invalid");
  }
}

function snapshotDependencies(
  dependencies: DelegatedPrCandidateOperationDependencies,
): DelegatedPrCandidateOperationDependencies {
  const receiver = dependencies?.authority;
  const operation = receiver?.loadExactCandidate;
  if (!receiver || typeof operation !== "function" || !ID.test(dependencies.producerPrincipalId) ||
      !REVISION.test(dependencies.producerVersion)) {
    throw new Error("delegated_pr_candidate_dependencies_invalid");
  }
  return Object.freeze({
    enabled: dependencies.enabled,
    producerPrincipalId: dependencies.producerPrincipalId,
    producerVersion: dependencies.producerVersion,
    authority: Object.freeze({
      loadExactCandidate: (db: AppDb, input: Readonly<{ tenantId: string; runId: string }>) =>
        Reflect.apply(operation, receiver, [db, input]),
    }),
  });
}

function requestDigest(input: PromoteDelegatedPrCandidateInput): string {
  return sha256(canonical({
    schemaVersion: 1,
    tenantId: input.tenantId,
    runId: input.runId,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
  }));
}

function eventKey(input: PromoteDelegatedPrCandidateInput): string {
  return `delegated-pr-candidate:${input.idempotencyKey}`;
}

function assertDurableAuthority(
  db: AppDb,
  input: PromoteDelegatedPrCandidateInput,
  candidate: ValidatedDelegatedPrCandidate,
  producerPrincipalId: string,
): void {
  const run = getAgentRun(db, input.runId, input.tenantId);
  const principal = db.raw.prepare(
    `SELECT id FROM principals WHERE tenant_id = ? AND id = ? AND kind = 'service'
       AND created_at <= ? AND (expires_at IS NULL OR expires_at > ?)
       AND (revoked_at IS NULL OR revoked_at > ?)`,
  ).get(input.tenantId, producerPrincipalId, input.observedAt, input.observedAt, input.observedAt);
  if (!run || !principal || run.status !== "candidate_ready" || run.ok !== 1 ||
      run.job_id === null || run.finished_at === null) {
    throw new Error("delegated_pr_candidate_authority_not_found");
  }
  let result: Record<string, unknown>;
  let changedPaths: unknown;
  try {
    result = JSON.parse(run.result_json ?? "") as Record<string, unknown>;
    changedPaths = JSON.parse(run.files_changed_json ?? "");
  } catch {
    throw new Error("delegated_pr_candidate_authority_corrupt");
  }
  const source = result.source && typeof result.source === "object" && !Array.isArray(result.source)
    ? result.source as Record<string, unknown> : null;
  const artifacts = result.artifacts && typeof result.artifacts === "object" && !Array.isArray(result.artifacts)
    ? result.artifacts as Record<string, unknown> : null;
  const snapshot = db.raw.prepare(
    `SELECT tenant_id, repository_id, resolved_sha, manifest_sha256 FROM repository_snapshots
       WHERE tenant_id = ? AND id = ?`,
  ).get(input.tenantId, candidate.snapshotId) as
    | { tenant_id: string; repository_id: string; resolved_sha: string; manifest_sha256: string }
    | undefined;
  const matches = candidate.tenantId === input.tenantId && candidate.runId === input.runId &&
    candidate.jobId === run.job_id && candidate.createdAt === run.finished_at && snapshot !== undefined &&
    snapshot.repository_id === candidate.repositoryId && snapshot.resolved_sha === candidate.revision &&
    snapshot.manifest_sha256 === candidate.sourceManifestSha256 &&
    source?.repositoryId === candidate.repositoryId && source.snapshotId === candidate.snapshotId &&
    source.revision === candidate.revision && source.manifestSha256 === candidate.sourceManifestSha256 &&
    artifacts?.sourceDigest === candidate.sourceTreeDigest &&
    artifacts.candidateDigest === candidate.candidateTreeDigest &&
    artifacts.candidateManifestSha256 === candidate.candidateManifestSha256 &&
    canonical(changedPaths) === canonical(candidate.changedPaths);
  if (!matches) throw new Error("delegated_pr_candidate_authority_mismatch");
}

function candidateContent(candidate: ValidatedDelegatedPrCandidate): string {
  return canonical({ schemaVersion: 1, kind: "delegated_pr_candidate", ...candidate });
}

function readPromoted(
  db: AppDb,
  input: PromoteDelegatedPrCandidateInput,
  digest: string,
  producerPrincipalId: string,
  producerVersion: string,
): PromotedDelegatedPrCandidate | undefined {
  const event = db.raw.prepare(
    `SELECT aggregate_id, actor_principal_id, correlation_id, payload_json FROM domain_events
       WHERE tenant_id = ? AND idempotency_key = ? AND event_type = ?`,
  ).get(input.tenantId, eventKey(input), EVENT_TYPE) as
    | { aggregate_id: string; actor_principal_id: string; correlation_id: string; payload_json: string }
    | undefined;
  if (!event) return undefined;
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(event.payload_json) as Record<string, unknown>; }
  catch { throw new Error("delegated_pr_candidate_event_corrupt"); }
  if (payload.requestDigest !== digest || payload.runId !== input.runId ||
      payload.correlationId !== input.correlationId || event.correlation_id !== input.correlationId ||
      event.actor_principal_id !== producerPrincipalId || typeof payload.artifactId !== "string" ||
      typeof payload.evidenceId !== "string" || event.aggregate_id !== input.runId) {
    throw new Error("delegated_pr_candidate_idempotency_conflict");
  }
  if (!verifyDomainEventIntegrity(db, input.tenantId).ok) throw new Error("delegated_pr_candidate_event_corrupt");
  const artifact = db.raw.prepare(
    `SELECT sha256, size_bytes, content_text, producer_principal_id FROM artifact_manifests
       WHERE tenant_id = ? AND id = ? AND kind = 'delegated_pr_candidate'
       AND schema_version = 1 AND media_type = ?`,
  ).get(input.tenantId, payload.artifactId, MEDIA_TYPE) as
    | { sha256: string; size_bytes: number; content_text: string | null; producer_principal_id: string | null }
    | undefined;
  if (!artifact?.content_text || artifact.producer_principal_id !== producerPrincipalId ||
      !SHA256.test(artifact.sha256) || sha256(artifact.content_text) !== artifact.sha256 ||
      Buffer.byteLength(artifact.content_text, "utf8") !== artifact.size_bytes) {
    throw new Error("delegated_pr_candidate_artifact_corrupt");
  }
  const evidence = db.raw.prepare(
    `SELECT artifact_id, input_artifact_id, producer_principal_id, tool, tool_version, commit_sha, verdict, created_at
       FROM evidence_records WHERE tenant_id = ? AND id = ?
       AND subject_type = 'delegated_pr_candidate' AND subject_id = ?`,
  ).get(input.tenantId, payload.evidenceId, input.runId) as
    | { artifact_id: string; input_artifact_id: string | null; producer_principal_id: string | null;
        tool: string; tool_version: string | null; commit_sha: string | null; verdict: string; created_at: string }
    | undefined;
  if (!evidence || evidence.artifact_id !== payload.artifactId || evidence.input_artifact_id !== null ||
      evidence.producer_principal_id !== producerPrincipalId || evidence.tool !== TOOL ||
      evidence.tool_version !== producerVersion || evidence.commit_sha !== producerVersion ||
      evidence.verdict !== "passed" || evidence.created_at !== payload.observedAt ||
      !validTimestamp(String(payload.observedAt))) {
    throw new Error("delegated_pr_candidate_evidence_corrupt");
  }
  const principal = db.raw.prepare(
    `SELECT id FROM principals WHERE tenant_id = ? AND id = ? AND kind = 'service'
       AND created_at <= ? AND (expires_at IS NULL OR expires_at > ?)
       AND (revoked_at IS NULL OR revoked_at > ?)`,
  ).get(input.tenantId, producerPrincipalId, evidence.created_at, evidence.created_at, evidence.created_at);
  if (!principal) throw new Error("delegated_pr_candidate_evidence_corrupt");
  let content: ValidatedDelegatedPrCandidate & { schemaVersion: number; kind: string };
  try { content = JSON.parse(artifact.content_text) as typeof content; }
  catch { throw new Error("delegated_pr_candidate_artifact_corrupt"); }
  const { schemaVersion, kind, ...candidate } = content;
  validateCandidate(candidate);
  if (schemaVersion !== 1 || kind !== "delegated_pr_candidate" ||
      content.tenantId !== input.tenantId || content.runId !== input.runId ||
      candidateContent(content) !== artifact.content_text) {
    throw new Error("delegated_pr_candidate_artifact_mismatch");
  }
  return deepFreeze({
    tenantId: content.tenantId,
    runId: content.runId,
    jobId: content.jobId,
    repositoryId: content.repositoryId,
    snapshotId: content.snapshotId,
    revision: content.revision,
    sourceManifestSha256: content.sourceManifestSha256,
    sourceTreeDigest: content.sourceTreeDigest,
    candidateTreeDigest: content.candidateTreeDigest,
    candidateManifestSha256: content.candidateManifestSha256,
    changedPaths: Object.freeze([...content.changedPaths]),
    createdAt: content.createdAt,
    artifact: Object.freeze({ artifactId: String(payload.artifactId), sha256: artifact.sha256 }),
    evidenceId: String(payload.evidenceId),
  });
}

export async function promoteDelegatedPrCandidate(
  db: AppDb,
  unsafeInput: PromoteDelegatedPrCandidateInput,
  unsafeDependencies: DelegatedPrCandidateOperationDependencies,
): Promise<PromotedDelegatedPrCandidate> {
  const input = snapshotPlain(unsafeInput, "delegated_pr_candidate_input_invalid");
  const dependencies = snapshotDependencies(unsafeDependencies);
  validateInput(input);
  if (dependencies.enabled !== true) throw new Error("delegated_pr_candidate_disabled");
  const digest = requestDigest(input);
  const replay = readPromoted(
    db, input, digest, dependencies.producerPrincipalId, dependencies.producerVersion,
  );
  if (replay) return replay;

  if (db.raw.isTransaction) throw new Error("delegated_pr_candidate_ambient_transaction_not_supported");
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const lockedReplay = readPromoted(
      db, input, digest, dependencies.producerPrincipalId, dependencies.producerVersion,
    );
    if (lockedReplay) {
      db.raw.exec("COMMIT");
      return lockedReplay;
    }
    const candidate = snapshotPlain(
      await dependencies.authority.loadExactCandidate(db, Object.freeze({
        tenantId: input.tenantId,
        runId: input.runId,
      })),
      "delegated_pr_candidate_authority_invalid",
    );
    validateCandidate(candidate);
    assertDurableAuthority(db, input, candidate, dependencies.producerPrincipalId);
    const content = candidateContent(candidate);
    const artifactSha256 = sha256(content);
    const artifactId = `delegated_candidate_${artifactSha256.slice(0, 40)}`;
    const evidenceId = `evidence_delegated_candidate_${artifactSha256.slice(0, 40)}`;
    insertArtifactManifest(db, {
      id: artifactId,
      tenantId: input.tenantId,
      kind: "delegated_pr_candidate",
      schemaVersion: 1,
      sha256: artifactSha256,
      mediaType: MEDIA_TYPE,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      storageRef: `sqlite://artifact_manifests/${artifactId}#content_text`,
      content,
      producerPrincipalId: dependencies.producerPrincipalId,
      createdAt: candidate.createdAt,
    });
    insertEvidenceRecord(db, {
      id: evidenceId,
      tenantId: input.tenantId,
      subjectType: "delegated_pr_candidate",
      subjectId: input.runId,
      artifactId,
      producerPrincipalId: dependencies.producerPrincipalId,
      tool: TOOL,
      toolVersion: dependencies.producerVersion,
      commitSha: dependencies.producerVersion,
      verdict: "passed",
      createdAt: input.observedAt,
    });
    appendDomainEvent(db, {
      id: `event_${sha256(`${input.tenantId}\0${input.idempotencyKey}\0${digest}`)}`,
      tenantId: input.tenantId,
      schemaVersion: 1,
      eventType: EVENT_TYPE,
      aggregateType: "fettler_delegated_candidate",
      aggregateId: input.runId,
      actorPrincipalId: dependencies.producerPrincipalId,
      correlationId: input.correlationId,
      idempotencyKey: eventKey(input),
      payload: {
        requestDigest: digest,
        tenantId: input.tenantId,
        runId: input.runId,
        correlationId: input.correlationId,
        artifactId,
        evidenceId,
        observedAt: input.observedAt,
      },
      createdAt: input.observedAt,
    });
    db.raw.exec("COMMIT");
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
  const promoted = readPromoted(
    db, input, digest, dependencies.producerPrincipalId, dependencies.producerVersion,
  );
  if (!promoted) throw new Error("delegated_pr_candidate_persistence_failed");
  return promoted;
}
