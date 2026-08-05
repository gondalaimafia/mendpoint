import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

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
  if (
    production &&
    invocation.profile !== "node-check"
  ) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: 126,
      error:
        "Production verification requires the read-only node-check profile or an explicit operator override",
    };
  }
  if (production && invocation.profile === "node-check") {
    const verifierPath = realpathSync(resolve(repoRoot, invocation.args[0]!));
    const verifierHash = createHash("sha256")
      .update(readFileSync(verifierPath))
      .digest("hex");
    const approvedHashes = new Set(
      (process.env.MENDPOINT_APPROVED_VERIFIER_SHA256S ?? "")
        .split(",")
        .map((hash) => hash.trim().toLowerCase())
        .filter((hash) => /^[a-f0-9]{64}$/.test(hash)),
    );
    if (!approvedHashes.has(verifierHash)) {
      return {
        ok: false,
        stdout: "",
        stderr: "",
        exitCode: 126,
        error: "Production node-check verifier content is not approved",
      };
    }
  }
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
  return await new Promise<VerificationExecution>((resolveExecution) => {
    execFile(invocation.executable, args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: boundedTimeout,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      env,
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
