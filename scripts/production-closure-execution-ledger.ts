/**
 * Production closure execution ledger gate.
 *
 * Invoke with `npx tsx scripts/production-closure-execution-ledger.ts`.
 * Root `test` already runs `scripts/production-closure-execution-ledger.test.ts`,
 * which is the CI gate. This file is the same check as a standalone process.
 * Do not add npm scripts for it: `package.json` is a pinned authority surface.
 *
 * The problem this guards against
 * --------------------------------
 * `docs/PRODUCTION_CLOSURE_EXECUTION_LEDGER.json` is generated from the
 * canonical register by `generate-production-closure-execution-ledger.ts`, but
 * nothing outside that generator and its unit test ever read it. A generated
 * artifact that no gate reads is free to drift the moment the register changes:
 * the committed file silently stops matching what the generator would produce,
 * and no CI step notices.
 *
 * What this gate establishes
 * --------------------------
 *   1. No drift — the committed artifact is byte-for-byte identical to a fresh
 *      generation. Regenerate with
 *      `npx tsx scripts/generate-production-closure-execution-ledger.ts`
 *      after any register change; this gate fails until the committed file is
 *      refreshed.
 *   2. No masquerade — no row's `reachableCodePath` points at a test file. The
 *      test/source distinction is routed through evidence-reachability-check's
 *      `isTestPath` rather than a second, bespoke judge, so "reachable code
 *      path" cannot silently degrade to the row's own regression test.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildExecutionLedger,
} from "./generate-production-closure-execution-ledger.js";
import { isTestPath } from "./evidence-reachability-check.js";

export interface LedgerGateIssue {
  code: string;
  subject: string;
  message: string;
}

/**
 * The exact bytes `writeExecutionLedger` commits: `JSON.stringify(ledger, null, 2)`
 * followed by a trailing newline. Keeping this in one place ties the drift check
 * to the generator's real serialization instead of a re-implementation of it.
 */
export function serializeLedger(ledger: ReturnType<typeof buildExecutionLedger>): string {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

export function evaluateLedgerGate(
  committedText: string,
  ledger: ReturnType<typeof buildExecutionLedger>,
): LedgerGateIssue[] {
  const issues: LedgerGateIssue[] = [];
  const expected = serializeLedger(ledger);
  if (committedText !== expected) {
    issues.push({
      code: "LEDGER_DRIFT",
      subject: "docs/PRODUCTION_CLOSURE_EXECUTION_LEDGER.json",
      message:
        "committed ledger does not match a fresh generation; run `npx tsx scripts/generate-production-closure-execution-ledger.ts` and commit the result",
    });
  }
  for (const row of ledger.rows) {
    if (row.reachableCodePath && isTestPath(row.reachableCodePath)) {
      issues.push({
        code: "LEDGER_REACHABLE_PATH_IS_TEST",
        subject: row.requirementId,
        message: `reachableCodePath "${row.reachableCodePath}" is a test file; a reachable code path must be non-test production source or null`,
      });
    }
  }
  return issues;
}

function main(): void {
  const root = resolve(process.cwd());
  const ledgerPath = resolve(root, "docs", "PRODUCTION_CLOSURE_EXECUTION_LEDGER.json");
  if (!existsSync(ledgerPath)) {
    console.error("PRODUCTION CLOSURE EXECUTION LEDGER FAIL: committed ledger is missing");
    process.exit(1);
  }
  const ledger = buildExecutionLedger();
  const committedText = readFileSync(ledgerPath, "utf8");
  const issues = evaluateLedgerGate(committedText, ledger);
  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`${issue.code} ${issue.subject}: ${issue.message}`);
    }
    console.error(
      `PRODUCTION CLOSURE EXECUTION LEDGER FAIL: ${issues.length} issue${issues.length === 1 ? "" : "s"}`,
    );
    process.exit(1);
  }
  const nonNull = ledger.rows.filter((row) => row.reachableCodePath !== null).length;
  console.log(
    `PRODUCTION CLOSURE EXECUTION LEDGER PASS: ${ledger.requirementCount} rows match the committed artifact; ` +
      `${nonNull} carry a non-test reachableCodePath, ${ledger.requirementCount - nonNull} are null`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main();
}
