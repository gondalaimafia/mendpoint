/**
 * Demo: Warden (API debug agent) on fixtures/agent-bugs/broken-charges
 *
 *   npm run agent:demo
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWarden } from "@mendpoint/agent";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "fixtures/agent-bugs/broken-charges");

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-agent-demo-"));
  try {
    cpSync(join(fixture, "client.js"), join(dir, "client.js"));
    cpSync(join(fixture, "check.mjs"), join(dir, "check.mjs"));

    console.log("Repo:", dir);
    console.log("Before:\n", readFileSync(join(dir, "client.js"), "utf8"));

    const result = await runWarden({
      goal: "Fix API 404 path typo chargess. Rename amount_cents to amount for charges API.",
      repoRoot: dir,
      verifyCommand: "node check.mjs",
      errorLog: "HTTP 404 /v1/chargess\nerror: amount_cents is not allowed",
      maxSteps: 16,
    });

    console.log("\n--- Report ---\n");
    console.log(result.reportMarkdown);
    console.log("\nAfter:\n", readFileSync(join(dir, "client.js"), "utf8"));
    console.log(
      `\nok=${result.ok} steps=${result.steps.length} stopped=${result.stoppedReason}`,
    );
    process.exit(result.ok ? 0 : 1);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
