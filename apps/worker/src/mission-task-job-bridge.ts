/**
 * Live-path bridge from `jobs` / `agent_runs` onto MissionTask (D3) and from a
 * settled Fettler run onto execution-cost `mission_id` (MCU rollup).
 *
 * A job without a bound mission is a no-op — the Fettler → mission enrollment
 * gap stays visible rather than being papered over with a fabricated mission.
 * When a mission id is claimed on the payload but the row is missing, fail
 * closed. Usage-ledger hashes are untouched; attribution uses the existing
 * execution-cost `mission_id` column.
 */
import { createHash } from "node:crypto";
import {
  ensureMissionTaskForJob,
  getLatestActualExecutionCostForTaskBeforeAttempt,
  getMissionTask,
  getMission,
  insertPrincipal,
  listRepositorySnapshots,
  missionTaskIdForJob,
  openTaskHandoff,
  recordRoutingOutcomeExactlyOnce,
  recordExecutionCostFromRoutingLedger,
  resolveMissionForFettlerCampaign,
  resolveMissionForRegaugeCampaign,
  transitionMissionTask,
  verifyWardenModelReservationIntegrity,
  type ActualExecutionCostEntry,
  type AppDb,
  type Mission,
  type MissionTask,
  type MissionTaskRisk,
  type WardenModelReservationRow,
} from "@mendpoint/db";

export type BridgedJob = Readonly<{
  id: string;
  tenant_id: string;
  type: string;
  payload_json: string;
  status?: string;
  result_json?: string | null;
  attempts?: number;
  lease_generation?: number;
}>;

function payloadRecord(job: BridgedJob): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(job.payload_json);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function textField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseRisk(value: unknown): MissionTaskRisk {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") {
    return value;
  }
  return "medium";
}

function resumeTaskEvent(jobId: string, revision: number): { eventId: string; idempotencyKey: string } {
  const digest = createHash("sha256")
    .update(`mission-task:job:${jobId}:agent_working_from_resume:r${revision}`)
    .digest("hex")
    .slice(0, 32);
  return {
    eventId: `e-mtask-${digest}`,
    idempotencyKey: `mission-task-job:${jobId}:agent_working_from_resume:r${revision}`,
  };
}
function missionTaskAgentPrincipal(db: AppDb, tenantId: string, createdAt: string) {
  const id = `principal-mtask-agent-${createHash("sha256").update(tenantId).digest("hex").slice(0, 24)}`;
  return insertPrincipal(db, {
    id,
    tenantId,
    kind: "service",
    subject: "mission-task-agent",
    displayName: "Mission task agent",
    createdAt,
  });
}

/**
 * Resolve the mission a job is bound to, if any. `missionId` on the payload is
 * a claimed binding (missing row fails closed). A `campaignId` is only a hint:
 * resolve through the Fettler/ReGauge campaign FK and skip when nothing is
 * linked — that is the enrollment gap, not a fabricated mission.
 */
export function resolveBoundMissionForJob(db: AppDb, job: BridgedJob): Mission | undefined {
  const payload = payloadRecord(job);
  const missionId = textField(payload, "missionId");
  if (missionId) {
    const mission = getMission(db, job.tenant_id, missionId);
    if (!mission) throw new Error("mission_task_job_mission_not_found");
    return mission;
  }
  const campaignId = textField(payload, "campaignId")
    ?? textField(payload, "fettlerCampaignId")
    ?? textField(payload, "regaugeCampaignId");
  if (!campaignId) return undefined;
  return resolveMissionForFettlerCampaign(db, job.tenant_id, campaignId)
    ?? resolveMissionForRegaugeCampaign(db, job.tenant_id, campaignId);
}

