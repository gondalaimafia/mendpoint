import { describe, expect, it } from "vitest";
import { wardenPlaybook } from "./knowledge.js";
import { WARDEN_BEHAVIOR_POLICY } from "./policies.js";

describe("wardenPlaybook behavior policy", () => {
  const playbook = wardenPlaybook();

  it("injects each behavior policy principle verbatim into the live prompt", () => {
    // Guards the wiring: if a refactor drops the policy from the injected
    // prompt, every canonical principle string fails to match here.
    for (const principle of WARDEN_BEHAVIOR_POLICY) {
      expect(playbook).toContain(principle);
    }
  });

  it("carries the three researched principle headers", () => {
    expect(playbook).toContain("Attribution before modification");
    expect(playbook).toContain("Retry is not the default repair");
    expect(playbook).toContain("Verify safety invariants, not response success");
  });

  it("preserves the named failure families the principles govern", () => {
    // Distinctive substrings from each principle — a partial drop still fails.
    expect(playbook).toContain("OAuth refresh-token rotation");
    expect(playbook).toContain("idempotency-key semantics");
    expect(playbook).toContain("created-resource counts");
  });
});
