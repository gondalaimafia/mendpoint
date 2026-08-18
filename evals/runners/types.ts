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
import type { FailureCategory, Severity } from "../graders/taxonomy.js";
import type { Product } from "../ground-truth/schema.js";

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
  /** Set when the product invocation threw. */
  error?: string;
}
