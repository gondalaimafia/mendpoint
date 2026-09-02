import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Drift detection for the six derived artifacts under
// evals/reports/production-learning. Together they are roughly 25,000 committed
// lines that no gate regenerated, so an edit to the case catalog, the repository
// provenance ledger or the requirement register could land while the artifacts
// published from them stayed stale, and nothing would say so.
//
// Comparison by diff alone could not do this before: generate-reports.ts stamped
// `new Date().toISOString()` into every artifact, so a regeneration always
// produced a six-file diff and a real content change looked exactly like the
// timestamp moving. The generator now takes PRODUCTION_LEARNING_GENERATED_AT,
// so this test pins the timestamp to the value already committed and any
// remaining difference is genuine content drift.
//
// SCOPE: this test runs under `vitest run scripts`, which is the second half of
// `npm test` (see scripts/run-root-tests.mjs). It is picked up by that glob, so
// it needs no entry in package.json — which matters, because package.json is a
// pinned authority surface in config/production-closure-authority.json and
// editing its authority-critical script commands would require a rotation.

const REPORT_DIRECTORY = "evals/reports/production-learning";
const ARTIFACTS = [
  "case-catalog.json",
  "case-catalog.md",
  "evaluation-status.json",
  "fixture-manifest-ledger.json",
  "repository-provenance.json",
  "requirement-case-test-production-matrix.json",
];

const repositoryRoot = resolve(__dirname, "..");
const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function committedGeneratedAt(): string {
  const catalog = JSON.parse(
    readFileSync(resolve(repositoryRoot, REPORT_DIRECTORY, "case-catalog.json"), "utf8"),
  ) as { generatedAt: string };
  return catalog.generatedAt;
}

// Regenerates the artifacts into a scratch directory, pinned to the committed
// timestamp, and returns that directory.
function regenerate(): string {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-production-learning-reports-"));
  temporaryDirectories.push(directory);
  const result = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs"), "evals/production-learning/generate-reports.ts", directory],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, PRODUCTION_LEARNING_GENERATED_AT: committedGeneratedAt() },
    },
  );
  if (result.status !== 0) {
    throw new Error(`production_learning_report_generation_failed:${result.status}:${result.stderr ?? ""}`);
  }
  return directory;
}

// Regeneration spawns tsx and rebuilds six artifacts, which is comfortably
// slower than Vitest's 5s default on a loaded machine, so every step that
// regenerates carries an explicit timeout.
const REGENERATION_TIMEOUT_MS = 120_000;

describe("production learning derived report drift", () => {
  let regeneratedDirectory: string;

  beforeAll(() => {
    regeneratedDirectory = regenerate();
  }, REGENERATION_TIMEOUT_MS);

  it("regenerates byte-identically, so a regeneration is a usable drift signal", () => {
    // Guards the injectable timestamp itself. If generate-reports.ts went back
    // to stamping wall-clock time, two regenerations would differ and every
    // comparison below would be meaningless rather than merely failing.
    const second = regenerate();
    for (const artifact of ARTIFACTS) {
      expect(readFileSync(join(second, artifact), "utf8"), artifact).toEqual(
        readFileSync(join(regeneratedDirectory, artifact), "utf8"),
      );
    }
  }, REGENERATION_TIMEOUT_MS);

  it("emits exactly the artifacts that are committed, with nothing extra or missing", () => {
    expect(readdirSync(regeneratedDirectory).sort()).toEqual([...ARTIFACTS].sort());
  });

  it.each(ARTIFACTS)("committed %s matches a fresh regeneration", (artifact) => {
    const committed = readFileSync(resolve(repositoryRoot, REPORT_DIRECTORY, artifact), "utf8");
    const regenerated = readFileSync(join(regeneratedDirectory, artifact), "utf8");
    expect(
      regenerated,
      `${REPORT_DIRECTORY}/${artifact} is stale. Regenerate it with:\n` +
        `  PRODUCTION_LEARNING_GENERATED_AT=<new timestamp> npx tsx evals/production-learning/generate-reports.ts`,
    ).toEqual(committed);
  });

  it("keeps every holdout answer key out of the committed case catalog", () => {
    // The seal boundary, asserted against the committed bytes rather than
    // against the generator, because it is the committed bytes that git history
    // makes permanent. `expected` and pattern.expectedImpactGraph are both
    // answer signal and both must be absent for every holdout case.
    const catalog = JSON.parse(
      readFileSync(resolve(repositoryRoot, REPORT_DIRECTORY, "case-catalog.json"), "utf8"),
    ) as { cases: { id: string; datasetSplit: string; expected?: unknown; pattern: { expectedImpactGraph: unknown } }[] };
    const holdouts = catalog.cases.filter((item) => item.datasetSplit === "holdout");
    expect(holdouts.length).toBeGreaterThan(0);
    const leaking = holdouts.filter(
      (item) => item.expected !== undefined || item.pattern.expectedImpactGraph !== null,
    );
    expect(leaking.map((item) => item.id)).toEqual([]);
  });
});
