/**
 * Tenant-isolated sandbox verification.
 *
 * Two backends live behind one `SandboxVerifier` seam:
 *  - `local` (default): the existing Node permission verifier on the worker host
 *    (delegates to {@link runVerificationCommand}; behavior unchanged).
 *  - `fly_machines`: an ephemeral Fly Machine per verification, gated behind
 *    explicit config. Enforced boundaries in this slice are dedicated-app
 *    isolation (no access to the production app's network, volumes, or secrets),
 *    an explicit minimal machine env (NOTHING from process.env), bounded
 *    CPU/memory guests, a hard wall-clock timeout with a guaranteed destroy, and
 *    no inbound services.
 *
 * RESIDUAL RISK — OUTBOUND NETWORK IS NOT BLOCKED. Fly Machines are granted
 * outbound internet by default and the public Machines REST API cannot disable
 * it through machine config alone. We therefore do NOT claim default-deny
 * network in any user-facing string. Egress blocking is a tracked follow-up
 * (see docs/SANDBOX_VERIFIER.md).
 *
 * Fail-closed contract: when `fly_machines` is selected but the token/app is
 * missing, or the Machines API is unreachable, verification FAILS with a
 * distinct error code. It never silently falls back to the local verifier.
 */
import { gzipSync } from "node:zlib";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseVerificationCommand, runVerificationCommand } from "./verify.js";

export type SandboxBackend = "local" | "fly_machines";

/**
 * All sandbox failure codes are snake_case and prefixed `sandbox_`. They are
 * distinct so a misconfiguration, a workspace that is too large, a wall-clock
 * timeout, and an unconfirmed destroy are never conflated with a real
 * verification failure.
 */
export type SandboxErrorCode =
  | "sandbox_backend_misconfigured"
  | "sandbox_command_unsupported"
  | "sandbox_workspace_too_large"
  | "sandbox_workspace_pack_failed"
  | "sandbox_create_failed"
  | "sandbox_start_timeout"
  | "sandbox_exec_failed"
  | "sandbox_timeout"
  | "sandbox_api_unreachable"
  | "sandbox_machine_not_destroyed";

export type FlyGuestConfig = Readonly<{
  cpus: number;
  memoryMb: number;
  cpuKind: "shared" | "performance";
}>;

export type FlyMachinesConfig = Readonly<{
  token: string;
  app: string;
  /** Machines REST API base, including the version segment (…/v1). */
  apiBaseUrl: string;
  image: string;
  guest: FlyGuestConfig;
  /** Hard wall-clock ceiling for the whole verify lifecycle. */
  wallClockMs: number;
  /** Per-exec ceiling (further clamped to remaining wall clock). */
  execTimeoutMs: number;
  /** Per-API-call ceiling for create/wait/destroy/list. */
  apiTimeoutMs: number;
  /** Maximum packed workspace tarball size before we refuse to ship it. */
  workspaceMaxBytes: number;
  /** Cap on captured stdout/stderr bytes. */
  outputCapBytes: number;
  /** Bounded retries on 429/5xx/network errors. */
  maxApiRetries: number;
}>;

export type SandboxConfig = Readonly<{
  backend: SandboxBackend;
  /** Present whenever backend is `fly_machines` (token may be empty → fails closed). */
  fly?: FlyMachinesConfig;
}>;

/** Injectable seams so tests can drive a local mock server without real sleeps. */
export type SandboxDeps = Readonly<{
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}>;

export type SandboxVerificationRequest = Readonly<{
  repoRoot: string;
  /** A single supported verification command (validated against the local profiles). */
  command: string;
  /** Optional override, clamped to the backend wall-clock ceiling. */
  timeoutMs?: number;
}>;

export type SandboxVerificationResult = Readonly<{
  ok: boolean;
  backend: SandboxBackend;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
  errorCode?: SandboxErrorCode;
  /** Fly only: the ephemeral machine id, retained for reconciliation. */
  machineId?: string;
  /** Fly only: whether the machine was confirmed destroyed. */
  destroyed?: boolean;
  /** Fly only: set when a machine could not be confirmed destroyed. */
  reconciliationRequired?: boolean;
}>;

