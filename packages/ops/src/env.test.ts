import { describe, expect, it } from "vitest";
import { validateApiEnv } from "./env.js";

/**
 * Retired Transformer -> Regauge environment names must fail loudly at boot when
 * a deployment sets only the retired legacy name, naming the current variable,
 * rather than silently falling back to a default.
 */
describe("validateApiEnv retired legacy env names", () => {
  it("refuses a retired legacy name set alone, naming the current variable", () => {
    const report = validateApiEnv({
      MENDPOINT_TRANSFORMER_GATE: "{}",
    } as NodeJS.ProcessEnv);
    expect(report.ok).toBe(false);
    expect(
      report.errors.some(
        (e) =>
          e.includes("MENDPOINT_TRANSFORMER_GATE") &&
          e.includes("MENDPOINT_REGAUGE_GATE"),
      ),
    ).toBe(true);
  });

  it("accepts the current name for a retired alias", () => {
    const report = validateApiEnv({
      MENDPOINT_REGAUGE_GATE: "{}",
    } as NodeJS.ProcessEnv);
    expect(
      report.errors.some((e) => e.includes("MENDPOINT_TRANSFORMER_GATE")),
    ).toBe(false);
  });

  it("does not fire when the current name is also set alongside a stale legacy one", () => {
    const report = validateApiEnv({
      MENDPOINT_REGAUGE_GATE: "{}",
      MENDPOINT_TRANSFORMER_GATE: "{}",
    } as NodeJS.ProcessEnv);
    expect(
      report.errors.some((e) => e.includes("was retired in the Transformer->Regauge rename")),
    ).toBe(false);
  });

  it("does not treat an active Warden->Fettler legacy name as retired", () => {
    // Active aliases still dual-read; setting the legacy name is not an error.
    const report = validateApiEnv({
      MENDPOINT_WARDEN_MODEL_PROVIDER: "openai-compatible",
    } as NodeJS.ProcessEnv);
    expect(
      report.errors.some((e) => e.includes("MENDPOINT_WARDEN_MODEL_PROVIDER")),
    ).toBe(false);
  });
});
