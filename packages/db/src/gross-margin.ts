import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { AppDb } from "./index.js";
import { reconcileUsageLedger } from "./usage.js";

export type ExecutionOutcomeStatus = "accepted" | "rejected" | "unresolved";

export type ActualExecutionCostEntry = Readonly<{
  id: string;
  tenantId: string;
  idempotencyKey: string;
  executionId: string;
  taskId: string;
  campaignId: string | null;
  taskClass: string;
  route: string;
  attemptNumber: number;
  retryNumber: number;
  fallbackFromExecutionId: string | null;
  outcomeStatus: ExecutionOutcomeStatus;
  acceptedOutcomeId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelId: string;
  modelPriceVersion: string;
  modelCostMoneyMicros: number;
  cacheCostMoneyMicros: number;
  gpuMillis: number;
  gpuCostMoneyMicros: number;
  graphCostMoneyMicros: number;
  sandboxCostMoneyMicros: number;
  verificationCostMoneyMicros: number;
  totalCostMoneyMicros: number;
  currency: string;
  actorPrincipalId: string;
  entrySequence: number;
  previousHash: string | null;
  entryHash: string;
  createdAt: string;
  /**
   * Mission this execution's cost is attributable to, or null when there is no
   * mission link. ReGauge's live launch path and a Fettler job whose payload
   * names a bound mission (or a campaign that resolves through the mission FK)
   * carry it here. An unbound Fettler `agent.run` stays null — "no mission link
   * yet", never a fabricated one. Usage-ledger hashes are not the carrier.
   */
  missionId: string | null;
  /**
   * Per-component measurement state. A component is UNMEASURED when we did not
   * observe its cost on this execution — not when it cost nothing. An unmeasured
   * component's money-micros is always 0 (so the arithmetic total CHECK still
   * holds), but the flag keeps "we did not measure" distinguishable from
   * "we measured zero". Collapsing those two is this repo's dominant defect.
   */
  modelCostMeasured: boolean;
  cacheCostMeasured: boolean;
  gpuCostMeasured: boolean;
  graphCostMeasured: boolean;
  sandboxCostMeasured: boolean;
  verificationCostMeasured: boolean;
  /**
   * Hash-payload version. Version 1 rows predate mission attribution and the
   * measurement flags and are hashed over the original field set, so a
   * pre-change volume still verifies. Version 2 rows include the fields above in
   * the hash. See `hashEntry`.
   */
  costSchemaVersion: number;
}>;

export type GrossMarginIncompleteAttribution = Readonly<{
  code:
    | "usage_ledger_integrity"
    | "cost_ledger_integrity"
    | "usage_price_version_missing"
    | "currency_mismatch"
    | "actual_cost_missing"
    | "accepted_outcome_missing"
    | "accepted_outcome_ambiguous"
    | "task_attribution_ambiguous"
    | "execution_cost_component_unmeasured"
    | "settlement_missing"
    | "campaign_mismatch";
  taskId: string | null;
  sourceId: string | null;
}>;

export type GrossMarginAttribution = Readonly<{
  costEntryId: string;
  executionId: string;
  tenantId: string;
  taskId: string;
  campaignId: string | null;
  taskClass: string;
  route: string;
  attemptNumber: number;
  retryNumber: number;
  fallbackFromExecutionId: string | null;
  outcomeStatus: ExecutionOutcomeStatus;
  acceptedOutcomeId: string | null;
  actualCostMoneyMicros: number;
  attributedNetRevenueMoneyMicros: number | null;
  attributedGrossMarginMoneyMicros: number | null;
}>;

export type GrossMarginReconciliation = Readonly<{
  tenantId: string;
  complete: boolean;
  currency: string | null;
  usageIntegrity: ReturnType<typeof reconcileUsageLedger>;
  costIntegrity: ExecutionCostIntegrity;
  settledMcuMicros: number;
  creditedMcuMicros: number;
  adjustedMcuMicros: number;
  settledRevenueMoneyMicros: number | null;
  creditMoneyMicros: number | null;
  adjustmentMoneyMicros: number | null;
  netRevenueMoneyMicros: number | null;
  actualCostMoneyMicros: number;
  modelCostMoneyMicros: number;
  cacheCostMoneyMicros: number;
  gpuCostMoneyMicros: number;
  graphCostMoneyMicros: number;
  sandboxCostMoneyMicros: number;
  verificationCostMoneyMicros: number;
  exactGrossMarginMoneyMicros: number | null;
  attributedGrossMarginMoneyMicros: number | null;
  unattributedRevenueMoneyMicros: number;
  incompleteAttributions: readonly GrossMarginIncompleteAttribution[];
  attributions: readonly GrossMarginAttribution[];
}>;

type CostRow = {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  execution_id: string;
  task_id: string;
  campaign_id: string | null;
  task_class: string;
  route: string;
  attempt_number: number;
  retry_number: number;
  fallback_from_execution_id: string | null;
  outcome_status: ExecutionOutcomeStatus;
  accepted_outcome_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  model_id: string;
  model_price_version: string;
  model_cost_money_micros: number;
  cache_cost_money_micros: number;
  gpu_millis: number;
  gpu_cost_money_micros: number;
  graph_cost_money_micros: number;
  sandbox_cost_money_micros: number;
  verification_cost_money_micros: number;
  total_cost_money_micros: number;
  currency: string;
  actor_principal_id: string;
  entry_sequence: number;
  prev_hash: string | null;
  entry_hash: string;
  created_at: string;
  mission_id: string | null;
  model_cost_measured: number;
  cache_cost_measured: number;
  gpu_cost_measured: number;
  graph_cost_measured: number;
  sandbox_cost_measured: number;
  verification_cost_measured: number;
  cost_schema_version: number;
};

type UsageRevenueRow = {
  id: string;
  entry_type: "settlement" | "adjustment" | "credit";
  task_id: string;
  campaign_id: string | null;
  price_version: string;
  consumed_mcu_micros_delta: number;
  currency: string | null;
  price_per_mcu_money_micros: number | null;
};

