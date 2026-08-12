/**
 * Learning-corpus exporter CLI.
 *
 * Produces a labeled fine-tuning corpus (JSONL) from ONLY sealed, consented,
 * approved, redacted learning data for one tenant + purpose. It is read-only and
 * trains no model; it prepares the dataset a post-training run would consume.
 *
 * Usage:
 *   npm run learning:export-corpus -- --tenant=tenant_default
 *   npm run learning:export-corpus -- --tenant=t1 --purpose=transformer-adaptive-repair
 *   npm run learning:export-corpus -- --tenant=t1 --dataset-version=<id> --out=corpus.jsonl
 *   npm run learning:export-corpus -- --tenant=t1 --db=./mendpoint.sqlite --at=2026-08-12T00:00:00.000Z
 *
 * Flags:
 *   --tenant           (required) tenant id whose consented data to export
 *   --purpose          consent purpose scope (default: transformer-adaptive-repair)
 *   --dataset-version  explicit sealed dataset version id (default: latest sealed)
 *   --at               eligibility instant, ISO 8601 (default: now)
 *   --db               SQLite path or file: url (default: DATABASE_URL / resolveDbPath)
 *   --out              write JSONL here (default: stdout). Stats always go to stderr.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLearningCorpus,
  createDb,
  formatLearningCorpusStats,
  resolveDbPath,
  serializeLearningCorpusJsonl,
} from "@mendpoint/db";

/** Default consent purpose for the Transformer adaptive learning loop. */
const DEFAULT_PURPOSE = "transformer-adaptive-repair";

function arg(argv: readonly string[], name: string): string | undefined {
  const hit = argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}

export function runExport(argv: readonly string[]): number {
  const tenantId = arg(argv, "tenant");
  if (!tenantId) {
    process.stderr.write("error: --tenant=<id> is required\n");
    return 2;
  }
  const purpose = arg(argv, "purpose") ?? DEFAULT_PURPOSE;
  const datasetVersionId = arg(argv, "dataset-version");
  const at = arg(argv, "at") ?? new Date().toISOString();
  const out = arg(argv, "out");

  const db = createDb(resolveDbPath(arg(argv, "db")));
  try {
    const result = buildLearningCorpus({
      db,
      tenantId,
      purpose,
      at,
      datasetVersionId,
    });
    const jsonl = serializeLearningCorpusJsonl(result.examples);
    if (out) {
      writeFileSync(resolve(out), jsonl);
      process.stderr.write(`wrote ${result.examples.length} examples to ${resolve(out)}\n`);
    } else {
      process.stdout.write(jsonl);
    }
    process.stderr.write(`\n${formatLearningCorpusStats(result.stats)}\n`);
    process.stderr.write(`reason: ${result.reason}\n`);
    return 0;
  } finally {
    db.raw.close();
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  process.exit(runExport(process.argv.slice(2)));
}
