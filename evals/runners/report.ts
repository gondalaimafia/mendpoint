/**
 * Phase 5/12 — report generation.
 *
 * Turns the per-run records + ground truth into the two required artifacts:
 *   - evals/reports/latest.md   (design-partner readiness dashboard)
 *   - evals/FAILURES.md         (failure backlog, one entry per unresolved issue)
 *
 * Everything here is derived from real run numbers. Nothing is fabricated; a
 * dimension the runner could not measure is reported as such, never scored.
 */
import type { GroundTruth } from "../ground-truth/schema.js";
import type { RunRecord, RunFailure } from "./types.js";

export interface ScoredRun {
  record: RunRecord;
  gt: GroundTruth;
}

const SAFE_NOTE_CATEGORIES = new Set(["COVERAGE_GAP", "HARNESS_LIMITATION"]);

const pct = (n: number, d: number): string =>
  d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;

function unsafeFailures(r: RunRecord): RunFailure[] {
  return r.failures.filter((f) => !SAFE_NOTE_CATEGORIES.has(f.category));
}

function group<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    (m.get(k) ?? m.set(k, []).get(k)!).push(it);
  }
  return m;
}

function tableFor(
  rows: ScoredRun[],
  label: string,
  keyFn: (s: ScoredRun) => string,
): string {
  const groups = [...group(rows, keyFn).entries()].sort(([a], [b]) => a.localeCompare(b));
  const lines = [`| ${label} | scenarios | passed | pass rate |`, `| --- | --- | --- | --- |`];
  for (const [k, gs] of groups) {
    const passed = gs.filter((g) => g.record.passed).length;
    lines.push(`| ${k} | ${gs.length} | ${passed} | ${pct(passed, gs.length)} |`);
  }
  return lines.join("\n");
}

