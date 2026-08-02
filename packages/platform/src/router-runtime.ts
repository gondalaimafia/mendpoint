import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  ExecutorRegistry,
  routeTask,
  type ExecutorAvailability,
  type ExecutorDescriptor,
  type HumanHandoffReason,
  type RouterPolicySnapshot,
  type RouterTaskSpec,
  type RoutingDecisionRecord,
} from "./router.js";

export type RouterRetryPolicy = Readonly<{
  maxAttempts: number;
  sameExecutorRetries: number;
  fallbackEnabled: boolean;
  retryableErrorCodes: readonly string[];
  fallbackErrorCodes: readonly string[];
  retryBackoffMs: readonly number[];
}>;

export type PersistedRouterTaskSpec = Readonly<
  Omit<RouterTaskSpec, "goal"> & { goalDigest: string }
>;

export type RouterVerificationEvidence = Readonly<{
  verdict: "passed" | "failed" | "unknown";
  evidenceArtifactIds: readonly string[];
  verifierId: string;
  verifierVersion?: string;
}>;

export type RouterActualOutcomeInput = Readonly<{
  idempotencyKey: string;
  executorId: string;
  providerId: string;
  outcome: "succeeded" | "failed" | "cancelled";
  startedAt: string;
  completedAt: string;
  actualLatencyMs: number;
  /** Null means the metering source has not supplied authoritative cost. */
  actualCostUsd: number | null;
  actualQualityScore?: number;
  errorCode?: string;
  verification: RouterVerificationEvidence;
}>;

export type RouterDispatch = Readonly<{
  executorId: string;
  providerId: string;
  executionRegion: string;
  expectedQualityScore: number;
  expectedLatencyMs: number;
  expectedCostUsd: number;
  attempt: number;
  kind: "primary" | "retry" | "fallback";
  fallbackFromExecutorId?: string;
  notBefore?: string;
}>;

type SerializableRoute = Omit<RouterDispatch, "attempt" | "kind" | "fallbackFromExecutorId">;

export type RouterPreparedEnvelope = Readonly<{
  schemaVersion: 1;
  envelopeId: string;
  createdAt: string;
  task: PersistedRouterTaskSpec;
  policy: RouterPolicySnapshot;
  executorSnapshot: readonly ExecutorDescriptor[];
  availabilitySnapshot: readonly Readonly<{
    executorId: string;
    providerId: string;
    allowed: boolean;
  }>[];
  constraints: Readonly<{
    classification: RouterTaskSpec["privacy"]["classification"];
    externalProcessingAllowed: boolean;
    requiredRegion?: string;
    allowedExecutionRegions: readonly string[];
    maximumBudgetUsd: number;
    maximumLatencyMs: number;
    minimumQualityScore: number;
    taskRisk: RouterTaskSpec["risk"];
    maximumAutonomousRisk: RouterPolicySnapshot["risk"]["maximumAutonomousRisk"];
  }>;
  retryPolicy: RouterRetryPolicy;
  decision: RoutingDecisionRecord;
  action: "execute" | "human_handoff";
  selectedExecutorId: string | null;
  eligibleExecutors: readonly SerializableRoute[];
  excludedExecutors: RoutingDecisionRecord["evaluations"];
  primary?: SerializableRoute;
  fallbacks: readonly SerializableRoute[];
  rationale: readonly string[];
  estimate: Readonly<{
    selectedCostUsd: number | null;
    selectedLatencyMs: number | null;
    maximumAuthorizedCostUsd: number;
  }>;
  handoffReason?: HumanHandoffReason;
}>;

export type RouterAttemptEvidence = Readonly<{
  dispatch: RouterDispatch;
  idempotencyKey: string;
  outcome: RouterActualOutcomeInput["outcome"];
  startedAt: string;
  completedAt: string;
  actualLatencyMs: number;
  actualCostUsd: number | null;
  actualQualityScore?: number;
  errorCode?: string;
  verification: RouterVerificationEvidence;
}>;

export type RouterFinalOutcome = Readonly<{
  outcome: "succeeded" | "failed" | "cancelled" | "human_handoff";
  completedAt: string;
  reason?: string;
  totalActualCostUsd: number | null;
  attempts: number;
}>;

