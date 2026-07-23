/**
 * Run all concrete API migration examples:
 * change event → surfaces → index → impact → e-graph notes → PR draft
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeImpact, reportToFindings } from "@mendpoint/code-impact";
import { generateMigration } from "@mendpoint/generation";
import { migrateFromFixHint, exploreMigration, app, lit } from "@mendpoint/egraph";
import { listExamples, loadExpectedPr } from "./load.js";
import { changeEventToDiff, changeEventToSurfaces } from "./surfaces.js";
import { generateExampleEdits, unifiedPatch, writeEdits } from "./migrate.js";

export type ExampleRunResult = {
  id: string;
  vendor: string;
  title: string;
  changeType: string;
  surfaces: number;
  findings: number;
  confidence: string;
  risk: string;
  files: string[];
  egraphNotes: string[];
  prTitle: string;
  prBody: string;
  patch: string;
  outDir: string;
};

async function runOne(exampleId?: string): Promise<ExampleRunResult[]> {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const outRoot = join(root, ".mendpoint", "example-runs");
  mkdirSync(outRoot, { recursive: true });

  const examples = listExamples().filter((e) => !exampleId || e.id === exampleId || e.id.startsWith(exampleId));
  if (!examples.length) {
    console.error("No examples found. Expected fixtures under fixtures/examples/");
    process.exit(1);
  }

  const results: ExampleRunResult[] = [];

  for (const ex of examples) {
    const ev = ex.changeEvent;
    const surfaces = changeEventToSurfaces(ev);
    const diff = changeEventToDiff(ev);

    const report = await analyzeImpact(ex.consumerPath, surfaces, {
      persistIndex: false,
      minConfidence: "medium",
    });

    const findings = reportToFindings(report);

    // Example-specific high-quality edits
    const edits = generateExampleEdits(ev, ex.consumerPath, findings);
    const patch = unifiedPatch(edits);

    // E-graph exploration on fix hints + field renames from ops
    const egraphNotes: string[] = [];
    for (const e of diff.entries) {
      if (e.op === "request_field_renamed" && e.fromField && e.toField) {
        const r = migrateFromFixHint(`${e.fromField} → ${e.toField}`);
        if (r) {
          egraphNotes.push(
            `field ${e.fromField}→${e.toField}: rules [${r.appliedRules.join(", ")}] → \`${r.extracted}\``,
          );
        }
      }
    }
    if (ev.searchTokens.includes("starting_after")) {
      const r = exploreMigration(app("paginate", lit("customers"), app("page", lit(1))));
      egraphNotes.push(`pagination explore: ${r.appliedRules.join(", ") || "no rules fired"}`);
    }

    const draft = generateMigration({
      providerName: ev.vendor,
      providerSlug: ev.vendor,
      change: diff,
      findings,
      repoRoot: ex.consumerPath,
      docsUrl: ev.docsUrl,
      impactReport: report,
      mode: ev.adoption || ev.type === "new_capability" ? "adopt" : "migrate",
    });

    // Enrich PR body with example narrative
    const expected = loadExpectedPr(ex.dir);
    const prBody = [
      draft.body,
      "",
      "### Concrete example notes",
      `- **Surface:** ${ev.surface}`,
      `- **SDK:** ${ev.sdkSurface ?? "—"}`,
      `- **Migration guide:** ${ev.migration}`,
      ev.adoption || ev.type === "new_capability"
        ? "- **Label:** optional improvement / feature adoption"
        : "- **Label:** required migration",
      "",
      "### E-graph rewrite exploration",
      ...(egraphNotes.length ? egraphNotes.map((n) => `- ${n}`) : ["- _(none)_"]),
      "",
      expected ? "### Expected PR sketch\n" + expected : "",
    ].join("\n");

    const runDir = join(outRoot, ex.id);
    mkdirSync(runDir, { recursive: true });
    writeEdits(join(runDir, "migrated"), edits);
    writeFileSync(join(runDir, "patch.diff"), patch || "# no textual edits generated\n", "utf8");
    writeFileSync(join(runDir, "pr.md"), `# ${draft.title}\n\n${prBody}\n`, "utf8");
    writeFileSync(
      join(runDir, "impact.json"),
      JSON.stringify(
        {
          event: ev.id,
          surfaces: surfaces.length,
          findings,
          report: {
            overallRisk: report.overallRisk,
            overallConfidence: report.overallConfidence,
            candidateCount: report.candidateCount,
            confirmedCount: report.confirmedCount,
            strategySummary: report.strategySummary,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result: ExampleRunResult = {
      id: ex.id,
      vendor: ev.vendor,
      title: ev.title,
      changeType: ev.type,
      surfaces: surfaces.length,
      findings: findings.length,
      confidence: report.overallConfidence,
      risk: report.overallRisk,
      files: [...new Set(findings.map((f) => f.filePath))],
      egraphNotes,
      prTitle: draft.title,
      prBody,
      patch,
      outDir: runDir,
    };
    results.push(result);

    console.log("\n" + "=".repeat(72));
    console.log(`EXAMPLE ${ex.id}`);
    console.log(`${ev.vendor} · ${ev.type} · ${ev.title}`);
    console.log("-".repeat(72));
    console.log(`Surfaces:    ${result.surfaces}`);
    console.log(`Findings:    ${result.findings} (${result.confidence} confidence, risk=${result.risk})`);
    console.log(`Files:       ${result.files.join(", ") || "—"}`);
    console.log(`Edits:       ${edits.length} file(s)`);
    console.log(`Output:      ${runDir}`);
    if (findings.length) {
      console.log("Top findings:");
      for (const f of findings.slice(0, 6)) {
        console.log(`  · ${f.filePath}:${f.lineStart} ${f.symbol} [${f.confidence}]`);
      }
    }
  }

  const summaryPath = join(outRoot, "SUMMARY.json");
  writeFileSync(
    summaryPath,
    JSON.stringify(
      results.map((r) => ({
        id: r.id,
        vendor: r.vendor,
        title: r.title,
        changeType: r.changeType,
        findings: r.findings,
        confidence: r.confidence,
        files: r.files,
        outDir: r.outDir,
      })),
      null,
      2,
    ),
    "utf8",
  );
  console.log("\n" + "=".repeat(72));
  console.log(`Ran ${results.length} example(s). Summary → ${summaryPath}`);
  return results;
}

const filter = process.argv[2];
runOne(filter).catch((e) => {
  console.error(e);
  process.exit(1);
});