export function renderLatestReport(scored: ScoredRun[]): string {
  const now = new Date().toISOString();
  const commit = scored[0]?.record.git_commit ?? "unknown";
  const total = scored.length;
  const passed = scored.filter((s) => s.record.passed).length;
  const fettler = scored.filter((s) => s.record.product === "fettler");
  const regauge = scored.filter((s) => s.record.product === "regauge");

  const allUnsafe = scored.flatMap((s) =>
    unsafeFailures(s.record).map((f) => ({ s, f })),
  );
  const coverageGaps = scored.flatMap((s) =>
    s.record.failures.filter((f) => f.category === "COVERAGE_GAP").map((f) => ({ s, f })),
  );
  const sevRank: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
  const topRisks = [...allUnsafe].sort(
    (a, b) => (sevRank[a.f.severity] ?? 9) - (sevRank[b.f.severity] ?? 9),
  );

  const out: string[] = [];
  out.push(`# MendPoint synthetic-repo evaluation — latest run`);
  out.push("");
  out.push(`- Generated: ${now}`);
  out.push(`- Git commit: \`${commit}\``);
  out.push(`- Invocation: deterministic analysis core (Fettler: change-intel -> code-impact, LLM off; ReGauge: analyzeRecipe over shipped registry, analyze-only)`);
  out.push("");
  out.push(`This corpus is built to make MendPoint fail, not to flatter it. "Pass" means the product did the SAFE, correct thing for the CURRENT shipped engine (found the impacted files without touching a distractor, or correctly abstained). Coverage gaps and dimensions the harness cannot yet observe are listed separately and do NOT count as passes.`);
  out.push("");

  out.push(`## Overall`);
  out.push("");
  out.push(`- Total scenarios: ${total}`);
  out.push(`- Passed (safe + correct for shipped engine): ${passed} (${pct(passed, total)})`);
  out.push(`- Unsafe/incorrect failures: ${allUnsafe.length}`);
  out.push(`- Coverage gaps recorded: ${coverageGaps.length}`);
  out.push(`- P0 failures (dangerous / materially incorrect): ${allUnsafe.filter((x) => x.f.severity === "P0").length}`);
  out.push("");

  // Phase 8: development / validation / holdout, presented SEPARATELY. A number
  // computed on development scenarios (seen during fixing) tells us the benchmark
  // improved; the holdout number is the honest measure of whether the PRODUCT
  // improved. Never conflate them.
  out.push(`## Dataset splits (Phase 8 — development / validation / holdout)`);
  out.push("");
  out.push(
    `Holdout scenarios are procedurally generated from scenario families and are NEVER inspected while fixing. Read the holdout row as the honest product-quality signal; development/validation can be inflated by fixing to the benchmark.`,
  );
  out.push("");
  const splitOrder = ["development", "validation", "holdout"] as const;
  out.push(`| split | scenarios | passed | pass rate |`);
  out.push(`| --- | --- | --- | --- |`);
  for (const split of splitOrder) {
    const rows = scored.filter((s) => s.gt.dataset_split === split);
    const pass = rows.filter((s) => s.record.passed).length;
    out.push(`| ${split} | ${rows.length} | ${pass} | ${pct(pass, rows.length)} |`);
  }
  out.push("");
  const holdout = scored.filter((s) => s.gt.dataset_split === "holdout");
  out.push(`### Holdout detail`);
  out.push("");
  if (holdout.length === 0) {
    out.push(`No holdout scenarios in this run.`);
  } else {
    out.push(`| scenario | product | L | behavior | passed |`);
    out.push(`| --- | --- | --- | --- | --- |`);
    for (const s of holdout) {
      out.push(
        `| ${s.record.scenario_id} | ${s.record.product} | ${s.gt.difficulty} | ${s.gt.correct_behavior} | ${s.record.passed ? "yes" : "NO"} |`,
      );
    }
  }
  out.push("");

  out.push(`## Fettler`);
  out.push("");
  out.push(`Scenarios: ${fettler.length}, passed ${fettler.filter((s) => s.record.passed).length} (${pct(fettler.filter((s) => s.record.passed).length, fettler.length)})`);
  out.push("");
  out.push(`### By repository family`);
  out.push(tableFor(fettler, "family", (s) => s.gt.repo_family));
  out.push("");
  out.push(`### By difficulty`);
  out.push(tableFor(fettler, "difficulty", (s) => `L${s.gt.difficulty}`));
  out.push("");
  out.push(`### Per scenario (recall / precision / traps)`);
  out.push(`| scenario | L | behavior | recall | precision | traps hit | passed |`);
  out.push(`| --- | --- | --- | --- | --- | --- | --- |`);
  for (const s of fettler) {
    const rec = s.record.grader_results.find((g) => g.dimension === "expected_findings_recall");
    const prec = s.record.grader_results.find((g) => g.dimension === "precision");
    const trap = s.record.grader_results.find((g) => g.dimension === "false_positive_traps");
    const abst = s.record.grader_results.find(
      (g) => g.dimension === "abstention_correctness" || g.dimension === "no_op_correctness",
    );
    const recallStr = rec ? `${Math.round(rec.score * 100)}%` : abst ? "(abstain)" : s.record.error ? "CRASH" : "-";
    const precStr = prec ? `${Math.round(prec.score * 100)}%` : "-";
    const trapStr = trap ? (trap.passed ? "no" : "YES") : abst ? (abst.passed ? "no" : "YES") : "-";
    out.push(
      `| ${s.record.scenario_id} | ${s.gt.difficulty} | ${s.gt.correct_behavior} | ${recallStr} | ${precStr} | ${trapStr} | ${s.record.passed ? "yes" : "NO"} |`,
    );
  }
  out.push("");

  out.push(`## ReGauge`);
  out.push("");
  out.push(`Scenarios: ${regauge.length}, passed ${regauge.filter((s) => s.record.passed).length} (${pct(regauge.filter((s) => s.record.passed).length, regauge.length)})`);
  out.push("");
  out.push(`### By migration family`);
  out.push(tableFor(regauge, "family", (s) => s.gt.recipe_expectation?.family ?? s.gt.repo_family));
  out.push("");
  out.push(`### Per scenario (engine decision)`);
  out.push(`| scenario | L | expected | matched recipes | passed | note |`);
  out.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const s of regauge) {
    const matched = (s.record.activity.notes ?? []).find((n) => n.startsWith("matched="))?.replace("matched=", "") ?? "-";
    const gap = s.record.failures.find((f) => f.category === "COVERAGE_GAP");
    out.push(
      `| ${s.record.scenario_id} | ${s.gt.difficulty} | ${s.gt.correct_behavior} | ${matched} | ${s.record.passed ? "yes" : "NO"} | ${gap ? "coverage gap" : s.record.error ? "CRASH" : ""} |`,
    );
  }
  out.push("");

  out.push(`## Model economics`);
  out.push("");
  out.push(`Not measured in this slice. The deterministic analysis path the runner exercises makes no model calls (Fettler runs with \`useLlm:false\`; the ReGauge recipe engine is pure AST/regex/JSON transforms). Therefore model utilization, token use, cost per evaluation, and escalation rate are genuinely zero/null for these runs rather than fabricated. Measuring routing and cost requires exercising the optional LLM confirmation/repair path (Fettler) and the adaptive-repair loop (ReGauge), which is future work.`);
  out.push("");

  out.push(`## Top remaining risks`);
  out.push("");
  if (topRisks.length === 0) {
    out.push(`No unsafe failures recorded. Per the spec, a corpus that reveals no weaknesses should raise suspicion that it is too easy — see the coverage-gap and unmeasured-dimension sections, which are where the real gaps currently sit.`);
  } else {
    for (const { s, f } of topRisks.slice(0, 8)) {
      out.push(`- **[${f.severity}] ${f.category}** — ${s.record.scenario_id} (${f.dimension}): ${f.observed}`);
    }
  }
  out.push("");

  out.push(`## Coverage gaps (correct abstention today; capability not yet shipped)`);
  out.push("");
  if (coverageGaps.length === 0) {
    out.push(`None recorded.`);
  } else {
    for (const { s, f } of coverageGaps) {
      out.push(`- ${s.record.scenario_id} — ${f.observed}`);
    }
  }
  out.push("");

  out.push(`## Unmeasured dimensions (harness limitations, recorded not fabricated)`);
  out.push("");
  const dims = new Set<string>();
  for (const s of scored) for (const d of s.record.unmeasured_dimensions) dims.add(d);
  for (const d of [...dims].sort()) out.push(`- ${d}`);
  out.push("");

  out.push(`## Design-partner readiness`);
  out.push("");
  const fPass = fettler.filter((s) => s.record.passed);
  const langFamilies = new Set(
    fettler.filter((s) => !s.record.passed && s.gt.tags.includes("language-support")).map((s) => s.gt.repo_family),
  );
  out.push(`**What we can accept today.** ` +
    (fPass.length
      ? `Fettler impact analysis on ${fPass.map((s) => s.record.scenario_id).filter((id) => id.includes("payments") || id.includes("monorepo") || id.includes("indirection")).join(", ") || "the passing scenarios above"}: repositories where the change is an OpenAPI field rename in a supported language and the impacted sites are reachable through imports. ReGauge's one shipped, applicable family (Node runtime version bump) is safe to run where it matches.`
      : `No Fettler scenario passed cleanly; do not accept live repositories for automated impact analysis yet.`));
  out.push("");
  out.push(`**What we should NOT yet accept.** ` +
    `${langFamilies.size ? `Repositories in languages where recall collapsed (${[...langFamilies].join(", ")}). ` : ""}` +
    `Repositories that require any ReGauge migration family other than the Node runtime bump — SDK major upgrades, framework upgrades, and internal-API renames are coverage gaps today (the engine correctly abstains, but delivers no value). Any repository whose correct answer is a judgement call (ambiguous renames) unless a human is in the loop.`);
  out.push("");
  const p0 = allUnsafe.filter((x) => x.f.severity === "P0");
  out.push(`**What remains fragile.** ` +
    `${p0.length ? `${p0.length} P0 issue(s) where the product acted when it should have abstained or touched a distractor — see Top remaining risks. ` : ""}` +
    `Verification honesty, large-repo scale limits, and binary/encoding/symlink robustness are only partially observable through the analysis-only path and need the full generation+verification pipeline to grade end to end.`);
  out.push("");

  return out.join("\n") + "\n";
}

