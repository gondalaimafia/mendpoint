/**
 * Run every GA gate and report ALL failures, instead of stopping at the first.
 *
 * `ga:check` chains twelve stages with `&&`, so the first red hides every gate
 * behind it. That is not a neutral detail: it trains serial discovery. One
 * subsystem here had five stacked causes, each visible only after the previous
 * fix merged — five fix-PRs and five CI cycles to learn what one full run would
 * have shown at once (docs/agents/FAILURE_MODES.md §10).
 *
 * This runs each stage independently, prints a per-stage verdict, and exits
 * non-zero if any failed — same pass/fail contract as the chain, strictly more
 * information. `ga:check` keeps the fail-fast chain for the common case where a
 * developer wants the first error quickly; `ga:check:all` is for "tell me
 * everything that is broken", which is what you want before declaring a
 * subsystem fixed.
 *
 * Stage list is derived from the `ga:check` script itself, so a stage added to
 * the chain is automatically covered here and the two cannot silently diverge.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

interface Stage {
  label: string;
  command: string;
}

/** Parse the ga:check chain rather than duplicating it. */
export function stagesFrom(gaCheck: string): Stage[] {
  return gaCheck
    .split("&&")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((command) => ({
      label: command.startsWith("npm run ") ? command.slice("npm run ".length) : command,
      command,
    }));
}

function readGaCheck(): string {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const gaCheck = manifest.scripts?.["ga:check"];
  if (typeof gaCheck !== "string" || gaCheck.trim() === "") {
    // A missing chain must never read as "no stages, everything passed".
    throw new Error("ga_check_script_missing");
  }
  return gaCheck;
}

function main(): void {
  const stages = stagesFrom(readGaCheck()).filter((stage) => stage.label !== "ga-check-all");
  const failed: string[] = [];
  const passed: string[] = [];

  for (const stage of stages) {
    process.stdout.write(`\n=== ${stage.label} ===\n`);
    const result = spawnSync(stage.command, {
      cwd: ROOT,
      shell: true,
      stdio: "inherit",
      env: process.env,
    });
    // A stage killed by a signal, or one that could not be spawned, is a
    // failure — never treat an absent status as success.
    const ok = result.error === undefined && result.status === 0;
    (ok ? passed : failed).push(stage.label);
  }

  process.stdout.write("\n================ GA CHECK (all stages) ================\n");
  for (const stage of stages) {
    const mark = failed.includes(stage.label) ? "FAIL" : "pass";
    process.stdout.write(`  ${mark}  ${stage.label}\n`);
  }
  process.stdout.write(
    `\n${passed.length} passed, ${failed.length} failed of ${stages.length} stages\n`,
  );

  if (failed.length > 0) {
    throw new Error(`ga check: ${failed.length} failing stage(s): ${failed.join(", ")}`);
  }
  process.stdout.write("GA CHECK ALL PASS\n");
}

if (import.meta.filename === process.argv[1]) main();
