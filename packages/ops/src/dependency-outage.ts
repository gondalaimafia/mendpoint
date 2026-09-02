/**
 * Product-neutral dependency outage policy.
 *
 * This module deliberately has no model, SCM, database, or network imports. A
 * caller maps provider evidence into this versioned decision and injects the
 * resulting policy into its durable recovery port. That dependency direction
 * prevents the GitHub and agent packages from importing ops or db and creating
 * a package cycle.
 */

export const DEPENDENCY_OUTAGE_SCHEMA_VERSION = 1 as const;

export type DependencyKind = "model" | "scm" | "feed" | "registry" | "notification";
export type DependencyFailureKind =
  | "timeout"
  | "throttled"
  | "transient"
  | "invalid_response"
  | "authentication"
  | "permission"
  | "permanent"
  | "expired"
  | "completed";
export type DependencyCircuitState = "closed" | "open" | "half_open";
export type DependencyOutageStanding =
  | "healthy"
  | "degraded_retrying"
  | "degraded_blocked"
  | "degraded_failed"
  | "recovering";
export type DependencyOutageAction =
  | "retry"
  | "wait"
  | "await_authority"
  | "fail"
  | "reconcile";

export type DependencyOutageScope = Readonly<{
  tenantId: string;
  dependencyKind: DependencyKind;
  providerId: string;
}>;

export type DependencyCircuitSnapshot = Readonly<{
  state: DependencyCircuitState;
  openedAt?: string;
  cooldownMs: number;
  consecutiveFailures: number;
}>;

export type DependencyOutageFailureInput = DependencyOutageScope & Readonly<{
  operationDigest: string;
  failureKind: DependencyFailureKind;
  /** One-based number of the attempt that produced this failure. */
  attempt: number;
  /** Maximum number of external attempts, including the first attempt. */
  retryBudget: number;
  now: string;
  expiresAt: string;
  retryAfterMs?: number;
  circuit?: DependencyCircuitSnapshot;
}>;

export type DependencyOutageDecision = Readonly<{
  schemaVersion: typeof DEPENDENCY_OUTAGE_SCHEMA_VERSION;
  action: DependencyOutageAction;
  failureKind: DependencyFailureKind;
  retryable: boolean;
  reason: string;
  nextAttemptAt: string | null;
  attemptsRemaining: number;
  circuitState: DependencyCircuitState;
  circuit: DependencyCircuitSnapshot;
  standing: DependencyOutageStanding;
}>;

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000;
const MAX_RETRY_DELAY_MS = 60_000;

function requiredIdentity(value: string, code: string): string {
  if (!IDENTITY.test(value)) throw new Error(code);
  return value;
}

function timestamp(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(code);
  }
  return parsed;
}

function integer(value: number, code: string, min = 1): number {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(code);
  return value;
}

function decision(
  input: DependencyOutageFailureInput,
  values: Omit<DependencyOutageDecision, "schemaVersion" | "failureKind" | "attemptsRemaining">,
): DependencyOutageDecision {
  if (values.circuitState !== values.circuit.state) {
    throw new Error("dependency_outage_circuit_decision_mismatch");
  }
  return Object.freeze({
    schemaVersion: DEPENDENCY_OUTAGE_SCHEMA_VERSION,
    failureKind: input.failureKind,
    attemptsRemaining: Math.max(0, input.retryBudget - input.attempt),
    ...values,
  });
}

function openedCircuit(
  circuit: DependencyCircuitSnapshot,
  openedAt: string,
): DependencyCircuitSnapshot {
  return Object.freeze({
    state: "open",
    openedAt,
    cooldownMs: circuit.cooldownMs,
    consecutiveFailures: circuit.consecutiveFailures + 1,
  });
}

function deterministicRetryDelayMs(input: DependencyOutageFailureInput): number {
  if (input.retryAfterMs !== undefined) {
    if (!Number.isSafeInteger(input.retryAfterMs) || input.retryAfterMs < 0 ||
        input.retryAfterMs > 24 * 60 * 60 * 1_000) {
      throw new Error("dependency_outage_retry_after_invalid");
    }
    return input.retryAfterMs;
  }
  const exponential = Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** Math.min(10, input.attempt - 1));
  const jitterRatio = (Number.parseInt(input.operationDigest.slice(0, 8), 16) % 201) / 1_000;
  return Math.min(MAX_RETRY_DELAY_MS, Math.round(exponential * (1 + jitterRatio)));
}

function validateCircuit(circuit: DependencyCircuitSnapshot | undefined): DependencyCircuitSnapshot {
  if (!circuit) {
    return Object.freeze({
      state: "closed",
      cooldownMs: DEFAULT_CIRCUIT_COOLDOWN_MS,
      consecutiveFailures: 0,
    });
  }
  if (!["closed", "open", "half_open"].includes(circuit.state) ||
      !Number.isSafeInteger(circuit.cooldownMs) || circuit.cooldownMs < 1 ||
      circuit.cooldownMs > 24 * 60 * 60 * 1_000 ||
      !Number.isSafeInteger(circuit.consecutiveFailures) || circuit.consecutiveFailures < 0) {
    throw new Error("dependency_outage_circuit_invalid");
  }
  if (circuit.state === "open") {
    if (!circuit.openedAt) throw new Error("dependency_outage_circuit_invalid");
    timestamp(circuit.openedAt, "dependency_outage_circuit_invalid");
  }
  return circuit;
}

