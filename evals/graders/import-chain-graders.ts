/**
 * Phase 5 — importChain (relationship-path) grader.
 *
 * Deferred until PR #200 exposed `GraphPath` on findings (see DEFERRED.md). It
 * grades the provider->code path the product now emits per finding
 * (`GraphPath.nodes`, anchor-first, each node importing the previous) against
 * the hand-derived answer key `blast_radius_truth.importChainPaths` — the
 * STRUCTURED key, not the prose `importChain` (which stays prose and is read
 * only for its hop count by task-family.ts).
 *
 * WHAT IT DISTINGUISHES (a correct relationship claim from a lucky one):
 *   - does the emitted path reach the EXPECTED ANCHOR (node[0])?
 *   - are the INTERMEDIATE HOPS correct and IN ORDER (arriving at the right file
 *     by a different route is not a correct explanation)?
 *   - is a path EMITTED AT ALL where the key expects one?
 *
 * HONEST ABSENCE / BOUNDED — the part that matters most:
 *   - A finding with NO graphPath is "not computed", NOT "computed and wrong".
 *     It is recorded as `absent` and never graded as an incorrect path.
 *   - A path whose terminal is `cycle` / `max_hops` (coverage `partial`) is a
 *     BOUNDED answer: the real chain is longer than shown. It is graded against
 *     what the bound permits — the shown nodes must be a correct in-order SUFFIX
 *     of the expected path — and a truncation marker is never treated as wrong.
 *
 * NON-GATING: this grader classifies disagreements into the existing taxonomy
 * (never a new category, never P0), but the runner keeps its results OUT of the
 * gating `passed` / `failures` channels. It is purely additive measurement.
 */
import type { GraphPath } from "@mendpoint/shared";
import type { GroundTruth } from "../ground-truth/schema.js";
import type { GraderResult, RunFailure } from "../runners/types.js";

const toPosix = (p: string): string => p.replace(/\\/g, "/");

/** One confident finding and the path the product computed for it (if any). */
export interface ObservedFindingPath {
  /** Repo-relative posix file path of the finding. */
  filePath: string;
  /** The provider->code path, or undefined when the product computed none. */
  graphPath?: GraphPath;
}

/**
 * Outcome for one expected path.
 *  - `exact`                       emitted nodes equal the expected path.
 *  - `reached_anchor_wrong_route`  right anchor and terminal, wrong intermediates.
 *  - `wrong_anchor`                reaches the terminal from a DIFFERENT upstream anchor.
 *  - `self_anchor`                 a single-node path [terminal]: the product treated
 *                                  the finding as its OWN provider anchor and traced
 *                                  no upstream relationship. Distinct from a wrong
 *                                  route (it reached no other file) and defensible
 *                                  when the file directly references the surface, so
 *                                  it is reported as "no relationship traced", NOT as
 *                                  a confidently-wrong path.
 *  - `bounded_ok`                  truncated path; shown nodes are a correct suffix.
 *  - `bounded_divergent`           truncated path whose shown suffix disagrees.
 *  - `absent`                      no path computed for the terminal (honest absence).
 */
export type ImportChainOutcome =
  | "exact"
  | "reached_anchor_wrong_route"
  | "wrong_anchor"
  | "self_anchor"
  | "bounded_ok"
  | "bounded_divergent"
  | "absent";

export interface ImportChainPathResult {
  /** The affected file the expected path explains (its last node). */
  terminal: string;
  /** The expected anchor (its first node). */
  anchor: string;
  /** The expected anchor-first path. */
  expected: string[];
  /** The emitted anchor-first path, or null when none was computed. */
  observed: string[] | null;
  /** How the emitted path ended, when one was emitted. */
  terminalKind: GraphPath["terminal"] | null;
  outcome: ImportChainOutcome;
  detail: string;
}

export interface ImportChainSummary {
  expectedPaths: number;
  exact: number;
  reachedAnchorWrongRoute: number;
  wrongAnchor: number;
  selfAnchor: number;
  boundedOk: number;
  boundedDivergent: number;
  absent: number;
}