export type SandboxSweepResult = Readonly<{
  ok: boolean;
  app: string;
  listed: number;
  destroyed: readonly string[];
  failed: readonly Readonly<{ id: string; error: string }>[];
  error?: string;
  errorCode?: SandboxErrorCode;
}>;

export interface SandboxVerifier {
  readonly backend: SandboxBackend;
  verify(request: SandboxVerificationRequest): Promise<SandboxVerificationResult>;
}

// --- Bounded ceilings (fail-closed constants) -------------------------------

const DEFAULT_GUEST_CPUS = 1;
const HARD_GUEST_CPUS = 8;
const DEFAULT_GUEST_MEMORY_MB = 512;
const HARD_GUEST_MEMORY_MB = 8192;
const MIN_GUEST_MEMORY_MB = 256;
const DEFAULT_WALL_CLOCK_MS = 300_000;
const HARD_WALL_CLOCK_MS = 900_000;
const DEFAULT_EXEC_TIMEOUT_MS = 300_000;
const DEFAULT_API_TIMEOUT_MS = 30_000;
const HARD_API_TIMEOUT_MS = 120_000;
const DEFAULT_WORKSPACE_MAX_BYTES = 64 * 1024 * 1024;
const HARD_WORKSPACE_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_OUTPUT_CAP_BYTES = 256 * 1024;
const HARD_OUTPUT_CAP_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_API_RETRIES = 4;
const HARD_MAX_API_RETRIES = 8;
const DEFAULT_GRACE_MS = 15 * 60_000;
const HARD_MAX_WORKSPACE_FILES = 5_000;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 4_000;

/**
 * Fly's Machines exec endpoint enforces a documented server-side timeout ceiling
 * of roughly 60 seconds; a larger `timeout` in the request is not honored and a
 * command that runs past it comes back as a deadline-exceeded error. We clamp the
 * requested exec timeout to this ceiling so the payload never asks for more than
 * the endpoint will grant. See docs/SANDBOX_VERIFIER.md.
 */
const SERVER_EXEC_CEILING_SECONDS = 60;

/** Guest workspace mount and embedded tarball path (inside the machine). */
const GUEST_TARBALL_PATH = "/workspace.tar.gz";
const GUEST_WORKSPACE_DIR = "/mendpoint/workspace";

/** Directories never shipped into a sandbox (huge and/or host-specific). */
const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
]);

const DEFAULT_IMAGE = "node:22";

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.trunc(value), max));
}

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

/** Internal, code-carrying error used to unwind the Fly lifecycle. */
class SandboxStageError extends Error {
  readonly code: SandboxErrorCode;
  constructor(code: SandboxErrorCode, message: string) {
    super(message);
    this.name = "SandboxStageError";
    this.code = code;
  }
}

/**
 * Resolve the sandbox configuration from an environment map. The default backend
 * is `local`. When `MENDPOINT_SANDBOX_BACKEND=fly_machines`, a fly config is
 * always populated (token may be empty) so the verifier can fail closed rather
 * than fall back to the local verifier.
 */
