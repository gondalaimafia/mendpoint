/**
 * Impact grading harness.
 *
 * Runs the real change-intel -> code-impact pipeline against a repository that
 * ships an OpenAPI v1/v2 pair, then grades the file-level findings against a
 * ground-truth list of files that a correct migration must flag.
 *
 * Reports precision, recall, the false-positive list by name, and the missed
 * (false-negative) list by name — so the whole corpus can be graded, not just
 * one repo. Confident findings (medium+) are graded; low-confidence
 * notifications are reported separately so a reviewer can see honestly-degraded
 * matches without them counting as confident claims.
 *
 * Usage:
 *   tsx scripts/impact-grade.ts <repoPath> --expected "a.ts,b.ts" [--slug meridian]
 *   tsx scripts/impact-grade.ts <repoPath> --expected-none   # correct output is nothing
 *   tsx scripts/impact-grade.ts --corpus                      # grade the built-in corpus
 *
 * Flags:
 *   --expected "<csv>"   repo-relative files a correct run must flag
 *   --expected-none      shorthand for an empty expected set
 *   --slug <slug>        provider slug hint (defaults to deriving from tokens)
 *   --old <path>         old spec path (default spec/openapi-v1.json)
 *   --new <path>         new spec path (default spec/openapi-v2.json)
 *   --json               emit a machine-readable JSON result
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeChange } from "@mendpoint/change-intel";
import { analyzeImpact } from "@mendpoint/code-impact";
import type { ImpactReport } from "@mendpoint/shared";
// Resolve the corpus root through the shared resolver rather than reading
// MENDPOINT_CORPUS_ROOT here: `resolve(process.env.X ?? "...")` silently
// collapses an empty (unset repository) variable onto process.cwd(), pointing
// the grader at this repo instead of the corpus. See evals/scenarios/corpus-root.ts.
import { CORPUS_ROOT as DEV } from "../evals/scenarios/corpus-root.js";

export type GradeResult = {
  repo: string;
  expected: string[];
  flagged: string[];
  truePositives: string[];
  falsePositives: string[];
  missed: string[];
  precision: number;
  recall: number;
  lowConfidenceFiles: string[];
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function uniqueSorted(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

export async function gradeRepo(opts: {
  repoPath: string;
  expected: string[];
  slug?: string;
  oldSpec?: string;
  newSpec?: string;
}): Promise<GradeResult> {
  const repoPath = resolve(opts.repoPath);
  const oldPath = join(repoPath, opts.oldSpec ?? "spec/openapi-v1.json");
  const newPath = join(repoPath, opts.newSpec ?? "spec/openapi-v2.json");
  const oldSpec = JSON.parse(readFileSync(oldPath, "utf8"));
  const newSpec = JSON.parse(readFileSync(newPath, "utf8"));

  const { surfaces } = normalizeChange(oldSpec, newSpec, {
    providerSlug: opts.slug,
  });

  const report: ImpactReport = await analyzeImpact(repoPath, surfaces, {
    useLlm: false,
    minConfidence: "medium",
  });

  const flagged = uniqueSorted(report.sites.map((s) => s.filePath));
  const lowConfidenceFiles = uniqueSorted(
    report.lowConfidenceNotifications.map((s) => s.filePath),
  );
  const expected = uniqueSorted(opts.expected);
  const expectedSet = new Set(expected);
  const flaggedSet = new Set(flagged);

  const truePositives = flagged.filter((f) => expectedSet.has(f));
  const falsePositives = flagged.filter((f) => !expectedSet.has(f));
  const missed = expected.filter((f) => !flaggedSet.has(f));

  const precision = flagged.length ? truePositives.length / flagged.length : expected.length ? 0 : 1;
  const recall = expected.length ? truePositives.length / expected.length : flagged.length ? 0 : 1;

  return {
    repo: repoPath,
    expected,
    flagged,
    truePositives,
    falsePositives,
    missed,
    precision,
    recall,
    lowConfidenceFiles,
  };
}

export function printResult(r: GradeResult): void {
  const tp = r.truePositives.length;
  console.log(`\n=== ${r.repo} ===`);
  console.log(
    `recall    : ${tp}/${r.expected.length} expected files found` +
      (r.expected.length === 0 ? " (expected: nothing)" : ""),
  );
  console.log(
    `precision : ${tp} correct of ${r.flagged.length} files flagged  (${pct(r.precision)})`,
  );
  if (r.falsePositives.length) {
    console.log(`false positives (${r.falsePositives.length}):`);
    for (const f of r.falsePositives) console.log(`  - ${f}`);
  } else {
    console.log(`false positives (0): none`);
  }
  if (r.missed.length) {
    console.log(`MISSED real sites (${r.missed.length}):`);
    for (const f of r.missed) console.log(`  ! ${f}`);
  }
  if (r.lowConfidenceFiles.length) {
    console.log(`low-confidence notifications (${r.lowConfidenceFiles.length}):`);
    for (const f of r.lowConfidenceFiles) console.log(`  ~ ${f}`);
  }
}

type CorpusEntry = { path: string; slug?: string; expected: string[] };

const CORPUS: CorpusEntry[] = [
  {
    path: join(DEV, "synthetic-payments-svc"),
    slug: "meridian",
    expected: [
      "src/infra/providers/meridian/client.ts",
      "src/services/checkoutService.ts",
      "src/services/subscriptionService.ts",
      "test/fixtures/charges.ts",
      "src/jobs/settlementJob.ts",
    ],
  },
  {
    path: join(DEV, "synthetic-corpus/edge/already-migrated"),
    expected: [],
  },
  {
    path: join(DEV, "synthetic-corpus/edge/generated-code"),
    slug: "acme",
    expected: ["src/handwritten/charges.js", "check.mjs"],
  },
  {
    path: join(DEV, "synthetic-corpus/edge/deep-indirection"),
    slug: "acmepay",
    expected: [
      "src/app/order.js",
      "src/shared/payments-facade.js",
      "src/shared/http-client.js",
      "src/vendor-sdk/acmepay.js",
      "check.mjs",
    ],
  },
];

function parseArgs(argv: string[]): {
  repoPath?: string;
  expected: string[];
  expectedNone: boolean;
  slug?: string;
  oldSpec?: string;
  newSpec?: string;
  json: boolean;
  corpus: boolean;
} {
  const out = {
    repoPath: undefined as string | undefined,
    expected: [] as string[],
    expectedNone: false,
    slug: undefined as string | undefined,
    oldSpec: undefined as string | undefined,
    newSpec: undefined as string | undefined,
    json: false,
    corpus: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--corpus") out.corpus = true;
    else if (a === "--json") out.json = true;
    else if (a === "--expected-none") out.expectedNone = true;
    else if (a === "--expected") out.expected = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--slug") out.slug = argv[++i];
    else if (a === "--old") out.oldSpec = argv[++i];
    else if (a === "--new") out.newSpec = argv[++i];
    else if (!a.startsWith("--")) out.repoPath = a;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.corpus) {
    const results: GradeResult[] = [];
    for (const entry of CORPUS) {
      const r = await gradeRepo({ repoPath: entry.path, expected: entry.expected, slug: entry.slug });
      results.push(r);
      if (!args.json) printResult(r);
    }
    if (args.json) console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (!args.repoPath) {
    console.error("usage: tsx scripts/impact-grade.ts <repoPath> --expected \"a,b\" [--slug x]");
    console.error("       tsx scripts/impact-grade.ts --corpus");
    process.exit(2);
  }

  const r = await gradeRepo({
    repoPath: args.repoPath,
    expected: args.expectedNone ? [] : args.expected,
    slug: args.slug,
    oldSpec: args.oldSpec,
    newSpec: args.newSpec,
  });
  if (args.json) console.log(JSON.stringify(r, null, 2));
  else printResult(r);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]).replace(/\\/g, "/").endsWith("impact-grade.ts");
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
