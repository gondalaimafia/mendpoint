import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type DependencyOutageKind = "model" | "scm" | "feed" | "registry" | "notification";
export type DependencyOutageStatus = "queued" | "claimed" | "blocked" | "failed" | "completed";
export type DependencyOutageCircuitState = "closed" | "open" | "half_open";
export type DependencyOutageStanding =
  | "healthy"
  | "degraded_retrying"
  | "degraded_blocked"
  | "degraded_failed"
  | "recovering";

export type DependencyOutageScope = Readonly<{
  tenantId: string;
  dependencyKind: DependencyOutageKind;
  providerId: string;
  operationId: string;
  operationDigest: string;
}>;

export type DependencyOutageFailureDecision = Readonly<{
  schemaVersion: 1;
  action: "retry" | "wait" | "await_authority" | "fail" | "reconcile";
  failureKind: string;
  retryable: boolean;
  reason: string;
  nextAttemptAt: string | null;
  circuitState: DependencyOutageCircuitState;
  circuit: DependencyOutageCircuitSnapshot;
  standing: DependencyOutageStanding;
}>;

export type DependencyOutageCircuitSnapshot = Readonly<{
  state: DependencyOutageCircuitState;
  openedAt?: string;
  cooldownMs: number;
  consecutiveFailures: number;
}>;

export type DependencyOutageRecord = DependencyOutageScope & Readonly<{
  status: DependencyOutageStatus;
  standing: DependencyOutageStanding;
  circuitState: DependencyOutageCircuitState;
  circuitOpenedAt: string | null;
  circuitCooldownMs: number;
  consecutiveFailures: number;
  retryBudget: number;
  attemptsConsumed: number;
  nextAttemptAt: string;
  expiresAt: string;
  authorityVersion: string | null;
  claimOwner: string | null;
  claimGeneration: number;
  claimExpiresAt: string | null;
  completionDigest: string | null;
  lastFailureKind: string | null;
  lastFailureReason: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type DependencyOutageClaim = DependencyOutageRecord & Readonly<{
  status: "claimed";
  claimOwner: string;
  claimExpiresAt: string;
}>;

export type DependencyOutageHistoryEvent = Readonly<{
  sequence: number;
  kind: "enqueued" | "claimed" | "claim_recovered" | "retry_scheduled" |
    "authority_blocked" | "authority_reactivated" | "failed" | "completed";
  observedAt: string;
  details: Readonly<Record<string, unknown>>;
  previousHash: string | null;
  eventHash: string;
}>;

export type DependencyOutageReconciliation<T> =
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "completed"; value: T; completionDigest: string }>;

export type DependencyOutageRunOperation<T> = DependencyOutageScope & Readonly<{
  workerId: string;
  retryBudget: number;
  expiresAt: string;
  leaseMs: number;
  authorityVersion: string;
  reconcile: () => Promise<DependencyOutageReconciliation<T>>;
  execute: () => Promise<Readonly<{ value: T; completionDigest: string }>>;
  classify: (
    error: unknown,
    context: Readonly<{
      attempt: number;
      retryBudget: number;
      now: string;
      circuit: DependencyOutageCircuitSnapshot;
    }>,
  ) => DependencyOutageFailureDecision;
}>;

export type DependencyOutageRunResult<T> =
  | Readonly<{ status: "completed" | "recovered"; value: T; record: DependencyOutageRecord }>
  | Readonly<{
    status: "deferred" | "blocked" | "failed";
    record: DependencyOutageRecord;
    decision?: DependencyOutageFailureDecision;
    error?: unknown;
  }>;

