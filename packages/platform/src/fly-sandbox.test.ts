import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  createFlyMachinesSandbox,
  createMockFlyClient,
  resolveFlyClient,
  resolveFlySandboxToken,
  type MockFlyClient,
} from "./fly-sandbox.js";
import {
  createSandbox,
  resolveSandboxKind,
  sandboxManifest,
  type CreateSandboxOpts,
} from "./sandbox.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function flyOpts(
  client: MockFlyClient,
  extra: Partial<CreateSandboxOpts> = {},
): CreateSandboxOpts {
  return {
    kind: "fly_machines",
    tenantId: "tenant-a",
    flyClient: client,
    fly: { app: "mendpoint-sandbox-test", ...(extra.fly ?? {}) },
    ...extra,
  };
}

describe("fly machines sandbox lifecycle", () => {
  it("creates a Machine, runs the command, and tears it down on success", async () => {
    const client = createMockFlyClient();
    const sbx = createFlyMachinesSandbox(flyOpts(client));
    try {
      const result = await sbx.runIsolated("echo ready");

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("echo ready");
      // exactly one Machine created and it was destroyed.
      expect(client.created).toHaveLength(1);
      expect(client.destroyed).toEqual([client.created[0]!.id]);
      expect(sbx.activeMachineIds()).toEqual([]);
    } finally {
      await sbx.destroy();
    }
  });

  it("tears the Machine down even when the command fails", async () => {
    const client = createMockFlyClient({
      exec: () => ({ exit_code: 7, stdout: "", stderr: "boom" }),
    });
    const sbx = createFlyMachinesSandbox(flyOpts(client));
    try {
      const result = await sbx.runIsolated("false");

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(7);
      expect(result.stderr).toContain("boom");
      expect(client.destroyed).toEqual([client.created[0]!.id]);
      expect(sbx.activeMachineIds()).toEqual([]);
    } finally {
      await sbx.destroy();
    }
  });

  it("tears the Machine down when exec throws (fail-closed, no host fallback)", async () => {
    const client = createMockFlyClient({ execError: new Error("network gone") });
    const execSpy = vi.spyOn(client, "exec");
    const sbx = createFlyMachinesSandbox(flyOpts(client));
    try {
      const result = await sbx.runIsolated("echo x");

      expect(result.ok).toBe(false);
      expect(result.stderr).toMatch(/refusing host fallback/i);
      expect(execSpy).toHaveBeenCalledTimes(1);
      expect(client.destroyed).toEqual([client.created[0]!.id]);
    } finally {
      await sbx.destroy();
    }
  });

  it("kills the Machine when a run exceeds the resource/timeout cap", async () => {
    const client = createMockFlyClient({ execDelayMs: 2_000 });
    const sbx = createFlyMachinesSandbox(
      flyOpts(client, { fly: { app: "capped-app", capMs: 25 } }),
    );
    try {
      const result = await sbx.runIsolated("sleep 100");

      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toMatch(/exceeded cap/i);
      // over-limit Machine was killed (destroyed).
      const id = client.created[0]!.id;
      expect(client.isDestroyed(id)).toBe(true);
      expect(sbx.activeMachineIds()).toEqual([]);
    } finally {
      await sbx.destroy();
    }
  });

  it("gives each run its own Machine (no shared host)", async () => {
    const client = createMockFlyClient();
    const sbx = createFlyMachinesSandbox(flyOpts(client));
    try {
      await sbx.runIsolated("echo one");
      await sbx.runIsolated("echo two");

      expect(client.created).toHaveLength(2);
      const ids = client.created.map((c) => c.id);
      expect(new Set(ids).size).toBe(2);
      expect(client.destroyed.sort()).toEqual([...ids].sort());
    } finally {
      await sbx.destroy();
    }
  });

  it("uploads only the caller tenant's workspace into the Machine", async () => {
    const client = createMockFlyClient();
    const sbx = createFlyMachinesSandbox(
      flyOpts(client, {
        files: { "src/app.ts": "export const x = 1;\n" },
        mocks: [{ name: "stripe" }],
      }),
    );
    try {
      await sbx.runIsolated("node -v");

      const config = client.created[0]!.config;
      const paths = (config.files ?? []).map((f) => f.guest_path).sort();
      expect(paths).toEqual([
        "/workspace/.mendpoint-mocks.json",
        "/workspace/src/app.ts",
      ]);
      const appFile = config.files!.find((f) => f.guest_path === "/workspace/src/app.ts")!;
      expect(Buffer.from(appFile.raw_value, "base64").toString("utf8")).toBe(
        "export const x = 1;\n",
      );
      expect(config.metadata?.mendpoint_tenant).toBe("tenant-a");
    } finally {
      await sbx.destroy();
    }
  });

  it("fails closed when the Machine cannot be created (no host fallback)", async () => {
    const client = createMockFlyClient({ createError: new Error("quota exceeded") });
    const sbx = createFlyMachinesSandbox(flyOpts(client));
    try {
      const result = await sbx.runIsolated("echo x");

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toMatch(/isolation could not be established/i);
      expect(result.stderr).toMatch(/refusing host fallback/i);
      expect(client.created).toHaveLength(0);
    } finally {
      await sbx.destroy();
    }
  });

  it("fails closed when no target Fly app is configured", async () => {
    const client = createMockFlyClient();
    const sbx = createFlyMachinesSandbox({
      kind: "fly_machines",
      flyClient: client,
      // no fly.app and no MENDPOINT_SANDBOX_FLY_APP
    });
    try {
      const result = await sbx.runIsolated("echo x");
      expect(result.ok).toBe(false);
      expect(result.stderr).toMatch(/refusing host fallback/i);
      expect(client.created).toHaveLength(0);
    } finally {
      await sbx.destroy();
    }
  });

  it("synchronous run() never executes on the shared host", () => {
    const client = createMockFlyClient();
    const sbx = createFlyMachinesSandbox(flyOpts(client));
    try {
      const result = sbx.run("rm -rf /");
      expect(result.ok).toBe(false);
      expect(result.stderr).toMatch(/never executes on the shared host/i);
      expect(client.created).toHaveLength(0);
    } finally {
      sbx.dispose();
    }
  });
});