export function resolveSandboxConfig(
  env: NodeJS.ProcessEnv = process.env,
): SandboxConfig {
  const backendRaw = trimmed(env.MENDPOINT_SANDBOX_BACKEND).toLowerCase();
  if (backendRaw !== "fly_machines") {
    return Object.freeze({ backend: "local" });
  }
  const fly: FlyMachinesConfig = Object.freeze({
    token: trimmed(env.MENDPOINT_SANDBOX_FLY_TOKEN),
    app: trimmed(env.MENDPOINT_SANDBOX_APP) || "mendpoint-sandbox",
    apiBaseUrl:
      trimmed(env.MENDPOINT_SANDBOX_API_BASE) || "https://api.machines.dev/v1",
    image: trimmed(env.MENDPOINT_SANDBOX_IMAGE) || DEFAULT_IMAGE,
    guest: Object.freeze({
      cpus: boundedInteger(
        numberFromEnv(env.MENDPOINT_SANDBOX_CPUS),
        DEFAULT_GUEST_CPUS,
        1,
        HARD_GUEST_CPUS,
      ),
      memoryMb: boundedInteger(
        numberFromEnv(env.MENDPOINT_SANDBOX_MEMORY_MB),
        DEFAULT_GUEST_MEMORY_MB,
        MIN_GUEST_MEMORY_MB,
        HARD_GUEST_MEMORY_MB,
      ),
      cpuKind: "shared",
    }),
    wallClockMs: boundedInteger(
      numberFromEnv(env.MENDPOINT_SANDBOX_TIMEOUT_MS),
      DEFAULT_WALL_CLOCK_MS,
      1_000,
      HARD_WALL_CLOCK_MS,
    ),
    execTimeoutMs: boundedInteger(
      numberFromEnv(env.MENDPOINT_SANDBOX_EXEC_TIMEOUT_MS),
      DEFAULT_EXEC_TIMEOUT_MS,
      1_000,
      HARD_WALL_CLOCK_MS,
    ),
    apiTimeoutMs: boundedInteger(
      numberFromEnv(env.MENDPOINT_SANDBOX_API_TIMEOUT_MS),
      DEFAULT_API_TIMEOUT_MS,
      1_000,
      HARD_API_TIMEOUT_MS,
    ),
    workspaceMaxBytes: boundedInteger(
      numberFromEnv(env.MENDPOINT_SANDBOX_WORKSPACE_MAX_BYTES),
      DEFAULT_WORKSPACE_MAX_BYTES,
      1_024,
      HARD_WORKSPACE_MAX_BYTES,
    ),
    outputCapBytes: boundedInteger(
      numberFromEnv(env.MENDPOINT_SANDBOX_OUTPUT_CAP_BYTES),
      DEFAULT_OUTPUT_CAP_BYTES,
      1_024,
      HARD_OUTPUT_CAP_BYTES,
    ),
    maxApiRetries: boundedInteger(
      numberFromEnv(env.MENDPOINT_SANDBOX_MAX_API_RETRIES),
      DEFAULT_MAX_API_RETRIES,
      0,
      HARD_MAX_API_RETRIES,
    ),
  });
  return Object.freeze({ backend: "fly_machines", fly });
}

function numberFromEnv(value: string | undefined): number | undefined {
  const t = trimmed(value);
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Construct a verifier for the resolved backend. Never falls back: a
 * `fly_machines` config with an empty token yields a Fly verifier that fails
 * closed at verify time.
 */
export function createSandboxVerifier(
  config: SandboxConfig,
  deps: SandboxDeps = {},
): SandboxVerifier {
  if (config.backend === "fly_machines") {
    return new FlyMachinesSandbox(config.fly ?? emptyFlyConfig(), deps);
  }
  return new LocalSandboxVerifier();
}

/** Convenience: resolve from env then construct. */
export function createSandboxVerifierFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: SandboxDeps = {},
): SandboxVerifier {
  return createSandboxVerifier(resolveSandboxConfig(env), deps);
}

function emptyFlyConfig(): FlyMachinesConfig {
  return Object.freeze({
    token: "",
    app: "",
    apiBaseUrl: "https://api.machines.dev/v1",
    image: DEFAULT_IMAGE,
    guest: Object.freeze({ cpus: DEFAULT_GUEST_CPUS, memoryMb: DEFAULT_GUEST_MEMORY_MB, cpuKind: "shared" }),
    wallClockMs: DEFAULT_WALL_CLOCK_MS,
    execTimeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
    apiTimeoutMs: DEFAULT_API_TIMEOUT_MS,
    workspaceMaxBytes: DEFAULT_WORKSPACE_MAX_BYTES,
    outputCapBytes: DEFAULT_OUTPUT_CAP_BYTES,
    maxApiRetries: DEFAULT_MAX_API_RETRIES,
  });
}

// --- Local backend (unchanged behavior) -------------------------------------

/** Runs the existing Node permission verifier on the worker host. */
export class LocalSandboxVerifier implements SandboxVerifier {
  readonly backend: SandboxBackend = "local";

