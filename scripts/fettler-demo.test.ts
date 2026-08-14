import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const artifactPaths = [
  "demo/FETTLER_RUNBOOK.md",
  "demo/fettler-demo-script.md",
  "demo/fettler-reel.html",
] as const;
const artifacts = Object.fromEntries(
  artifactPaths.map((path) => [path, readFileSync(resolve(root, path), "utf8")]),
) as Record<(typeof artifactPaths)[number], string>;

describe("Fettler investor demo", () => {
  it("uses one truthful two-minute runtime", () => {
    const html = artifacts["demo/fettler-reel.html"];
    const durationMatch = html.match(/var DURATIONS = \[([^\]]+)\]/);
    expect(durationMatch).not.toBeNull();
    const durations = durationMatch![1].split(",").map((value) => Number(value.trim()));
    expect(durations).toEqual([10000, 17000, 22000, 21000, 21000, 20000, 9000]);
    expect(durations.reduce((sum, duration) => sum + duration, 0)).toBe(120000);
    expect(artifacts["demo/FETTLER_RUNBOOK.md"]).toContain("120 seconds (2:00)");
    expect(Object.values(artifacts).join("\n")).not.toMatch(/128 seconds|128000|2:08/);
  });

  it("keeps exact public product names and evidence-safe live wording", () => {
    const all = Object.values(artifacts).join("\n");
    for (const artifact of Object.values(artifacts)) {
      expect(artifact).toContain("Fettler — the first AI API Engineer");
      expect(artifact).toContain("Regauge — the first AI Legacy Engineer");
    }
    expect(all).not.toMatch(/\b(?:warden|transformer)\b/i);
    expect(all).not.toMatch(/disabled in production|not enabled in production|gated off in production|not connected to any live repository/i);
    expect(all).not.toMatch(/Seeded repository|checks that passed|test suite passing|draft PR staged/i);
    expect(all).not.toMatch(/<span class="ev-check__state">(?:passing|enforced)<\/span>/i);
    expect(all).toContain("Illustrative scenario");
    expect(all).toContain("This illustrative reel is not execution evidence");
    expect(all).toContain("live deployment status not verified");
  });

  it("remains a seven-scene self-contained reduced-motion reel", () => {
    const html = artifacts["demo/fettler-reel.html"];
    expect(html.match(/<section class="scene\b/g)).toHaveLength(7);
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
    expect(html).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/@import\s+url/i);
    expect(html).not.toMatch(/<button[^>]*ds-btn--icon/i);
    expect(html.match(/aria-label="Illustrative repository filter" tabindex="-1"/g)).toHaveLength(5);
  });
});
