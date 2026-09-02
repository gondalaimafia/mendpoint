import { createHash } from "node:crypto";

export const MCU_VERSION = "mcu-v1" as const;
export const MCU_MICROS = 1_000_000;
export const MCU_FINANCE_AUTHORIZATION_VERSION = "mcu-finance-authorization-v1" as const;

export const MCU_SCHEDULE_V1 = Object.freeze({
  version: MCU_VERSION,
  effectiveAt: "2026-08-02T00:00:00.000Z",
  approval: Object.freeze({
    requiredRole: "finance_owner",
    immutableAfterUse: true,
    replacementRequiresNewVersion: true,
  }),
  settlement: Object.freeze({
    formulaVersion: "mcu-formula-v1",
    priceVersion: "reference-cost-2026-08-02.v1",
  }),
  weights: Object.freeze({
    graphObjectsPerMcu: 10_000,
    retrievalBytesPerMcu: 10_000_000,
    modelUsdPerMcu: 0.01,
    sandboxVcpuMinutesPerMcu: 1,
    sandboxGibMinutesPerMcu: 2,
    verificationVcpuMinutesPerMcu: 1,
    verificationGibMinutesPerMcu: 2,
    retainedVerificationBytesPerMcu: 100_000_000,
  }),
  examples: Object.freeze([
    Object.freeze({ label: "Graph scan", work: Object.freeze({ graphObjects: 10_001 }), expectedMicros: 2_000_000 }),
    Object.freeze({ label: "Model execution", work: Object.freeze({ modelCostUsd: 0.025 }), expectedMicros: 2_500_000 }),
    Object.freeze({ label: "Verification", work: Object.freeze({ verificationVcpuMinutes: 0.5, verificationGibMinutes: 1 }), expectedMicros: 1_000_000 }),
  ]),
});

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function mcuScheduleDigest(schedule: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(schedule), "utf8").digest("hex")}`;
}

export const MCU_SCHEDULE_DIGEST = mcuScheduleDigest(MCU_SCHEDULE_V1);

export const MCU_LEDGER_ENTRY_TYPES = [
  "reservation",
  "settlement",
  "release",
  "adjustment",
  "credit",
] as const;

export type McuLedgerEntryType = typeof MCU_LEDGER_ENTRY_TYPES[number];

export type McuFinanceAuthorization = Readonly<{
  schemaVersion: typeof MCU_FINANCE_AUTHORIZATION_VERSION;
  approvalId: string;
  approvedByPrincipalId: string;
  approvedByRole: "finance_owner";
  tenantId: string;
  invoiceReference: string;
  actorId: string;
  consumedMcuMicrosDelta: number;
  reasonCode: string;
  entryOccurredAt: string;
  approvedAt: string;
  authorizationDigest: string;
}>;

export type McuFinanceAuthorizationInput = Omit<McuFinanceAuthorization, "authorizationDigest">;

export type McuFinanceAuthorizationVerifier = (
  authorization: McuFinanceAuthorization,
) => boolean;

export type McuLedgerEntry = {
  id: string;
  tenantId: string;
  entryType: McuLedgerEntryType;
  entitlementId: string;
  idempotencyKey: string;
  taskId: string;
  campaignId: string | null;
  reservationId: string | null;
  priceVersion: string;
  formulaVersion: string;
  formulaDigest: string;
  reservedMcuMicrosDelta: number;
  consumedMcuMicrosDelta: number;
  invoiceReference: string | null;
  entrySequence: number;
  actorId: string;
  reasonCode: string;
  occurredAt: string;
  financeAuthorization?: McuFinanceAuthorization | null;
  previousEntryHash: string | null;
  entryHash: string;
};

export type McuLedgerEntryInput = Omit<McuLedgerEntry,
  "id" | "priceVersion" | "formulaVersion" | "formulaDigest" |
  "entrySequence" | "previousEntryHash" | "entryHash" | "financeAuthorization"> & {
    financeAuthorization?: McuFinanceAuthorization | null;
  };

export type McuLedgerLifecycle = {
  scheduleVersion: typeof MCU_VERSION;
  scheduleDigest: string;
  entries: McuLedgerEntry[];
};

export type McuLedgerReconciliation = Readonly<{
  scheduleVersion: typeof MCU_VERSION;
  scheduleDigest: string;
  tenantId: string;
  entitlementId: string;
  taskId: string;
  campaignId: string | null;
  priceVersion: string;
  formulaVersion: string;
  formulaDigest: string;
  entryCount: number;
  ledgerHeadHash: string;
  firstOccurredAt: string;
  lastOccurredAt: string;
  actorIds: readonly string[];
  reasonCodes: readonly string[];
  financeAuthorizationDigests: readonly string[];
  reservationMcuMicros: number;
  settledMcuMicros: number;
  adjustmentMcuMicros: number;
  creditedMcuMicros: number;
  outstandingReservationMcuMicros: number;
  invoiceMappings: ReadonlyArray<Readonly<{
    invoiceReference: string;
    mcuMicros: number;
    sourceEntryIds: readonly string[];
    settledEntryIds: readonly string[];
  }>>;
  reconciled: true;
}>;

function requiredLedgerId(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)
  ) {
    throw new Error(`${field}_invalid`);
  }
}

function mcuEntryId(input: Omit<McuLedgerEntry, "id" | "entryHash">): string {
  return `mcu-entry-${createHash("sha256")
    .update(canonicalJson(input), "utf8")
    .digest("hex")}`;
}

export function mcuLedgerEntryDigest(entry: Omit<McuLedgerEntry, "entryHash">): string {
  return `sha256:${createHash("sha256").update(canonicalJson(entry), "utf8").digest("hex")}`;
}

export function mcuFinanceAuthorizationDigest(
  authorization: McuFinanceAuthorizationInput,
): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(authorization), "utf8")
    .digest("hex")}`;
}

