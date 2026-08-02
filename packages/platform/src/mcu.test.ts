import { describe, expect, it } from "vitest";
import {
  assertMcuScheduleChange,
  calculateMcuV1,
  formatMcu,
  MCU_MICROS,
  MCU_SCHEDULE_V1,
} from "./mcu.js";

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

  it("publishes executable examples and requires a new finance approved version for changes", () => {
    for (const example of MCU_SCHEDULE_V1.examples) {
      expect(calculateMcuV1(example.work).totalMicros, example.label).toBe(example.expectedMicros);
    }
    expect(Object.isFrozen(MCU_SCHEDULE_V1)).toBe(true);
    expect(Object.isFrozen(MCU_SCHEDULE_V1.weights)).toBe(true);
    expect(() => assertMcuScheduleChange({
      currentVersion: "mcu-v1",
      nextVersion: "mcu-v1",
      approvedByRole: "finance_owner",
      currentVersionHasUsage: true,
    })).toThrow("mcu_new_version_required");
    expect(() => assertMcuScheduleChange({
      currentVersion: "mcu-v1",
      nextVersion: "mcu-v2",
      approvedByRole: "engineer",
      currentVersionHasUsage: true,
    })).toThrow("mcu_finance_approval_required");
    expect(() => assertMcuScheduleChange({
      currentVersion: "mcu-v1",
      nextVersion: "mcu-v2",
      approvedByRole: "finance_owner",
      currentVersionHasUsage: false,
    })).toThrow("mcu_change_without_usage_snapshot");
    expect(() => assertMcuScheduleChange({
      currentVersion: "mcu-v1",
      nextVersion: "mcu-v2",
      approvedByRole: "finance_owner",
      currentVersionHasUsage: true,
    })).not.toThrow();
  });
});