export type RouterEvidenceEnvelope = Readonly<{
  prepared: RouterPreparedEnvelope;
  dispatches: readonly RouterDispatch[];
  attempts: readonly RouterAttemptEvidence[];
  finalOutcome?: RouterFinalOutcome;
  evidenceHead: string;
}>;

export type RouterRuntimeDisposition = Readonly<{
  envelopeId: string;
  action: "execute" | "retry" | "fallback" | "completed" | "human_handoff";
  selectedExecutorId: string | null;
  dispatch?: RouterDispatch;
  reason?: string;
  evidence: RouterEvidenceEnvelope;
}>;

export type RouterEvidenceEvent = Readonly<{
  eventId: string;
  envelopeId: string;
  sequence: number;
  previousEventId: string | null;
  recordedAt: string;
  type: "prepared" | "dispatch" | "attempt" | "final";
  data: unknown;
}>;

export interface RouterEvidenceStore {
  append(event: RouterEvidenceEvent): void;
  read(envelopeId: string): readonly RouterEvidenceEvent[];
}

export class InMemoryRouterEvidenceStore implements RouterEvidenceStore {
  readonly #events = new Map<string, RouterEvidenceEvent[]>();

  append(event: RouterEvidenceEvent): void {
    const events = this.#events.get(event.envelopeId) ?? [];
    validateAppend(events, event);
    events.push(structuredClone(event));
    this.#events.set(event.envelopeId, events);
  }

  read(envelopeId: string): readonly RouterEvidenceEvent[] {
    return Object.freeze(
      (this.#events.get(envelopeId) ?? []).map((event) =>
        Object.freeze(structuredClone(event)),
      ),
    );
  }
}

/** Append-only JSONL store. Corrupt or broken hash chains fail closed on read. */
export class JsonlRouterEvidenceStore implements RouterEvidenceStore {
  constructor(readonly path: string) {
    if (!path.trim()) throw new Error("Router evidence path is required");
  }

  append(event: RouterEvidenceEvent): void {
    const events = this.#readAll().filter(
      (candidate) => candidate.envelopeId === event.envelopeId,
    );
    validateAppend(events, event);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }

  read(envelopeId: string): readonly RouterEvidenceEvent[] {
    const events = this.#readAll().filter(
      (event) => event.envelopeId === envelopeId,
    );
    validateChain(events);
    return Object.freeze(events.map((event) => Object.freeze(event)));
  }

  #readAll(): RouterEvidenceEvent[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.map((line, index) => {
      try {
        return JSON.parse(line) as RouterEvidenceEvent;
      } catch {
        throw new Error(`Router evidence JSON is invalid at line ${index + 1}`);
      }
    });
  }
}

export type PrepareRouterRuntimeInput = Readonly<{
  task: RouterTaskSpec;
  policy: RouterPolicySnapshot;
  registry: ExecutorRegistry;
  remainingBudgetUsd: number;
  decidedAt: Date;
  retryPolicy?: Partial<RouterRetryPolicy>;
}>;

export class PolicyRouterRuntime {
  constructor(
    readonly store: RouterEvidenceStore,
    readonly circuitBreaker: ExecutorAvailability,
  ) {}

