import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@mendpoint/db";
import { runChangePipeline } from "@mendpoint/pipeline";

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  process.chdir(root);

  await import("./seed.ts");

  const db = createDb(resolve(root, "data/mendpoint.sqlite"));
  const report = await runChangePipeline({
    providerSlug: "acme-payments",
    db,
  });

  const outDir = join(root, ".mendpoint/demo");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");

  console.log("\n========== Mendpoint Demo ==========");
  console.log(`Change ID:  ${report.changeId}`);
  console.log(`Risk:       ${report.risk}`);
  console.log(`Surfaces:   ${report.surfaces}`);
  console.log(`Summary:    ${report.summary}`);
  console.log(`Diff ops:   ${report.diff.entries.length}`);
  for (const e of report.diff.entries.slice(0, 8)) {
    console.log(
      `  - ${e.op}${e.path ? ` ${e.path}` : ""}${e.fromField ? ` ${e.fromField}→${e.toField}` : ""}`,
    );
  }
  console.log("\nImpact pipeline (per consumer):");
  for (const c of report.consumers) {
    console.log(
      `  - ${c.name}: candidates=${c.candidates} confirmed=${c.confirmed} findings=${c.findings} confidence=${c.overallConfidence} → PR ${c.prStatus}${c.prUrl ? ` ${c.prUrl}` : ""}`,
    );
  }

  console.log(`\nReport written to ${join(outDir, "report.json")}`);
  console.log("=====================================\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
