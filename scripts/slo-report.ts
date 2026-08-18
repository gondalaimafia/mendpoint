/**
 * Graph-RAG latency SLO report — warms queries then prints p50/p99.
 * Usage: npm run graph:slo
 */
import {
  getGraphLearnDb,
  runGraphQuery,
  runGraphBenchmark,
  resetLatencySamples,
  checkSlos,
  formatLatencyReport,
  latencyReport,
} from "@mendpoint/graph-learn";

// Dedicated operator scope for the latency harness. Like the graph benchmark's
// own scope, this exercises the fail-closed tenant read path under an explicit,
// named tenant rather than the global cross-tenant graph; the SLO gate measures
// query latency, not any customer's data.
const SLO_SCOPE = { tenantId: "slo-report" };

function main() {
  resetLatencySamples();
  const db = getGraphLearnDb();

  // Warm common ops
  for (let i = 0; i < 8; i++) {
    runGraphQuery(db, { op: "stats" }, SLO_SCOPE);
    runGraphQuery(db, { op: "who_consumes_provider", providerSlug: "acme" }, SLO_SCOPE);
    runGraphQuery(db, {
      op: "blast_radius",
      nodeId: "change:ch1",
      maxHops: 2,
    }, SLO_SCOPE);
    runGraphQuery(db, { op: "pattern_success_rates", minSamples: 1 }, SLO_SCOPE);
  }

  // Bench also exercises ops
  const bench = runGraphBenchmark();
  console.log(`benchmark: ${bench.passed}/${bench.total}`);

  const report = latencyReport();
  console.log(formatLatencyReport(report));
  const slo = checkSlos(3);
  console.log(
    `SLO gate: ${slo.ok ? "PASS" : "FAIL"} evaluated=${slo.evaluated} skipped=${slo.skipped}`,
  );
  if (slo.violations.length) {
    for (const v of slo.violations) console.log("  !", v);
  }
  process.exit(slo.ok && bench.passed >= 18 ? 0 : 1);
}

main();
