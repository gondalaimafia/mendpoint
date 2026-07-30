import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

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

export function runVerificationCommand(
  command: string,
  repoRoot: string,
  timeoutMs = 120_000,
): VerificationExecution {
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
  try {
    const stdout = execFileSync(invocation.executable, invocation.args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: boundedTimeout,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout), stderr: "", exitCode: 0 };
  } catch (error: unknown) {
    const failure = error as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
      message?: string;
    };
    return {
      ok: false,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? ""),
      exitCode: Number.isInteger(failure.status) ? Number(failure.status) : 1,
      error: failure.message ?? String(error),
    };
  }
}
