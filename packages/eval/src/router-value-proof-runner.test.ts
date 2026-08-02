import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  persistRouterValueProofReport,
  runRouterValueProofArtifact,
  type RouterValueProofInput,
} from "./router-value-proof-runner.js";

const roots: string[] = [];

function fixture(): { root: string; input: string; output: string; raw: string } {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-router-value-"));
  roots.push(root);
  const value: RouterValueProofInput = {
    version: "2026-08-02.v1",
    cohort: { id: "held-out-v1", revision: "a".repeat(40), heldOut: true },
    policy: {
      latencyP95Ms: 2_000,
      requirePerTaskAcceptanceNonRegression: true,
      requirePerTaskSecurityNonRegression: true,
      requireLowerAcceptedOutputCost: true,
    },
    observations: [
      { taskId: "task-a", arm: "baseline", accepted: true, securityFindings: 0, costUsd: 1, latencyMs: 1_000, evidenceRefs: ["run://baseline/a"] },
      { taskId: "task-a", arm: "candidate", accepted: true, securityFindings: 0, costUsd: 0.5, latencyMs: 900, evidenceRefs: ["run://candidate/a"] },
    ],
  };
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  const input = join(root, "cohort.json");
  writeFileSync(input, raw);
  return { root, input, output: join(root, "report.json"), raw };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("router value proof artifact runner", () => {
  it("binds the report to the exact immutable cohort bytes and writes atomically", () => {
    const { input, output, raw } = fixture();
    const report = persistRouterValueProofReport(input, output);
    expect(report.ok).toBe(true);
    expect(report.cohortDigest).toBe(
      `sha256:${createHash("sha256").update(raw).digest("hex")}`,
    );
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(report);
  });

  it("refuses training cohorts and refuses to overwrite retained evidence", () => {
    const { input, output } = fixture();
    const value = JSON.parse(readFileSync(input, "utf8")) as RouterValueProofInput;
    writeFileSync(input, JSON.stringify({ ...value, cohort: { ...value.cohort, heldOut: false } }));
    expect(() => runRouterValueProofArtifact(input)).toThrow("router_value_cohort_not_held_out");

    const second = fixture();
    persistRouterValueProofReport(second.input, second.output);
    expect(() => persistRouterValueProofReport(second.input, second.output)).toThrow("router_value_output_exists");
  });
});
