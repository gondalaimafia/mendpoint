/**
 * Fly Machines sandbox backend — per-run microVM isolation.
 *
 * Real REST path is credential-gated (FLY_API_TOKEN + MENDPOINT_SANDBOX_FLY_APP);
 * a deterministic mock client drives the full lifecycle with no network, mirroring
 * the scm.ts token-vs-mock pattern (MENDPOINT_SANDBOX_FLY_MODE=mock forces mock).
 *
 * Isolation guarantees encoded here:
 *  - each run creates its own ephemeral Machine (no shared host process),
 *  - the Machine is always destroyed on teardown (finally-guaranteed), including
 *    on command failure and on timeout,
 *  - a wall-clock / resource cap kills (destroys) a Machine that runs past the cap,
 *  - only the caller tenant's workspace files are uploaded into the Machine,
 *  - fail-closed: if a Machine cannot be created/started the run errors and NEVER
 *    falls back to executing on the shared host.
 */
import { Buffer } from "node:buffer";
import {
  createLocalSandbox,
  type CreateSandboxOpts,
  type SandboxHandle,
  type SandboxRunResult,
} from "./sandbox.js";

/** Fly Machines guest sizing (subset of the REST `config.guest` shape). */
export type FlyGuest = { cpu_kind: string; cpus: number; memory_mb: number };

/** File injected into a Machine at creation (`config.files`), base64 in raw_value. */
export type FlyMachineFile = { guest_path: string; raw_value: string };

export type FlyMachineConfig = {
  image: string;
  guest: FlyGuest;
  files?: FlyMachineFile[];
  env?: Record<string, string>;
  auto_destroy?: boolean;
  metadata?: Record<string, string>;
};

export type FlyMachine = { id: string; state: string; region?: string };

export type FlyExecResult = { exit_code: number; stdout: string; stderr: string };

/**
 * Minimal Fly Machines REST surface the adapter depends on. The real
 * implementation uses fetch; tests inject a deterministic mock.
 */
export interface FlyMachineClient {
  readonly mode: "live" | "mock";
  createMachine(input: {
    app: string;
    region?: string;
    config: FlyMachineConfig;
  }): Promise<FlyMachine>;
  waitForState(input: {
    app: string;
    id: string;
    state: "started" | "stopped";
    timeoutMs: number;
  }): Promise<void>;
  exec(input: {
    app: string;
    id: string;
    command: string[];
    timeoutMs: number;
  }): Promise<FlyExecResult>;
  destroyMachine(input: { app: string; id: string }): Promise<void>;
}

export type FlySandboxResources = {
  cpuKind?: string;
  cpus?: number;
  memoryMb?: number;
};

export type FlySandboxOptions = {
  app?: string;
  region?: string;
  image?: string;
  resources?: FlySandboxResources;
  /** Hard wall-clock cap for a single run; the Machine is killed past this. */
  capMs?: number;
  /** Timeout waiting for the Machine to reach "started". */
  startTimeoutMs?: number;
  /** Default per-exec timeout handed to the Machine. */
  execTimeoutMs?: number;
};

export const FLY_SANDBOX_DEFAULTS = {
  // Built from Dockerfile.sandbox and pushed by scripts/build-sandbox-image.mjs.
  // `:latest` tracks the current sandbox image; production pins an immutable tag
  // via MENDPOINT_SANDBOX_FLY_IMAGE. See docs/SANDBOX_IMAGE.md.
  image: "registry.fly.io/mendpoint-sandbox:latest",
  region: "iad",
  cpuKind: "shared",
  cpus: 1,
  memoryMb: 512,
  capMs: 120_000,
  startTimeoutMs: 30_000,
  execTimeoutMs: 120_000,
} as const;

export type FlySandboxHandle = SandboxHandle & {
  kind: "fly_machines";
  mode: "live" | "mock";
  /** Async isolated execution: create → run → teardown a per-run Machine. */
  runIsolated: (cmd: string, opts?: { timeoutMs?: number }) => Promise<SandboxRunResult>;
  /** Awaitable teardown of any in-flight Machine + local workspace root. */
  destroy: () => Promise<void>;
  /** Ids of Machines currently in flight (should be empty between runs). */
  activeMachineIds: () => string[];
};

export class FlySandboxError extends Error {
  readonly stage: "create" | "wait" | "exec" | "destroy";
  readonly status: number;
  readonly response: unknown;

