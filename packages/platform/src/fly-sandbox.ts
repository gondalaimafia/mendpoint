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
import {
  SANDBOX_EGRESS_ALLOWED_PROBE_COMMAND,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_COMMAND,
  sandboxEgressAuthorityFromEnv,
  verifySandboxEgressAttestation,
  type SandboxEgressAuthorityConfig,
} from "./sandbox-egress-attestation.js";

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

export type FlyMachine = {
  id: string;
  state: string;
  region?: string;
  /** Machine metadata (`config.metadata`) — carries our tenant/sandbox tags. */
  metadata?: Record<string, string>;
  /** Creation time (ISO 8601) when the API reports it; used for orphan age. */
  createdAt?: string;
};

// exit_code is `number | undefined`, not defaulted: Fly can return a reshaped or
// truncated /exec body with no code at all, and that third state (never reported)
// must stay distinguishable from an observed 0. Every consumer treats absence as a
// hard failure; a sentinel like 0 would mint an unproven pass under a security gate.
export type FlyExecResult = { exit_code: number | undefined; stdout: string; stderr: string };

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
  /**
   * Enumerate machines in an app, for orphan reconciliation. Optional: a client
   * that cannot list (older mocks) yields no reconciliation capability rather
   * than a hard failure.
   */
  listMachines?(input: { app: string }): Promise<FlyMachine[]>;
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
  /** Bounded-backoff policy for transient (429/5xx) Fly API failures. */
  retry?: FlyRetryOptions;
  /** Signed production authority for the app-level default-deny egress policy. */
  egressAuthority?: SandboxEgressAuthorityConfig;
};

export const FLY_SANDBOX_DEFAULTS = {
  // Deliberately NO default image. The sandbox image IS the isolation boundary,
  // so it must be an immutable, reviewed, digest-pinned reference supplied via
  // MENDPOINT_SANDBOX_FLY_IMAGE (or fly.image). A floating `:latest` default here
  // would be fail-OPEN: the artifact enforcing the isolation guarantee could
  // change with no review, no reproducibility, and nothing to audit. When no
  // pinned image resolves the live path fails closed (see resolveSandboxImage).
  // Built from Dockerfile.sandbox and pushed by scripts/build-sandbox-image.mjs;
  // see docs/SANDBOX_IMAGE.md.
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
  /** Ids of Machines whose teardown failed and that are therefore leaked. */
  leakedMachineIds: () => string[];
  /**
   * Sweep orphaned Machines left behind on the app (e.g. by a crashed worker).
   * This handle's in-flight Machines are always protected automatically.
   */
  reconcileOrphans: (input?: {
    protectIds?: Iterable<string>;
    olderThanMs?: number;
    now?: number;
  }) => Promise<OrphanReconcileResult>;
};

export class FlySandboxError extends Error {
  readonly stage: "create" | "wait" | "exec" | "destroy" | "list";
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

/**
 * A Fly API failure is transient ONLY for 429 (rate limit) and 5xx (server).
 * Everything else — a deterministic 4xx (bad request, not found, forbidden), a
 * missing credential, or any non-Fly error — is a product/deterministic failure
 * that retrying would only mask. Mirrors the transient-vs-deterministic split in
 * `classifyJobFailure` (apps/worker) and the retryable set in the router.
 */
export function isTransientFlyError(e: unknown): boolean {
  if (e instanceof FlySandboxError) {
    return e.status === 429 || (e.status >= 500 && e.status <= 599);
  }
  return false;
}

export type FlyRetryOptions = {
  /** Total attempts including the first (>=1). Default 4. */
  maxAttempts?: number;
  /** First backoff step in ms; doubles each attempt. Default 250. */
  baseMs?: number;
  /** Backoff ceiling in ms. Default 10_000. */
  maxMs?: number;
  /** Injectable delay (tests pass a no-op / fast sleep). */
  sleep?: (ms: number) => Promise<void>;
};

const FLY_RETRY_DEFAULTS = { maxAttempts: 4, baseMs: 250, maxMs: 10_000 } as const;

/**
 * Bounded exponential backoff (base * 2**n, capped). Same shape as the job
 * queue's `boundedDelayMs` (packages/db) so backoff behaviour is consistent
 * across the system rather than reinvented here.
 */
function flyBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const base = Math.max(1, baseMs);
  const ceiling = Math.max(base, maxMs);
  const exponent = Math.max(0, Math.min(attempt - 1, 16));
  return Math.min(ceiling, base * 2 ** exponent);
}