  prepare(input: PrepareRouterRuntimeInput): RouterRuntimeDisposition {
    validIso(input.policy.capturedAt, "Router policy capture time");
    const executorSnapshot = input.registry.list();
    const availabilitySnapshot = executorSnapshot.map((executor) => ({
      executorId: executor.executorId,
      providerId: executor.providerId,
      allowed: this.circuitBreaker.allows(
        executor.executorId,
        executor.providerId,
        input.decidedAt,
      ),
    }));
    const availability = new SnapshotAvailability(availabilitySnapshot);
    const outcome = routeTask({
      ...input,
      circuitBreaker: availability,
    });
    const retryPolicy = normalizeRetryPolicy(input.retryPolicy);
    const prepared = buildPreparedEnvelope({
      input,
      executorSnapshot,
      availabilitySnapshot,
      retryPolicy,
      outcome,
    });
    const existing = this.store.read(prepared.envelopeId);
    if (existing.length > 0) {
      const evidence = aggregateEvidence(existing);
      if (canonicalJson(evidence.prepared) !== canonicalJson(prepared)) {
        throw new Error("Router envelope id collision");
      }
      return initialDisposition(evidence);
    }
    this.#append(prepared.envelopeId, prepared.createdAt, "prepared", prepared);
    if (prepared.action === "human_handoff") {
      this.#append(prepared.envelopeId, prepared.createdAt, "final", {
        outcome: "human_handoff",
        completedAt: prepared.createdAt,
        reason: prepared.handoffReason,
        totalActualCostUsd: 0,
        attempts: 0,
      } satisfies RouterFinalOutcome);
      return initialDisposition(this.getEvidence(prepared.envelopeId));
    }
    const dispatch = toDispatch(prepared.primary!, 1, "primary");
    this.#append(prepared.envelopeId, prepared.createdAt, "dispatch", dispatch);
    return Object.freeze({
      envelopeId: prepared.envelopeId,
      action: "execute",
      selectedExecutorId: dispatch.executorId,
      dispatch,
      evidence: this.getEvidence(prepared.envelopeId),
    });
  }

  recordOutcome(
    envelopeId: string,
    input: RouterActualOutcomeInput,
  ): RouterRuntimeDisposition {
    const current = this.getEvidence(envelopeId);
    const duplicate = current.attempts.find(
      (attempt) => attempt.idempotencyKey === input.idempotencyKey,
    );
    if (duplicate) {
      const normalizedInput = {
        ...input,
        verification: freezeVerification(input.verification),
      };
      if (
        canonicalJson(stripDispatch(duplicate)) !== canonicalJson(normalizedInput)
      ) {
        throw new Error("Router outcome idempotency collision");
      }
      return dispositionFromEvidence(current);
    }
    if (current.finalOutcome) throw new Error("Router envelope is already final");
    if (current.prepared.action !== "execute") {
      throw new Error("Human handoff envelopes cannot record execution");
    }
    validateActualOutcome(input);
    const dispatch = current.dispatches.at(-1);
    if (!dispatch || current.attempts.length >= current.dispatches.length) {
      throw new Error("Router outcome has no pending dispatch");
    }
    if (
      dispatch.executorId !== input.executorId ||
      dispatch.providerId !== input.providerId
    ) {
      throw new Error("Router outcome executor does not match the pending dispatch");
    }
    if (
      input.outcome === "succeeded" &&
      input.verification.verdict !== "passed"
    ) {
      throw new Error("Successful router outcomes require passed verification");
    }
    if (Date.parse(input.startedAt) < Date.parse(current.prepared.createdAt)) {
      throw new Error("Router outcome starts before its routing decision");
    }
    if (
      dispatch.notBefore &&
      Date.parse(input.startedAt) < Date.parse(dispatch.notBefore)
    ) {
      throw new Error("Router retry started before its policy backoff elapsed");
    }
    const attempt: RouterAttemptEvidence = Object.freeze({
      dispatch,
      ...input,
      verification: freezeVerification(input.verification),
    });
    this.#append(envelopeId, input.completedAt, "attempt", attempt);
    let evidence = this.getEvidence(envelopeId);

    if (input.outcome === "succeeded") {
      return this.#finalize(envelopeId, input.completedAt, "succeeded");
    }
    if (input.outcome === "cancelled") {
      return this.#finalize(envelopeId, input.completedAt, "cancelled");
    }

    const policy = evidence.prepared.retryPolicy;
    if (evidence.attempts.length >= policy.maxAttempts) {
      return this.#handoff(envelopeId, input.completedAt, "retry_attempts_exhausted");
    }
    if (input.actualCostUsd === null) {
      return this.#handoff(envelopeId, input.completedAt, "actual_cost_unavailable");
    }
    const totalCost = sumActualCost(evidence.attempts);
    if (totalCost === null) {
      return this.#handoff(envelopeId, input.completedAt, "actual_cost_unavailable");
    }
    const remaining = evidence.prepared.estimate.maximumAuthorizedCostUsd - totalCost;
    const retryable =
      input.errorCode !== undefined &&
      policy.retryableErrorCodes.includes(input.errorCode);
    const sameExecutorAttempts = evidence.attempts.filter(
      (attempt) => attempt.dispatch.executorId === dispatch.executorId,
    ).length;
    if (
      retryable &&
      sameExecutorAttempts <= policy.sameExecutorRetries &&
      dispatch.expectedCostUsd <= remaining &&
      this.circuitBreaker.allows(
        dispatch.executorId,
        dispatch.providerId,
        new Date(input.completedAt),
      )
    ) {
      const next = Object.freeze({
        ...dispatch,
        attempt: evidence.attempts.length + 1,
        kind: "retry" as const,
        notBefore: new Date(
          Date.parse(input.completedAt) +
            policy.retryBackoffMs[Math.min(
              sameExecutorAttempts - 1,
              policy.retryBackoffMs.length - 1,
            )],
        ).toISOString(),
      });
      this.#append(envelopeId, input.completedAt, "dispatch", next);
      evidence = this.getEvidence(envelopeId);
      return Object.freeze({
        envelopeId,
        action: "retry",
        selectedExecutorId: next.executorId,
        dispatch: next,
        evidence,
      });
    }

    if (
      policy.fallbackEnabled &&
      input.errorCode !== undefined &&
      policy.fallbackErrorCodes.includes(input.errorCode)
    ) {
      const attempted = new Set(
        evidence.dispatches.map((candidate) => candidate.executorId),
      );
      const fallback = evidence.prepared.fallbacks.find(
        (candidate) =>
          !attempted.has(candidate.executorId) &&
          candidate.expectedCostUsd <= remaining &&
          this.circuitBreaker.allows(
            candidate.executorId,
            candidate.providerId,
            new Date(input.completedAt),
          ),
      );
      if (fallback) {
        const next = toDispatch(
          fallback,
          evidence.attempts.length + 1,
          "fallback",
          dispatch.executorId,
        );
        this.#append(envelopeId, input.completedAt, "dispatch", next);
        return Object.freeze({
          envelopeId,
          action: "fallback",
          selectedExecutorId: next.executorId,
          dispatch: next,
          evidence: this.getEvidence(envelopeId),
        });
      }
    }
    return this.#handoff(envelopeId, input.completedAt, "no_policy_compliant_retry");
  }

  getEvidence(envelopeId: string): RouterEvidenceEnvelope {
    const events = this.store.read(envelopeId);
    if (events.length === 0) throw new Error("Router evidence envelope was not found");
    return aggregateEvidence(events);
  }

  replay(envelopeId: string): Readonly<{
    matches: boolean;
    expectedDecisionId: string;
    replayedDecisionId: string;
    expectedEnvelopeId: string;
    replayedEnvelopeId: string;
  }> {
    const expected = this.getEvidence(envelopeId).prepared;
    const registry = new ExecutorRegistry();
    for (const executor of expected.executorSnapshot) registry.register(executor);
    const replayed = routeTask({
      task: restoreTask(expected.task),
      policy: expected.policy,
      registry,
      circuitBreaker: new SnapshotAvailability(expected.availabilitySnapshot),
      remainingBudgetUsd: expected.decision.remainingBudgetUsd,
      decidedAt: new Date(expected.createdAt),
    });
    const replayedEnvelopeId = preparedEnvelopeId({
      task: expected.task,
      policy: expected.policy,
      executorSnapshot: expected.executorSnapshot,
      availabilitySnapshot: expected.availabilitySnapshot,
      remainingBudgetUsd: expected.decision.remainingBudgetUsd,
      decidedAt: expected.createdAt,
      retryPolicy: expected.retryPolicy,
    });
    return Object.freeze({
      matches:
        replayed.decision.decisionId === expected.decision.decisionId &&
        replayedEnvelopeId === expected.envelopeId,
      expectedDecisionId: expected.decision.decisionId,
      replayedDecisionId: replayed.decision.decisionId,
      expectedEnvelopeId: expected.envelopeId,
      replayedEnvelopeId,
    });
  }

  #finalize(
    envelopeId: string,
    completedAt: string,
    outcome: RouterFinalOutcome["outcome"],
    reason?: string,
  ): RouterRuntimeDisposition {
    const evidence = this.getEvidence(envelopeId);
    const final: RouterFinalOutcome = Object.freeze({
      outcome,
      completedAt,
      reason,
      totalActualCostUsd: sumActualCost(evidence.attempts),
      attempts: evidence.attempts.length,
    });
    this.#append(envelopeId, completedAt, "final", final);
    const complete = this.getEvidence(envelopeId);
    return Object.freeze({
      envelopeId,
      action: outcome === "succeeded" ? "completed" : "human_handoff",
      selectedExecutorId: null,
      reason,
      evidence: complete,
    });
  }

  #handoff(
    envelopeId: string,
    completedAt: string,
    reason: string,
  ): RouterRuntimeDisposition {
    return this.#finalize(envelopeId, completedAt, "human_handoff", reason);
  }

  #append(
    envelopeId: string,
    recordedAt: string,
    type: RouterEvidenceEvent["type"],
    data: unknown,
  ): void {
    validIso(recordedAt, "Router evidence time");
    const events = this.store.read(envelopeId);
    const previous = events.at(-1);
    const body = {
      envelopeId,
      sequence: events.length + 1,
      previousEventId: previous?.eventId ?? null,
      recordedAt,
      type,
      data,
    };
    this.store.append(Object.freeze({
      eventId: `route_event_${fingerprint(body)}`,
      ...body,
    }));
  }
}

