/**
 * Sandbox abstraction — local workdir today; VM/in-cluster later.
 * Warden: live-service hooks (mock upstreams, optional base URL).
 * Transformer: multi-runtime matrix descriptors + cache keys.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

export type SandboxKind = "local" | "vm" | "in_cluster";

export type MockUpstream = {
  name: string;
  /** Relative path under sandbox for fixture responses */
  fixturePath?: string;
  baseUrl?: string;
};

export type SandboxHandle = {
  id: string;
  kind: SandboxKind;
  root: string;
  /** Optional service under test */
  serviceBaseUrl?: string;
  mocks: MockUpstream[];
  runtime?: string;
  dispose: () => void;
  run: (cmd: string, opts?: { timeoutMs?: number }) => { ok: boolean; stdout: string; stderr: string };
};

export type CreateSandboxOpts = {
  kind?: SandboxKind;
  prefix?: string;
  /** Seed files: relative path → content */
  files?: Record<string, string>;
  mocks?: MockUpstream[];
  serviceBaseUrl?: string;
  runtime?: "node" | "python" | "jvm" | "dotnet" | "cobol";
  /** Persistent cache dir key (Transformer multi-PR builds) */
  cacheKey?: string;
};

type CacheEntry = {
  root: string;
  createdAt: number;
  lastUsedAt: number;
  refs: number;
};

const cacheRoots = new Map<string, CacheEntry>();
const MAX_CACHE_ROOTS = 32;

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function seedPath(root: string, rel: string): string {
  if (!rel || isAbsolute(rel)) throw new Error(`Sandbox seed path must be relative: ${rel}`);
  const abs = resolve(root, rel);
  if (!isWithin(root, abs)) throw new Error(`Sandbox seed path escapes root: ${rel}`);
  const realRoot = realpathSync(root);
  if (existsSync(abs) && !isWithin(realRoot, realpathSync(abs))) {
    throw new Error(`Sandbox seed path resolves outside root: ${rel}`);
  }
  let parent = dirname(abs);
  while (!existsSync(parent)) parent = dirname(parent);
  if (!isWithin(realRoot, realpathSync(parent))) {
    throw new Error(`Sandbox seed path resolves outside root: ${rel}`);
  }
  return abs;
}

function evictOldestCache(): void {
  if (cacheRoots.size < MAX_CACHE_ROOTS) return;
  const oldest = [...cacheRoots.entries()]
    .filter(([, entry]) => entry.refs === 0)
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
  if (oldest) clearSandboxCache(oldest[0]);
}

export function clearSandboxCache(cacheKey?: string): void {
  const keys = cacheKey ? [cacheKey] : [...cacheRoots.keys()];
  for (const key of keys) {
    const entry = cacheRoots.get(key);
    if (!entry) continue;
    try {
      rmSync(entry.root, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
    cacheRoots.delete(key);
  }
}

export function getSandboxCacheStats() {
  return [...cacheRoots.entries()].map(([cacheKey, entry]) => ({
    cacheKey,
    root: entry.root,
    createdAt: new Date(entry.createdAt).toISOString(),
    lastUsedAt: new Date(entry.lastUsedAt).toISOString(),
    activeHandles: entry.refs,
  }));
}

export function createSandbox(opts: CreateSandboxOpts = {}): SandboxHandle {
  const kind = opts.kind ?? "local";
  if (kind !== "local") {
    throw new Error(
      `Sandbox kind ${kind} is unavailable through createSandbox; use a real backend`,
    );
  }
  let root: string;
  const cached = opts.cacheKey ? cacheRoots.get(opts.cacheKey) : undefined;
  if (cached && existsSync(cached.root)) {
    root = cached.root;
    cached.lastUsedAt = Date.now();
    cached.refs++;
  } else {
    if (cached && opts.cacheKey) cacheRoots.delete(opts.cacheKey);
    if (opts.cacheKey) evictOldestCache();
    root = mkdtempSync(join(tmpdir(), opts.prefix ?? "mendpoint-sbx-"));
    if (opts.cacheKey) {
      const now = Date.now();
      cacheRoots.set(opts.cacheKey, {
        root,
        createdAt: now,
        lastUsedAt: now,
        refs: 1,
      });
    }
  }

  try {
    for (const [rel, content] of Object.entries(opts.files ?? {})) {
      const abs = seedPath(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    }
  } catch (error) {
    if (opts.cacheKey) clearSandboxCache(opts.cacheKey);
    else rmSync(root, { recursive: true, force: true });
    throw error;
  }

  // Write mock upstream manifest for agents
  const mocks = opts.mocks ?? [];
  if (mocks.length) {
    writeFileSync(
      seedPath(root, ".mendpoint-mocks.json"),
      JSON.stringify({ mocks, serviceBaseUrl: opts.serviceBaseUrl }, null, 2),
      "utf8",
    );
  }

  const id = `sbx_${randomUUID()}`;
  return {
    id,
    kind: "local",
    root,
    serviceBaseUrl: opts.serviceBaseUrl,
    mocks,
    runtime: opts.runtime,
    dispose: (() => {
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        if (opts.cacheKey) {
          const entry = cacheRoots.get(opts.cacheKey);
          if (entry) {
            entry.refs = Math.max(0, entry.refs - 1);
            entry.lastUsedAt = Date.now();
            if (cacheRoots.size > MAX_CACHE_ROOTS) evictOldestCache();
          }
          return;
        }
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          /* */
        }
      };
    })(),
    run: (cmd, runOpts) => {
      try {
        const stdout = execSync(cmd, {
          cwd: root,
          encoding: "utf8",
          timeout: runOpts?.timeoutMs ?? 60_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { ok: true, stdout: String(stdout).slice(0, 8000), stderr: "" };
      } catch (e: unknown) {
        const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
        return {
          ok: false,
          stdout: String(err.stdout ?? "").slice(0, 4000),
          stderr: String(err.stderr ?? err.message ?? e).slice(0, 4000),
        };
      }
    },
  };
}

/** Transformer multi-runtime matrix descriptor (no real COBOL yet). */
export const RUNTIME_MATRIX = [
  { id: "node", label: "Node.js 20+", available: true },
  { id: "python", label: "Python 3.11+", available: true },
  { id: "jvm", label: "JVM (Java analysis harness)", available: true },
  { id: "dotnet", label: ".NET (planned)", available: false },
  { id: "cobol", label: "Micro Focus / Hercules (planned)", available: false },
] as const;

export function sandboxManifest(h: SandboxHandle) {
  return {
    id: h.id,
    kind: h.kind,
    root: h.root,
    serviceBaseUrl: h.serviceBaseUrl,
    mocks: h.mocks,
    runtime: h.runtime,
    note:
      h.kind === "local"
        ? "Local workdir only; this is not process or network isolation"
        : `Sandbox kind ${h.kind}`,
  };
}
