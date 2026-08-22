/**
 * Sandbox dispatch for verification execution.
 *
 * When a real sandbox backend is configured (currently `fly_machines`), an
 * operator-approved verification command is executed inside a per-run, isolated
 * Fly Machine rather than via host `execFile` in the worker container. This is
 * the containment layer the residual-risk note in {@link ./verify.ts} calls for:
 * the customer's own test command (`npm test`, `pytest`, ...) that #111 lets an
 * operator approve cannot accept Node's `--permission` flags, so without this it
 * would run next to our secrets. Here it runs in a microVM instead.
 *
 * Fail-closed by construction: if the sandbox backend cannot establish real
 * isolation (missing credential/app, create/exec failure, or an oversized
 * workspace we cannot hand over intact), verification FAILS. It NEVER silently
 * falls back to host execution — that silent fallback already produced a
 * fake-green once (#99).
 *
 * The seam is deliberately additive: {@link runVerificationCommand} routes here
 * only after its production approval gates pass, so the sandbox is an extra
 * containment layer, never a replacement for operator approval.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  createSandbox,
  resolveSandboxKind,
  type CreateSandboxOpts,
  type FlyMachineClient,
  type SandboxHandle,
  type SandboxKind,
  type SandboxRunResult,
} from "@mendpoint/platform";
import type { VerificationExecution } from "./verify.js";

/** The backend kinds a sandbox run may legitimately report having executed under. */
const KNOWN_SANDBOX_BACKENDS: ReadonlySet<SandboxKind> = new Set<SandboxKind>([
  "local",
  "vm",
  "in_cluster",
  "fly_machines",
]);

/**
 * Directories that are never source and dwarf a real repo tree (installed
 * dependencies, build outputs, VCS metadata). Mirrors
 * `EXCLUDED_DIRECTORIES`/`walkCodeFiles` skip lists elsewhere in the monorepo;
 * kept local so `@mendpoint/repair` does not take a dependency on
 * `@mendpoint/agent` for this constant.
 */
const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".turbo",
  ".venv",
]);

/**
 * Bounds for the inline-files handoff. The workspace is uploaded to the Machine
 * as base64 `config.files` at create time, so it must fit a sane inline budget.
 * A tree past these bounds fails closed rather than being silently truncated —
 * verifying a partial workspace would be a fake result.
 */
const MAX_WORKSPACE_FILES = 5_000;
const MAX_WORKSPACE_BYTES = 8 * 1024 * 1024;

export type VerificationSandboxOptions = {
  /** Tenant identity — tags the Machine; only this tenant's files are uploaded. */
  tenantId?: string;
  /**
   * Test / dry-run seam: inject a Fly client so no real credential or network is
   * needed. Mirrors `CreateSandboxOpts.flyClient`.
   */
  flyClient?: FlyMachineClient;
};

/** The effective sandbox backend for verification (reads MENDPOINT_SANDBOX_KIND). */
export function configuredSandboxKind(): SandboxKind {
  return resolveSandboxKind();
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Read the repository working tree into a relative-path → content map suitable
 * for {@link createSandbox}'s `files` option. Excluded directories and symlinks
 * are skipped; the caps above are enforced. Returns an error string (never
 * throws) when the tree cannot be handed over intact, so the caller fails closed.
 */
function collectRepoWorkspace(
  repoRoot: string,
): { ok: true; files: Record<string, Buffer> } | { ok: false; error: string } {
  let root: string;
  try {
    root = realpathSync(resolve(repoRoot));
  } catch (e) {
    return { ok: false, error: `workspace root is unavailable: ${String(e)}` };
  }
  const files: Record<string, Buffer> = {};
  let totalBytes = 0;
  let count = 0;

  const stack: string[] = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch (e) {
      return { ok: false, error: `workspace directory could not be read: ${String(e)}` };
    }
    for (const name of entries) {
      const abs = join(current, name);
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        continue;
      }
      // Skip symlinks entirely — never follow a link out of the workspace.
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(name)) continue;
        stack.push(abs);
        continue;
      }
      if (!stat.isFile()) continue;
      const rel = relative(root, abs).replace(/\\/g, "/");
      if (!rel || !isWithin(root, abs)) continue;
      count += 1;
      totalBytes += stat.size;
      if (count > MAX_WORKSPACE_FILES) {
        return {
          ok: false,
          error: `workspace exceeds ${MAX_WORKSPACE_FILES} files; cannot hand it to the sandbox intact`,
        };
      }
      if (totalBytes > MAX_WORKSPACE_BYTES) {
        return {
          ok: false,
          error: `workspace exceeds ${MAX_WORKSPACE_BYTES} bytes; cannot hand it to the sandbox intact`,
        };
      }
      try {
        // Read as raw bytes, never as UTF-8 text. A binary file in a customer
        // repo (image, compiled artifact, fixture, `.so`/`.dll`, PDF) would be
        // silently corrupted by a UTF-8 decode/re-encode round-trip, and the
        // sandbox would then verify a mangled workspace. Bytes transfer verbatim.
        files[rel] = readFileSync(abs);
      } catch (e) {
        return { ok: false, error: `workspace file could not be read (${rel}): ${String(e)}` };
      }
    }
  }
  return { ok: true, files };
}

