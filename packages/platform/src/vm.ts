/**
 * Ephemeral VM sandbox backends.
 * - local: workdir (default)
 * - docker: docker run --rm when DOCKER available
 * - firecracker: reserved until a real microVM runner is implemented
 * Build cache keyed by cacheKey across PR units.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSandbox,
  type CreateSandboxOpts,
  type SandboxHandle,
  type SandboxKind,
} from "./sandbox.js";

export type VmBackend = "local" | "docker" | "firecracker";

export type VmSandboxOpts = CreateSandboxOpts & {
  backend?: VmBackend;
  /** Docker image when backend=docker */
  image?: string;
  /** Firecracker kernel/rootfs paths reserved for a future real microVM runner */
  firecracker?: { kernel?: string; rootfs?: string; vcpus?: number; memMb?: number };
};

export type VmCapability = {
  backend: VmBackend;
  available: boolean;
  reason: string;
};

const buildCache = new Map<string, { root: string; hits: number; createdAt: string }>();

export function detectVmCapabilities(): VmCapability[] {
  const caps: VmCapability[] = [
    { backend: "local", available: true, reason: "always" },
  ];
  let dockerOk = false;
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    dockerOk = true;
  } catch {
    dockerOk = false;
  }
  caps.push({
    backend: "docker",
    available: dockerOk,
    reason: dockerOk ? "docker daemon reachable" : "docker not available",
  });
  caps.push({
    backend: "firecracker",
    available: false,
    reason: "not implemented: no microVM runner is available",
  });
  return caps;
}

export function getBuildCacheStats() {
  return [...buildCache.entries()].map(([key, v]) => ({
    cacheKey: key,
    root: v.root,
    hits: v.hits,
    createdAt: v.createdAt,
  }));
}

export function clearBuildCache(key?: string): void {
  if (key) {
    const e = buildCache.get(key);
    if (e) {
      try {
        rmSync(e.root, { recursive: true, force: true });
      } catch {
        /* */
      }
      buildCache.delete(key);
    }
    return;
  }
  for (const k of [...buildCache.keys()]) clearBuildCache(k);
}

/**
 * Create sandbox with preferred backend. Docker may fall back to local when unavailable.
 * Firecracker fails closed until a real microVM runner is implemented.
 */
export function createVmSandbox(opts: VmSandboxOpts = {}): SandboxHandle & {
  backend: VmBackend;
  fallback: boolean;
  cacheHit: boolean;
  manifestExtra: Record<string, unknown>;
} {
  const want = opts.backend ?? (process.env.MENDPOINT_VM_BACKEND as VmBackend) ?? "local";
  const caps = detectVmCapabilities();
  const docker = caps.find((c) => c.backend === "docker")?.available;

  if (want === "firecracker") {
    throw new Error(
      "Firecracker backend is unavailable: no microVM runner is implemented",
    );
  }

  let backend: VmBackend = "local";
  let fallback = false;
  if (want === "docker" && docker) backend = "docker";
  else if (want === "local") backend = "local";
  else {
    backend = "local";
    fallback = true;
  }

  let cacheHit = false;
  if (opts.cacheKey && buildCache.has(opts.cacheKey)) {
    cacheHit = true;
    const e = buildCache.get(opts.cacheKey)!;
    e.hits++;
  }

  const kind: SandboxKind = backend === "local" ? "local" : "vm";

  const base = createSandbox({
    ...opts,
    kind,
    prefix: opts.prefix ?? `mendpoint-${backend}-`,
  });

  if (opts.cacheKey && !buildCache.has(opts.cacheKey)) {
    buildCache.set(opts.cacheKey, {
      root: base.root,
      hits: 0,
      createdAt: new Date().toISOString(),
    });
  }

  // Write VM metadata for agents
  const meta = {
    backend,
    fallback,
    cacheHit,
    cacheKey: opts.cacheKey,
    firecracker: opts.firecracker ?? {
      vcpus: 2,
      memMb: 512,
      note: "interface reserved",
    },
    image: opts.image ?? "node:20-alpine",
    capabilities: caps,
  };
  writeFileSync(join(base.root, ".mendpoint-vm.json"), JSON.stringify(meta, null, 2));

  const run =
    backend === "docker" && docker
      ? (cmd: string, runOpts?: { timeoutMs?: number }) => {
          try {
            const image = opts.image ?? "node:20-alpine";
            const stdout = execFileSync(
              "docker",
              [
                "run",
                "--rm",
                "-v",
                `${base.root}:/work`,
                "-w",
                "/work",
                image,
                "sh",
                "-c",
                cmd,
              ],
              {
                encoding: "utf8",
                timeout: runOpts?.timeoutMs ?? 120_000,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
              },
            );
            return { ok: true, stdout: String(stdout).slice(0, 8000), stderr: "" };
          } catch (e: unknown) {
            const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
            return {
              ok: false,
              stdout: String(err.stdout ?? "").slice(0, 4000),
              stderr: String(err.stderr ?? err.message ?? e).slice(0, 4000),
            };
          }
        }
      : base.run;

  return {
    ...base,
    run,
    backend,
    fallback,
    cacheHit,
    manifestExtra: meta,
    kind,
  };
}

export function vmStatusReport() {
  return {
    capabilities: detectVmCapabilities(),
    buildCache: getBuildCacheStats(),
    env: {
      MENDPOINT_VM_BACKEND: process.env.MENDPOINT_VM_BACKEND ?? "local",
      FIRECRACKER_BIN: process.env.FIRECRACKER_BIN ?? null,
    },
  };
}

/** Ensure a named cache dir under tmp for transformer multi-PR builds */
export function ensureBuildCacheDir(cacheKey: string): string {
  const root = join(tmpdir(), "mendpoint-build-cache", cacheKey);
  mkdirSync(root, { recursive: true });
  if (!buildCache.has(cacheKey)) {
    buildCache.set(cacheKey, {
      root,
      hits: 0,
      createdAt: new Date().toISOString(),
    });
  }
  return root;
}