  async verify(request: SandboxVerificationRequest): Promise<SandboxVerificationResult> {
    const execution = await runVerificationCommand(
      request.command,
      request.repoRoot,
      request.timeoutMs,
    );
    return Object.freeze({
      ok: execution.ok,
      backend: "local" as const,
      stdout: execution.stdout,
      stderr: execution.stderr,
      exitCode: execution.exitCode,
      ...(execution.error ? { error: execution.error } : {}),
    });
  }
}

// --- Fly Machines backend ---------------------------------------------------

type FlyApiResponse = Readonly<{ ok: boolean; status: number; json: unknown; networkError: boolean }>;

/**
 * One ephemeral Fly Machine per verification, with a guaranteed force-destroy in
 * a finally block and bounded retries on destroy. An unconfirmed destroy fails
 * the verification and flags it for reconciliation.
 */
export class FlyMachinesSandbox implements SandboxVerifier {
  readonly backend: SandboxBackend = "fly_machines";
  private readonly config: FlyMachinesConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(config: FlyMachinesConfig, deps: SandboxDeps = {}) {
    this.config = config;
    this.fetchImpl = deps.fetch ?? fetch;
    this.sleep = deps.sleep ?? realSleep;
    this.now = deps.now ?? Date.now;
  }

  async verify(request: SandboxVerificationRequest): Promise<SandboxVerificationResult> {
    if (!this.config.token || !this.config.app) {
      return failure(
        "sandbox_backend_misconfigured",
        "Fly Machines backend is selected but the deploy token or app is missing",
      );
    }
    // Only supported verification profiles cross the boundary. The normalized
    // command has no shell metacharacters (enforced by parseVerificationCommand),
    // so it is safe to embed in the guest shell pipeline below.
    const parsed = parseVerificationCommand(request.command, request.repoRoot);
    if (!parsed) {
      return failure(
        "sandbox_command_unsupported",
        `Unsupported verification command: ${request.command}`,
      );
    }
    const normalizedCommand = request.command.trim().replace(/\s+/g, " ");

    let pack: { base64: string; byteLength: number; fileCount: number };
    try {
      pack = packWorkspaceTarGz(request.repoRoot, {
        maxBytes: this.config.workspaceMaxBytes,
      });
    } catch (error) {
      if (error instanceof SandboxStageError) {
        return failure(error.code, error.message);
      }
      return failure("sandbox_workspace_pack_failed", String(error));
    }

    const start = this.now();
    const wallClockMs = boundedInteger(
      request.timeoutMs,
      this.config.wallClockMs,
      1_000,
      this.config.wallClockMs,
    );
    const deadline = start + wallClockMs;

    let machineId: string | undefined;
    let execOutcome: { stdout: string; stderr: string; exitCode: number } | undefined;
    let stageError: SandboxStageError | undefined;

    try {
      machineId = await this.createMachine(pack.base64, deadline);
      await this.waitForStarted(machineId, deadline);
      execOutcome = await this.execVerifier(machineId, normalizedCommand, deadline);
    } catch (error) {
      stageError =
        error instanceof SandboxStageError
          ? error
          : new SandboxStageError("sandbox_exec_failed", String(error));
    } finally {
      if (machineId) {
        const destroy = await this.destroyMachine(machineId);
        if (!destroy.ok) {
          // Isolation cannot be confirmed torn down — fail closed regardless of
          // whether verification itself passed, and flag for reconciliation.
          return failure(
            "sandbox_machine_not_destroyed",
            `Machine ${machineId} could not be confirmed destroyed: ${destroy.detail}`,
            { machineId, reconciliationRequired: true, destroyed: false },
          );
        }
      }
    }

    if (stageError) {
      return failure(stageError.code, stageError.message, {
        machineId,
        destroyed: true,
      });
    }
    const capped = execOutcome!;
    return Object.freeze({
      ok: capped.exitCode === 0,
      backend: "fly_machines" as const,
      stdout: capped.stdout,
      stderr: capped.stderr,
      exitCode: capped.exitCode,
      machineId,
      destroyed: true,
      ...(capped.exitCode === 0
        ? {}
        : { error: `Verification exited ${capped.exitCode}`, errorCode: "sandbox_exec_failed" as const }),
    });
  }

