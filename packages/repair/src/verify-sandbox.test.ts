import { afterEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMockFlyClient,
  type CreateSandboxOpts,
  type SandboxHandle,
  type SandboxRunResult,
} from "@mendpoint/platform";
import { runVerificationCommand } from "./verify.js";
import {
  classifySandboxRunResult,
  configuredSandboxKind,
  runVerificationInSandbox,
} from "./verify-sandbox.js";

/**
 * A sandbox handle whose isolated run returns exactly the {@link SandboxRunResult}
 * the test supplies. It lets a test drive `runVerificationInSandbox` with a run
 * whose reported backend differs from the forced `kind: "fly_machines"` config,
 * so we can prove the recorded backend follows the RUN, not the configuration.
 */
function fakeSandbox(result: SandboxRunResult): (opts: CreateSandboxOpts) => SandboxHandle {
  return (opts) => ({
    id: "sbx_fake",
    kind: opts.kind ?? "fly_machines",
    root: "/workspace",
    mocks: [],
    dispose: () => {},
    run: () => ({ ok: false, stdout: "", stderr: "sync run unsupported" }),
    runIsolated: async () => result,
  });
}

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
    // The command reached the Machine, dropped to the image's node user, and
    // then ran in the uploaded workspace.
    expect(result.stdout).toContain(
      "SANDBOX_RAN:/usr/sbin/runuser -u node -- /bin/sh -c cd /workspace && npm test",
    );
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

  it("transfers a binary workspace file to the Machine byte-for-byte (no UTF-8 mangling)", async () => {
    const dir = tempRepo("mp-verify-sbx-binary-");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }));
    // A genuinely binary payload: a NUL byte plus sequences that are INVALID
    // UTF-8 (0xC0 0x80 overlong, 0xED 0xA0 0x80 surrogate, lone 0xFF/0xFE). A
    // readFileSync(_, "utf8") round-trip would replace these with U+FFFD and
    // corrupt the file; a byte-accurate transfer preserves them exactly.
    const binary = Buffer.from([
      0x00, 0xff, 0xfe, 0x80, 0xc0, 0x80, 0x01, 0x02, 0xed, 0xa0, 0x80, 0x7f, 0x00,
    ]);
    writeFileSync(join(dir, "fixture.bin"), binary);

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MENDPOINT_SANDBOX_KIND", "fly_machines");
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_APP", "mendpoint-sandbox-test");
    vi.stubEnv("MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION", "npm test");

    const client = createMockFlyClient();
    const result = await runVerificationCommand("npm test", dir, 60_000, undefined, {
      flyClient: client,
      tenantId: "tenant-a",
    });

    expect(result.ok).toBe(true);
    const config = client.created[0]!.config;
    const uploaded = config.files!.find((f) => f.guest_path === "/workspace/fixture.bin")!;
    // Decode exactly what the Machine would receive and assert byte equality.
    const received = Buffer.from(uploaded.raw_value, "base64");
    expect(received.equals(binary)).toBe(true);
    expect(received).toHaveLength(binary.length);
  });

  it("records the backend observed from the run (fly_machines) on a real sandbox exec", async () => {
    const dir = tempRepo("mp-verify-sbx-observed-");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }));

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MENDPOINT_SANDBOX_KIND", "fly_machines");
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_APP", "mendpoint-sandbox-test");
    vi.stubEnv("MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION", "npm test");

    const client = createMockFlyClient({ exec: () => ({ exit_code: 0, stdout: "ok", stderr: "" }) });
    const result = await runVerificationCommand("npm test", dir, 60_000, undefined, {
      flyClient: client,
      tenantId: "tenant-a",
    });

    expect(result.ok).toBe(true);
    // Observed from the run, not echoed from config plumbing.
    expect(result.outcome).toBe("verified");
    expect(result.sandboxBackend).toBe("fly_machines");
  });

  it("records not_verified (never verified) when the executor cannot name its backend", async () => {
    const dir = tempRepo("mp-verify-sbx-unnamed-");
    writeFileSync(join(dir, "package.json"), "{}\n");

    // The run claims success but reports NO backend. An unreportable backend must
    // fail closed to not_verified — never verified — even though ok is true.
    const result = await runVerificationInSandbox({
      command: "npm test",
      repoRoot: dir,
      timeoutMs: 60_000,
      createSandboxImpl: fakeSandbox({ ok: true, stdout: "looks green", stderr: "", exitCode: 0 }),
    });

    expect(result.outcome).toBe("not_verified");
    expect(result.sandboxBackend).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/did not report which backend/i);
  });

  it("records the backend the run reports, not the configured one, when they differ", async () => {
    const dir = tempRepo("mp-verify-sbx-differ-");
    writeFileSync(join(dir, "package.json"), "{}\n");

    // The function forces `kind: "fly_machines"` in its create opts, but the run
    // REPORTS it executed under "local". The recorded backend must follow the run
    // (local), proving it is observed, not read back from the configuration.
    const result = await runVerificationInSandbox({
      command: "npm test",
      repoRoot: dir,
      timeoutMs: 60_000,
      createSandboxImpl: fakeSandbox({ ok: true, stdout: "ran", stderr: "", exitCode: 0, backend: "local" }),
    });

    expect(result.sandboxBackend).toBe("local");
    expect(result.sandboxBackend).not.toBe("fly_machines");
    expect(result.outcome).toBe("verified");
    expect(result.ok).toBe(true);
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

describe("classifySandboxRunResult reads the backend from the run", () => {
  it("maps a passing run under a named backend to verified", () => {
    const out = classifySandboxRunResult({ ok: true, stdout: "", stderr: "", exitCode: 0, backend: "fly_machines" });
    expect(out.outcome).toBe("verified");
    expect(out.sandboxBackend).toBe("fly_machines");
    expect(out.ok).toBe(true);
  });

  it("maps a non-zero run under a named backend to failed (a real test failure)", () => {
    const out = classifySandboxRunResult({ ok: false, stdout: "", stderr: "boom", exitCode: 1, backend: "fly_machines" });
    expect(out.outcome).toBe("failed");
    expect(out.sandboxBackend).toBe("fly_machines");
    expect(out.ok).toBe(false);
  });

  it("fails closed to not_verified when the backend is absent, even if the run claims ok", () => {
    const out = classifySandboxRunResult({ ok: true, stdout: "green", stderr: "", exitCode: 0 });
    expect(out.outcome).toBe("not_verified");
    expect(out.sandboxBackend).toBeNull();
    expect(out.ok).toBe(false);
  });

  it("fails closed to not_verified when the backend is unrecognised", () => {
    const out = classifySandboxRunResult({
      ok: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
      backend: "totally_made_up" as never,
    });
    expect(out.outcome).toBe("not_verified");
    expect(out.sandboxBackend).toBeNull();
  });
});
