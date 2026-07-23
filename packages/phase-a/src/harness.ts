/**
 * Phase A quality harness — TypeScript only.
 *
 * Scores high-confidence impact findings against expected symbols/files
 * on three sample consumers. Target: ≥70% recall of high-confidence expected sites.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeImpact, reportToFindings } from "@mendpoint/code-impact";
import { normalizeChange } from "@mendpoint/change-intel";
import type { ImpactableSurface } from "@mendpoint/shared";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

type Case = {
  id: string;
  consumerPath: string;
  /** Load OpenAPI pair from Acme fixtures, or synthetic surfaces */
  mode: "openapi" | "event";
  eventPath?: string;
  expectedHigh: Array<{ fileIncludes: string; symbolIncludes: string }>;
};

function surfacesFromAcme(): { surfaces: ImpactableSurface[] } {
  const provider = join(root, "fixtures/providers/acme-payments");
  const v1 = JSON.parse(readFileSync(join(provider, "openapi-v1.json"), "utf8"));
  const v2 = JSON.parse(readFileSync(join(provider, "openapi-v2.json"), "utf8"));
  const { surfaces } = normalizeChange(v1, v2, {
    providerSlug: "acme-payments",
    providerNotes: readFileSync(join(provider, "changelog.md"), "utf8"),
  });
  return { surfaces };
}

function surfacesFromEvent(path: string): { surfaces: ImpactableSurface[] } {
  const ev = JSON.parse(readFileSync(path, "utf8")) as {
    vendor: string;
    type: string;
    title: string;
    description: string;
    migration: string;
    searchTokens: string[];
    ops: Array<Record<string, unknown>>;
  };
  const surfaces: ImpactableSurface[] = ev.ops.map((o, i) => ({
    id: `ev-${i}-${ev.vendor}`,
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
  return { surfaces };
}


const CASES: Case[] = [
  {
    id: "phase-a-consumer",
    consumerPath: join(root, "packages/phase-a/consumer"),
    mode: "openapi",
    expectedHigh: [
      { fileIncludes: "payments.ts", symbolIncludes: "amount_cents" },
      { fileIncludes: "payments.ts", symbolIncludes: "charges" },
      { fileIncludes: "payments.ts", symbolIncludes: "receipt" },
    ],
  },
  {
    id: "shop-app",
    consumerPath: join(root, "fixtures/consumers/shop-app"),
    mode: "openapi",
    expectedHigh: [
      { fileIncludes: "payments.ts", symbolIncludes: "amount_cents" },
      { fileIncludes: "payments.ts", symbolIncludes: "receipt" },
    ],
  },
  {
    id: "fintech-transfers",
    consumerPath: join(root, "fixtures/examples/04-fintech-transfers/consumer"),
    mode: "event",
    eventPath: join(root, "fixtures/examples/04-fintech-transfers/change-event.json"),
    expectedHigh: [
      { fileIncludes: "transfers.ts", symbolIncludes: "/v2/transfers" },
    ],
  },
];

export type HarnessResult = {
  id: string;
  expected: number;
  hit: number;
  recall: number;
  highConfidenceFindings: number;
  passed: boolean;
  misses: string[];
};

export async function runHarness(): Promise<{
  results: HarnessResult[];
  overallRecall: number;
  passed: boolean;
  threshold: number;
}> {
  const threshold = 0.7;
  const results: HarnessResult[] = [];

  for (const c of CASES) {
    const { surfaces } =
      c.mode === "openapi"
        ? surfacesFromAcme()
        : surfacesFromEvent(c.eventPath!);

    const report = await analyzeImpact(c.consumerPath, surfaces, {
      minConfidence: "medium",
      persistIndex: false,
    });
    const findings = reportToFindings(report);
    const high = findings.filter((f) => f.confidence === "high" || f.confidence === "medium");

    let hit = 0;
    const misses: string[] = [];
    for (const exp of c.expectedHigh) {
      const ok = high.some(
        (f) =>
          f.filePath.includes(exp.fileIncludes) &&
          (f.symbol.includes(exp.symbolIncludes) ||
            f.evidence.includes(exp.symbolIncludes)),
      );
      if (ok) hit++;
      else misses.push(`${exp.fileIncludes}::${exp.symbolIncludes}`);
    }
    const recall = c.expectedHigh.length ? hit / c.expectedHigh.length : 1;
    results.push({
      id: c.id,
      expected: c.expectedHigh.length,
      hit,
      recall,
      highConfidenceFindings: high.length,
      passed: recall >= threshold,
      misses,
    });
  }

  const overallRecall =
    results.reduce((s, r) => s + r.hit, 0) /
    Math.max(1, results.reduce((s, r) => s + r.expected, 0));

  return {
    results,
    overallRecall,
    passed: overallRecall >= threshold && results.every((r) => r.passed || r.recall >= 0.5),
    threshold,
  };
}

async function main() {
  const report = await runHarness();
  console.log("\n========== Phase A Quality Harness (TypeScript) ==========");
  console.log(`Threshold: ≥${(report.threshold * 100).toFixed(0)}% expected-site recall\n`);
  for (const r of report.results) {
    console.log(
      `${r.passed ? "PASS" : "FAIL"}  ${r.id}: ${(r.recall * 100).toFixed(0)}% (${r.hit}/${r.expected}) · findings=${r.highConfidenceFindings}`,
    );
    if (r.misses.length) console.log(`       misses: ${r.misses.join(", ")}`);
  }
  console.log(
    `\nOverall recall: ${(report.overallRecall * 100).toFixed(1)}% · ${report.passed ? "HARNESS PASS" : "HARNESS FAIL"}`,
  );
  console.log("==========================================================\n");
  process.exit(report.passed ? 0 : 2);
}

// only run CLI when executed directly
const isMain =
  process.argv[1] &&
  (process.argv[1].includes("harness") || process.argv[1].endsWith("harness.ts"));
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
