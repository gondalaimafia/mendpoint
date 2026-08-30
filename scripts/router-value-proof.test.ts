import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RouterValueProofInput } from "@mendpoint/eval";
import { runRouterValueProofCli } from "./router-value-proof.js";

const roots: string[] = [];

function input(accepted = true): RouterValueProofInput {
  return {
    version: "2026-08-02.v1",
    cohort: { id: "router-holdout-v1", revision: "a".repeat(40), heldOut: true },
    policy: {
      latencyP95Ms: 2_000,
      requirePerTaskAcceptanceNonRegression: true,
      requirePerTaskSecurityNonRegression: true,
      requireLowerAcceptedOutputCost: true,
    },
    observations: [
      { taskId: "task-a", arm: "baseline", accepted: true, securityFindings: 0,
        costUsd: 1, latencyMs: 1_000, evidenceRefs: ["evidence://baseline/a"] },
      { taskId: "task-a", arm: "candidate", accepted, securityFindings: 0,
        costUsd: 0.5, latencyMs: 900, evidenceRefs: ["evidence://candidate/a"] },
    ],
  };
}

function fixture(value: RouterValueProofInput = input()) {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-router-value-cli-"));
  roots.push(root);
  const inputPath = join(root, "cohort.json");
  const outputPath = join(root, "report.json");
  writeFileSync(inputPath, `${JSON.stringify(value)}\n`);
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { inputPath, outputPath, stdout, stderr,
    io: { stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) } };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("production router value proof caller", () => {
  it("publishes one exact passing report and returns success", () => {
    const item = fixture();
    expect(runRouterValueProofCli([
      `--input=${item.inputPath}`,
      `--output=${item.outputPath}`,
    ], item.io)).toBe(0);
    expect(JSON.parse(item.stdout.join(""))).toMatchObject({ ok: true, taskCount: 1 });
    expect(JSON.parse(readFileSync(item.outputPath, "utf8"))).toMatchObject({ ok: true });
  });

  it("retains a failed policy report but returns a failing process status", () => {
    const item = fixture(input(false));
    expect(runRouterValueProofCli([
      `--input=${item.inputPath}`,
      `--output=${item.outputPath}`,
    ], item.io)).toBe(1);
    expect(JSON.parse(readFileSync(item.outputPath, "utf8"))).toMatchObject({
      ok: false,
      acceptanceRegressionTaskIds: ["task-a"],
    });
  });

  it("refuses training input, duplicate arguments, and retained output", () => {
    const original = input();
    const training: RouterValueProofInput = {
      ...original,
      cohort: { ...original.cohort, heldOut: false },
    };
    const item = fixture(training);
    expect(runRouterValueProofCli([
      `--input=${item.inputPath}`,
      `--output=${item.outputPath}`,
    ], item.io)).toBe(2);
    expect(JSON.parse(item.stderr.join(""))).toEqual({
      ok: false,
      error: "router_value_cohort_not_held_out",
    });

    const duplicate = fixture();
    expect(runRouterValueProofCli([
      `--input=${duplicate.inputPath}`,
      `--input=${duplicate.inputPath}`,
      `--output=${duplicate.outputPath}`,
    ], duplicate.io)).toBe(2);

    const retained = fixture();
    writeFileSync(retained.outputPath, "retained");
    expect(runRouterValueProofCli([
      `--input=${retained.inputPath}`,
      `--output=${retained.outputPath}`,
    ], retained.io)).toBe(2);
    expect(readFileSync(retained.outputPath, "utf8")).toBe("retained");
  });

  it.each([
    ["security", { securityFindings: 1 }, { securityRegressionTaskIds: ["task-a"] }],
    ["cost", { costUsd: 1 }, { acceptedOutputCostRegressionTaskIds: ["task-a"] }],
    ["latency", { latencyMs: 2_001 }, { latencyObjectiveExceededTaskIds: ["task-a"] }],
  ])("returns a policy failure with task attribution for a %s regression", (_name, candidatePatch, expected) => {
    const original = input();
    const observations = original.observations.map((observation) =>
      observation.arm === "candidate" ? { ...observation, ...candidatePatch } : observation,
    );
    const item = fixture({ ...original, observations });
    expect(runRouterValueProofCli([
      `--input=${item.inputPath}`,
      `--output=${item.outputPath}`,
    ], item.io)).toBe(1);
    expect(JSON.parse(readFileSync(item.outputPath, "utf8"))).toMatchObject({
      ok: false,
      ...expected,
    });
  });

  it.each([
    ["held-out cohort", (value: any) => { value.cohort.heldOut = "false"; }, "router_value_cohort_not_held_out"],
    ["accepted observation", (value: any) => { value.observations[0].accepted = "false"; }, "router_value_acceptance_invalid"],
  ])("rejects a string boolean for %s", (_name, mutate, error) => {
    const value: any = input();
    mutate(value);
    const item = fixture(value);
    expect(runRouterValueProofCli([
      `--input=${item.inputPath}`,
      `--output=${item.outputPath}`,
    ], item.io)).toBe(2);
    expect(JSON.parse(item.stderr.join(""))).toEqual({ ok: false, error });
  });

  it("binds the report digest to the exact held-out cohort bytes", () => {
    const first = fixture();
    const secondInput = input();
    const second = fixture({
      ...secondInput,
      observations: secondInput.observations.map((observation) => ({
        ...observation,
        evidenceRefs: observation.evidenceRefs.map((reference) => `${reference}:second`),
      })),
    });

    expect(runRouterValueProofCli([
      `--input=${first.inputPath}`,
      `--output=${first.outputPath}`,
    ], first.io)).toBe(0);
    expect(runRouterValueProofCli([
      `--input=${second.inputPath}`,
      `--output=${second.outputPath}`,
    ], second.io)).toBe(0);

    const firstBytes = readFileSync(first.inputPath);
    const firstReport = JSON.parse(readFileSync(first.outputPath, "utf8"));
    const secondReport = JSON.parse(readFileSync(second.outputPath, "utf8"));
    expect(firstReport.cohortDigest).toBe(
      `sha256:${createHash("sha256").update(firstBytes).digest("hex")}`,
    );
    expect(secondReport.cohortDigest).not.toBe(firstReport.cohortDigest);
  });
});