/** Create-or-drive the MissionTask for a claimed job. No-op when unbound. */
export function bridgeClaimedJobToMissionTask(
  db: AppDb,
  job: BridgedJob,
  createdAt: string,
): MissionTask | undefined {
  const mission = resolveBoundMissionForJob(db, job);
  if (!mission) return undefined;
  const agent = missionTaskAgentPrincipal(db, job.tenant_id, createdAt);
  const payload = payloadRecord(job);
  const task = ensureMissionTaskForJob(db, {
    tenantId: job.tenant_id,
    jobId: job.id,
    missionId: mission.id,
    taskType: job.type,
    acceptanceCriteria: `Complete job ${job.id} (${job.type}) under mission ${mission.id}.`,
    risk: parseRisk(payload?.risk),
    actorPrincipalId: mission.ownerPrincipalId,
    assignedPrincipalId: agent.id,
    createdAt,
    correlationId: job.id,
  });
  if (task.status !== "agent_resume") return task;
  return transitionMissionTask(db, {
    tenantId: job.tenant_id,
    taskId: task.id,
    expectedRevision: task.revision,
    to: "agent_working",
    actorPrincipalId: agent.id,
    assignedPrincipalId: agent.id,
    ...resumeTaskEvent(job.id, task.revision),
    correlationId: job.id,
    createdAt,
  });
}

/**
 * Hand a successfully settled review-first job to a human without leaving its
 * durable MissionTask in agent_working. Call this in the same transaction as
 * job completion so a crash cannot commit only one side of the lifecycle.
 */
export function handoffCompletedJobToMissionReview(
  db: AppDb,
  job: BridgedJob,
  createdAt: string,
): MissionTask | undefined {
  const mission = resolveBoundMissionForJob(db, job);
  if (!mission) return undefined;
  const task = bridgeClaimedJobToMissionTask(db, job, createdAt)
    ?? getMissionTask(db, job.tenant_id, missionTaskIdForJob(job.id));
  if (!task) throw new Error("mission_task_job_review_task_missing");
  if (task.status === "human_review_required") return task;
  if (task.status !== "agent_working" || !task.assignedPrincipalId) {
    throw new Error("mission_task_job_review_transition_invalid");
  }
  const snapshot = mission.snapshotId && mission.repositoryId
    ? listRepositorySnapshots(db, job.tenant_id, mission.repositoryId)
      .find((row) => row.id === mission.snapshotId)
    : undefined;
  openTaskHandoff(db, {
    tenantId: job.tenant_id,
    missionId: mission.id,
    taskId: task.id,
    reason: "architecture_decision_required",
    question:
      `Should job ${job.id} (${job.type}) under mission ${mission.id}` +
      ` proceed after advisory verification passed?`,
    context:
      `Review-first job ${job.id} settled successfully. ` +
      `Human approval is required before treating verification as delivery.`,
    ownerPrincipalId: task.assignedPrincipalId,
    ...(snapshot ? { observedAgainst: { snapshotId: snapshot.id, resolvedSha: snapshot.resolved_sha } } : {}),
    correlationId: job.id,
    createdAt,
  });
  return getMissionTask(db, job.tenant_id, task.id);
}

/**
 * Attribute a terminal run's routing-ledger cost to its bound mission. No-op
 * when unbound. Callers persist this in the same transaction as the terminal
 * job state, so a transient accounting failure leaves the job under its
 * recoverable lease rather than committing an outcome that can never acquire
 * an immutable cost row.
 * Does not write the usage ledger.
 */
