/**
 * Phase C — Python quality bar (same ≥70% expected-site recall as TS harness).
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
    id: `py-${i}`,
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
    id: "openai-python",
    consumerPath: join(root, "fixtures/examples/02-openai-chat/consumer"),
    eventPath: join(root, "fixtures/examples/02-openai-chat/change-event.json"),
    expected: [
      { fileIncludes: "llm_client.py", symbolIncludes: "max_tokens" },
      { fileIncludes: "llm_client.py", symbolIncludes: "chat.completions" },
    ],
  },
];

export async function runPythonHarness() {
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
    const report = await analyzeImpact(c.consumerPath, surfaces, {
      minConfidence: "medium",
      persistIndex: false,
    });
    const findings = reportToFindings(report);
    let hit = 0;
    const misses: string[] = [];
    for (const exp of c.expected) {
      const ok = findings.some(
        (f) =>
          f.filePath.includes(exp.fileIncludes) &&
          (f.symbol.includes(exp.symbolIncludes) || f.evidence.includes(exp.symbolIncludes)),
      );
      if (ok) hit++;
      else misses.push(`${exp.fileIncludes}::${exp.symbolIncludes}`);
    }
    const recall = c.expected.length ? hit / c.expected.length : 1;
    results.push({
      id: c.id,
      hit,
      expected: c.expected.length,
      recall,
      passed: recall >= threshold,
      misses,
    });
  }

  const overall =
    results.reduce((s, r) => s + r.hit, 0) /
    Math.max(1, results.reduce((s, r) => s + r.expected, 0));

  return {
    results,
    overallRecall: overall,
    passed: overall >= threshold,
    threshold,
  };
}

async function main() {
  const report = await runPythonHarness();
  console.log("\n========== Phase C Python Quality Harness ==========");
  for (const r of report.results) {
    console.log(
      `${r.passed ? "PASS" : "FAIL"}  ${r.id}: ${(r.recall * 100).toFixed(0)}% (${r.hit}/${r.expected})`,
    );
    if (r.misses.length) console.log(`       misses: ${r.misses.join(", ")}`);
  }
  console.log(
    `\nOverall: ${(report.overallRecall * 100).toFixed(1)}% · ${report.passed ? "HARNESS PASS" : "HARNESS FAIL"}`,
  );
  console.log("====================================================\n");
  process.exit(report.passed ? 0 : 2);
}

if (process.argv[1]?.includes("harness-python")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
