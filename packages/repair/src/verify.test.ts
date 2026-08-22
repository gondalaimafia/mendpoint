import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runVerificationCommand, verifierProtectedPaths } from "./verify.js";

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
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
});
