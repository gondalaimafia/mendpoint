import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  runExecFileVerification,
  runVerificationCommand,
  verifierProtectedPaths,
  type VerificationExecFile,
} from "./verify.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("verify egress residual-risk disclosure", () => {
  it("documents that verification runs without network isolation", () => {
    const source = readFileSync(join(here, "verify.ts"), "utf8");
    expect(source).toMatch(/network isolation/i);
    expect(source).toMatch(/egress/i);
    // The disclosure must point operators at the infra-layer gate.
    expect(source).toMatch(/SANDBOX_VERIFIER\.md/);
  });
});

describe("verifierProtectedPaths covers every verification profile", () => {
  // The covered profiles below need no on-disk files, so any directory works.
  const root = here;

  it("protects the discovered check file for node-check", () => {
    expect(verifierProtectedPaths("node check.mjs", root)).toEqual(["check.mjs"]);
    expect(verifierProtectedPaths("node check.cjs", root)).toEqual(["check.cjs"]);
  });

  it("protects package.json for every npm profile (the sharp case)", () => {
    for (const command of ["npm test", "npm build", "npm run typecheck", "npm run lint"]) {
      expect(verifierProtectedPaths(command, root)).toContain("package.json");
    }
  });

  it("protects the config/manifest surface for the toolchain profiles", () => {
    expect(verifierProtectedPaths("pytest", root)).toContain("pytest.ini");
    expect(verifierProtectedPaths("go test ./...", root)).toContain("go.mod");
    expect(verifierProtectedPaths("cargo test", root)).toContain("Cargo.toml");
    expect(verifierProtectedPaths("mvn test", root)).toContain("pom.xml");
    expect(verifierProtectedPaths("gradle test", root)).toContain("build.gradle");
    expect(verifierProtectedPaths("bundle exec rspec", root)).toContain("Gemfile");
  });

  it("contributes nothing for an unrecognized command", () => {
    expect(verifierProtectedPaths("rm -rf /", root)).toEqual([]);
  });
});

describe("runVerificationCommand distinguishes a refusal from a test failure", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) {
      // Abort can resolve before Windows releases the child's working directory.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
  function tempRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "mp-verify-outcome-"));
    dirs.push(dir);
    return dir;
  }

  it("records a production approval-gate refusal as not_verified (never failed)", async () => {
    const dir = tempRepo();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "exit 1" } }));
    vi.stubEnv("NODE_ENV", "production");
    // No MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION: the command is not approved, so
    // it must be refused (never run) rather than reported as a failing test.
    vi.stubEnv("MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION", undefined);

    const result = await runVerificationCommand("npm test", dir);

    expect(result.outcome).toBe("not_verified");
    expect(result.sandboxBackend).toBeNull();
    expect(result.exitCode).toBe(126);
    // Fail closed: a refusal is not a pass.
    expect(result.ok).toBe(false);
  });

  it("records an unsupported command as not_verified", async () => {
    const dir = tempRepo();
    const result = await runVerificationCommand("definitely not a verifier", dir);
    expect(result.outcome).toBe("not_verified");
    expect(result.sandboxBackend).toBeNull();
    expect(result.exitCode).toBe(126);
  });

  it("records a genuine host test failure as failed under the local backend", async () => {
    const dir = tempRepo();
    // A node-check that exits non-zero: it truly runs and fails (not a refusal).
    writeFileSync(join(dir, "check.mjs"), "process.exit(1)\n", "utf8");
    const result = await runVerificationCommand("node check.mjs", dir);
    expect(result.outcome).toBe("failed");
    expect(result.sandboxBackend).toBe("local");
    expect(result.ok).toBe(false);
  });

  it("records a passing host verification as verified under the local backend", async () => {
    const dir = tempRepo();
    writeFileSync(join(dir, "check.mjs"), "process.exit(0)\n", "utf8");
    const result = await runVerificationCommand("node check.mjs", dir);
    expect(result.outcome).toBe("verified");
    expect(result.sandboxBackend).toBe("local");
    expect(result.ok).toBe(true);
  });

  it("records a command that cannot start in a missing directory as not_verified", async () => {
    const missingRoot = join(tempRepo(), "missing");
    const result = await runVerificationCommand("go test ./...", missingRoot);

    expect(result.error).toContain("ENOENT");
    expect(result.outcome).toBe("not_verified");
    expect(result.sandboxBackend).toBeNull();
    expect(result.ok).toBe(false);
    // A launch failure is a refusal, so it uses the same exit code every other
    // not_verified path returns (126), never the "1" of a run that produced a
    // real verdict.
    expect(result.exitCode).toBe(126);
  });

  it("keeps a timed out host command classified as failed after it starts", async () => {
    const dir = tempRepo();
    writeFileSync(join(dir, "check.mjs"), "console.log('started'); setInterval(() => {}, 1000);\n");

    const result = await runVerificationCommand("node check.mjs", dir, 1_000);

    expect(result.stdout).toContain("started");
    expect(result.outcome).toBe("failed");
    expect(result.sandboxBackend).toBe("local");
    expect(result.ok).toBe(false);
  });

  it("records an unavailable executable as not_verified", async () => {
    const dir = tempRepo();
    vi.stubEnv("PATH", dir);
    vi.stubEnv("Path", dir);

    const result = await runVerificationCommand("pytest", dir);

    expect(result.error).toContain("ENOENT");
    expect(result.outcome).toBe("not_verified");
    expect(result.sandboxBackend).toBeNull();
    expect(result.ok).toBe(false);
  });

  it.runIf(process.platform === "win32")("preserves synchronous EINVAL rejection for the npm fallback", async () => {
    await expect(runVerificationCommand("npm test", tempRepo())).rejects.toMatchObject({ code: "EINVAL" });
  });

  it("keeps an aborted host command classified as failed after it starts", async () => {
    const dir = tempRepo();
    writeFileSync(join(dir, "check.mjs"), [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync("started", "ready");',
      'setInterval(() => {}, 1000);',
    ].join("\n"));
    const controller = new AbortController();
    const execution = runVerificationCommand("node check.mjs", dir, 10_000, controller.signal);
    try {
      await vi.waitFor(() => expect(existsSync(join(dir, "started"))).toBe(true));
    } finally {
      controller.abort();
    }

    const result = await execution;

    expect(result.error).toContain("aborted");
    expect(result.outcome).toBe("failed");
    expect(result.sandboxBackend).toBe("local");
    expect(result.ok).toBe(false);
  });
});