export type ActualExecutionCostInput = Omit<
  ActualExecutionCostEntry,
  | "campaignId"
  | "fallbackFromExecutionId"
  | "acceptedOutcomeId"
  | "totalCostMoneyMicros"
  | "entrySequence"
  | "previousHash"
  | "entryHash"
  | "missionId"
  | "modelCostMeasured"
  | "cacheCostMeasured"
  | "gpuCostMeasured"
  | "graphCostMeasured"
  | "sandboxCostMeasured"
  | "verificationCostMeasured"
  | "costSchemaVersion"
> & {
  campaignId?: string | null;
  fallbackFromExecutionId?: string | null;
  acceptedOutcomeId?: string | null;
  missionId?: string | null;
  /**
   * Per-component measurement state. Omitted defaults to `true` (measured) so
   * the HTTP caller — which supplies real numbers for every component — records
   * measured rows unchanged. An internal writer that could not measure a
   * component MUST pass `false` for it and 0 for its money-micros; the validator
   * rejects a measured=false component that carries a nonzero cost.
   */
  modelCostMeasured?: boolean;
  cacheCostMeasured?: boolean;
  gpuCostMeasured?: boolean;
  graphCostMeasured?: boolean;
  sandboxCostMeasured?: boolean;
  verificationCostMeasured?: boolean;
};

type TaskRevenue = {
  taskId: string;
  campaignIds: Set<string | null>;
  settledMcuMicros: number;
  creditedMcuMicros: number;
  adjustedMcuMicros: number;
  settledRevenueMoneyMicros: number;
  creditMoneyMicros: number;
  adjustmentMoneyMicros: number;
  netRevenueMoneyMicros: number;
  complete: boolean;
};

export type ExecutionCostIntegrity = Readonly<{
  ok: boolean;
  checked: number;
  totalCostMoneyMicros: number;
  error?: string;
}>;

function one<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined;
}

function many<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T[] {
  return db.raw.prepare(sql).all(...params) as T[];
}

function text(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error(`${name}_invalid`);
  return normalized;
}

function timestamp(name: string, value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name}_invalid`);
  return parsed;
}

function integer(name: string, value: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name}_invalid`);
  return value;
}

