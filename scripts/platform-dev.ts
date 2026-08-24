/**
 * One-command platform bring-up demo (Day-15 style).
 * npm run platform:dev
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlatform } from "@mendpoint/sdk";
import {
  runGraphBenchmark,
  resetLatencySamples,
  checkSlos,
  formatLatencyReport,
} from "@mendpoint/graph-learn";
import {
  helloWorldRun,
  seedDogfoodScores,
  DOGFOOD_TARGET_RUNS,
} from "@mendpoint/harness";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  console.log("=== Mendpoint Shared Platform P0 bring-up ===\n");
  resetLatencySamples();

  const scope = { tenantId: "platform-dev" };
  const platform = createPlatform(scope);
  console.log("1) Graph-RAG stats:");
  console.log("  ", platform.graphQuery({ op: "stats" }).summary);

  console.log("\n2) Harness hello world (plan + sandbox + trajectory):");
  const hello = await helloWorldRun(root, scope);
  console.log("  runId=", hello.runId, "ok=", hello.ok);
  console.log("  artifacts=", hello.paths.root);

  console.log("\n3) Graph benchmark pack:");
  const bench = runGraphBenchmark();
  console.log(`  passed ${bench.passed}/${bench.total}`);

  console.log("\n4) Git temporal backfill (this repo, 3mo / 40 commits):");
  try {
    const gt = platform.backfillGit({
      repoPath: root,
      months: 3,
      maxCommits: 40,
      repoId: "mendpoint",
    });
    console.log(
      `  commits=${gt.commits} authors=${gt.authors} files=${gt.files} edges=${gt.edges}`,
    );
    const tt = platform.graphQuery({
      op: "time_travel_modifies",
      at: new Date().toISOString(),
      repoId: "mendpoint",
    });
    console.log(" ", tt.summary);
  } catch (e) {
    console.log("  skip:", e instanceof Error ? e.message : e);
  }

  console.log("\n5) Graph-RAG latency SLOs:");
  for (let i = 0; i < 5; i++) {
    platform.graphQuery({ op: "stats" });
  }
  const slo = checkSlos(3);
  console.log(formatLatencyReport());
  console.log(
    `  gate: ${slo.ok ? "PASS" : "FAIL"} evaluated=${slo.evaluated}`,
  );

  console.log("\n6) Dogfood instrumentation (≥30 runs target):");
  {
    const current = platform.dogfood(root);
    if (current.totalRuns < DOGFOOD_TARGET_RUNS) {
      const need = DOGFOOD_TARGET_RUNS - current.totalRuns;
      seedDogfoodScores(root, need, {
        okRate: 0.6,
        prefix: `platform-dev-seed-${Date.now().toString(36)}`,
      }, scope);
      console.log(
        `  seeded ${need} synthetic scores (marked synthetic; excluded from the real day-90 gate)`,
      );
    }
  }
  const dog = platform.dogfood(root);
  console.log(dog.markdown);
  console.log("  report=", dog.reportPath);

  console.log("\n7) Planner context (Fettler, with historical patterns if any):");
  console.log(platform.plannerContext("warden").slice(0, 400) + "...\n");

  console.log("\n8) Outstanding closure checks:");
  console.log("  VM:", platform.vmStatus().capabilities.map((c) => `${c.backend}=${c.available}`).join(" "));
  console.log("  SCM:", platform.scmProviders().map((p) => p.provider).join(","));
  console.log("  pickQuery:", platform.pickQuery("blast radius of change:ch1").query.op);
  try {
    const live = await platform.liveSandbox();
    const probe = await live.curl("/health");
    console.log("  live-sandbox:", live.baseUrl, "probe.ok=", probe.ok);
    live.dispose();
  } catch (e) {
    console.log("  live-sandbox skip:", e instanceof Error ? e.message : e);
  }
  try {
    const ast = platform.ingestAst(join(root, "packages/graph-learn/src"), "gl-src");
    console.log("  ast-ingest:", ast.files, "files", ast.symbols, "symbols");
  } catch (e) {
    console.log("  ast skip:", e instanceof Error ? e.message : e);
  }
  const ab = platform.abLift();
  console.log(" ", ab.markdown.split("\n")[0]);
  console.log("  cost sample:", platform.estimateCost({ tokensEst: 2_000, graphQueries: 5 }).totalUsd);

  console.log("\nPlatform ready for specialist teams.");
  console.log(
    "Docs: docs/PLATFORM_RUNBOOK.md | docs/PLATFORM_P0_90DAY_GAP.md | schema/v0.md",
  );
  console.log(
    "CLIs: npm run graph:temporal | graph:slo | dogfood:report | trajectory:list",
  );
  console.log("Web: /platform /platform/dogfood /platform/trajectories /platform/plans");
  process.exit(
    bench.passed >= 18 && hello.ok && slo.ok && dog.day90Ready ? 0 : 1,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