export function renderFailuresBacklog(scored: ScoredRun[]): string {
  const out: string[] = [];
  out.push(`# FAILURES — MendPoint evaluation backlog`);
  out.push("");
  out.push(`One entry per unresolved failure or coverage gap surfaced by the suite. Never silently discarded. Generated from the latest run; re-run the suite to refresh.`);
  out.push("");
  let id = 0;
  const emit = (
    scenarioId: string,
    product: string,
    f: RunFailure,
    isGap: boolean,
  ): void => {
    id++;
    out.push(`## FAIL-${String(id).padStart(3, "0")} — ${scenarioId} (${f.dimension})`);
    out.push("");
    out.push(`- Scenario: ${scenarioId}`);
    out.push(`- Product: ${product}`);
    out.push(`- Severity: ${f.severity}`);
    out.push(`- Failure category: ${f.category}`);
    out.push(`- Observed behavior: ${f.observed}`);
    out.push(`- Expected behavior: ${f.expected}`);
    out.push(`- Root cause: ${isGap ? "capability not shipped for this migration family (coverage gap, not a defect)" : "to be diagnosed (Phase 7); classify from the category above"}`);
    out.push(`- Proposed generalized fix: ${isGap ? "author/ship a general recipe for this family; keep abstention-by-absence until then" : "smallest generalizable root-cause fix in the subsystem named by the category"}`);
    out.push(`- Status: OPEN`);
    out.push(`- Regression test: this scenario (${scenarioId}) becomes the permanent regression once fixed`);
    out.push(`- Owner: unassigned`);
    out.push("");
  };

  const sevRank: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
  const rows = scored.flatMap((s) =>
    s.record.failures.map((f) => ({ s, f, isGap: f.category === "COVERAGE_GAP" })),
  );
  // Unsafe failures first, ordered by severity; then coverage gaps; harness limits last.
  rows.sort((a, b) => {
    const aGap = a.isGap || a.f.category === "HARNESS_LIMITATION";
    const bGap = b.isGap || b.f.category === "HARNESS_LIMITATION";
    if (aGap !== bGap) return aGap ? 1 : -1;
    return (sevRank[a.f.severity] ?? 9) - (sevRank[b.f.severity] ?? 9);
  });
  for (const { s, f, isGap } of rows) {
    emit(s.record.scenario_id, s.record.product, f, isGap);
  }
  if (rows.length === 0) {
    out.push(`No failures recorded. Treat with suspicion — verify the corpus is adversarial enough.`);
    out.push("");
  }
  return out.join("\n") + "\n";
}
