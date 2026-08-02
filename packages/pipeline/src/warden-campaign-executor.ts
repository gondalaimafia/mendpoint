import { createHash } from "node:crypto";
import type { UnifiedSourceArtifact } from "@mendpoint/change-intel";
import {
  appendWardenRunEvent,
  claimReadyWardenTargets,
  getPrincipal,
  getRepositorySnapshotPolicy,
  getWardenRolloutDecision,
  insertArtifactManifest,
  listWardenCampaignTargets,
  replayWardenRun,
  transitionWardenTarget,
  type AppDb,
  type WardenCampaignTarget,
  type WardenRunArtifactReference,
  type WardenRunEventKind,
  type WardenRunReplayEvidence,
} from "@mendpoint/db";
import { runGraphQuery, type GraphLearnDb } from "@mendpoint/graph-learn";
import {
  discoverVerificationCommands,
  runVerificationCommand,
  validateVerificationCommands,
} from "@mendpoint/repair";

const SHA256 = /^[a-f0-9]{64}$/;

export type WardenSourceEnvelope = Readonly<{
  schemaVersion: 1;
  sourceArtifactId: string;
  tenantId: string;
  sourceKind: UnifiedSourceArtifact["sourceKind"];
  providerSlug: string;
  sourceUri: string;
  sourceRevision: string | null;
  contentSha256: string;
  observedAt: string;
  capturedAt: string;
  taxonomyVersion: string;
  signalEvidenceLocations: readonly string[];
}>;

export type WardenTypedEditStrategy = Readonly<{
  id: string;
  kind: "typed_recipe" | "ast_codemod" | "semantic_codemod" | "manual_review";
  targetPath: string;
  targetSymbol: string;
  sourceEvidenceIds: readonly string[];
  precondition: string;
  postcondition: string;
  rollback: string;
  confidence: number;
}>;

export type WardenVerificationCheck = Readonly<{
  command: string;
  status: "passed" | "failed";
  failureFingerprints: readonly string[];
  outputSha256: string;
  durationMs: number;
}>;

export type WardenVerificationRun = Readonly<{
  phase: "baseline" | "post_edit";
  snapshotId: string;
  resolvedSha: string;
  manifestSha256: string;
  commands: readonly string[];
  checks: readonly WardenVerificationCheck[];
}>;

export type WardenVerificationComparison = Readonly<{
  ok: boolean;
  introducedFailures: readonly string[];
  resolvedFailures: readonly string[];
  baselineFailed: readonly string[];
  postEditFailed: readonly string[];
}>;

export type WardenCampaignExecutionResult = Readonly<{
  tenantId: string;
  campaignId: string;
  targetId: string;
  runId: string;
  stage: "review";
  attempt: number;
  snapshotId: string;
  resolvedSha: string;
  sourceEnvelopeArtifactId: string;
  baselineArtifactId: string;
  candidateArtifactId: string;
  postEditArtifactId: string;
  gateArtifactId: string;
  packageArtifactId: string;
  replay: WardenRunReplayEvidence;
}>;

export type WardenCampaignExecutionDependencies = Readonly<{
  graphDb: GraphLearnDb;
  planEdits(input: Readonly<{
    source: WardenSourceEnvelope;
    snapshotId: string;
    resolvedSha: string;
    manifestSha256: string;
    snapshotRoot: string;
  }>): Promise<readonly WardenTypedEditStrategy[]>;
  applyEdits(input: Readonly<{
    snapshotId: string;
    resolvedSha: string;
    manifestSha256: string;
    snapshotRoot: string;
    edits: readonly WardenTypedEditStrategy[];
  }>): Promise<Readonly<{
    baseManifestSha256: string;
    candidateRoot: string;
    candidateContent: string;
    appliedEditIds: readonly string[];
  }>>;
  verify?(input: Readonly<{
    phase: WardenVerificationRun["phase"];
    workspaceRoot: string;
    commands: readonly string[];
    snapshotId: string;
    resolvedSha: string;
    manifestSha256: string;
  }>): Promise<readonly WardenVerificationCheck[]>;
}>;

export class WardenCampaignExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message = code,
  ) {
    super(message);
    this.name = "WardenCampaignExecutionError";
  }
}

