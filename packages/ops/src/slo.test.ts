import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLO_TARGETS,
  availabilitySignal,
  evaluateSlo,
  evaluateSloReport,
  jobSuccessSignal,
  latencySignal,
  verifySloReport,
  type SloSignal,
} from "./service-health.js";

const WINDOW = {
  tenantId: "tenant-a",
  service: "warden-api",
  windowStartedAt: "2026-08-02T00:00:00.000Z",
  windowEndedAt: "2026-08-02T00:30:00.000Z",
};

function series(count: number, at: (i: number) => SloSignal): SloSignal[] {
  return Array.from({ length: count }, (_, i) => at(i));
}

describe("live SLO instrumentation", () => {
  it("computes error budget consumed/remaining and a healthy burn state from readiness signals", () => {
    const availability = DEFAULT_SLO_TARGETS.find((t) => t.slo === "availability")!;
    // 100 readiness probes, 0 failures, objective 0.99 -> budget untouched.
    const signals = series(100, (i) =>
      availabilitySignal(true, `2026-08-02T00:${String(i % 30).padStart(2, "0")}:00.000Z`),
    );
    const evidence = evaluateSlo(availability, { ...WINDOW, signals });
    expect(evidence.samples).toBe(100);
    expect(evidence.badSamples).toBe(0);
    expect(evidence.observedRatio).toBe(1);
    expect(evidence.errorBudgetConsumed).toBe(0);
    expect(evidence.errorBudgetRemaining).toBe(1);
    expect(evidence.burnState).toBe("healthy");
  });

  it("flags an exhausted budget when failures exceed the allowance", () => {
    const availability = DEFAULT_SLO_TARGETS.find((t) => t.slo === "availability")!;
    // 100 samples, 2 failures -> errorRate 0.02, allowed 0.01 -> consumed 2.0 -> exhausted.
    const signals = [
      ...series(98, (i) => availabilitySignal(true, `2026-08-02T00:${String(i % 30).padStart(2, "0")}:01.000Z`)),
      availabilitySignal(false, "2026-08-02T00:05:00.000Z"),
      availabilitySignal(false, "2026-08-02T00:06:00.000Z"),
    ];
    const evidence = evaluateSlo(availability, { ...WINDOW, signals });
    expect(evidence.samples).toBe(100);
    expect(evidence.badSamples).toBe(2);
    expect(evidence.errorBudgetConsumed).toBeCloseTo(2);
    expect(evidence.errorBudgetRemaining).toBe(0);
    expect(evidence.burnState).toBe("exhausted");
  });

  it("derives latency good/bad from the threshold and reports at-risk burn", () => {
    const latency = DEFAULT_SLO_TARGETS.find((t) => t.slo === "latency")!;
    // objective 0.95 -> allowed 0.05. 40 samples, 2 slow -> errorRate 0.05 -> consumed 1.0.
    const signals = [
      ...series(38, (i) => latencySignal(120, `2026-08-02T00:${String(i % 30).padStart(2, "0")}:02.000Z`)),
      latencySignal(4_000, "2026-08-02T00:10:00.000Z"),
      latencySignal(5_000, "2026-08-02T00:11:00.000Z"),
    ];
    const evidence = evaluateSlo(latency, { ...WINDOW, signals });
    expect(evidence.samples).toBe(40);
    expect(evidence.badSamples).toBe(2);
    expect(evidence.errorBudgetConsumed).toBeCloseTo(1);
    expect(evidence.burnState).toBe("at_risk");
  });

  it("reports insufficient evidence below the minimum sample count", () => {
    const jobs = DEFAULT_SLO_TARGETS.find((t) => t.slo === "job_success")!;
    const signals = series(3, (i) => jobSuccessSignal(true, `2026-08-02T00:0${i}:00.000Z`));
    const evidence = evaluateSlo(jobs, { ...WINDOW, signals });
    expect(evidence.errorBudgetConsumed).toBeNull();
    expect(evidence.errorBudgetRemaining).toBeNull();
    expect(evidence.burnState).toBe("insufficient_evidence");
  });

  it("builds a tamper-evident multi-SLO report whose status escalates with the worst SLO", () => {
    const signals: SloSignal[] = [
      ...series(50, (i) => availabilitySignal(true, `2026-08-02T00:${String(i % 30).padStart(2, "0")}:03.000Z`)),
      ...series(30, (i) => latencySignal(100, `2026-08-02T00:${String(i % 30).padStart(2, "0")}:04.000Z`)),
      // job SLO: 20 jobs, 2 failures, objective 0.98 -> allowed 0.02 -> consumed 5.0 -> exhausted.
      ...series(18, (i) => jobSuccessSignal(true, `2026-08-02T00:${String(i % 30).padStart(2, "0")}:05.000Z`)),
      jobSuccessSignal(false, "2026-08-02T00:12:00.000Z"),
      jobSuccessSignal(false, "2026-08-02T00:13:00.000Z"),
    ];
    const report = evaluateSloReport({ ...WINDOW, signals });
    expect(report.slos.map((s) => s.slo)).toEqual(["availability", "latency", "job_success"]);
    expect(report.slos.find((s) => s.slo === "job_success")!.burnState).toBe("exhausted");
    expect(report.status).toBe("unavailable");
    expect(verifySloReport(report)).toBe(true);
    expect(verifySloReport({ ...report, status: "healthy" })).toBe(false);
  });
});
