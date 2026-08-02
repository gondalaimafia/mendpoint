import { describe, expect, it } from "vitest";
import { calculateMcuV1, formatMcu, MCU_MICROS } from "./mcu.js";

describe("migration compute units", () => {
  it("calculates every v1 component without losing fractional compute", () => {
    expect(
      calculateMcuV1({
        graphObjects: 10_001,
        retrievalBytes: 10_000_001,
        modelCostUsd: 0.025,
        sandboxVcpuMinutes: 1.25,
        sandboxGibMinutes: 1,
        verificationVcpuMinutes: 0.5,
        verificationGibMinutes: 1,
        retainedVerificationBytes: 50_000_000,
      }),
    ).toEqual({
      version: "mcu-v1",
      graphMicros: 2 * MCU_MICROS,
      retrievalMicros: 2 * MCU_MICROS,
      modelMicros: 2.5 * MCU_MICROS,
      sandboxMicros: 1.75 * MCU_MICROS,
      verificationMicros: 1.5 * MCU_MICROS,
      totalMicros: 9.75 * MCU_MICROS,
    });
  });

  it("rejects invalid work and formats ledger precision", () => {
    expect(() => calculateMcuV1({ modelCostUsd: -1 })).toThrow(
      "mcu_model_cost_usd_invalid",
    );
    expect(() => calculateMcuV1({ graphObjects: Number.NaN })).toThrow(
      "mcu_graph_objects_invalid",
    );
    expect(formatMcu(1_250_000)).toBe("1.25");
    expect(formatMcu(0)).toBe("0");
  });
});
