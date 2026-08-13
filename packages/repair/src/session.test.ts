import {
  mkdtempSync,
  existsSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRepairSession } from "./session.js";
import { diagnoseFailureLog } from "./diagnose.js";
import { planRepairs } from "./plan.js";
import { runAgenticRepairLoop } from "./loop.js";
import {
  discoverVerificationCommands,
  parseVerificationCommand,
  runVerificationCommand,
} from "./verify.js";
import { applyActions, RepairPolicyError } from "./apply.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
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

  it("does not remove a FIXME without a grounded repair", () => {
    const plan = planRepairs(
      [
        {
          kind: "fixme_mendpoint",
          filePath: "src/a.ts",
          message: "endpoint migration remains",
        },
      ],
      { attempt: 1 },
    );
    expect(plan.actions).toEqual([]);
  });
});

describe("repair session", () => {
  it("repairs a leftover rename and retains one pristine edit per file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-repair-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "pay.ts"),
      "export function charge(amount_cents: number, fee_cents: number) {\n  return amount_cents + fee_cents;\n}\n",
      "utf8",
    );
    writeFileSync(join(dir, "check.mjs"), "console.log('ok')\n", "utf8");
    const original = readFileSync(join(dir, "pay.ts"), "utf8");

    const result = await runRepairSession({
      repoRoot: dir,
      renameMap: { amount_cents: "amount", fee_cents: "fee" },
      maxAttempts: 2,
      verifyCommands: ["node check.mjs"],
    });

    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]?.original).toBe(original);
    const text = readFileSync(join(dir, "pay.ts"), "utf8");
    expect(text).toContain("amount");
    expect(text).not.toMatch(/\bamount_cents\b/);
    expect(text).not.toMatch(/\bfee_cents\b/);
    expect(result.ok).toBe(true);
    expect(result.simulated).toBe(false);
    expect(result.stopReason).toBe("verified");
    expect(result.failureFingerprints).toHaveLength(1);
    expect(result.actionFingerprints).toHaveLength(1);
    expect(result.reportMarkdown).toContain("agentic repair");
  });

  it("fails closed when no verification command profile is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-repair-no-verify-"));
    dirs.push(dir);
    writeFileSync(join(dir, "pay.ts"), "export const amount = 1;\n", "utf8");

    const result = await runRepairSession({
      repoRoot: dir,
      verifyCommands: [],
      maxAttempts: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.simulated).toBe(false);
    expect(result.finalVerify?.output).toContain("failed closed");
  });

  it("marks a dry run as simulated and never claims verification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-repair-loop-"));
    dirs.push(dir);
    writeFileSync(join(dir, "x.ts"), `const amount_cents = 1;\n`, "utf8");
    writeFileSync(join(dir, "check.mjs"), "console.log('ok')\n", "utf8");
    const r = await runAgenticRepairLoop({
      repoRoot: dir,
      renameMap: { amount_cents: "amount" },
      dryRun: true,
      verifyCommands: ["node check.mjs"],
      maxAttempts: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.repair.ok).toBe(false);
    expect(r.repair.simulated).toBe(true);
    expect(r.repair.stopReason).toBe("simulated");
    expect(r.repair.finalVerify?.ok).toBe(false);
    expect(r.repair.reportMarkdown).toContain("SIMULATED");
    expect(readFileSync(join(dir, "x.ts"), "utf8")).toContain("amount_cents");
  });

  it("hard-clamps the configured attempt budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-repair-attempts-"));
    dirs.push(dir);
    writeFileSync(join(dir, "x.ts"), "export const value = 1;\n", "utf8");

    const result = await runRepairSession({
      repoRoot: dir,
      verifyCommands: [],
      maxAttempts: 10_000,
    });

    expect(result.maxAttempts).toBe(5);
    expect(result.ok).toBe(false);
  });

  it("rolls back the complete session when verification never succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-repair-rollback-"));
    dirs.push(dir);
    const source = join(dir, "x.ts");
    const original = "export const total = amount_cents + fee_cents;\n";
    writeFileSync(source, original, "utf8");
    writeFileSync(join(dir, "check.mjs"), "process.exit(1)\n", "utf8");

    const result = await runRepairSession({
      repoRoot: dir,
      renameMap: { amount_cents: "amount", fee_cents: "fee" },
      verifyCommands: ["node check.mjs"],
      maxAttempts: 5,
    });

    expect(result.ok).toBe(false);
    expect(["no_actions", "no_edits", "repeated_actions", "repeated_failure"]).toContain(
      result.stopReason,
    );
    expect(result.edits).toEqual([]);
    expect(readFileSync(source, "utf8")).toBe(original);
  });

  it("refreshes LLM file slices after each attempted edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-repair-refresh-"));
    dirs.push(dir);
    writeFileSync(join(dir, "x.ts"), "export const value = old;\n", "utf8");
    writeFileSync(
      join(dir, "check.mjs"),
      [
        'import { readFileSync } from "node:fs";',
        'const source = readFileSync(new URL("./x.ts", import.meta.url), "utf8");',
        'if (source.includes("done")) process.exit(0);',
        'const symbol = source.includes("old") ? "old" : "next";',
        "console.error(\"x.ts:1:1 - error TS2304: Cannot find name '\" + symbol + \"'.\");",
        "process.exit(1);",
      ].join("\n"),
      "utf8",
    );
    const slices: string[] = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          messages: Array<{ content: string }>;
        };
        const prompt = JSON.parse(request.messages[1]!.content) as {
          slices: Array<{ content: string }>;
        };
        slices.push(prompt.slices[0]?.content ?? "");
        const from = call++ === 0 ? "old" : "next";
        const to = from === "old" ? "next" : "done";
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    actions: [
                      {
                        type: "replace_in_file",
                        filePath: "x.ts",
                        from,
                        to,
                        global: true,
                        reason: "grounded test repair",
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        } as Response;
      }),
    );
    const priorRepairUrl = process.env.LLM_REPAIR_URL;
    const priorApiKey = process.env.OPENAI_API_KEY;
    process.env.LLM_REPAIR_URL = "https://repair.invalid/v1";
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const result = await runRepairSession({
        repoRoot: dir,
        verifyCommands: ["node check.mjs"],
        useLlm: true,
        maxAttempts: 3,
      });
      expect(result.ok).toBe(true);
      expect(slices).toHaveLength(2);
      expect(slices[0]).toContain("old");
      expect(slices[1]).toContain("next");
      expect(readFileSync(join(dir, "x.ts"), "utf8")).toContain("done");
    } finally {
      if (priorRepairUrl === undefined) delete process.env.LLM_REPAIR_URL;
      else process.env.LLM_REPAIR_URL = priorRepairUrl;
      if (priorApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorApiKey;
    }
  });

  it("rejects arbitrary shell commands and runs supported verification profiles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-repair-verify-"));
    dirs.push(dir);
    writeFileSync(join(dir, "check.mjs"), "console.log('ok')\n", "utf8");

    expect(parseVerificationCommand("node check.mjs", dir)?.profile).toBe("node-check");
    expect((await runVerificationCommand("node check.mjs", dir)).ok).toBe(true);
    expect(parseVerificationCommand("node -e process.exit(0)", dir)).toBeUndefined();
    expect(parseVerificationCommand("npm test && whoami", dir)).toBeUndefined();
    expect(await runVerificationCommand("whoami", dir)).toMatchObject({
      ok: false,
      exitCode: 126,
    });
  });

  it("terminates a verifier promptly when its lease signal is aborted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-repair-verify-abort-"));
    dirs.push(dir);
    writeFileSync(join(dir, "check.mjs"), "setTimeout(() => {}, 5000)\n", "utf8");
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort("lease_lost"), 10);

    const result = await runVerificationCommand("node check.mjs", dir, 10_000, controller.signal);

    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("discovers bounded repository verification profiles", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-repair-discovery-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck: "tsc --noEmit",
          test: "vitest run",
          build: "tsc",
          deploy: "forbidden",
        },
      }),
    );

    expect(discoverVerificationCommands(dir)).toEqual([
      "npm run typecheck",
      "npm test",
      "npm build",
    ]);
  });

  it("blocks customer npm scripts in production without an operator override", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-repair-production-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node -e \"require('node:fs').writeFileSync('escaped.txt','bad')\"",
        },
      }),
    );
    const priorNodeEnv = process.env.NODE_ENV;
    const priorOverride = process.env.MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION;
    const priorVerifierHashes = process.env.MENDPOINT_APPROVED_VERIFIER_SHA256S;
    process.env.NODE_ENV = "production";
    delete process.env.MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION;
    delete process.env.MENDPOINT_APPROVED_VERIFIER_SHA256S;
    try {
      await expect(runVerificationCommand("npm test", dir)).resolves.toMatchObject({
        ok: false,
        exitCode: 126,
      });
      expect(existsSync(join(dir, "escaped.txt"))).toBe(false);
      const verifierSource = "console.log('approved')\n";
      writeFileSync(join(dir, "check.mjs"), verifierSource, "utf8");
      await expect(
        runVerificationCommand("node check.mjs", dir),
      ).resolves.toMatchObject({ ok: false, exitCode: 126 });
      process.env.MENDPOINT_APPROVED_VERIFIER_SHA256S = createHash("sha256")
        .update(verifierSource)
        .digest("hex");
      await expect(
        runVerificationCommand("node check.mjs", dir),
      ).resolves.toMatchObject({ ok: true, exitCode: 0 });
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
      if (priorOverride === undefined) {
        delete process.env.MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION;
      } else {
        process.env.MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION = priorOverride;
      }
      if (priorVerifierHashes === undefined) {
        delete process.env.MENDPOINT_APPROVED_VERIFIER_SHA256S;
      } else {
        process.env.MENDPOINT_APPROVED_VERIFIER_SHA256S = priorVerifierHashes;
      }
    }
  });
});

