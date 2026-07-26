/**
 * One-command platform bring-up demo (Day-15 style).
 * npm run platform:dev
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlatform } from "@mendpoint/sdk";
import { runGraphBenchmark } from "@mendpoint/graph-learn";
import { helloWorldRun } from "@mendpoint/harness";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  console.log("=== Mendpoint Shared Platform P0 bring-up ===\n");

  const platform = createPlatform();
  console.log("1) Graph-RAG stats:");
  console.log("  ", platform.graphQuery({ op: "stats" }).summary);

  console.log("\n2) Harness hello world (plan + sandbox + trajectory):");
  const hello = await helloWorldRun(root);
  console.log("  runId=", hello.runId, "ok=", hello.ok);
  console.log("  artifacts=", hello.paths.root);

  console.log("\n3) Graph benchmark pack:");
  const bench = runGraphBenchmark();
  console.log(`  passed ${bench.passed}/${bench.total}`);

  console.log("\n4) Planner context (Warden, with historical patterns if any):");
  console.log(platform.plannerContext("warden").slice(0, 400) + "...\n");

  console.log("Platform ready for specialist teams.");
  console.log("Docs: docs/PLATFORM_RUNBOOK.md | docs/PLATFORM_P0_90DAY_GAP.md");
  process.exit(bench.passed >= 18 && hello.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
