/**
 * Dogfood 30-run report.
 * Usage:
 *   npm run dogfood:report
 *
 * This reports REAL runs only. There is deliberately no seeding flag here: a
 * fabricated pass rate must never be emitted from the same command a human would
 * quote as a real dogfood figure. Seeding fixtures for harness self-tests lives
 * in the harness package (seedDogfoodScores), and every seeded record is marked
 * structurally so collectDogfood excludes it from these figures.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectDogfood,
  formatDogfoodReport,
  writeDogfoodReport,
} from "@mendpoint/harness";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function main() {
  const report = collectDogfood(root);
  const path = writeDogfoodReport(root, report);
  console.log(formatDogfoodReport(report));
  console.log(`wrote ${path}`);
  // Fail closed: a report contaminated by fabricated records is not a real
  // measurement and must never read as green.
  if (report.synthetic) {
    console.error(
      `refusing to pass: ${report.syntheticRuns} synthetic record(s) present in ${root}/runs`,
    );
    process.exit(3);
  }
  process.exit(report.day90Ready ? 0 : 2);
}

main();
