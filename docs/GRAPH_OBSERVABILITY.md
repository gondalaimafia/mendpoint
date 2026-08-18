# Change Graph observability inventory

Spec v3 §22.4 lists fourteen graph metrics and §21.2.1 lists seven graph
build/retrieval budgets. This document records the honest status of each: what
is emitted today, what is not yet measurable, and what blocks the rest. It
exists so gate coverage stays honest. A metric is either emitted from a real
source, or listed here with the reason it cannot be measured yet and the
smallest change that would move it into "emitted".

The rule this inventory enforces: no metric emits a placeholder, zero, or
estimated value from a source that does not exist. A panel reading
`entity_resolution_failures: 0` when entity resolution does not exist is worse
than no panel, so those metrics are named here rather than faked.

## How latency is emitted

`packages/graph-learn/src/query.ts` times every `runGraphQuery` call and passes
the sample to `recordLatency` in `packages/graph-learn/src/slo.ts`. That
function does two things with each sample:

1. writes it to a 500-entry, process-local ring (read by `GET
   /graph-learn/slo`, the SDK `latencySlo()` call, `scripts/slo-report.ts`, and
   `scripts/platform-dev.ts`); and
2. emits it to the vendor-neutral telemetry sink in
   `packages/ops/src/telemetry.ts` as a `graph_query_duration_ms` histogram and
   a `graph_query_total` counter, both labelled by `op`.

The telemetry sink is a no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so a
configured collector receives the histogram off-process while the ring stays the
source of truth for the in-process SLO gate. The SLO gate evaluates P50, P95,
and P99 against per-op budgets (`DEFAULT_SLO_TARGETS`).

## §22.4 Graph metrics

| # | Metric | Status | Notes |
|---|--------|--------|-------|
| 1 | entities/edges by type | **emitted** | `countStats` returns `nodesByKind` / `edgesByKind` via `GROUP BY kind`, folding legacy kinds into their v0 form. |
| 1 | entities/edges by epistemic state | **blocked** | No epistemic-status column exists in the graph schema (`gl_nodes` / `gl_edges` have no such field). Being built by a separate workstream. Emitting a breakdown now would be a fabricated bucket. Unblocks once epistemic status is a stored, queryable column. |
| 2 | graph/index freshness | **not-yet-measurable** | No per-graph or per-index materialization timestamp is tracked, so "how stale is the graph" has no source. Unblocks by stamping and emitting a last-materialized time per graph/index. |
| 3 | graph coverage by task/repository class | **not-yet-measurable** | There is no coverage denominator and no task/repository-class labelling on graph contents. Unblocks by defining the population a graph is meant to cover and labelling entities by task/repo class. |
| 4 | entity-resolution failures and ambiguity | **blocked** | No entity-resolution subsystem exists to fail; identities are assigned directly at write time. Unblocks once an entity-resolution stage exists and can report failures/ambiguity. |
| 5 | extraction/materialization failures | **not-yet-measurable** | Extraction and materialization do not count or emit their failures. Unblocks by counting failed extraction/materialization attempts through the telemetry sink. |
| 6 | stale/conflicting edges | **not-yet-measurable** | No staleness or conflict detector runs over `gl_edges`. Unblocks once edges carry a validation/conflict signal that can be counted. |
| 7 | hidden-dependency discoveries | **not-yet-measurable** | Nothing classifies a discovered edge as previously hidden. Unblocks by recording, at ingest, whether an edge was already known. |
| 8 | graph-induced false positives/false negatives | **blocked** | `gl_edges.confidence` is assigned by fiat at write time and never validated against an outcome, and no graph-gated decision runs in production, so there is no graph-attributable prediction to score. Matches the `change-graph-completeness-and-confidence-calibration` entry in `evals/readiness-gates.json`. Unblocks by wiring the already-written `runImpactBenchmark` / `evaluateConfidenceCalibration` into a scored eval. |
| 9 | raw-retrieval fallback rate | **blocked** | The impact path never consults the graph, so there is no graph-vs-raw decision and no fallback to count. Structurally unmeasurable until graph-backed retrieval is on the impact path. |
| 10 | graph query latency | **emitted** | Ring buffer plus `graph_query_duration_ms` histogram; P50/P95/P99 against per-op budgets. See "How latency is emitted" above. |
| 11 | context compilation latency | **not-yet-measurable** | No context-compilation stage is instrumented (the graph is not on the context/retrieval path). Unblocks by timing a real context-compilation step. |
| 12 | context tokens with/without graph representation | **not-yet-measurable** | No A/B token accounting exists because the graph is not on the retrieval path, so there is no "with graph" arm to compare. Matches the `retrieval-quality` gap in `evals/readiness-gates.json`. Unblocks once graph-backed retrieval runs and token counts can be compared against the raw arm. |
| 13 | percentage of Fettler/ReGauge findings supported by explicit evidence paths | **not-yet-measurable** | Query results carry a coverage basis and evidence exists per finding, but no aggregate ratio (findings-with-evidence / total-findings) is computed or emitted. Unblocks by defining the denominator and emitting the ratio. |
| 14 | graph version used per mission | **blocked** | The schema version is hardcoded (`schema: "v0"`) and no per-mission graph version is stamped onto a mission record. Unblocks by introducing graph versioning and stamping the version onto each mission. |

## §21.2.1 Graph build and retrieval budgets

| # | Budget | Status | Notes |
|---|--------|--------|-------|
| 1 | full graph build time | **not-yet-measurable** | The build path is not timed into the telemetry sink. Unblocks by wrapping the full build in a span/histogram. |
| 2 | incremental graph update time | **not-yet-measurable** | `incrementalReingest` runs but is not timed or emitted. Unblocks by timing incremental reingest through the sink. |
| 3 | graph publication time | **not-yet-measurable** | No publication step is timed. Unblocks once a publication step exists and is instrumented. |
| 4 | graph query P50/P95 | **emitted** | P50 and P95 (plus P99) are computed per op and evaluated against budgets; P95 was added in this change. |
| 5 | context compilation time | **not-yet-measurable** | Same gap as §22.4 metric 11: no context-compilation stage is instrumented. |
| 6 | mission subgraph size | **not-yet-measurable** | Queries return node/edge counts, but no per-mission subgraph size is recorded against a mission id. Unblocks by stamping subgraph size onto a mission record. |
| 7 | raw retrieval fallback rate | **blocked** | Same as §22.4 metric 9: no fallback path exists to measure. |

## Related, not part of §22.4/§21.2.1

Per-run graph-query count is now recorded honestly in the harness. The executor
threads the real number of graph queries a run executed into the run score and
the dogfood ledger, replacing a hardcoded `graphQueries = 0`. A run that makes
no graph queries records a measured zero; a run that makes graph queries records
the real count.

## Out of scope

`docs/PERFORMANCE_CONTRACT.md` and `packages/eval/src/performance-contract.ts`
cover a different metric set (`first_result`, `complete_scan`, `verification`,
`queue_wait`, `campaign_fanout`) and need an external probe endpoint. That
contract is not merged with the graph metrics here.