function safeSum(name: string, values: readonly number[]): number {
  const total = values.reduce((sum, value) => BigInt(sum) + BigInt(value), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${name}_overflow`);
  }
  return Number(total);
}

function moneyForMcu(mcuMicros: number, pricePerMcuMoneyMicros: number): number {
  const value =
    (BigInt(mcuMicros) * BigInt(pricePerMcuMoneyMicros)) / BigInt(1_000_000);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error("gross_margin_money_overflow");
  }
  return Number(value);
}

function entryFromRow(row: CostRow): ActualExecutionCostEntry {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    idempotencyKey: row.idempotency_key,
    executionId: row.execution_id,
    taskId: row.task_id,
    campaignId: row.campaign_id,
    taskClass: row.task_class,
    route: row.route,
    attemptNumber: row.attempt_number,
    retryNumber: row.retry_number,
    fallbackFromExecutionId: row.fallback_from_execution_id,
    outcomeStatus: row.outcome_status,
    acceptedOutcomeId: row.accepted_outcome_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    modelId: row.model_id,
    modelPriceVersion: row.model_price_version,
    modelCostMoneyMicros: row.model_cost_money_micros,
    cacheCostMoneyMicros: row.cache_cost_money_micros,
    gpuMillis: row.gpu_millis,
    gpuCostMoneyMicros: row.gpu_cost_money_micros,
    graphCostMoneyMicros: row.graph_cost_money_micros,
    sandboxCostMoneyMicros: row.sandbox_cost_money_micros,
    verificationCostMoneyMicros: row.verification_cost_money_micros,
    totalCostMoneyMicros: row.total_cost_money_micros,
    currency: row.currency,
    actorPrincipalId: row.actor_principal_id,
    entrySequence: row.entry_sequence,
    previousHash: row.prev_hash,
    entryHash: row.entry_hash,
    createdAt: row.created_at,
    missionId: row.mission_id,
    modelCostMeasured: row.model_cost_measured === 1,
    cacheCostMeasured: row.cache_cost_measured === 1,
    gpuCostMeasured: row.gpu_cost_measured === 1,
    graphCostMeasured: row.graph_cost_measured === 1,
    sandboxCostMeasured: row.sandbox_cost_measured === 1,
    verificationCostMeasured: row.verification_cost_measured === 1,
    costSchemaVersion: row.cost_schema_version,
  });
}

/**
 * Hash the entry, versioned so a schema change never breaks an existing chain.
 *
 * Version 1 rows (written before mission attribution and the measurement flags,
 * and any row a pre-change volume upgraded) are hashed over EXACTLY the original
 * field set. The new columns are stripped before hashing, so their migrated
 * defaults never enter the digest and the stored hash still verifies.
 *
 * Version 2 rows include the mission id, the six measurement flags, and the
 * version itself in the digest, so tampering with attribution or a flag breaks
 * the chain.
 */
function hashEntry(entry: Omit<ActualExecutionCostEntry, "entryHash">): string {
  if (entry.costSchemaVersion <= 1) {
    const {
      missionId: _missionId,
      modelCostMeasured: _modelCostMeasured,
      cacheCostMeasured: _cacheCostMeasured,
      gpuCostMeasured: _gpuCostMeasured,
      graphCostMeasured: _graphCostMeasured,
      sandboxCostMeasured: _sandboxCostMeasured,
      verificationCostMeasured: _verificationCostMeasured,
      costSchemaVersion: _costSchemaVersion,
      ...legacy
    } = entry;
    return createHash("sha256").update(JSON.stringify(legacy)).digest("hex");
  }
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

function sameRequest(
  entry: ActualExecutionCostEntry,
  input: ActualExecutionCostInput,
  totalCostMoneyMicros: number,
): boolean {
  return (
    entry.id === input.id &&
    entry.executionId === input.executionId &&
    entry.taskId === input.taskId &&
    entry.campaignId === (input.campaignId ?? null) &&
    entry.taskClass === input.taskClass &&
    entry.route === input.route &&
    entry.attemptNumber === input.attemptNumber &&
    entry.retryNumber === input.retryNumber &&
    entry.fallbackFromExecutionId === (input.fallbackFromExecutionId ?? null) &&
    entry.outcomeStatus === input.outcomeStatus &&
    entry.acceptedOutcomeId === (input.acceptedOutcomeId ?? null) &&
    entry.inputTokens === input.inputTokens &&
    entry.outputTokens === input.outputTokens &&
    entry.cacheReadTokens === input.cacheReadTokens &&
    entry.cacheWriteTokens === input.cacheWriteTokens &&
    entry.modelId === input.modelId &&
    entry.modelPriceVersion === input.modelPriceVersion &&
    entry.modelCostMoneyMicros === input.modelCostMoneyMicros &&
    entry.cacheCostMoneyMicros === input.cacheCostMoneyMicros &&
    entry.gpuMillis === input.gpuMillis &&
    entry.gpuCostMoneyMicros === input.gpuCostMoneyMicros &&
    entry.graphCostMoneyMicros === input.graphCostMoneyMicros &&
    entry.sandboxCostMoneyMicros === input.sandboxCostMoneyMicros &&
    entry.verificationCostMoneyMicros === input.verificationCostMoneyMicros &&
    entry.totalCostMoneyMicros === totalCostMoneyMicros &&
    entry.currency === input.currency.toUpperCase() &&
    entry.actorPrincipalId === input.actorPrincipalId &&
    entry.missionId === (input.missionId ?? null) &&
    entry.modelCostMeasured === (input.modelCostMeasured ?? true) &&
    entry.cacheCostMeasured === (input.cacheCostMeasured ?? true) &&
    entry.gpuCostMeasured === (input.gpuCostMeasured ?? true) &&
    entry.graphCostMeasured === (input.graphCostMeasured ?? true) &&
    entry.sandboxCostMeasured === (input.sandboxCostMeasured ?? true) &&
    entry.verificationCostMeasured === (input.verificationCostMeasured ?? true)
  );
}

function validateInput(input: ActualExecutionCostInput): number {
  text("execution_cost_id", input.id);
  text("tenant_id", input.tenantId);
  text("execution_cost_idempotency_key", input.idempotencyKey);
  text("execution_cost_execution_id", input.executionId);
  text("execution_cost_task_id", input.taskId);
  if (input.campaignId) text("execution_cost_campaign_id", input.campaignId);
  text("execution_cost_task_class", input.taskClass);
  text("execution_cost_route", input.route);
  integer("execution_cost_attempt_number", input.attemptNumber, 1);
  integer("execution_cost_retry_number", input.retryNumber);
  if (input.fallbackFromExecutionId) {
    text("execution_cost_fallback_execution_id", input.fallbackFromExecutionId);
  }
  if (!new Set<ExecutionOutcomeStatus>(["accepted", "rejected", "unresolved"]).has(input.outcomeStatus)) {
    throw new Error("execution_cost_outcome_status_invalid");
  }
  if (input.outcomeStatus === "accepted") {
    if (!input.acceptedOutcomeId) throw new Error("execution_cost_accepted_outcome_required");
    text("execution_cost_accepted_outcome_id", input.acceptedOutcomeId);
  } else if (input.acceptedOutcomeId) {
    throw new Error("execution_cost_accepted_outcome_invalid");
  }
  integer("execution_cost_input_tokens", input.inputTokens);
  integer("execution_cost_output_tokens", input.outputTokens);
  integer("execution_cost_cache_read_tokens", input.cacheReadTokens);
  integer("execution_cost_cache_write_tokens", input.cacheWriteTokens);
  text("execution_cost_model_id", input.modelId);
  text("execution_cost_model_price_version", input.modelPriceVersion);
  integer("execution_cost_model_money", input.modelCostMoneyMicros);
  integer("execution_cost_cache_money", input.cacheCostMoneyMicros);
  integer("execution_cost_gpu_millis", input.gpuMillis);
  integer("execution_cost_gpu_money", input.gpuCostMoneyMicros);
  integer("execution_cost_graph_money", input.graphCostMoneyMicros);
  integer("execution_cost_sandbox_money", input.sandboxCostMoneyMicros);
  integer("execution_cost_verification_money", input.verificationCostMoneyMicros);
  const currency = text("execution_cost_currency", input.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("execution_cost_currency_invalid");
  text("execution_cost_actor_principal_id", input.actorPrincipalId);
  timestamp("execution_cost_created_at", input.createdAt);
  if (input.missionId) text("execution_cost_mission_id", input.missionId);
  // A component that was not measured must carry zero money-micros. This keeps
  // the arithmetic total honest (unmeasured contributes 0) while the flag stays
  // the sole carrier of "not measured". A measured=false component with a
  // nonzero cost is a contradiction and is rejected — never silently coerced.
  const consistency: Array<[string, boolean, number]> = [
    ["model", input.modelCostMeasured ?? true, input.modelCostMoneyMicros],
    ["cache", input.cacheCostMeasured ?? true, input.cacheCostMoneyMicros],
    ["gpu", input.gpuCostMeasured ?? true, input.gpuCostMoneyMicros],
    ["graph", input.graphCostMeasured ?? true, input.graphCostMoneyMicros],
    ["sandbox", input.sandboxCostMeasured ?? true, input.sandboxCostMoneyMicros],
    ["verification", input.verificationCostMeasured ?? true, input.verificationCostMoneyMicros],
  ];
  for (const [name, measured, micros] of consistency) {
    if (!measured && micros !== 0) {
      throw new Error(`execution_cost_${name}_unmeasured_nonzero`);
    }
  }
  return safeSum("execution_cost_total", [
    input.modelCostMoneyMicros,
    input.cacheCostMoneyMicros,
    input.gpuCostMoneyMicros,
    input.graphCostMoneyMicros,
    input.sandboxCostMoneyMicros,
    input.verificationCostMoneyMicros,
  ]);
}

export function recordActualExecutionCost(
  db: AppDb,
  input: ActualExecutionCostInput,
): ActualExecutionCostEntry {
  const totalCostMoneyMicros = validateInput(input);
  const replay = one<CostRow>(
    db,
    `SELECT * FROM actual_execution_cost_entries
     WHERE tenant_id = ? AND idempotency_key = ?`,
    [input.tenantId, input.idempotencyKey],
  );
  if (replay) {
    const entry = entryFromRow(replay);
    if (!sameRequest(entry, input, totalCostMoneyMicros)) {
      throw new Error("execution_cost_idempotency_conflict");
    }
    return entry;
  }

  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const actor = one<{ id: string }>(
      db,
      `SELECT id FROM principals
       WHERE id = ? AND tenant_id = ?
         AND (expires_at IS NULL OR expires_at > ?)
         AND (revoked_at IS NULL OR revoked_at > ?)`,
      [input.actorPrincipalId, input.tenantId, input.createdAt, input.createdAt],
    );
    if (!actor) throw new Error("execution_cost_actor_tenant_mismatch");

    const duplicateExecution = one<CostRow>(
      db,
      `SELECT * FROM actual_execution_cost_entries
       WHERE tenant_id = ? AND execution_id = ?`,
      [input.tenantId, input.executionId],
    );
    if (duplicateExecution) throw new Error("execution_cost_execution_conflict");

    if (input.fallbackFromExecutionId) {
      const prior = one<{ task_id: string; attempt_number: number }>(
        db,
        `SELECT task_id, attempt_number FROM actual_execution_cost_entries
         WHERE tenant_id = ? AND execution_id = ?`,
        [input.tenantId, input.fallbackFromExecutionId],
      );
      if (!prior || prior.task_id !== input.taskId || prior.attempt_number >= input.attemptNumber) {
        throw new Error("execution_cost_fallback_reference_invalid");
      }
    }

    const previous = one<{ entry_sequence: number; entry_hash: string }>(
      db,
      `SELECT entry_sequence, entry_hash FROM actual_execution_cost_entries
       WHERE tenant_id = ? ORDER BY entry_sequence DESC LIMIT 1`,
      [input.tenantId],
    );
    const entrySequence = (previous?.entry_sequence ?? 0) + 1;
    const entry: Omit<ActualExecutionCostEntry, "entryHash"> = Object.freeze({
      id: input.id,
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      executionId: input.executionId,
      taskId: input.taskId,
      campaignId: input.campaignId ?? null,
      taskClass: input.taskClass,
      route: input.route,
      attemptNumber: input.attemptNumber,
      retryNumber: input.retryNumber,
      fallbackFromExecutionId: input.fallbackFromExecutionId ?? null,
      outcomeStatus: input.outcomeStatus,
      acceptedOutcomeId: input.acceptedOutcomeId ?? null,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      modelId: input.modelId,
      modelPriceVersion: input.modelPriceVersion,
      modelCostMoneyMicros: input.modelCostMoneyMicros,
      cacheCostMoneyMicros: input.cacheCostMoneyMicros,
      gpuMillis: input.gpuMillis,
      gpuCostMoneyMicros: input.gpuCostMoneyMicros,
      graphCostMoneyMicros: input.graphCostMoneyMicros,
      sandboxCostMoneyMicros: input.sandboxCostMoneyMicros,
      verificationCostMoneyMicros: input.verificationCostMoneyMicros,
      totalCostMoneyMicros,
      currency: input.currency.toUpperCase(),
      actorPrincipalId: input.actorPrincipalId,
      entrySequence,
      previousHash: previous?.entry_hash ?? null,
      createdAt: input.createdAt,
      missionId: input.missionId ?? null,
      modelCostMeasured: input.modelCostMeasured ?? true,
      cacheCostMeasured: input.cacheCostMeasured ?? true,
      gpuCostMeasured: input.gpuCostMeasured ?? true,
      graphCostMeasured: input.graphCostMeasured ?? true,
      sandboxCostMeasured: input.sandboxCostMeasured ?? true,
      verificationCostMeasured: input.verificationCostMeasured ?? true,
      costSchemaVersion: 2,
    });
    const entryHash = hashEntry(entry);
    db.raw.prepare(
      `INSERT INTO actual_execution_cost_entries
       (id, tenant_id, idempotency_key, execution_id, task_id, campaign_id,
        task_class, route, attempt_number, retry_number, fallback_from_execution_id,
        outcome_status, accepted_outcome_id, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, model_id, model_price_version,
        model_cost_money_micros, cache_cost_money_micros, gpu_millis,
        gpu_cost_money_micros, graph_cost_money_micros, sandbox_cost_money_micros,
        verification_cost_money_micros, total_cost_money_micros, currency,
        actor_principal_id, entry_sequence, prev_hash, entry_hash, created_at,
        mission_id, model_cost_measured, cache_cost_measured, gpu_cost_measured,
        graph_cost_measured, sandbox_cost_measured, verification_cost_measured,
        cost_schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.id,
      entry.tenantId,
      entry.idempotencyKey,
      entry.executionId,
      entry.taskId,
      entry.campaignId,
      entry.taskClass,
      entry.route,
      entry.attemptNumber,
      entry.retryNumber,
      entry.fallbackFromExecutionId,
      entry.outcomeStatus,
      entry.acceptedOutcomeId,
      entry.inputTokens,
      entry.outputTokens,
      entry.cacheReadTokens,
      entry.cacheWriteTokens,
      entry.modelId,
      entry.modelPriceVersion,
      entry.modelCostMoneyMicros,
      entry.cacheCostMoneyMicros,
      entry.gpuMillis,
      entry.gpuCostMoneyMicros,
      entry.graphCostMoneyMicros,
      entry.sandboxCostMoneyMicros,
      entry.verificationCostMoneyMicros,
      entry.totalCostMoneyMicros,
      entry.currency,
      entry.actorPrincipalId,
      entry.entrySequence,
      entry.previousHash,
      entryHash,
      entry.createdAt,
      entry.missionId,
      entry.modelCostMeasured ? 1 : 0,
      entry.cacheCostMeasured ? 1 : 0,
      entry.gpuCostMeasured ? 1 : 0,
      entry.graphCostMeasured ? 1 : 0,
      entry.sandboxCostMeasured ? 1 : 0,
      entry.verificationCostMeasured ? 1 : 0,
      entry.costSchemaVersion,
    );
    const inserted = one<CostRow>(
      db,
      `SELECT * FROM actual_execution_cost_entries WHERE id = ?`,
      [entry.id],
    );
    if (!inserted) throw new Error("execution_cost_insert_failed");
    if (owns) db.raw.exec("COMMIT");
    return entryFromRow(inserted);
  } catch (error) {
    if (owns) db.raw.exec("ROLLBACK");
    throw error;
  }
}

