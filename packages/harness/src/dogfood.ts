/**
 * Dogfood instrumentation — aggregate runs/<id>/score.json toward Day-90 targets.
 * Targets: ≥30 runs, merge/ok rate ≥50%, recovered failures tracked.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { runDir, runsDir, type HarnessTenantScope, type RunScore } from "./trajectory.js";

export const DOGFOOD_TARGET_RUNS = 30;
export const DOGFOOD_TARGET_OK_RATE = 0.5;

export type DogfoodRunSummary = {
  runId: string;
  ok: boolean;
  durationMs: number;
  stepsTotal: number;
  stepsFailed: number;
  recoveredFromFailure: boolean;
  graphQueries?: number;
  tokensEst?: number;
  path: string;
  /** True when this record was fabricated by seedDogfoodScores, not a real run. */
  synthetic: boolean;
};

export type DogfoodReport = {
  generatedAt: string;
  baseDir: string;
  /**
   * All count/rate fields below describe REAL runs only. Fabricated (seeded)
   * records are excluded from them so a synthetic score can never inflate the
   * day-90 verdict; they are surfaced separately via `synthetic`/`syntheticRuns`.
   */
  totalRuns: number;
  okRuns: number;
  failRuns: number;
  okRate: number;
  recovered: number;
  avgDurationMs: number;
  totalGraphQueries: number;
  targetRuns: number;
  targetOkRate: number;
  meetsVolume: boolean;
  meetsOkRate: boolean;
  day90Ready: boolean;
  /** True when any fabricated record was present in this base dir. */
  synthetic: boolean;
  /** Count of fabricated records found and excluded from the real figures. */
  syntheticRuns: number;
  byDay: Array<{ day: string; runs: number; ok: number }>;
  runs: DogfoodRunSummary[];
  notes: string[];
};

function scorePath(baseDir: string, runId: string, scope?: HarnessTenantScope): string {
  return runDir(baseDir, runId, scope).scorePath;
}

export function listRunIds(baseDir: string, scope?: HarnessTenantScope): string[] {
  const root = runsDir(baseDir, scope);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) => existsSync(scorePath(baseDir, id, scope)))
    .sort();
}

export function loadRunScore(
  baseDir: string,
  runId: string,
  scope?: HarnessTenantScope,
): RunScore | undefined {
  const p = scorePath(baseDir, runId, scope);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RunScore;
  } catch {
    return undefined;
  }
}

