import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * MENDPOINT_ROUTER_ADAPTIVE is recognised but adaptive routing is not wired to a
 * stats producer, so enabling it would silently no-op. The boot guard refuses it
 * loudly; these two tests are its tripwire. The first fails if the guard is
 * removed (the delete-the-check test); the second fails if someone wires the sole
 * stats producer without also removing the guard the wiring would invalidate.
 */
describe("validateApiEnv adaptive-routing flag guard", () => {
  it("refuses MENDPOINT_ROUTER_ADAPTIVE because adaptive routing is unwired", () => {
    const enabled = validateApiEnv({
      MENDPOINT_ROUTER_ADAPTIVE: "1",
    } as NodeJS.ProcessEnv);
    expect(enabled.ok).toBe(false);
    expect(
      enabled.errors.some(
        (e) =>
          e.includes("MENDPOINT_ROUTER_ADAPTIVE") &&
          e.includes("not yet wired to a stats producer"),
      ),
    ).toBe(true);

    // Uses isAdaptiveRoutingEnabled semantics: only the literal "1" fires, so an
    // unset flag must not produce the error (guards against a tautological push).
    const unset = validateApiEnv({} as NodeJS.ProcessEnv);
    expect(
      unset.errors.some((e) => e.includes("MENDPOINT_ROUTER_ADAPTIVE")),
    ).toBe(false);
  });

  it("keeps aggregateRouterOutcomes unwired so the boot guard stays valid", () => {
    // The guard is honest only while adaptive routing has no production caller.
    // aggregateRouterOutcomes is the sole producer of AdaptiveRoutingStats; a
    // *call* to it (the "(" excludes prose mentions and the paren-less barrel
    // re-export) outside its own definition means the feature was wired, at which
    // point this guard must be removed too. This test fails first, pointing the
    // wirer at the guard.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    // The sole permitted "aggregateRouterOutcomes(" is its own definition line.
    const allowed = new Set(["packages/platform/src/router-adaptive.ts"]);
    const skipDirs = new Set(["node_modules", "dist", "__tests__", ".git"]);
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name)) walk(join(dir, entry.name));
          continue;
        }
        const ext = extname(entry.name);
        if (ext !== ".ts" && ext !== ".tsx") continue;
        if (/\.test\.tsx?$/.test(entry.name)) continue;
        const full = join(dir, entry.name);
        const rel = full.slice(repoRoot.length + 1).replace(/\\/g, "/");
        if (allowed.has(rel)) continue;
        if (readFileSync(full, "utf8").includes("aggregateRouterOutcomes(")) {
          offenders.push(rel);
        }
      }
    };

    // Walk scripts/ and evals/ too: they are real code but not npm workspaces, and
    // a gate that omitted scripts/ is exactly how a retired-env change nearly shipped.
    for (const workspace of ["packages", "apps", "scripts", "evals"]) {
      walk(join(repoRoot, workspace));
    }

    expect(offenders).toEqual([]);
  });
});
