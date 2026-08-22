import { describe, expect, it } from "vitest";
import {
  RENAMED_ENV,
  RETIRED_ENV,
  RETIRED_ENV_ALIASES,
  readRenamedEnv,
  resolveRenamedEnv,
  resolveEitherRenamedEnv,
  type ActiveRenamedEnvName,
  type RetiredRenamedEnvName,
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

describe("resolveRenamedEnv active alias (Warden -> Fettler still dual-reads)", () => {
  it("dual-reads using the legacy name from the source-of-truth map", () => {
    // An active alias must remain: a live deployment still carries the value
    // under the legacy name, so both names must resolve.
    expect(resolveRenamedEnv({ [LEGACY]: "1" }, CURRENT)).toBe("1");
    expect(resolveRenamedEnv({ [CURRENT]: "1" }, CURRENT)).toBe("1");
  });
});

describe("resolveRenamedEnv retired alias (Transformer -> Regauge reads current only)", () => {
  const RETIRED_CURRENT = "MENDPOINT_REGAUGE_GATE" as const;
  const RETIRED_LEGACY = "MENDPOINT_TRANSFORMER_GATE" as const;

  it("resolves the current name", () => {
    expect(resolveRenamedEnv({ [RETIRED_CURRENT]: "gate" }, RETIRED_CURRENT)).toBe(
      "gate",
    );
  });

  it("does NOT honour the retired legacy value (no silent fallback)", () => {
    // The retirement control: a value left only under the retired legacy name is
    // ignored, so it cannot silently drive behaviour. validateApiEnv turns this
    // into a loud boot failure.
    expect(resolveRenamedEnv({ [RETIRED_LEGACY]: "gate" }, RETIRED_CURRENT)).toBeUndefined();
  });

  it("uses the current name and ignores the legacy one when both are set", () => {
    expect(
      resolveRenamedEnv(
        { [RETIRED_CURRENT]: "new", [RETIRED_LEGACY]: "old" },
        RETIRED_CURRENT,
      ),
    ).toBe("new");
  });
});

describe("resolveEitherRenamedEnv (current or legacy or unrelated name)", () => {
  it("dual-reads an active alias whether given the current or the legacy name", () => {
    expect(resolveEitherRenamedEnv({ [LEGACY]: "1" }, CURRENT)).toBe("1");
    expect(resolveEitherRenamedEnv({ [CURRENT]: "1" }, LEGACY)).toBe("1");
    expect(resolveEitherRenamedEnv({ [LEGACY]: "1" }, LEGACY)).toBe("1");
  });

  it("maps a retired legacy name forward and reads the current value only", () => {
    const RETIRED_CURRENT = "MENDPOINT_REGAUGE_GATE" as const;
    const RETIRED_LEGACY = "MENDPOINT_TRANSFORMER_GATE" as const;
    // Given the legacy name, it resolves the CURRENT value...
    expect(resolveEitherRenamedEnv({ [RETIRED_CURRENT]: "v" }, RETIRED_LEGACY)).toBe("v");
    expect(resolveEitherRenamedEnv({ [RETIRED_CURRENT]: "v" }, RETIRED_CURRENT)).toBe("v");
    // ...and never the retired legacy value.
    expect(resolveEitherRenamedEnv({ [RETIRED_LEGACY]: "v" }, RETIRED_LEGACY)).toBeUndefined();
    expect(resolveEitherRenamedEnv({ [RETIRED_LEGACY]: "v" }, RETIRED_CURRENT)).toBeUndefined();
  });

  it("reads an unrelated name directly", () => {
    expect(resolveEitherRenamedEnv({ MENDPOINT_UNRELATED: "x" }, "MENDPOINT_UNRELATED")).toBe(
      "x",
    );
    expect(resolveEitherRenamedEnv({}, "MENDPOINT_UNRELATED")).toBeUndefined();
  });
});

describe("rename source-of-truth maps", () => {
  const activeEntries = Object.entries(RENAMED_ENV) as ReadonlyArray<
    [ActiveRenamedEnvName, string]
  >;
  const retiredEntries = Object.entries(RETIRED_ENV) as ReadonlyArray<
    [RetiredRenamedEnvName, string]
  >;
  const allEntries = [...activeEntries, ...retiredEntries];

  it("renames only Warden->Fettler and Transformer->Regauge and never collides", () => {
    const currents = new Set<string>();
    const legacies = new Set<string>();
    for (const [current, legacy] of allEntries) {
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
    expect(currents.size).toBe(allEntries.length);
    expect(legacies.size).toBe(allEntries.length);
  });

  it("keeps the active and retired maps disjoint", () => {
    const active = new Set<string>(activeEntries.map(([current]) => current));
    for (const [current] of retiredEntries) expect(active.has(current)).toBe(false);
  });

  it("wires a dual read path for every active (Warden->Fettler) entry", () => {
    for (const [current, legacy] of activeEntries) {
      // New name alone resolves.
      expect(resolveRenamedEnv({ [current]: "value-new" }, current)).toBe("value-new");
      // Legacy name alone resolves (the production shape kept alive).
      expect(resolveRenamedEnv({ [legacy]: "value-old" }, current)).toBe("value-old");
      // Both set: the new name wins.
      expect(
        resolveRenamedEnv({ [current]: "value-new", [legacy]: "value-old" }, current),
      ).toBe("value-new");
      // Neither set: undefined (feature stays default-off).
      expect(resolveRenamedEnv({}, current)).toBeUndefined();
      // The legacy name is reachable through resolveEitherRenamedEnv too.
      expect(resolveEitherRenamedEnv({ [legacy]: "value-old" }, legacy)).toBe("value-old");
    }
  });

  it("reads the current name only for every retired (Transformer->Regauge) entry", () => {
    for (const [current, legacy] of retiredEntries) {
      // New name alone resolves.
      expect(resolveRenamedEnv({ [current]: "value-new" }, current)).toBe("value-new");
      // Legacy name alone is NOT honoured (retired: no silent fallback).
      expect(resolveRenamedEnv({ [legacy]: "value-old" }, current)).toBeUndefined();
      // Both set: the new name wins, legacy ignored.
      expect(
        resolveRenamedEnv({ [current]: "value-new", [legacy]: "value-old" }, current),
      ).toBe("value-new");
      // Neither set: undefined.
      expect(resolveRenamedEnv({}, current)).toBeUndefined();
    }
  });

  it("exposes every retired entry as a (current, legacy) alias pair for boot validation", () => {
    expect(RETIRED_ENV_ALIASES.length).toBe(retiredEntries.length);
    for (const [current, legacy] of RETIRED_ENV_ALIASES) {
      expect(RETIRED_ENV[current]).toBe(legacy);
    }
  });

  it("keeps the customer backup-path aliases active, never retired", () => {
    // These Transformer->Regauge backup paths are operator-provisioned per-customer
    // Fly secrets (CUSTOMER_WARDEN_REQUIRED_SECRETS in scripts/customer-warden-profile.ts),
    // delivered under the legacy names and unchangeable from this repository.
    // Retiring them would fail a live customer boot, so the fallback must stay.
    for (const current of [
      "MENDPOINT_BACKUP_REGAUGE_CONTROL_PLANE_PATH",
      "MENDPOINT_BACKUP_REGAUGE_PILOT_PATH",
    ] as const) {
      expect(current in RENAMED_ENV).toBe(true);
      expect(current in RETIRED_ENV).toBe(false);
      // The legacy secret a live customer still sets must resolve.
      expect(resolveEitherRenamedEnv({ [RENAMED_ENV[current]]: "path.sqlite" }, current)).toBe(
        "path.sqlite",
      );
    }
  });
});