export interface ImportChainGrade {
  /** False when the scenario carries no `importChainPaths` key (nothing to grade). */
  applicable: boolean;
  grader_results: GraderResult[];
  /** Classified disagreements — NON-GATING (never P0, never merged into gates). */
  failures: RunFailure[];
  results: ImportChainPathResult[];
  summary: ImportChainSummary;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Whether `suffix` is an in-order tail of `full` (both anchor-first). */
function isSuffix(full: readonly string[], suffix: readonly string[]): boolean {
  if (suffix.length > full.length) return false;
  const start = full.length - suffix.length;
  return arraysEqual(full.slice(start), suffix);
}

const NOT_APPLICABLE: ImportChainSummary = {
  expectedPaths: 0,
  exact: 0,
  reachedAnchorWrongRoute: 0,
  wrongAnchor: 0,
  selfAnchor: 0,
  boundedOk: 0,
  boundedDivergent: 0,
  absent: 0,
};

/**
 * Grade the emitted provider->code paths against a scenario's structured
 * importChain key. `observed` is every confident finding with the path the
 * product computed for it (paths keyed by the finding's own file). Deterministic,
 * no LLM.
 */
export function gradeImportChain(
  observed: readonly ObservedFindingPath[],
  gt: GroundTruth,
): ImportChainGrade {
  const key = gt.blast_radius_truth.importChainPaths;
  if (!key || key.length === 0) {
    // No structured key for this scenario: skipped honestly, never defaulted.
    return {
      applicable: false,
      grader_results: [],
      failures: [],
      results: [],
      summary: { ...NOT_APPLICABLE },
    };
  }

  // Index the emitted paths by terminal file (posix). A finding may appear more
  // than once (multiple sites); prefer the entry that carries a path.
  const byFile = new Map<string, GraphPath | undefined>();
  for (const o of observed) {
    const fp = toPosix(o.filePath);
    if (!byFile.has(fp) || (o.graphPath && !byFile.get(fp))) {
      byFile.set(fp, o.graphPath);
    }
  }

  const results: ImportChainPathResult[] = [];
  const summary: ImportChainSummary = { ...NOT_APPLICABLE, expectedPaths: key.length };

  for (const rawExpected of key) {
    const expected = rawExpected.map(toPosix);
    const anchor = expected[0]!;
    const terminal = expected[expected.length - 1]!;
    const g = byFile.get(terminal);

    if (!g) {
      // Either the terminal was not flagged, or it was flagged with no path.
      // Both are "not computed" — never an incorrect path.
      results.push({
        terminal,
        anchor,
        expected,
        observed: null,
        terminalKind: null,
        outcome: "absent",
        detail: byFile.has(terminal)
          ? "finding flagged but no graphPath computed (not computed, not wrong)"
          : "no confident finding for this terminal, so no path to grade (not computed)",
      });
      summary.absent++;
      continue;
    }

    const nodes = g.nodes.map(toPosix);
    const bounded = g.coverage === "partial" || g.truncated || g.terminal !== "anchor";

    let outcome: ImportChainOutcome;
    let detail: string;
    if (nodes.length <= 1) {
      // A single-node path [terminal]: the product anchored the finding on itself
      // and traced no upstream relationship. Not a wrong route (it reached no
      // other file) — reported as "no relationship traced", never as wrong.
      outcome = "self_anchor";
      detail = `single-node path [${nodes.join("")}]: finding treated as its own anchor, no upstream path traced`;
      summary.selfAnchor++;
    } else if (bounded) {
      // Bounded: grade only against what the bound permits — the shown nodes must
      // be a correct in-order suffix of the expected path ending at the terminal.
      if (nodes[nodes.length - 1] === terminal && isSuffix(expected, nodes)) {
        outcome = "bounded_ok";
        detail = `bounded (${g.terminal}); shown ${nodes.length}-node suffix matches the expected tail`;
        summary.boundedOk++;
      } else {
        outcome = "bounded_divergent";
        detail = `bounded (${g.terminal}) but shown suffix diverges from expected: [${nodes.join(" -> ")}]`;
        summary.boundedDivergent++;
      }
    } else if (arraysEqual(nodes, expected)) {
      outcome = "exact";
      detail = `exact match (${nodes.length} nodes, ${g.hops} hops)`;
      summary.exact++;
    } else if (nodes[0] === anchor && nodes[nodes.length - 1] === terminal) {
      outcome = "reached_anchor_wrong_route";
      detail = `reached anchor and terminal but via a different route: [${nodes.join(" -> ")}] vs expected [${expected.join(" -> ")}]`;
      summary.reachedAnchorWrongRoute++;
    } else {
      outcome = "wrong_anchor";
      detail = `terminal reached from an unexpected anchor: got [${nodes.join(" -> ")}], expected anchor ${anchor}`;
      summary.wrongAnchor++;
    }

    results.push({
      terminal,
      anchor,
      expected,
      observed: nodes,
      terminalKind: g.terminal,
      outcome,
      detail,
    });
  }

  // One summarizing grader_result (informational; the runner does NOT gate on it).
  // "traced" = paths where the product actually emitted a multi-node relationship
  // path. `absent` (no path) and `self_anchor` (single-node self-path) both mean
  // "no relationship traced" and are excluded from the correctness ratio rather
  // than counted against the product.
  const notTraced = summary.absent + summary.selfAnchor;
  const traced = summary.expectedPaths - notTraced;
  const correct = summary.exact + summary.boundedOk;
  const score = traced > 0 ? correct / traced : 0;
  const grader_results: GraderResult[] = [
    {
      dimension: "import_chain_route",
      // A dimension with no traced relationship path is unmeasured, not failed.
      passed: traced === 0 ? true : correct === traced,
      score,
      detail:
        traced === 0
          ? `${summary.expectedPaths} expected path(s); none traced as a relationship (absent ${summary.absent}, self-anchor ${summary.selfAnchor}) — unmeasured`
          : `${correct}/${traced} traced path(s) correct (exact ${summary.exact}, bounded-ok ${summary.boundedOk}); ` +
            `wrong-route ${summary.reachedAnchorWrongRoute}, wrong-anchor ${summary.wrongAnchor}, bounded-divergent ${summary.boundedDivergent}; ` +
            `not traced: absent ${summary.absent}, self-anchor ${summary.selfAnchor}`,
    },
  ];

  // Classify disagreements into the EXISTING taxonomy. GRAPH_CONSTRUCTION_FAILURE
  // is the honest root-cause bucket for a path that reaches the wrong place or by
  // the wrong route. Severity is deliberately P2 (a wrong explanation is a trust
  // problem, not a dangerous action) — never P0 — so it can never perturb the
  // open-P0 readiness gate even though the runner keeps it out of gates entirely.
  const failures: RunFailure[] = [];
  for (const r of results) {
    if (
      r.outcome === "reached_anchor_wrong_route" ||
      r.outcome === "wrong_anchor" ||
      r.outcome === "bounded_divergent"
    ) {
      failures.push({
        category: "GRAPH_CONSTRUCTION_FAILURE",
        severity: "P2",
        dimension: "import_chain_route",
        observed: r.observed ? r.observed.join(" -> ") : "(no path)",
        expected: r.expected.join(" -> "),
      });
    }
  }

  return { applicable: true, grader_results, failures, results, summary };
}
