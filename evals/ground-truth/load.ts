/**
 * Ground-truth loader.
 *
 * Loads and validates the JSON answer keys. Enforces two invariants the eval
 * depends on:
 *   1. Every scenario file is well-formed (validateGroundTruth passes).
 *   2. The answer key is never located inside the repo under test — this loader
 *      only ever reads from `evals/ground-truth/`, and the scenario registry's
 *      repo paths live outside this git repo entirely.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGroundTruth, type GroundTruth } from "./schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadGroundTruth(scenarioId: string): GroundTruth {
  const file = join(HERE, `${scenarioId}.json`);
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const problems = validateGroundTruth(raw);
  if (problems.length) {
    throw new Error(
      `ground truth ${scenarioId} invalid:\n  - ${problems.join("\n  - ")}`,
    );
  }
  return raw as GroundTruth;
}

export function loadAllGroundTruth(): GroundTruth[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort()
    .map(loadGroundTruth);
}
