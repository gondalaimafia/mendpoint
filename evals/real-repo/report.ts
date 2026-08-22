/**
 * Real-repository harness — evidence report.
 *
 * Renders one run as a plain markdown scorecard whose headline is the honest
 * result: the outcome (ran / ran-partial / did-not-run), then true positives,
 * false positives, and false negatives stated as counts and lists. No rounding
 * that hides a miss, no "success" language the run did not earn.
 */
import type { SealedAnswerKey } from "./inject.js";
import type { RealRepoRunResult } from "./harness.js";

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function list(items: readonly string[]): string {
  return items.length ? items.map((i) => `- \`${i}\``).join("\n") : "- (none)";
}

const OUTCOME_HEADLINE: Record<RealRepoRunResult["outcome"], string> = {
  analyzed: "RAN — full coverage",
  analyzed_partial: "RAN — partial coverage",
  did_not_run: "DID NOT RUN",
};

export function renderRealRepoReport(
  result: RealRepoRunResult,
  key: SealedAnswerKey,
): string {
  const tp = result.truePositives.length;
  const fp = result.falsePositives.length;
  const fn = result.falseNegatives.length;
  const expected = key.expected_findings.length;

  const lines: string[] = [];
  lines.push(`# Real-repository result — ${result.scenarioId}`);
  lines.push("");
  lines.push(`**Outcome: ${OUTCOME_HEADLINE[result.outcome]}.**`);
  if (result.outcomeReason) lines.push("", `> ${result.outcomeReason}`);
  lines.push("");
  lines.push(
    `**True positives: ${tp}/${expected}. False positives: ${fp}. False negatives: ${fn}.**`,
  );
  if (result.outcome !== "did_not_run") {
    lines.push("", `Precision ${pct(result.precision)}; recall ${pct(result.recall)}.`);
  }
  lines.push("");

  lines.push("## Repository under test");
  lines.push("");
  lines.push(`- Repository: ${result.repoUrl}`);
  lines.push(`- Commit: \`${result.commit}\``);
  lines.push(`- Licence: ${result.license}`);
  lines.push(`- Files scanned by the product: ${result.filesScanned}`);
  lines.push(`- Coverage basis: \`${result.coverageBasis}\``);
  lines.push(`- Overall confidence: \`${result.overallConfidence ?? "n/a"}\``);
  lines.push(`- Latency: ${result.latencyMs}ms`);
  lines.push("");

  lines.push("## Injected change");
  lines.push("");
  const c = key.injected_change;
  lines.push(
    `- ${c.kind}: \`${c.method} ${c.path}\` removed, superseded by \`${c.superseded_by.method} ${c.superseded_by.path}\`.`,
  );
  lines.push(`- Provider slug: \`${c.provider_slug}\`. Spec pair: \`${c.spec_v1}\` -> \`${c.spec_v2}\`.`);
  lines.push("");

  lines.push("## Grading against the sealed answer key");
  lines.push("");
  lines.push(`### True positives (${tp}/${expected} expected files flagged)`);
  lines.push(list(result.truePositives));
  lines.push("");
  lines.push(`### False negatives (expected but missed): ${fn}`);
  lines.push(list(result.falseNegatives));
  lines.push("");
  lines.push(`### False positives: ${fp}`);
  lines.push(`Distractor traps flagged (P0 class): ${result.trapHits.length}`);
  lines.push(list(result.trapHits));
  lines.push("");
  lines.push(`Other extra files flagged: ${result.extras.length}`);
  lines.push(list(result.extras));
  lines.push("");

  if (result.lowConfidence.length) {
    lines.push("### Low-confidence notifications (not counted as findings)");
    lines.push(list(result.lowConfidence));
    lines.push("");
  }

  lines.push("## Grader dimensions");
  lines.push("");
  for (const g of result.graderResults) {
    lines.push(`- ${g.dimension}: ${g.passed ? "PASS" : "FAIL"} (${g.detail})`);
  }
  lines.push("");
  lines.push(`Verdict (safe + correct): ${result.passed ? "PASS" : "FAIL"}`);
  lines.push("");

  lines.push("## Not measured by this path");
  lines.push("");
  for (const d of result.unmeasuredDimensions) lines.push(`- ${d}`);
  lines.push("");

  return lines.join("\n");
}
