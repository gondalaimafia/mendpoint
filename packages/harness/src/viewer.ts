/**
 * Trajectory viewer — list runs and pretty-print plan/trace/score.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { listRunIds, loadRunScore } from "./dogfood.js";
import { runDir, runsDir, type HarnessTenantScope } from "./trajectory.js";

export type RunListItem = {
  runId: string;
  ok?: boolean;
  durationMs?: number;
  hasTrace: boolean;
  hasPlan: boolean;
};

export function listTrajectories(
  baseDir: string,
  scope?: HarnessTenantScope,
): RunListItem[] {
  const root = runsDir(baseDir, scope);
  if (!existsSync(root)) return [];
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  return dirs.map((runId) => {
    const paths = runDir(baseDir, runId, scope);
    const score = loadRunScore(baseDir, runId, scope);
    return {
      runId,
      ok: score?.ok,
      durationMs: score?.durationMs,
      hasTrace: existsSync(paths.tracePath),
      hasPlan: existsSync(paths.planPath),
    };
  });
}

export function viewTrajectory(
  baseDir: string,
  runId: string,
  opts?: { maxTraceLines?: number },
  scope?: HarnessTenantScope,
): string {
  const paths = runDir(baseDir, runId, scope);
  if (!existsSync(paths.root)) {
    return `run not found: ${runId}`;
  }
  const lines: string[] = [`### Trajectory ${runId}`, `root: ${paths.root}`];
  if (existsSync(paths.scorePath)) {
    lines.push("## score.json", readFileSync(paths.scorePath, "utf8").trim());
  }
  if (existsSync(paths.planPath)) {
    const plan = JSON.parse(readFileSync(paths.planPath, "utf8")) as {
      id?: string;
      steps?: Array<{ id?: string; title?: string; status?: string; action?: string }>;
    };
    lines.push(
      "## plan",
      `id=${plan.id ?? "?"} steps=${plan.steps?.length ?? 0}`,
    );
    for (const s of plan.steps ?? []) {
      lines.push(
        `- [${s.status ?? "?"}] ${s.action ?? ""} ${s.title ?? s.id ?? ""}`,
      );
    }
  }
  if (existsSync(paths.tracePath)) {
    const max = opts?.maxTraceLines ?? 40;
    const all = readFileSync(paths.tracePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    lines.push(`## trace.jsonl (${all.length} events, showing ≤${max})`);
    for (const line of all.slice(0, max)) {
      try {
        const e = JSON.parse(line) as {
          ts?: string;
          type?: string;
          message?: string;
        };
        lines.push(`- ${e.ts ?? ""} ${e.type ?? ""} ${e.message ?? line}`);
      } catch {
        lines.push(`- ${line}`);
      }
    }
    if (all.length > max) lines.push(`… ${all.length - max} more`);
  }
  return lines.join("\n");
}

export function formatRunList(baseDir: string, scope?: HarnessTenantScope): string {
  const items = listTrajectories(baseDir, scope);
  if (!items.length) return "No runs/ trajectories found.";
  const lines = [`### Trajectories (${items.length})`];
  for (const r of items.slice(0, 50)) {
    const flag = r.ok === undefined ? "?" : r.ok ? "ok" : "FAIL";
    lines.push(
      `- ${r.runId} [${flag}] ${r.durationMs ?? "?"}ms plan=${r.hasPlan} trace=${r.hasTrace}`,
    );
  }
  if (items.length > 50) lines.push(`… ${items.length - 50} more`);
  // also listRunIds with scores for dogfood alignment
  const scored = listRunIds(baseDir, scope).length;
  lines.push(`scored: ${scored}`);
  return lines.join("\n");
}