type CampaignRow = { status: string };
type SnapshotRow = {
  id: string;
  tenant_id: string;
  repository_id: string;
  resolved_sha: string;
  manifest_sha256: string;
  storage_path: string;
  expires_at: string;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new WardenCampaignExecutionError("warden_value_invalid", false);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new WardenCampaignExecutionError("warden_value_invalid", false);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function required(value: string, code: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new WardenCampaignExecutionError(code, false);
  }
  return value;
}

function canonicalTimestamp(value: string, code: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new WardenCampaignExecutionError(code, false);
  }
  return value;
}

export function createWardenSourceEnvelope(source: UnifiedSourceArtifact): WardenSourceEnvelope {
  if (!SHA256.test(source.contentSha256) || sha256(source.content) !== source.contentSha256) {
    throw new WardenCampaignExecutionError("warden_source_hash_mismatch", false);
  }
  required(source.id, "warden_source_id_required");
  required(source.tenantId, "warden_source_tenant_required");
  canonicalTimestamp(source.observedAt, "warden_source_observed_at_invalid");
  canonicalTimestamp(source.capturedAt, "warden_source_captured_at_invalid");
  if (Date.parse(source.capturedAt) < Date.parse(source.observedAt)) {
    throw new WardenCampaignExecutionError("warden_source_time_invalid", false);
  }
  return Object.freeze({
    schemaVersion: 1,
    sourceArtifactId: source.id,
    tenantId: source.tenantId,
    sourceKind: source.sourceKind,
    providerSlug: required(source.providerSlug, "warden_source_provider_required"),
    sourceUri: required(source.sourceUri, "warden_source_uri_required"),
    sourceRevision: source.sourceRevision,
    contentSha256: source.contentSha256,
    observedAt: source.observedAt,
    capturedAt: source.capturedAt,
    taxonomyVersion: source.taxonomyVersion,
    signalEvidenceLocations: Object.freeze([...new Set(source.taxonomySignals.map((signal) =>
      required(signal.evidenceLocation, "warden_source_evidence_location_required")))].sort()),
  });
}

function validateCheck(check: WardenVerificationCheck, command: string): void {
  if (check.command !== command || !["passed", "failed"].includes(check.status) ||
    !SHA256.test(check.outputSha256) || !Number.isSafeInteger(check.durationMs) || check.durationMs < 0 ||
    check.failureFingerprints.some((value) => !SHA256.test(value)) ||
    (check.status === "passed" && check.failureFingerprints.length > 0) ||
    (check.status === "failed" && check.failureFingerprints.length === 0)) {
    throw new WardenCampaignExecutionError("warden_verification_result_invalid", false);
  }
}

export function compareWardenVerificationRuns(
  baseline: WardenVerificationRun,
  postEdit: WardenVerificationRun,
): WardenVerificationComparison {
  if (baseline.phase !== "baseline" || postEdit.phase !== "post_edit" ||
    baseline.snapshotId !== postEdit.snapshotId || baseline.resolvedSha !== postEdit.resolvedSha ||
    baseline.manifestSha256 !== postEdit.manifestSha256 ||
    canonicalJson(baseline.commands) !== canonicalJson(postEdit.commands)) {
    throw new WardenCampaignExecutionError("warden_verification_runs_mismatch", false);
  }
  const baselineFailed = [...new Set(baseline.checks.flatMap((check) => check.failureFingerprints))].sort();
  const postEditFailed = [...new Set(postEdit.checks.flatMap((check) => check.failureFingerprints))].sort();
  const before = new Set(baselineFailed);
  const after = new Set(postEditFailed);
  const introducedFailures = postEditFailed.filter((failure) => !before.has(failure));
  const resolvedFailures = baselineFailed.filter((failure) => !after.has(failure));
  return Object.freeze({
    ok: introducedFailures.length === 0,
    introducedFailures: Object.freeze(introducedFailures),
    resolvedFailures: Object.freeze(resolvedFailures),
    baselineFailed: Object.freeze(baselineFailed),
    postEditFailed: Object.freeze(postEditFailed),
  });
}