  private assertTimeBudget(deadline: number): number {
    const remaining = deadline - this.now();
    if (remaining <= 0) {
      throw new SandboxStageError("sandbox_timeout", "Sandbox wall-clock budget exhausted");
    }
    return remaining;
  }

  private async createMachine(tarballBase64: string, deadline: number): Promise<string> {
    this.assertTimeBudget(deadline);
    const body = {
      config: {
        image: this.config.image,
        guest: {
          cpus: this.config.guest.cpus,
          memory_mb: this.config.guest.memoryMb,
          cpu_kind: this.config.guest.cpuKind,
        },
        // The machine env is constructed EXPLICITLY here. It intentionally
        // carries NOTHING from process.env — no secrets, tokens, or host config
        // ever cross the boundary. The deploy token stays in the Authorization
        // header and is never placed in guest env.
        env: guestEnv(),
        auto_destroy: true,
        restart: { policy: "no" },
        // The candidate workspace is uploaded via the create payload's `files`
        // mechanism (base64), the simplest reliable path. It is unpacked inside
        // the guest before the verifier runs.
        files: [
          {
            guest_path: GUEST_TARBALL_PATH,
            raw_value: tarballBase64,
          },
        ],
        // Keep-alive command so the machine stays up for exec; the verifier
        // itself is run via the exec endpoint below.
        cmd: ["sleep", String(Math.ceil(this.config.wallClockMs / 1_000) + 30)],
        // No `services`: the machine exposes no inbound network surface.
      },
    };
    const response = await this.apiRequest("POST", `/apps/${this.config.app}/machines`, body, deadline);
    if (response.networkError) {
      throw new SandboxStageError("sandbox_api_unreachable", "Machines API unreachable on create");
    }
    if (!response.ok) {
      throw new SandboxStageError(
        "sandbox_create_failed",
        `Machine create failed with status ${response.status}`,
      );
    }
    const id = extractString(response.json, "id");
    if (!id) {
      throw new SandboxStageError("sandbox_create_failed", "Machine create returned no id");
    }
    return id;
  }

  private async waitForStarted(machineId: string, deadline: number): Promise<void> {
    const remaining = this.assertTimeBudget(deadline);
    const waitSeconds = Math.max(1, Math.floor(Math.min(remaining, this.config.apiTimeoutMs) / 1_000));
    const response = await this.apiRequest(
      "GET",
      `/apps/${this.config.app}/machines/${machineId}/wait?state=started&timeout=${waitSeconds}`,
      undefined,
      deadline,
    );
    if (response.networkError) {
      throw new SandboxStageError("sandbox_api_unreachable", "Machines API unreachable on wait");
    }
    if (!response.ok) {
      throw new SandboxStageError(
        "sandbox_start_timeout",
        `Machine ${machineId} did not reach started state (status ${response.status})`,
      );
    }
  }

