import type { ReconciledUsageEvidence } from "./invoice-boundary.js";

export type BillableUsageLedgerEntry = Readonly<{
  id: string;
  tenantId: string;
  taskId: string;
  priceVersion: string;
  consumedMcuMicrosDelta: number;
  entryHash: string;
  createdAt: string;
}>;

export type UsageLedgerReconciliation = Readonly<{
  ok: boolean;
  checked: number;
  error?: string;
}>;

function time(name: string, value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name}_invalid`);
  return parsed;
}

function required(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error(`${name}_invalid`);
  return normalized;
}

/**
 * Converts the append-only usage ledger's verified result into the narrow,
 * immutable evidence accepted by invoice creation. It does not infer accepted
 * outcomes: callers must supply the independently reconciled accepted task IDs.
 */
export function buildReconciledUsageEvidence(input: Readonly<{
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  priceVersion: string;
  currency: string;
  entries: readonly BillableUsageLedgerEntry[];
  ledgerReconciliation: UsageLedgerReconciliation;
  acceptedTaskIds: readonly string[];
}>): ReconciledUsageEvidence {
  const tenantId = required("billing_tenant_id", input.tenantId);
  const priceVersion = required("billing_price_version", input.priceVersion);
  const currency = required("billing_currency", input.currency);
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("billing_currency_invalid");
  const start = time("billing_usage_period_start", input.periodStart);
  const end = time("billing_usage_period_end", input.periodEnd);
  if (end <= start) throw new Error("billing_usage_period_invalid");
  if (!input.ledgerReconciliation.ok || input.ledgerReconciliation.checked !== input.entries.length) {
    throw new Error("billing_usage_ledger_unverified");
  }
  const accepted = new Set(input.acceptedTaskIds.map((id) => required("billing_accepted_task_id", id)));
  const selected = input.entries.filter((entry) => {
    if (entry.tenantId !== tenantId) throw new Error("billing_usage_tenant_mismatch");
    if (!/^[a-f0-9]{64}$/.test(entry.entryHash)) throw new Error("billing_ledger_entry_hash_invalid");
    const at = time("billing_usage_entry_created_at", entry.createdAt);
    return at >= start && at < end && entry.consumedMcuMicrosDelta !== 0;
  });
  if (selected.length < 1) throw new Error("billing_usage_entries_required");
  if (selected.some((entry) => entry.priceVersion !== priceVersion)) {
    throw new Error("billing_usage_price_mismatch");
  }
  const ids = selected.map((entry) => required("billing_ledger_entry_id", entry.id));
  if (new Set(ids).size !== ids.length) throw new Error("billing_usage_entry_duplicate");
  const unmatchedTaskIds = [...new Set(selected
    .map((entry) => required("billing_usage_task_id", entry.taskId))
    .filter((taskId) => !accepted.has(taskId)))].sort();
  let consumed = 0n;
  for (const entry of selected) {
    if (!Number.isSafeInteger(entry.consumedMcuMicrosDelta)) throw new Error("billing_usage_mcu_invalid");
    consumed += BigInt(entry.consumedMcuMicrosDelta);
  }
  if (consumed < 0n || consumed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("billing_usage_mcu_overflow");
  }
  const ledgerHeadHash = input.entries.at(-1)?.entryHash;
  if (!ledgerHeadHash) throw new Error("billing_ledger_head_hash_invalid");
  return Object.freeze({
    tenantId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    priceVersion,
    currency,
    consumedMcuMicros: Number(consumed),
    ledgerEntryIds: Object.freeze([...ids].sort()),
    ledgerHeadHash,
    ledgerIntegrityOk: true,
    matchedTaskCount: new Set(selected.map((entry) => entry.taskId)).size - unmatchedTaskIds.length,
    unmatchedTaskIds: Object.freeze(unmatchedTaskIds),
  });
}