export function recordBoundMissionExecutionCost(
  db: AppDb,
  input: Readonly<{
    job: BridgedJob;
    routingRunId: string;
    routingEnvelopeId: string;
    createdAt: string;
    attemptNumber?: number;
    outcomeStatus?: "unresolved";
  }>,
): ActualExecutionCostEntry | undefined {
  const mission = resolveBoundMissionForJob(db, input.job);
  if (!mission) return undefined;
  const payload = payloadRecord(input.job);
  const taskId = missionTaskIdForJob(input.job.id);
  // lease_generation is monotonic across operator reopen; attempts is not.
  const leaseGeneration = Math.max(1, input.job.lease_generation ?? input.job.attempts ?? 1);
  const attemptNumber = input.attemptNumber ?? leaseGeneration;
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > leaseGeneration) {
    throw new Error("mission_execution_cost_attempt_invalid");
  }
  const executionId = `${input.job.id}:lease-${attemptNumber}:attempt-${attemptNumber}`;
  const prior = getLatestActualExecutionCostForTaskBeforeAttempt(db, {
    tenantId: input.job.tenant_id,
    taskId,
    attemptNumber,
  });
  return recordExecutionCostFromRoutingLedger(db, {
    tenantId: input.job.tenant_id,
    routingEvidence: {
      jobId: input.job.id,
      runId: input.routingRunId,
      envelopeIds: [input.routingEnvelopeId],
    },
    executionId,
    taskId,
    taskClass: input.job.type,
    route: mission.product,
    campaignId: mission.fettlerCampaignId ?? mission.regaugeCampaignId
      ?? textField(payload, "campaignId") ?? null,
    missionId: mission.id,
    actorPrincipalId: mission.ownerPrincipalId,
    createdAt: input.createdAt,
    attemptNumber,
    retryNumber: attemptNumber - 1,
    fallbackFromExecutionId: prior?.executionId ?? null,
    outcomeStatus: "unresolved",
  });
}

type PendingPaidRoutingRow = Readonly<{
  run_id: string;
  envelope_id: string;
  action: string;
  selected_executor_id: string | null;
  provider_id: string | null;
}>;

/**
 * Recover a paid prior Fettler attempt whose deferred routing outcome was lost
 * when the terminal job transaction rolled back. Settled model reservations are
 * the durable execution evidence: they are imported into one conservative
 * terminal routing row and one immutable cost entry without calling or settling
 * the provider again. Ambiguous or unauthenticated evidence fails closed.
 */