/** Fail closed when a recovery record is used outside its exact dependency scope. */
export function assertDependencyOutageScope(
  expected: DependencyOutageScope,
  actual: DependencyOutageScope,
): void {
  for (const scope of [expected, actual]) {
    requiredIdentity(scope.tenantId, "dependency_outage_tenant_invalid");
    requiredIdentity(scope.providerId, "dependency_outage_provider_invalid");
  }
  if (expected.tenantId !== actual.tenantId ||
      expected.dependencyKind !== actual.dependencyKind ||
      expected.providerId !== actual.providerId) {
    throw new Error("dependency_outage_scope_mismatch");
  }
}

/**
 * Convert one exact provider failure into a deterministic queue/circuit action.
 * This function does not sleep, retry, or perform I/O.
 */
export function classifyDependencyOutage(
  input: DependencyOutageFailureInput,
): DependencyOutageDecision {
  requiredIdentity(input.tenantId, "dependency_outage_tenant_invalid");
  requiredIdentity(input.providerId, "dependency_outage_provider_invalid");
  if (!SHA256.test(input.operationDigest)) throw new Error("dependency_outage_digest_invalid");
  integer(input.attempt, "dependency_outage_attempt_invalid");
  integer(input.retryBudget, "dependency_outage_retry_budget_invalid");
  const now = timestamp(input.now, "dependency_outage_now_invalid");
  const expiresAt = timestamp(input.expiresAt, "dependency_outage_expiry_invalid");
  const circuit = validateCircuit(input.circuit);

  // A provider may have completed the external effect even after our local
  // deadline. Reconciliation comes before expiry so we never repeat it.
  if (input.failureKind === "completed") {
    return decision(input, {
      action: "reconcile",
      retryable: false,
      reason: "completed_effect_requires_reconciliation",
      nextAttemptAt: null,
      circuitState: circuit.state,
      circuit,
      standing: "recovering",
    });
  }

  if (input.failureKind === "expired" || now >= expiresAt) {
    const nextCircuit = openedCircuit(circuit, input.now);
    return decision(input, {
      action: "fail",
      retryable: false,
      reason: "operation_expired",
      nextAttemptAt: null,
      circuitState: "open",
      circuit: nextCircuit,
      standing: "degraded_failed",
    });
  }

  if (input.failureKind === "authentication" || input.failureKind === "permission") {
    const nextCircuit = openedCircuit(circuit, input.now);
    return decision(input, {
      action: "await_authority",
      retryable: false,
      reason: "authority_change_required",
      nextAttemptAt: null,
      circuitState: "open",
      circuit: nextCircuit,
      standing: "degraded_blocked",
    });
  }

  if (input.failureKind === "permanent") {
    const nextCircuit = openedCircuit(circuit, input.now);
    return decision(input, {
      action: "fail",
      retryable: false,
      reason: "permanent_failure",
      nextAttemptAt: null,
      circuitState: "open",
      circuit: nextCircuit,
      standing: "degraded_failed",
    });
  }

  if (input.attempt >= input.retryBudget) {
    const nextCircuit = openedCircuit(circuit, input.now);
    return decision(input, {
      action: "fail",
      retryable: false,
      reason: "retry_budget_exhausted",
      nextAttemptAt: null,
      circuitState: "open",
      circuit: nextCircuit,
      standing: "degraded_failed",
    });
  }

  if (circuit.state === "open") {
    const openedAt = timestamp(circuit.openedAt!, "dependency_outage_circuit_invalid");
    const probeAt = openedAt + circuit.cooldownMs;
    if (now < probeAt) {
      return decision(input, {
        action: "wait",
        retryable: true,
        reason: "circuit_open",
        nextAttemptAt: new Date(probeAt).toISOString(),
        circuitState: "open",
        circuit,
        standing: "degraded_retrying",
      });
    }
    const probeCircuit = Object.freeze({
      ...circuit,
      state: "half_open" as const,
    });
    return decision(input, {
      action: "retry",
      retryable: true,
      reason: "half_open_probe",
      nextAttemptAt: input.now,
      circuitState: "half_open",
      circuit: probeCircuit,
      standing: "recovering",
    });
  }

  if (circuit.state === "half_open" ||
      circuit.consecutiveFailures + 1 >= CIRCUIT_FAILURE_THRESHOLD) {
    const nextCircuit = openedCircuit(circuit, input.now);
    return decision(input, {
      action: "wait",
      retryable: true,
      reason: "circuit_opened",
      nextAttemptAt: new Date(now + circuit.cooldownMs).toISOString(),
      circuitState: "open",
      circuit: nextCircuit,
      standing: "degraded_retrying",
    });
  }

  const delayMs = deterministicRetryDelayMs(input);
  const nextCircuit = Object.freeze({
    state: "closed" as const,
    cooldownMs: circuit.cooldownMs,
    consecutiveFailures: circuit.consecutiveFailures + 1,
  });
  return decision(input, {
    action: "retry",
    retryable: true,
    reason: input.failureKind === "throttled" ? "provider_throttled" :
      input.failureKind === "invalid_response" ? "provider_response_invalid" :
        input.failureKind === "timeout" ? "provider_timeout" : "transient_failure",
    nextAttemptAt: new Date(now + delayMs).toISOString(),
    circuitState: "closed",
    circuit: nextCircuit,
    standing: "degraded_retrying",
  });
}