describe("repair filesystem policy", () => {
  it("rejects path traversal before writing", () => {
    const repo = mkdtempSync(join(tmpdir(), "mendpoint-repair-contained-"));
    const outside = mkdtempSync(join(tmpdir(), "mendpoint-repair-outside-"));
    dirs.push(repo, outside);
    const outsideFile = join(outside, "outside.ts");
    writeFileSync(outsideFile, "safe\n", "utf8");

    expect(() =>
      applyActions(
        [
          {
            type: "write_file",
            filePath: `../${outside.split(/[\\/]/).pop()}/outside.ts`,
            content: "changed\n",
            reason: "escape",
          },
        ],
        { repoRoot: repo },
      ),
    ).toThrow(RepairPolicyError);
    expect(readFileSync(outsideFile, "utf8")).toBe("safe\n");
  });

  it("rejects a symbolic link in an action path", () => {
    const repo = mkdtempSync(join(tmpdir(), "mendpoint-repair-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "mendpoint-repair-link-target-"));
    dirs.push(repo, outside);
    writeFileSync(join(outside, "outside.ts"), "safe\n", "utf8");
    const link = join(repo, "linked");
    try {
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    expect(() =>
      applyActions(
        [
          {
            type: "replace_in_file",
            filePath: "linked/outside.ts",
            from: "safe",
            to: "changed",
            reason: "linked edit",
          },
        ],
        { repoRoot: repo },
      ),
    ).toThrow(/symbolic link/);
    expect(readFileSync(join(outside, "outside.ts"), "utf8")).toBe("safe\n");
  });

  it("rejects action and file budgets before retaining writes", () => {
    const repo = mkdtempSync(join(tmpdir(), "mendpoint-repair-budget-"));
    dirs.push(repo);
    writeFileSync(join(repo, "a.ts"), "const old = 1;\n", "utf8");
    writeFileSync(join(repo, "b.ts"), "const old = 2;\n", "utf8");
    const actions = [
      {
        type: "replace_in_file" as const,
        filePath: "a.ts",
        from: "old",
        to: "next",
        reason: "first",
      },
      {
        type: "replace_in_file" as const,
        filePath: "b.ts",
        from: "old",
        to: "next",
        reason: "second",
      },
    ];

    expect(() =>
      applyActions(actions, { repoRoot: repo, maxActions: 1 }),
    ).toThrow(/action budget/);
    expect(() =>
      applyActions(actions, {
        repoRoot: repo,
        maxActions: 2,
        maxFilesChanged: 1,
      }),
    ).toThrow(/file budget/);
    expect(readFileSync(join(repo, "a.ts"), "utf8")).toContain("old");
    expect(readFileSync(join(repo, "b.ts"), "utf8")).toContain("old");
  });
});