/**
 * Run a Fly API operation with bounded retry. ONLY transient failures (429/5xx)
 * are retried; a deterministic 4xx or any non-Fly error is re-thrown on the
 * first occurrence so a real product failure is never buried under retries.
 */
export async function withFlyRetry<T>(
  op: () => Promise<T>,
  options: FlyRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? FLY_RETRY_DEFAULTS.maxAttempts);
  const baseMs = options.baseMs ?? FLY_RETRY_DEFAULTS.baseMs;
  const maxMs = options.maxMs ?? FLY_RETRY_DEFAULTS.maxMs;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op();
    } catch (e) {
      lastError = e;
      if (attempt >= maxAttempts || !isTransientFlyError(e)) throw e;
      await sleep(flyBackoffMs(attempt, baseMs, maxMs));
    }
  }
  throw lastError;
}

function clip(s: string, max: number): string {
  return String(s).slice(0, max);
}

function toCommand(cmd: string): string[] {
  // Fly's Machines /exec endpoint starts as root even when the OCI image has a
  // non-root USER. The sandbox image includes util-linux's runuser and the
  // unprivileged node account (uid 1000), so make the privilege drop part of
  // every remotely executed verification command. Keeping this in the command
  // envelope makes the invariant apply to both the REST client and injected
  // clients, rather than relying on an unsupported /exec `user` field.
  return ["/usr/sbin/runuser", "-u", "node", "--", "/bin/sh", "-c", cmd];
}