export function createMcuFinanceAuthorization(
  input: McuFinanceAuthorizationInput,
): McuFinanceAuthorization {
  return Object.freeze({
    ...input,
    authorizationDigest: mcuFinanceAuthorizationDigest(input),
  });
}

export function createMcuLedgerEntry(
  input: McuLedgerEntryInput,
  previous: McuLedgerEntry | null,
): McuLedgerEntry {
  const content: Omit<McuLedgerEntry, "id" | "entryHash"> = {
    ...input,
    priceVersion: MCU_SCHEDULE_V1.settlement.priceVersion,
    formulaVersion: MCU_SCHEDULE_V1.settlement.formulaVersion,
    formulaDigest: MCU_SCHEDULE_DIGEST,
    entrySequence: previous === null ? 1 : previous.entrySequence + 1,
    previousEntryHash: previous?.entryHash ?? null,
  };
  const id = mcuEntryId(content);
  const withoutHash = { id, ...content };
  return Object.freeze({
    ...withoutHash,
    entryHash: mcuLedgerEntryDigest(withoutHash),
  });
}

function ledgerMicros(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${field}_invalid`);
  return value;
}

function safeLedgerSum(values: readonly number[]): number {
  let result = 0;
  for (const value of values) {
    result += value;
    if (!Number.isSafeInteger(result)) throw new Error("mcu_ledger_overflow");
  }
  return result;
}

function validateFinanceAuthorization(
  entry: McuLedgerEntry,
  verifier: McuFinanceAuthorizationVerifier | undefined,
): void {
  const authorization = entry.financeAuthorization;
  if (!authorization) throw new Error("mcu_finance_authority_required");
  if (authorization.schemaVersion !== MCU_FINANCE_AUTHORIZATION_VERSION) {
    throw new Error("mcu_finance_authority_version_invalid");
  }
  requiredLedgerId(authorization.approvalId, "mcu_finance_approval_id");
  requiredLedgerId(authorization.approvedByPrincipalId, "mcu_finance_principal_id");
  requiredLedgerId(authorization.tenantId, "mcu_finance_tenant_id");
  requiredLedgerId(authorization.invoiceReference, "mcu_finance_invoice_reference");
  requiredLedgerId(authorization.actorId, "mcu_finance_actor_id");
  requiredLedgerId(authorization.reasonCode, "mcu_finance_reason_code");
  ledgerMicros(authorization.consumedMcuMicrosDelta, "mcu_finance_consumed_micros");
  if (authorization.approvedByRole !== MCU_SCHEDULE_V1.approval.requiredRole) {
    throw new Error("mcu_finance_authority_role_invalid");
  }
  const approvedAt = Date.parse(authorization.approvedAt);
  const entryOccurredAt = Date.parse(authorization.entryOccurredAt);
  if (
    !Number.isFinite(approvedAt) ||
    new Date(approvedAt).toISOString() !== authorization.approvedAt ||
    !Number.isFinite(entryOccurredAt) ||
    new Date(entryOccurredAt).toISOString() !== authorization.entryOccurredAt ||
    approvedAt > entryOccurredAt
  ) {
    throw new Error("mcu_finance_authority_time_invalid");
  }
  if (
    authorization.tenantId !== entry.tenantId ||
    authorization.invoiceReference !== entry.invoiceReference ||
    authorization.actorId !== entry.actorId ||
    authorization.consumedMcuMicrosDelta !== entry.consumedMcuMicrosDelta ||
    authorization.reasonCode !== entry.reasonCode ||
    authorization.entryOccurredAt !== entry.occurredAt
  ) {
    throw new Error("mcu_finance_authority_binding_invalid");
  }
  const { authorizationDigest, ...content } = authorization;
  if (authorizationDigest !== mcuFinanceAuthorizationDigest(content)) {
    throw new Error("mcu_finance_authority_digest_invalid");
  }
  if (!verifier) throw new Error("mcu_finance_authority_verifier_required");
  let authorized = false;
  try {
    authorized = verifier(authorization) === true;
  } catch {
    authorized = false;
  }
  if (!authorized) throw new Error("mcu_finance_authority_rejected");
}

export function reconcileMcuLedgerLifecycle(
  lifecycle: McuLedgerLifecycle,
  options: Readonly<{
    verifyFinanceAuthorization?: McuFinanceAuthorizationVerifier;
  }> = {},
): McuLedgerReconciliation {
  if (lifecycle.scheduleVersion !== MCU_VERSION) throw new Error("mcu_schedule_version_invalid");
  if (lifecycle.scheduleDigest !== MCU_SCHEDULE_DIGEST) {
    throw new Error("mcu_schedule_changed_without_version");
  }
  if (!Array.isArray(lifecycle.entries) || lifecycle.entries.length === 0) {
    throw new Error("mcu_ledger_entries_required");
  }
  const reservations = lifecycle.entries.filter((entry) => entry.entryType === "reservation");
  if (reservations.length !== 1) throw new Error("mcu_reservation_required");
  const reservation = reservations[0]!;
  if (lifecycle.entries[0] !== reservation) throw new Error("mcu_reservation_must_be_first");
  const ids = new Set<string>();
  const idempotencyKeys = new Set<string>();
  let previousSequence = 0;
  let previousEntry: McuLedgerEntry | null = null;
  let previousOccurredAt = 0;
  for (const entry of lifecycle.entries) {
    requiredLedgerId(entry.id, "mcu_ledger_id");
    requiredLedgerId(entry.idempotencyKey, "mcu_ledger_idempotency_key");
    if (ids.has(entry.id)) throw new Error("mcu_ledger_duplicate_id");
    if (idempotencyKeys.has(entry.idempotencyKey)) {
      throw new Error("mcu_ledger_duplicate_idempotency_key");
    }
    ids.add(entry.id);
    idempotencyKeys.add(entry.idempotencyKey);
    if (!MCU_LEDGER_ENTRY_TYPES.includes(entry.entryType)) {
      throw new Error("mcu_ledger_entry_type_invalid");
    }
    if (!Number.isSafeInteger(entry.entrySequence) || entry.entrySequence !== previousSequence + 1) {
      throw new Error("mcu_ledger_sequence_invalid");
    }
    previousSequence = entry.entrySequence;
    requiredLedgerId(entry.tenantId, "mcu_ledger_tenant_id");
    requiredLedgerId(entry.entitlementId, "mcu_ledger_entitlement_id");
    requiredLedgerId(entry.taskId, "mcu_ledger_task_id");
    if (entry.campaignId !== null) requiredLedgerId(entry.campaignId, "mcu_ledger_campaign_id");
    if (entry.reservationId !== null) {
      requiredLedgerId(entry.reservationId, "mcu_ledger_reservation_id");
    }
    requiredLedgerId(entry.priceVersion, "mcu_ledger_price_version");
    requiredLedgerId(entry.formulaVersion, "mcu_ledger_formula_version");
    requiredLedgerId(entry.actorId, "mcu_ledger_actor_id");
    requiredLedgerId(entry.reasonCode, "mcu_ledger_reason_code");
    if (
      entry.priceVersion !== MCU_SCHEDULE_V1.settlement.priceVersion ||
      entry.formulaVersion !== MCU_SCHEDULE_V1.settlement.formulaVersion ||
      entry.formulaDigest !== MCU_SCHEDULE_DIGEST
    ) {
      throw new Error("mcu_ledger_schedule_binding_invalid");
    }
    const occurredAt = Date.parse(entry.occurredAt);
    if (!Number.isFinite(occurredAt) || new Date(occurredAt).toISOString() !== entry.occurredAt) {
      throw new Error("mcu_ledger_occurred_at_invalid");
    }
    if (previousEntry && occurredAt < previousOccurredAt) {
      throw new Error("mcu_ledger_time_order_invalid");
    }
    if (entry.previousEntryHash !== (previousEntry?.entryHash ?? null)) {
      throw new Error("mcu_ledger_previous_hash_invalid");
    }
    const { entryHash, ...withoutHash } = entry;
    if (entryHash !== mcuLedgerEntryDigest(withoutHash)) {
      throw new Error("mcu_ledger_entry_hash_invalid");
    }
    const { id: _id, ...content } = withoutHash;
    if (entry.id !== mcuEntryId(content)) throw new Error("mcu_ledger_entry_id_invalid");
    ledgerMicros(entry.reservedMcuMicrosDelta, "mcu_ledger_reserved_micros");
    ledgerMicros(entry.consumedMcuMicrosDelta, "mcu_ledger_consumed_micros");
    previousEntry = entry;
    previousOccurredAt = occurredAt;
  }

  if (
    reservation.reservationId !== null ||
    reservation.reservedMcuMicrosDelta <= 0 ||
    reservation.consumedMcuMicrosDelta !== 0 ||
    reservation.invoiceReference !== null
  ) {
    throw new Error("mcu_reservation_invalid");
  }
  const identity = [
    reservation.tenantId,
    reservation.entitlementId,
    reservation.taskId,
    reservation.priceVersion,
    reservation.campaignId,
    reservation.formulaVersion,
    reservation.formulaDigest,
  ] as const;
  let reserved = reservation.reservedMcuMicrosDelta;
  let consumed = 0;
  let settled = 0;
  let adjusted = 0;
  let credited = 0;
  const invoices = new Map<string, {
    mcuMicros: number;
    sourceEntryIds: string[];
    settledEntryIds: string[];
  }>();

  for (const entry of lifecycle.entries.slice(1)) {
    if (
      entry.tenantId !== identity[0] ||
      entry.entitlementId !== identity[1] ||
      entry.taskId !== identity[2] ||
      entry.priceVersion !== identity[3] ||
      entry.campaignId !== identity[4] ||
      entry.formulaVersion !== identity[5] ||
      entry.formulaDigest !== identity[6]
    ) {
      throw new Error("mcu_ledger_binding_mismatch");
    }
    if (entry.entryType === "settlement" || entry.entryType === "release") {
      if (
        entry.reservationId !== reservation.id ||
        entry.reservedMcuMicrosDelta >= 0 ||
        -entry.reservedMcuMicrosDelta > reserved
      ) {
        throw new Error("mcu_reservation_transition_invalid");
      }
      reserved = safeLedgerSum([reserved, entry.reservedMcuMicrosDelta]);
      if (entry.entryType === "release") {
        if (entry.consumedMcuMicrosDelta !== 0 || entry.invoiceReference !== null) {
          throw new Error("mcu_release_invalid");
        }
        continue;
      }
      if (entry.consumedMcuMicrosDelta < 0) throw new Error("mcu_settlement_invalid");
      if (entry.consumedMcuMicrosDelta > -entry.reservedMcuMicrosDelta) {
        throw new Error("mcu_settlement_exceeds_released_reservation");
      }
      settled = safeLedgerSum([settled, entry.consumedMcuMicrosDelta]);
    } else {
      if (entry.reservationId !== null || entry.reservedMcuMicrosDelta !== 0) {
        throw new Error("mcu_ledger_adjustment_binding_invalid");
      }
      if (entry.entryType === "adjustment") {
        if (entry.consumedMcuMicrosDelta <= 0) throw new Error("mcu_adjustment_invalid");
        validateFinanceAuthorization(entry, options.verifyFinanceAuthorization);
        adjusted = safeLedgerSum([adjusted, entry.consumedMcuMicrosDelta]);
      } else if (entry.entryType === "credit") {
        if (entry.consumedMcuMicrosDelta >= 0) throw new Error("mcu_credit_invalid");
        validateFinanceAuthorization(entry, options.verifyFinanceAuthorization);
        credited = safeLedgerSum([credited, -entry.consumedMcuMicrosDelta]);
      } else {
        throw new Error("mcu_reservation_duplicate");
      }
    }
    if (
      entry.entryType !== "adjustment" &&
      entry.entryType !== "credit" &&
      entry.financeAuthorization !== null &&
      entry.financeAuthorization !== undefined
    ) {
      throw new Error("mcu_finance_authority_unexpected");
    }
    if (!entry.invoiceReference) throw new Error("mcu_invoice_mapping_required");
    requiredLedgerId(entry.invoiceReference, "mcu_invoice_reference");
    const invoice = invoices.get(entry.invoiceReference) ?? {
      mcuMicros: 0,
      sourceEntryIds: [],
      settledEntryIds: [],
    };
    invoice.mcuMicros = safeLedgerSum([invoice.mcuMicros, entry.consumedMcuMicrosDelta]);
    if (invoice.mcuMicros < 0) throw new Error("mcu_credit_exceeds_invoice_consumption");
    invoice.sourceEntryIds.push(entry.id);
    if (entry.entryType === "settlement") invoice.settledEntryIds.push(entry.id);
    invoices.set(entry.invoiceReference, invoice);
    consumed = safeLedgerSum([consumed, entry.consumedMcuMicrosDelta]);
    if (consumed < 0) throw new Error("mcu_credit_exceeds_consumption");
  }
  if (reserved !== 0) throw new Error("mcu_reservation_not_closed");

  return Object.freeze({
    scheduleVersion: MCU_VERSION,
    scheduleDigest: MCU_SCHEDULE_DIGEST,
    tenantId: reservation.tenantId,
    entitlementId: reservation.entitlementId,
    taskId: reservation.taskId,
    campaignId: reservation.campaignId,
    priceVersion: reservation.priceVersion,
    formulaVersion: reservation.formulaVersion,
    formulaDigest: reservation.formulaDigest,
    entryCount: lifecycle.entries.length,
    ledgerHeadHash: lifecycle.entries.at(-1)!.entryHash,
    firstOccurredAt: reservation.occurredAt,
    lastOccurredAt: lifecycle.entries.at(-1)!.occurredAt,
    actorIds: Object.freeze([...new Set(lifecycle.entries.map((entry) => entry.actorId))].sort(compareText)),
    reasonCodes: Object.freeze([...new Set(lifecycle.entries.map((entry) => entry.reasonCode))].sort(compareText)),
    financeAuthorizationDigests: Object.freeze(lifecycle.entries
      .map((entry) => entry.financeAuthorization?.authorizationDigest)
      .filter((digest): digest is string => digest !== undefined)
      .sort(compareText)),
    reservationMcuMicros: reservation.reservedMcuMicrosDelta,
    settledMcuMicros: settled,
    adjustmentMcuMicros: adjusted,
    creditedMcuMicros: credited,
    outstandingReservationMcuMicros: reserved,
    invoiceMappings: Object.freeze([...invoices.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([invoiceReference, invoice]) => Object.freeze({
        invoiceReference,
        mcuMicros: invoice.mcuMicros,
        sourceEntryIds: Object.freeze([...invoice.sourceEntryIds]),
        settledEntryIds: Object.freeze([...invoice.settledEntryIds]),
      }))),
    reconciled: true,
  });
}

export function assertMcuScheduleChange(input: Readonly<{
  currentVersion: string;
  nextVersion: string;
  approvedByRole: string;
  currentVersionHasUsage: boolean;
}>): void {
  if (input.currentVersion !== MCU_VERSION) throw new Error("mcu_current_version_unknown");
  if (!/^mcu-v[1-9][0-9]*$/.test(input.nextVersion) || input.nextVersion === input.currentVersion) {
    throw new Error("mcu_new_version_required");
  }
  if (input.approvedByRole !== MCU_SCHEDULE_V1.approval.requiredRole) {
    throw new Error("mcu_finance_approval_required");
  }
  if (!input.currentVersionHasUsage) throw new Error("mcu_change_without_usage_snapshot");
}

export type McuWork = Readonly<{
  graphObjects?: number;
  retrievalBytes?: number;
  modelCostUsd?: number;
  sandboxVcpuMinutes?: number;
  sandboxGibMinutes?: number;
  verificationVcpuMinutes?: number;
  verificationGibMinutes?: number;
  retainedVerificationBytes?: number;
}>;

export type McuBreakdown = Readonly<{
  version: typeof MCU_VERSION;
  graphMicros: number;
  retrievalMicros: number;
  modelMicros: number;
  sandboxMicros: number;
  verificationMicros: number;
  totalMicros: number;
}>;

function nonNegative(value: number | undefined, name: string): number {
  const normalized = value ?? 0;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`mcu_${name}_invalid`);
  }
  return normalized;
}

function micros(units: number): number {
  const value = Math.round(units * MCU_MICROS);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("mcu_overflow");
  return value;
}

export function calculateMcuV1(work: McuWork): McuBreakdown {
  const graphObjects = nonNegative(work.graphObjects, "graph_objects");
  const retrievalBytes = nonNegative(work.retrievalBytes, "retrieval_bytes");
  const modelCostUsd = nonNegative(work.modelCostUsd, "model_cost_usd");
  const sandboxVcpuMinutes = nonNegative(
    work.sandboxVcpuMinutes,
    "sandbox_vcpu_minutes",
  );
  const sandboxGibMinutes = nonNegative(
    work.sandboxGibMinutes,
    "sandbox_gib_minutes",
  );
  const verificationVcpuMinutes = nonNegative(
    work.verificationVcpuMinutes,
    "verification_vcpu_minutes",
  );
  const verificationGibMinutes = nonNegative(
    work.verificationGibMinutes,
    "verification_gib_minutes",
  );
  const retainedVerificationBytes = nonNegative(
    work.retainedVerificationBytes,
    "retained_verification_bytes",
  );

  const graphMicros = micros(
    graphObjects === 0 ? 0 : Math.ceil(graphObjects / MCU_SCHEDULE_V1.weights.graphObjectsPerMcu),
  );
  const retrievalMicros = micros(
    retrievalBytes === 0 ? 0 : Math.ceil(retrievalBytes / MCU_SCHEDULE_V1.weights.retrievalBytesPerMcu),
  );
  const modelMicros = micros(modelCostUsd / MCU_SCHEDULE_V1.weights.modelUsdPerMcu);
  const sandboxMicros = micros(
    sandboxVcpuMinutes / MCU_SCHEDULE_V1.weights.sandboxVcpuMinutesPerMcu +
      sandboxGibMinutes / MCU_SCHEDULE_V1.weights.sandboxGibMinutesPerMcu,
  );
  const verificationMicros = micros(
    verificationVcpuMinutes / MCU_SCHEDULE_V1.weights.verificationVcpuMinutesPerMcu +
      verificationGibMinutes / MCU_SCHEDULE_V1.weights.verificationGibMinutesPerMcu +
      retainedVerificationBytes / MCU_SCHEDULE_V1.weights.retainedVerificationBytesPerMcu,
  );
  const totalMicros =
    graphMicros + retrievalMicros + modelMicros + sandboxMicros + verificationMicros;
  if (!Number.isSafeInteger(totalMicros)) throw new Error("mcu_overflow");
  return Object.freeze({
    version: MCU_VERSION,
    graphMicros,
    retrievalMicros,
    modelMicros,
    sandboxMicros,
    verificationMicros,
    totalMicros,
  });
}

export function formatMcu(microsValue: number): string {
  if (!Number.isSafeInteger(microsValue)) throw new Error("mcu_micros_invalid");
  return (microsValue / MCU_MICROS).toFixed(6).replace(/\.?0+$/, "");
}
