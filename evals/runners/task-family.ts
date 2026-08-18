/**
 * Task-family classification for the representation experiment (spec §11.21).
 *
 * The representation-first thesis predicts that a Change Graph projection helps
 * MOST on tasks whose correct answer is reachable only by following an INDIRECT
 * relationship (wrappers, transitive blast radius, hidden runtime dependencies),
 * and helps LEAST on tasks answerable from an explicit local reference (a direct
 * import, an installed version). If the two families were pooled into one
 * headline number, that predicted difference would be averaged away — so the
 * harness must classify every scenario into a family and report the families
 * SEPARATELY (see `evals/runners/arms.ts`).
 *
 * HOW WE CLASSIFY (inspectable, corpus-derived — no hand-maintained list). The
 * decisive signal is the corpus's own `blast_radius_truth.importChain`: the
 * prose chain a correct trace must follow. Hop count is read mechanically from
 * that field (chain arrows and entry count). Everything else the classifier
 * touches — `correct_behavior`, `expected_findings`, `repo_family`, `difficulty`
 * — is recorded on the result as `signals` so any reader can see exactly why a
 * scenario landed where it did.
 *
 * HONESTY. A scenario the corpus does not encode a chain for is NOT defaulted
 * into a family. It is returned as `unclassified` with a stated reason, exactly
 * as the rest of this harness records "not measured" rather than guessing. An
 * unclassified scenario is never folded into either family's number.
 */
import type { CorrectBehavior, GroundTruth } from "../ground-truth/schema.js";

/**
 * The task-family axis of the representation experiment.
 *  - direct-reference    the correct answer set is reachable from an explicit
 *                        local reference (a single, direct hop).
 *  - relationship-heavy  the correct answer set is reachable only by following
 *                        an indirect relationship (a multi-hop chain).
 *  - unclassified        the corpus does not encode enough to place the scenario
 *                        on this axis; recorded honestly, never averaged in.
 */
export type TaskFamily = "direct-reference" | "relationship-heavy" | "unclassified";

/** The raw corpus signals a classification was derived from, for inspection. */
export interface TaskFamilySignals {
  correct_behavior: CorrectBehavior;
  expectedFindings: number;
  /** Hops read from `blast_radius_truth.importChain`; null when absent/empty. */
  importChainHops: number | null;
  repo_family: string;
  difficulty: number;
}

export interface TaskFamilyClassification {
  family: TaskFamily;
  /** Human-readable, names the corpus field that decided it. */
  reason: string;
  signals: TaskFamilySignals;
}

/**
 * Count the hops encoded in an `importChain`. A hop is a node in the chain: a
 * single entry with N chain arrows describes N+1 nodes; multiple entries are the
 * segments of one chain. Returns null when there is no chain to read, so callers
 * can tell "the corpus encoded a single direct reference" (1) apart from "the
 * corpus encoded nothing" (null) — the two must not be conflated.
 */
export function importChainHops(chain: readonly string[] | undefined): number | null {
  if (!chain || chain.length === 0) return null;
  const arrowCount = chain.reduce(
    (sum, entry) => sum + (entry.match(/->|→/g)?.length ?? 0),
    0,
  );
  // Arrows describe one continuous chain (N arrows = N+1 nodes). With no arrows,
  // each entry is a distinct named hop.
  return arrowCount > 0 ? arrowCount + 1 : chain.length;
}

/** Behaviours whose correct answer is a localization set graded on recall. */
const RETRIEVAL_GRADED: ReadonlySet<CorrectBehavior> = new Set([
  "flag_files",
  "apply_recipe",
]);

/**
 * Classify one scenario onto the representation experiment's task-family axis
 * from its ground truth. Deterministic and side-effect-free: it reads only the
 * (already answer-key-isolated) `GroundTruth`, never the repo under test, so a
 * holdout scenario can be classified without exposing its answer key.
 */
export function classifyTaskFamily(gt: GroundTruth): TaskFamilyClassification {
  const hops = importChainHops(gt.blast_radius_truth?.importChain);
  const signals: TaskFamilySignals = {
    correct_behavior: gt.correct_behavior,
    expectedFindings: gt.expected_findings.length,
    importChainHops: hops,
    repo_family: gt.repo_family,
    difficulty: gt.difficulty,
  };

  // A scenario with no localization target grades restraint or coverage, not
  // reference-vs-relationship retrieval depth. Placing it on this axis would put
  // a null-recall scenario into a family average; keep it off the axis.
  if (!RETRIEVAL_GRADED.has(gt.correct_behavior) || gt.expected_findings.length === 0) {
    return {
      family: "unclassified",
      reason: `correct_behavior "${gt.correct_behavior}" with ${gt.expected_findings.length} expected finding(s) grades restraint/coverage, not reference-vs-relationship retrieval depth; not placed in a task family`,
      signals,
    };
  }

  if (hops === null) {
    return {
      family: "unclassified",
      reason:
        "no importChain answer key: the corpus does not encode whether the correct answer requires following an indirect relationship, so this scenario is not defaulted into a family",
      signals,
    };
  }

  if (hops >= 2) {
    return {
      family: "relationship-heavy",
      reason: `importChain encodes ${hops} hops: the correct answer set is reachable only by following an indirect relationship`,
      signals,
    };
  }

  return {
    family: "direct-reference",
    reason:
      "importChain encodes a single direct reference: the correct answer set is reachable from an explicit local reference",
    signals,
  };
}

/** The three task-family buckets, each with its member classifications. */
export interface TaskFamilyGroups<T> {
  "direct-reference": T[];
  "relationship-heavy": T[];
  unclassified: T[];
}

/**
 * Split items into the three task-family buckets using `classify`. The families
 * are returned SEPARATELY on purpose — nothing here ever pools them, and
 * `unclassified` is a first-class bucket, never merged into a family.
 */
export function groupByTaskFamily<T>(
  items: readonly T[],
  classify: (item: T) => TaskFamily,
): TaskFamilyGroups<T> {
  const groups: TaskFamilyGroups<T> = {
    "direct-reference": [],
    "relationship-heavy": [],
    unclassified: [],
  };
  for (const item of items) groups[classify(item)].push(item);
  return groups;
}

/** Task families reported as headline numbers (unclassified is shown apart). */
export const REPORTED_TASK_FAMILIES: readonly TaskFamily[] = [
  "direct-reference",
  "relationship-heavy",
];
