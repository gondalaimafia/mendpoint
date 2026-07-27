/**
 * Trajectory viewer CLI.
 * Usage:
 *   npm run trajectory:list
 *   npm run trajectory:view -- <runId>
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatRunList, viewTrajectory } from "@mendpoint/harness";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const runId = args[0];
  if (!runId || runId === "list") {
    console.log(formatRunList(root));
    return;
  }
  console.log(viewTrajectory(root, runId));
}

main();
