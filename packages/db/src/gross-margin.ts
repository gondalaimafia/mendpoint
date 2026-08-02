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
> & {
  campaignId?: string | null;
  fallbackFromExecutionId?: string | null;
  acceptedOutcomeId?: string | null;
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
  });
}

function hashEntry(entry: Omit<ActualExecutionCostEntry, "entryHash">): string {
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
    entry.actorPrincipalId === input.actorPrincipalId
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

  db.raw.exec("BEGIN IMMEDIATE");
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
        actor_principal_id, entry_sequence, prev_hash, entry_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
    const inserted = one<CostRow>(
      db,
      `SELECT * FROM actual_execution_cost_entries WHERE id = ?`,
      [entry.id],
    );
    if (!inserted) throw new Error("execution_cost_insert_failed");
    db.raw.exec("COMMIT");
    return entryFromRow(inserted);
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
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

  const costsByTask = new Map<string, ActualExecutionCostEntry[]>();
  for (const entry of costEntries) {
    const entries = costsByTask.get(entry.taskId) ?? [];
    entries.push(entry);
    costsByTask.set(entry.taskId, entries);
  }

  let unattributedRevenueMoneyMicros = 0;
  const taskComplete = new Map<string, boolean>();
  for (const taskId of new Set([...taskRevenue.keys(), ...costsByTask.keys()])) {
    const revenue = taskRevenue.get(taskId);
    const costs = costsByTask.get(taskId) ?? [];
    const accepted = costs.filter((entry) => entry.outcomeStatus === "accepted");
    let complete = revenue?.complete ?? true;
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
    const revenue = taskRevenue.get(entry.taskId);
    const complete = taskComplete.get(entry.taskId) ?? false;
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
