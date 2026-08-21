import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  collectWorkspaceFiles,
  createFlyMachinesSandbox,
  createFlyRestClient,
  createMockFlyClient,
  FlySandboxError,
  isTransientFlyError,
  reconcileOrphanedMachines,
  resolveFlyClient,
  resolveFlySandboxToken,
  resolveSandboxImage,
  sandboxAllowUnpinnedImage,
  withFlyRetry,
  type MockFlyClient,
} from "./fly-sandbox.js";
import {
  SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST,
  SANDBOX_EGRESS_ATTESTATION_SCHEMA,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_COMMAND,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_DIGEST,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_TARGETS,
  sandboxEgressAttestationPayloadBytes,
} from "./sandbox-egress-attestation.js";
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

function signedEgressAuthority(app: string, image: string) {
  const keys = generateKeyPairSync("ed25519");
  const policyDigest = `sha256:${"b".repeat(64)}`;
  const payload = {
    schemaVersion: SANDBOX_EGRESS_ATTESTATION_SCHEMA,
    app,
    image,
    policyDigest,
    testedAt: "2026-08-18T19:55:00.000Z",
    expiresAt: "2026-08-18T20:55:00.000Z",
    forbiddenOutbound: {
      commandDigest: SANDBOX_EGRESS_FORBIDDEN_PROBE_DIGEST,
      targets: SANDBOX_EGRESS_FORBIDDEN_PROBE_TARGETS.map(([host, port]) => `${host}:${port}`),
      blocked: true as const,
    },
    allowedVerification: { commandDigest: SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST, passed: true as const },
    evidenceRefs: ["evidence://protected-egress-acceptance/1"],
  };
  const payloadBytes = sandboxEgressAttestationPayloadBytes(payload);
  const envelope = {
    payload: payloadBytes.toString("base64"),
    signatures: [{ keyId: "sandbox-egress-key-1", signature: sign(null, payloadBytes, keys.privateKey).toString("base64") }],
  };
  return {
    attestationBase64: Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
    publicKeySpkiBase64: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    expectedKeyId: "sandbox-egress-key-1",
    expectedPolicyDigest: policyDigest,
    now: () => "2026-08-18T20:00:00.000Z",
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

  it("drops Fly exec privileges to the image node user", async () => {
    let observedCommand: string[] | undefined;
    const client = createMockFlyClient({
      exec(input) {
        observedCommand = input.command;
        return { exit_code: 0, stdout: "", stderr: "" };
      },
    });
    const sbx = createFlyMachinesSandbox(flyOpts(client));
    try {
      const result = await sbx.runIsolated("id -u");

      expect(result.ok).toBe(true);
      expect(observedCommand).toEqual([
        "/usr/sbin/runuser",
        "-u",
        "node",
        "--",
        "/bin/sh",
        "-c",
        "id -u",
      ]);
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

  it("fails closed when a configured sandbox kind is invalid", () => {
    vi.stubEnv("MENDPOINT_SANDBOX_KIND", "fly-machines");
    expect(() => resolveSandboxKind()).toThrow("sandbox_kind_invalid");
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

describe("forced mock mode cannot produce verification evidence (fail-closed)", () => {
  it("refuses to run when MENDPOINT_SANDBOX_FLY_MODE=mock even with a token (no fake green)", async () => {
    // A token is present, so this is NOT the missing-credential path: the mock is
    // reached only because mock mode was explicitly forced. It must still refuse
    // rather than mint the mock's exit_code 0 as a passing verification.
    vi.stubEnv("MENDPOINT_SANDBOX_KIND", "fly_machines");
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_APP", "mendpoint-sandbox");
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_TOKEN", "sentinel-token");
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_MODE", "mock");
    // No injected flyClient — the env decides, and env-forced mock is not evidence.
    const sbx = createSandbox({ tenantId: "t1" });
    try {
      const result = await sbx.runIsolated!("npm test");
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toMatch(/mock/i);
      expect(result.stderr).toMatch(/refusing host fallback/i);
      // Did NOT run: the mock's "mock exec: ..." stdout never leaked through.
      expect(result.stdout).toBe("");
    } finally {
      sbx.dispose();
    }
  });

  it("still runs an explicitly injected mock (the legitimate test / dry-run seam)", async () => {
    // The injected-client seam is untouched: a deliberate double still executes.
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_MODE", "mock");
    const client = createMockFlyClient({
      exec: () => ({ exit_code: 0, stdout: "INJECTED_RAN", stderr: "" }),
    });
    const sbx = createFlyMachinesSandbox(flyOpts(client));
    try {
      const result = await sbx.runIsolated!("npm test");
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("INJECTED_RAN");
    } finally {
      sbx.dispose();
    }
  });
});

describe("sandbox image must be an immutable digest pin (fail-closed isolation boundary)", () => {
  const DIGEST = `registry.fly.io/mendpoint-sandbox@sha256:${"a".repeat(64)}`;

  // A deterministic in-memory client that reports mode "live", so the image
  // validation (which is skipped on the mock path) actually engages. No network.
  function liveMock(behavior?: Parameters<typeof createMockFlyClient>[0]): MockFlyClient {
    return { ...createMockFlyClient(behavior), mode: "live" as const };
  }

  it("resolveSandboxImage: unset image is refused on the live path (no default fills in)", () => {
    const r = resolveSandboxImage({ image: undefined, mode: "live" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stderr).toMatch(/sandbox_image_unresolved/);
      expect(r.stderr).toMatch(/refusing host fallback/i);
    }
  });

  it("resolveSandboxImage: a mutable tag (:latest) is refused on the live path", () => {
    const r = resolveSandboxImage({
      image: "registry.fly.io/mendpoint-sandbox:latest",
      mode: "live",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stderr).toMatch(/sandbox_image_not_pinned/);
      expect(r.stderr).toMatch(/refusing host fallback/i);
    }
  });

  it("resolveSandboxImage: a digest-pinned image is accepted on the live path", () => {
    const r = resolveSandboxImage({ image: DIGEST, mode: "live" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.image).toBe(DIGEST);
  });

  it("resolveSandboxImage: the explicit escape hatch permits an unpinned tag (dev only)", () => {
    const r = resolveSandboxImage({
      image: "registry.fly.io/mendpoint-sandbox:latest",
      mode: "live",
      allowUnpinned: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.image).toBe("registry.fly.io/mendpoint-sandbox:latest");
  });

  it("resolveSandboxImage: the escape hatch never permits an ABSENT image", () => {
    const r = resolveSandboxImage({ image: undefined, mode: "live", allowUnpinned: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stderr).toMatch(/sandbox_image_unresolved/);
  });

  it("resolveSandboxImage: the mock path is exempt (image never pulled there)", () => {
    expect(resolveSandboxImage({ image: undefined, mode: "mock" })).toEqual({
      ok: true,
      image: "mock",
    });
    expect(resolveSandboxImage({ image: "anything:latest", mode: "mock" })).toEqual({
      ok: true,
      image: "anything:latest",
    });
  });

  it("sandboxAllowUnpinnedImage: defaults to false; only explicit truthy strings enable it", () => {
    expect(sandboxAllowUnpinnedImage({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      sandboxAllowUnpinnedImage({ MENDPOINT_SANDBOX_ALLOW_UNPINNED_IMAGE: "0" } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      sandboxAllowUnpinnedImage({ MENDPOINT_SANDBOX_ALLOW_UNPINNED_IMAGE: "1" } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      sandboxAllowUnpinnedImage({
        MENDPOINT_SANDBOX_ALLOW_UNPINNED_IMAGE: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("runIsolated fails closed when the image is unset (never defaults, no host exec)", async () => {
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_IMAGE", undefined);
    const client = liveMock();
    const sbx = createFlyMachinesSandbox(flyOpts(client)); // no fly.image
    try {
      const result = await sbx.runIsolated("echo pwned");
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toMatch(/sandbox_image_unresolved/);
      expect(result.stderr).toMatch(/refusing host fallback/i);
      // No Machine created and nothing executed -> no host fallback path taken.
      expect(client.created).toHaveLength(0);
      expect(result.stdout).toBe("");
    } finally {
      await sbx.destroy();
    }
  });

  it("runIsolated fails closed when the image is a mutable tag (:latest rejected)", async () => {
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_IMAGE", undefined);
    const client = liveMock();
    const sbx = createFlyMachinesSandbox(
      flyOpts(client, {
        fly: { app: "mendpoint-sandbox-test", image: "registry.fly.io/mendpoint-sandbox:latest" },
      }),
    );
    try {
      const result = await sbx.runIsolated("echo pwned");
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toMatch(/sandbox_image_not_pinned/);
      expect(result.stderr).toMatch(/refusing host fallback/i);
      expect(client.created).toHaveLength(0);
      expect(result.stdout).toBe("");
    } finally {
      await sbx.destroy();
    }
  });

  it("runIsolated accepts a digest-pinned image and runs isolated", async () => {
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_IMAGE", undefined);
    const client = liveMock();
    const sbx = createFlyMachinesSandbox(
      flyOpts(client, {
        fly: {
          app: "mendpoint-sandbox-test",
          image: DIGEST,
          egressAuthority: signedEgressAuthority("mendpoint-sandbox-test", DIGEST),
        },
      }),
    );
    try {
      const result = await sbx.runIsolated("echo ready");
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(client.created).toHaveLength(1);
      expect(client.created[0]!.config.image).toBe(DIGEST);
      expect(client.destroyed).toEqual([client.created[0]!.id]);
    } finally {
      await sbx.destroy();
    }
  });

  it("runIsolated still requires immutable egress authority when the image pin escape hatch is used", async () => {
    vi.stubEnv("MENDPOINT_SANDBOX_FLY_IMAGE", undefined);
    vi.stubEnv("MENDPOINT_SANDBOX_ALLOW_UNPINNED_IMAGE", "1");
    const client = liveMock();
    const sbx = createFlyMachinesSandbox(
      flyOpts(client, {
        fly: { app: "mendpoint-sandbox-test", image: "registry.fly.io/mendpoint-sandbox:latest" },
      }),
    );
    try {
      const result = await sbx.runIsolated("echo ready");
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("sandbox_egress_attestation_required");
      expect(client.created).toHaveLength(0);
    } finally {
      await sbx.destroy();
    }
  });
});

describe("production default-deny egress authority", () => {
  const DIGEST = `registry.fly.io/mendpoint-sandbox@sha256:${"a".repeat(64)}`;
  const APP = "mendpoint-sandbox-test";

  function liveClient(behavior?: Parameters<typeof createMockFlyClient>[0]): MockFlyClient {
    return { ...createMockFlyClient(behavior), mode: "live" as const };
  }

  it("refuses before Machine creation when the signed egress authority is missing", async () => {
    const client = liveClient();
    const sbx = createFlyMachinesSandbox(
      flyOpts(client, { fly: { app: APP, image: DIGEST } }),
    );
    try {
      const result = await sbx.runIsolated("npm test");
      expect(result).toMatchObject({ ok: false, exitCode: -1 });
      expect(result.stderr).toContain("sandbox_egress_attestation_required");
      expect(client.created).toHaveLength(0);
    } finally {
      await sbx.destroy();
    }
  });

  it("never runs the customer command when the forbidden outbound probe succeeds", async () => {
    const commands: string[] = [];
    const client = liveClient({
      exec(input) {
        commands.push(input.command.join(" "));
        return { exit_code: 42, stdout: "outbound reachable", stderr: "" };
      },
    });
    const sbx = createFlyMachinesSandbox(
      flyOpts(client, {
        fly: {
          app: APP,
          image: DIGEST,
          egressAuthority: signedEgressAuthority(APP, DIGEST),
        },
      }),
    );
    try {
      const result = await sbx.runIsolated("CUSTOMER_COMMAND_MUST_NOT_RUN");
      expect(result).toMatchObject({ ok: false, exitCode: -1 });
      expect(result.stderr).toContain("sandbox_egress_policy_unverified");
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain(SANDBOX_EGRESS_FORBIDDEN_PROBE_COMMAND);
      expect(commands[0]).not.toContain("CUSTOMER_COMMAND_MUST_NOT_RUN");
    } finally {
      await sbx.destroy();
    }
  });

  it("revalidates signed authority and both acceptance probes immediately before execution", async () => {
    const commands: string[] = [];
    const client = liveClient({
      exec(input) {
        const command = input.command.join(" ");
        commands.push(command);
        if (commands.length <= 2) return { exit_code: 0, stdout: "", stderr: "" };
        return { exit_code: 0, stdout: "customer verified", stderr: "" };
      },
    });
    const sbx = createFlyMachinesSandbox(
      flyOpts(client, {
        fly: {
          app: APP,
          image: DIGEST,
          egressAuthority: signedEgressAuthority(APP, DIGEST),
        },
      }),
    );
    try {
      const result = await sbx.runIsolated("CUSTOMER_VERIFICATION");
      expect(result).toMatchObject({ ok: true, exitCode: 0, stdout: "customer verified" });
      expect(commands).toHaveLength(3);
      expect(commands[0]).toContain(SANDBOX_EGRESS_FORBIDDEN_PROBE_COMMAND);
      expect(commands[2]).toContain("CUSTOMER_VERIFICATION");
    } finally {
      await sbx.destroy();
    }
  });

  // Defect: Fly can return a reshaped or truncated /exec body with no exit_code.
  // Absence must fail closed at each of the three consumer sites, never read as 0.
  it("refuses at the forbidden-egress gate when the probe returns no exit code", async () => {
    const commands: string[] = [];
    const client = liveClient({
      exec(input) {
        commands.push(input.command.join(" "));
        // No exit_code field at all: the "Fly never reported one" third state.
        return { exit_code: undefined, stdout: "", stderr: "" };
      },
    });
    const sbx = createFlyMachinesSandbox(
      flyOpts(client, {
        fly: { app: APP, image: DIGEST, egressAuthority: signedEgressAuthority(APP, DIGEST) },
      }),
    );
    try {
      const result = await sbx.runIsolated("CUSTOMER_COMMAND_MUST_NOT_RUN");
      expect(result).toMatchObject({ ok: false, exitCode: -1 });
      expect(result.stderr).toContain("sandbox_egress_policy_unverified");
      // Only the forbidden probe ran; the customer command never executed.
      expect(commands).toHaveLength(1);
      expect(commands[0]).not.toContain("CUSTOMER_COMMAND_MUST_NOT_RUN");
    } finally {
      await sbx.destroy();
    }
  });

  it("refuses at the allowed-path gate when that probe returns no exit code", async () => {
    const commands: string[] = [];
    const client = liveClient({
      exec(input) {
        commands.push(input.command.join(" "));
        // Forbidden probe proves blocked (0); the allowed probe reports no code.
        return commands.length === 1
          ? { exit_code: 0, stdout: "", stderr: "" }
          : { exit_code: undefined, stdout: "", stderr: "" };
      },
    });
    const sbx = createFlyMachinesSandbox(
      flyOpts(client, {
        fly: { app: APP, image: DIGEST, egressAuthority: signedEgressAuthority(APP, DIGEST) },
      }),
    );
    try {
      const result = await sbx.runIsolated("CUSTOMER_COMMAND_MUST_NOT_RUN");
      expect(result).toMatchObject({ ok: false, exitCode: -1 });
      expect(result.stderr).toContain("allowed local verification probe did not pass");
      expect(commands).toHaveLength(2);
      expect(commands[1]).not.toContain("CUSTOMER_COMMAND_MUST_NOT_RUN");
    } finally {
      await sbx.destroy();
    }
  });

  it("never mints a passing verification when the customer command returns no exit code", async () => {
    const commands: string[] = [];
    const client = liveClient({
      exec(input) {
        commands.push(input.command.join(" "));
        // Both egress probes pass; the customer command's response carries no code.
        return commands.length <= 2
          ? { exit_code: 0, stdout: "", stderr: "" }
          : { exit_code: undefined, stdout: "customer output", stderr: "" };
      },
    });
    const sbx = createFlyMachinesSandbox(
      flyOpts(client, {
        fly: { app: APP, image: DIGEST, egressAuthority: signedEgressAuthority(APP, DIGEST) },
      }),
    );
    try {
      const result = await sbx.runIsolated("CUSTOMER_VERIFICATION");
      expect(commands).toHaveLength(3);
      // An absent exit code is not green: ok is false and no exit code is reported.
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBeUndefined();
    } finally {
      await sbx.destroy();
    }
  });

  it("still fails a customer command that exits nonzero (working path unchanged)", async () => {
    const commands: string[] = [];
    const client = liveClient({
      exec(input) {
        commands.push(input.command.join(" "));
        return commands.length <= 2
          ? { exit_code: 0, stdout: "", stderr: "" }
          : { exit_code: 7, stdout: "", stderr: "boom" };
      },
    });
    const sbx = createFlyMachinesSandbox(
      flyOpts(client, {
        fly: { app: APP, image: DIGEST, egressAuthority: signedEgressAuthority(APP, DIGEST) },
      }),
    );
    try {
      const result = await sbx.runIsolated("CUSTOMER_VERIFICATION");
      expect(commands).toHaveLength(3);
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(7);
    } finally {
      await sbx.destroy();
    }
  });
});

describe("byte-accurate workspace transfer (binary files survive)", () => {
  it("base64-encodes raw bytes verbatim for a binary seed file", () => {
    // NUL + invalid UTF-8 (0xC0 0x80 overlong, 0xED 0xA0 0x80 surrogate, lone
    // 0xFF/0xFE). A UTF-8 round-trip would replace these with U+FFFD; raw bytes
    // must survive untouched.
    const binary = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc0, 0x80, 0xed, 0xa0, 0x80, 0x7f]);
    const files = collectWorkspaceFiles({ files: { "fixture.bin": binary } });
    const uploaded = files.find((f) => f.guest_path === "/workspace/fixture.bin")!;
    const decoded = Buffer.from(uploaded.raw_value, "base64");
    expect(decoded.equals(binary)).toBe(true);
  });

  it("still encodes string content as UTF-8 (unchanged for text files)", () => {
    const files = collectWorkspaceFiles({ files: { "a.ts": "export const x = 1;\n" } });
    const uploaded = files.find((f) => f.guest_path === "/workspace/a.ts")!;
    expect(Buffer.from(uploaded.raw_value, "base64").toString("utf8")).toBe(
      "export const x = 1;\n",
    );
  });
});

describe("teardown failures surface as leaked microVMs (never a silent green)", () => {
  it("forces a run failure and tracks the leak when destroy keeps failing", async () => {
    const client = createMockFlyClient({ destroyError: new Error("fly destroy 500") });
    const sbx = createFlyMachinesSandbox(flyOpts(client));
    try {
      // The command itself succeeds, but the Machine cannot be destroyed.
      const result = await sbx.runIsolated("echo ok");

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toMatch(/sandbox_machine_not_destroyed/);
      const id = client.created[0]!.id;
      expect(sbx.leakedMachineIds()).toEqual([id]);
      // The leaked Machine is not misreported as an in-flight run.
      expect(sbx.activeMachineIds()).toEqual([]);
    } finally {
      await sbx.destroy().catch(() => {});
    }
  });
});

describe("isTransientFlyError (429/5xx only)", () => {
  it("treats 429 and 5xx as transient", () => {
    expect(isTransientFlyError(new FlySandboxError("create", 429, ""))).toBe(true);
    expect(isTransientFlyError(new FlySandboxError("wait", 500, ""))).toBe(true);
    expect(isTransientFlyError(new FlySandboxError("exec", 503, ""))).toBe(true);
    expect(isTransientFlyError(new FlySandboxError("destroy", 599, ""))).toBe(true);
  });

  it("treats deterministic 4xx and non-Fly errors as non-transient", () => {
    expect(isTransientFlyError(new FlySandboxError("create", 400, ""))).toBe(false);
    expect(isTransientFlyError(new FlySandboxError("create", 404, ""))).toBe(false);
    expect(isTransientFlyError(new FlySandboxError("create", 403, ""))).toBe(false);
    expect(isTransientFlyError(new Error("network gone"))).toBe(false);
    expect(isTransientFlyError("nope")).toBe(false);
  });
});

describe("withFlyRetry (bounded backoff for transient failures)", () => {
  const fastSleep = () => Promise.resolve();

  it("retries a transient failure and then succeeds", async () => {
    let calls = 0;
    const value = await withFlyRetry(
      async () => {
        calls++;
        if (calls < 3) throw new FlySandboxError("create", 503, "overloaded");
        return "ok";
      },
      { baseMs: 1, maxAttempts: 4, sleep: fastSleep },
    );
    expect(value).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does NOT retry a deterministic 4xx (throws on first occurrence)", async () => {
    let calls = 0;
    await expect(
      withFlyRetry(
        async () => {
          calls++;
          throw new FlySandboxError("create", 400, "bad request");
        },
        { baseMs: 1, maxAttempts: 4, sleep: fastSleep },
      ),
    ).rejects.toBeInstanceOf(FlySandboxError);
    expect(calls).toBe(1);
  });

  it("gives up after maxAttempts on a persistent transient failure", async () => {
    let calls = 0;
    await expect(
      withFlyRetry(
        async () => {
          calls++;
          throw new FlySandboxError("wait", 500, "still down");
        },
        { baseMs: 1, maxAttempts: 3, sleep: fastSleep },
      ),
    ).rejects.toBeInstanceOf(FlySandboxError);
    expect(calls).toBe(3);
  });
});

describe("REST client retry on transient Fly API failures", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("retries a 503 create then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response("overloaded", { status: 503 });
      return jsonResponse({ id: "m-1", state: "started" });
    });
    const client = createFlyRestClient({
      token: "token-sentinel",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: { baseMs: 1, sleep: () => Promise.resolve() },
    });
    const m = await client.createMachine({
      app: "app",
      config: { image: "img", guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 } },
    });
    expect(m.id).toBe("m-1");
    expect(calls).toBe(2);
  });

  it("does NOT retry a 400 create", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return new Response("bad request", { status: 400 });
    });
    const client = createFlyRestClient({
      token: "token-sentinel",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: { baseMs: 1, sleep: () => Promise.resolve() },
    });
    await expect(
      client.createMachine({
        app: "app",
        config: { image: "img", guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 } },
      }),
    ).rejects.toBeInstanceOf(FlySandboxError);
    expect(calls).toBe(1);
  });

  it("exec maps an absent exit_code to undefined (no 0 default is substituted)", async () => {
    // A reshaped or truncated /exec body: stdout present, exit_code omitted entirely.
    const fetchImpl = vi.fn(async () => jsonResponse({ stdout: "partial", stderr: "" }));
    const client = createFlyRestClient({
      token: "token-sentinel",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: { baseMs: 1, sleep: () => Promise.resolve() },
    });
    const r = await client.exec({ app: "app", id: "m-1", command: ["true"], timeoutMs: 1_000 });
    expect(r.exit_code).toBeUndefined();
    expect(r.stdout).toBe("partial");
  });

  it("exec preserves a reported exit_code (0 and nonzero both survive)", async () => {
    const bodies = [
      { exit_code: 0, stdout: "", stderr: "" },
      { exit_code: 3, stdout: "", stderr: "x" },
    ];
    let i = 0;
    const fetchImpl = vi.fn(async () => jsonResponse(bodies[i++]!));
    const client = createFlyRestClient({
      token: "token-sentinel",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: { baseMs: 1, sleep: () => Promise.resolve() },
    });
    expect(
      (await client.exec({ app: "app", id: "m-1", command: ["x"], timeoutMs: 1_000 })).exit_code,
    ).toBe(0);
    expect(
      (await client.exec({ app: "app", id: "m-1", command: ["x"], timeoutMs: 1_000 })).exit_code,
    ).toBe(3);
  });
});

describe("orphan reconciliation (sweep machines a crashed worker left behind)", () => {
  it("destroys tagged orphans, protects in-flight ids, and reports a summary", async () => {
    const client = createMockFlyClient({ createdAt: "2020-01-01T00:00:00.000Z" });
    // Two of our machines plus one that is not ours (no mendpoint_sandbox tag).
    const ours1 = await client.createMachine({
      app: "app",
      config: {
        image: "i",
        guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
        metadata: { mendpoint_sandbox: "sbx-1", mendpoint_tenant: "t" },
      },
    });
    const ours2 = await client.createMachine({
      app: "app",
      config: {
        image: "i",
        guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
        metadata: { mendpoint_sandbox: "sbx-2", mendpoint_tenant: "t" },
      },
    });
    await client.createMachine({
      app: "app",
      config: { image: "i", guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 } },
    });

    const result = await reconcileOrphanedMachines({
      client,
      app: "app",
      // ours2 is a legitimately in-flight run — must be protected.
      protectIds: [ours2.id],
      olderThanMs: 0,
    });

    expect(result.supported).toBe(true);
    expect(result.scanned).toBe(2); // only our two tagged machines
    expect(result.orphans).toEqual([ours1.id]);
    expect(result.destroyed).toEqual([ours1.id]);
    expect(result.failed).toEqual([]);
    expect(client.isDestroyed(ours1.id)).toBe(true);
    expect(client.isLive(ours2.id)).toBe(true); // protected, untouched
  });

  it("does not sweep machines younger than the age threshold (shared-app safety)", async () => {
    const now = Date.parse("2020-01-01T00:01:00.000Z");
    const client = createMockFlyClient({ createdAt: "2020-01-01T00:00:59.000Z" });
    await client.createMachine({
      app: "app",
      config: {
        image: "i",
        guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
        metadata: { mendpoint_sandbox: "sbx-young", mendpoint_tenant: "t" },
      },
    });
    const result = await reconcileOrphanedMachines({
      client,
      app: "app",
      olderThanMs: 30_000, // machine is only 1s old
      now,
    });
    expect(result.scanned).toBe(1);
    expect(result.orphans).toEqual([]);
    expect(result.destroyed).toEqual([]);
  });

  it("reports unsupported when the client cannot list machines", async () => {
    const base = createMockFlyClient();
    // A client without listMachines capability.
    const noList = { ...base, listMachines: undefined } as unknown as Parameters<
      typeof reconcileOrphanedMachines
    >[0]["client"];
    const result = await reconcileOrphanedMachines({ client: noList, app: "app" });
    expect(result.supported).toBe(false);
    expect(result.destroyed).toEqual([]);
  });
});
