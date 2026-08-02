/**
 * warden-bench v0 — internal eval only (not for marketing).
 *
 * Loads fixtures/warden-bench/* and runs Warden with goal text only.
 */
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWarden } from "@mendpoint/agent";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const BENCH_ROOT = join(root, "fixtures/warden-bench");

export type WardenBenchCaseMeta = {
  verify?: string;
  timeoutSec?: number;
  expected?: "verified" | "safe_handoff";
  expectedMode?: string;
  allowedFiles?: string[];
  forbiddenFiles?: string[];
};

export type WardenBenchCaseResult = {
  id: string;
  ok: boolean;
  steps: number;
  filesChanged: string[];
  stoppedReason: string;
  error?: string;
  durationMs: number;
  outcome: "resolved" | "already_green" | "safe_handoff" | "wrong_patch" | "timeout" | "error";
  toolCalls: number;
  modelCalls: number;
};

export type WardenBenchReport = {
  passed: number;
  total: number;
  cases: WardenBenchCaseResult[];
};

function listCaseDirs(benchRoot: string): string[] {
  if (!existsSync(benchRoot)) return [];
  return readdirSync(benchRoot)
    .filter((name) => {
      const abs = join(benchRoot, name);
      try {
        return (
          statSync(abs).isDirectory() &&
          existsSync(join(abs, "issue.md")) &&
          existsSync(join(abs, "repo"))
        );
      } catch {
        return false;
      }
    })
    .sort();
}

function loadMeta(caseDir: string): WardenBenchCaseMeta {
  const p = join(caseDir, "meta.json");
  if (!existsSync(p)) return { verify: "node check.mjs", timeoutSec: 60 };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as WardenBenchCaseMeta;
  } catch {
    return { verify: "node check.mjs", timeoutSec: 60 };
  }
}

async function runCase(id: string, caseDir: string): Promise<WardenBenchCaseResult> {
  const meta = loadMeta(caseDir);
  const goal = readFileSync(join(caseDir, "issue.md"), "utf8").trim();
  const verifyCommand = meta.verify ?? "node check.mjs";
  const work = mkdtempSync(join(tmpdir(), `warden-bench-${id}-`));
  const started = Date.now();
  const timeoutMs = Math.max(1, Math.min(meta.timeoutSec ?? 60, 300)) * 1000;
  const deadline = started + timeoutMs;

  try {
    cpSync(join(caseDir, "repo"), work, { recursive: true });
    const result = await runWarden({
      goal,
      repoRoot: work,
      verifyCommand,
      maxSteps: 20,
      shouldContinue: () => Date.now() <= deadline,
    });
    const expected = meta.expected ?? "verified";
    const allowedFiles = new Set(meta.allowedFiles ?? []);
    const unexpectedFiles = allowedFiles.size
      ? result.filesChanged.filter((file) => !allowedFiles.has(file))
      : [];
    const forbiddenFiles = result.filesChanged.filter((file) =>
      (meta.forbiddenFiles ?? []).some((forbidden) => file.includes(forbidden)),
    );
    const baseline = result.steps.find(
      (step) => step.step === 0 && step.call.tool === "run_command",
    );
    const baselineFailed = baseline?.result.ok === false;
    const modeMatches = !meta.expectedMode || result.reportMarkdown.includes(`\`${meta.expectedMode}\``);
    const timedOut = Date.now() > deadline + 2_000;
    const outcome: WardenBenchCaseResult["outcome"] = timedOut
      ? "timeout"
      : !baselineFailed && result.stoppedReason === "already_passing"
        ? "already_green"
        : baselineFailed && result.ok
          ? "resolved"
          : expected === "safe_handoff" && !result.ok && result.filesChanged.length === 0
            ? "safe_handoff"
            : "wrong_patch";
    const outcomeMatches = expected === "verified"
      ? outcome === "resolved"
      : outcome === "safe_handoff";
    const ok = outcomeMatches && modeMatches && !unexpectedFiles.length && !forbiddenFiles.length && !timedOut;
    const errors = [
      !outcomeMatches ? `expected ${expected}, received ${result.stoppedReason}` : undefined,
      expected === "verified" && !baselineFailed
        ? "repair verifier did not fail before Warden ran"
        : undefined,
      !modeMatches ? `expected diagnosis ${meta.expectedMode}` : undefined,
      unexpectedFiles.length ? `unexpected files: ${unexpectedFiles.join(", ")}` : undefined,
      forbiddenFiles.length ? `forbidden files: ${forbiddenFiles.join(", ")}` : undefined,
      timedOut ? `case exceeded ${timeoutMs}ms` : undefined,
    ].filter(Boolean);
    return {
      id,
      ok,
      steps: result.steps.length,
      filesChanged: result.filesChanged,
      stoppedReason: result.stoppedReason,
      ...(errors.length ? { error: errors.join("; ") } : {}),
      durationMs: Date.now() - started,
      outcome,
      toolCalls: result.metrics.toolCalls,
      modelCalls: result.metrics.model.calls,
    };
  } catch (e) {
    return {
      id,
      ok: false,
      steps: 0,
      filesChanged: [],
      stoppedReason: "error",
      error: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - started,
      outcome: "error",
      toolCalls: 0,
      modelCalls: 0,
    };
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
}

/**
 * Run all warden-bench fixtures.
 */
export async function runWardenBench(opts?: {
  benchRoot?: string;
  caseIds?: string[];
}): Promise<WardenBenchReport> {
  const benchRoot = opts?.benchRoot ?? BENCH_ROOT;
  let ids = listCaseDirs(benchRoot);
  if (opts?.caseIds?.length) {
    const allow = new Set(opts.caseIds);
    ids = ids.filter((id) => allow.has(id));
  }

  const cases: WardenBenchCaseResult[] = [];
  for (const id of ids) {
    cases.push(await runCase(id, join(benchRoot, id)));
  }

  const passed = cases.filter((c) => c.ok).length;
  return { passed, total: cases.length, cases };
}

function printTable(report: WardenBenchReport) {
  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  console.log("");
  console.log(
    `${pad("CASE", 22)} ${pad("OK", 4)} ${pad("TOOLS", 6)} ${pad("MODEL", 6)} ${pad("MS", 8)} ${pad("OUTCOME", 14)} FILES`,
  );
  console.log("-".repeat(80));
  for (const c of report.cases) {
    console.log(
      `${pad(c.id, 22)} ${pad(c.ok ? "yes" : "no", 4)} ${pad(String(c.toolCalls), 6)} ${pad(String(c.modelCalls), 6)} ${pad(String(c.durationMs), 8)} ${pad(c.outcome, 14)} ${c.filesChanged.join(",") || "-"}`,
    );
    if (c.error) console.log(`  error: ${c.error}`);
  }
  console.log("-".repeat(80));
  console.log(
    `warden-bench: ${report.passed}/${report.total} passed (internal only — not for marketing)`,
  );
  console.log("");
}

async function main() {
  const report = await runWardenBench();
  printTable(report);
  if (report.total < 5) {
    console.error("warden-bench FAILED: expected ≥5 cases");
    process.exit(1);
  }
  if (report.passed !== report.total) {
    console.error(`warden-bench FAILED: ${report.total - report.passed} capability cases failed`);
    process.exit(1);
  }
  process.exit(0);
}

const isMain =
  process.argv[1]?.includes("warden-bench") ||
  process.argv[1]?.replace(/\\/g, "/").endsWith("warden-bench.ts") ||
  process.argv[1]?.replace(/\\/g, "/").endsWith("warden-bench.js");

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
