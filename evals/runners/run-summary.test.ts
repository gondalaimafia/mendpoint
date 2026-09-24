import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { corpusStatusOf, summarizeSyntheticRun, type SyntheticRunSummary } from "./run-summary.js";

const REPO_ROOT = resolve(__dirname, "..", "..");

describe("summarizeSyntheticRun", () => {
  const base = {
    corpusConfigured: true,
    corpusRoot: "/corpus",
    generatedScenariosRun: 46,
    suiteTotal: 67,
    suitePassed: 67,
    p0Failures: 0,
    readinessOverall: "PASS",
  };

  it("reports FULL only when every corpus scenario ran (nothing skipped)", () => {
    const s = summarizeSyntheticRun({ ...base, corpusScenariosRun: 21, corpusSkippedScenarioIds: [] });
    expect(s.corpusStatus).toBe("full");
    expect(s.corpusAvailable).toBe(true);
    expect(s.corpusScenariosRun).toBe(21);
    expect(s.corpusScenariosSkipped).toBe(0);
    expect(s.corpusScenariosTotal).toBe(21);
    expect(s.corpusSkippedScenarioIds).toEqual([]);
  });

  it("reports PARTIAL when some corpus scenarios ran but any were skipped", () => {
    // 20 of 21 ran — the exact case the honest label must not call "full".
    const s = summarizeSyntheticRun({
      ...base,
      corpusScenariosRun: 20,
      corpusSkippedScenarioIds: ["regauge-internal-api-rename"],
    });
    expect(s.corpusStatus).toBe("partial");
    expect(s.corpusAvailable).toBe(true);
    expect(s.corpusScenariosRun).toBe(20);
    expect(s.corpusScenariosSkipped).toBe(1);
    expect(s.corpusScenariosTotal).toBe(21);
    expect(s.corpusSkippedScenarioIds).toEqual(["regauge-internal-api-rename"]);
  });

  it("reports UNAVAILABLE when no corpus scenario ran", () => {
    const s = summarizeSyntheticRun({
      ...base,
      corpusConfigured: false,
      corpusScenariosRun: 0,
      corpusSkippedScenarioIds: ["a", "b", "c"],
    });
    expect(s.corpusStatus).toBe("unavailable");
    expect(s.corpusAvailable).toBe(false);
    expect(s.corpusScenariosSkipped).toBe(3);
  });

  it("sorts skipped ids for a stable, diffable summary", () => {
    const s = summarizeSyntheticRun({ ...base, corpusScenariosRun: 1, corpusSkippedScenarioIds: ["c", "a", "b"] });
    expect(s.corpusSkippedScenarioIds).toEqual(["a", "b", "c"]);
  });

  it("corpusStatusOf is the three-way primitive (a >0 collapse would break PARTIAL)", () => {
    expect(corpusStatusOf(21, 0)).toBe("full");
    expect(corpusStatusOf(20, 1)).toBe("partial");
    expect(corpusStatusOf(0, 21)).toBe("unavailable");
  });
});

describe("nightly-synthetic-eval 'Report what actually ran' step", () => {
  const workflow = parse(
    readFileSync(resolve(REPO_ROOT, ".github/workflows/nightly-synthetic-eval.yml"), "utf8"),
  ) as Record<string, any>;
  const steps = workflow.jobs["synthetic-eval"].steps as Record<string, any>[];
  const stepRun = (() => {
    const found = steps.find((s) => s.name === "Report what actually ran");
    if (!found) throw new Error("step not found: Report what actually ran");
    return found.run as string;
  })();

  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  /** Runs the shipped step shell with a fixture run-summary.json (or none) and returns the job summary. */
  function runStep(summary: Partial<SyntheticRunSummary> | null): string {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-nightly-summary-"));
    tmpDirs.push(dir);
    mkdirSync(join(dir, "evals", "reports"), { recursive: true });
    if (summary) {
      writeFileSync(join(dir, "evals/reports/run-summary.json"), JSON.stringify(summary), "utf8");
    }
    const stepSummary = join(dir, "step-summary.md");
    writeFileSync(stepSummary, "", "utf8");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", stepRun], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: stepSummary },
    });
    if (result.status !== 0) throw new Error(`step exited ${result.status}: ${result.stderr}`);
    return readFileSync(stepSummary, "utf8");
  }

  const full: Partial<SyntheticRunSummary> = {
    corpusStatus: "full",
    corpusScenariosRun: 21,
    corpusScenariosSkipped: 0,
    corpusScenariosTotal: 21,
    corpusSkippedScenarioIds: [],
    generatedScenariosRun: 46,
    suitePassed: 67,
    suiteTotal: 67,
    readinessOverall: "PASS",
  };
  const partial: Partial<SyntheticRunSummary> = {
    corpusStatus: "partial",
    corpusScenariosRun: 20,
    corpusScenariosSkipped: 1,
    corpusScenariosTotal: 21,
    corpusSkippedScenarioIds: ["regauge-internal-api-rename"],
    generatedScenariosRun: 46,
    suitePassed: 66,
    suiteTotal: 67,
    readinessOverall: "FAIL",
  };
  const unavailable: Partial<SyntheticRunSummary> = {
    corpusStatus: "unavailable",
    corpusScenariosRun: 0,
    corpusScenariosSkipped: 21,
    corpusScenariosTotal: 21,
    corpusSkippedScenarioIds: [],
    generatedScenariosRun: 46,
    suitePassed: 46,
    suiteTotal: 46,
    readinessOverall: "FAIL",
  };

  it("labels a full run 'full corpus + synthetic'", () => {
    const out = runStep(full);
    expect(out).toContain("full corpus + synthetic");
    expect(out).not.toContain("partial corpus");
    expect(out).not.toContain("corpus unavailable");
    expect(out).toContain("ran all 21 corpus scenario(s)");
  });

  it("labels a partial run 'partial corpus' and names the skipped scenario", () => {
    const out = runStep(partial);
    expect(out).toContain("partial corpus + synthetic");
    expect(out).toContain("20 of 21");
    expect(out).toContain("skipped: regauge-internal-api-rename");
    expect(out).toContain("NOT a full-corpus pass");
    expect(out).not.toContain("full corpus + synthetic");
  });

  it("labels a corpus-free run 'corpus unavailable, synthetic only'", () => {
    const out = runStep(unavailable);
    expect(out).toContain("corpus unavailable, synthetic only");
    expect(out).toContain("NOT a full-corpus pass");
    expect(out).not.toContain("full corpus + synthetic");
    expect(out).not.toContain("partial corpus");
  });

  it("says it measured nothing when no run summary was produced", () => {
    const out = runStep(null);
    expect(out).toContain("measured nothing");
  });
});
