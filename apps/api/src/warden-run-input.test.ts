import { describe, expect, it } from "vitest";
import {
  parseWardenRunInput,
  resolveWardenUseLlm,
} from "./warden-run-input.js";

function valid(overrides: Record<string, unknown> = {}) {
  return {
    goal: "Repair the charges API path.",
    consumerId: "consumer-a",
    allowedChangedPaths: ["src/payments.ts"],
    maxSteps: 20,
    ...overrides,
  };
}

describe("Warden run input", () => {
  it("returns a frozen bounded input", () => {
    const result = parseWardenRunInput(valid({ verifyCommand: "npm test" }));
    expect(result).toMatchObject({
      ok: true,
      value: {
        goal: "Repair the charges API path.",
        allowedChangedPaths: ["src/payments.ts"],
        verifyCommand: "npm test",
      },
    });
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.allowedChangedPaths)).toBe(true);
    }
  });

  it.each([
    [[], "allowedChangedPaths"],
    [["../secret.ts"], "allowedChangedPaths"],
    [["src/a.ts", "src/a.ts"], "allowedChangedPaths"],
    [["C:/source.ts"], "allowedChangedPaths"],
  ])("rejects unsafe file scope %#", (allowedChangedPaths, error) => {
    expect(parseWardenRunInput(valid({ allowedChangedPaths })))
      .toEqual({ ok: false, error: expect.stringContaining(error) });
  });

  it("redacts known credentials before queue persistence", () => {
    const secret = `github_pat_${"A".repeat(30)}`;
    const result = parseWardenRunInput(valid({ errorLog: `token=${secret}` }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.errorLog).not.toContain(secret);
    expect(result.value.ingressRedactions).toBeGreaterThan(0);
  });

  it("rejects tests and verification controls from the mutation scope", () => {
    expect(parseWardenRunInput(valid({ allowedChangedPaths: ["tests/payments.test.ts"] })))
      .toEqual({
        ok: false,
        error: "allowedChangedPaths cannot include tests or verification controls",
      });
    expect(parseWardenRunInput(valid({ allowedChangedPaths: ["package.json"] }))).toEqual({
      ok: false,
      error: "allowedChangedPaths cannot include tests or verification controls",
    });
    expect(parseWardenRunInput(valid({ allowedChangedPaths: [".env"] }))).toEqual({
      ok: false,
      error: "allowedChangedPaths contains a protected repository path",
    });
  });

  it("fails closed for ambiguous high entropy input", () => {
    const ambiguous = `opaque ${"aB3dE6fG9hJ2kL5mN8pQ1rS4tV7wX0yZ".repeat(2)}`;
    expect(parseWardenRunInput(valid({ goal: ambiguous }))).toEqual({
      ok: false,
      error: "goal contains unsupported or excessive content",
    });
  });

  it("rejects invalid types and budgets", () => {
    expect(parseWardenRunInput(valid({ useLlm: "yes" })))
      .toEqual({ ok: false, error: "useLlm must be a boolean" });
    expect(parseWardenRunInput(valid({ maxSteps: 101 })))
      .toEqual({ ok: false, error: "maxSteps must be an integer from 1 to 100" });
    expect(parseWardenRunInput(valid({ dryRun: true }))).toEqual({
      ok: false,
      error: "dryRun is not supported for snapshot bound Warden runs",
    });
  });

  it("requires capable model execution for every customer Warden run", () => {
    expect(resolveWardenUseLlm({ useLlm: false }, {
      MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      LLM_AGENT: "0",
    })).toBe(true);
    expect(resolveWardenUseLlm({}, {
      MENDPOINT_DEPLOYMENT_PROFILE: "customer",
    })).toBe(true);
    expect(resolveWardenUseLlm({ useLlm: false }, {
      MENDPOINT_DEPLOYMENT_PROFILE: "pilot",
      LLM_AGENT: "1",
    })).toBe(false);
    expect(resolveWardenUseLlm({}, {
      MENDPOINT_DEPLOYMENT_PROFILE: "demo",
      LLM_AGENT: "1",
    })).toBe(true);
  });
});