  private async execVerifier(
    machineId: string,
    normalizedCommand: string,
    deadline: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const remaining = this.assertTimeBudget(deadline);
    const execTimeoutMs = Math.min(remaining, this.config.execTimeoutMs);
    // The live Machines exec payload takes `timeout` in whole SECONDS (not ms).
    // Convert up (ceil) and guard the 0 case so we never send `timeout: 0`, then
    // clamp to Fly's documented server-side exec ceiling — the endpoint refuses
    // to run longer regardless, and a larger value only invites a
    // deadline-exceeded response.
    const requestedSeconds = Math.max(1, Math.ceil(execTimeoutMs / 1_000));
    const execSeconds = Math.min(requestedSeconds, SERVER_EXEC_CEILING_SECONDS);
    if (requestedSeconds > SERVER_EXEC_CEILING_SECONDS) {
      console.warn(
        JSON.stringify({
          event: "sandbox_exec_timeout_clamped",
          requestedSeconds,
          appliedSeconds: execSeconds,
          serverCeilingSeconds: SERVER_EXEC_CEILING_SECONDS,
        }),
      );
    }
    const pipeline = [
      `mkdir -p ${GUEST_WORKSPACE_DIR}`,
      `tar -xzf ${GUEST_TARBALL_PATH} -C ${GUEST_WORKSPACE_DIR}`,
      `cd ${GUEST_WORKSPACE_DIR}`,
      normalizedCommand,
    ].join(" && ");
    // Live Machines API exec shape: `{ command: string[], timeout: <seconds> }`.
    // The argv array gives us shell semantics for the pipeline above.
    const body = { command: ["/bin/sh", "-lc", pipeline], timeout: execSeconds };
    const url = `${this.config.apiBaseUrl}/apps/${this.config.app}/machines/${machineId}/exec`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(execTimeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new SandboxStageError("sandbox_timeout", "Verification exec exceeded the timeout");
      }
      throw new SandboxStageError("sandbox_api_unreachable", `Exec request failed: ${String(error)}`);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (isDeadlineExceeded(res.status, json)) {
        // The provider hit its exec ceiling — route this to the exec-timeout path
        // rather than a generic unknown failure.
        throw new SandboxStageError(
          "sandbox_timeout",
          "Verification exec hit the provider deadline",
        );
      }
      throw new SandboxStageError("sandbox_exec_failed", `Exec failed with status ${res.status}`);
    }
    const cap = this.config.outputCapBytes;
    const stdout = capString(stringField(json, "stdout"), cap);
    const stderr = capString(stringField(json, "stderr"), cap);
    const exitCode = integerField(json, "exit_code");
    return { stdout, stderr, exitCode };
  }

  private async destroyMachine(machineId: string): Promise<{ ok: boolean; detail: string }> {
    // Bounded, independent-of-wall-clock destroy loop: teardown must run even if
    // the verify budget is exhausted. Uses its own deadline per attempt.
    let detail = "no attempt";
    for (let attempt = 0; attempt <= this.config.maxApiRetries; attempt++) {
      const attemptDeadline = this.now() + this.config.apiTimeoutMs;
      const response = await this.apiRequest(
        "DELETE",
        `/apps/${this.config.app}/machines/${machineId}?force=true`,
        undefined,
        attemptDeadline,
        0,
      );
      if (response.networkError) {
        detail = "network error";
      } else if (response.ok || response.status === 404) {
        // 404 means the machine is already gone (auto_destroy) — confirmed.
        return { ok: true, detail: `status ${response.status}` };
      } else {
        detail = `status ${response.status}`;
      }
      if (attempt < this.config.maxApiRetries) {
        await this.sleep(backoffMs(attempt));
      }
    }
    return { ok: false, detail };
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      "content-type": "application/json",
    };
  }

  /** Bounded-retry JSON request against the Machines API. */
  private async apiRequest(
    method: string,
    path: string,
    body: unknown,
    deadline: number,
    retries = this.config.maxApiRetries,
  ): Promise<FlyApiResponse> {
    const url = `${this.config.apiBaseUrl}${path}`;
    let last: FlyApiResponse = { ok: false, status: 0, json: null, networkError: true };
    for (let attempt = 0; attempt <= retries; attempt++) {
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        return { ok: false, status: 0, json: null, networkError: true };
      }
      const timeoutMs = Math.min(remaining, this.config.apiTimeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: this.headers(),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const json = await res.json().catch(() => ({}));
        last = { ok: res.ok, status: res.status, json, networkError: false };
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        return last;
      } catch (error) {
        last = { ok: false, status: 0, json: { error: String(error) }, networkError: true };
        if (attempt < retries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
      }
    }
    return last;
  }
}

/**
 * Sweep orphaned machines in the sandbox app older than a grace period and
 * force-destroy them. Exported for the worker's maintenance loop to call later;
 * it is intentionally NOT wired into apps/worker in this slice.
 */
