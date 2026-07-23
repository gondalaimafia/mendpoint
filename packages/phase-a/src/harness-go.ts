/**
 * Phase D — Go quality bar (≥70% expected-site recall on Go fixture).
 * Uses the same text/index impact path as TS/Python (Go parsed as source text).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeImpact, reportToFindings } from "@mendpoint/code-impact";
import type { ImpactableSurface } from "@mendpoint/shared";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

type Case = {
  id: string;
  consumerPath: string;
  eventPath: string;
  expected: Array<{ fileIncludes: string; symbolIncludes: string }>;
};

function surfacesFromEvent(path: string): ImpactableSurface[] {
  const ev = JSON.parse(readFileSync(path, "utf8")) as {
    vendor: string;
    type: string;
    description: string;
    migration: string;
    searchTokens: string[];
    ops: Array<Record<string, unknown>>;
  };
  return ev.ops.map((o, i) => ({
    id: `go-${i}`,
    canonicalId: `${ev.vendor}.${String(o.op)}.${i}`,
    kind: String(o.op).includes("field")
      ? "request_field"
      : String(o.path ?? "").startsWith("/")
        ? "http_path"
        : "sdk_method",
    op: o.op as ImpactableSurface["op"],
    path: o.path as string | undefined,
    method: o.method as string | undefined,
    field: o.field as string | undefined,
    fromField: o.fromField as string | undefined,
    toField: o.toField as string | undefined,
    severity: (o.breaking
      ? "breaking"
      : ev.type === "new_capability"
        ? "new_capability"
        : "non_breaking") as ImpactableSurface["severity"],
    migrationStrategy: String(o.detail ?? ev.migration),
    explanation: ev.description,
    searchTokens: [
      ...ev.searchTokens,
      o.path,
      o.field,
      o.fromField,
      o.toField,
    ].filter(Boolean) as string[],
  }));
}

const CASES: Case[] = [
  {
    id: "stripe-go-pagination",
    consumerPath: join(root, "fixtures/examples/06-go-stripe/consumer"),
    eventPath: join(root, "fixtures/examples/06-go-stripe/change-event.json"),
    expected: [
      { fileIncludes: "billing.go", symbolIncludes: "StartingAfter" },
      { fileIncludes: "billing.go", symbolIncludes: "CustomerListParams" },
    ],
  },
];

export async function runGoHarness() {
  const threshold = 0.7;
  const results: Array<{
    id: string;
    hit: number;
    expected: number;
    recall: number;
    passed: boolean;
    misses: string[];
  }> = [];

  for (const c of CASES) {
    const surfaces = surfacesFromEvent(c.eventPath);
    const impact = await analyzeImpact(c.consumerPath, surfaces, { persistIndex: false });
    const findings = reportToFindings(impact);
    const hits = new Set<string>();
    const misses: string[] = [];

    for (const exp of c.expected) {
      const ok = findings.some(
        (f) =>
          f.filePath.replace(/\\/g, "/").includes(exp.fileIncludes) &&
          (f.symbol.includes(exp.symbolIncludes) ||
            JSON.stringify(f).includes(exp.symbolIncludes)),
      );
      const key = `${exp.fileIncludes}:${exp.symbolIncludes}`;
      if (ok) hits.add(key);
      else misses.push(key);
    }

    const recall = c.expected.length ? hits.size / c.expected.length : 1;
    results.push({
      id: c.id,
      hit: hits.size,
      expected: c.expected.length,
      recall,
      passed: recall >= threshold,
      misses,
    });
  }

  const overall =
    results.reduce((s, r) => s + r.recall, 0) / Math.max(results.length, 1);
  const passed = results.every((r) => r.passed);
  return { threshold, overall, passed, results };
}

async function main() {
  const report = await runGoHarness();
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) {
    console.error(`Go harness FAILED (overall recall ${(report.overall * 100).toFixed(0)}%)`);
    process.exit(1);
  }
  console.log(`Go harness PASS overall recall ${(report.overall * 100).toFixed(0)}%`);
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("harness-go.ts") || process.argv[1].includes("harness-go"));
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
