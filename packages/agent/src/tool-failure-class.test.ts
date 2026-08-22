import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeToolAsync, type ToolContext } from "./tools.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(root);
  return root;
}

function context(repoRoot: string, allowedCommands: string[] = []): ToolContext {
  return { repoRoot, changedFiles: new Set(), allowedCommands };
}

// Each case drives run_command to exactly one of the four observed worlds and
// asserts the failure class recorded from what that site actually saw. The four
// worlds a bare `ok: false` conflates must stay distinguishable here.
describe("typed tool failure class", () => {
  it("records bad_arguments when the model supplies no command", async () => {
    const result = await executeToolAsync(context(repo("mp-failclass-args-")), {
      tool: "run_command",
      args: { command: "" },
    });
    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe("bad_arguments");
  });

  it("records policy_refusal when the command is not allowed", async () => {
    // Not in allowedCommands: harness policy refuses it before it ever runs.
    const result = await executeToolAsync(context(repo("mp-failclass-policy-"), []), {
      tool: "run_command",
      args: { command: "npm test" },
    });
    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe("policy_refusal");
  });

  it("records infra_failure when the command cannot be verified (never ran)", async () => {
    // Allowed and unblocked, but not a supported verification command, so
    // runVerificationCommand returns outcome "not_verified": it never executed.
    const command = "npm run deploy";
    const result = await executeToolAsync(
      context(repo("mp-failclass-infra-"), [command]),
      { tool: "run_command", args: { command } },
    );
    expect(result.ok).toBe(false);
    expect((result.data as { outcome?: string }).outcome).toBe("not_verified");
    expect(result.failureClass).toBe("infra_failure");
  });

  it("records target_failure when the command runs and exits non-zero", async () => {
    const repoRoot = repo("mp-failclass-target-");
    // A supported node-check verifier that genuinely runs and fails.
    writeFileSync(join(repoRoot, "check.mjs"), "process.exit(1);\n");
    const command = "node check.mjs";
    const result = await executeToolAsync(context(repoRoot, [command]), {
      tool: "run_command",
      args: { command },
    });
    expect(result.ok).toBe(false);
    expect((result.data as { outcome?: string }).outcome).toBe("failed");
    expect(result.failureClass).toBe("target_failure");
  });

  it("carries no failure class on a successful command", async () => {
    const repoRoot = repo("mp-failclass-ok-");
    writeFileSync(join(repoRoot, "check.mjs"), "process.exit(0);\n");
    const command = "node check.mjs";
    const result = await executeToolAsync(context(repoRoot, [command]), {
      tool: "run_command",
      args: { command },
    });
    expect(result.ok).toBe(true);
    expect(result.failureClass).toBeUndefined();
  });
});
