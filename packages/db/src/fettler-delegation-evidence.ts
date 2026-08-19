import { createHash } from "node:crypto";
import type { AuditEvent, RoutingLedgerRow } from "./schema.js";
import type { AgentRunRow, AppDb, JobRow } from "./index.js";
import { verifyAuditIntegrity } from "./index.js";
import {
  getTrajectory,
  listTrajectorySteps,
  type Trajectory,
  type TrajectoryStep,
} from "./trajectory.js";
import { getAgentRunMeter, type AgentRunMeter } from "./agent-run-meter.js";
import type { WardenModelReservationRow } from "./warden-model-accounting.js";
import {
  getWardenCandidateDeliveryByRun,
  type WardenCandidateDeliveryRecord,
} from "./warden-candidate-delivery.js";
import {
  getWardenCiCycle,
  listWardenCiObservations,
  type WardenCiCycle,
  type WardenCiObservation,
} from "./warden-ci-reentry.js";

export type FettlerDelegationEvidenceReason =
  | "agent_run_not_found"
  | "job_not_linked"
  | "job_not_found"
  | "trajectory_not_observed"
  | "trajectory_join_ambiguous"
  | "trajectory_binding_conflict"
  | "model_reservations_not_observed"
  | "model_reservation_binding_conflict"
  | "routing_ledger_not_observed"
  | "routing_ledger_binding_conflict"
  | "run_meter_not_observed"
  | "audit_chain_invalid"
  | "approval_audit_not_observed"
  | "approval_principal_unproven"
  | "approval_candidate_binding_unproven"
  | "candidate_delivery_not_observed"
  | "delivery_audit_not_observed"
  | "delivery_audit_binding_unproven"
  | "ci_not_observed"
  | "ci_binding_conflict"
  | "terminal_outcome_not_observed"
  | "scm_cleanup_not_durably_recorded";

export type Observed<T> = Readonly<{ status: "observed"; value: T }>;
export type NotObserved = Readonly<{
  status: "not_observed";
  reason: FettlerDelegationEvidenceReason;
}>;
export type DurableEvidence<T> = Observed<T> | NotObserved;

export type FettlerTrajectoryEvidence = Readonly<{
  trajectory: Trajectory;
  steps: readonly TrajectoryStep[];
}>;

export type FettlerApprovalEvidence = Readonly<{
  auditEvents: readonly AuditEvent[];
  reviewerPrincipalId: string;
  trustPrincipalId: string;
  authMethod: "oidc";
  membershipEvidenceId: string;
  reviewedAt: string;
  requestIds: readonly string[];
  seal: Readonly<{ path: string; sha256: string }>;
  candidate: Readonly<{
    digest: string;
    candidateManifestSha256: string;
    repositoryId: string;
    snapshotId: string;
    revision: string;
    sourceManifestSha256: string;
  }>;
}>;

export type FettlerCandidateDeliveryEvidence = Readonly<{
  delivery: WardenCandidateDeliveryRecord;
  auditEvents: readonly AuditEvent[];
  auditReason: FettlerDelegationEvidenceReason | null;
}>;

export type FettlerCiEvidence = Readonly<{
  cycle: WardenCiCycle;
  observations: readonly WardenCiObservation[];
}>;

export type FettlerTerminalOutcomeEvidence = Readonly<{
  source: "candidate_delivery";
  outcome: "merged" | "closed_unmerged" | "reverted";
  observedAt: string;
}>;

export type FettlerDelegationEvidence = Readonly<{
  tenantId: string;
  runId: string;
  auditIntegrity: Readonly<{ ok: boolean; checked: number; error?: string }>;
  agentRun: DurableEvidence<Readonly<AgentRunRow>>;
  job: DurableEvidence<Readonly<JobRow>>;
  trajectory: DurableEvidence<FettlerTrajectoryEvidence>;
  modelReservations: DurableEvidence<readonly Readonly<WardenModelReservationRow>[]>;
  routingLedger: DurableEvidence<readonly Readonly<RoutingLedgerRow>[]>;
  runMeter: DurableEvidence<AgentRunMeter>;
  approval: DurableEvidence<FettlerApprovalEvidence>;
  candidateDelivery: DurableEvidence<FettlerCandidateDeliveryEvidence>;
  ci: DurableEvidence<readonly FettlerCiEvidence[]>;
  terminalOutcome: DurableEvidence<FettlerTerminalOutcomeEvidence>;
  cleanup: NotObserved;
}>;