class SnapshotAvailability implements ExecutorAvailability {
  readonly #allowed: Map<string, boolean>;

  constructor(
    snapshot: readonly Readonly<{
      executorId: string;
      providerId: string;
      allowed: boolean;
    }>[],
  ) {
    this.#allowed = new Map(
      snapshot.map((item) => [availabilityKey(item.executorId, item.providerId), item.allowed]),
    );
  }

  allows(executorId: string, providerId: string): boolean {
    return this.#allowed.get(availabilityKey(executorId, providerId)) === true;
  }
}

function buildPreparedEnvelope(input: {
  input: PrepareRouterRuntimeInput;
  executorSnapshot: readonly ExecutorDescriptor[];
  availabilitySnapshot: readonly Readonly<{
    executorId: string;
    providerId: string;
    allowed: boolean;
  }>[];
  retryPolicy: RouterRetryPolicy;
  outcome: ReturnType<typeof routeTask>;
}): RouterPreparedEnvelope {
  const { task, policy, remainingBudgetUsd, decidedAt } = input.input;
  const effectiveBudget = Math.min(
    task.budget.maximumUsd,
    policy.budget.maximumUsd,
    remainingBudgetUsd,
  );
  const eligibleExecutors = input.outcome.decision.evaluations
    .filter((item) => item.eligible && item.executionRegion)
    .sort(compareEvaluation)
    .map(serializableRoute);
  const primary = input.outcome.action === "execute"
    ? serializablePlanRoute(input.outcome.plan.primary)
    : undefined;
  const fallbacks = input.outcome.action === "execute"
    ? input.outcome.plan.fallbacks.map(serializablePlanRoute)
    : [];
  const envelopeId = preparedEnvelopeId({
    task: persistTask(task),
    policy,
    executorSnapshot: input.executorSnapshot,
    availabilitySnapshot: input.availabilitySnapshot,
    remainingBudgetUsd,
    decidedAt: decidedAt.toISOString(),
    retryPolicy: input.retryPolicy,
  });
  const selected = input.outcome.action === "execute" ? primary! : null;
  return Object.freeze({
    schemaVersion: 1,
    envelopeId,
    createdAt: decidedAt.toISOString(),
    task: persistTask(task),
    policy: structuredClone(policy),
    executorSnapshot: Object.freeze(input.executorSnapshot.map((item) => structuredClone(item))),
    availabilitySnapshot: Object.freeze(input.availabilitySnapshot.map((item) => Object.freeze({ ...item }))),
    constraints: Object.freeze({
      classification: task.privacy.classification,
      externalProcessingAllowed: policy.privacy.externalProcessingAllowed,
      requiredRegion: task.privacy.requiredRegion,
      allowedExecutionRegions: Object.freeze([...policy.region.allowedExecutionRegions].sort()),
      maximumBudgetUsd: effectiveBudget,
      maximumLatencyMs: Math.min(task.latency.maximumMs, policy.latency.maximumMs),
      minimumQualityScore: Math.max(task.quality.minimumScore, policy.quality.minimumScore),
      taskRisk: task.risk,
      maximumAutonomousRisk: policy.risk.maximumAutonomousRisk,
    }),
    retryPolicy: input.retryPolicy,
    decision: structuredClone(input.outcome.decision),
    action: input.outcome.action,
    selectedExecutorId: selected?.executorId ?? null,
    eligibleExecutors: Object.freeze(eligibleExecutors),
    excludedExecutors: Object.freeze(
      input.outcome.decision.evaluations.filter((item) => !item.eligible).map((item) => structuredClone(item)),
    ),
    primary,
    fallbacks: Object.freeze(fallbacks),
    rationale: Object.freeze(rationale(input.outcome.decision, primary)),
    estimate: Object.freeze({
      selectedCostUsd: selected?.expectedCostUsd ?? null,
      selectedLatencyMs: selected?.expectedLatencyMs ?? null,
      maximumAuthorizedCostUsd: effectiveBudget,
    }),
    handoffReason: input.outcome.action === "human_handoff"
      ? input.outcome.handoff.reason
      : undefined,
  });
}

