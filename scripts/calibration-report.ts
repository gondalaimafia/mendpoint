/**
 * Cross-run calibration report CLI.
 *
 * Reads ONLY sealed, consented, redacted learning data for one tenant -- the same
 * read path the training-corpus exporter uses (buildLearningCorpus) -- from BOTH
 * arms of the legacy learning loop, then computes a confidence-calibration report.
 * It is read-only, trains nothing, and emits no learning attribution.
 *
 * The two arms:
 *   - approved outcomes under `transformer-adaptive-repair` (decision "accepted")
 *   - rejected outcomes under `transformer-adaptive-rejected-outcomes`
 * (both constants live in apps/worker/src/transformer-learning-outcome.ts).
 *
 * The outcome being calibrated is the HUMAN REVIEWER'S decision, not correctness,
 * and the confidence is the model's own self-score. The report carries both facts
 * in fixed fields; see packages/pipeline/src/calibration-report.ts.
 *
 * Usage:
 *   npm run calibration:report -- --tenant=tenant_default
 *   npm run calibration:report -- --tenant=t1 --at=2026-08-12T00:00:00.000Z
 *   npm run calibration:report -- --tenant=t1 --db=./mendpoint.sqlite --out=calibration.json
 *   npm run calibration:report -- --tenant=t1 --min-bucket-observations=10
 *
 * Flags:
 *   --tenant                    (required) tenant id whose consented data to read
 *   --approved-purpose          approved-arm consent purpose (default below)
 *   --rejected-purpose          rejected-arm consent purpose (default below)
 *   --approved-dataset-version  explicit sealed dataset version for the approved arm
 *   --rejected-dataset-version  explicit sealed dataset version for the rejected arm
 *   --min-bucket-observations   small-N floor override (default: package default)
 *   --at                        eligibility instant, ISO 8601 (default: now)
 *   --db                        SQLite path or file: url (default: DATABASE_URL)
 *   --out                       write the JSON report here (default: stdout). The
 *                               readable table always goes to stderr.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLearningCorpus,
  createDb,
  resolveDbPath,
  type AppDb,
} from "@mendpoint/db";
import {
  computeCalibrationReport,
  formatCalibrationReport,
  observationsFromCorpusExamples,
  type CalibrationObservation,
  type CalibrationReport,
} from "@mendpoint/pipeline";

/** Approved-arm consent purpose (TRANSFORMER_LEARNING_PURPOSE). */
const DEFAULT_APPROVED_PURPOSE = "transformer-adaptive-repair";
/** Rejected-arm consent purpose (TRANSFORMER_REJECTED_OUTCOME_PURPOSE). */
const DEFAULT_REJECTED_PURPOSE = "transformer-adaptive-rejected-outcomes";

function arg(argv: readonly string[], name: string): string | undefined {
  const hit = argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}

/** Per-arm read outcome: which purpose, why the corpus resolved as it did, and count. */
export type CalibrationArmStats = Readonly<{
  purpose: string;
  reason: string;
  observations: number;
}>;

export type CrossRunCalibration = Readonly<{
  tenantId: string;
  at: string;
  arms: readonly CalibrationArmStats[];
  report: CalibrationReport;
}>;

export type BuildCrossRunCalibrationInput = Readonly<{
  db: AppDb;
  tenantId: string;
  at: string;
  approvedPurpose?: string;
  rejectedPurpose?: string;
  approvedDatasetVersionId?: string;
  rejectedDatasetVersionId?: string;
  minBucketObservations?: number;
}>;

/**
 * Read both arms for one tenant and compute the merged calibration report. Pure
 * over the database (read-only) and returns the arm-by-arm read stats alongside
 * the report so the caller can see how each arm resolved (e.g. no_active_consent,
 * no_sealed_dataset, ok).
 */
export function buildCrossRunCalibration(
  input: BuildCrossRunCalibrationInput,
): CrossRunCalibration {
  const approvedPurpose = input.approvedPurpose ?? DEFAULT_APPROVED_PURPOSE;
  const rejectedPurpose = input.rejectedPurpose ?? DEFAULT_REJECTED_PURPOSE;

  const specs: readonly Readonly<{ purpose: string; datasetVersionId?: string }>[] = [
    { purpose: approvedPurpose, datasetVersionId: input.approvedDatasetVersionId },
    { purpose: rejectedPurpose, datasetVersionId: input.rejectedDatasetVersionId },
  ];

  const arms: CalibrationArmStats[] = [];
  const observations: CalibrationObservation[] = [];
  for (const spec of specs) {
    const corpus = buildLearningCorpus({
      db: input.db,
      tenantId: input.tenantId,
      purpose: spec.purpose,
      at: input.at,
      datasetVersionId: spec.datasetVersionId,
    });
    const armObservations = observationsFromCorpusExamples(corpus.examples);
    observations.push(...armObservations);
    arms.push(
      Object.freeze({
        purpose: spec.purpose,
        reason: corpus.reason,
        observations: armObservations.length,
      }),
    );
  }

  const report = computeCalibrationReport(observations, {
    minBucketObservations: input.minBucketObservations,
  });

  return Object.freeze({
    tenantId: input.tenantId,
    at: input.at,
    arms: Object.freeze(arms),
    report,
  });
}

export function runCalibrationReport(argv: readonly string[]): number {
  const tenantId = arg(argv, "tenant");
  if (!tenantId) {
    process.stderr.write("error: --tenant=<id> is required\n");
    return 2;
  }
  const at = arg(argv, "at") ?? new Date().toISOString();
  const out = arg(argv, "out");
  const minRaw = arg(argv, "min-bucket-observations");
  let minBucketObservations: number | undefined;
  if (minRaw !== undefined) {
    const parsed = Number(minRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      process.stderr.write("error: --min-bucket-observations must be a positive integer\n");
      return 2;
    }
    minBucketObservations = parsed;
  }

  const db = createDb(resolveDbPath(arg(argv, "db")));
  try {
    const result = buildCrossRunCalibration({
      db,
      tenantId,
      at,
      approvedPurpose: arg(argv, "approved-purpose"),
      rejectedPurpose: arg(argv, "rejected-purpose"),
      approvedDatasetVersionId: arg(argv, "approved-dataset-version"),
      rejectedDatasetVersionId: arg(argv, "rejected-dataset-version"),
      minBucketObservations,
    });

    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (out) {
      writeFileSync(resolve(out), json);
      process.stderr.write(`wrote calibration report to ${resolve(out)}\n`);
    } else {
      process.stdout.write(json);
    }

    // Readable table (and per-arm read stats) always to stderr.
    for (const armStats of result.arms) {
      process.stderr.write(
        `arm ${armStats.purpose}: ${armStats.observations} observation(s) (${armStats.reason})\n`,
      );
    }
    process.stderr.write(`\n${formatCalibrationReport(result.report)}\n`);
    return 0;
  } finally {
    db.raw.close();
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  process.exit(runCalibrationReport(process.argv.slice(2)));
}
