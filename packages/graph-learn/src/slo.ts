/**
 * Graph-RAG latency SLOs — ring-buffer instrumentation + p50/p99 checks.
 * Targets sized for local SQLite property graph (not network-backed Kùzu).
 */

export type SloTarget = { p50Ms: number; p99Ms: number };

/** Default budgets (ms). Override via setSloTargets. */
export const DEFAULT_SLO_TARGETS: Record<string, SloTarget> = {
  default: { p50Ms: 50, p99Ms: 250 },
  stats: { p50Ms: 20, p99Ms: 80 },
  who_consumes_provider: { p50Ms: 40, p99Ms: 150 },
  blast_radius: { p50Ms: 80, p99Ms: 400 },
  path: { p50Ms: 100, p99Ms: 500 },
  pattern_success_rates: { p50Ms: 60, p99Ms: 300 },
  time_travel_calls: { p50Ms: 80, p99Ms: 400 },
  /** Full-repo MODIFIES scan — looser budget after git backfill */
  time_travel_modifies: { p50Ms: 300, p99Ms: 1200 },
  latency_stats: { p50Ms: 10, p99Ms: 40 },
};

const RING = 500;
const samples = new Map<string, number[]>();
let targets: Record<string, SloTarget> = { ...DEFAULT_SLO_TARGETS };

export function setSloTargets(partial: Record<string, SloTarget>): void {
  targets = { ...targets, ...partial };
}

export function resetLatencySamples(): void {
  samples.clear();
}

export function recordLatency(op: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const arr = samples.get(op) ?? [];
  arr.push(ms);
  if (arr.length > RING) arr.splice(0, arr.length - RING);
  samples.set(op, arr);
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const w = rank - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

export type OpLatency = {
  op: string;
  n: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
  target: SloTarget;
  p50Ok: boolean;
  p99Ok: boolean;
};

export function latencyForOp(op: string): OpLatency | undefined {
  const arr = samples.get(op);
  if (!arr?.length) return undefined;
  const p50Ms = percentile(arr, 50);
  const p99Ms = percentile(arr, 99);
  const maxMs = Math.max(...arr);
  const meanMs = arr.reduce((a, b) => a + b, 0) / arr.length;
  const target = targets[op] ?? targets.default!;
  return {
    op,
    n: arr.length,
    p50Ms,
    p99Ms,
    maxMs,
    meanMs,
    target,
    p50Ok: p50Ms <= target.p50Ms,
    p99Ok: p99Ms <= target.p99Ms,
  };
}

export function latencyReport(): {
  ops: OpLatency[];
  totalSamples: number;
  ok: boolean;
  violations: string[];
} {
  const ops: OpLatency[] = [];
  for (const op of [...samples.keys()].sort()) {
    const row = latencyForOp(op);
    if (row) ops.push(row);
  }
  const violations: string[] = [];
  for (const o of ops) {
    if (!o.p50Ok)
      violations.push(
        `${o.op} p50 ${o.p50Ms.toFixed(1)}ms > ${o.target.p50Ms}ms`,
      );
    if (!o.p99Ok)
      violations.push(
        `${o.op} p99 ${o.p99Ms.toFixed(1)}ms > ${o.target.p99Ms}ms`,
      );
  }
  return {
    ops,
    totalSamples: ops.reduce((a, o) => a + o.n, 0),
    ok: violations.length === 0,
    violations,
  };
}

export function checkSlos(minSamples = 3): {
  ok: boolean;
  evaluated: number;
  skipped: number;
  violations: string[];
  report: ReturnType<typeof latencyReport>;
} {
  const report = latencyReport();
  const violations: string[] = [];
  let evaluated = 0;
  let skipped = 0;
  for (const o of report.ops) {
    if (o.n < minSamples) {
      skipped++;
      continue;
    }
    evaluated++;
    if (!o.p50Ok)
      violations.push(
        `${o.op} p50 ${o.p50Ms.toFixed(1)}ms > ${o.target.p50Ms}ms (n=${o.n})`,
      );
    if (!o.p99Ok)
      violations.push(
        `${o.op} p99 ${o.p99Ms.toFixed(1)}ms > ${o.target.p99Ms}ms (n=${o.n})`,
      );
  }
  return {
    ok: violations.length === 0,
    evaluated,
    skipped,
    violations,
    report,
  };
}

export function formatLatencyReport(
  report: ReturnType<typeof latencyReport> = latencyReport(),
): string {
  const lines = [
    `### Graph-RAG latency (n=${report.totalSamples})`,
    report.ok ? "SLO: PASS" : `SLO: FAIL — ${report.violations.join("; ")}`,
  ];
  for (const o of report.ops) {
    const flag = o.p50Ok && o.p99Ok ? "ok" : "FAIL";
    lines.push(
      `- ${o.op}: n=${o.n} p50=${o.p50Ms.toFixed(1)}ms p99=${o.p99Ms.toFixed(1)}ms max=${o.maxMs.toFixed(1)}ms [${flag}]`,
    );
  }
  return lines.join("\n");
}