type OutageRow = {
  tenant_id: string;
  dependency_kind: DependencyOutageKind;
  provider_id: string;
  operation_id: string;
  operation_digest: string;
  status: DependencyOutageStatus;
  standing: DependencyOutageStanding;
  circuit_state: DependencyOutageCircuitState;
  circuit_opened_at: string | null;
  circuit_cooldown_ms: number;
  consecutive_failures: number;
  retry_budget: number;
  attempts_consumed: number;
  next_attempt_at: string;
  expires_at: string;
  authority_version: string | null;
  claim_owner: string | null;
  claim_generation: number;
  claim_expires_at: string | null;
  completion_digest: string | null;
  last_failure_kind: string | null;
  last_failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

type HistoryRow = {
  sequence: number;
  event_kind: DependencyOutageHistoryEvent["kind"];
  observed_at: string;
  details_json: string;
  previous_hash: string | null;
  event_hash: string;
};

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,499}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function iso(value: string, code: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(code);
  return value;
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}

function validateScope(scope: DependencyOutageScope): void {
  if (!IDENTITY.test(scope.tenantId)) throw new Error("dependency_outage_tenant_invalid");
  if (!IDENTITY.test(scope.providerId)) throw new Error("dependency_outage_provider_invalid");
  if (!OPERATION_ID.test(scope.operationId)) throw new Error("dependency_outage_operation_id_invalid");
  if (!SHA256.test(scope.operationDigest)) throw new Error("dependency_outage_digest_invalid");
}

