export const MCU_VERSION = "mcu-v1" as const;
export const MCU_MICROS = 1_000_000;

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

  const graphMicros = micros(graphObjects === 0 ? 0 : Math.ceil(graphObjects / 10_000));
  const retrievalMicros = micros(
    retrievalBytes === 0 ? 0 : Math.ceil(retrievalBytes / 10_000_000),
  );
  const modelMicros = micros(modelCostUsd / 0.01);
  const sandboxMicros = micros(sandboxVcpuMinutes + sandboxGibMinutes / 2);
  const verificationMicros = micros(
    verificationVcpuMinutes +
      verificationGibMinutes / 2 +
      retainedVerificationBytes / 100_000_000,
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
