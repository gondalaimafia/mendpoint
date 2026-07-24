import { mkdtempSync, cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runWarden } from "./agent.js";
import { extractHints, extractRenames, extractApiPaths } from "./heuristics.js";
import { pathBlocked, commandBlocked } from "./policies.js";
import { executeTool, type ToolContext } from "./tools.js";
import { classifyFailures, FAILURE_CATEGORIES, FAILURE_MODES } from "./knowledge.js";
import { proposeWardenFix } from "./fixes.js";
import { discoverVerifyCommand } from "./discover-verify.js";

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

describe("Warden training knowledge", () => {
  it("covers all seven communication failure categories", () => {
    const cats = Object.keys(FAILURE_CATEGORIES);
    expect(cats).toEqual(
      expect.arrayContaining([
        "protocol_contract",
        "serialization_drift",
        "semantic_mismatch",
        "network_latency",
        "cascading_errors",
        "async_webhooks",
        "rate_limiting",
      ]),
    );
    expect(FAILURE_MODES.length).toBeGreaterThanOrEqual(20);
  });

  it("classifies protocol, rate limit, and webhook modes", () => {
    const a = classifyFailures("404 on /v1/chargess", "HTTP 404 Not Found");
    expect(a.some((m) => m.category === "protocol_contract")).toBe(true);

    const b = classifyFailures("handle rate limits", "HTTP 429 Too Many Requests Retry-After: 2");
    expect(b.some((m) => m.id === "rate_limit_429")).toBe(true);

    const c = classifyFailures("webhook duplicate deliveries", "event_id already processed");
    expect(c.some((m) => m.category === "async_webhooks")).toBe(true);
  });

  it("proposes backoff, idempotency, and status-check fixes", () => {
    const tried = new Set<string>();
    const retrySrc = `async function call() {
  for (let attempt = 0; attempt < 5; attempt++) {
    await fetch("/v1/x");
  }
}`;
    const backoff = proposeWardenFix(
      retrySrc,
      "retry.js",
      "aggressive retry without backoff causes storms",
      "retry storm no backoff",
      tried,
    );
    expect(backoff?.call.tool).toBe("replace_in_file");
    expect(String(backoff?.call.args.to)).toMatch(/setTimeout|2 \*\*/);

    const postSrc = `export function pay() {
  return fetch("/v1/charges", {
    method: "POST",
    headers: { "Authorization": "Bearer x" },
    body: "{}"
  });
}`;
    const idemp = proposeWardenFix(
      postSrc,
      "pay.js",
      "prevent double-charge with idempotency",
      "duplicate payment",
      new Set(),
    );
    expect(String(idemp?.call.args.to)).toMatch(/Idempotency-Key/);

    const parseSrc = `async function load(res) {
  const data = await res.json();
  return data;
}`;
    const status = proposeWardenFix(
      parseSrc,
      "load.js",
      "must check status before parse",
      "did not check status assumed 200",
      new Set(),
    );
    expect(String(status?.call.args.to)).toMatch(/res\.ok/);
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

describe("Warden (API debug agent)", () => {
  it("fixes path typo and amount_cents on fixture", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-agent-"));
    dirs.push(dir);
    const fixture = join(root, "fixtures/agent-bugs/broken-charges");
    cpSync(join(fixture, "client.js"), join(dir, "client.js"));
    cpSync(join(fixture, "check.mjs"), join(dir, "check.mjs"));

    const result = await runWarden({
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
    expect(result.reportMarkdown).toContain("Warden");
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
    const result = await runWarden({
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
    const result = await runWarden({
      goal: "ensure charges client is correct",
      repoRoot: dir,
      verifyCommand: "node check.mjs",
      maxSteps: 5,
    });
    expect(result.ok).toBe(true);
    expect(result.stoppedReason).toMatch(/already_passing|verify/);
  });
});

describe("discoverVerifyCommand", () => {
  it("detects npm test, check.mjs, pytest, and go test", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-discover-"));
    dirs.push(dir);

    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    expect(discoverVerifyCommand(dir)).toBe("npm test");

    const dir2 = mkdtempSync(join(tmpdir(), "mendpoint-discover2-"));
    dirs.push(dir2);
    writeFileSync(join(dir2, "check.mjs"), "console.log('ok')\n");
    expect(discoverVerifyCommand(dir2)).toBe("node check.mjs");

    const dir3 = mkdtempSync(join(tmpdir(), "mendpoint-discover3-"));
    dirs.push(dir3);
    writeFileSync(join(dir3, "pytest.ini"), "[pytest]\n");
    expect(discoverVerifyCommand(dir3)).toBe("pytest");

    const dir4 = mkdtempSync(join(tmpdir(), "mendpoint-discover4-"));
    dirs.push(dir4);
    writeFileSync(join(dir4, "go.mod"), "module example.com/x\n\ngo 1.22\n");
    expect(discoverVerifyCommand(dir4)).toBe("go test ./...");

    const empty = mkdtempSync(join(tmpdir(), "mendpoint-discover-empty-"));
    dirs.push(empty);
    expect(discoverVerifyCommand(empty)).toBeUndefined();
  });
});