describe("fly machines selection + default-safe routing", () => {
  it("selects fly_machines when MENDPOINT_SANDBOX_KIND=fly_machines", () => {
    vi.stubEnv("MENDPOINT_SANDBOX_KIND", "fly_machines");
    expect(resolveSandboxKind()).toBe("fly_machines");
  });

  it("selects fly_machines per-tenant over the global default", () => {
    expect(resolveSandboxKind({ tenantSandboxKind: "fly_machines" })).toBe("fly_machines");
  });

  it("routes createSandbox to fly_machines when configured", async () => {
    vi.stubEnv("MENDPOINT_SANDBOX_KIND", "fly_machines");
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_APP", "mendpoint-sandbox");
    const client = createMockFlyClient();
    const sbx = createSandbox({ flyClient: client, tenantId: "t1" });
    try {
      expect(sbx.kind).toBe("fly_machines");
      expect(typeof sbx.runIsolated).toBe("function");
      const r = await sbx.runIsolated!("echo hi");
      expect(r.ok).toBe(true);
      expect(client.created).toHaveLength(1);
      expect(sandboxManifest(sbx)).toMatchObject({ kind: "fly_machines" });
    } finally {
      sbx.dispose();
    }
  });

  it("defaults to the local backend unchanged when nothing is configured", () => {
    expect(process.env.MENDPOINT_SANDBOX_KIND).toBeUndefined();
    expect(resolveSandboxKind()).toBe("local");

    const sbx = createSandbox({ files: { "a.txt": "hi" } });
    try {
      // Byte-identical local behavior: kind local, real host exec, no runIsolated,
      // and no isolated-backend fields leak onto the handle.
      expect(sbx.kind).toBe("local");
      expect(sbx.runIsolated).toBeUndefined();
      expect(Object.keys(sbx).sort()).toEqual(
        ["dispose", "id", "kind", "mocks", "root", "run", "runtime", "serviceBaseUrl"].sort(),
      );
      const r = sbx.run('node -e "process.stdout.write(\'local-ok\')"');
      expect(r.ok).toBe(true);
      expect(r.stdout).toContain("local-ok");
      expect(sandboxManifest(sbx).note).toMatch(/not process or network isolation/i);
    } finally {
      sbx.dispose();
    }
  });
});