function persistJsonArtifact(db: AppDb, input: {
  tenantId: string;
  kind: string;
  value: unknown;
  producerPrincipalId: string;
  createdAt: string;
}) {
  const content = canonicalJson(input.value);
  const digest = sha256(content);
  const id = `artifact_${sha256(`${input.tenantId}\0${input.kind}\0${digest}`)}`;
  return insertArtifactManifest(db, {
    id,
    tenantId: input.tenantId,
    kind: input.kind,
    schemaVersion: 1,
    sha256: digest,
    mediaType: `application/vnd.mendpoint.${input.kind}+json`,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    storageRef: `sqlite://artifact_manifests/${id}#content_text`,
    content,
    producerPrincipalId: input.producerPrincipalId,
    createdAt: input.createdAt,
  }).row;
}

function artifactReference(row: {
  id: string; kind: string; sha256: string; storage_ref: string;
}): WardenRunArtifactReference {
  return Object.freeze({ id: row.id, kind: row.kind, sha256: row.sha256, storageRef: row.storage_ref });
}

function campaignStatus(db: AppDb, tenantId: string, campaignId: string): string {
  const row = db.raw.prepare(
    "SELECT status FROM warden_campaigns WHERE id = ? AND tenant_id = ?",
  ).get(campaignId, tenantId) as CampaignRow | undefined;
  if (!row) throw new WardenCampaignExecutionError("warden_campaign_not_found", false);
  return row.status;
}

function assertRunning(db: AppDb, tenantId: string, campaignId: string): void {
  const status = campaignStatus(db, tenantId, campaignId);
  if (status === "paused") throw new WardenCampaignExecutionError("warden_campaign_paused", true);
  if (status !== "running") throw new WardenCampaignExecutionError("warden_campaign_not_running", false);
}

function validateTypedEdits(edits: readonly WardenTypedEditStrategy[], sourceArtifactId: string): void {
  if (edits.length === 0 || edits.length > 100) {
    throw new WardenCampaignExecutionError("warden_typed_edits_required", false);
  }
  const ids = new Set<string>();
  for (const edit of edits) {
    required(edit.id, "warden_edit_id_required");
    if (ids.has(edit.id)) throw new WardenCampaignExecutionError("warden_edit_id_duplicate", false);
    ids.add(edit.id);
    if (!["typed_recipe", "ast_codemod", "semantic_codemod", "manual_review"].includes(edit.kind) ||
      !edit.targetPath || edit.targetPath.includes("..") || edit.targetPath.startsWith("/") || /^[A-Za-z]:/.test(edit.targetPath) ||
      !edit.targetSymbol || !edit.precondition || !edit.postcondition || !edit.rollback ||
      !Number.isFinite(edit.confidence) || edit.confidence < 0 || edit.confidence > 1 ||
      edit.sourceEvidenceIds.length === 0 || !edit.sourceEvidenceIds.includes(sourceArtifactId)) {
      throw new WardenCampaignExecutionError("warden_typed_edit_invalid", false);
    }
  }
}

function graphGateEvidence(
  graphDb: GraphLearnDb,
  input: { tenantId: string; repositoryId: string; snapshotId: string; resolvedSha: string; ownerHandle: string },
) {
  const result = runGraphQuery(graphDb, {
    op: "repository_evidence",
    repositoryId: input.repositoryId,
    snapshotId: input.snapshotId,
    limit: 100,
  }, { tenantId: input.tenantId });
  const rows = (result.rows ?? []) as Array<Record<string, unknown>>;
  const exact = (row: Record<string, unknown>) => row.exactCommit === input.resolvedSha;
  const owner = rows.find((row) => row.type === "codeowners" && exact(row) &&
    Array.isArray(row.owners) && row.owners.includes(input.ownerHandle));
  const ci = rows.find((row) => row.type === "ci" && exact(row) && row.conclusion === "success");
  const runtime = rows.find((row) => row.type === "runtime_trace" && exact(row) && row.status === "ok");
  if (!owner) throw new WardenCampaignExecutionError("warden_owner_gate_failed", false);
  if (!ci) throw new WardenCampaignExecutionError("warden_ci_gate_failed", true);
  if (!runtime) throw new WardenCampaignExecutionError("warden_runtime_gate_failed", true);
  return Object.freeze({
    snapshotId: input.snapshotId,
    resolvedSha: input.resolvedSha,
    ownerEvidenceId: String(owner.id),
    ciEvidenceId: String(ci.id),
    runtimeEvidenceId: String(runtime.id),
  });
}

