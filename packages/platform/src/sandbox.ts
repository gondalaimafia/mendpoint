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
import {
  createFlyMachinesSandbox,
  type FlyMachineClient,
  type FlySandboxOptions,
} from "./fly-sandbox.js";

export type SandboxKind = "local" | "vm" | "in_cluster" | "fly_machines";

export type MockUpstream = {
  name: string;
  /** Relative path under sandbox for fixture responses */
  fixturePath?: string;
  baseUrl?: string;
};

export type SandboxRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
  timedOut?: boolean;
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
  run: (cmd: string, opts?: { timeoutMs?: number }) => SandboxRunResult;
  /** Async isolated execution for VM/Machine backends (kind !== "local"). */
  runIsolated?: (cmd: string, opts?: { timeoutMs?: number }) => Promise<SandboxRunResult>;
};

export type CreateSandboxOpts = {
  kind?: SandboxKind;
  prefix?: string;
  /**
   * Seed files: relative path → content. Content may be a `string` (written as
   * UTF-8) or raw bytes (`Uint8Array`/`Buffer`). Byte content is written and
   * transferred verbatim, so a binary file in a customer repo (images, compiled
   * artifacts, `.so`/`.dll`, PDFs) round-trips into the sandbox without the
   * UTF-8 mangling that a text-only channel would inflict.
   */
  files?: Record<string, string | Uint8Array>;
  mocks?: MockUpstream[];
  serviceBaseUrl?: string;
  runtime?: "node" | "python" | "jvm" | "dotnet" | "cobol";
  /** Persistent cache dir key (Transformer multi-PR builds) */
  cacheKey?: string;
  /** Tenant identity — tags the isolated Machine; only this tenant's files upload. */
  tenantId?: string;
  /** Per-tenant sandbox backend selection (overrides the global default). */
  tenantSandboxKind?: SandboxKind;
  /** Fly Machines backend configuration (kind === "fly_machines"). */
  fly?: FlySandboxOptions;
  /** Injected Fly client for tests / dry-run (bypasses credential resolution). */
  flyClient?: FlyMachineClient;
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

/**
 * Minimal environment allowlist handed to sandboxed child processes.
 * The child MUST NOT inherit the parent process.env, which carries host secrets
 * (GitHub tokens, DB URLs, provider API keys). Only variables a build/verify
 * command genuinely needs to locate a shell and toolchain are forwarded. Mirrors
 * the production scrub in packages/repair/src/verify.ts.
 */
const SANDBOX_ENV_ALLOWLIST: string[] = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERPROFILE",
  "TMP",
  "TEMP",
  "TMPDIR",
];

function scrubbedSandboxEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    SANDBOX_ENV_ALLOWLIST.map((key) => [key, process.env[key]]).filter(
      (entry): entry is [string, string] => Boolean(entry[1]),
    ),
  );
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

/**
 * Resolve the effective sandbox backend. Precedence: an explicit opts.kind, then
 * a per-tenant selection, then the MENDPOINT_SANDBOX_KIND global, else local.
 * With nothing configured the result is "local" — the default path is unchanged.
 */
export function resolveSandboxKind(opts: CreateSandboxOpts = {}): SandboxKind {
  if (opts.kind) return opts.kind;
  if (opts.tenantSandboxKind) return opts.tenantSandboxKind;
  const env = process.env.MENDPOINT_SANDBOX_KIND;
  if (env === "fly_machines" || env === "local" || env === "vm" || env === "in_cluster") {
    return env;
  }
  return "local";
}

export function createSandbox(opts: CreateSandboxOpts = {}): SandboxHandle {
  const kind = resolveSandboxKind(opts);
  if (kind === "fly_machines") {
    return createFlyMachinesSandbox(opts);
  }
  if (kind !== "local") {
    throw new Error(
      `Sandbox kind ${kind} is unavailable through createSandbox; use a real backend`,
    );
  }
  return createLocalSandbox(opts);
}

/**
 * Local workdir backend (default). Not process or network isolation. This is the
 * byte-identical default path — the isolated backends layer on top of it.
 */
export function createLocalSandbox(opts: CreateSandboxOpts = {}): SandboxHandle {
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
      // Byte content is written verbatim; a string defaults to UTF-8 (byte-
      // identical to the previous explicit "utf8"), so binary files survive.
      writeFileSync(abs, content);
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
    // `cmd` is executed as a shell string, so it must never receive untrusted
    // input. The env is scrubbed to SANDBOX_ENV_ALLOWLIST so host secrets never
    // reach the child process regardless of the command.
    run: (cmd, runOpts) => {
      try {
        const stdout = execSync(cmd, {
          cwd: root,
          encoding: "utf8",
          timeout: runOpts?.timeoutMs ?? 60_000,
          stdio: ["ignore", "pipe", "pipe"],
          env: scrubbedSandboxEnv(),
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
        : h.kind === "fly_machines"
          ? "Fly Machines microVM: per-run ephemeral isolation, torn down on teardown"
          : `Sandbox kind ${h.kind}`,
  };
}