export async function sweepOrphanedSandboxMachines(
  config: SandboxConfig,
  opts: Readonly<{ graceMs?: number; now?: number; apiTimeoutMs?: number }> = {},
  deps: SandboxDeps = {},
): Promise<SandboxSweepResult> {
  const fly = config.backend === "fly_machines" ? config.fly : undefined;
  if (!fly || !fly.token || !fly.app) {
    return Object.freeze({
      ok: false,
      app: fly?.app ?? "",
      listed: 0,
      destroyed: Object.freeze([]),
      failed: Object.freeze([]),
      error: "Fly Machines backend is not configured for reconciliation",
      errorCode: "sandbox_backend_misconfigured",
    });
  }
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? realSleep;
  const clock = opts.now ?? (deps.now ? deps.now() : Date.now());
  const graceMs = boundedInteger(opts.graceMs, DEFAULT_GRACE_MS, 0, HARD_WALL_CLOCK_MS * 4);
  const apiTimeoutMs = boundedInteger(opts.apiTimeoutMs, fly.apiTimeoutMs, 1_000, HARD_API_TIMEOUT_MS);
  const headers = {
    Authorization: `Bearer ${fly.token}`,
    "content-type": "application/json",
  };

  let listJson: unknown;
  try {
    const res = await fetchImpl(`${fly.apiBaseUrl}/apps/${fly.app}/machines`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(apiTimeoutMs),
    });
    if (!res.ok) {
      return Object.freeze({
        ok: false,
        app: fly.app,
        listed: 0,
        destroyed: Object.freeze([]),
        failed: Object.freeze([]),
        error: `Machines list failed with status ${res.status}`,
        errorCode: "sandbox_api_unreachable",
      });
    }
    listJson = await res.json().catch(() => []);
  } catch (error) {
    return Object.freeze({
      ok: false,
      app: fly.app,
      listed: 0,
      destroyed: Object.freeze([]),
      failed: Object.freeze([]),
      error: `Machines list unreachable: ${String(error)}`,
      errorCode: "sandbox_api_unreachable",
    });
  }

  const machines = Array.isArray(listJson) ? listJson : [];
  const destroyed: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const machine of machines) {
    const id = extractString(machine, "id");
    if (!id) continue;
    const createdAtMs = parseCreatedAt(extractString(machine, "created_at"));
    if (createdAtMs !== undefined && clock - createdAtMs < graceMs) {
      continue; // within grace — leave it alone
    }
    let ok = false;
    let detail = "no attempt";
    for (let attempt = 0; attempt <= fly.maxApiRetries; attempt++) {
      try {
        const res = await fetchImpl(
          `${fly.apiBaseUrl}/apps/${fly.app}/machines/${id}?force=true`,
          { method: "DELETE", headers, signal: AbortSignal.timeout(apiTimeoutMs) },
        );
        if (res.ok || res.status === 404) {
          ok = true;
          break;
        }
        detail = `status ${res.status}`;
      } catch (error) {
        detail = String(error);
      }
      if (attempt < fly.maxApiRetries) await sleep(backoffMs(attempt));
    }
    if (ok) destroyed.push(id);
    else failed.push({ id, error: detail });
  }

  return Object.freeze({
    ok: failed.length === 0,
    app: fly.app,
    listed: machines.length,
    destroyed: Object.freeze([...destroyed]),
    failed: Object.freeze(failed.map((entry) => Object.freeze({ ...entry }))),
  });
}

// --- Helpers ----------------------------------------------------------------

/** Explicit, minimal guest env. NOTHING from process.env is included. */
function guestEnv(): Record<string, string> {
  return { MENDPOINT_SANDBOX_RUN: "1", CI: "1" };
}

function realSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
}

function capString(value: string, cap: number): string {
  return value.length > cap ? value.slice(0, cap) : value;
}

function stringField(json: Record<string, unknown>, key: string): string {
  const value = json[key];
  return typeof value === "string" ? value : "";
}