async function defaultVerify(input: {
  workspaceRoot: string;
  commands: readonly string[];
}): Promise<readonly WardenVerificationCheck[]> {
  const checks: WardenVerificationCheck[] = [];
  for (const command of input.commands) {
    const started = performance.now();
    const result = await runVerificationCommand(command, input.workspaceRoot);
    const output = `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`;
    checks.push(Object.freeze({
      command,
      status: result.ok ? "passed" : "failed",
      failureFingerprints: Object.freeze(result.ok ? [] : [sha256(output)]),
      outputSha256: sha256(output),
      durationMs: Math.max(0, Math.round(performance.now() - started)),
    }));
  }
  return Object.freeze(checks);
}

function runEnvelopeAppender(db: AppDb, input: {
  tenantId: string;
  runId: string;
  actorPrincipalId: string;
  correlationId: string;
  createdAt: string;
  snapshotState: string;
  rolloutDecisionSha256: string;
}) {
  let sequence = 0;
  let causationId: string | null = null;
  let state = sha256(input.snapshotState);
  return (kind: WardenRunEventKind, value: unknown, artifacts: readonly WardenRunArtifactReference[] = []) => {
    sequence += 1;
    const output = sha256(canonicalJson(value));
    const eventId = `event_${sha256(`${input.runId}\0${sequence}\0${kind}\0${output}`)}`;
    appendWardenRunEvent(db, {
      tenantId: input.tenantId,
      actorPrincipalId: input.actorPrincipalId,
      idempotencyKey: `${input.runId}:${sequence}:${kind}`,
      createdAt: input.createdAt,
      envelope: {
        envelopeVersion: 1,
        eventId,
        tenantId: input.tenantId,
        runId: input.runId,
        eventKind: kind,
        actorPrincipalId: input.actorPrincipalId,
        correlationId: input.correlationId,
        causationId,
        occurredAt: input.createdAt,
        inputSha256: state,
        outputSha256: output,
        versions: [
          { kind: "tool", id: "warden-campaign-executor", version: "1" },
          { kind: "policy", id: "warden-rollout", version: input.rolloutDecisionSha256 },
        ],
        cost: { currency: "USD", amountMicros: 0, inputTokens: 0, outputTokens: 0, computeMs: 0 },
        artifacts,
        deterministic: { eligible: true, replayKey: `warden:${input.runId}:v1`, stateBeforeSha256: state, stateAfterSha256: output },
        metadata: { sequence, kind },
      },
    });
    causationId = eventId;
    state = output;
  };
}

