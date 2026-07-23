/**
 * Design-partner eval runner — precision/recall of expected sites + migration edit score.
 */
import { normalizeChange } from "@mendpoint/change-intel";
import { analyzeImpact, reportToFindings } from "@mendpoint/code-impact";
import { generateMigration } from "@mendpoint/generation";
import type { ImpactableSurface } from "@mendpoint/shared";
import { readFileSync } from "node:fs";
import { loadOpenApiPair, PARTNER_CASES, type PartnerCase } from "./partners.js";

export type PartnerResult = {
  id: string;
  name: string;
  hit: number;
  expected: number;
  recall: number;
  findings: number;
  editedFiles: number;
  migrationOk: boolean;
  passed: boolean;
  misses: string[];
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
    id: `ev-${i}`,
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

async function runCase(c: PartnerCase): Promise<PartnerResult> {
  let surfaces: ImpactableSurface[];
  let change;
  if (c.kind === "openapi" && c.openapiDir) {
    const { v1, v2, notes } = loadOpenApiPair(c.openapiDir);
    const norm = normalizeChange(v1, v2, {
      providerSlug: "acme-payments",
      providerNotes: notes,
    });
    surfaces = norm.surfaces;
    change = norm.diff;
  } else if (c.eventPath) {
    surfaces = surfacesFromEvent(c.eventPath);
    change = {
      risk: "breaking" as const,
      summary: c.name,
      entries: surfaces.map((s) => ({
        op: s.op,
        path: s.path,
        method: s.method,
        field: s.field,
        fromField: s.fromField,
        toField: s.toField,
        breaking: s.severity === "breaking",
      })),
    };
  } else {
    throw new Error(`Invalid case ${c.id}`);
  }

  const impact = await analyzeImpact(c.consumerPath, surfaces, { persistIndex: false });
  const findings = reportToFindings(impact);
  const misses: string[] = [];
  let hit = 0;
  for (const exp of c.expected) {
    const ok = findings.some(
      (f) =>
        f.filePath.replace(/\\/g, "/").includes(exp.fileIncludes) &&
        (f.symbol.includes(exp.symbolIncludes) ||
          JSON.stringify(f).toLowerCase().includes(exp.symbolIncludes.toLowerCase())),
    );
    if (ok) hit++;
    else misses.push(`${exp.fileIncludes}:${exp.symbolIncludes}`);
  }
  const recall = c.expected.length ? hit / c.expected.length : 1;

  const draft = generateMigration({
    providerName: c.name,
    providerSlug: c.id,
    change,
    findings,
    repoRoot: c.consumerPath,
    impactReport: impact,
  });
  const editedFiles = draft.fileEdits.length;
  const minEdits = c.minEditedFiles ?? 0;
  const migrationOk = editedFiles >= minEdits;
  const passed = recall >= 0.7 && migrationOk;

  return {
    id: c.id,
    name: c.name,
    hit,
    expected: c.expected.length,
    recall,
    findings: findings.length,
    editedFiles,
    migrationOk,
    passed,
    misses,
  };
}

export async function runPartnerEval() {
  const results: PartnerResult[] = [];
  for (const c of PARTNER_CASES) {
    results.push(await runCase(c));
  }
  const overall =
    results.reduce((s, r) => s + r.recall, 0) / Math.max(results.length, 1);
  const passed = results.every((r) => r.passed);
  return {
    threshold: 0.7,
    overall,
    passed,
    partnerCount: results.length,
    results,
  };
}

async function main() {
  const report = await runPartnerEval();
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) {
    console.error(
      `Design-partner eval FAILED overall recall ${(report.overall * 100).toFixed(0)}%`,
    );
    process.exit(1);
  }
  console.log(
    `Design-partner eval PASS · ${report.partnerCount} partners · overall ${(report.overall * 100).toFixed(0)}%`,
  );
}

if (process.argv[1]?.includes("run.ts") || process.argv[1]?.includes("eval")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