function initialDisposition(evidence: RouterEvidenceEnvelope): RouterRuntimeDisposition {
  if (evidence.finalOutcome) return dispositionFromEvidence(evidence);
  const dispatch = evidence.dispatches.at(-1);
  return Object.freeze({
    envelopeId: evidence.prepared.envelopeId,
    action: evidence.prepared.action,
    selectedExecutorId: dispatch?.executorId ?? evidence.prepared.selectedExecutorId,
    dispatch,
    reason: evidence.prepared.handoffReason,
    evidence,
  });
}

function dispositionFromEvidence(evidence: RouterEvidenceEnvelope): RouterRuntimeDisposition {
  if (evidence.finalOutcome) {
    return Object.freeze({
      envelopeId: evidence.prepared.envelopeId,
      action: evidence.finalOutcome.outcome === "succeeded" ? "completed" : "human_handoff",
      selectedExecutorId: null,
      reason: evidence.finalOutcome.reason,
      evidence,
    });
  }
  const dispatch = evidence.dispatches.at(-1);
  return Object.freeze({
    envelopeId: evidence.prepared.envelopeId,
    action: dispatch?.kind === "primary" ? "execute" : dispatch?.kind ?? "execute",
    selectedExecutorId: dispatch?.executorId ?? null,
    dispatch,
    evidence,
  });
}

