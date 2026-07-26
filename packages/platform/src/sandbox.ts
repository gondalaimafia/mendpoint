/**
 * Sandbox abstraction — local workdir today; VM/in-cluster later.
 * Warden: live-service hooks (mock upstreams, optional base URL).
 * Transformer: multi-runtime matrix descriptors + cache keys.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
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

const cacheRoots = new Map<string, string>();

export function createSandbox(opts: CreateSandboxOpts = {}): SandboxHandle {
  const kind = opts.kind ?? "local";
  if (kind !== "local") {
    // Interface reserved for VM / in-cluster — fall back to local with annotation
  }
  let root: string;
  if (opts.cacheKey && cacheRoots.has(opts.cacheKey)) {
    root = cacheRoots.get(opts.cacheKey)!;
  } else {
    root = mkdtempSync(join(tmpdir(), opts.prefix ?? "mendpoint-sbx-"));
    if (opts.cacheKey) cacheRoots.set(opts.cacheKey, root);
  }

  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    // fix path: mkdir parent of file
  }
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = join(root, rel);
    const parent = abs.includes("\\") || abs.includes("/")
      ? abs.replace(/[/\\][^/\\]+$/, "")
      : root;
    mkdirSync(parent, { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  // Write mock upstream manifest for agents
  const mocks = opts.mocks ?? [];
  if (mocks.length) {
    writeFileSync(
      join(root, ".mendpoint-mocks.json"),
      JSON.stringify({ mocks, serviceBaseUrl: opts.serviceBaseUrl }, null, 2),
      "utf8",
    );
  }

  const id = `sbx_${Date.now().toString(36)}`;
  return {
    id,
    kind: kind === "local" ? "local" : kind,
    root,
    serviceBaseUrl: opts.serviceBaseUrl,
    mocks,
    runtime: opts.runtime,
    dispose: () => {
      if (opts.cacheKey) return; // persistent cache
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* */
      }
    },
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
        ? "Local workdir sandbox — VM/in-cluster kinds reserved"
        : `Sandbox kind ${h.kind}`,
  };
}
