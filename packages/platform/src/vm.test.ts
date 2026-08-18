import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock("node:child_process", () => childProcess);

import {
  clearBuildCache,
  createVmSandbox,
  detectVmCapabilities,
  ensureBuildCacheDir,
  vmStatusReport,
} from "./vm.js";

describe("vm backend isolation", () => {
  beforeEach(() => {
    childProcess.execFileSync.mockReset();
    childProcess.execSync.mockReset();
    childProcess.execFileSync.mockImplementation(
      (_file: string, args: string[]) =>
        args[0] === "version" ? "27.0.0" : "container output",
    );
  });

  it("passes Docker commands as arguments without invoking a host shell", () => {
    const sbx = createVmSandbox({ backend: "docker", image: "node:20-alpine" });
    const command = "printf safe && touch /tmp/container-only";

    try {
      const result = sbx.run(command);

      expect(result.ok).toBe(true);
      expect(childProcess.execFileSync).toHaveBeenLastCalledWith(
        "docker",
        [
          "run",
          "--rm",
          "-v",
          `${sbx.root}:/work`,
          "-w",
          "/work",
          "node:20-alpine",
          "sh",
          "-c",
          command,
        ],
        expect.objectContaining({
          encoding: "utf8",
          windowsHide: true,
        }),
      );
      expect(childProcess.execSync).not.toHaveBeenCalled();
    } finally {
      sbx.dispose();
    }
  });

  it("fails closed when Firecracker is requested", () => {
    const firecracker = detectVmCapabilities().find(
      (capability) => capability.backend === "firecracker",
    );

    expect(firecracker).toMatchObject({
      available: false,
      reason: expect.stringMatching(/not implemented/i),
    });
    expect(() =>
      createVmSandbox({
        backend: "firecracker",
        firecracker: { kernel: "kernel", rootfs: "rootfs" },
      }),
    ).toThrow(/Firecracker backend is unavailable/);
  });

  it("fails closed when Docker is requested but unavailable", () => {
    childProcess.execFileSync.mockImplementation(() => {
      throw new Error("docker unavailable");
    });
    expect(() => createVmSandbox({ backend: "docker" })).toThrow(
      /Docker daemon is unavailable/i,
    );
  });

  it("rejects cache key path traversal and clears cached roots", () => {
    expect(() => ensureBuildCacheDir("tenant-a", "../escape")).toThrow(/safe characters/i);
    expect(ensureBuildCacheDir("tenant-a", "first")).not.toBe(
      ensureBuildCacheDir("tenant-a", "second"),
    );
    expect(ensureBuildCacheDir("tenant-a", "shared")).not.toBe(
      ensureBuildCacheDir("tenant-b", "shared"),
    );
    const key = `vm-test-${Date.now()}`;
    const sbx = createVmSandbox({ backend: "local", cacheKey: key, tenantId: "tenant-a" });
    sbx.dispose();
    expect(() => clearBuildCache()).not.toThrow();
  });

  it("does not expose process-wide tenant cache metadata in the VM status report", () => {
    const first = createVmSandbox({
      backend: "local",
      cacheKey: "shared-key",
      tenantId: "tenant-a",
    });
    const second = createVmSandbox({
      backend: "local",
      cacheKey: "shared-key",
      tenantId: "tenant-b",
    });
    first.dispose();
    second.dispose();

    expect(vmStatusReport()).not.toHaveProperty("buildCache");
    clearBuildCache();
  });
});