function aggregateEvidence(events: readonly RouterEvidenceEvent[]): RouterEvidenceEnvelope {
  validateChain(events);
  const prepared = events.find((event) => event.type === "prepared")?.data as
    | RouterPreparedEnvelope
    | undefined;
  if (!prepared) throw new Error("Router evidence is missing its prepared record");
  const dispatches = events
    .filter((event) => event.type === "dispatch")
    .map((event) => event.data as RouterDispatch);
  const attempts = events
    .filter((event) => event.type === "attempt")
    .map((event) => event.data as RouterAttemptEvidence);
  const finalEvents = events.filter((event) => event.type === "final");
  if (finalEvents.length > 1) throw new Error("Router evidence has multiple final records");
  return Object.freeze({
    prepared: Object.freeze(structuredClone(prepared)),
    dispatches: Object.freeze(dispatches.map((item) => Object.freeze(structuredClone(item)))),
    attempts: Object.freeze(attempts.map((item) => Object.freeze(structuredClone(item)))),
    finalOutcome: finalEvents[0]?.data as RouterFinalOutcome | undefined,
    evidenceHead: events.at(-1)!.eventId,
  });
}

function validateAppend(
  events: readonly RouterEvidenceEvent[],
  event: RouterEvidenceEvent,
): void {
  validateChain(events);
  const previous = events.at(-1);
  if (event.sequence !== events.length + 1) throw new Error("Router evidence sequence is invalid");
  if (event.previousEventId !== (previous?.eventId ?? null)) {
    throw new Error("Router evidence previous hash is invalid");
  }
  const { eventId: _eventId, ...body } = event;
  if (event.eventId !== `route_event_${fingerprint(body)}`) {
    throw new Error("Router evidence event hash is invalid");
  }
  if (events.some((candidate) => candidate.eventId === event.eventId)) {
    throw new Error("Router evidence event is duplicated");
  }
}

