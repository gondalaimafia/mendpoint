/**
 * Phase 8 — procedural scenario generation entry point.
 *
 * `generateScenarios()` returns every generated scenario (families +
 * counterfactuals + holdout variations) with a full, schema-valid GroundTruth.
 * `materializeRepo()` writes an in-memory synthetic repo to a fresh scratch
 * directory (plus the OpenAPI spec pair for Fettler scenarios) so the SAME
 * product path the corpus scenarios use can run against it, then hands back a
 * cleanup. Generated repos never contain an answer-key file, so staging strips
 * nothing from them — but they still flow through the same staging step for
 * uniformity.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { validateGroundTruth } from "../ground-truth/schema.js";
import type { SyntheticRepo } from "../mutations/engine.js";
import { generateAllScenarios } from "./families.js";
import type { GeneratedScenario } from "./types.js";

export type { GeneratedScenario } from "./types.js";
export { generateAllScenarios, holdoutRefVariations } from "./families.js";

/**
 * All generated scenarios. Every ground truth is validated here so a malformed
 * auto-emitted key fails fast rather than silently mis-scoring a run.
 */
export function generateScenarios(): GeneratedScenario[] {
  const scenarios = generateAllScenarios();
  const seen = new Set<string>();
  for (const s of scenarios) {
    if (seen.has(s.scenario_id)) {
      throw new Error(`duplicate generated scenario id: ${s.scenario_id}`);
    }
    seen.add(s.scenario_id);
    const problems = validateGroundTruth(s.gt);
    if (problems.length) {
      throw new Error(
        `generated ground truth ${s.scenario_id} invalid:\n  - ${problems.join("\n  - ")}`,
      );
    }
    if (s.gt.scenario_id !== s.scenario_id) {
      throw new Error(`scenario_id mismatch: ${s.scenario_id} vs gt ${s.gt.scenario_id}`);
    }
  }
  return scenarios;
}

export interface MaterializedRepo {
  repoPath: string;
  cleanup: () => void;
}

/** Write an in-memory synthetic repo (and its spec pair) to scratch. */
export function materializeRepo(repo: SyntheticRepo): MaterializedRepo {
  const repoPath = mkdtempSync(join(tmpdir(), "mendpoint-eval-gen-"));
  const write = (rel: string, content: string): void => {
    const abs = join(repoPath, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };
  for (const [rel, content] of Object.entries(repo.files)) write(rel, content);
  if (repo.specV1 !== undefined) {
    write("spec/openapi-v1.json", JSON.stringify(repo.specV1, null, 2) + "\n");
  }
  if (repo.specV2 !== undefined) {
    write("spec/openapi-v2.json", JSON.stringify(repo.specV2, null, 2) + "\n");
  }
  let cleaned = false;
  return {
    repoPath,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      try {
        rmSync(repoPath, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}