export type ExecutionCostFromRoutingLedgerInput = Readonly<{
  tenantId: string;
  /** The run whose routing_ledger rows carry the measured model cost/tokens. */
  sourceRunId: string;
  executionId: string;
  taskId: string;
  taskClass: string;
  route: string;
  actorPrincipalId: string;
  createdAt: string;
  campaignId?: string | null;
  missionId?: string | null;
  attemptNumber?: number;
  retryNumber?: number;
  outcomeStatus?: ExecutionOutcomeStatus;
  acceptedOutcomeId?: string | null;
  currency?: string;
  idempotencyKey?: string;
}>;

type LedgerAggregateRow = Readonly<{
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  measured_rows: number | null;
  model_id: string | null;
}>;

/**
 * Write one `actual_execution_cost_entries` row for a real execution, deriving
 * each component from what actually happened rather than estimating.
 *
 * The model component is sourced from the durable `routing_ledger` rows for the
 * run (the same measured feed `agent_run_meters` uses): its money-micros is the
 * summed charged `cost_usd` converted to integer micros, and it is marked
 * MEASURED only when at least one ledger row carried a cost. When no ledger row
 * did, the model component is UNMEASURED (flag false, 0 micros) — an honest
 * "we did not measure", never a fabricated zero.
 *
 * The other five components (cache, GPU, graph, sandbox, verification) have no
 * meter on this execution path today, so each is written UNMEASURED with 0
 * micros. As soon as a real meter exists for one, pass its measured cost through
 * `recordActualExecutionCost` directly (or extend this function) — the schema is
 * already shaped for it. Cache tokens are not separately reported by the router,
 * so cache_read/cache_write are 0 and the cache component stays unmeasured; the
 * provider's charge is captured whole in the model component.
 */