export async function executeWardenCampaignTarget(input: {
  db: AppDb;
  tenantId: string;
  campaignId: string;
  targetId: string;
  rolloutDecisionId: string;
  source: UnifiedSourceArtifact;
  rolloutApproval: Readonly<{ decisionSha256: string; approvedByPrincipalId: string; approvedAt: string }>;
  ownerApproval: Readonly<{ ownerPrincipalId: string; ownerHandle: string; approvedAt: string }>;
  actorPrincipalId: string;
  runId: string;
  createdAt: string;
  dependencies: WardenCampaignExecutionDependencies;
}): Promise<WardenCampaignExecutionResult> {
  canonicalTimestamp(input.createdAt, "warden_execution_created_at_invalid");
  assertRunning(input.db, input.tenantId, input.campaignId);
  const actor = getPrincipal(input.db, input.tenantId, input.actorPrincipalId);
  if (!actor || actor.revoked_at) throw new WardenCampaignExecutionError("warden_execution_actor_invalid", false);
  const approver = getPrincipal(input.db, input.tenantId, input.rolloutApproval.approvedByPrincipalId);
  if (!approver || approver.revoked_at || approver.kind !== "human") {
    throw new WardenCampaignExecutionError("warden_rollout_human_approval_required", false);
  }
  canonicalTimestamp(input.rolloutApproval.approvedAt, "warden_rollout_approval_time_invalid");
  canonicalTimestamp(input.ownerApproval.approvedAt, "warden_owner_approval_time_invalid");

  const target = listWardenCampaignTargets(input.db, input.tenantId, input.campaignId)
    .find((candidate) => candidate.id === input.targetId);
  if (!target) throw new WardenCampaignExecutionError("warden_target_not_found", false);
  if (target.stage !== "queued") throw new WardenCampaignExecutionError("warden_target_not_queued", true);
  if (target.ownerPrincipalId !== input.ownerApproval.ownerPrincipalId) {
    throw new WardenCampaignExecutionError("warden_owner_approval_mismatch", false);
  }
  const owner = getPrincipal(input.db, input.tenantId, input.ownerApproval.ownerPrincipalId);
  if (!owner || owner.revoked_at || owner.kind !== "human") {
    throw new WardenCampaignExecutionError("warden_human_owner_required", false);
  }
  const decision = getWardenRolloutDecision(input.db, input.tenantId, input.rolloutDecisionId);
  if (!decision || decision.campaignId !== input.campaignId ||
    decision.decisionSha256 !== input.rolloutApproval.decisionSha256) {
    throw new WardenCampaignExecutionError("warden_rollout_approval_mismatch", false);
  }
  const targets = listWardenCampaignTargets(input.db, input.tenantId, input.campaignId);
  const completed = new Set(targets.filter((candidate) => candidate.stage === "completed").map((candidate) => candidate.id));
  const activeCohort = decision.cohorts.find((cohort) => cohort.targetIds.some((id) => !completed.has(id)));
  if (!activeCohort || !activeCohort.targetIds.includes(input.targetId)) {
    throw new WardenCampaignExecutionError("warden_rollout_cohort_blocked", true);
  }
  if (input.createdAt < activeCohort.notBefore || input.createdAt > activeCohort.notAfter) {
    throw new WardenCampaignExecutionError("warden_maintenance_window_closed", true);
  }
  if (!claimReadyWardenTargets(input.db, input.tenantId, input.campaignId).some((candidate) => candidate.id === input.targetId)) {
    throw new WardenCampaignExecutionError("warden_target_not_ready", true);
  }

  const snapshot = input.db.raw.prepare(
    `SELECT id, tenant_id, repository_id, resolved_sha, manifest_sha256, storage_path, expires_at
     FROM repository_snapshots WHERE id = ? AND tenant_id = ? AND repository_id = ?`,
  ).get(target.snapshotId, input.tenantId, target.repositoryId) as SnapshotRow | undefined;
  if (!snapshot || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.resolved_sha) ||
    !SHA256.test(snapshot.manifest_sha256)) {
    throw new WardenCampaignExecutionError("warden_exact_snapshot_invalid", false);
  }
  if (input.createdAt >= snapshot.expires_at) throw new WardenCampaignExecutionError("warden_snapshot_expired", false);
  const snapshotPolicy = getRepositorySnapshotPolicy(input.db, input.tenantId, snapshot.id);
  if (!snapshotPolicy) throw new WardenCampaignExecutionError("warden_snapshot_policy_required", false);
  const approvedCommands = JSON.parse(snapshotPolicy.verification_commands_json) as unknown;
  if (!Array.isArray(approvedCommands) || approvedCommands.some((command) => typeof command !== "string")) {
    throw new WardenCampaignExecutionError("warden_verification_policy_invalid", false);
  }
  const discovered = discoverVerificationCommands(snapshot.storage_path);
  const commands = discovered.filter((command) => approvedCommands.includes(command));
  if (commands.length === 0 || validateVerificationCommands(commands, snapshot.storage_path).ok === false) {
    throw new WardenCampaignExecutionError("warden_approved_verification_missing", false);
  }

  const source = createWardenSourceEnvelope(input.source);
  if (source.tenantId !== input.tenantId) throw new WardenCampaignExecutionError("warden_source_tenant_mismatch", false);
  const runId = required(input.runId, "warden_run_id_required");
  const appendRun = runEnvelopeAppender(input.db, {
    tenantId: input.tenantId,
    runId,
    actorPrincipalId: input.actorPrincipalId,
    correlationId: input.campaignId,
    createdAt: input.createdAt,
    snapshotState: canonicalJson(snapshot),
    rolloutDecisionSha256: decision.decisionSha256,
  });
  appendRun("run_started", {
    campaignId: input.campaignId,
    targetId: input.targetId,
    snapshotId: snapshot.id,
    resolvedSha: snapshot.resolved_sha,
    manifestSha256: snapshot.manifest_sha256,
    rolloutDecisionId: decision.id,
    approvedByPrincipalId: input.rolloutApproval.approvedByPrincipalId,
  });

  let current: WardenCampaignTarget = target;
  try {
    current = transitionWardenTarget(input.db, {
      tenantId: input.tenantId, campaignId: input.campaignId, targetId: input.targetId,
      expectedRevision: current.revision, from: "queued", to: "analyzing",
      actorPrincipalId: input.actorPrincipalId, eventId: `${runId}:target:analyzing`,
      idempotencyKey: `${runId}:target:analyzing`, correlationId: input.campaignId, createdAt: input.createdAt,
    });
    const sourceArtifact = persistJsonArtifact(input.db, {
      tenantId: input.tenantId, kind: "warden-source-envelope", value: source,
      producerPrincipalId: input.actorPrincipalId, createdAt: input.createdAt,
    });
    appendRun("artifact_ingested", source, [artifactReference(sourceArtifact)]);
    assertRunning(input.db, input.tenantId, input.campaignId);

    const gates = graphGateEvidence(input.dependencies.graphDb, {
      tenantId: input.tenantId, repositoryId: snapshot.repository_id, snapshotId: snapshot.id,
      resolvedSha: snapshot.resolved_sha, ownerHandle: input.ownerApproval.ownerHandle,
    });
    const gateArtifact = persistJsonArtifact(input.db, {
      tenantId: input.tenantId, kind: "warden-execution-gates", value: {
        ...gates, rolloutDecisionId: decision.id, rolloutDecisionSha256: decision.decisionSha256,
        rolloutApprovedBy: input.rolloutApproval.approvedByPrincipalId,
        ownerApprovedBy: input.ownerApproval.ownerPrincipalId,
      }, producerPrincipalId: input.actorPrincipalId, createdAt: input.createdAt,
    });
    appendRun("policy_enforced", gates, [artifactReference(gateArtifact)]);

    const verify = input.dependencies.verify ?? (async (request) => defaultVerify(request));
    const baselineChecks = await verify({
      phase: "baseline", workspaceRoot: snapshot.storage_path, commands,
      snapshotId: snapshot.id, resolvedSha: snapshot.resolved_sha, manifestSha256: snapshot.manifest_sha256,
    });
    if (baselineChecks.length !== commands.length) throw new WardenCampaignExecutionError("warden_verification_result_incomplete", false);
    baselineChecks.forEach((check, index) => validateCheck(check, commands[index]!));
    const baseline: WardenVerificationRun = Object.freeze({
      phase: "baseline", snapshotId: snapshot.id, resolvedSha: snapshot.resolved_sha,
      manifestSha256: snapshot.manifest_sha256, commands: Object.freeze([...commands]),
      checks: Object.freeze([...baselineChecks]),
    });
    const baselineArtifact = persistJsonArtifact(input.db, {
      tenantId: input.tenantId, kind: "warden-baseline-verification", value: baseline,
      producerPrincipalId: input.actorPrincipalId, createdAt: input.createdAt,
    });
    assertRunning(input.db, input.tenantId, input.campaignId);

    const edits = await input.dependencies.planEdits({
      source, snapshotId: snapshot.id, resolvedSha: snapshot.resolved_sha,
      manifestSha256: snapshot.manifest_sha256, snapshotRoot: snapshot.storage_path,
    });
    validateTypedEdits(edits, source.sourceArtifactId);
    appendRun("analysis_completed", edits, [artifactReference(sourceArtifact), artifactReference(baselineArtifact)]);
    assertRunning(input.db, input.tenantId, input.campaignId);
    current = transitionWardenTarget(input.db, {
      tenantId: input.tenantId, campaignId: input.campaignId, targetId: input.targetId,
      expectedRevision: current.revision, from: "analyzing", to: "editing",
      actorPrincipalId: input.actorPrincipalId, eventId: `${runId}:target:editing`,
      idempotencyKey: `${runId}:target:editing`, correlationId: input.campaignId, createdAt: input.createdAt,
    });
    const candidate = await input.dependencies.applyEdits({
      snapshotId: snapshot.id, resolvedSha: snapshot.resolved_sha,
      manifestSha256: snapshot.manifest_sha256, snapshotRoot: snapshot.storage_path, edits,
    });
    if (candidate.baseManifestSha256 !== snapshot.manifest_sha256 ||
      canonicalJson([...candidate.appliedEditIds].sort()) !== canonicalJson(edits.map((edit) => edit.id).sort())) {
      throw new WardenCampaignExecutionError("warden_candidate_snapshot_binding_invalid", false);
    }
    const candidateArtifact = persistJsonArtifact(input.db, {
      tenantId: input.tenantId, kind: "warden-candidate", value: {
        snapshotId: snapshot.id, resolvedSha: snapshot.resolved_sha,
        baseManifestSha256: snapshot.manifest_sha256, candidateContentSha256: sha256(candidate.candidateContent),
        candidateContent: candidate.candidateContent, edits,
      }, producerPrincipalId: input.actorPrincipalId, createdAt: input.createdAt,
    });
    appendRun("candidate_generated", { candidateArtifactId: candidateArtifact.id, edits: edits.length }, [artifactReference(candidateArtifact)]);
    assertRunning(input.db, input.tenantId, input.campaignId);
    current = transitionWardenTarget(input.db, {
      tenantId: input.tenantId, campaignId: input.campaignId, targetId: input.targetId,
      expectedRevision: current.revision, from: "editing", to: "verifying",
      actorPrincipalId: input.actorPrincipalId, eventId: `${runId}:target:verifying`,
      idempotencyKey: `${runId}:target:verifying`, correlationId: input.campaignId, createdAt: input.createdAt,
    });
    const postChecks = await verify({
      phase: "post_edit", workspaceRoot: candidate.candidateRoot, commands,
      snapshotId: snapshot.id, resolvedSha: snapshot.resolved_sha, manifestSha256: snapshot.manifest_sha256,
    });
    if (postChecks.length !== commands.length) throw new WardenCampaignExecutionError("warden_verification_result_incomplete", false);
    postChecks.forEach((check, index) => validateCheck(check, commands[index]!));
    const postEdit: WardenVerificationRun = Object.freeze({
      phase: "post_edit", snapshotId: snapshot.id, resolvedSha: snapshot.resolved_sha,
      manifestSha256: snapshot.manifest_sha256, commands: Object.freeze([...commands]),
      checks: Object.freeze([...postChecks]),
    });
    const comparison = compareWardenVerificationRuns(baseline, postEdit);
    const postEditArtifact = persistJsonArtifact(input.db, {
      tenantId: input.tenantId, kind: "warden-post-edit-verification", value: { run: postEdit, comparison },
      producerPrincipalId: input.actorPrincipalId, createdAt: input.createdAt,
    });
    appendRun("verification_completed", comparison, [artifactReference(baselineArtifact), artifactReference(postEditArtifact)]);
    if (!comparison.ok) throw new WardenCampaignExecutionError("warden_verification_regression", true);

    const packageArtifact = persistJsonArtifact(input.db, {
      tenantId: input.tenantId, kind: "warden-campaign-review-package", value: {
        schemaVersion: 1, campaignId: input.campaignId, targetId: input.targetId, runId,
        attempt: current.attemptCount, sourceEnvelopeArtifactId: sourceArtifact.id,
        snapshot: { id: snapshot.id, resolvedSha: snapshot.resolved_sha, manifestSha256: snapshot.manifest_sha256 },
        typedEdits: edits, baselineArtifactId: baselineArtifact.id, candidateArtifactId: candidateArtifact.id,
        postEditArtifactId: postEditArtifact.id, gateArtifactId: gateArtifact.id,
        delivery: { mode: "draft", autoMerge: false, autoDeploy: false },
      }, producerPrincipalId: input.actorPrincipalId, createdAt: input.createdAt,
    });
    current = transitionWardenTarget(input.db, {
      tenantId: input.tenantId, campaignId: input.campaignId, targetId: input.targetId,
      expectedRevision: current.revision, from: "verifying", to: "review", packageArtifactId: packageArtifact.id,
      actorPrincipalId: input.actorPrincipalId, eventId: `${runId}:target:review`,
      idempotencyKey: `${runId}:target:review`, correlationId: input.campaignId, createdAt: input.createdAt,
    });
    appendRun("run_completed", { stage: current.stage, packageArtifactId: packageArtifact.id }, [artifactReference(packageArtifact)]);
    const replay = replayWardenRun(input.db, input.tenantId, runId);
    return Object.freeze({
      tenantId: input.tenantId, campaignId: input.campaignId, targetId: input.targetId, runId,
      stage: "review", attempt: current.attemptCount, snapshotId: snapshot.id, resolvedSha: snapshot.resolved_sha,
      sourceEnvelopeArtifactId: sourceArtifact.id, baselineArtifactId: baselineArtifact.id,
      candidateArtifactId: candidateArtifact.id, postEditArtifactId: postEditArtifact.id,
      gateArtifactId: gateArtifact.id, packageArtifactId: packageArtifact.id, replay,
    });
  } catch (cause) {
    const error = cause instanceof WardenCampaignExecutionError
      ? cause
      : new WardenCampaignExecutionError("warden_execution_failed", true, cause instanceof Error ? cause.message : String(cause));
    const failureKind: WardenRunEventKind = "run_failed";
    appendRun(failureKind, { code: error.code, retryable: error.retryable });
    const latest = listWardenCampaignTargets(input.db, input.tenantId, input.campaignId)
      .find((candidate) => candidate.id === input.targetId);
    if (latest && ["analyzing", "editing", "verifying"].includes(latest.stage)) {
      transitionWardenTarget(input.db, {
        tenantId: input.tenantId, campaignId: input.campaignId, targetId: input.targetId,
        expectedRevision: latest.revision, from: latest.stage,
        to: error.code === "warden_campaign_paused" ? "blocked" : "failed",
        exceptionCode: error.code, actorPrincipalId: input.actorPrincipalId,
        eventId: `${runId}:target:${error.code}`, idempotencyKey: `${runId}:target:${error.code}`,
        correlationId: input.campaignId, createdAt: input.createdAt,
      });
    }
    throw error;
  }
}

