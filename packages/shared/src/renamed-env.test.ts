import { describe, expect, it } from "vitest";
import {
  RENAMED_ENV,
  readRenamedEnv,
  resolveRenamedEnv,
  resolveEitherRenamedEnv,
  type RenamedEnvName,
} from "./renamed-env.js";

const CURRENT = "MENDPOINT_SELF_SERVE_FETTLER" as const;
const LEGACY = "MENDPOINT_SELF_SERVE_WARDEN" as const;

describe("readRenamedEnv dual-read", () => {
  it("resolves the current (new) name when only it is set", () => {
    expect(readRenamedEnv({ [CURRENT]: "1" }, CURRENT, LEGACY)).toBe("1");
  });

  it("resolves the legacy (old) name when only it is set (the production shape)", () => {
    // Production still holds the secret under the old name; the feature must not
    // silently turn off when the code prefers the new name.
    expect(readRenamedEnv({ [LEGACY]: "1" }, CURRENT, LEGACY)).toBe("1");
  });

  it("prefers the current name when both are set", () => {
    expect(
      readRenamedEnv({ [CURRENT]: "new", [LEGACY]: "old" }, CURRENT, LEGACY),
    ).toBe("new");
  });

  it("falls through a whitespace-only current name to a real legacy value", () => {
    expect(
      readRenamedEnv({ [CURRENT]: "   ", [LEGACY]: "real" }, CURRENT, LEGACY),
    ).toBe("real");
  });

  it("returns undefined when neither name is set", () => {
    expect(readRenamedEnv({}, CURRENT, LEGACY)).toBeUndefined();
  });

  it("keeps a set-but-empty value visible so emptiness validators are unchanged", () => {
    // Reading the legacy variable directly today yields "" (not undefined); the
    // helper preserves that so `value !== undefined && !value.trim()` checks fire.
    expect(readRenamedEnv({ [LEGACY]: "" }, CURRENT, LEGACY)).toBe("");
  });

  it("returns the raw untrimmed value so downstream trim/compare is unchanged", () => {
    expect(readRenamedEnv({ [CURRENT]: " padded " }, CURRENT, LEGACY)).toBe(
      " padded ",
    );
  });
});

describe("resolveRenamedEnv (current name via map)", () => {
  it("dual-reads using the legacy name from the source-of-truth map", () => {
    expect(resolveRenamedEnv({ [LEGACY]: "1" }, CURRENT)).toBe("1");
    expect(resolveRenamedEnv({ [CURRENT]: "1" }, CURRENT)).toBe("1");
  });
});

describe("resolveEitherRenamedEnv (current or legacy or unrelated name)", () => {
  it("dual-reads whether given the current or the legacy name", () => {
    expect(resolveEitherRenamedEnv({ [LEGACY]: "1" }, CURRENT)).toBe("1");
    expect(resolveEitherRenamedEnv({ [CURRENT]: "1" }, LEGACY)).toBe("1");
    expect(resolveEitherRenamedEnv({ [LEGACY]: "1" }, LEGACY)).toBe("1");
  });

  it("reads an unrelated name directly", () => {
    expect(resolveEitherRenamedEnv({ MENDPOINT_UNRELATED: "x" }, "MENDPOINT_UNRELATED")).toBe(
      "x",
    );
    expect(resolveEitherRenamedEnv({}, "MENDPOINT_UNRELATED")).toBeUndefined();
  });
});

describe("RENAMED_ENV source-of-truth map", () => {
  const entries = Object.entries(RENAMED_ENV) as ReadonlyArray<
    [RenamedEnvName, string]
  >;

  it("renames only Warden->Fettler and Transformer->Regauge and never collides", () => {
    const currents = new Set<string>();
    const legacies = new Set<string>();
    for (const [current, legacy] of entries) {
      // Current names carry the new vocabulary and none of the old.
      expect(current).not.toMatch(/WARDEN|TRANSFORMER/);
      expect(current).toMatch(/FETTLER|REGAUGE/);
      // Legacy names carry the old vocabulary and none of the new.
      expect(legacy).not.toMatch(/FETTLER|REGAUGE/);
      expect(legacy).toMatch(/WARDEN|TRANSFORMER/);
      // The rename is a pure token swap.
      expect(current).toBe(
        legacy.replaceAll("WARDEN", "FETTLER").replaceAll("TRANSFORMER", "REGAUGE"),
      );
      currents.add(current);
      legacies.add(legacy);
    }
    expect(currents.size).toBe(entries.length);
    expect(legacies.size).toBe(entries.length);
  });

  it("wires both a new and a legacy read path for every entry", () => {
    for (const [current, legacy] of entries) {
      // New name alone resolves.
      expect(resolveRenamedEnv({ [current]: "value-new" }, current)).toBe(
        "value-new",
      );
      // Legacy name alone resolves (the production shape).
      expect(resolveRenamedEnv({ [legacy]: "value-old" }, current)).toBe(
        "value-old",
      );
      // Both set: the new name wins.
      expect(
        resolveRenamedEnv({ [current]: "value-new", [legacy]: "value-old" }, current),
      ).toBe("value-new");
      // Neither set: undefined (feature stays default-off).
      expect(resolveRenamedEnv({}, current)).toBeUndefined();
      // The legacy name is reachable through resolveEitherRenamedEnv too.
      expect(resolveEitherRenamedEnv({ [legacy]: "value-old" }, legacy)).toBe(
        "value-old",
      );
    }
  });
});