export function recordExecutionCostFromRoutingLedger(
  db: AppDb,
  input: ExecutionCostFromRoutingLedgerInput,
): ActualExecutionCostEntry {
  const tenantId = text("tenant_id", input.tenantId);
  const sourceRunId = text("execution_cost_source_run_id", input.sourceRunId);
  const aggregate =
    (one<LedgerAggregateRow>(
      db,
      `SELECT
         SUM(input_tokens) AS input_tokens,
         SUM(output_tokens) AS output_tokens,
         SUM(total_tokens) AS total_tokens,
         SUM(cost_usd) AS cost_usd,
         SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS measured_rows,
         MAX(selected_executor_id) AS model_id
       FROM routing_ledger
       WHERE tenant_id = ? AND run_id = ?`,
      [tenantId, sourceRunId],
    ) ?? {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cost_usd: null,
      measured_rows: 0,
      model_id: null,
    });

  const modelMeasured = (aggregate.measured_rows ?? 0) > 0;
  // USD is REAL in routing_ledger; convert to integer micros once, fail closed
  // on an unsafe value rather than writing a rounded lie.
  const modelCostMoneyMicros = modelMeasured
    ? (() => {
        const micros = Math.round((aggregate.cost_usd ?? 0) * 1_000_000);
        if (!Number.isSafeInteger(micros) || micros < 0) {
          throw new Error("execution_cost_model_micros_invalid");
        }
        return micros;
      })()
    : 0;

  const idempotencyKey =
    input.idempotencyKey ?? `execution-cost:routing-ledger:${input.executionId}`;
  const id = `execution-cost-${createHash("sha256")
    .update(`${tenantId}\n${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32)}`;

  return recordActualExecutionCost(db, {
    id,
    tenantId,
    idempotencyKey,
    executionId: input.executionId,
    taskId: input.taskId,
    campaignId: input.campaignId ?? null,
    taskClass: input.taskClass,
    route: input.route,
    attemptNumber: input.attemptNumber ?? 1,
    retryNumber: input.retryNumber ?? 0,
    fallbackFromExecutionId: null,
    outcomeStatus: input.outcomeStatus ?? "unresolved",
    acceptedOutcomeId: input.acceptedOutcomeId ?? null,
    inputTokens: modelMeasured ? aggregate.input_tokens ?? 0 : 0,
    outputTokens: modelMeasured ? aggregate.output_tokens ?? 0 : 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    modelId: aggregate.model_id ?? "routing_ledger_aggregate",
    modelPriceVersion: "routing_ledger",
    modelCostMoneyMicros,
    cacheCostMoneyMicros: 0,
    gpuMillis: 0,
    gpuCostMoneyMicros: 0,
    graphCostMoneyMicros: 0,
    sandboxCostMoneyMicros: 0,
    verificationCostMoneyMicros: 0,
    currency: input.currency ?? "USD",
    actorPrincipalId: input.actorPrincipalId,
    createdAt: input.createdAt,
    missionId: input.missionId ?? null,
    modelCostMeasured: modelMeasured,
    cacheCostMeasured: false,
    gpuCostMeasured: false,
    graphCostMeasured: false,
    sandboxCostMeasured: false,
    verificationCostMeasured: false,
  });
}

export function listActualExecutionCosts(
  db: AppDb,
  tenantId: string,
  limit = 500,
): ActualExecutionCostEntry[] {
  const bounded = Math.max(1, Math.min(Math.floor(limit), 5_000));
  return many<CostRow>(
    db,
    `SELECT * FROM actual_execution_cost_entries
     WHERE tenant_id = ? ORDER BY entry_sequence DESC LIMIT ?`,
    [tenantId, bounded],
  ).map(entryFromRow);
}

export function verifyExecutionCostIntegrity(
  db: AppDb,
  tenantId: string,
): ExecutionCostIntegrity {
  const entries = many<CostRow>(
    db,
    `SELECT * FROM actual_execution_cost_entries
     WHERE tenant_id = ? ORDER BY entry_sequence`,
    [tenantId],
  ).map(entryFromRow);
  let previousHash: string | null = null;
  let totalCostMoneyMicros = 0;
  for (const [index, entry] of entries.entries()) {
    if (entry.entrySequence !== index + 1 || entry.previousHash !== previousHash) {
      return {
        ok: false,
        checked: index,
        totalCostMoneyMicros,
        error: `execution_cost_chain_sequence:${entry.id}`,
      };
    }
    const components = safeSum("execution_cost_total", [
      entry.modelCostMoneyMicros,
      entry.cacheCostMoneyMicros,
      entry.gpuCostMoneyMicros,
      entry.graphCostMoneyMicros,
      entry.sandboxCostMoneyMicros,
      entry.verificationCostMoneyMicros,
    ]);
    if (components !== entry.totalCostMoneyMicros) {
      return {
        ok: false,
        checked: index,
        totalCostMoneyMicros,
        error: `execution_cost_component_total:${entry.id}`,
      };
    }
    const measurement: Array<[string, boolean, number]> = [
      ["model", entry.modelCostMeasured, entry.modelCostMoneyMicros],
      ["cache", entry.cacheCostMeasured, entry.cacheCostMoneyMicros],
      ["gpu", entry.gpuCostMeasured, entry.gpuCostMoneyMicros],
      ["graph", entry.graphCostMeasured, entry.graphCostMoneyMicros],
      ["sandbox", entry.sandboxCostMeasured, entry.sandboxCostMoneyMicros],
      ["verification", entry.verificationCostMeasured, entry.verificationCostMoneyMicros],
    ];
    for (const [name, measured, micros] of measurement) {
      if (!measured && micros !== 0) {
        return {
          ok: false,
          checked: index,
          totalCostMoneyMicros,
          error: `execution_cost_unmeasured_nonzero:${name}:${entry.id}`,
        };
      }
    }
    const { entryHash: _entryHash, ...hashInput } = entry;
    if (hashEntry(hashInput) !== entry.entryHash) {
      return {
        ok: false,
        checked: index,
        totalCostMoneyMicros,
        error: `execution_cost_chain_hash:${entry.id}`,
      };
    }
    totalCostMoneyMicros = safeSum("execution_cost_total", [
      totalCostMoneyMicros,
      entry.totalCostMoneyMicros,
    ]);
    previousHash = entry.entryHash;
  }
  return { ok: true, checked: entries.length, totalCostMoneyMicros };
}

function issueKey(issue: GrossMarginIncompleteAttribution): string {
  return `${issue.code}\u0000${issue.taskId ?? ""}\u0000${issue.sourceId ?? ""}`;
}

function addIssue(
  issues: Map<string, GrossMarginIncompleteAttribution>,
  issue: GrossMarginIncompleteAttribution,
) {
  issues.set(issueKey(issue), Object.freeze(issue));
}

/**
 * Resolve the revenue job for a mission-bound cost through persisted lineage.
 * The execution id alone is caller-controlled data and is never sufficient:
 * the job, MissionTask, Mission, and MissionTask creation event must all agree
 * inside the tenant before revenue may be attributed across task identifiers.
 */
function durableRevenueJobForCost(
  db: AppDb,
  entry: ActualExecutionCostEntry,
): string | null {
  if (!entry.missionId) return null;
  const row = one<{ job_id: string }>(
    db,
    `SELECT j.id AS job_id
     FROM jobs j
     JOIN mission_task mt
       ON mt.id = ?
      AND mt.tenant_id = j.tenant_id
      AND mt.mission_id = ?
     JOIN mission m
       ON m.id = mt.mission_id
      AND m.tenant_id = mt.tenant_id
     WHERE j.id = ?
       AND j.tenant_id = ?
       AND EXISTS (
         SELECT 1
         FROM domain_events e
         WHERE e.tenant_id = j.tenant_id
           AND e.aggregate_type = 'mission_task'
           AND e.aggregate_id = mt.id
           AND e.event_type = 'mission_task.created'
           AND e.correlation_id = j.id
       )`,
    [entry.taskId, entry.missionId, entry.executionId, entry.tenantId],
  );
  return row?.job_id ?? null;
}

export function reconcileGrossMargin(
  db: AppDb,
  tenantId: string,
): GrossMarginReconciliation {
  text("tenant_id", tenantId);
  const usageIntegrity = reconcileUsageLedger(db, tenantId);
  const costIntegrity = verifyExecutionCostIntegrity(db, tenantId);
  const issues = new Map<string, GrossMarginIncompleteAttribution>();
  if (!usageIntegrity.ok) {
    addIssue(issues, {
      code: "usage_ledger_integrity",
      taskId: null,
      sourceId: usageIntegrity.error ?? null,
    });
  }
  if (!costIntegrity.ok) {
    addIssue(issues, {
      code: "cost_ledger_integrity",
      taskId: null,
      sourceId: costIntegrity.error ?? null,
    });
  }

  const revenueRows = many<UsageRevenueRow>(
    db,
    `SELECT u.id, u.entry_type, u.task_id, u.campaign_id, u.price_version,
            u.consumed_mcu_micros_delta, p.currency,
            p.price_per_mcu_money_micros
     FROM usage_ledger_entries u
     LEFT JOIN usage_price_versions p
       ON p.id = u.price_version AND p.tenant_id = u.tenant_id
     WHERE u.tenant_id = ?
       AND u.entry_type IN ('settlement', 'adjustment', 'credit')
     ORDER BY u.entry_sequence`,
    [tenantId],
  );
  const costEntries = many<CostRow>(
    db,
    `SELECT * FROM actual_execution_cost_entries
     WHERE tenant_id = ? ORDER BY entry_sequence`,
    [tenantId],
  ).map(entryFromRow);
  const currencies = new Set<string>();
  const taskRevenue = new Map<string, TaskRevenue>();
  let settledMcuMicros = 0;
  let creditedMcuMicros = 0;
  let adjustedMcuMicros = 0;
  let settledRevenueMoneyMicros = 0;
  let creditMoneyMicros = 0;
  let adjustmentMoneyMicros = 0;
  let revenueComplete = true;

  for (const row of revenueRows) {
    let task = taskRevenue.get(row.task_id);
    if (!task) {
      task = {
        taskId: row.task_id,
        campaignIds: new Set(),
        settledMcuMicros: 0,
        creditedMcuMicros: 0,
        adjustedMcuMicros: 0,
        settledRevenueMoneyMicros: 0,
        creditMoneyMicros: 0,
        adjustmentMoneyMicros: 0,
        netRevenueMoneyMicros: 0,
        complete: true,
      };
      taskRevenue.set(row.task_id, task);
    }
    task.campaignIds.add(row.campaign_id);
    if (row.currency === null || row.price_per_mcu_money_micros === null) {
      revenueComplete = false;
      task.complete = false;
      addIssue(issues, {
        code: "usage_price_version_missing",
        taskId: row.task_id,
        sourceId: row.id,
      });
      continue;
    }
    currencies.add(row.currency);
    const money = moneyForMcu(
      row.consumed_mcu_micros_delta,
      row.price_per_mcu_money_micros,
    );
    if (row.entry_type === "settlement") {
      task.settledMcuMicros = safeSum("gross_margin_mcu", [
        task.settledMcuMicros,
        row.consumed_mcu_micros_delta,
      ]);
      task.settledRevenueMoneyMicros = safeSum("gross_margin_money", [
        task.settledRevenueMoneyMicros,
        money,
      ]);
      settledMcuMicros = safeSum("gross_margin_mcu", [
        settledMcuMicros,
        row.consumed_mcu_micros_delta,
      ]);
      settledRevenueMoneyMicros = safeSum("gross_margin_money", [
        settledRevenueMoneyMicros,
        money,
      ]);
    } else if (row.entry_type === "credit") {
      const mcu = -row.consumed_mcu_micros_delta;
      const credit = -money;
      task.creditedMcuMicros = safeSum("gross_margin_mcu", [task.creditedMcuMicros, mcu]);
      task.creditMoneyMicros = safeSum("gross_margin_money", [task.creditMoneyMicros, credit]);
      creditedMcuMicros = safeSum("gross_margin_mcu", [creditedMcuMicros, mcu]);
      creditMoneyMicros = safeSum("gross_margin_money", [creditMoneyMicros, credit]);
    } else {
      task.adjustedMcuMicros = safeSum("gross_margin_mcu", [
        task.adjustedMcuMicros,
        row.consumed_mcu_micros_delta,
      ]);
      task.adjustmentMoneyMicros = safeSum("gross_margin_money", [
        task.adjustmentMoneyMicros,
        money,
      ]);
      adjustedMcuMicros = safeSum("gross_margin_mcu", [
        adjustedMcuMicros,
        row.consumed_mcu_micros_delta,
      ]);
      adjustmentMoneyMicros = safeSum("gross_margin_money", [
        adjustmentMoneyMicros,
        money,
      ]);
    }
    task.netRevenueMoneyMicros = safeSum("gross_margin_money", [
      task.settledRevenueMoneyMicros,
      -task.creditMoneyMicros,
      task.adjustmentMoneyMicros,
    ]);
  }

  for (const entry of costEntries) currencies.add(entry.currency);
  if (currencies.size > 1) {
    addIssue(issues, { code: "currency_mismatch", taskId: null, sourceId: null });
  }

  const rawCostsByTask = new Map<string, ActualExecutionCostEntry[]>();
  for (const entry of costEntries) {
    const entries = rawCostsByTask.get(entry.taskId) ?? [];
    entries.push(entry);
    rawCostsByTask.set(entry.taskId, entries);
  }

  // A production run is admitted and settled before its MissionTask exists, so
  // usage carries the stable job/run id while mission-bound cost rows carry the
  // MissionTask id and retain that same job id as executionId. Bridge only that
  // exact, tenant-local identity. Ambiguous candidates remain separate and the
  // existing missing-cost / missing-settlement reasons keep the report closed.
  const candidateRevenueTasksByCostTask = new Map<string, Set<string>>();
  for (const [costTaskId, entries] of rawCostsByTask) {
    const candidates = new Set<string>();
    if (taskRevenue.has(costTaskId)) candidates.add(costTaskId);
    for (const entry of entries) {
      const durableJobId = durableRevenueJobForCost(db, entry);
      if (durableJobId && taskRevenue.has(durableJobId)) candidates.add(durableJobId);
    }
    candidateRevenueTasksByCostTask.set(costTaskId, candidates);
  }
  const costTasksByRevenueTask = new Map<string, Set<string>>();
  const ambiguousReconciliationTasks = new Set<string>();
  for (const [costTaskId, candidates] of candidateRevenueTasksByCostTask) {
    if (candidates.size !== 1) {
      if (candidates.size > 1) {
        ambiguousReconciliationTasks.add(costTaskId);
        for (const candidate of candidates) ambiguousReconciliationTasks.add(candidate);
        addIssue(issues, {
          code: "task_attribution_ambiguous",
          taskId: costTaskId,
          sourceId: null,
        });
      }
      continue;
    }
    const revenueTaskId = [...candidates][0]!;
    const costTasks = costTasksByRevenueTask.get(revenueTaskId) ?? new Set<string>();
    costTasks.add(costTaskId);
    costTasksByRevenueTask.set(revenueTaskId, costTasks);
  }
  const reconciliationTaskByCostTask = new Map<string, string>();
  for (const [costTaskId, candidates] of candidateRevenueTasksByCostTask) {
    if (candidates.size !== 1) continue;
    const revenueTaskId = [...candidates][0]!;
    const matchingCostTasks = costTasksByRevenueTask.get(revenueTaskId);
    if (matchingCostTasks?.size !== 1) {
      ambiguousReconciliationTasks.add(revenueTaskId);
      for (const matchingCostTask of matchingCostTasks ?? []) {
        ambiguousReconciliationTasks.add(matchingCostTask);
      }
      addIssue(issues, {
        code: "task_attribution_ambiguous",
        taskId: revenueTaskId,
        sourceId: null,
      });
      continue;
    }
    reconciliationTaskByCostTask.set(costTaskId, revenueTaskId);
  }

  const costsByTask = new Map<string, ActualExecutionCostEntry[]>();
  for (const entry of costEntries) {
    const reconciliationTaskId = reconciliationTaskByCostTask.get(entry.taskId) ?? entry.taskId;
    const entries = costsByTask.get(reconciliationTaskId) ?? [];
    entries.push(entry);
    costsByTask.set(reconciliationTaskId, entries);
    if (
      !entry.modelCostMeasured ||
      !entry.cacheCostMeasured ||
      !entry.gpuCostMeasured ||
      !entry.graphCostMeasured ||
      !entry.sandboxCostMeasured ||
      !entry.verificationCostMeasured
    ) {
      addIssue(issues, {
        code: "execution_cost_component_unmeasured",
        taskId: reconciliationTaskId,
        sourceId: entry.id,
      });
    }
  }

  let unattributedRevenueMoneyMicros = 0;
  const taskComplete = new Map<string, boolean>();
  for (const taskId of new Set([...taskRevenue.keys(), ...costsByTask.keys()])) {
    const revenue = taskRevenue.get(taskId);
    const costs = costsByTask.get(taskId) ?? [];
    const accepted = costs.filter((entry) => entry.outcomeStatus === "accepted");
    let complete = (revenue?.complete ?? true) && !ambiguousReconciliationTasks.has(taskId);
    if (costs.some((entry) =>
      !entry.modelCostMeasured ||
      !entry.cacheCostMeasured ||
      !entry.gpuCostMeasured ||
      !entry.graphCostMeasured ||
      !entry.sandboxCostMeasured ||
      !entry.verificationCostMeasured
    )) {
      complete = false;
    }
    if (revenue && costs.length === 0) {
      complete = false;
      addIssue(issues, { code: "actual_cost_missing", taskId, sourceId: null });
    }
    if (revenue && accepted.length === 0) {
      complete = false;
      addIssue(issues, { code: "accepted_outcome_missing", taskId, sourceId: null });
    } else if (accepted.length > 1) {
      complete = false;
      addIssue(issues, { code: "accepted_outcome_ambiguous", taskId, sourceId: null });
    }
    if (accepted.length > 0 && (!revenue || revenue.settledMcuMicros === 0)) {
      complete = false;
      addIssue(issues, {
        code: "settlement_missing",
        taskId,
        sourceId: accepted[0]?.id ?? null,
      });
    }
    const campaignIds = new Set<string | null>(revenue?.campaignIds ?? []);
    for (const cost of costs) campaignIds.add(cost.campaignId);
    if (campaignIds.size > 1) {
      complete = false;
      addIssue(issues, { code: "campaign_mismatch", taskId, sourceId: null });
    }
    taskComplete.set(taskId, complete);
    if (revenue && !complete) {
      unattributedRevenueMoneyMicros = safeSum("gross_margin_money", [
        unattributedRevenueMoneyMicros,
        revenue.netRevenueMoneyMicros,
      ]);
    }
  }

  const attributions = costEntries.map<GrossMarginAttribution>((entry) => {
    const reconciliationTaskId = reconciliationTaskByCostTask.get(entry.taskId) ?? entry.taskId;
    const revenue = taskRevenue.get(reconciliationTaskId);
    const complete = taskComplete.get(reconciliationTaskId) ?? false;
    const attributedRevenue = complete
      ? entry.outcomeStatus === "accepted"
        ? revenue?.netRevenueMoneyMicros ?? 0
        : 0
      : null;
    return Object.freeze({
      costEntryId: entry.id,
      executionId: entry.executionId,
      tenantId: entry.tenantId,
      taskId: entry.taskId,
      campaignId: entry.campaignId,
      taskClass: entry.taskClass,
      route: entry.route,
      attemptNumber: entry.attemptNumber,
      retryNumber: entry.retryNumber,
      fallbackFromExecutionId: entry.fallbackFromExecutionId,
      outcomeStatus: entry.outcomeStatus,
      acceptedOutcomeId: entry.acceptedOutcomeId,
      actualCostMoneyMicros: entry.totalCostMoneyMicros,
      attributedNetRevenueMoneyMicros: attributedRevenue,
      attributedGrossMarginMoneyMicros:
        attributedRevenue === null ? null : attributedRevenue - entry.totalCostMoneyMicros,
    });
  });

  const componentTotal = (select: (entry: ActualExecutionCostEntry) => number) =>
    costEntries.reduce(
      (sum, entry) => safeSum("execution_cost_total", [sum, select(entry)]),
      0,
    );
  const actualCostMoneyMicros = componentTotal((entry) => entry.totalCostMoneyMicros);
  const netRevenueMoneyMicros = revenueComplete
    ? safeSum("gross_margin_money", [
        settledRevenueMoneyMicros,
        -creditMoneyMicros,
        adjustmentMoneyMicros,
      ])
    : null;
  const incompleteAttributions = [...issues.values()].sort(
    (left, right) => issueKey(left).localeCompare(issueKey(right)),
  );
  const complete = incompleteAttributions.length === 0;
  const exactGrossMarginMoneyMicros =
    netRevenueMoneyMicros === null ||
    !usageIntegrity.ok ||
    !costIntegrity.ok ||
    incompleteAttributions.length > 0
      ? null
      : safeSum("gross_margin_money", [netRevenueMoneyMicros, -actualCostMoneyMicros]);

  return Object.freeze({
    tenantId,
    complete,
    currency: currencies.size === 1 ? [...currencies][0]! : null,
    usageIntegrity,
    costIntegrity,
    settledMcuMicros,
    creditedMcuMicros,
    adjustedMcuMicros,
    settledRevenueMoneyMicros: revenueComplete ? settledRevenueMoneyMicros : null,
    creditMoneyMicros: revenueComplete ? creditMoneyMicros : null,
    adjustmentMoneyMicros: revenueComplete ? adjustmentMoneyMicros : null,
    netRevenueMoneyMicros,
    actualCostMoneyMicros,
    modelCostMoneyMicros: componentTotal((entry) => entry.modelCostMoneyMicros),
    cacheCostMoneyMicros: componentTotal((entry) => entry.cacheCostMoneyMicros),
    gpuCostMoneyMicros: componentTotal((entry) => entry.gpuCostMoneyMicros),
    graphCostMoneyMicros: componentTotal((entry) => entry.graphCostMoneyMicros),
    sandboxCostMoneyMicros: componentTotal((entry) => entry.sandboxCostMoneyMicros),
    verificationCostMoneyMicros: componentTotal(
      (entry) => entry.verificationCostMoneyMicros,
    ),
    exactGrossMarginMoneyMicros,
    attributedGrossMarginMoneyMicros: complete ? exactGrossMarginMoneyMicros : null,
    unattributedRevenueMoneyMicros,
    incompleteAttributions: Object.freeze(incompleteAttributions),
    attributions: Object.freeze(attributions),
  });
}
