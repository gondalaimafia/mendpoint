import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@mendpoint/db";
import { runChangePipeline } from "@mendpoint/pipeline";
import { seedDatabase } from "./seed.js";

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  process.chdir(root);
  const demoDir = mkdtempSync(join(tmpdir(), "mendpoint-demo-"));
  const dbPath = join(demoDir, "mendpoint.sqlite");
  let db: ReturnType<typeof createDb> | undefined;

  try {
    seedDatabase({ dbPath, root });
    db = createDb(dbPath);
    const report = await runChangePipeline({
      tenantId: "tenant_default",
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
    for (const entry of report.diff.entries.slice(0, 8)) {
      console.log(
        `  - ${entry.op}${entry.path ? ` ${entry.path}` : ""}${entry.fromField ? ` ${entry.fromField} to ${entry.toField}` : ""}`,
      );
    }
    console.log("\nImpact pipeline (per consumer):");
    for (const consumer of report.consumers) {
      console.log(
        `  - ${consumer.name}: candidates=${consumer.candidates} confirmed=${consumer.confirmed} findings=${consumer.findings} confidence=${consumer.overallConfidence} to PR ${consumer.prStatus}${consumer.prUrl ? ` ${consumer.prUrl}` : ""}`,
      );
    }

    console.log(`\nReport written to ${join(outDir, "report.json")}`);
    console.log("=====================================\n");
  } finally {
    db?.raw.close();
    rmSync(demoDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