describe("fly client credential gating", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the mock client when no FLY_API_TOKEN is set", () => {
    vi.stubEnv("FLY_API_TOKEN", undefined);
    const client = resolveFlyClient({}, "some-app");
    expect(client.mode).toBe("mock");
  });

  it("uses the mock client when MENDPOINT_SANDBOX_FLY_MODE=mock even with a token", () => {
    vi.stubEnv("FLY_API_TOKEN", "fly-token");
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_MODE", "mock");
    const client = resolveFlyClient({}, "some-app");
    expect(client.mode).toBe("mock");
  });

  it("selects the live REST client only when token + app are wired", () => {
    vi.stubEnv("FLY_API_TOKEN", "fly-token");
    const client = resolveFlyClient({}, "mendpoint-sandbox");
    expect(client.mode).toBe("live");
  });

  it("stays on the mock client when a token is set but no app is targeted", () => {
    vi.stubEnv("FLY_API_TOKEN", "fly-token");
    const client = resolveFlyClient({}, undefined);
    expect(client.mode).toBe("mock");
  });

  it("prefers an injected client over credential resolution", () => {
    vi.stubEnv("FLY_API_TOKEN", "fly-token");
    const injected = createMockFlyClient();
    const client = resolveFlyClient({ flyClient: injected }, "mendpoint-sandbox");
    expect(client).toBe(injected);
  });
});

describe("resolveFlySandboxToken (deployed credential shape)", () => {
  // Sentinel strings only — never a real token value.
  it("resolves MENDPOINT_SANDBOX_FLY_TOKEN alone (the production shape)", () => {
    expect(
      resolveFlySandboxToken({ MENDPOINT_SANDBOX_FLY_TOKEN: "scoped-sentinel" } as NodeJS.ProcessEnv),
    ).toBe("scoped-sentinel");
  });

  it("resolves FLY_API_TOKEN alone (backwards compatible)", () => {
    expect(
      resolveFlySandboxToken({ FLY_API_TOKEN: "generic-sentinel" } as NodeJS.ProcessEnv),
    ).toBe("generic-sentinel");
  });

  it("prefers the sandbox-scoped token when both are set", () => {
    expect(
      resolveFlySandboxToken({
        MENDPOINT_SANDBOX_FLY_TOKEN: "scoped-sentinel",
        FLY_API_TOKEN: "generic-sentinel",
      } as NodeJS.ProcessEnv),
    ).toBe("scoped-sentinel");
  });

  it("treats whitespace-only values as unset", () => {
    expect(
      resolveFlySandboxToken({
        MENDPOINT_SANDBOX_FLY_TOKEN: "   ",
        FLY_API_TOKEN: "  \t ",
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });

  it("falls back past a whitespace-only scoped token to a real generic token", () => {
    expect(
      resolveFlySandboxToken({
        MENDPOINT_SANDBOX_FLY_TOKEN: "   ",
        FLY_API_TOKEN: "generic-sentinel",
      } as NodeJS.ProcessEnv),
    ).toBe("generic-sentinel");
  });
});

describe("fly_machines fail-closed on missing credential", () => {
  it("fails closed when fly_machines is selected but no Fly token resolves (no host/mock fallback)", async () => {
    vi.stubEnv("MENDPOINT_SANDBOX_KIND", "fly_machines");
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_APP", "mendpoint-sandbox");
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_TOKEN", undefined);
    vi.stubEnv("FLY_API_TOKEN", undefined);
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_MODE", undefined);
    // No injected flyClient — the real credential-resolution path decides.
    const sbx = createSandbox({ tenantId: "t1" });
    try {
      expect(sbx.kind).toBe("fly_machines");
      const result = await sbx.runIsolated!("echo pwned");

      // Must FAIL rather than silently returning the mock's fake success.
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toMatch(/token/i);
      expect(result.stderr).toMatch(/refusing host fallback/i);
      // Did NOT execute: no command output (mock success would have leaked here).
      expect(result.stdout).toBe("");
    } finally {
      sbx.dispose();
    }
  });
});