export function collectDogfood(baseDir: string, scope?: HarnessTenantScope): DogfoodReport {
  const ids = listRunIds(baseDir, scope);
  const runs: DogfoodRunSummary[] = [];
  const dayMap = new Map<string, { runs: number; ok: number }>();

  for (const runId of ids) {
    const s = loadRunScore(baseDir, runId, scope);
    if (!s) continue;
    const path = scorePath(baseDir, runId, scope);
    const synthetic = !!s.synthetic;
    runs.push({
      runId,
      ok: !!s.ok,
      durationMs: s.durationMs ?? 0,
      stepsTotal: s.stepsTotal ?? 0,
      stepsFailed: s.stepsFailed ?? 0,
      recoveredFromFailure: !!s.recoveredFromFailure,
      graphQueries: s.graphQueries,
      tokensEst: s.tokensEst,
      path,
      synthetic,
    });
    // Fabricated records never contribute to the per-day tally that feeds the
    // real figures.
    if (synthetic) continue;
    // day from run folder mtime approximation via score if no ts — use runId prefix if uuid skip
    let day = "unknown";
    try {
      const st = readFileSync(path, "utf8");
      // no ts in score — use file birth via score content only
      void st;
      day = new Date().toISOString().slice(0, 10);
    } catch {
      /* */
    }
    // Prefer embedding day from path stats isn't portable; group all as "ledger"
    const bucket = dayMap.get(day) ?? { runs: 0, ok: 0 };
    bucket.runs++;
    if (s.ok) bucket.ok++;
    dayMap.set(day, bucket);
  }

  // Merge ledger entries if present (explicit timestamps)
  const ledger = readLedger(baseDir, scope);
  for (const e of ledger) {
    const day = e.ts.slice(0, 10);
    const synthetic = e.source === "seed";
    const bucket = dayMap.get(day) ?? { runs: 0, ok: 0 };
    // only count ledger-only runs not already in runs/
    if (!runs.some((r) => r.runId === e.runId)) {
      // Fabricated ledger entries are recorded but excluded from the day tally.
      if (!synthetic) {
        bucket.runs++;
        if (e.ok) bucket.ok++;
        dayMap.set(day, bucket);
      }
      runs.push({
        runId: e.runId,
        ok: e.ok,
        durationMs: e.durationMs,
        stepsTotal: e.stepsTotal ?? 0,
        stepsFailed: e.stepsFailed ?? 0,
        recoveredFromFailure: !!e.recoveredFromFailure,
        graphQueries: e.graphQueries,
        path: "ledger",
        synthetic,
      });
    } else if (!synthetic) {
      // refresh day buckets from ledger timestamps for known real runs
      dayMap.set(day, bucket);
    }
  }

  // The day-90 verdict is computed from REAL runs only. A fabricated (seeded)
  // record is recorded and surfaced, but it can never contribute to the volume
  // or ok-rate that gate readiness — the whole point of the integrity fix.
  const realRuns = runs.filter((r) => !r.synthetic);
  const syntheticRuns = runs.length - realRuns.length;
  const totalRuns = realRuns.length;
  const okRuns = realRuns.filter((r) => r.ok).length;
  const failRuns = totalRuns - okRuns;
  const okRate = totalRuns ? okRuns / totalRuns : 0;
  const recovered = realRuns.filter((r) => r.recoveredFromFailure).length;
  const avgDurationMs = totalRuns
    ? realRuns.reduce((a, r) => a + r.durationMs, 0) / totalRuns
    : 0;
  const totalGraphQueries = realRuns.reduce(
    (a, r) => a + (r.graphQueries ?? 0),
    0,
  );
  const meetsVolume = totalRuns >= DOGFOOD_TARGET_RUNS;
  const meetsOkRate = okRate >= DOGFOOD_TARGET_OK_RATE;
  const notes: string[] = [];
  if (syntheticRuns > 0)
    notes.push(
      `SYNTHETIC: ${syntheticRuns} fabricated record(s) present and EXCLUDED from the figures above. This base dir is not a real measurement.`,
    );
  if (!meetsVolume)
    notes.push(
      `Need ${DOGFOOD_TARGET_RUNS - totalRuns} more run(s) to hit volume target (${DOGFOOD_TARGET_RUNS}).`,
    );
  if (totalRuns && !meetsOkRate)
    notes.push(
      `Ok rate ${(okRate * 100).toFixed(0)}% below target ${(DOGFOOD_TARGET_OK_RATE * 100).toFixed(0)}% — freeze features, fix harness.`,
    );
  if (meetsVolume && meetsOkRate)
    notes.push("Day-90 dogfood gates met (volume + ok rate).");

  return {
    generatedAt: new Date().toISOString(),
    baseDir,
    totalRuns,
    okRuns,
    failRuns,
    okRate,
    recovered,
    avgDurationMs,
    totalGraphQueries,
    targetRuns: DOGFOOD_TARGET_RUNS,
    targetOkRate: DOGFOOD_TARGET_OK_RATE,
    meetsVolume,
    meetsOkRate,
    day90Ready: meetsVolume && meetsOkRate,
    synthetic: syntheticRuns > 0,
    syntheticRuns,
    byDay: [...dayMap.entries()]
      .map(([day, v]) => ({ day, runs: v.runs, ok: v.ok }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    runs,
    notes,
  };
}

export type LedgerEntry = {
  ts: string;
  runId: string;
  ok: boolean;
  durationMs: number;
  stepsTotal?: number;
  stepsFailed?: number;
  recoveredFromFailure?: boolean;
  graphQueries?: number;
  source?: string;
  tenantId?: string;
};

export function ledgerPath(baseDir: string, scope?: HarnessTenantScope): string {
  return join(runsDir(baseDir, scope), "dogfood-ledger.jsonl");
}

export function appendDogfoodLedger(
  baseDir: string,
  entry: Omit<LedgerEntry, "ts"> & { ts?: string },
  scope?: HarnessTenantScope,
): void {
  const root = runsDir(baseDir, scope);
  mkdirSync(root, { recursive: true });
  const line: LedgerEntry = {
    ts: entry.ts ?? new Date().toISOString(),
    runId: entry.runId,
    ok: entry.ok,
    durationMs: entry.durationMs,
    stepsTotal: entry.stepsTotal,
    stepsFailed: entry.stepsFailed,
    recoveredFromFailure: entry.recoveredFromFailure,
    graphQueries: entry.graphQueries,
    source: entry.source ?? "harness",
    tenantId: entry.tenantId,
  };
  appendFileSync(ledgerPath(baseDir, scope), JSON.stringify(line) + "\n", "utf8");
}

export function readLedger(baseDir: string, scope?: HarnessTenantScope): LedgerEntry[] {
  const p = ledgerPath(baseDir, scope);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as LedgerEntry;
      } catch {
        return null;
      }
    })
    .filter((x): x is LedgerEntry => !!x);
}

