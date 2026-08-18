/**
 * Ephemeral VM sandbox backends.
 * - local: workdir (default)
 * - docker: docker run --rm when DOCKER available
 * - firecracker: reserved until a real microVM runner is implemented
 * Build cache keyed by cacheKey across PR units.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import {
  clearSandboxCache,
  createSandbox,
  tenantScopedCacheKey,
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

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pruneMissingBuildCacheEntries(): void {
  for (const [key, entry] of buildCache) {
    if (!existsSync(entry.root)) buildCache.delete(key);
  }
}

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
  pruneMissingBuildCacheEntries();
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
        clearSandboxCache(key);
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
  pruneMissingBuildCacheEntries();
  const want = opts.backend ?? (process.env.MENDPOINT_VM_BACKEND as VmBackend) ?? "local";
  const caps = detectVmCapabilities();
  const docker = caps.find((c) => c.backend === "docker")?.available;

  if (want === "firecracker") {
    throw new Error(
      "Firecracker backend is unavailable: no microVM runner is implemented",
    );
  }

  if (!["local", "docker", "firecracker"].includes(want)) {
    throw new Error(`Unknown VM backend: ${want}`);
  }
  if (want === "docker" && !docker) {
    throw new Error("Docker backend requested but the Docker daemon is unavailable");
  }

  const backend: VmBackend = want;
  const fallback = false;

  // The build cache is keyed by the tenant-scoped composite, never the caller's
  // raw cacheKey. Without this, cacheHit and the shared root leak across tenants:
  // tenant B replaying tenant A's cacheKey would read a hit (an existence oracle)
  // against tenant A's root. Fail-closed: a cacheKey without a tenant throws
  // sandbox_tenant_scope_required before any cache lookup.
  const scopedKey = tenantScopedCacheKey(opts);

  let cacheHit = false;
  if (
    scopedKey &&
    buildCache.has(scopedKey) &&
    existsSync(buildCache.get(scopedKey)!.root)
  ) {
    cacheHit = true;
    const e = buildCache.get(scopedKey)!;
    e.hits++;
  } else if (scopedKey) {
    buildCache.delete(scopedKey);
  }

  const kind: SandboxKind = backend === "local" ? "local" : "vm";

  const base = createSandbox({
    ...opts,
    kind: "local",
    prefix: opts.prefix ?? `mendpoint-${backend}-`,
  });

  if (scopedKey && !buildCache.has(scopedKey)) {
    buildCache.set(scopedKey, {
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
  const metadataPath = join(base.root, ".mendpoint-vm.json");
  if (
    existsSync(metadataPath) &&
    !isWithin(realpathSync(base.root), realpathSync(metadataPath))
  ) {
    base.dispose();
    throw new Error("VM metadata path resolves outside sandbox root");
  }
  writeFileSync(metadataPath, JSON.stringify(meta, null, 2));

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
    // Cache roots, tenant-scoped keys, and hit counts are process-internal
    // isolation metadata. The status report is exposed to any authenticated
    // graph reader, so returning the process-wide cache map would disclose one
    // tenant's cache existence and host paths to another tenant.
    env: {
      MENDPOINT_VM_BACKEND: process.env.MENDPOINT_VM_BACKEND ?? "local",
      FIRECRACKER_BIN: process.env.FIRECRACKER_BIN ?? null,
    },
  };
}

/** Ensure a tenant-scoped cache dir under tmp for Transformer multi-PR builds. */
export function ensureBuildCacheDir(tenantId: string, cacheKey: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(cacheKey)) {
    throw new Error("Build cache key must use 1 to 128 safe characters");
  }
  const scopedKey = tenantScopedCacheKey({ tenantId, cacheKey })!;
  pruneMissingBuildCacheEntries();
  // The filesystem name is content addressed from the unambiguous tenant and
  // cache-key pair. Tenant identifiers never become path components.
  const directoryKey = createHash("sha256").update(scopedKey, "utf8").digest("hex");
  const root = join(tmpdir(), "mendpoint-build-cache", directoryKey);
  mkdirSync(root, { recursive: true });
  if (!buildCache.has(scopedKey)) {
    buildCache.set(scopedKey, {
      root,
      hits: 0,
      createdAt: new Date().toISOString(),
    });
  }
  return root;
}
