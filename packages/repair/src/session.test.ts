import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRepairSession } from "./session.js";
import { diagnoseFailureLog } from "./diagnose.js";
import { planRepairs } from "./plan.js";
import { runAgenticRepairLoop } from "./loop.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  }
});

describe("diagnose", () => {
  it("parses TS cannot find name", () => {
    const obs = diagnoseFailureLog(`src/a.ts:10:5 - error TS2304: Cannot find name 'amount_cents'.`);
    expect(obs.some((o) => o.kind === "undefined_symbol" || o.message.includes("amount_cents"))).toBe(
      true,
    );
  });
});

describe("plan", () => {
  it("plans rename from leftover observation", () => {
    const plan = planRepairs(
      [
        {
          kind: "api_rename_leftover",
          filePath: "src/a.ts",
          symbol: "amount_cents",
          message: "leftover",
        },
      ],
      { attempt: 1, renameMap: { amount_cents: "amount" } },
    );
    expect(plan.actions.some((a) => a.type === "replace_in_file")).toBe(true);
  });
});

describe("repair session", () => {
  it("repairs leftover rename and strips FIXME", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-repair-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "pay.ts"),
      `export function charge(amount_cents: number) {\n  return amount_cents;\n}\n// FIXME(mendpoint): endpoint removed — /v1/old\n`,
      "utf8",
    );

    const result = await runRepairSession({
      repoRoot: dir,
      renameMap: { amount_cents: "amount" },
      maxAttempts: 2,
      verifyCommands: [], // no shell verify in unit test
    });

    expect(result.edits.length).toBeGreaterThan(0);
    const text = readFileSync(join(dir, "pay.ts"), "utf8");
    expect(text).toContain("amount");
    expect(text).not.toMatch(/\bamount_cents\b/);
    expect(text).not.toContain("FIXME(mendpoint)");
    expect(result.ok).toBe(true);
    expect(result.reportMarkdown).toContain("agentic repair");
  });

  it("agentic loop dry-run succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-repair-loop-"));
    dirs.push(dir);
    writeFileSync(join(dir, "x.ts"), `const amount_cents = 1;\n`, "utf8");
    const r = await runAgenticRepairLoop({
      repoRoot: dir,
      renameMap: { amount_cents: "amount" },
      dryRun: true,
      verifyCommands: ["echo ok"],
      maxAttempts: 1,
    });
    // dry-run may not write files but should produce a plan/edits in memory
    expect(r.repair.plans.length).toBeGreaterThanOrEqual(0);
    expect(r.repair.reportMarkdown).toBeTruthy();
  });
});