export function reconcilePriorPaidWardenAttempts(
  db: AppDb,
  input: Readonly<{ job: BridgedJob; observedAt: string }>,
): number {
  const currentGeneration = input.job.lease_generation ?? input.job.attempts ?? 1;
  if (!Number.isSafeInteger(currentGeneration) || currentGeneration < 1 ||
      !Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error("warden_paid_attempt_recovery_input_invalid");
  }
  const pending = db.raw.prepare(
    `SELECT run_id, envelope_id, action, selected_executor_id, provider_id
     FROM routing_ledger
     WHERE tenant_id = ? AND job_id = ? AND outcome IS NULL AND run_id IS NOT NULL
     ORDER BY created_at, id`,
  ).all(input.job.tenant_id, input.job.id) as PendingPaidRoutingRow[];
  const candidates = pending.map((route) => {
    const match = /^(.*):lease-([1-9][0-9]*)$/.exec(route.run_id);
    if (!match) return undefined;
    const leaseGeneration = Number(match[2]);
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration >= currentGeneration) return undefined;
    return { route, baseRunId: match[1]!, leaseGeneration };
  }).filter((value): value is NonNullable<typeof value> => value !== undefined)
    .sort((left, right) => left.leaseGeneration - right.leaseGeneration);
  const generations = new Set<number>();
  for (const candidate of candidates) {
    if (generations.has(candidate.leaseGeneration)) {
      throw new Error("warden_paid_attempt_routing_ambiguous");
    }
    generations.add(candidate.leaseGeneration);
  }
  let reconciled = 0;
  for (const candidate of candidates) {
    const reservations = db.raw.prepare(
      `SELECT * FROM fettler_model_reservations
       WHERE tenant_id = ? AND job_id = ? AND lease_generation = ?
       ORDER BY call_index, id`,
    ).all(
      input.job.tenant_id,
      input.job.id,
      candidate.leaseGeneration,
    ) as WardenModelReservationRow[];
    if (reservations.length === 0) continue;
    if (
      candidate.route.action !== "route" ||
      !candidate.route.selected_executor_id ||
      !candidate.route.provider_id ||
      reservations.some((reservation) => {
        const integrity = verifyWardenModelReservationIntegrity(reservation);
        return reservation.run_id !== candidate.baseRunId ||
          reservation.provider !== candidate.route.provider_id ||
          reservation.status === "active" ||
          !integrity.ok ||
          integrity.settlementDigestVersion !== 2 ||
          !Number.isSafeInteger(reservation.charged_input_tokens) ||
          reservation.charged_input_tokens! < 0 ||
          !Number.isSafeInteger(reservation.charged_output_tokens) ||
          reservation.charged_output_tokens! < 0 ||
          !Number.isSafeInteger(reservation.charged_total_tokens) ||
          reservation.charged_total_tokens !==
            reservation.charged_input_tokens! + reservation.charged_output_tokens! ||
          typeof reservation.charged_cost_usd !== "number" ||
          !Number.isFinite(reservation.charged_cost_usd) ||
          reservation.charged_cost_usd < 0 ||
          !reservation.settled_at ||
          !Number.isFinite(Date.parse(reservation.reserved_at)) ||
          !Number.isFinite(Date.parse(reservation.settled_at));
      })
    ) {
      throw new Error("warden_paid_attempt_evidence_invalid");
    }
    const sumInteger = (field: "charged_input_tokens" | "charged_output_tokens" | "charged_total_tokens") => {
      const value = reservations.reduce((sum, reservation) => sum + reservation[field]!, 0);
      if (!Number.isSafeInteger(value)) throw new Error("warden_paid_attempt_evidence_invalid");
      return value;
    };
    const inputTokens = sumInteger("charged_input_tokens");
    const outputTokens = sumInteger("charged_output_tokens");
    const totalTokens = sumInteger("charged_total_tokens");
    const costUsd = reservations.reduce(
      (sum, reservation) => sum + reservation.charged_cost_usd!,
      0,
    );
    if (!Number.isFinite(costUsd)) throw new Error("warden_paid_attempt_evidence_invalid");
    // A reservation settled without a reported cost was never observed: its
    // charged_* columns hold the reservation ceiling, written precisely BECAUSE
    // nothing came back from the provider (settleUnknownReservation, and any
    // settlement that reported no usage). The ceiling is what we charge, never
    // what we measured, so the recovered routing row carries a null cost and
    // null tokens. That resolves `modelCostMeasured` to false downstream and
    // stamps the immutable cost entry's provenance `:cost_unmeasured` instead of
    // attesting a routing-ledger measurement for a call nobody ever saw.
    const costMeasured = reservations.every(
      (reservation) => reservation.reported_cost_usd !== null,
    );
    const evidence = reservations.map((reservation) => ({
      reservationId: reservation.id,
      reservationDigest: reservation.reservation_digest,
      settlementDigest: reservation.settlement_digest,
      status: reservation.status,
    }));
    const ownsTransaction = !db.raw.isTransaction;
    if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
    try {
      recordRoutingOutcomeExactlyOnce(db, {
        tenantId: input.job.tenant_id,
        jobId: input.job.id,
        envelopeId: candidate.route.envelope_id,
        idempotencyKey: `warden-paid-attempt-recovery:${candidate.route.envelope_id}`,
        idempotencyPayload: {
          schemaVersion: "mendpoint.warden-paid-attempt-recovery.v1",
          runId: candidate.route.run_id,
          evidence,
        },
        executorId: candidate.route.selected_executor_id,
        providerId: candidate.route.provider_id,
        breakerFeedback: "none",
        action: "human_handoff",
        outcome: "failed",
        errorCode: "warden_routing_outcome_recovered_from_model_reservations",
        inputTokens: costMeasured ? inputTokens : null,
        outputTokens: costMeasured ? outputTokens : null,
        totalTokens: costMeasured ? totalTokens : null,
        costUsd: costMeasured ? costUsd : null,
        startedAt: reservations.map((reservation) => reservation.reserved_at).sort()[0]!,
        completedAt: reservations.map((reservation) => reservation.settled_at!).sort().at(-1)!,
        observedAt: input.observedAt,
      });
      recordBoundMissionExecutionCost(db, {
        job: input.job,
        routingRunId: candidate.route.run_id,
        routingEnvelopeId: candidate.route.envelope_id,
        createdAt: input.observedAt,
        attemptNumber: candidate.leaseGeneration,
      });
      if (ownsTransaction) db.raw.exec("COMMIT");
      reconciled++;
    } catch (error) {
      if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
      throw error;
    }
  }
  return reconciled;
}
