import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  configuredSandboxKind,
  runVerificationInSandbox,
  type VerificationSandboxOptions,
} from "./verify-sandbox.js";

export type VerificationInvocation = {
  executable: string;
  args: string[];
  profile:
    | "npm-test"
    | "npm-build"
    | "npm-typecheck"
    | "npm-lint"
    | "node-check"
    | "pytest"
    | "go-test"
    | "cargo-test"
    | "maven-test"
    | "gradle-test"
    | "rspec";
};

export type VerificationExecution = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
};

const SIMPLE_TOKEN = /^[A-Za-z0-9_./:@+-]+$/;
const NODE_CHECK = /^check\.(?:mjs|cjs|js)$/;

/** Operator-curated list of exact verification commands approved for production. */
const APPROVED_COMMANDS_ENV = "MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION";
/** Operator-curated list of SHA-256 hashes of node-check verifier files. */
const APPROVED_HASHES_ENV = "MENDPOINT_APPROVED_VERIFIER_SHA256S";

function normalizeVerificationCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function approvedVerifierHashes(): Set<string> {
  return new Set(
    (process.env[APPROVED_HASHES_ENV] ?? "")
      .split(",")
      .map((hash) => hash.trim().toLowerCase())
      .filter((hash) => /^[a-f0-9]{64}$/.test(hash)),
  );
}

/**
 * Operator override — the explicit, auditable allowlist of exact verification
 * commands an operator has approved to run in production against repositories we
 * did not write. Entries are exact commands, comma- or newline-separated, each
 * normalized the same way as {@link parseVerificationCommand} (trimmed, internal
 * whitespace collapsed) — for example `npm test`, `npm run typecheck`, or
 * `pytest`. Unset or empty means nothing is approved, so the production path
 * fails closed.
 *
 * The `node-check` profile is deliberately NOT approvable here: it executes a
 * verifier file directly under our Node runtime, so it is gated by content hash
 * ({@link APPROVED_HASHES_ENV}) instead. Approving `node check.mjs` by command
 * string alone would run arbitrary customer JavaScript without a reviewed hash.
 *
 * Approved commands still receive the scrubbed child environment (see the `env`
 * block below), so host secrets never reach them. They do run outside the Node
 * filesystem permission model that `node-check` gets, because npm/pytest/etc.
 * cannot accept those flags; that residual (filesystem/egress) risk is carried
 * by the sandbox backend and documented in docs/SANDBOX_VERIFIER.md.
 */
function approvedOperatorCommands(): Set<string> {
  return new Set(
    (process.env[APPROVED_COMMANDS_ENV] ?? "")
      .split(/[,\n]/)
      .map((command) => normalizeVerificationCommand(command))
      .filter((command) => command.length > 0),
  );
}

export function discoverVerificationCommands(repoRoot: string): string[] {
  for (const file of ["check.mjs", "check.cjs", "check.js"]) {
    if (existsSync(join(repoRoot, file))) return [`node ${file}`];
  }
  const packagePath = join(repoRoot, "package.json");
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
        scripts?: Record<string, unknown>;
      };
      const commands = ["typecheck", "test", "build"]
        .filter((name) => typeof pkg.scripts?.[name] === "string")
        .map((name) => (name === "test" || name === "build" ? `npm ${name}` : `npm run ${name}`));
      if (commands.length) return commands;
    } catch {
      return [];
    }
  }
  if (
    existsSync(join(repoRoot, "pytest.ini")) ||
    existsSync(join(repoRoot, "conftest.py")) ||
    existsSync(join(repoRoot, "tests"))
  ) {
    return ["pytest"];
  }
  if (existsSync(join(repoRoot, "go.mod"))) return ["go test ./..."];
  if (existsSync(join(repoRoot, "Cargo.toml"))) return ["cargo test"];
  return [];
}

