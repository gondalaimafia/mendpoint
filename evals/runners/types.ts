/**
 * Phase 4 — per-run record.
 *
 * Captures exactly the fields the spec lists that are OBSERVABLE from the
 * deterministic analysis path the runner exercises. Fields the path does not
 * expose (model, tokens, cost, routing on the LLM-off path) are recorded as
 * null with an explicit `unobservable` note rather than fabricated.
 *
 * We NEVER capture model chain-of-thought or hidden reasoning — only observable
 * inputs, outputs, tool/analysis interactions, and outcomes.
 */
import type { GraphPath } from "@mendpoint/shared";
import type { FailureCategory, Severity } from "../graders/taxonomy.js";
import type { Product } from "../ground-truth/schema.js";
import type { ImportChainGrade } from "../graders/import-chain-graders.js";

/** One graded dimension result. */
export interface GraderResult {
  dimension: string;
  passed: boolean;
  /** 0..1 where a continuous score applies (precision/recall); else 1|0. */
  score: number;
  detail: string;
}

/** A single classified failure attached to a run. */
export interface RunFailure {
  category: FailureCategory;
  severity: Severity;
  dimension: string;
  observed: string;
  expected: string;
}

/** Observable analysis activity (the "tools/graph/retrieval" telemetry). */
export interface AnalysisActivity {
  /**
   * Files the scanner actually examined — the repo size independent variable
   * (spec §21.3). This is the number of source files the index/snapshot layer
   * walked and indexed after pruning dependency/VCS/cache trees, NOT the number
   * of impact findings. Plot scale degradation against this.
   */
  filesExamined: number;
  /** Candidate sites discovered before confirmation (Fettler). */
  candidateCount?: number;
  /** Confirmed impact sites (Fettler). */
  confirmedCount?: number;
  /** Low-confidence notifications split out (Fettler). */
  lowConfidenceCount?: number;
  /** Recipes evaluated against the repo (ReGauge). */
  recipesEvaluated?: number;
  /** Extra observable notes (e.g. scan aborted, symlink skipped). */
  notes?: string[];
}

export interface RunRecord {
  run_id: string;
  timestamp: string; // ISO 8601 text
  git_commit: string;
  product: Product;
  product_version: string;
  scenario_id: string;
  scenario_version: string;
  /** Invocation path used (documented, so the run is reproducible). */
  invocation_path: string;
  /** Model + provider. null on the deterministic (LLM-off) path. */
  model: string | null;
  model_provider: string | null;
  /** Routing decisions. Empty on the deterministic path. */
  routing_decisions: string[];
  /** Token counts. null when no model was called. */
  tokens: number | null;
  /** Wall-clock latency of the product invocation, milliseconds. */
  latency_ms: number;
  /** Estimated model cost USD. null when no model was called. */
  estimated_cost_usd: number | null;
  /** Observable analysis activity. */
  activity: AnalysisActivity;
  /** Files the product flagged / would change (repo-relative, posix). */
  findings: string[];
  /**
   * Provider->code path behind each confident finding that carried one (FET-016,
   * spec 8.8). The product emits a {@link GraphPath} per reachable finding; the
   * runner used to map `report.sites` down to file paths only and DISCARD this,
   * so the relationship evidence the product already computes never reached the
   * persisted record. Now persisted, keyed by the finding's repo-relative posix
   * `filePath`. A finding ABSENT from this list computed no path ("not computed",
   * never "no path") — the importChain grader treats that as honest-absence.
   */
  findingGraphPaths: { filePath: string; graphPath: GraphPath }[];
  /** Overall confidence the product reported, when it reports one. */
  confidence: string | null;
  /** Whether the product produced/attempted an edit or PR (observable). */
  produced_edit: boolean;
  /** Grader results, one per graded dimension. */
  grader_results: GraderResult[];
  /** Classified failures (empty when the scenario fully passed). */
  failures: RunFailure[];
  /** Whether the scenario passed overall (all required dimensions passed). */
  passed: boolean;
  /** Dimensions the harness could not measure for this scenario. */
  unmeasured_dimensions: string[];
  /**
   * Relationship-path grade for this run (importChain grader), when the scenario
   * carries a structured `importChainPaths` key. STRICTLY ADDITIVE and
   * NON-GATING: its results and classified disagreements live here only. They
   * are never merged into {@link RunRecord.failures} or {@link RunRecord.passed},
   * so readiness gates (which read findings, passed, and P0 failures) and every
   * existing scenario verdict are unaffected. Absent when the scenario has no key.
   */
  importChainGrade?: ImportChainGrade;
  /** Set when the product invocation threw. */
  error?: string;
}