function failClosed(stderr: string): VerificationExecution {
  // Containment could not be established, so the command never ran: not_verified,
  // and no backend was established. This is never a test failure.
  return {
    ok: false,
    stdout: "",
    stderr,
    exitCode: -1,
    error: stderr,
    outcome: "not_verified",
    sandboxBackend: null,
  };
}

/**
 * Map a sandbox {@link SandboxRunResult} to a three-state {@link VerificationExecution}.
 *
 * The recorded backend is read from what the executor REPORTS it ran under
 * (`result.backend`), never from the configuration that requested the run — a
 * field that echoes its own input proves nothing. Fail closed on both edges:
 *
 *  - an absent or unrecognised backend means the executor cannot name what it
 *    ran (or nothing ran), so the outcome is `not_verified` even if the result
 *    claims `ok: true` — an unreportable backend never yields `verified`;
 *  - otherwise the observed backend is recorded and the run is `verified`/`failed`
 *    strictly by whether the command passed.
 *
 * Exported so the classification itself is unit-testable against fabricated run
 * results without a live sandbox.
 */
export function classifySandboxRunResult(result: SandboxRunResult): VerificationExecution {
  const observed = result.backend;
  if (observed === undefined || !KNOWN_SANDBOX_BACKENDS.has(observed)) {
    const stderr =
      result.stderr ||
      "sandbox verification refused: executor did not report which backend it ran; refusing to record a result";
    return {
      ok: false,
      stdout: result.stdout,
      stderr,
      exitCode: typeof result.exitCode === "number" ? result.exitCode : -1,
      error: stderr,
      outcome: "not_verified",
      sandboxBackend: null,
    };
  }
  const exitCode =
    typeof result.exitCode === "number" ? result.exitCode : result.ok ? 0 : 1;
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode,
    error: result.ok ? undefined : result.stderr || "sandbox verification failed",
    outcome: result.ok ? "verified" : "failed",
    sandboxBackend: observed,
  };
}

/**
 * Execute a verification command inside an isolated sandbox Machine.
 *
 * The workspace tree is uploaded to the Machine (at `/workspace`), the command
 * runs there via the backend's async `runIsolated`, and the result is mapped
 * back into a {@link VerificationExecution}. Host `process.env` is never handed
 * to the Machine — the Fly backend seeds no environment from the host — so the
 * production secret scrub holds on this path as well.
 */
export async function runVerificationInSandbox(input: {
  command: string;
  repoRoot: string;
  timeoutMs: number;
  options?: VerificationSandboxOptions;
  /**
   * Test seam: inject the sandbox factory. Defaults to the real
   * {@link createSandbox}. Mirrors the existing `flyClient` injection and lets a
   * test prove the recorded backend follows the RUN even when it differs from the
   * forced `kind: "fly_machines"` configuration below.
   */
  createSandboxImpl?: (opts: CreateSandboxOpts) => SandboxHandle;
}): Promise<VerificationExecution> {
  const { command, repoRoot, timeoutMs } = input;
  if (!existsSync(repoRoot)) {
    return failClosed(`sandbox verification refused: workspace ${repoRoot} does not exist`);
  }

  const workspace = collectRepoWorkspace(repoRoot);
  if (!workspace.ok) {
    return failClosed(`sandbox verification refused: ${workspace.error}; refusing host fallback`);
  }

  const opts: CreateSandboxOpts = {
    // Force the configured real backend; do not let opts precedence downgrade it.
    kind: "fly_machines",
    prefix: "mendpoint-verify-",
    files: workspace.files,
    tenantId: input.options?.tenantId,
    // Env is intentionally NOT forwarded: the Machine gets no host secrets.
    fly: { execTimeoutMs: timeoutMs, capMs: timeoutMs },
    flyClient: input.options?.flyClient,
  };

  const create = input.createSandboxImpl ?? createSandbox;
  let handle: SandboxHandle;
  try {
    handle = create(opts);
  } catch (e) {
    return failClosed(`sandbox verification refused: ${String(e)}; refusing host fallback`);
  }
  if (typeof handle.runIsolated !== "function") {
    handle.dispose();
    return failClosed(
      "sandbox verification refused: backend does not support isolated execution; refusing host fallback",
    );
  }

  try {
    // The command was already parsed/approved by verify.ts (no shell
    // metacharacters, allowlisted or operator-approved), so wrapping it to run in
    // the uploaded /workspace directory is safe. The Machine's /bin/sh runs it.
    const result = await handle.runIsolated(`cd /workspace && ${command}`, { timeoutMs });
    // The backend is read from what the run REPORTED, not from the forced
    // `kind: "fly_machines"` above: a result that cannot name its backend is
    // not_verified, never a pass.
    return classifySandboxRunResult(result);
  } catch (e) {
    // A thrown isolation failure is still fail-closed: never run on the host.
    return failClosed(
      `sandbox verification refused: isolation error ${String(e)}; refusing host fallback`,
    );
  } finally {
    handle.dispose();
  }
}