function validateChain(events: readonly RouterEvidenceEvent[]): void {
  let previous: string | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.sequence !== index + 1 || event.previousEventId !== previous) {
      throw new Error("Router evidence hash chain is invalid");
    }
    const { eventId: _eventId, ...body } = event;
    if (event.eventId !== `route_event_${fingerprint(body)}`) {
      throw new Error("Router evidence event hash is invalid");
    }
    previous = event.eventId;
  }
}

function normalizeRetryPolicy(
  input: Partial<RouterRetryPolicy> | undefined,
): RouterRetryPolicy {
  const maxAttempts = input?.maxAttempts ?? 3;
  const sameExecutorRetries = input?.sameExecutorRetries ?? 1;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("Router max attempts is invalid");
  }
  if (
    !Number.isInteger(sameExecutorRetries) ||
    sameExecutorRetries < 0 ||
    sameExecutorRetries >= maxAttempts
  ) {
    throw new Error("Router same executor retry count is invalid");
  }
  const retryableErrorCodes = Object.freeze(
    [...new Set(input?.retryableErrorCodes ?? ["rate_limited", "timeout", "provider_unavailable"])]
      .map((value) => value.trim())
      .filter(Boolean)
      .sort(),
  );
  const fallbackErrorCodes = Object.freeze(
    [...new Set(input?.fallbackErrorCodes ?? ["timeout", "provider_unavailable"])]
      .map((value) => value.trim())
      .filter(Boolean)
      .sort(),
  );
  const retryBackoffMs = Object.freeze([
    ...(input?.retryBackoffMs ?? [1_000, 5_000]),
  ]);
  if (
    retryBackoffMs.length < sameExecutorRetries ||
    retryBackoffMs.some(
      (value) => !Number.isFinite(value) || value < 0 || value > 300_000,
    )
  ) {
    throw new Error("Router retry backoff is invalid");
  }
  return Object.freeze({
    maxAttempts,
    sameExecutorRetries,
    fallbackEnabled: input?.fallbackEnabled ?? true,
    retryableErrorCodes,
    fallbackErrorCodes,
    retryBackoffMs,
  });
}

function validateActualOutcome(input: RouterActualOutcomeInput): void {
  if (!input.idempotencyKey.trim() || !input.executorId.trim() || !input.providerId.trim()) {
    throw new Error("Router outcome identity is required");
  }
  const started = validIso(input.startedAt, "Router outcome start");
  const completed = validIso(input.completedAt, "Router outcome completion");
  if (completed < started) throw new Error("Router outcome completion precedes its start");
  if (!Number.isFinite(input.actualLatencyMs) || input.actualLatencyMs < 0) {
    throw new Error("Router actual latency is invalid");
  }
  if (
    input.actualCostUsd !== null &&
    (!Number.isFinite(input.actualCostUsd) || input.actualCostUsd < 0)
  ) {
    throw new Error("Router actual cost is invalid");
  }
  if (
    input.actualQualityScore !== undefined &&
    (!Number.isFinite(input.actualQualityScore) ||
      input.actualQualityScore < 0 ||
      input.actualQualityScore > 1)
  ) {
    throw new Error("Router actual quality is invalid");
  }
  if (!input.verification.verifierId.trim()) {
    throw new Error("Router verifier identity is required");
  }
  if (
    input.verification.evidenceArtifactIds.some((value) => !value.trim()) ||
    new Set(input.verification.evidenceArtifactIds).size !==
      input.verification.evidenceArtifactIds.length
  ) {
    throw new Error("Router verification evidence is invalid");
  }
}