function executable(name: string): string {
  if (process.platform !== "win32") return name;
  if (name === "npm") return "npm.cmd";
  if (name === "mvn") return "mvn.cmd";
  if (name === "gradle") return "gradle.bat";
  return name;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function containedExistingFile(repoRoot: string, file: string): boolean {
  if (!SIMPLE_TOKEN.test(file) || file.includes("..") || isAbsolute(file)) return false;
  const root = realpathSync(resolve(repoRoot));
  const candidate = resolve(root, file);
  if (!isWithin(root, candidate) || !existsSync(candidate)) return false;
  return isWithin(root, realpathSync(candidate));
}

/**
 * Convert a user supplied verification request into one of the supported,
 * argument based profiles. Shell syntax and arbitrary executables fail closed.
 */
export function parseVerificationCommand(
  command: string,
  repoRoot: string,
): VerificationInvocation | undefined {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (!normalized || /[;&|`<>\r\n]/.test(normalized)) return undefined;
  const tokens = normalized.split(" ");
  if (tokens.some((token) => !SIMPLE_TOKEN.test(token))) return undefined;

  if (
    tokens.length === 2 &&
    tokens[0] === "npm" &&
    ["test", "build"].includes(tokens[1])
  ) {
    return {
      executable: executable("npm"),
      args: [tokens[1]],
      profile: tokens[1] === "test" ? "npm-test" : "npm-build",
    };
  }
  if (
    tokens.length === 3 &&
    tokens[0] === "npm" &&
    tokens[1] === "run" &&
    ["test", "build", "typecheck", "lint"].includes(tokens[2])
  ) {
    return {
      executable: executable("npm"),
      args: ["run", tokens[2]],
      profile:
        tokens[2] === "test"
          ? "npm-test"
          : tokens[2] === "build"
            ? "npm-build"
            : tokens[2] === "typecheck"
              ? "npm-typecheck"
              : "npm-lint",
    };
  }
  if (
    tokens.length === 2 &&
    tokens[0] === "node" &&
    NODE_CHECK.test(tokens[1]) &&
    containedExistingFile(repoRoot, tokens[1])
  ) {
    return { executable: process.execPath, args: [tokens[1]], profile: "node-check" };
  }
  if (
    (normalized === "pytest" ||
      normalized === "python -m pytest" ||
      normalized === "python3 -m pytest")
  ) {
    if (tokens.length === 1) {
      return { executable: "pytest", args: [], profile: "pytest" };
    }
    return { executable: tokens[0], args: ["-m", "pytest"], profile: "pytest" };
  }
  if (normalized === "go test ./...") {
    return { executable: "go", args: ["test", "./..."], profile: "go-test" };
  }
  if (normalized === "cargo test") {
    return { executable: "cargo", args: ["test"], profile: "cargo-test" };
  }
  if (normalized === "mvn test") {
    return { executable: executable("mvn"), args: ["test"], profile: "maven-test" };
  }
  if (normalized === "gradle test" || normalized === "gradlew.bat test") {
    return {
      executable: normalized.startsWith("gradlew") ? "gradlew.bat" : executable("gradle"),
      args: ["test"],
      profile: "gradle-test",
    };
  }
  if (normalized === "./gradlew test" && containedExistingFile(repoRoot, "gradlew")) {
    return { executable: resolve(repoRoot, "gradlew"), args: ["test"], profile: "gradle-test" };
  }
  if (normalized === "bundle exec rspec") {
    return { executable: "bundle", args: ["exec", "rspec"], profile: "rspec" };
  }
  return undefined;
}

export function validateVerificationCommands(
  commands: string[],
  repoRoot: string,
): { ok: true; invocations: VerificationInvocation[] } | { ok: false; error: string } {
  const invocations: VerificationInvocation[] = [];
  for (const command of commands) {
    const invocation = parseVerificationCommand(command, repoRoot);
    if (!invocation) {
      return {
        ok: false,
        error: `Unsupported verification command: ${command}. Use a predefined verification profile.`,
      };
    }
    invocations.push(invocation);
  }
  return { ok: true, invocations };
}

export async function runVerificationCommand(
  command: string,
  repoRoot: string,
  timeoutMs = 120_000,
  signal?: AbortSignal,
  sandbox?: VerificationSandboxOptions,
): Promise<VerificationExecution> {
  const invocation = parseVerificationCommand(command, repoRoot);
  if (!invocation) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: 126,
      error: `Unsupported verification command: ${command}`,
    };
  }
  const boundedTimeout = Math.max(1_000, Math.min(timeoutMs, 300_000));
  const production = process.env.NODE_ENV === "production";
  if (production) {
    if (invocation.profile === "node-check") {
      // node-check runs a verifier file directly under our Node runtime, so its
      // content must match an operator-approved SHA-256 hash. Register a hash by
      // adding it to MENDPOINT_APPROVED_VERIFIER_SHA256S.
      const verifierPath = realpathSync(resolve(repoRoot, invocation.args[0]!));
      const verifierHash = createHash("sha256")
        .update(readFileSync(verifierPath))
        .digest("hex");
      if (!approvedVerifierHashes().has(verifierHash)) {
        return {
          ok: false,
          stdout: "",
          stderr: "",
          exitCode: 126,
          error: "Production node-check verifier content is not approved",
        };
      }
    } else if (!approvedOperatorCommands().has(normalizeVerificationCommand(command))) {
      // Every other profile invokes a customer toolchain we cannot hash. An
      // operator must approve the exact command deliberately; unlisted commands
      // fail closed.
      return {
        ok: false,
        stdout: "",
        stderr: "",
        exitCode: 126,
        error:
          `Production verification refused: "${normalizeVerificationCommand(command)}" is not an ` +
          `approved verifier. An operator must add this exact command to ${APPROVED_COMMANDS_ENV}, ` +
          `or use the node-check profile with an approved hash in ${APPROVED_HASHES_ENV}.`,
      };
    }
  }
  // Containment layer: when a real sandbox backend is configured, run the
  // (already approved) command inside a per-run isolated Machine instead of the
  // worker container. This is fail-closed — if isolation cannot be established
  // the run FAILS here and never reaches the host execFile path below. With no
  // sandbox configured (`configuredSandboxKind() === "local"`) this is skipped
  // and behaviour is byte-identical to the host path. The production approval
  // gates above still apply; the sandbox is an additional layer, not a bypass.
  if (configuredSandboxKind() === "fly_machines") {
    return runVerificationInSandbox({
      command: normalizeVerificationCommand(command),
      repoRoot,
      timeoutMs: boundedTimeout,
      options: sandbox,
    });
  }
  // SECURITY — RESIDUAL RISK: verification runs WITHOUT network isolation.
  // The Node permission model below (--permission / --allow-fs-read /
  // --allow-fs-write) restricts filesystem access only; it does NOT restrict
  // egress. An approved-but-malicious verifier command (or a compromised
  // toolchain it invokes) can still open outbound network connections and
  // exfiltrate data. Egress MUST be gated at the infrastructure layer
  // (netns / firewall / Fly network policy) — the Node runtime cannot do it.
  // See docs/SANDBOX_VERIFIER.md for the full local-verify egress residual-risk
  // note and where the sandbox backend is expected to carry the egress gate.
  const args =
    production && invocation.profile === "node-check"
      ? [
          process.allowedNodeEnvironmentFlags.has("--permission")
            ? "--permission"
            : "--experimental-permission",
          "--experimental-strip-types",
          `--allow-fs-read=${realpathSync(resolve(repoRoot))}`,
          `--allow-fs-write=${tmpdir()}`,
          ...invocation.args,
        ]
      : invocation.args;
  const env = production
    ? Object.fromEntries(
        [
          "PATH",
          "Path",
          "PATHEXT",
          "SystemRoot",
          "COMSPEC",
          "TMP",
          "TEMP",
          "TMPDIR",
        ]
          .map((key) => [key, process.env[key]])
          .filter((entry): entry is [string, string] => Boolean(entry[1])),
      )
    : process.env;
  // NOTE: some spawn failures (e.g. Node's refusal to execFile a .cmd shim on
  // Windows) throw synchronously from execFile rather than surfacing through the
  // callback. That synchronous throw is a deliberate contract: callers such as
  // packages/agent's attempt-engine catch EINVAL to apply a platform-specific
  // npm fallback. Do NOT wrap this in try/catch — swallowing the throw would
  // silently disable that fallback.
  return await new Promise<VerificationExecution>((resolveExecution) => {
    execFile(invocation.executable, args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: boundedTimeout,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      env,
      signal,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolveExecution({
          ok: true,
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode: 0,
        });
        return;
      }
      const failure = error as Error & { code?: number | string };
      resolveExecution({
        ok: false,
        stdout: String(stdout),
        stderr: String(stderr),
        exitCode: Number.isInteger(failure.code) ? Number(failure.code) : 1,
        error: failure.message,
      });
    });
  });
}
