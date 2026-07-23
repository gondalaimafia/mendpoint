import { mkdtempSync, cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runApiBugAgent } from "./agent.js";
import { extractHints, extractRenames, extractApiPaths } from "./heuristics.js";
import { pathBlocked, commandBlocked } from "./policies.js";
import { executeTool, type ToolContext } from "./tools.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
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

describe("heuristics", () => {
  it("extracts API hints from goal", () => {
    const h = extractHints("fix amount_cents rename and 404 on charges");
    expect(h.some((x) => /amount|charges/i.test(x))).toBe(true);
  });

  it("parses rename and path tokens", () => {
    const renames = extractRenames("rename amount_cents to amount and max_tokens → max_completion_tokens");
    expect(renames.some((r) => r.from === "amount_cents" && r.to === "amount")).toBe(true);
    expect(extractApiPaths("GET /v1/chargess returned 404")).toContain("/v1/chargess");
  });
});

describe("policies", () => {
  it("blocks secrets and dangerous commands", () => {
    expect(pathBlocked(".env")).toBe(true);
    expect(pathBlocked("src/client.ts")).toBe(false);
    expect(commandBlocked("rm -rf /")).toBe(true);
    expect(commandBlocked("node check.mjs")).toBe(false);
  });
});

describe("tools sandbox", () => {
  it("refuses path escape and blocks write to .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-agent-tools-"));
    dirs.push(dir);
    writeFileSync(join(dir, "ok.js"), "export const x = 1;\n");
    const ctx: ToolContext = {
      repoRoot: dir,
      changedFiles: new Set(),
    };
    const escape = executeTool(ctx, {
      tool: "read_file",
      args: { path: "../outside.js" },
    });
    expect(escape.ok).toBe(false);
    const envWrite = executeTool(ctx, {
      tool: "write_file",
      args: { path: ".env", content: "SECRET=1" },
    });
    expect(envWrite.ok).toBe(false);
  });
});

describe("api bug agent", () => {
  it("fixes path typo and amount_cents on fixture", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-agent-"));
    dirs.push(dir);
    const fixture = join(root, "fixtures/agent-bugs/broken-charges");
    cpSync(join(fixture, "client.js"), join(dir, "client.js"));
    cpSync(join(fixture, "check.mjs"), join(dir, "check.mjs"));

    const result = await runApiBugAgent({
      goal: "API returns 404: path typo chargess. Also rename amount_cents to amount for the charges API.",
      repoRoot: dir,
      verifyCommand: "node check.mjs",
      maxSteps: 16,
      errorLog: "HTTP 404 Not Found /v1/chargess\nerror: amount_cents is not allowed",
    });

    const src = readFileSync(join(dir, "client.js"), "utf8");
    expect(src).not.toContain("chargess");
    expect(src).toContain("/v1/charges");
    expect(src).not.toMatch(/\bamount_cents\b/);
    expect(src).toContain("amount");
    expect(result.ok).toBe(true);
    expect(result.filesChanged.length).toBeGreaterThan(0);
    expect(result.reportMarkdown).toContain("API Bug Agent");
  }, 60_000);

  it("fixes rename-only goal without canned amount_cents special-case text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-agent-rename-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "sdk.js"),
      `export const payload = { max_tokens: 100, model: "x" };\n`,
    );
    writeFileSync(
      join(dir, "check.mjs"),
      `import { readFileSync } from "fs";
const s = readFileSync("sdk.js","utf8");
if (s.includes("max_tokens") && !s.includes("max_completion_tokens")) process.exit(1);
if (!s.includes("max_completion_tokens")) process.exit(1);
console.log("ok");
`,
    );
    const result = await runApiBugAgent({
      goal: "rename max_tokens to max_completion_tokens (deprecated OpenAI field)",
      repoRoot: dir,
      verifyCommand: "node check.mjs",
      maxSteps: 12,
      errorLog: "Warning: max_tokens is deprecated; use max_completion_tokens",
    });
    const src = readFileSync(join(dir, "sdk.js"), "utf8");
    expect(src).toContain("max_completion_tokens");
    expect(src).not.toMatch(/\bmax_tokens\b/);
    expect(result.ok).toBe(true);
  }, 60_000);

  it("reports already passing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-agent-ok-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "client.js"),
      `export const url = "/v1/charges";\nexport const body = { amount: 1 };\n`,
    );
    writeFileSync(
      join(dir, "check.mjs"),
      `import { readFileSync } from "fs";\nconst s=readFileSync("client.js","utf8");\nif(s.includes("chargess")||/amount_cents/.test(s)) process.exit(1);\nconsole.log("ok");\n`,
    );
    const result = await runApiBugAgent({
      goal: "ensure charges client is correct",
      repoRoot: dir,
      verifyCommand: "node check.mjs",
      maxSteps: 5,
    });
    expect(result.ok).toBe(true);
    expect(result.stoppedReason).toMatch(/already_passing|verify/);
  });
});
