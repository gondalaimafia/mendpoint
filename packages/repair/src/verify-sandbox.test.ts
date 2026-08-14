import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockFlyClient } from "@mendpoint/platform";
import { runVerificationCommand } from "./verify.js";
import { configuredSandboxKind } from "./verify-sandbox.js";

const dirs: string[] = [];

function tempRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("verification sandbox routing", () => {
  it("routes an operator-approved command through the sandbox, not host execFile", async () => {
    const dir = tempRepo("mp-verify-sbx-through-");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }));
    writeFileSync(join(dir, "src.ts"), "export const x = 1;\n", "utf8");

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MENDPOINT_SANDBOX_KIND", "fly_machines");
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_APP", "mendpoint-sandbox-test");
    vi.stubEnv("MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION", "npm test");

    // Sentinel stdout proves the sandbox exec ran; host `npm test` in this bare
    // temp dir could never produce it.
    const client = createMockFlyClient({
      exec: (input) => ({
        exit_code: 0,
        stdout: `SANDBOX_RAN:${input.command.join(" ")}`,
        stderr: "",
      }),
    });

    const result = await runVerificationCommand("npm test", dir, 60_000, undefined, {
      flyClient: client,
      tenantId: "tenant-a",
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    // The sandbox path was taken: one Machine created + exec'd, none left running.
    expect(client.created).toHaveLength(1);
    expect(client.execed).toHaveLength(1);
    expect(client.destroyed).toEqual([client.created[0]!.id]);
    // The command reached the Machine, wrapped to run in the uploaded workspace.
    expect(result.stdout).toContain("SANDBOX_RAN:/bin/sh -c cd /workspace && npm test");
    // Only the tenant's workspace files were uploaded, tagged with the tenant.
    const config = client.created[0]!.config;
    const paths = (config.files ?? []).map((f) => f.guest_path).sort();
    expect(paths).toContain("/workspace/package.json");
    expect(paths).toContain("/workspace/src.ts");
    expect(config.metadata?.mendpoint_tenant).toBe("tenant-a");
  });

  it("fails closed when the sandbox is unavailable (no host fallback)", async () => {
    const dir = tempRepo("mp-verify-sbx-unavail-");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }));

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MENDPOINT_SANDBOX_KIND", "fly_machines");
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_APP", "mendpoint-sandbox-test");
    vi.stubEnv("MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION", "npm test");
    // No token, no forced mock, no injected client — real credential resolution
    // must refuse rather than run the mock's fake success.
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_TOKEN", undefined);
    vi.stubEnv("FLY_API_TOKEN", undefined);
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_MODE", undefined);

    const result = await runVerificationCommand("npm test", dir);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toMatch(/token/i);
    expect(result.stderr).toMatch(/refusing host fallback/i);
    // Did NOT execute on the host: no command output leaked through.
    expect(result.stdout).toBe("");
  });

  it("fails closed when the Machine cannot be created (no host fallback)", async () => {
    const dir = tempRepo("mp-verify-sbx-createfail-");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }));

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MENDPOINT_SANDBOX_KIND", "fly_machines");
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_APP", "mendpoint-sandbox-test");
    vi.stubEnv("MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION", "npm test");

    const client = createMockFlyClient({ createError: new Error("quota exceeded") });
    const result = await runVerificationCommand("npm test", dir, 60_000, undefined, {
      flyClient: client,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toMatch(/isolation could not be established/i);
    expect(result.stderr).toMatch(/refusing host fallback/i);
    expect(client.created).toHaveLength(0);
    expect(result.stdout).toBe("");
  });

  it("leaves behaviour unchanged when no sandbox is configured (host path, sandbox untouched)", async () => {
    const dir = tempRepo("mp-verify-nosbx-");
    writeFileSync(join(dir, "check.mjs"), "process.exit(0)\n", "utf8");

    // No MENDPOINT_SANDBOX_KIND: the default local backend, host execution.
    expect(process.env.MENDPOINT_SANDBOX_KIND).toBeUndefined();
    expect(configuredSandboxKind()).toBe("local");

    const client = createMockFlyClient();
    const result = await runVerificationCommand("node check.mjs", dir, 60_000, undefined, {
      flyClient: client,
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    // The sandbox was never touched — the host path ran, byte-identical to today.
    expect(client.created).toHaveLength(0);
    expect(client.execed).toHaveLength(0);
  });

  it("does not forward host secrets to the sandboxed Machine (env scrub holds)", async () => {
    const dir = tempRepo("mp-verify-sbx-scrub-");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }));

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MENDPOINT_SANDBOX_KIND", "fly_machines");
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_APP", "mendpoint-sandbox-test");
    vi.stubEnv("MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION", "npm test");
    vi.stubEnv("SUPER_SECRET_TOKEN", "sk-do-not-leak");

    const client = createMockFlyClient();
    const result = await runVerificationCommand("npm test", dir, 60_000, undefined, {
      flyClient: client,
    });

    expect(result.ok).toBe(true);
    const config = client.created[0]!.config;
    // The Machine received no host environment at all.
    expect(config.env).toBeUndefined();
    // And the secret did not smuggle in through the uploaded workspace files.
    expect(JSON.stringify(config.files ?? [])).not.toContain("sk-do-not-leak");
  });
});