function integerField(json: Record<string, unknown>, key: string): number {
  const value = json[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/**
 * The Machines exec endpoint returns a deadline-style error when a command runs
 * past the server-side ceiling. Detect it (HTTP 504, or a `deadline` marker in
 * the `error`/`message` body) so the caller can map it to the exec-timeout path
 * instead of a generic failure.
 */
function isDeadlineExceeded(status: number, json: Record<string, unknown>): boolean {
  if (status === 504) return true;
  const error = typeof json.error === "string" ? json.error.toLowerCase() : "";
  const message = typeof json.message === "string" ? json.message.toLowerCase() : "";
  return error.includes("deadline") || message.includes("deadline");
}

function extractString(json: unknown, key: string): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const value = (json as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : undefined;
}

function parseCreatedAt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function failure(
  errorCode: SandboxErrorCode,
  message: string,
  extra: Readonly<{ machineId?: string; destroyed?: boolean; reconciliationRequired?: boolean }> = {},
): SandboxVerificationResult {
  return Object.freeze({
    ok: false,
    backend: "fly_machines" as const,
    stdout: "",
    stderr: "",
    exitCode: 1,
    error: message,
    errorCode,
    ...(extra.machineId ? { machineId: extra.machineId } : {}),
    ...(extra.destroyed !== undefined ? { destroyed: extra.destroyed } : {}),
    ...(extra.reconciliationRequired ? { reconciliationRequired: true } : {}),
  });
}

// --- Workspace packing (self-contained ustar + gzip, no host `tar`) ---------

export type PackedWorkspace = Readonly<{
  base64: string;
  byteLength: number;
  fileCount: number;
}>;

/**
 * Pack the candidate workspace into a gzipped ustar tarball, base64-encoded for
 * the Fly create `files` mechanism. Excludes host-specific/huge directories,
 * skips symlinks (fail-closed), and enforces the byte cap.
 */
export function packWorkspaceTarGz(
  repoRoot: string,
  opts: Readonly<{ maxBytes?: number }> = {},
): PackedWorkspace {
  const maxBytes = boundedInteger(opts.maxBytes, DEFAULT_WORKSPACE_MAX_BYTES, 1_024, HARD_WORKSPACE_MAX_BYTES);
  const root = resolve(repoRoot);
  const files: { path: string; content: Buffer }[] = [];
  let totalBytes = 0;

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw new SandboxStageError("sandbox_workspace_pack_failed", `Cannot read ${dir}: ${String(error)}`);
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      // Skip symlinks entirely: they can escape the workspace root.
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, abs).replace(/\\/g, "/");
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
      if (files.length >= HARD_MAX_WORKSPACE_FILES) {
        throw new SandboxStageError(
          "sandbox_workspace_too_large",
          `Workspace exceeds the ${HARD_MAX_WORKSPACE_FILES} file ceiling`,
        );
      }
      const content = readFileSync(abs);
      totalBytes += content.byteLength;
      if (totalBytes > maxBytes) {
        throw new SandboxStageError(
          "sandbox_workspace_too_large",
          `Workspace exceeds the ${maxBytes}-byte cap`,
        );
      }
      files.push({ path: rel, content });
    }
  };
  walk(root);

  const blocks: Buffer[] = [];
  for (const file of files) {
    blocks.push(tarHeader(file.path, file.content.byteLength));
    blocks.push(file.content);
    const remainder = file.content.byteLength % 512;
    if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder, 0));
  }
  blocks.push(Buffer.alloc(1024, 0)); // two zero blocks terminate the archive
  const gz = gzipSync(Buffer.concat(blocks));
  return Object.freeze({
    base64: gz.toString("base64"),
    byteLength: gz.byteLength,
    fileCount: files.length,
  });
}

function octalField(value: number, length: number): string {
  // length includes the trailing NUL.
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function splitTarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== "/") continue;
    const name = path.slice(i + 1);
    const prefix = path.slice(0, i);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) {
      return { name, prefix };
    }
  }
  throw new SandboxStageError("sandbox_workspace_pack_failed", `Path too long for tar: ${path}`);
}

function tarHeader(path: string, size: number): Buffer {
  const { name, prefix } = splitTarPath(path);
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii"); // mode
  header.write("0000000\0", 108, 8, "ascii"); // uid
  header.write("0000000\0", 116, 8, "ascii"); // gid
  header.write(octalField(size, 12), 124, 12, "ascii"); // size
  header.write(octalField(0, 12), 136, 12, "ascii"); // mtime (fixed for determinism)
  header.write("        ", 148, 8, "ascii"); // checksum placeholder (spaces)
  header.write("0", 156, 1, "ascii"); // typeflag: regular file
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  if (prefix) header.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i]!;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}