export function recoverWardenCampaignTarget(input: {
  db: AppDb;
  tenantId: string;
  campaignId: string;
  targetId: string;
  failedRunId: string;
  expectedReplaySha256: string;
  actorPrincipalId: string;
  createdAt: string;
}): Readonly<{ target: WardenCampaignTarget; replay: WardenRunReplayEvidence }> {
  assertRunning(input.db, input.tenantId, input.campaignId);
  const replay = replayWardenRun(input.db, input.tenantId, input.failedRunId, input.expectedReplaySha256);
  const target = listWardenCampaignTargets(input.db, input.tenantId, input.campaignId)
    .find((candidate) => candidate.id === input.targetId);
  if (!target || !["failed", "blocked"].includes(target.stage)) {
    throw new WardenCampaignExecutionError("warden_target_not_recoverable", false);
  }
  if (target.attemptCount >= target.maxAttempts) {
    throw new WardenCampaignExecutionError("warden_attempts_exhausted", false);
  }
  const recovered = transitionWardenTarget(input.db, {
    tenantId: input.tenantId, campaignId: input.campaignId, targetId: input.targetId,
    expectedRevision: target.revision, from: target.stage, to: "queued",
    actorPrincipalId: input.actorPrincipalId, eventId: `${input.failedRunId}:recovered:${target.revision}`,
    idempotencyKey: `${input.failedRunId}:recovered:${target.revision}`,
    correlationId: input.campaignId, createdAt: input.createdAt,
  });
  return Object.freeze({ target: recovered, replay });
}
