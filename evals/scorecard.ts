/**
 * Design-partner readiness scorecard (spec §29).
 *
 * One block per capability, populated ONLY from real run data plus the versioned
 * readiness evaluation. A field the analysis-only path cannot measure (patch
 * verification, cost, rollback, product-side security limits) is emitted as an
 * explicit "not measured (<why>)" — never blanked and never guessed — following
 * the precedent the latest report already sets for unmeasured dimensions.
 */
import type {
  AbsentScenario,
  ReadinessEvaluation,
  ReadinessGatesConfig,
  ScoredRun,
} from "./readiness.js";

const NOT_MEASURED = (why: string): string => `not measured (${why})`;

/** Tags that label provenance/split, not a repo pattern; excluded from the pattern list. */
const NON_PATTERN_TAGS = new Set([
  "development",
  "regression",
  "validation",
  "holdout",
  "fettler",
  "regauge",
  "generated",
]);

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function latencyRange(rows: ScoredRun[]): string {
  const ms = rows.map((r) => r.record.latency_ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (ms.length === 0) return NOT_MEASURED("no runs");
  const p50 = ms[Math.floor(ms.length / 2)]!;
  return `${ms[0]}ms min, ${p50}ms median, ${ms[ms.length - 1]}ms max (n=${ms.length})`;
}

function p0p1(rows: ScoredRun[]): { p0: string[]; p1: string[] } {
  const safe = new Set(["COVERAGE_GAP", "HARNESS_LIMITATION"]);
  const p0: string[] = [];
  const p1: string[] = [];
  for (const s of rows) {
    for (const f of s.record.failures) {
      if (safe.has(f.category)) continue;
      if (f.severity === "P0") p0.push(`${s.record.scenario_id} (${f.category})`);
      else if (f.severity === "P1") p1.push(`${s.record.scenario_id} (${f.category})`);
    }
  }
  return { p0: uniqueSorted(p0), p1: uniqueSorted(p1) };
}

function field(label: string, value: string): string {
  return `| ${label} | ${value} |`;
}

function fettlerScorecard(scored: ScoredRun[], ev: ReadinessEvaluation, gates: ReadinessGatesConfig): string {
  const rows = scored.filter((s) => s.record.product === "fettler");
  const flagFiles = rows.filter((s) => s.gt.correct_behavior === "flag_files");
  const passedFlag = flagFiles.filter((s) => s.record.passed);
  const failedFlag = flagFiles.filter((s) => !s.record.passed);
  const cap = ev.capabilities.find((c) => c.capability === "fettler-impact-analysis");
  const holdout = rows.filter((s) => s.gt.dataset_split === "holdout");
  const holdoutPass = holdout.filter((s) => s.record.passed).length;

  const supportedFamilies = uniqueSorted(passedFlag.map((s) => s.gt.repo_family));
  const unsupportedFamilies = uniqueSorted(
    failedFlag
      .filter((s) => s.record.grader_results.some((g) => g.dimension === "expected_findings_recall" && !g.passed))
      .map((s) => s.gt.repo_family),
  );
  const abstainScenarios = rows.filter((s) => s.gt.correct_behavior === "abstain");
  const { p0, p1 } = p0p1(rows);
  const commit = rows[0]?.record.git_commit ?? "unknown";

  const precision = cap?.metrics.precision;
  const recall = cap?.metrics.recall;
  const fp = cap?.metrics.falsePositives ?? 0;
  const tp = cap?.metrics.truePositives ?? 0;
  const fpRate = tp + fp > 0 ? `${((fp / (tp + fp)) * 100).toFixed(1)}% of confident findings (${fp}/${tp + fp})` : NOT_MEASURED("no findings");

  const lines: string[] = [];
  lines.push(`## Capability: Fettler — API-change impact analysis`);
  lines.push("");
  lines.push(`Readiness verdict: **${cap?.verdict ?? "unknown"}** (policy ${ev.policy}).`);
  lines.push("");
  lines.push(`| field | value |`);
  lines.push(`| --- | --- |`);
  lines.push(field("Capability", "Given a structured OpenAPI v1->v2 change, flag exactly the impacted source files."));
  lines.push(field("Supported languages / stacks", supportedFamilies.length ? supportedFamilies.join("; ") : NOT_MEASURED("no flag_files scenario passed")));
  lines.push(field("Supported repo patterns", uniqueSorted(passedFlag.flatMap((s) => s.gt.tags).filter((t) => !NON_PATTERN_TAGS.has(t))).join(", ") || NOT_MEASURED("no passing scenario")));
  lines.push(field("Supported providers", "provider-agnostic (driven by the OpenAPI diff, not a provider allowlist); exercised only against synthetic providers"));
  lines.push(field("Known unsupported patterns", unsupportedFamilies.length ? `recall collapses on: ${unsupportedFamilies.join("; ")}` : "none surfaced by this run"));
  lines.push(field("Scenario count", `${rows.length} Fettler scenarios (${flagFiles.length} flag_files, ${abstainScenarios.length} abstain, ${rows.length - flagFiles.length - abstainScenarios.length} other)`));
  lines.push(field("Hidden-holdout status", holdout.length ? `${holdout.length} procedurally-generated holdout scenarios, never inspected while fixing; ${holdoutPass}/${holdout.length} passed` : NOT_MEASURED("no holdout scenarios in this run")));
  lines.push(field("Precision / recall", precision !== null && precision !== undefined && recall !== null && recall !== undefined ? `precision ${(precision * 100).toFixed(1)}%, recall ${(recall * 100).toFixed(1)}% (micro-averaged over ${cap?.metrics.scenarioCount} flag_files scenarios)` : NOT_MEASURED("no findings to pool")));
  lines.push(field("Patch verification rate", NOT_MEASURED("generation + sandbox verification path not exercised by the analysis-only runner")));
  lines.push(field("False-positive rate", fpRate));
  lines.push(field("Known P0 / P1", `P0: ${p0.length ? p0.join("; ") : "none"} | P1: ${p1.length ? p1.join("; ") : "none"}`));
  lines.push(field("Latency range", latencyRange(rows)));
  lines.push(field("Cost range", NOT_MEASURED("LLM off on this path; no model called, so token cost is genuinely zero rather than estimated")));
  lines.push(field("Required human review", abstainScenarios.length ? "yes — ambiguous renames and low-confidence notifications are surfaced for human decision, never auto-applied" : NOT_MEASURED("no abstain scenario in this run")));
  lines.push(field("Rollback behaviour", NOT_MEASURED("PR delivery + apply path not exercised; rollback is a delivery-layer property")));
  lines.push(field("Security limitations", "answer-key isolation is enforced (corpus staged with grading keys stripped, corpus root asserted outside the repo); product-side security limits (secret handling, sandbox escape) are " + NOT_MEASURED("full pipeline not exercised")));
  lines.push(field("Owner", gates.owner));
  lines.push(field("Last-validated commit", `\`${commit}\``));
  lines.push("");
  return lines.join("\n");
}

/** §29 block for the Fettler restraint (abstention / no-op) capability. */
function fettlerAbstentionScorecard(scored: ScoredRun[], ev: ReadinessEvaluation, gates: ReadinessGatesConfig): string {
  const cap = ev.capabilities.find((c) => c.capability === "fettler-abstention");
  if (!cap) return "";
  const rows = scored.filter(
    (s) => s.record.product === "fettler" && (s.gt.correct_behavior === "abstain" || s.gt.correct_behavior === "no_op"),
  );
  const abstain = rows.filter((s) => s.gt.correct_behavior === "abstain");
  const noOp = rows.filter((s) => s.gt.correct_behavior === "no_op");
  const passed = rows.filter((s) => s.record.passed).length;
  const { p0, p1 } = p0p1(rows);
  const commit = rows[0]?.record.git_commit ?? "unknown";
  const gate = gates.capabilities["fettler-abstention"] as { description?: string } | undefined;

  const lines: string[] = [];
  lines.push(`## Capability: Fettler — restraint (abstention / no-op)`);
  lines.push("");
  lines.push(`Readiness verdict: **${cap.verdict}** (policy ${ev.policy}).`);
  lines.push("");
  if (gate?.description) {
    lines.push(gate.description);
    lines.push("");
  }
  lines.push(`| criterion | measured | threshold | verdict |`);
  lines.push(`| --- | --- | --- | --- |`);
  for (const c of cap.criteria) {
    const verdict = !c.measurable ? "NOT MEASURED" : c.passed ? "PASS" : "FAIL";
    lines.push(`| ${c.name} | ${c.measured} | ${c.threshold} | ${verdict} |`);
  }
  lines.push("");
  lines.push(`| field | value |`);
  lines.push(`| --- | --- |`);
  lines.push(field("Scenario count", `${rows.length} (abstain ${abstain.filter((s) => s.record.passed).length}/${abstain.length}, no_op ${noOp.filter((s) => s.record.passed).length}/${noOp.length}; ${passed}/${rows.length} correct)`));
  lines.push(field("Known P0 / P1", `P0: ${p0.length ? p0.join("; ") : "none"} | P1: ${p1.length ? p1.join("; ") : "none"}`));
  lines.push(field("Latency range", latencyRange(rows)));
  lines.push(field("Cost range", NOT_MEASURED("LLM off on this path; no model called")));
  lines.push(field("Required human review", "yes — an ambiguous rename is surfaced for a human decision, never auto-applied"));
  lines.push(field("Owner", gates.owner));
  lines.push(field("Last-validated commit", `\`${commit}\``));
  lines.push("");
  return lines.join("\n");
}

/** §29 block listing gated scenarios that were ABSENT from this run (not scored). */
function absentScenariosScorecard(absent: AbsentScenario[]): string {
  if (absent.length === 0) return "";
  const out: string[] = [];
  out.push(`## Gated scenarios not measured this run (absent)`);
  out.push("");
  out.push(
    `${absent.length} gated scenario(s) did not run (e.g. MENDPOINT_CORPUS_ROOT unset / corpus absent). They are reported here, not renormalised away: the readiness verdict above FAILS every capability one of these would have fed, so a partial run cannot read as ready.`,
  );
  out.push("");
  out.push(`| scenario | product | correct behavior | status |`);
  out.push(`| --- | --- | --- | --- |`);
  for (const a of [...absent].sort((x, y) => x.scenario_id.localeCompare(y.scenario_id))) {
    out.push(`| ${a.scenario_id} | ${a.product} | ${a.gt.correct_behavior} | not measured (absent) |`);
  }
  out.push("");
  return out.join("\n");
}

/** §29 block listing capabilities that have no measurable signal today. */
function notMeasuredScorecard(gates: ReadinessGatesConfig): string {
  const block = gates.not_measured;
  if (!block || !block.capabilities.length) return "";
  const out: string[] = [];
  out.push(`## Capabilities not measured (Phase 2 gate-coverage backlog)`);
  out.push("");
  if (block.notes) {
    out.push(block.notes);
    out.push("");
  }
  out.push(`| capability | why not measured | experiment that would measure it | owner |`);
  out.push(`| --- | --- | --- | --- |`);
  for (const c of block.capabilities) {
    const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
    out.push(`| ${cell(c.capability)} | ${cell(c.reason)} | ${cell(c.experiment)} | ${cell(c.owner ?? "")} |`);
  }
  out.push("");
  return out.join("\n");
}

/** One §29 block per ReGauge recipe family, scored against its own gate. */
function regaugeFamilyScorecard(
  scored: ScoredRun[],
  ev: ReadinessEvaluation,
  gates: ReadinessGatesConfig,
): string {
  const allRegauge = scored.filter((s) => s.record.product === "regauge");
  const commit = allRegauge[0]?.record.git_commit ?? "unknown";
  const familyCaps = ev.capabilities.filter((c) => c.familyMetrics);

  const out: string[] = [];
  out.push(`## Capability: ReGauge — migration recipe engine (per family)`);
  out.push("");
  out.push(
    `Each recipe family is scored against its own gate in \`readiness-gates.json\`: correct application on in-scope repos, refusal on partial-migration repos (a residual consumer outside the recipe's allowedPaths), abstention on out-of-scope repos, and zero open P0. Analyze-only fields (apply + verification, cost, rollback) are marked "not measured".`,
  );
  out.push("");

  if (familyCaps.length === 0) {
    out.push(NOT_MEASURED("no regauge-family capabilities are configured in readiness-gates.json"));
    out.push("");
    return out.join("\n");
  }

  for (const cap of familyCaps) {
    const fm = cap.familyMetrics!;
    const rows = allRegauge.filter((s) => (s.gt.recipe_expectation?.family ?? "") === fm.family);
    const { p0, p1 } = p0p1(rows);
    const gate = gates.capabilities[cap.capability];
    const description = (gate as { description?: string })?.description ?? "";

    out.push(`### Family: ${fm.family} (${cap.capability}) — **${cap.verdict}**`);
    out.push("");
    if (description) {
      out.push(description);
      out.push("");
    }
    out.push(`| criterion | measured | threshold | verdict |`);
    out.push(`| --- | --- | --- | --- |`);
    for (const c of cap.criteria) {
      const verdict = !c.measurable ? "NOT MEASURED" : c.passed ? "PASS" : "FAIL";
      out.push(`| ${c.name} | ${c.measured} | ${c.threshold} | ${verdict} |`);
    }
    out.push("");
    out.push(`| field | value |`);
    out.push(`| --- | --- |`);
    out.push(field("Scenario count", `${fm.scenarioCount} (apply ${fm.applyPassed}/${fm.applyTotal}, residual-refusal ${fm.refusePassed}/${fm.refuseTotal}, abstention ${fm.abstainPassed}/${fm.abstainTotal})`));
    out.push(field("Known P0 / P1", `P0: ${p0.length ? p0.join("; ") : "none"} | P1: ${p1.length ? p1.join("; ") : "none"}`));
    out.push(field("Patch verification rate", NOT_MEASURED("recipe apply + verification gate not exercised (analyze-only)")));
    out.push(field("Latency range", latencyRange(rows)));
    out.push(field("Cost range", NOT_MEASURED("deterministic recipe engine; no model called")));
    out.push(field("Required human review", "yes — recipe application produces a draft PR for human review; nothing auto-merges"));
    out.push(field("Rollback behaviour", NOT_MEASURED("inverse/rollback path not exercised")));
    out.push(field("Last-validated commit", `\`${commit}\``));
    out.push("");
  }
  out.push(field("Owner", gates.owner));
  out.push("");
  return out.join("\n");
}

/** Render the full readiness scorecard document. */
export function renderScorecard(
  scored: ScoredRun[],
  ev: ReadinessEvaluation,
  gates: ReadinessGatesConfig,
  absent: AbsentScenario[] = [],
): string {
  const now = new Date().toISOString();
  const commit = scored[0]?.record.git_commit ?? "unknown";
  const out: string[] = [];
  out.push(`# MendPoint design-partner readiness scorecard (spec §29)`);
  out.push("");
  out.push(`- Generated: ${now}`);
  out.push(`- Git commit: \`${commit}\``);
  out.push(`- Readiness policy: ${ev.policy} (owner ${ev.owner}, decided ${ev.decided_at})`);
  out.push(`- Overall readiness: **${ev.overall}**`);
  out.push("");
  out.push(
    `Every field below is populated from the latest run's real records or the versioned readiness evaluation. Fields the analysis-only path cannot measure are marked "not measured (<why>)" rather than left blank or estimated.`,
  );
  out.push("");
  out.push(fettlerScorecard(scored, ev, gates));
  out.push(fettlerAbstentionScorecard(scored, ev, gates));
  out.push(regaugeFamilyScorecard(scored, ev, gates));
  out.push(absentScenariosScorecard(absent));
  out.push(notMeasuredScorecard(gates));
  return out.join("\n") + "\n";
}