function posixJoin(base: string, rel: string): string {
  const trimmed = rel.replace(/^\.\//, "").replace(/\\/g, "/");
  return `${base.replace(/\/$/, "")}/${trimmed.replace(/^\//, "")}`;
}

/**
 * Exact bytes for a seed-file value. A string is encoded as UTF-8; raw bytes
 * (`Uint8Array`/`Buffer`) are copied verbatim. This is the seam that keeps
 * binary files (images, compiled artifacts, `.so`/`.dll`, PDFs) byte-accurate:
 * the `config.files.raw_value` base64 below is taken over these exact bytes, so
 * the Machine decodes back to the original content with no UTF-8 mangling.
 */
function toBytes(content: string | Uint8Array): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
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
      raw_value: toBytes(content).toString("base64"),
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

/**
 * Attempt teardown of a Machine. Returns `true` only when the destroy actually
 * succeeded. A failure is NOT swallowed silently: it never throws out of a
 * finally block, but the boolean lets the caller surface the leak (a Machine we
 * could not destroy is both a billing liability and an isolation liability, and
 * must never coexist with a green verification result).
 */
async function safeDestroy(
  client: FlyMachineClient,
  app: string,
  id: string,
  retry?: FlyRetryOptions,
): Promise<{ destroyed: true } | { destroyed: false; error: string }> {
  try {
    await withFlyRetry(() => client.destroyMachine({ app, id }), retry);
    return { destroyed: true };
  } catch (e) {
    return { destroyed: false, error: errMsg(e) };
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
 * An immutable, digest-pinned image reference: `<name>@sha256:<64 lowercase hex>`.
 * A mutable tag (`:latest`, `:v1`, any tag) is refused because the pulled artifact
 * behind a tag can change with no review — and that artifact IS the isolation
 * boundary. Digests are canonical lowercase hex (docker/OCI), so the match is
 * case-sensitive on purpose.
 */
const DIGEST_PINNED_IMAGE = /@sha256:[0-9a-f]{64}$/;

/**
 * Explicit, LOUD escape hatch for local/dev use ONLY: allow a non-digest-pinned
 * (tag-based) sandbox image on the live path. Its name is deliberately alarming so
 * that enabling it is a conscious act, never a silent default. Production never
 * sets it; the strict digest-pin requirement is the default. It only relaxes the
 * pin — it never permits an absent image and never enables host fallback.
 */
export function sandboxAllowUnpinnedImage(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.MENDPOINT_SANDBOX_ALLOW_UNPINNED_IMAGE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Resolve and validate the sandbox image, fail-closed. The resolution chain that
 * feeds this (`fly.image` -> MENDPOINT_SANDBOX_FLY_IMAGE) has NO floating default,
 * so an unset image arrives here as undefined rather than silently becoming
 * `:latest`.
 *
 * On the live path the image is the artifact actually pulled to enforce isolation,
 * so it MUST be present and digest-pinned; an absent or tag-based image is refused
 * (the `allowUnpinned` dev escape hatch relaxes only the pin, never presence).
 *
 * The mock client is a deterministic in-memory dry-run that never pulls an image,
 * so on that path the image string is not the isolation boundary and is not
 * validated. The mock client can only be reached deliberately (an injected client,
 * or an explicitly forced mock mode); a live selection that falls back to mock for
 * a missing token already fails closed upstream (see the isolationUnavailable
 * guard), so this exemption cannot become a silent host/mock bypass.
 */
export function resolveSandboxImage(input: {
  image: string | undefined;
  mode: "live" | "mock";
  allowUnpinned?: boolean;
}): { ok: true; image: string } | { ok: false; stderr: string } {
  const image = input.image?.trim();
  if (input.mode === "mock") {
    // Never pulled; value is cosmetic on the mock path.
    return { ok: true, image: image && image.length > 0 ? image : "mock" };
  }
  if (!image) {
    return {
      ok: false,
      stderr:
        "fly_machines: sandbox_image_unresolved: no sandbox image configured; set MENDPOINT_SANDBOX_FLY_IMAGE to a digest-pinned image (registry.fly.io/mendpoint-sandbox@sha256:<64 hex>); refusing host fallback",
    };
  }
  if (!DIGEST_PINNED_IMAGE.test(image)) {
    if (input.allowUnpinned) return { ok: true, image };
    return {
      ok: false,
      stderr:
        "fly_machines: sandbox_image_not_pinned: sandbox image must be digest-pinned (name@sha256:<64 hex>), not a mutable tag; push the image, capture its digest, and pin it in the reviewed config (see docs/SANDBOX_IMAGE.md); set MENDPOINT_SANDBOX_ALLOW_UNPINNED_IMAGE=1 to allow an unpinned image for local dev only; refusing host fallback",
    };
  }
  return { ok: true, image };
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
  // Fail-closed guard: a mock client is NEVER real isolation. Its exec mints
  // exit_code 0 without running the command, so a mock result is not evidence of
  // anything. It is legitimate only as an explicitly injected test / dry-run
  // double (opts.flyClient). Reached any other way — a forced
  // MENDPOINT_SANDBOX_FLY_MODE=mock, or the credential fallback when no token
  // resolves — verification refuses to run rather than mint a fabricated green
  // (repro of #99). This holds regardless of NODE_ENV; the production env guard
  // (packages/ops/src/env.ts) is the discoverable boot-time refusal on top.
  const isolationUnavailable = !opts.flyClient && client.mode !== "live";
  const mockModeForced = process.env.MENDPOINT_SANDBOX_FLY_MODE === "mock";
  const region =
    flyOpts.region ?? process.env.MENDPOINT_SANDBOX_FLY_REGION ?? FLY_SANDBOX_DEFAULTS.region;
  // Resolution chain terminates in undefined (no floating `:latest` default). The
  // image is validated fail-closed: an unset or tag-based image is refused on the
  // live path so an unreviewed, mutable artifact can never become the isolation
  // boundary. Computed once here (mirrors the isolationUnavailable guard) and
  // surfaced as a fail-closed run result in runIsolated below.
  const imageResolution = resolveSandboxImage({
    image: flyOpts.image ?? process.env.MENDPOINT_SANDBOX_FLY_IMAGE,
    mode: client.mode,
    allowUnpinned: sandboxAllowUnpinnedImage(process.env),
  });
  const guest: FlyGuest = {
    cpu_kind: flyOpts.resources?.cpuKind ?? FLY_SANDBOX_DEFAULTS.cpuKind,
    cpus: flyOpts.resources?.cpus ?? FLY_SANDBOX_DEFAULTS.cpus,
    memory_mb: flyOpts.resources?.memoryMb ?? FLY_SANDBOX_DEFAULTS.memoryMb,
  };
  const capMs = flyOpts.capMs ?? FLY_SANDBOX_DEFAULTS.capMs;
  const startTimeoutMs = flyOpts.startTimeoutMs ?? FLY_SANDBOX_DEFAULTS.startTimeoutMs;
  const execTimeoutMs = flyOpts.execTimeoutMs ?? FLY_SANDBOX_DEFAULTS.execTimeoutMs;
  const retryOptions = flyOpts.retry;
  const configuredEgressAuthority = flyOpts.egressAuthority ?? sandboxEgressAuthorityFromEnv();
  const egressAuthority = Object.freeze({
    attestationBase64: configuredEgressAuthority.attestationBase64,
    publicKeySpkiBase64: configuredEgressAuthority.publicKeySpkiBase64,
    expectedKeyId: configuredEgressAuthority.expectedKeyId,
    expectedPolicyDigest: configuredEgressAuthority.expectedPolicyDigest,
    minimumSchemaVersion: configuredEgressAuthority.minimumSchemaVersion,
    now: configuredEgressAuthority.now,
  });

  const validateEgressAuthority = (image: string): string | undefined => {
    if (client.mode !== "live") return undefined;
    try {
      const observedAt = egressAuthority.now?.() ?? new Date().toISOString();
      verifySandboxEgressAttestation({
        ...egressAuthority,
        expectedApp: app ?? "",
        expectedImage: image,
        observedAt,
      });
      return undefined;
    } catch (error) {
      return errMsg(error);
    }
  };

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
  // Machines whose teardown failed even after retry. A leaked microVM is a
  // billing + isolation liability, so it is tracked (never silently dropped) for
  // the orphan sweep and surfaced as a run failure.
  const leakedMachines = new Set<string>();

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
      // fail-closed: the resolved client is a mock, which would only fake
      // success. Refuse rather than silently skip real isolation. A forced mock
      // mode and a missing token surface distinct guidance, but both refuse.
      return {
        ok: false,
        stdout: "",
        stderr: mockModeForced
          ? "fly_machines: MENDPOINT_SANDBOX_FLY_MODE=mock cannot produce verification evidence; the mock reports a pass without running the command; refusing host fallback"
          : "fly_machines: no sandbox Fly token resolved; set MENDPOINT_SANDBOX_FLY_TOKEN; refusing host fallback",
        exitCode: -1,
      };
    }

    if (!imageResolution.ok) {
      // fail-closed: the sandbox image is the isolation boundary. An unset or
      // tag-based image is refused so no Machine is created from an unreviewed,
      // mutable artifact and the run never degrades to the shared host.
      return {
        ok: false,
        stdout: "",
        stderr: imageResolution.stderr,
        exitCode: -1,
      };
    }
    const image = imageResolution.image;

    const initialEgressError = validateEgressAuthority(image);
    if (initialEgressError) {
      return {
        ok: false,
        stdout: "",
        stderr: `fly_machines: ${initialEgressError}; refusing host fallback`,
        exitCode: -1,
      };
    }

    let machine: FlyMachine;
    try {
      // Transient (429/5xx) create failures back off and retry; a deterministic
      // 4xx or non-Fly error still throws straight through to fail-closed.
      machine = await withFlyRetry(
        () =>
          client.createMachine({
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
          }),
        retryOptions,
      );
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
    let result: SandboxRunResult | undefined;
    try {
      await withFlyRetry(
        () =>
          client.waitForState({
            app,
            id: machine.id,
            state: "started",
            timeoutMs: startTimeoutMs,
          }),
        retryOptions,
      );

      const currentEgressError = validateEgressAuthority(image);
      if (currentEgressError) {
        result = {
          ok: false,
          stdout: "",
          stderr: `fly_machines: ${currentEgressError}; refusing host fallback`,
          exitCode: -1,
        };
      } else if (client.mode === "live") {
        const probeTimeoutMs = Math.min(5_000, timeoutMs);
        const forbiddenProbe = await withCap(
          client.exec({
            app,
            id: machine.id,
            command: toCommand(SANDBOX_EGRESS_FORBIDDEN_PROBE_COMMAND),
            timeoutMs: probeTimeoutMs,
          }),
          probeTimeoutMs,
        );
        if (
          forbiddenProbe.timedOut ||
          typeof forbiddenProbe.value.exit_code !== "number" ||
          forbiddenProbe.value.exit_code !== 0
        ) {
          result = {
            ok: false,
            stdout: "",
            stderr: "fly_machines: sandbox_egress_policy_unverified: forbidden outbound access was reachable or could not be proven blocked; refusing customer command",
            exitCode: -1,
          };
        } else {
          const allowedProbe = await withCap(
            client.exec({
              app,
              id: machine.id,
              command: toCommand(SANDBOX_EGRESS_ALLOWED_PROBE_COMMAND),
              timeoutMs: probeTimeoutMs,
            }),
            probeTimeoutMs,
          );
          if (
            allowedProbe.timedOut ||
            typeof allowedProbe.value.exit_code !== "number" ||
            allowedProbe.value.exit_code !== 0
          ) {
            result = {
              ok: false,
              stdout: "",
              stderr: "fly_machines: sandbox_egress_policy_unverified: allowed local verification probe did not pass; refusing customer command",
              exitCode: -1,
            };
          }
        }
      }

      if (!result) {
        const capped = await withCap(
          // exec is intentionally single-shot (not retried): re-running a customer
          // verification command on a transient response could double its effects.
          client.exec({ app, id: machine.id, command: toCommand(cmd), timeoutMs }),
          capMs,
        );
        if (capped.timedOut) {
          result = {
            ok: false,
            stdout: "",
            stderr: `fly_machines: run exceeded cap ${capMs}ms; Machine ${machine.id} killed`,
            exitCode: 124,
            timedOut: true,
          };
        } else {
          const exec = capped.value;
          result = {
            // An absent exit code is never a pass: only an observed 0 is green.
            ok: typeof exec.exit_code === "number" && exec.exit_code === 0,
            stdout: clip(exec.stdout, 8000),
            stderr: clip(exec.stderr, 4000),
            exitCode: exec.exit_code,
          };
        }
      }
    } catch (e) {
      // fail-closed on wait/exec failure: error, never run on the shared host.
      result = {
        ok: false,
        stdout: "",
        stderr: `fly_machines: isolation could not be established (run): ${errMsg(e)}; refusing host fallback`,
        exitCode: -1,
      };
    } finally {
      // Teardown is mandatory. A destroy that fails even after retry is NOT
      // swallowed: the Machine is recorded as leaked and the run is forced to
      // fail so a leaked microVM can never coexist with a green result.
      const teardown = await safeDestroy(client, app, machine.id, retryOptions);
      if (teardown.destroyed) {
        activeMachines.delete(machine.id);
      } else {
        leakedMachines.add(machine.id);
        activeMachines.delete(machine.id);
        result = {
          ok: false,
          stdout: "",
          stderr: `fly_machines: sandbox_machine_not_destroyed: Machine ${machine.id} could not be torn down (${teardown.error}); leaked microVM`,
          exitCode: -1,
        };
      }
    }
    return result ?? {
      ok: false,
      stdout: "",
      stderr: "fly_machines: sandbox execution ended without an authoritative result; refusing host fallback",
      exitCode: -1,
    };
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
        for (const id of activeMachines) {
          void safeDestroy(client, app, id, retryOptions).then((t) => {
            if (!t.destroyed) leakedMachines.add(id);
          });
        }
      }
      activeMachines.clear();
      base.dispose();
    },
    destroy: async () => {
      if (app) {
        await Promise.all(
          [...activeMachines].map(async (id) => {
            const t = await safeDestroy(client, app, id, retryOptions);
            if (!t.destroyed) leakedMachines.add(id);
          }),
        );
      }
      activeMachines.clear();
      base.dispose();
    },
    activeMachineIds: () => [...activeMachines],
    leakedMachineIds: () => [...leakedMachines],
    reconcileOrphans: (input) =>
      app
        ? reconcileOrphanedMachines({
            client,
            app,
            protectIds: [...activeMachines, ...input?.protectIds ?? []],
            olderThanMs: input?.olderThanMs,
            now: input?.now,
            retry: retryOptions,
          })
        : Promise.resolve({
            supported: false,
            scanned: 0,
            orphans: [],
            destroyed: [],
            failed: [],
          }),
  };
}

/* ------------------------------------------------------------------ */
/* Orphan reconciliation (sweep machines a crashed worker left behind) */
/* ------------------------------------------------------------------ */

export type OrphanReconcileResult = {
  /** False when the client cannot enumerate machines (no listMachines). */
  supported: boolean;
  /** Machines tagged as ours that were examined. */
  scanned: number;
  /** Ids identified as orphans (tagged, unprotected, over-age). */
  orphans: string[];
  /** Ids actually destroyed. */
  destroyed: string[];
  /** Orphans whose teardown still failed (remain leaked). */
  failed: Array<{ id: string; error: string }>;
};

/**
 * Identify and destroy Fly Machines left behind by a crashed worker.
 *
 * Safe on a shared app: only machines carrying our `mendpoint_sandbox` metadata
 * tag are ever considered, machines in the caller's `protectIds` are never
 * touched, and — because every run is wall-clock capped — a machine is treated
 * as an orphan only once its age exceeds `olderThanMs` (default: the run cap),
 * so a peer worker's in-flight run cannot be swept out from under it. A machine
 * whose creation time is unknown is destroyed only when `olderThanMs <= 0` is
 * requested explicitly.
 */
export async function reconcileOrphanedMachines(input: {
  client: FlyMachineClient;
  app: string;
  protectIds?: Iterable<string>;
  olderThanMs?: number;
  now?: number;
  retry?: FlyRetryOptions;
}): Promise<OrphanReconcileResult> {
  const { client, app } = input;
  if (typeof client.listMachines !== "function") {
    return { supported: false, scanned: 0, orphans: [], destroyed: [], failed: [] };
  }
  const olderThanMs = input.olderThanMs ?? FLY_SANDBOX_DEFAULTS.capMs;
  const now = input.now ?? Date.now();
  const protect = new Set(input.protectIds ?? []);

  const machines = await withFlyRetry(() => client.listMachines!({ app }), input.retry);
  const ours = machines.filter((m) => Boolean(m.metadata?.mendpoint_sandbox));
  const eligible = (m: FlyMachine): boolean => {
    if (protect.has(m.id)) return false;
    if (olderThanMs <= 0) return true;
    if (!m.createdAt) return false;
    const created = Date.parse(m.createdAt);
    if (Number.isNaN(created)) return false;
    return now - created >= olderThanMs;
  };
  const orphans = ours.filter(eligible);

  const destroyed: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const m of orphans) {
    const t = await safeDestroy(client, app, m.id, input.retry);
    if (t.destroyed) destroyed.push(m.id);
    else failed.push({ id: m.id, error: t.error });
  }
  return {
    supported: true,
    scanned: ours.length,
    orphans: orphans.map((m) => m.id),
    destroyed,
    failed,
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
  /** Force teardown to fail — for exercising the leaked-microVM path. Returns an
   *  error (constant, or per-id) to throw from destroyMachine, or undefined to
   *  let the destroy succeed. */
  destroyError?: Error | ((id: string) => Error | undefined);
  /** ISO creation time stamped on each created machine (default: now). */
  createdAt?: string;
};

export type MockFlyClient = FlyMachineClient & {
  readonly created: Array<{ id: string; config: FlyMachineConfig }>;
  readonly destroyed: string[];
  readonly execed: string[];
  isDestroyed: (id: string) => boolean;
  isLive: (id: string) => boolean;
  listMachines(input: { app: string }): Promise<FlyMachine[]>;
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
  const meta = new Map<string, { metadata?: Record<string, string>; createdAt: string }>();

  const destroyErrorFor = (id: string): Error | undefined =>
    typeof behavior.destroyError === "function"
      ? behavior.destroyError(id)
      : behavior.destroyError;

  return {
    mode: "mock",
    async createMachine({ config }) {
      if (behavior.createError) throw behavior.createError;
      const id = `fly-mock-${++seq}`;
      created.push({ id, config });
      live.add(id);
      meta.set(id, {
        metadata: config.metadata,
        createdAt: behavior.createdAt ?? new Date().toISOString(),
      });
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
      const err = destroyErrorFor(id);
      if (err) throw err;
      destroyed.push(id);
      live.delete(id);
    },
    async listMachines() {
      return [...live].map((id) => ({
        id,
        state: "started",
        metadata: meta.get(id)?.metadata,
        createdAt: meta.get(id)?.createdAt,
      }));
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

type FlyRestMachineJson = {
  id?: string;
  state?: string;
  region?: string;
  created_at?: string;
  config?: { metadata?: Record<string, string> };
};

function toFlyMachine(j: FlyRestMachineJson, fallbackState = "created"): FlyMachine {
  return {
    id: j.id ?? "",
    state: j.state ?? fallbackState,
    region: j.region,
    metadata: j.config?.metadata,
    createdAt: j.created_at,
  };
}

export function createFlyRestClient(cfg: {
  token: string;
  apiBase?: string;
  fetchImpl?: FetchImpl;
  /** Bounded-backoff policy for transient (429/5xx) failures. */
  retry?: FlyRetryOptions;
}): FlyMachineClient {
  const apiBase = cfg.apiBase ?? "https://api.machines.dev";
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const retry = cfg.retry;
  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${cfg.token}`,
    "Content-Type": "application/json",
  });
  const appUrl = (app: string): string =>
    `${apiBase}/v1/apps/${encodeURIComponent(app)}/machines`;

  return {
    mode: "live",
    // Control-plane calls (create/wait/destroy/list) retry transient 429/5xx via
    // withFlyRetry; a deterministic 4xx throws through unretried.
    createMachine({ app, region, config }) {
      return withFlyRetry(async () => {
        const res = await fetchImpl(appUrl(app), {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ region, config }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new FlySandboxError("create", res.status, await safeText(res));
        const j = (await res.json()) as FlyRestMachineJson;
        if (!j.id) throw new FlySandboxError("create", res.status, "response missing machine id");
        return toFlyMachine(j);
      }, retry);
    },
    waitForState({ app, id, state, timeoutMs }) {
      const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
      return withFlyRetry(async () => {
        const res = await fetchImpl(
          `${appUrl(app)}/${encodeURIComponent(id)}/wait?state=${state}&timeout=${seconds}`,
          { headers: headers(), signal: AbortSignal.timeout(timeoutMs + 5_000) },
        );
        if (!res.ok) throw new FlySandboxError("wait", res.status, await safeText(res));
      }, retry);
    },
    // exec is intentionally NOT retried: re-running a customer verification
    // command on a transient response could double its side effects.
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
        // No default: an absent code is reported as undefined so consumers can fail closed.
        exit_code: typeof j.exit_code === "number" ? j.exit_code : undefined,
        stdout: j.stdout ?? "",
        stderr: j.stderr ?? "",
      };
    },
    destroyMachine({ app, id }) {
      return withFlyRetry(async () => {
        const res = await fetchImpl(`${appUrl(app)}/${encodeURIComponent(id)}?force=true`, {
          method: "DELETE",
          headers: headers(),
          signal: AbortSignal.timeout(30_000),
        });
        // 404 means the Machine is already gone — acceptable for idempotent teardown.
        if (!res.ok && res.status !== 404) {
          throw new FlySandboxError("destroy", res.status, await safeText(res));
        }
      }, retry);
    },
    listMachines({ app }) {
      return withFlyRetry(async () => {
        const res = await fetchImpl(appUrl(app), {
          headers: headers(),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new FlySandboxError("list", res.status, await safeText(res));
        const j = (await res.json()) as FlyRestMachineJson[];
        return (Array.isArray(j) ? j : [])
          .filter((m): m is FlyRestMachineJson => Boolean(m?.id))
          .map((m) => toFlyMachine(m, "started"));
      }, retry);
    },
  };
}
