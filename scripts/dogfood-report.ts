/**
 * Dogfood 30-run report.
 * Usage:
 *   npm run dogfood:report
 *   npm run dogfood:report -- --seed=30
 *   npm run dogfood:report -- --seed=30 --ok-rate=0.55
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectDogfood,
  formatDogfoodReport,
  seedDogfoodScores,
  writeDogfoodReport,
  DOGFOOD_TARGET_RUNS,
} from "@mendpoint/harness";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  return undefined;
}

function main() {
  const seedN = arg("seed");
  if (seedN) {
    const n = Number(seedN) || DOGFOOD_TARGET_RUNS;
    const okRate = Number(arg("ok-rate") ?? "0.6");
    const ids = seedDogfoodScores(root, n, { okRate, prefix: "dogfood-seed" });
    console.log(`seeded ${ids.length} dogfood scores (okRate≈${okRate})`);
  }

  const report = collectDogfood(root);
  const path = writeDogfoodReport(root, report);
  console.log(formatDogfoodReport(report));
  console.log(`wrote ${path}`);
  process.exit(report.day90Ready ? 0 : 2);
}

main();
