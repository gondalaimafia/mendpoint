import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verifierProtectedPaths } from "./verify.js";

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
