import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSandboxVerifier,
  createSandboxVerifierFromEnv,
  resolveSandboxConfig,
  sweepOrphanedSandboxMachines,
  packWorkspaceTarGz,
  FlyMachinesSandbox,
  type FlyMachinesConfig,
  type SandboxConfig,
  type SandboxDeps,
} from "./sandbox.js";

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
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
  while (servers.length) {
    const s = servers.pop();
    if (s) {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  }
});

type RecordedCall = { method: string; path: string; body: unknown };

type MockRoutes = {
  create?: (call: RecordedCall) => { status: number; json: unknown };
  wait?: (call: RecordedCall) => { status: number; json: unknown };
  exec?: (call: RecordedCall) => Promise<{ status: number; json: unknown }> | { status: number; json: unknown };
  destroy?: (call: RecordedCall) => { status: number; json: unknown };
  list?: (call: RecordedCall) => { status: number; json: unknown };
};

async function startMockMachines(routes: MockRoutes): Promise<{ baseUrl: string; calls: RecordedCall[] }> {
  const calls: RecordedCall[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = undefined;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const method = (req.method ?? "GET").toUpperCase();
      const path = req.url ?? "/";
      const call: RecordedCall = { method, path, body };
      calls.push(call);
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      try {
        const pathname = path.split("?")[0] ?? "/";
        if (method === "POST" && /\/machines$/.test(pathname)) {
          const r = routes.create?.(call) ?? { status: 200, json: { id: "m_default", state: "created" } };
          send(r.status, r.json);
        } else if (method === "GET" && /\/wait$/.test(pathname)) {
          const r = routes.wait?.(call) ?? { status: 200, json: { ok: true } };
          send(r.status, r.json);
        } else if (method === "POST" && /\/exec$/.test(pathname)) {
          const r = await (routes.exec?.(call) ?? { status: 200, json: { exit_code: 0, stdout: "", stderr: "" } });
          send(r.status, r.json);
        } else if (method === "DELETE" && /\/machines\/[^/]+$/.test(pathname)) {
          const r = routes.destroy?.(call) ?? { status: 200, json: { ok: true } };
          send(r.status, r.json);
        } else if (method === "GET" && /\/machines$/.test(pathname)) {
          const r = routes.list?.(call) ?? { status: 200, json: [] };
          send(r.status, r.json);
        } else {
          send(404, { error: "not_found", path });
        }
      } catch (error) {
        send(500, { error: String(error) });
      }
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no port"));
    });
  });
  return { baseUrl: `http://127.0.0.1:${port}/v1`, calls };
}

function tinyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-sandbox-repo-"));
  dirs.push(dir);
  writeFileSync(join(dir, "check.mjs"), "console.log('ok')\n", "utf8");
  writeFileSync(join(dir, "pay.ts"), "export const amount = 1;\n", "utf8");
  return dir;
}

function flyConfig(baseUrl: string, overrides: Partial<FlyMachinesConfig> = {}): SandboxConfig {
  const fly: FlyMachinesConfig = {
    token: "test-token",
    app: "mendpoint-sandbox",
    apiBaseUrl: baseUrl,
    image: "node:22",
    guest: { cpus: 1, memoryMb: 512, cpuKind: "shared" },
    wallClockMs: 300_000,
    execTimeoutMs: 300_000,
    apiTimeoutMs: 30_000,
    workspaceMaxBytes: 64 * 1024 * 1024,
    outputCapBytes: 256 * 1024,
    maxApiRetries: 4,
    ...overrides,
  };
  return { backend: "fly_machines", fly };
}

const noopSleep = () => Promise.resolve();

describe("resolveSandboxConfig", () => {
  it("defaults to the local backend", () => {
    expect(resolveSandboxConfig({}).backend).toBe("local");
  });

  it("populates a fly config with defaults and clamps guest ceilings", () => {
    const config = resolveSandboxConfig({
      MENDPOINT_SANDBOX_BACKEND: "fly_machines",
      MENDPOINT_SANDBOX_FLY_TOKEN: "tok",
      MENDPOINT_SANDBOX_CPUS: "999",
      MENDPOINT_SANDBOX_MEMORY_MB: "1",
    });
    expect(config.backend).toBe("fly_machines");
    expect(config.fly?.app).toBe("mendpoint-sandbox");
    expect(config.fly?.image).toBe("node:22");
    expect(config.fly?.guest.cpus).toBe(8); // clamped down from 999
    expect(config.fly?.guest.memoryMb).toBe(256); // clamped up from 1
  });
});