type ApprovalBinding = Readonly<{
  reviewerPrincipalId: string;
  trustPrincipalId: string;
  authMethod: "oidc";
  membershipEvidenceId: string;
  reviewedAt: string;
  rationale: string;
  sealPath: string;
  sealSha256: string;
  candidateDigest: string;
  candidateManifestSha256: string;
  repositoryId: string;
  snapshotId: string;
  revision: string;
  manifestSha256: string;
}>;

const observed = <T>(value: T): Observed<T> => Object.freeze({ status: "observed", value });
const notObserved = (reason: FettlerDelegationEvidenceReason): NotObserved =>
  Object.freeze({ status: "not_observed", reason });

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function membershipEvidenceId(tenantId: string, issuer: string, subject: string): string {
  return `membership:${createHash("sha256")
    .update(`${tenantId}\n${issuer}\n${subject}`, "utf8")
    .digest("hex")}`;
}

function timestamp(value: unknown): value is string {
  return nonEmpty(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseObject(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    return object(JSON.parse(value));
  } catch {
    return null;
  }
}

function freezeRows<T extends object>(rows: readonly T[]): readonly Readonly<T>[] {
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

function approvalBinding(run: AgentRunRow): ApprovalBinding | null {
  const result = parseObject(run.result_json);
  const source = object(result?.source);
  const review = object(result?.review);
  const artifacts = object(result?.artifacts);
  const approval = object(artifacts?.approval);
  if (
    result?.jobId !== run.job_id ||
    result?.attemptStatus !== "succeeded" ||
    review?.decision !== "approve" ||
    !nonEmpty(review.reviewerPrincipalId) ||
    !nonEmpty(review.trustPrincipalId) ||
    review.reviewerPrincipalId !== review.trustPrincipalId ||
    review.authMethod !== "oidc" ||
    !nonEmpty(review.membershipEvidenceId) ||
    !timestamp(review.reviewedAt) ||
    !nonEmpty(review.rationale) ||
    !nonEmpty(approval?.path) ||
    !nonEmpty(approval.sha256) ||
    !nonEmpty(artifacts?.candidateDigest) ||
    !nonEmpty(artifacts.candidateManifestSha256) ||
    !nonEmpty(source?.repositoryId) ||
    !nonEmpty(source.snapshotId) ||
    !nonEmpty(source.revision) ||
    !nonEmpty(source.manifestSha256)
  ) {
    return null;
  }
  return Object.freeze({
    reviewerPrincipalId: review.reviewerPrincipalId,
    trustPrincipalId: review.trustPrincipalId,
    authMethod: "oidc",
    membershipEvidenceId: review.membershipEvidenceId,
    reviewedAt: review.reviewedAt,
    rationale: review.rationale,
    sealPath: approval.path,
    sealSha256: approval.sha256,
    candidateDigest: artifacts.candidateDigest,
    candidateManifestSha256: artifacts.candidateManifestSha256,
    repositoryId: source.repositoryId,
    snapshotId: source.snapshotId,
    revision: source.revision,
    manifestSha256: source.manifestSha256,
  });
}

function metadata(event: AuditEvent): Record<string, unknown> | null {
  return parseObject(event.metadata_json);
}

function approvalAuditMatches(
  event: AuditEvent,
  run: AgentRunRow,
  binding: ApprovalBinding,
  delivery: WardenCandidateDeliveryRecord,
): boolean {
  const value = metadata(event);
  const recordedDelivery = object(value?.delivery);
  return event.action === "agent.candidate.approved" &&
    event.resource_type === "agent_run" && event.resource_id === run.id &&
    event.actor === "operator" && event.principal_id === binding.reviewerPrincipalId &&
    event.api_key_id === null && nonEmpty(event.request_id) &&
    value?.decision === "approve" && value.reviewerPrincipalId === binding.reviewerPrincipalId &&
    value.trustPrincipalId === binding.trustPrincipalId &&
    value.authMethod === binding.authMethod &&
    value.membershipEvidenceId === binding.membershipEvidenceId &&
    value.reviewedAt === binding.reviewedAt &&
    event.created_at === binding.reviewedAt &&
    value.candidateDigest === binding.candidateDigest &&
    value.candidateManifestSha256 === binding.candidateManifestSha256 &&
    recordedDelivery?.id === delivery.id && recordedDelivery.runId === run.id &&
    recordedDelivery.repositoryId === binding.repositoryId &&
    recordedDelivery.snapshotId === binding.snapshotId &&
    recordedDelivery.expectedBaseRevision === binding.revision &&
    recordedDelivery.sealedPath === binding.sealPath &&
    recordedDelivery.sealedSha256 === binding.sealSha256;
}

function deliveryAuditMatches(
  event: AuditEvent,
  delivery: WardenCandidateDeliveryRecord,
): boolean {
  const value = metadata(event);
  return event.action === "agent.candidate.draft_delivered" &&
    event.resource_type === "agent_run" && event.resource_id === delivery.runId &&
    event.actor === "agent" && event.request_id === delivery.jobId &&
    value?.deliveryId === delivery.id && value.repositoryId === delivery.repositoryId &&
    value.snapshotId === delivery.snapshotId && value.baseBranch === delivery.baseBranch &&
    value.expectedBaseRevision === delivery.expectedBaseRevision &&
    value.approvalSeal === delivery.sealedSha256 &&
    value.requesterPrincipalId === delivery.requesterPrincipalId &&
    value.branchName === delivery.branchName && value.commitSha === delivery.commitSha &&
    value.draftPr === true && value.draftPrNumber === delivery.draftPrNumber &&
    value.draftPrUrl === delivery.draftPrUrl;
}

function approvalEvidence(
  run: AgentRunRow,
  delivery: WardenCandidateDeliveryRecord | undefined,
  events: readonly AuditEvent[],
  auditOk: boolean,
  snapshotBound: boolean,
  humanPrincipalBound: boolean,
): DurableEvidence<FettlerApprovalEvidence> {
  if (!auditOk) return notObserved("audit_chain_invalid");
  if (!humanPrincipalBound) return notObserved("approval_principal_unproven");
  const binding = approvalBinding(run);
  if (!binding || !delivery || !snapshotBound ||
    delivery.runId !== run.id ||
    delivery.repositoryId !== binding.repositoryId ||
    delivery.snapshotId !== binding.snapshotId ||
    delivery.expectedBaseRevision !== binding.revision ||
    delivery.sealedPath !== binding.sealPath || delivery.sealedSha256 !== binding.sealSha256 ||
    delivery.requesterPrincipalId !== binding.reviewerPrincipalId ||
    delivery.rationale !== binding.rationale) {
    return notObserved("approval_candidate_binding_unproven");
  }
  const matched = events.filter((event) => approvalAuditMatches(event, run, binding, delivery));
  if (matched.length === 0) return notObserved("approval_audit_not_observed");
  if (matched.length !== 1) return notObserved("approval_candidate_binding_unproven");
  return observed(Object.freeze({
    auditEvents: freezeRows(matched),
    reviewerPrincipalId: binding.reviewerPrincipalId,
    trustPrincipalId: binding.trustPrincipalId,
    authMethod: binding.authMethod,
    membershipEvidenceId: binding.membershipEvidenceId,
    reviewedAt: binding.reviewedAt,
    requestIds: Object.freeze(matched.map((event) => event.request_id!)),
    seal: Object.freeze({ path: binding.sealPath, sha256: binding.sealSha256 }),
    candidate: Object.freeze({
      digest: binding.candidateDigest,
      candidateManifestSha256: binding.candidateManifestSha256,
      repositoryId: binding.repositoryId,
      snapshotId: binding.snapshotId,
      revision: binding.revision,
      sourceManifestSha256: binding.manifestSha256,
    }),
  }));
}

/**
 * Read the durable Fettler delegation evidence for one exact tenant/run pair.
 * This reader performs no writes and never upgrades absence, malformed JSON, or
 * a partial join into success. In particular, current storage has no durable
 * remote-branch deletion/base-unchanged record, so SCM cleanup is always
 * reported as not observed rather than inferred from local candidate cleanup.
 */
export function getFettlerDelegationEvidence(
  db: AppDb,
  tenantId: string,
  runId: string,
): FettlerDelegationEvidence {
  if (!tenantId.trim()) throw new Error("fettler_delegation_evidence_tenant_invalid");
  if (!runId.trim()) throw new Error("fettler_delegation_evidence_run_invalid");

  const run = db.raw.prepare(
    "SELECT * FROM agent_runs WHERE tenant_id = ? AND id = ?",
  ).get(tenantId, runId) as AgentRunRow | undefined;
  const auditIntegrity = Object.freeze(verifyAuditIntegrity(db, tenantId));
  const auditEvents = db.raw.prepare(
    `SELECT * FROM audit_events WHERE tenant_id = ? AND resource_type = 'agent_run'
       AND resource_id = ? ORDER BY event_sequence, id`,
  ).all(tenantId, runId) as AuditEvent[];

  if (!run) {
    const absent = notObserved("agent_run_not_found");
    return Object.freeze({
      tenantId, runId, auditIntegrity, agentRun: absent,
      job: notObserved("job_not_linked"), trajectory: notObserved("trajectory_not_observed"),
      modelReservations: notObserved("model_reservations_not_observed"),
      routingLedger: notObserved("routing_ledger_not_observed"),
      runMeter: notObserved("run_meter_not_observed"),
      approval: notObserved("approval_candidate_binding_unproven"),
      candidateDelivery: notObserved("candidate_delivery_not_observed"),
      ci: notObserved("ci_not_observed"),
      terminalOutcome: notObserved("terminal_outcome_not_observed"),
      cleanup: notObserved("scm_cleanup_not_durably_recorded"),
    });
  }

  const frozenRun = Object.freeze({ ...run });
  const job = run.job_id
    ? db.raw.prepare("SELECT * FROM jobs WHERE tenant_id = ? AND id = ?")
      .get(tenantId, run.job_id) as JobRow | undefined
    : undefined;

  const trajectoryIds = db.raw.prepare(
    "SELECT id FROM trajectories WHERE tenant_id = ? AND run_id = ? ORDER BY created_at, id",
  ).all(tenantId, runId) as Array<{ id: string }>;
  let trajectory: DurableEvidence<FettlerTrajectoryEvidence>;
  if (trajectoryIds.length === 0) {
    trajectory = notObserved("trajectory_not_observed");
  } else if (trajectoryIds.length !== 1) {
    trajectory = notObserved("trajectory_join_ambiguous");
  } else {
    const row = getTrajectory(db, tenantId, trajectoryIds[0]!.id)!;
    trajectory = row.runId !== runId || row.jobId !== run.job_id
      ? notObserved("trajectory_binding_conflict")
      : observed(Object.freeze({
        trajectory: row,
        steps: Object.freeze(listTrajectorySteps(db, tenantId, row.id)),
      }));
  }

  const reservationCandidates = db.raw.prepare(
    `SELECT * FROM fettler_model_reservations WHERE tenant_id = ?
       AND (run_id = ? OR (? IS NOT NULL AND job_id = ?))
       ORDER BY reserved_at, lease_generation, call_index, id`,
  ).all(tenantId, runId, run.job_id, run.job_id) as WardenModelReservationRow[];
  const reservationsBound = reservationCandidates.every((row) =>
    row.run_id === runId && run.job_id !== null && row.job_id === run.job_id);
  const modelReservations = reservationCandidates.length === 0
    ? notObserved("model_reservations_not_observed")
    : reservationsBound
      ? observed(freezeRows(reservationCandidates))
      : notObserved("model_reservation_binding_conflict");

  const routingCandidates = db.raw.prepare(
    `SELECT * FROM routing_ledger WHERE tenant_id = ?
       AND (run_id = ? OR (? IS NOT NULL AND job_id = ?))
       ORDER BY created_at, id`,
  ).all(tenantId, runId, run.job_id, run.job_id) as RoutingLedgerRow[];
  const routingBound = routingCandidates.every((row) =>
    row.run_id === runId && run.job_id !== null && row.job_id === run.job_id);
  const routingLedger = routingCandidates.length === 0
    ? notObserved("routing_ledger_not_observed")
    : routingBound
      ? observed(freezeRows(routingCandidates))
      : notObserved("routing_ledger_binding_conflict");

  const meter = getAgentRunMeter(db, tenantId, runId);
  const delivery = getWardenCandidateDeliveryByRun(db, tenantId, runId);
  const binding = approvalBinding(run);
  const snapshot = binding
    ? db.raw.prepare(
      `SELECT repository_id, resolved_sha, manifest_sha256 FROM repository_snapshots
       WHERE tenant_id = ? AND id = ? AND repository_id = ?`,
    ).get(tenantId, binding.snapshotId, binding.repositoryId) as
      | { repository_id: string; resolved_sha: string; manifest_sha256: string }
      | undefined
    : undefined;
  const snapshotBound = Boolean(snapshot && snapshot.resolved_sha === binding!.revision &&
    snapshot.manifest_sha256 === binding!.manifestSha256);
  const humanPrincipal = binding ? db.raw.prepare(
    `SELECT id, subject, audience FROM principals WHERE tenant_id = ? AND id = ? AND kind = 'human'
       AND created_at <= ? AND (expires_at IS NULL OR expires_at > ?)
       AND (revoked_at IS NULL OR revoked_at > ?)`,
  ).get(
    tenantId,
    binding.reviewerPrincipalId,
    binding.reviewedAt,
    binding.reviewedAt,
    binding.reviewedAt,
  ) as { id: string; subject: string; audience: string | null } | undefined : undefined;
  const membershipIssuer = humanPrincipal?.audience ?? "";
  const membershipSubjectPrefix = membershipIssuer ? `${membershipIssuer}|` : "";
  const membershipSubject = humanPrincipal?.subject.startsWith(membershipSubjectPrefix)
    ? humanPrincipal.subject.slice(membershipSubjectPrefix.length)
    : "";
  const membership = binding && membershipIssuer && membershipSubject
    ? db.raw.prepare(
      `SELECT tenant_id FROM tenant_memberships WHERE tenant_id = ? AND issuer = ? AND subject = ?
         AND status = 'active' AND created_at <= ?`,
    ).get(tenantId, membershipIssuer, membershipSubject, binding.reviewedAt)
    : undefined;
  const humanPrincipalBound = Boolean(binding && humanPrincipal && membership &&
    binding.authMethod === "oidc" && binding.membershipEvidenceId ===
      membershipEvidenceId(tenantId, membershipIssuer, membershipSubject));
  let candidateDelivery: DurableEvidence<FettlerCandidateDeliveryEvidence>;
  if (!delivery) {
    candidateDelivery = notObserved("candidate_delivery_not_observed");
  } else if (!auditIntegrity.ok) {
    candidateDelivery = observed(Object.freeze({
      delivery,
      auditEvents: Object.freeze([]),
      auditReason: "audit_chain_invalid",
    }));
  } else {
    const deliveryEvents = auditEvents.filter((event) => deliveryAuditMatches(event, delivery));
    const actionEvents = auditEvents.filter((event) => event.action === "agent.candidate.draft_delivered");
    candidateDelivery = observed(Object.freeze({
      delivery,
      auditEvents: freezeRows(deliveryEvents),
      auditReason: deliveryEvents.length > 0
        ? null
        : actionEvents.length > 0
          ? "delivery_audit_binding_unproven"
          : "delivery_audit_not_observed",
    }));
  }

  const cycleIds = delivery
    ? db.raw.prepare(
      "SELECT id FROM fettler_ci_cycles WHERE tenant_id = ? AND delivery_id = ? ORDER BY created_at, id",
    ).all(tenantId, delivery.id) as Array<{ id: string }>
    : [];
  const ciRows = cycleIds.map(({ id }) => {
      const cycle = getWardenCiCycle(db, tenantId, id)!;
      return Object.freeze({
        cycle,
        observations: listWardenCiObservations(db, tenantId, id),
      });
    });
  const ciBound = Boolean(delivery && ciRows.every(({ cycle }) =>
    cycle.deliveryId === delivery.id && cycle.repositoryId === delivery.repositoryId &&
    cycle.pullRequestNumber === delivery.draftPrNumber && cycle.baseBranch === delivery.baseBranch &&
    cycle.branchName === delivery.branchName && cycle.baseRevision === delivery.baseRevision &&
    cycle.currentHeadSha === delivery.commitSha));
  const ci = cycleIds.length === 0
    ? notObserved("ci_not_observed")
    : ciBound
      ? observed(Object.freeze(ciRows))
      : notObserved("ci_binding_conflict");

  const terminalOutcome = delivery?.outcome && delivery.outcomeAt
    ? observed(Object.freeze({
      source: "candidate_delivery" as const,
      outcome: delivery.outcome,
      observedAt: delivery.outcomeAt,
    }))
    : notObserved("terminal_outcome_not_observed");

  return Object.freeze({
    tenantId,
    runId,
    auditIntegrity,
    agentRun: observed(frozenRun),
    job: run.job_id === null
      ? notObserved("job_not_linked")
      : job
        ? observed(Object.freeze({ ...job }))
        : notObserved("job_not_found"),
    trajectory,
    modelReservations,
    routingLedger,
    runMeter: meter ? observed(meter) : notObserved("run_meter_not_observed"),
    approval: approvalEvidence(
      run,
      delivery,
      auditEvents,
      auditIntegrity.ok,
      snapshotBound,
      humanPrincipalBound,
    ),
    candidateDelivery,
    ci,
    terminalOutcome,
    cleanup: notObserved("scm_cleanup_not_durably_recorded"),
  });
}
