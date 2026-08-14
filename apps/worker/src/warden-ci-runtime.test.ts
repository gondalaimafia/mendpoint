import { describe, expect, it } from "vitest";
import { wardenCiConfigForRepository } from "./warden-ci-runtime.js";

describe("Warden CI production configuration", () => {
  it("is disabled unless explicitly enabled", () => {
    expect(wardenCiConfigForRepository({}, "repo-a")).toBeUndefined();
  });

  it("loads one exact repository authority with bounded budgets", () => {
    const config = wardenCiConfigForRepository({
      MENDPOINT_WARDEN_CI_REENTRY_ENABLED: "1",
      MENDPOINT_WARDEN_CI_REENTRY_CONFIG_JSON: JSON.stringify({
        "repo-a": {
          requiredChecks: ["check:77:test", "check:88:security"],
          maxCycles: 3,
          maxModelCalls: 9,
          maximumCostUsd: 12,
        },
      }),
    }, "repo-a");
    expect(config).toEqual({
      requiredChecks: ["check:77:test", "check:88:security"],
      maxCycles: 3,
      maxModelCalls: 9,
      maximumCostUsd: 12,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("fails closed when enabled without an exact repository configuration", () => {
    expect(() => wardenCiConfigForRepository({
      MENDPOINT_WARDEN_CI_REENTRY_ENABLED: "1",
      MENDPOINT_WARDEN_CI_REENTRY_CONFIG_JSON: "{}",
    }, "repo-a")).toThrow("warden_ci_repository_config_required");
  });

  it("rejects legacy commit status identities that lack an authoritative publisher binding", () => {
    expect(() => wardenCiConfigForRepository({
      MENDPOINT_WARDEN_CI_REENTRY_ENABLED: "1",
      MENDPOINT_WARDEN_CI_REENTRY_CONFIG_JSON: JSON.stringify({
        "repo-a": { requiredChecks: ["status:unit"], maxCycles: 3, maxModelCalls: 9,
          maximumCostUsd: 12 },
      }),
    }, "repo-a")).toThrow("warden_ci_required_checks_invalid");
  });
});
