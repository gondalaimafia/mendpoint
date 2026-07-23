/**
 * Phase E — Ruby quality bar (≥70% expected-site recall).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeImpact, reportToFindings } from "@mendpoint/code-impact";
import type { ImpactableSurface } from "@mendpoint/shared";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

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
    id: `ruby-${i}`,
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
    severity: (o.breaking ? "breaking" : "non_breaking") as ImpactableSurface["severity"],
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

export async function runRubyHarness() {
  const threshold = 0.7;
  const expected = [
    { fileIncludes: "billing.rb", symbolIncludes: "starting_after" },
    { fileIncludes: "billing.rb", symbolIncludes: "Customer.list" },
  ];
  const surfaces = surfacesFromEvent(
    join(root, "fixtures/examples/08-ruby-stripe/change-event.json"),
  );
  const impact = await analyzeImpact(
    join(root, "fixtures/examples/08-ruby-stripe/consumer"),
    surfaces,
    { persistIndex: false },
  );
  const findings = reportToFindings(impact);
  const misses: string[] = [];
  let hit = 0;
  for (const exp of expected) {
    const ok = findings.some(
      (f) =>
        f.filePath.replace(/\\/g, "/").includes(exp.fileIncludes) &&
        (f.symbol.includes(exp.symbolIncludes) ||
          JSON.stringify(f).includes(exp.symbolIncludes)),
    );
    if (ok) hit++;
    else misses.push(`${exp.fileIncludes}:${exp.symbolIncludes}`);
  }
  const recall = hit / expected.length;
  return {
    threshold,
    overall: recall,
    passed: recall >= threshold,
    results: [
      {
        id: "stripe-ruby-pagination",
        hit,
        expected: expected.length,
        recall,
        passed: recall >= threshold,
        misses,
      },
    ],
  };
}

async function main() {
  const report = await runRubyHarness();
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) {
    console.error(`Ruby harness FAILED (overall recall ${(report.overall * 100).toFixed(0)}%)`);
    process.exit(1);
  }
  console.log(`Ruby harness PASS overall recall ${(report.overall * 100).toFixed(0)}%`);
}

if (process.argv[1]?.includes("harness-ruby")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