describe("local backend passthrough", () => {
  it("runs the unchanged local verifier as the default", async () => {
    const repo = tinyRepo();
    const verifier = createSandboxVerifier({ backend: "local" });
    expect(verifier.backend).toBe("local");
    const result = await verifier.verify({ repoRoot: repo, command: "node check.mjs" });
    expect(result.ok).toBe(true);
    expect(result.backend).toBe("local");
    expect(result.exitCode).toBe(0);
  });
});

describe("FlyMachinesSandbox happy path", () => {
  it("creates, uploads the workspace, execs the verifier, and destroys", async () => {
    const repo = tinyRepo();
    const { baseUrl, calls } = await startMockMachines({
      create: () => ({ status: 200, json: { id: "m_happy", state: "created" } }),
      exec: () => ({ status: 200, json: { exit_code: 0, stdout: "ok\n", stderr: "" } }),
      destroy: () => ({ status: 200, json: { ok: true } }),
    });
    const verifier = createSandboxVerifier(flyConfig(baseUrl), { sleep: noopSleep });
    const result = await verifier.verify({ repoRoot: repo, command: "node check.mjs" });

    expect(result.ok).toBe(true);
    expect(result.backend).toBe("fly_machines");
    expect(result.machineId).toBe("m_happy");
    expect(result.destroyed).toBe(true);
    expect(result.stdout).toBe("ok\n");

    // Call sequence: create -> wait -> exec -> destroy.
    const sequence = calls.map((c) => `${c.method} ${c.path.split("?")[0]}`);
    expect(sequence).toEqual([
      "POST /v1/apps/mendpoint-sandbox/machines",
      "GET /v1/apps/mendpoint-sandbox/machines/m_happy/wait",
      "POST /v1/apps/mendpoint-sandbox/machines/m_happy/exec",
      "DELETE /v1/apps/mendpoint-sandbox/machines/m_happy",
    ]);

    // Upload shape: the create payload carries the base64 workspace tarball.
    const createBody = calls[0]!.body as {
      config: { files: { guest_path: string; raw_value: string }[]; restart: { policy: string }; auto_destroy: boolean; guest: unknown; services?: unknown };
    };
    expect(createBody.config.files[0]!.guest_path).toBe("/workspace.tar.gz");
    expect(createBody.config.files[0]!.raw_value.length).toBeGreaterThan(0);
    expect(createBody.config.restart.policy).toBe("no");
    expect(createBody.config.auto_destroy).toBe(true);
    expect(createBody.config.services).toBeUndefined(); // no inbound surface

    // The uploaded tarball unpacks to the candidate files.
    const tar = gunzipSync(Buffer.from(createBody.config.files[0]!.raw_value, "base64"));
    const tarText = tar.toString("latin1");
    expect(tarText).toContain("check.mjs");
    expect(tarText).toContain("pay.ts");

    // Exec payload runs the verifier inside the unpacked workspace. The live
    // Machines API field is `command` (an argv array), never `cmd`.
    const execBody = calls[2]!.body as { command: string[]; timeout: number; cmd?: unknown };
    expect(execBody.cmd).toBeUndefined();
    expect(Array.isArray(execBody.command)).toBe(true);
    expect(execBody.command[0]).toBe("/bin/sh");
    expect(execBody.command[2]).toContain("tar -xzf /workspace.tar.gz");
    expect(execBody.command[2]).toContain("node check.mjs");
  });
});

