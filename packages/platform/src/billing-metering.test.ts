import { describe, expect, it } from "vitest";
import { calculateMcuV1 } from "./mcu.js";
import {
  SELF_SERVE_BILLING_FLAG,
  computeFanoutRunMcuMicros,
  fanoutRunMcuWork,
  resolveFanoutSettlementMcuMicros,
  selfServeBillingEnabled,
  type FanoutRunMeterSignals,
} from "./billing-metering.js";

const ON = { [SELF_SERVE_BILLING_FLAG]: "1" } as unknown as NodeJS.ProcessEnv;
const OFF = {} as unknown as NodeJS.ProcessEnv;

const REAL_SIGNALS: FanoutRunMeterSignals = {
  surfaces: 4,
  findings: 6,
  candidates: 9,
  confirmed: 3,
  edits: 2,
};

describe("self-serve billing flag", () => {
  it("is off unless explicitly set to 1", () => {
    expect(selfServeBillingEnabled(OFF)).toBe(false);
    expect(selfServeBillingEnabled({ [SELF_SERVE_BILLING_FLAG]: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(selfServeBillingEnabled(ON)).toBe(true);
  });
});

describe("server-computed MCU from real work", () => {
  it("maps only genuine run signals onto graph objects (no fabricated dimensions)", () => {
    const work = fanoutRunMcuWork(REAL_SIGNALS);
    // 4 + 6 + 9 + 3 + 2 = 24 real graph/impact/edit objects.
    expect(work).toEqual({ graphObjects: 24 });
    // Unmeasured dimensions are absent, never invented.
    expect(work.retrievalBytes).toBeUndefined();
    expect(work.modelCostUsd).toBeUndefined();
    expect(work.sandboxVcpuMinutes).toBeUndefined();
    expect(work.verificationVcpuMinutes).toBeUndefined();
  });

  it("computes via calculateMcuV1 (a small run rounds up to the 1 MCU graph floor)", () => {
    const computed = computeFanoutRunMcuMicros(REAL_SIGNALS);
    expect(computed).toBe(calculateMcuV1({ graphObjects: 24 }).totalMicros);
    expect(computed).toBe(1_000_000); // ceil(24 / 10_000) MCU = 1 MCU
  });

  it("ignores negative or non-finite counts (defensive, deterministic)", () => {
    const messy: FanoutRunMeterSignals = {
      surfaces: -3,
      findings: Number.NaN,
      candidates: 10_000,
      confirmed: 0,
      edits: 0,
    };
    expect(fanoutRunMcuWork(messy)).toEqual({ graphObjects: 10_000 });
    expect(computeFanoutRunMcuMicros(messy)).toBe(1_000_000);
  });
});

describe("settlement amount resolution", () => {
  const reservedMcuMicros = 4_000_000; // Wave C estimate for targetCount 3

  it("flag OFF settles to the reserved estimate, byte-identical to Wave C", () => {
    expect(
      resolveFanoutSettlementMcuMicros({ reservedMcuMicros, signals: REAL_SIGNALS, env: OFF }),
    ).toBe(reservedMcuMicros);
  });

  it("flag ON settles to the server-computed amount, not the client/reserved value", () => {
    const settled = resolveFanoutSettlementMcuMicros({
      reservedMcuMicros,
      signals: REAL_SIGNALS,
      env: ON,
    });
    expect(settled).toBe(1_000_000);
    expect(settled).not.toBe(reservedMcuMicros);
  });

  it("flag ON never settles above the reservation (quota ceiling holds)", () => {
    // A run whose computed cost exceeds a tiny reservation is capped at the hold.
    const bigWork: FanoutRunMeterSignals = {
      surfaces: 60_000,
      findings: 0,
      candidates: 0,
      confirmed: 0,
      edits: 0,
    };
    expect(computeFanoutRunMcuMicros(bigWork)).toBe(6_000_000); // ceil(60k/10k) = 6 MCU
    const settled = resolveFanoutSettlementMcuMicros({
      reservedMcuMicros: 2_000_000,
      signals: bigWork,
      env: ON,
    });
    expect(settled).toBe(2_000_000);
  });
});
