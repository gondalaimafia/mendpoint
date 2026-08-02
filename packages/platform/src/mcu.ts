export const MCU_VERSION = "mcu-v1" as const;
export const MCU_MICROS = 1_000_000;

export const MCU_SCHEDULE_V1 = Object.freeze({
  version: MCU_VERSION,
  effectiveAt: "2026-08-02T00:00:00.000Z",
  approval: Object.freeze({
    requiredRole: "finance_owner",
    immutableAfterUse: true,
    replacementRequiresNewVersion: true,
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