describe("runExecFileVerification classifies launch vs run on any platform", () => {
  // A launcher whose child never emits `spawn` before erroring models a launch
  // failure; one that emits `spawn` first models a process that started. This
  // makes the classification (which packages/agent's npm EINVAL fallback also
  // depends on) testable on Linux CI, not only on the Windows `.cmd` shim path.
  type Behavior = "launch-error" | "started-then-failed" | "verified";
  function fakeLauncher(behavior: Behavior): VerificationExecFile {
    return (_file, _args, _options, callback) => {
      const emitter = new EventEmitter();
      // Defer so the synchronous `.once("spawn", ...)` registration inside
      // runExecFileVerification runs before we emit anything, exactly like a
      // real child process.
      queueMicrotask(() => {
        if (behavior !== "launch-error") emitter.emit("spawn");
        if (behavior === "verified") {
          callback(null, "ran-out", "ran-err");
        } else if (behavior === "started-then-failed") {
          callback(Object.assign(new Error("exited 3"), { code: 3 }), "ran-out", "ran-err");
        } else {
          callback(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), "", "");
        }
      });
      return emitter as unknown as Pick<ChildProcess, "once">;
    };
  }

  it("reports a verifier that never launched as not_verified with no backend", async () => {
    const result = await runExecFileVerification("npm", ["test"], { encoding: "utf8" }, fakeLauncher("launch-error"));
    expect(result.outcome).toBe("not_verified");
    expect(result.sandboxBackend).toBeNull();
    expect(result.ok).toBe(false);
    // A refusal uses the canonical not_verified exit code, never a run's "1".
    expect(result.exitCode).toBe(126);
    expect(result.error).toContain("ENOENT");
  });

  it("reports a process that started then failed as failed under the local backend", async () => {
    const result = await runExecFileVerification("npm", ["test"], { encoding: "utf8" }, fakeLauncher("started-then-failed"));
    expect(result.outcome).toBe("failed");
    expect(result.sandboxBackend).toBe("local");
    expect(result.ok).toBe(false);
    // The real exit code of the run is preserved (not collapsed to the refusal code).
    expect(result.exitCode).toBe(3);
  });

  it("reports a process that started and passed as verified under the local backend", async () => {
    const result = await runExecFileVerification("npm", ["test"], { encoding: "utf8" }, fakeLauncher("verified"));
    expect(result.outcome).toBe("verified");
    expect(result.sandboxBackend).toBe("local");
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});
