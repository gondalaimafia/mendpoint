import { describe, expect, it } from "vitest";
import { stagesFrom } from "./ga-check-all.js";

describe("ga:check:all stage derivation", () => {
  it("derives every stage from the ga:check chain", () => {
    const stages = stagesFrom("npm run spec:check && npm run claims:check && tsx scripts/ga-check.ts");
    expect(stages.map((stage) => stage.label)).toEqual(["spec:check", "claims:check", "tsx scripts/ga-check.ts"]);
  });

  it("keeps the raw command so a non-npm stage still runs", () => {
    const stages = stagesFrom("npm run a:check && tsx scripts/x.ts");
    expect(stages[1]?.command).toBe("tsx scripts/x.ts");
  });

  it("ignores empty segments rather than inventing a stage", () => {
    expect(stagesFrom("npm run a:check &&  && npm run b:check").map((s) => s.label)).toEqual([
      "a:check",
      "b:check",
    ]);
  });

  it("covers every stage the real ga:check chain declares", async () => {
    // The point of this script is that it cannot silently cover fewer gates
    // than the chain it stands in for.
    const { readFileSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const root = resolve(import.meta.dirname, "..");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const chain = manifest.scripts["ga:check"]!;
    const derived = stagesFrom(chain).map((stage) => stage.label);
    const declared = chain
      .split("&&")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => (part.startsWith("npm run ") ? part.slice(8) : part));
    expect(derived).toEqual(declared);
    expect(derived.length).toBeGreaterThan(5);
  });
});