function freezeVerification(
  value: RouterVerificationEvidence,
): RouterVerificationEvidence {
  return Object.freeze({
    ...value,
    evidenceArtifactIds: Object.freeze([...value.evidenceArtifactIds].sort()),
  });
}

function toDispatch(
  route: SerializableRoute,
  attempt: number,
  kind: RouterDispatch["kind"],
  fallbackFromExecutorId?: string,
): RouterDispatch {
  return Object.freeze({ ...route, attempt, kind, fallbackFromExecutorId });
}

function serializableRoute(
  evaluation: RoutingDecisionRecord["evaluations"][number],
): SerializableRoute {
  return Object.freeze({
    executorId: evaluation.executorId,
    providerId: evaluation.providerId,
    executionRegion: evaluation.executionRegion!,
    expectedQualityScore: evaluation.expectedQualityScore,
    expectedLatencyMs: evaluation.expectedLatencyMs,
    expectedCostUsd: evaluation.expectedCostUsd,
  });
}

function serializablePlanRoute(route: {
  executorId: string;
  providerId: string;
  executionRegion: string;
  expectedQualityScore: number;
  expectedLatencyMs: number;
  expectedCostUsd: number;
}): SerializableRoute {
  return Object.freeze({
    executorId: route.executorId,
    providerId: route.providerId,
    executionRegion: route.executionRegion,
    expectedQualityScore: route.expectedQualityScore,
    expectedLatencyMs: route.expectedLatencyMs,
    expectedCostUsd: route.expectedCostUsd,
  });
}

function compareEvaluation(
  a: RoutingDecisionRecord["evaluations"][number],
  b: RoutingDecisionRecord["evaluations"][number],
): number {
  return (
    b.expectedQualityScore - a.expectedQualityScore ||
    a.expectedCostUsd - b.expectedCostUsd ||
    a.expectedLatencyMs - b.expectedLatencyMs ||
    a.executorId.localeCompare(b.executorId)
  );
}

function rationale(
  decision: RoutingDecisionRecord,
  selected: SerializableRoute | undefined,
): string[] {
  if (!selected) {
    return [
      `Routing stopped with ${decision.handoffReason ?? "policy_handoff"}`,
      `${decision.evaluations.filter((item) => !item.eligible).length} executors were excluded by policy`,
    ];
  }
  return [
    `Selected ${selected.executorId} from ${decision.evaluations.filter((item) => item.eligible).length} eligible executors`,
    "Eligible executors are ordered by quality, cost, latency, then stable executor identity",
    `The selected route is bound to policy snapshot ${decision.policySnapshotId}`,
  ];
}

function preparedEnvelopeId(input: unknown): string {
  return `route_envelope_${fingerprint(input)}`;
}

function sumActualCost(attempts: readonly RouterAttemptEvidence[]): number | null {
  if (attempts.some((attempt) => attempt.actualCostUsd === null)) return null;
  return attempts.reduce((sum, attempt) => sum + (attempt.actualCostUsd ?? 0), 0);
}

function stripDispatch(attempt: RouterAttemptEvidence): RouterActualOutcomeInput {
  const { dispatch, ...input } = attempt;
  return {
    ...input,
    executorId: dispatch.executorId,
    providerId: dispatch.providerId,
  };
}

function availabilityKey(executorId: string, providerId: string): string {
  return `${executorId}\u0000${providerId}`;
}

function validIso(value: string, label: string): number {
  const time = Date.parse(value);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString() !== value
  ) {
    throw new Error(`${label} is invalid`);
  }
  return time;
}

function persistTask(task: RouterTaskSpec): PersistedRouterTaskSpec {
  const { goal, ...fields } = task;
  return Object.freeze({
    ...structuredClone(fields),
    goalDigest: createHash("sha256").update(goal).digest("hex"),
  });
}

function restoreTask(task: PersistedRouterTaskSpec): RouterTaskSpec {
  const { goalDigest, ...fields } = task;
  if (!/^[a-f0-9]{64}$/.test(goalDigest)) {
    throw new Error("Router task goal digest is invalid");
  }
  return {
    ...structuredClone(fields),
    goal: `sha256:${goalDigest}`,
  };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