function fromRow(row: OutageRow): DependencyOutageRecord {
  return Object.freeze({
    tenantId: row.tenant_id,
    dependencyKind: row.dependency_kind,
    providerId: row.provider_id,
    operationId: row.operation_id,
    operationDigest: row.operation_digest,
    status: row.status,
    standing: row.standing,
    circuitState: row.circuit_state,
    circuitOpenedAt: row.circuit_opened_at,
    circuitCooldownMs: row.circuit_cooldown_ms,
    consecutiveFailures: row.consecutive_failures,
    retryBudget: row.retry_budget,
    attemptsConsumed: row.attempts_consumed,
    nextAttemptAt: row.next_attempt_at,
    expiresAt: row.expires_at,
    authorityVersion: row.authority_version,
    claimOwner: row.claim_owner,
    claimGeneration: row.claim_generation,
    claimExpiresAt: row.claim_expires_at,
    completionDigest: row.completion_digest,
    lastFailureKind: row.last_failure_kind,
    lastFailureReason: row.last_failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dependency_outage_operations (
      tenant_id TEXT NOT NULL,
      dependency_kind TEXT NOT NULL CHECK (dependency_kind IN ('model','scm','feed','registry','notification')),
      provider_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      operation_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','claimed','blocked','failed','completed')),
      standing TEXT NOT NULL CHECK (standing IN ('healthy','degraded_retrying','degraded_blocked','degraded_failed','recovering')),
      circuit_state TEXT NOT NULL CHECK (circuit_state IN ('closed','open','half_open')),
      circuit_opened_at TEXT,
      circuit_cooldown_ms INTEGER NOT NULL DEFAULT 30000 CHECK (circuit_cooldown_ms > 0),
      consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
      retry_budget INTEGER NOT NULL CHECK (retry_budget > 0),
      attempts_consumed INTEGER NOT NULL DEFAULT 0 CHECK (attempts_consumed >= 0),
      next_attempt_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      authority_version TEXT,
      claim_owner TEXT,
      claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
      claim_expires_at TEXT,
      completion_digest TEXT,
      last_failure_kind TEXT,
      last_failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, dependency_kind, provider_id, operation_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS dependency_outage_claimable_idx
      ON dependency_outage_operations(status, next_attempt_at, expires_at);
    CREATE TABLE IF NOT EXISTS dependency_outage_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      dependency_kind TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      details_json TEXT NOT NULL,
      previous_hash TEXT,
      event_hash TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS dependency_outage_history_no_update
      BEFORE UPDATE ON dependency_outage_history BEGIN
        SELECT RAISE(ABORT, 'dependency_outage_history_immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS dependency_outage_history_no_delete
      BEFORE DELETE ON dependency_outage_history BEGIN
        SELECT RAISE(ABORT, 'dependency_outage_history_immutable');
      END;
  `);
  const columns = new Set((db.prepare("PRAGMA table_info(dependency_outage_operations)").all() as
    Array<{ name: string }>).map((column) => column.name));
  if (!columns.has("circuit_opened_at")) {
    db.exec("ALTER TABLE dependency_outage_operations ADD COLUMN circuit_opened_at TEXT");
  }
  if (!columns.has("circuit_cooldown_ms")) {
    db.exec("ALTER TABLE dependency_outage_operations ADD COLUMN circuit_cooldown_ms INTEGER NOT NULL DEFAULT 30000");
  }
  if (!columns.has("consecutive_failures")) {
    db.exec("ALTER TABLE dependency_outage_operations ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0");
  }
}

function circuitFromRow(row: OutageRow): DependencyOutageCircuitSnapshot {
  return Object.freeze({
    state: row.circuit_state,
    ...(row.circuit_opened_at === null ? {} : { openedAt: row.circuit_opened_at }),
    cooldownMs: row.circuit_cooldown_ms,
    consecutiveFailures: row.consecutive_failures,
  });
}

function validateCircuit(circuit: DependencyOutageCircuitSnapshot): void {
  if (!Number.isSafeInteger(circuit.cooldownMs) || circuit.cooldownMs < 1 ||
      circuit.cooldownMs > 24 * 60 * 60 * 1_000 ||
      !Number.isSafeInteger(circuit.consecutiveFailures) || circuit.consecutiveFailures < 0 ||
      (circuit.state === "open" && circuit.openedAt === undefined)) {
    throw new Error("dependency_outage_circuit_invalid");
  }
  if (circuit.openedAt !== undefined) iso(circuit.openedAt, "dependency_outage_circuit_invalid");
}

function withImmediateTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

export class DependencyOutageQueue {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    ensureSchema(db);
  }

  private row(scope: DependencyOutageScope): OutageRow | undefined {
    validateScope(scope);
    return this.db.prepare(`SELECT * FROM dependency_outage_operations
      WHERE tenant_id = ? AND dependency_kind = ? AND provider_id = ? AND operation_id = ?`)
      .get(scope.tenantId, scope.dependencyKind, scope.providerId, scope.operationId) as
        OutageRow | undefined;
  }

  private append(
    scope: DependencyOutageScope,
    kind: DependencyOutageHistoryEvent["kind"],
    observedAt: string,
    details: Readonly<Record<string, unknown>>,
  ): void {
    const previous = this.db.prepare(`SELECT event_hash FROM dependency_outage_history
      WHERE tenant_id = ? AND dependency_kind = ? AND provider_id = ? AND operation_id = ?
      ORDER BY sequence DESC LIMIT 1`)
      .get(scope.tenantId, scope.dependencyKind, scope.providerId, scope.operationId) as
        { event_hash: string } | undefined;
    const detailsJson = canonical(details);
    const previousHash = previous?.event_hash ?? null;
    const eventHash = sha256(canonical({
      tenantId: scope.tenantId,
      dependencyKind: scope.dependencyKind,
      providerId: scope.providerId,
      operationId: scope.operationId,
      operationDigest: scope.operationDigest,
      kind,
      observedAt,
      details: JSON.parse(detailsJson),
      previousHash,
    }));
    this.db.prepare(`INSERT INTO dependency_outage_history (
      tenant_id, dependency_kind, provider_id, operation_id, event_kind,
      observed_at, details_json, previous_hash, event_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(scope.tenantId, scope.dependencyKind, scope.providerId, scope.operationId,
        kind, observedAt, detailsJson, previousHash, eventHash);
  }

  get(scope: DependencyOutageScope): DependencyOutageRecord | null {
    const row = this.row(scope);
    if (!row) return null;
    if (row.operation_digest !== scope.operationDigest) {
      throw new Error("dependency_outage_operation_digest_conflict");
    }
    return fromRow(row);
  }

  enqueue(
    input: DependencyOutageScope & Readonly<{
      retryBudget: number;
      expiresAt: string;
      nextAttemptAt: string;
      standing: DependencyOutageStanding;
      status?: "queued" | "blocked" | "failed";
      authorityVersion?: string;
      circuitState?: DependencyOutageCircuitState;
      circuitOpenedAt?: string;
      circuitCooldownMs?: number;
      consecutiveFailures?: number;
    }>,
    observedAt = this.now(),
  ): DependencyOutageRecord {
    validateScope(input);
    positiveInteger(input.retryBudget, "dependency_outage_retry_budget_invalid");
    iso(observedAt, "dependency_outage_timestamp_invalid");
    iso(input.nextAttemptAt, "dependency_outage_next_attempt_invalid");
    iso(input.expiresAt, "dependency_outage_expiry_invalid");
    if (Date.parse(input.expiresAt) <= Date.parse(observedAt)) {
      throw new Error("dependency_outage_expired");
    }
    if (input.authorityVersion !== undefined && !IDENTITY.test(input.authorityVersion)) {
      throw new Error("dependency_outage_authority_invalid");
    }
    const status = input.status ?? "queued";
    const circuit: DependencyOutageCircuitSnapshot = Object.freeze({
      state: input.circuitState ?? "closed",
      ...(input.circuitOpenedAt === undefined ? {} : { openedAt: input.circuitOpenedAt }),
      cooldownMs: input.circuitCooldownMs ?? 30_000,
      consecutiveFailures: input.consecutiveFailures ?? 0,
    });
    validateCircuit(circuit);
    return withImmediateTransaction(this.db, () => {
      const existing = this.row(input);
      if (existing) {
        if (existing.operation_digest !== input.operationDigest) {
          throw new Error("dependency_outage_operation_digest_conflict");
        }
        return fromRow(existing);
      }
      this.db.prepare(`INSERT INTO dependency_outage_operations (
        tenant_id, dependency_kind, provider_id, operation_id, operation_digest,
        status, standing, circuit_state, circuit_opened_at, circuit_cooldown_ms,
        consecutive_failures, retry_budget, attempts_consumed,
        next_attempt_at, expires_at, authority_version, claim_generation,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?)`)
        .run(input.tenantId, input.dependencyKind, input.providerId, input.operationId,
          input.operationDigest, status, input.standing, circuit.state, circuit.openedAt ?? null,
          circuit.cooldownMs, circuit.consecutiveFailures, input.retryBudget,
          input.nextAttemptAt, input.expiresAt,
          input.authorityVersion ?? null, observedAt, observedAt);
      this.append(input, "enqueued", observedAt, Object.freeze({
        status,
        retryBudget: input.retryBudget,
        expiresAt: input.expiresAt,
      }));
      return fromRow(this.row(input)!);
    });
  }

  claim(input: DependencyOutageScope & Readonly<{
    workerId: string;
    now: string;
    leaseMs: number;
  }>): DependencyOutageClaim | null {
    validateScope(input);
    if (!IDENTITY.test(input.workerId)) throw new Error("dependency_outage_worker_invalid");
    iso(input.now, "dependency_outage_timestamp_invalid");
    positiveInteger(input.leaseMs, "dependency_outage_lease_invalid");
    return withImmediateTransaction(this.db, () => {
      const current = this.row(input);
      if (!current) return null;
      if (current.operation_digest !== input.operationDigest) {
        throw new Error("dependency_outage_operation_digest_conflict");
      }
      const recovering = current.status === "claimed" &&
        current.claim_expires_at !== null && current.claim_expires_at <= input.now;
      if ((current.status !== "queued" && !recovering) ||
          current.next_attempt_at > input.now || current.expires_at <= input.now ||
          current.attempts_consumed >= current.retry_budget) return null;
      const generation = current.claim_generation + 1;
      const expiresAt = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
      this.db.prepare(`UPDATE dependency_outage_operations SET
        status = 'claimed', standing = 'recovering',
        circuit_state = CASE WHEN circuit_state = 'open' THEN 'half_open' ELSE circuit_state END,
        claim_owner = ?,
        claim_generation = ?, claim_expires_at = ?, attempts_consumed = attempts_consumed + 1,
        updated_at = ?
        WHERE tenant_id = ? AND dependency_kind = ? AND provider_id = ? AND operation_id = ?`)
        .run(input.workerId, generation, expiresAt, input.now, input.tenantId,
          input.dependencyKind, input.providerId, input.operationId);
      this.append(input, recovering ? "claim_recovered" : "claimed", input.now,
        Object.freeze({ workerId: input.workerId, claimGeneration: generation, leaseExpiresAt: expiresAt }));
      return fromRow(this.row(input)!) as DependencyOutageClaim;
    });
  }

  complete(
    claim: DependencyOutageClaim,
    completionDigest: string,
    observedAt = this.now(),
  ): Readonly<{ applied: boolean; record: DependencyOutageRecord }> {
    validateScope(claim);
    if (!SHA256.test(completionDigest)) throw new Error("dependency_outage_completion_digest_invalid");
    iso(observedAt, "dependency_outage_timestamp_invalid");
    return withImmediateTransaction(this.db, () => {
      const current = this.row(claim);
      if (!current || current.operation_digest !== claim.operationDigest) {
        throw new Error("dependency_outage_operation_missing");
      }
      if (current.status === "completed") {
        if (current.completion_digest !== completionDigest) {
          throw new Error("dependency_outage_completion_digest_conflict");
        }
        return Object.freeze({ applied: false, record: fromRow(current) });
      }
      const active = current.status === "claimed" && current.claim_owner === claim.claimOwner &&
        current.claim_generation === claim.claimGeneration &&
        current.claim_expires_at !== null && current.claim_expires_at > observedAt;
      if (!active) return Object.freeze({ applied: false, record: fromRow(current) });
      this.db.prepare(`UPDATE dependency_outage_operations SET
        status = 'completed', standing = 'healthy', circuit_state = 'closed',
        circuit_opened_at = NULL, consecutive_failures = 0,
        completion_digest = ?, claim_owner = NULL, claim_expires_at = NULL,
        last_failure_kind = NULL, last_failure_reason = NULL, updated_at = ?
        WHERE tenant_id = ? AND dependency_kind = ? AND provider_id = ? AND operation_id = ?`)
        .run(completionDigest, observedAt, claim.tenantId, claim.dependencyKind,
          claim.providerId, claim.operationId);
      this.append(claim, "completed", observedAt,
        Object.freeze({ claimGeneration: claim.claimGeneration, completionDigest }));
      return Object.freeze({ applied: true, record: fromRow(this.row(claim)!) });
    });
  }

  fail(
    claim: DependencyOutageClaim,
    decision: DependencyOutageFailureDecision,
    observedAt = this.now(),
  ): DependencyOutageRecord {
    validateScope(claim);
    iso(observedAt, "dependency_outage_timestamp_invalid");
    if (decision.schemaVersion !== 1) throw new Error("dependency_outage_decision_version_invalid");
    validateCircuit(decision.circuit);
    if (decision.circuitState !== decision.circuit.state) {
      throw new Error("dependency_outage_circuit_decision_mismatch");
    }
    if (decision.nextAttemptAt !== null) {
      iso(decision.nextAttemptAt, "dependency_outage_next_attempt_invalid");
    }
    return withImmediateTransaction(this.db, () => {
      const current = this.row(claim);
      if (!current || current.operation_digest !== claim.operationDigest) {
        throw new Error("dependency_outage_operation_missing");
      }
      const active = current.status === "claimed" && current.claim_owner === claim.claimOwner &&
        current.claim_generation === claim.claimGeneration &&
        current.claim_expires_at !== null && current.claim_expires_at > observedAt;
      if (!active) throw new Error("dependency_outage_claim_fence_lost");
      const budgetExhausted = current.attempts_consumed >= current.retry_budget;
      const status: DependencyOutageStatus = budgetExhausted || decision.action === "fail"
        ? "failed"
        : decision.action === "await_authority" ? "blocked" : "queued";
      const standing: DependencyOutageStanding = status === "failed"
        ? "degraded_failed"
        : status === "blocked" ? "degraded_blocked" : decision.standing;
      const nextAttemptAt = decision.nextAttemptAt ?? current.next_attempt_at;
      this.db.prepare(`UPDATE dependency_outage_operations SET
        status = ?, standing = ?, circuit_state = ?, circuit_opened_at = ?,
        circuit_cooldown_ms = ?, consecutive_failures = ?, next_attempt_at = ?,
        claim_owner = NULL, claim_expires_at = NULL,
        last_failure_kind = ?, last_failure_reason = ?, updated_at = ?
        WHERE tenant_id = ? AND dependency_kind = ? AND provider_id = ? AND operation_id = ?`)
        .run(status, standing, decision.circuitState, decision.circuit.openedAt ?? null,
          decision.circuit.cooldownMs, decision.circuit.consecutiveFailures, nextAttemptAt,
          decision.failureKind, budgetExhausted ? "retry_budget_exhausted" : decision.reason,
          observedAt, claim.tenantId, claim.dependencyKind, claim.providerId, claim.operationId);
      const event = status === "failed" ? "failed" :
        status === "blocked" ? "authority_blocked" : "retry_scheduled";
      this.append(claim, event, observedAt, Object.freeze({
        claimGeneration: claim.claimGeneration,
        failureKind: decision.failureKind,
        reason: budgetExhausted ? "retry_budget_exhausted" : decision.reason,
        nextAttemptAt: status === "queued" ? nextAttemptAt : null,
        circuit: decision.circuit,
      }));
      return fromRow(this.row(claim)!);
    });
  }

  reactivateAuthority(
    scope: DependencyOutageScope,
    input: Readonly<{
      previousAuthorityVersion: string;
      nextAuthorityVersion: string;
      now: string;
    }>,
  ): DependencyOutageRecord {
    validateScope(scope);
    if (!IDENTITY.test(input.previousAuthorityVersion) || !IDENTITY.test(input.nextAuthorityVersion)) {
      throw new Error("dependency_outage_authority_invalid");
    }
    if (input.previousAuthorityVersion === input.nextAuthorityVersion) {
      throw new Error("dependency_outage_authority_unchanged");
    }
    iso(input.now, "dependency_outage_timestamp_invalid");
    return withImmediateTransaction(this.db, () => {
      const current = this.row(scope);
      if (!current || current.operation_digest !== scope.operationDigest) {
        throw new Error("dependency_outage_operation_missing");
      }
      if (current.status !== "blocked" || current.authority_version !== input.previousAuthorityVersion) {
        throw new Error("dependency_outage_authority_mismatch");
      }
      if (current.expires_at <= input.now) throw new Error("dependency_outage_expired");
      this.db.prepare(`UPDATE dependency_outage_operations SET
        status = 'queued', standing = 'degraded_retrying', circuit_state = 'half_open',
        next_attempt_at = ?, authority_version = ?, updated_at = ?
        WHERE tenant_id = ? AND dependency_kind = ? AND provider_id = ? AND operation_id = ?`)
        .run(input.now, input.nextAuthorityVersion, input.now, scope.tenantId,
          scope.dependencyKind, scope.providerId, scope.operationId);
      this.append(scope, "authority_reactivated", input.now, Object.freeze({
        previousAuthorityVersion: input.previousAuthorityVersion,
        nextAuthorityVersion: input.nextAuthorityVersion,
      }));
      return fromRow(this.row(scope)!);
    });
  }

  history(scope: DependencyOutageScope): readonly DependencyOutageHistoryEvent[] {
    const current = this.get(scope);
    if (!current) return [];
    const rows = this.db.prepare(`SELECT sequence, event_kind, observed_at, details_json,
      previous_hash, event_hash FROM dependency_outage_history
      WHERE tenant_id = ? AND dependency_kind = ? AND provider_id = ? AND operation_id = ?
      ORDER BY sequence ASC`)
      .all(scope.tenantId, scope.dependencyKind, scope.providerId, scope.operationId) as HistoryRow[];
    let previousHash: string | null = null;
    return Object.freeze(rows.map((row) => {
      if (row.previous_hash !== previousHash) throw new Error("dependency_outage_history_chain_invalid");
      const details = JSON.parse(row.details_json) as Record<string, unknown>;
      const expectedHash = sha256(canonical({
        tenantId: scope.tenantId,
        dependencyKind: scope.dependencyKind,
        providerId: scope.providerId,
        operationId: scope.operationId,
        operationDigest: scope.operationDigest,
        kind: row.event_kind,
        observedAt: row.observed_at,
        details,
        previousHash,
      }));
      if (row.event_hash !== expectedHash) throw new Error("dependency_outage_history_chain_invalid");
      previousHash = row.event_hash;
      return Object.freeze({
        sequence: row.sequence,
        kind: row.event_kind,
        observedAt: row.observed_at,
        details: Object.freeze(details),
        previousHash: row.previous_hash,
        eventHash: row.event_hash,
      });
    }));
  }

  async run<T>(operation: DependencyOutageRunOperation<T>): Promise<DependencyOutageRunResult<T>> {
    const now = this.now();
    const enqueued = this.enqueue({
      ...operation,
      nextAttemptAt: now,
      standing: "degraded_retrying",
    }, now);
    if (enqueued.status === "blocked" && enqueued.authorityVersion !== operation.authorityVersion) {
      if (enqueued.authorityVersion === null) {
        throw new Error("dependency_outage_authority_missing");
      }
      this.reactivateAuthority(operation, {
        previousAuthorityVersion: enqueued.authorityVersion,
        nextAuthorityVersion: operation.authorityVersion,
        now,
      });
    }
    const claim = this.claim({ ...operation, now, leaseMs: operation.leaseMs });
    if (!claim) {
      const record = this.get(operation)!;
      if (record.status === "completed") {
        const observed = await operation.reconcile();
        if (observed.status !== "completed" || observed.completionDigest !== record.completionDigest) {
          throw new Error("dependency_outage_completed_effect_not_reconciled");
        }
        return Object.freeze({ status: "recovered", value: observed.value, record });
      }
      return Object.freeze({
        status: record.status === "blocked" ? "blocked" :
          record.status === "failed" ? "failed" : "deferred",
        record,
      });
    }
    try {
      const observed = await operation.reconcile();
      if (observed.status === "completed") {
        const completed = this.complete(claim, observed.completionDigest, this.now());
        if (!completed.applied && completed.record.status !== "completed") {
          throw new Error("dependency_outage_completion_fence_lost");
        }
        return Object.freeze({ status: "recovered", value: observed.value, record: completed.record });
      }
      const executed = await operation.execute();
      const completed = this.complete(claim, executed.completionDigest, this.now());
      if (!completed.applied) throw new Error("dependency_outage_completion_fence_lost");
      return Object.freeze({ status: "completed", value: executed.value, record: completed.record });
    } catch (error) {
      const failedAt = this.now();
      const decision = operation.classify(error, {
        attempt: claim.attemptsConsumed,
        retryBudget: claim.retryBudget,
        now: failedAt,
        circuit: Object.freeze({
          state: claim.circuitState,
          ...(claim.circuitOpenedAt === null ? {} : { openedAt: claim.circuitOpenedAt }),
          cooldownMs: claim.circuitCooldownMs,
          consecutiveFailures: claim.consecutiveFailures,
        }),
      });
      const record = this.fail(claim, decision, failedAt);
      return Object.freeze({
        status: record.status === "blocked" ? "blocked" :
          record.status === "failed" ? "failed" : "deferred",
        record,
        decision,
        error,
      });
    }
  }
}

export function createDependencyOutageQueue(
  db: DatabaseSync,
  options: Readonly<{ now?: () => string }> = {},
): DependencyOutageQueue {
  return new DependencyOutageQueue(db, options.now);
}