  constructor(
    stage: FlySandboxError["stage"],
    status: number,
    response: unknown,
  ) {
    super(`fly machines ${stage} failed with status ${status}`);
    this.name = "FlySandboxError";
    this.stage = stage;
    this.status = status;
    this.response = response;
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function clip(s: string, max: number): string {
  return String(s).slice(0, max);
}

function toCommand(cmd: string): string[] {
  return ["/bin/sh", "-c", cmd];
}

function posixJoin(base: string, rel: string): string {
  const trimmed = rel.replace(/^\.\//, "").replace(/\\/g, "/");
  return `${base.replace(/\/$/, "")}/${trimmed.replace(/^\//, "")}`;
}

/**
 * Collect the caller tenant's workspace as base64-encoded Machine files. Only
 * the tenant's own seeded files (and its mock manifest) are uploaded — never the
 * host process or another tenant's data.
 */
export function collectWorkspaceFiles(opts: CreateSandboxOpts): FlyMachineFile[] {
  const files: FlyMachineFile[] = [];
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    files.push({
      guest_path: posixJoin("/workspace", rel),
      raw_value: Buffer.from(content, "utf8").toString("base64"),
    });
  }
  if (opts.mocks?.length) {
    files.push({
      guest_path: "/workspace/.mendpoint-mocks.json",
      raw_value: Buffer.from(
        JSON.stringify({ mocks: opts.mocks, serviceBaseUrl: opts.serviceBaseUrl }, null, 2),
        "utf8",
      ).toString("base64"),
    });
  }
  return files;
}

async function safeDestroy(
  client: FlyMachineClient,
  app: string,
  id: string,
): Promise<void> {
  try {
    await client.destroyMachine({ app, id });
  } catch {
    /* best-effort teardown; teardown must never throw out of finally */
  }
}

async function withCap<T>(
  p: Promise<T>,
  capMs: number,
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  // Prevent an unhandled rejection if the capped promise loses the race.
  void Promise.resolve(p).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), capMs);
  });
  try {
    return await Promise.race([
      p.then((value) => ({ timedOut: false as const, value })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveApp(opts: CreateSandboxOpts): string | undefined {
  return opts.fly?.app ?? process.env.MENDPOINT_SANDBOX_FLY_APP ?? undefined;
}

/**
 * Resolve the Fly credential for sandbox Machines.
 * Prefers the sandbox-scoped token (narrower blast radius) over the generic
 * account token. Returns undefined when neither is set so callers can fail
 * closed rather than silently degrading to host execution.
 */
export function resolveFlySandboxToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const scoped = env.MENDPOINT_SANDBOX_FLY_TOKEN?.trim();
  if (scoped) return scoped;
  const generic = env.FLY_API_TOKEN?.trim();
  return generic ? generic : undefined;
}

/**
 * Pick the Fly client. Injected client wins (tests / explicit dry-run). Otherwise
 * live only when a sandbox token + a target app are present and mock mode is not
 * forced; else a deterministic in-memory mock (no network).
 */
export function resolveFlyClient(
  opts: CreateSandboxOpts,
  app: string | undefined,
): FlyMachineClient {
  if (opts.flyClient) return opts.flyClient;
  const token = resolveFlySandboxToken(process.env);
  const mode = process.env.MENDPOINT_SANDBOX_FLY_MODE;
  if (mode === "mock" || !token || !app) {
    return createMockFlyClient();
  }
  return createFlyRestClient({
    token,
    apiBase: process.env.MENDPOINT_SANDBOX_FLY_API ?? "https://api.machines.dev",
  });
}

export function createFlyMachinesSandbox(opts: CreateSandboxOpts = {}): FlySandboxHandle {
  const flyOpts = opts.fly ?? {};
  const app = resolveApp(opts);
  const client = resolveFlyClient(opts, app);
  // Fail-closed guard: fly_machines was explicitly selected, but the mock client
  // was chosen only because no Fly token resolved (no injected client and mock
  // mode not explicitly forced). Refuse to run rather than silently degrade to
  // the no-op mock / host path.
  const isolationUnavailable =
    !opts.flyClient &&
    process.env.MENDPOINT_SANDBOX_FLY_MODE !== "mock" &&
    resolveFlySandboxToken(process.env) === undefined;
  const region =
    flyOpts.region ?? process.env.MENDPOINT_SANDBOX_FLY_REGION ?? FLY_SANDBOX_DEFAULTS.region;
  const image =
    flyOpts.image ?? process.env.MENDPOINT_SANDBOX_FLY_IMAGE ?? FLY_SANDBOX_DEFAULTS.image;
  const guest: FlyGuest = {
    cpu_kind: flyOpts.resources?.cpuKind ?? FLY_SANDBOX_DEFAULTS.cpuKind,
    cpus: flyOpts.resources?.cpus ?? FLY_SANDBOX_DEFAULTS.cpus,
    memory_mb: flyOpts.resources?.memoryMb ?? FLY_SANDBOX_DEFAULTS.memoryMb,
  };
  const capMs = flyOpts.capMs ?? FLY_SANDBOX_DEFAULTS.capMs;
  const startTimeoutMs = flyOpts.startTimeoutMs ?? FLY_SANDBOX_DEFAULTS.startTimeoutMs;
  const execTimeoutMs = flyOpts.execTimeoutMs ?? FLY_SANDBOX_DEFAULTS.execTimeoutMs;

  // Local workspace root reuses the path-safe seeding of the local backend so the
  // uploaded workspace holds ONLY this tenant's files. It does NOT expose host exec.
  const base = createLocalSandbox({
    ...opts,
    kind: "local",
    prefix: opts.prefix ?? "mendpoint-fly-",
  });

  const tenantId = opts.tenantId;
  const workspaceFiles = collectWorkspaceFiles(opts);
  const activeMachines = new Set<string>();

  const runIsolated = async (
    cmd: string,
    runOpts?: { timeoutMs?: number },
  ): Promise<SandboxRunResult> => {
    if (!app) {
      // fail-closed: without a target Fly app the run cannot be isolated.
      return {
        ok: false,
        stdout: "",
        stderr:
          "fly_machines: MENDPOINT_SANDBOX_FLY_APP is not configured; refusing host fallback",
        exitCode: -1,
      };
    }

    if (isolationUnavailable) {
      // fail-closed: no sandbox Fly token resolved, so the mock client would only
      // fake success. Refuse rather than silently skip real isolation.
      return {
        ok: false,
        stdout: "",
        stderr:
          "fly_machines: no sandbox Fly token resolved; set MENDPOINT_SANDBOX_FLY_TOKEN; refusing host fallback",
        exitCode: -1,
      };
    }

    let machine: FlyMachine;
    try {
      machine = await client.createMachine({
        app,
        region,
        config: {
          image,
          guest,
          files: workspaceFiles,
          auto_destroy: true,
          metadata: {
            mendpoint_tenant: tenantId ?? "unknown",
            mendpoint_sandbox: base.id,
          },
        },
      });
    } catch (e) {
      // fail-closed: no Machine means no host fallback.
      return {
        ok: false,
        stdout: "",
        stderr: `fly_machines: isolation could not be established (create): ${errMsg(e)}; refusing host fallback`,
        exitCode: -1,
      };
    }

    activeMachines.add(machine.id);
    const timeoutMs = Math.min(runOpts?.timeoutMs ?? execTimeoutMs, capMs);
    try {
      await client.waitForState({
        app,
        id: machine.id,
        state: "started",
        timeoutMs: startTimeoutMs,
      });

      const capped = await withCap(
        client.exec({ app, id: machine.id, command: toCommand(cmd), timeoutMs }),
        capMs,
      );
      if (capped.timedOut) {
        // Kill the over-limit Machine (also destroyed in finally; idempotent).
        await safeDestroy(client, app, machine.id);
        return {
          ok: false,
          stdout: "",
          stderr: `fly_machines: run exceeded cap ${capMs}ms; Machine ${machine.id} killed`,
          exitCode: 124,
          timedOut: true,
        };
      }

      const exec = capped.value;
      return {
        ok: exec.exit_code === 0,
        stdout: clip(exec.stdout, 8000),
        stderr: clip(exec.stderr, 4000),
        exitCode: exec.exit_code,
      };
    } catch (e) {
      // fail-closed on wait/exec failure: error, never run on the shared host.
      return {
        ok: false,
        stdout: "",
        stderr: `fly_machines: isolation could not be established (run): ${errMsg(e)}; refusing host fallback`,
        exitCode: -1,
      };
    } finally {
      await safeDestroy(client, app, machine.id);
      activeMachines.delete(machine.id);
    }
  };

  return {
    id: base.id,
    kind: "fly_machines",
    root: base.root,
    serviceBaseUrl: opts.serviceBaseUrl,
    mocks: base.mocks,
    runtime: opts.runtime,
    mode: client.mode,
    // Synchronous `run` is fail-closed: this backend is asynchronous and MUST NOT
    // execute on the shared host. Callers use runIsolated().
    run: () => ({
      ok: false,
      stdout: "",
      stderr:
        "fly_machines sandbox is asynchronous; call runIsolated() (never executes on the shared host)",
    }),
    runIsolated,
    dispose: () => {
      if (app) {
        for (const id of activeMachines) void safeDestroy(client, app, id);
      }
      activeMachines.clear();
      base.dispose();
    },
    destroy: async () => {
      if (app) {
        await Promise.all([...activeMachines].map((id) => safeDestroy(client, app, id)));
      }
      activeMachines.clear();
      base.dispose();
    },
    activeMachineIds: () => [...activeMachines],
  };
}

/* ------------------------------------------------------------------ */
/* Mock client (deterministic dry-run; no network)                    */
/* ------------------------------------------------------------------ */

export type MockFlyBehavior = {
  createError?: Error;
  startError?: Error;
  execError?: Error;
  execDelayMs?: number;
  exec?: (input: {
    app: string;
    id: string;
    command: string[];
    timeoutMs: number;
  }) => FlyExecResult | Promise<FlyExecResult>;
};

export type MockFlyClient = FlyMachineClient & {
  readonly created: Array<{ id: string; config: FlyMachineConfig }>;
  readonly destroyed: string[];
  readonly execed: string[];
  isDestroyed: (id: string) => boolean;
  isLive: (id: string) => boolean;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMockFlyClient(behavior: MockFlyBehavior = {}): MockFlyClient {
  let seq = 0;
  const created: Array<{ id: string; config: FlyMachineConfig }> = [];
  const destroyed: string[] = [];
  const execed: string[] = [];
  const live = new Set<string>();

  return {
    mode: "mock",
    async createMachine({ config }) {
      if (behavior.createError) throw behavior.createError;
      const id = `fly-mock-${++seq}`;
      created.push({ id, config });
      live.add(id);
      return { id, state: "created" };
    },
    async waitForState({ id }) {
      if (behavior.startError) throw behavior.startError;
      if (!live.has(id)) throw new Error(`fly mock: machine ${id} not found`);
    },
    async exec(input) {
      execed.push(input.id);
      if (behavior.execError) throw behavior.execError;
      if (behavior.execDelayMs) await delay(behavior.execDelayMs);
      if (behavior.exec) return behavior.exec(input);
      return {
        exit_code: 0,
        stdout: `mock exec: ${input.command.join(" ")}`,
        stderr: "",
      };
    },
    async destroyMachine({ id }) {
      destroyed.push(id);
      live.delete(id);
    },
    created,
    destroyed,
    execed,
    isDestroyed: (id) => destroyed.includes(id),
    isLive: (id) => live.has(id),
  };
}

/* ------------------------------------------------------------------ */
/* Real REST client (code-complete; only runs when creds are wired)   */
/* ------------------------------------------------------------------ */

type FetchImpl = typeof fetch;

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export function createFlyRestClient(cfg: {
  token: string;
  apiBase?: string;
  fetchImpl?: FetchImpl;
}): FlyMachineClient {
  const apiBase = cfg.apiBase ?? "https://api.machines.dev";
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${cfg.token}`,
    "Content-Type": "application/json",
  });
  const appUrl = (app: string): string =>
    `${apiBase}/v1/apps/${encodeURIComponent(app)}/machines`;

  return {
    mode: "live",
    async createMachine({ app, region, config }) {
      const res = await fetchImpl(appUrl(app), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ region, config }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new FlySandboxError("create", res.status, await safeText(res));
      const j = (await res.json()) as { id?: string; state?: string; region?: string };
      if (!j.id) throw new FlySandboxError("create", res.status, "response missing machine id");
      return { id: j.id, state: j.state ?? "created", region: j.region };
    },
    async waitForState({ app, id, state, timeoutMs }) {
      const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
      const res = await fetchImpl(
        `${appUrl(app)}/${encodeURIComponent(id)}/wait?state=${state}&timeout=${seconds}`,
        { headers: headers(), signal: AbortSignal.timeout(timeoutMs + 5_000) },
      );
      if (!res.ok) throw new FlySandboxError("wait", res.status, await safeText(res));
    },
    async exec({ app, id, command, timeoutMs }) {
      const res = await fetchImpl(`${appUrl(app)}/${encodeURIComponent(id)}/exec`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ command, timeout: Math.max(1, Math.ceil(timeoutMs / 1000)) }),
        signal: AbortSignal.timeout(timeoutMs + 5_000),
      });
      if (!res.ok) throw new FlySandboxError("exec", res.status, await safeText(res));
      const j = (await res.json()) as {
        exit_code?: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        exit_code: typeof j.exit_code === "number" ? j.exit_code : 0,
        stdout: j.stdout ?? "",
        stderr: j.stderr ?? "",
      };
    },
    async destroyMachine({ app, id }) {
      const res = await fetchImpl(`${appUrl(app)}/${encodeURIComponent(id)}?force=true`, {
        method: "DELETE",
        headers: headers(),
        signal: AbortSignal.timeout(30_000),
      });
      // 404 means the Machine is already gone — acceptable for idempotent teardown.
      if (!res.ok && res.status !== 404) {
        throw new FlySandboxError("destroy", res.status, await safeText(res));
      }
    },
  };
}