export function writeDogfoodReport(
  baseDir: string,
  report?: DogfoodReport,
  scope?: HarnessTenantScope,
): string {
  const r = report ?? collectDogfood(baseDir, scope);
  const root = runsDir(baseDir, scope);
  mkdirSync(root, { recursive: true });
  const out = join(root, "dogfood-report.json");
  writeFileSync(out, JSON.stringify(r, null, 2), "utf8");
  return out;
}

export function formatDogfoodReport(r: DogfoodReport): string {
  return [
    `### Dogfood report`,
    ...(r.synthetic
      ? [
          `SYNTHETIC REPORT — ${r.syntheticRuns} fabricated record(s) present and excluded; NOT a real measurement.`,
        ]
      : []),
    `runs: ${r.totalRuns}/${r.targetRuns} (ok=${r.okRuns} fail=${r.failRuns})`,
    `okRate: ${(r.okRate * 100).toFixed(1)}% (target ${(r.targetOkRate * 100).toFixed(0)}%)`,
    `recovered: ${r.recovered} · avgDuration: ${r.avgDurationMs.toFixed(0)}ms · graphQueries: ${r.totalGraphQueries}`,
    `day90Ready: ${r.day90Ready ? "YES" : "NO"} (volume=${r.meetsVolume} okRate=${r.meetsOkRate})`,
    ...r.notes.map((n) => `- ${n}`),
  ].join("\n");
}

/**
 * Seed N synthetic dogfood scores for offline demos / CI (does not run harness).
 */
export function seedDogfoodScores(
  baseDir: string,
  n: number,
  opts?: { okRate?: number; prefix?: string },
  scope?: HarnessTenantScope,
): string[] {
  const okRate = opts?.okRate ?? 0.6;
  const prefix = opts?.prefix ?? "dogfood-seed";
  const ids: string[] = [];
  const root = runsDir(baseDir, scope);
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < n; i++) {
    const runId = `${prefix}-${String(i + 1).padStart(3, "0")}`;
    const dir = join(root, runId);
    mkdirSync(dir, { recursive: true });
    const ok = i / n < okRate;
    const score: RunScore = {
      runId,
      ok,
      stepsTotal: 3,
      stepsDone: ok ? 3 : 2,
      stepsFailed: ok ? 0 : 1,
      recoveredFromFailure: !ok && i % 2 === 0,
      durationMs: 50 + i * 3,
      graphQueries: 2 + (i % 5),
      tokensEst: 1000 + i * 10,
      tenantId: scope?.tenantId,
      // Structural marker: these scores are fabricated, not real runs. collectDogfood
      // reads this to exclude them from the real dogfood figures.
      synthetic: true,
    };
    writeFileSync(join(dir, "score.json"), JSON.stringify(score, null, 2));
    writeFileSync(
      join(dir, "plan.json"),
      JSON.stringify({ id: runId, steps: [] }, null, 2),
    );
    appendDogfoodLedger(baseDir, {
      runId,
      ok,
      durationMs: score.durationMs,
      stepsTotal: score.stepsTotal,
      stepsFailed: score.stepsFailed,
      recoveredFromFailure: score.recoveredFromFailure,
      graphQueries: score.graphQueries,
      source: "seed",
      tenantId: scope?.tenantId,
    }, scope);
    ids.push(runId);
  }
  return ids;
}
