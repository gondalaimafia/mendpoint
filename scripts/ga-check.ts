/**
 * Production GA preflight — exit 0 only if release channel + critical surfaces look healthy.
 * npm run ga:check
 */
import { RELEASE, featureMatrix, validateApiEnv, readiness } from "@mendpoint/ops";
import { runGraphBenchmark } from "@mendpoint/graph-learn";

function fail(msg: string): never {
  console.error("GA CHECK FAIL:", msg);
  process.exit(1);
}

function main() {
  console.log("=== Mendpoint / Warden GA preflight ===");
  console.log(`version=${RELEASE.version} channel=${RELEASE.channel}`);

  if (RELEASE.channel !== "ga") fail("RELEASE.channel must be ga");
  if (RELEASE.version !== "1.0.0") {
    console.warn("note: version is", RELEASE.version);
  }

  const features = featureMatrix();
  const gaOff = features.filter((f) => f.tier === "ga" && !f.enabled);
  if (gaOff.length) fail(`GA features disabled: ${gaOff.map((f) => f.id).join(",")}`);

  const env = validateApiEnv();
  console.log("env mode=", env.mode, "ok=", env.ok);
  for (const w of env.warnings) console.log("  warn:", w);

  const ready = readiness();
  console.log("readiness=", ready.status);
  for (const c of ready.checks) {
    console.log(`  [${c.ok ? "ok" : "FAIL"}] ${c.name}: ${c.detail ?? ""}`);
  }
  if (ready.status === "fail") fail("readiness fail");

  const bench = runGraphBenchmark();
  console.log(`graph bench ${bench.passed}/${bench.total}`);
  if (bench.passed < 18) fail("graph benchmark below 18/20");

  console.log("GA CHECK PASS");
  console.log("Ship story: review-first migration PRs + Warden debug loop + registry + gates.");
  console.log("Not GA: Transformer campaigns, Firecracker, GNN train, silent auto-merge.");
  process.exit(0);
}

main();