describe("FlyMachinesSandbox exec payload shape", () => {
  it("sends the live-API exec shape: `command` argv array and integer-second `timeout`", async () => {
    const repo = tinyRepo();
    const { baseUrl, calls } = await startMockMachines({
      create: () => ({ status: 200, json: { id: "m_shape", state: "created" } }),
      exec: () => ({ status: 200, json: { exit_code: 0, stdout: "", stderr: "" } }),
      destroy: () => ({ status: 200, json: { ok: true } }),
    });
    // 5s exec timeout stays under the 60s server ceiling, so no clamp masks it.
    // If someone reverts to milliseconds this becomes 5000 and the test fails.
    const verifier = createSandboxVerifier(flyConfig(baseUrl, { execTimeoutMs: 5_000 }), {
      sleep: noopSleep,
    });
    const result = await verifier.verify({ repoRoot: repo, command: "node check.mjs" });
    expect(result.ok).toBe(true);

    const execBody = calls.find((c) => /\/exec$/.test(c.path))!.body as {
      command: unknown;
      timeout: unknown;
      cmd?: unknown;
    };
    // Field name is `command`, never `cmd`.
    expect(execBody.cmd).toBeUndefined();
    expect(Array.isArray(execBody.command)).toBe(true);
    for (const part of execBody.command as unknown[]) {
      expect(typeof part).toBe("string");
    }
    // `timeout` is whole SECONDS, not milliseconds.
    expect(execBody.timeout).toBe(5);
    expect(Number.isInteger(execBody.timeout)).toBe(true);
  });

  it("clamps the exec timeout to the server ceiling and logs a structured note", async () => {
    const repo = tinyRepo();
    const { baseUrl, calls } = await startMockMachines({
      create: () => ({ status: 200, json: { id: "m_clamp", state: "created" } }),
      exec: () => ({ status: 200, json: { exit_code: 0, stdout: "", stderr: "" } }),
      destroy: () => ({ status: 200, json: { ok: true } }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // 600s configured exec timeout far exceeds the 60s server ceiling.
      const verifier = createSandboxVerifier(
        flyConfig(baseUrl, { execTimeoutMs: 600_000, wallClockMs: 600_000 }),
        { sleep: noopSleep },
      );
      const result = await verifier.verify({ repoRoot: repo, command: "node check.mjs" });
      expect(result.ok).toBe(true);

      const execBody = calls.find((c) => /\/exec$/.test(c.path))!.body as { timeout: number };
      expect(execBody.timeout).toBe(60); // clamped down to the ceiling

      expect(warn).toHaveBeenCalledTimes(1);
      const note = JSON.parse((warn.mock.calls[0]![0] as string)) as Record<string, unknown>;
      expect(note.event).toBe("sandbox_exec_timeout_clamped");
      expect(note.appliedSeconds).toBe(60);
      expect(note.serverCeilingSeconds).toBe(60);
      expect(note.requestedSeconds).toBe(600);
    } finally {
      warn.mockRestore();
    }
  });

  it("maps a provider deadline-exceeded exec response to sandbox_timeout and destroys", async () => {
    const repo = tinyRepo();
    const { baseUrl, calls } = await startMockMachines({
      create: () => ({ status: 200, json: { id: "m_deadline", state: "created" } }),
      exec: () => ({ status: 504, json: { error: "deadline_exceeded" } }),
      destroy: () => ({ status: 200, json: { ok: true } }),
    });
    const verifier = createSandboxVerifier(flyConfig(baseUrl), { sleep: noopSleep });
    const result = await verifier.verify({ repoRoot: repo, command: "node check.mjs" });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("sandbox_timeout");
    expect(result.destroyed).toBe(true);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });
});

describe("FlyMachinesSandbox no process.env leak", () => {
  it("never places process.env values into the machine env", async () => {
    const repo = tinyRepo();
    const sentinel = "sandbox-leak-sentinel-value-9f3a";
    const priorSentinel = process.env.MENDPOINT_TEST_SECRET;
    process.env.MENDPOINT_TEST_SECRET = sentinel;
    try {
      const { baseUrl, calls } = await startMockMachines({
        create: () => ({ status: 200, json: { id: "m_env", state: "created" } }),
        exec: () => ({ status: 200, json: { exit_code: 0, stdout: "", stderr: "" } }),
        destroy: () => ({ status: 200, json: { ok: true } }),
      });
      const verifier = createSandboxVerifier(flyConfig(baseUrl, { token: sentinel }), { sleep: noopSleep });
      const result = await verifier.verify({ repoRoot: repo, command: "node check.mjs" });
      expect(result.ok).toBe(true);

      const createBody = calls[0]!.body as { config: { env: Record<string, string> } };
      const env = createBody.config.env;
      // Explicit minimal env only.
      expect(env).toEqual({ MENDPOINT_SANDBOX_RUN: "1", CI: "1" });
      // No process.env value crosses the boundary, including the token.
      const serialized = JSON.stringify(env);
      expect(serialized).not.toContain(sentinel);
      for (const value of Object.values(process.env)) {
        if (value && value.length > 8) {
          expect(serialized).not.toContain(value);
        }
      }
    } finally {
      if (priorSentinel === undefined) delete process.env.MENDPOINT_TEST_SECRET;
      else process.env.MENDPOINT_TEST_SECRET = priorSentinel;
    }
  });
});

describe("FlyMachinesSandbox failure paths", () => {
  it("captures a non-zero verifier exit and still destroys", async () => {
    const repo = tinyRepo();
    const { baseUrl, calls } = await startMockMachines({
      create: () => ({ status: 200, json: { id: "m_fail", state: "created" } }),
      exec: () => ({ status: 200, json: { exit_code: 1, stdout: "boom", stderr: "err" } }),
      destroy: () => ({ status: 200, json: { ok: true } }),
    });
    const verifier = createSandboxVerifier(flyConfig(baseUrl), { sleep: noopSleep });
    const result = await verifier.verify({ repoRoot: repo, command: "node check.mjs" });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("sandbox_exec_failed");
    expect(result.destroyed).toBe(true);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("treats an exec timeout as a sandbox_timeout and destroys the machine", async () => {
    const repo = tinyRepo();
    const { baseUrl, calls } = await startMockMachines({
      create: () => ({ status: 200, json: { id: "m_timeout", state: "created" } }),
      exec: async () => {
        await new Promise((r) => setTimeout(r, 400));
        return { status: 200, json: { exit_code: 0, stdout: "", stderr: "" } };
      },
      destroy: () => ({ status: 200, json: { ok: true } }),
    });
    // Tiny wall clock forces the exec AbortSignal timeout to fire.
    const verifier = createSandboxVerifier(flyConfig(baseUrl, { wallClockMs: 150, execTimeoutMs: 150 }), {
      sleep: noopSleep,
    });
    const result = await verifier.verify({ repoRoot: repo, command: "node check.mjs" });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("sandbox_timeout");
    expect(result.destroyed).toBe(true);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("fails closed when the machine cannot be confirmed destroyed", async () => {
    const repo = tinyRepo();
    const { baseUrl, calls } = await startMockMachines({
      create: () => ({ status: 200, json: { id: "m_stuck", state: "created" } }),
      exec: () => ({ status: 200, json: { exit_code: 0, stdout: "ok", stderr: "" } }),
      destroy: () => ({ status: 500, json: { error: "boom" } }),
    });
    const verifier = createSandboxVerifier(flyConfig(baseUrl, { maxApiRetries: 2 }), { sleep: noopSleep });
    const result = await verifier.verify({ repoRoot: repo, command: "node check.mjs" });
    // Verification "passed" but isolation teardown could not be confirmed.
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("sandbox_machine_not_destroyed");
    expect(result.reconciliationRequired).toBe(true);
    expect(result.machineId).toBe("m_stuck");
    const deleteCalls = calls.filter((c) => c.method === "DELETE");
    expect(deleteCalls.length).toBe(3); // initial + 2 bounded retries
  });

  it("retries with backoff on 429 before succeeding", async () => {
    const repo = tinyRepo();
    let createHits = 0;
    const { baseUrl } = await startMockMachines({
      create: () => {
        createHits += 1;
        if (createHits <= 2) return { status: 429, json: { error: "rate_limited" } };
        return { status: 200, json: { id: "m_429", state: "created" } };
      },
      exec: () => ({ status: 200, json: { exit_code: 0, stdout: "", stderr: "" } }),
      destroy: () => ({ status: 200, json: { ok: true } }),
    });
    const sleep = vi.fn(() => Promise.resolve());
    const verifier = createSandboxVerifier(flyConfig(baseUrl), { sleep });
    const result = await verifier.verify({ repoRoot: repo, command: "node check.mjs" });
    expect(result.ok).toBe(true);
    expect(createHits).toBe(3);
    expect(sleep.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("fails closed without any HTTP call when the token is missing", async () => {
    const repo = tinyRepo();
    const { baseUrl, calls } = await startMockMachines({});
    const config = flyConfig(baseUrl, { token: "" });
    const verifier = createSandboxVerifier(config, { sleep: noopSleep });
    const result = await verifier.verify({ repoRoot: repo, command: "node check.mjs" });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("sandbox_backend_misconfigured");
    expect(calls.length).toBe(0); // never reached the API
  });

  it("rejects unsupported verification commands before creating a machine", async () => {
    const repo = tinyRepo();
    const { baseUrl, calls } = await startMockMachines({});
    const verifier = createSandboxVerifier(flyConfig(baseUrl), { sleep: noopSleep });
    const result = await verifier.verify({ repoRoot: repo, command: "rm -rf /" });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("sandbox_command_unsupported");
    expect(calls.length).toBe(0);
  });

  it("refuses a workspace larger than the byte cap before creating a machine", async () => {
    const repo = tinyRepo();
    writeFileSync(join(repo, "big.txt"), "x".repeat(5_000), "utf8");
    const { baseUrl, calls } = await startMockMachines({});
    // 2048 is above the 1024-byte pack floor; the 5000-byte file exceeds it.
    const verifier = createSandboxVerifier(flyConfig(baseUrl, { workspaceMaxBytes: 2_048 }), { sleep: noopSleep });
    const result = await verifier.verify({ repoRoot: repo, command: "node check.mjs" });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("sandbox_workspace_too_large");
    expect(calls.length).toBe(0);
  });
});

describe("packWorkspaceTarGz", () => {
  it("excludes node_modules and .git and produces a valid gzip tar", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-sandbox-pack-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n", "utf8");
    mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "dep", "index.js"), "module.exports = 1;\n", "utf8");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

    const packed = packWorkspaceTarGz(dir);
    expect(packed.fileCount).toBe(1);
    const tarText = gunzipSync(Buffer.from(packed.base64, "base64")).toString("latin1");
    expect(tarText).toContain("a.ts");
    expect(tarText).not.toContain("node_modules");
    expect(tarText).not.toContain("HEAD");
  });
});

describe("sweepOrphanedSandboxMachines", () => {
  it("destroys only machines older than the grace period", async () => {
    const nowMs = Date.parse("2026-08-06T12:00:00.000Z");
    const oldCreated = new Date(nowMs - 60 * 60_000).toISOString(); // 60m old
    const freshCreated = new Date(nowMs - 60_000).toISOString(); // 1m old
    const { baseUrl, calls } = await startMockMachines({
      list: () => ({
        status: 200,
        json: [
          { id: "m_old", created_at: oldCreated },
          { id: "m_fresh", created_at: freshCreated },
        ],
      }),
      destroy: () => ({ status: 200, json: { ok: true } }),
    });
    const config = flyConfig(baseUrl);
    const result = await sweepOrphanedSandboxMachines(
      config,
      { graceMs: 15 * 60_000, now: nowMs },
      { sleep: noopSleep },
    );
    expect(result.ok).toBe(true);
    expect(result.listed).toBe(2);
    expect(result.destroyed).toEqual(["m_old"]);
    const deleted = calls.filter((c) => c.method === "DELETE").map((c) => c.path.split("?")[0]);
    expect(deleted).toEqual(["/v1/apps/mendpoint-sandbox/machines/m_old"]);
  });

  it("fails closed when the backend is not configured", async () => {
    const result = await sweepOrphanedSandboxMachines({ backend: "local" });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("sandbox_backend_misconfigured");
  });
});

describe("createSandboxVerifierFromEnv", () => {
  it("builds a fly verifier that fails closed on a missing token", async () => {
    const repo = tinyRepo();
    const verifier = createSandboxVerifierFromEnv(
      { MENDPOINT_SANDBOX_BACKEND: "fly_machines" },
      { sleep: noopSleep } satisfies SandboxDeps,
    );
    expect(verifier.backend).toBe("fly_machines");
    const result = await verifier.verify({ repoRoot: repo, command: "node check.mjs" });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("sandbox_backend_misconfigured");
    // Must not silently fall back to the local verifier.
    expect(result.backend).toBe("fly_machines");
  });
});

// Reference so FlyMachinesSandbox is exercised as a direct export too.
describe("FlyMachinesSandbox direct construction", () => {
  it("exposes the fly_machines backend id", () => {
    const config = flyConfig("http://127.0.0.1:1/v1").fly!;
    const sandbox = new FlyMachinesSandbox(config, { sleep: noopSleep });
    expect(sandbox.backend).toBe("fly_machines");
  });
});
