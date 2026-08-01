/**
 * Discover a reasonable verify command for a consumer repo.
 * Used when the operator does not pass verifyCommand explicitly.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function hasPythonTests(repoRoot: string): boolean {
  if (
    existsSync(join(repoRoot, "pytest.ini")) ||
    existsSync(join(repoRoot, "conftest.py")) ||
    existsSync(join(repoRoot, "tests")) ||
    existsSync(join(repoRoot, "test"))
  ) {
    return true;
  }
  try {
    const entries = readdirSync(repoRoot);
    return entries.some(
      (name) =>
        /^test_.*\.py$/i.test(name) ||
        /_test\.py$/i.test(name) ||
        name === "tox.ini",
    );
  } catch {
    return false;
  }
}

function hasGoMod(repoRoot: string): boolean {
  return existsSync(join(repoRoot, "go.mod"));
}

function hasRubySpecs(repoRoot: string): boolean {
  return existsSync(join(repoRoot, "Gemfile")) &&
    (existsSync(join(repoRoot, "spec")) || existsSync(join(repoRoot, ".rspec")));
}

/**
 * Infer a verify command from common project layouts.
 *
 * Priority:
 * 1. package.json scripts.test → `npm test`
 * 2. check.mjs (repo root) → `node check.mjs`
 * 3. Python test layout → `pytest` / `python -m pytest`
 * 4. go.mod → `go test ./...`
 * 5. Cargo.toml → `cargo test`
 * 6. Maven or Gradle project → its standard test task
 * 7. Ruby specs → `bundle exec rspec`
 */
export function discoverVerifyCommand(repoRoot: string): string | undefined {
  const pkgPath = join(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts && typeof pkg.scripts.test === "string" && pkg.scripts.test.length) {
        return "npm test";
      }
    } catch {
      /* ignore invalid package.json */
    }
  }

  if (existsSync(join(repoRoot, "check.mjs"))) {
    return "node check.mjs";
  }

  // Also accept check.js
  if (existsSync(join(repoRoot, "check.js"))) {
    return "node check.js";
  }

  if (hasPythonTests(repoRoot)) {
    // Prefer pytest when available as a conventional command string
    return "pytest";
  }

  if (hasGoMod(repoRoot)) {
    return "go test ./...";
  }

  if (existsSync(join(repoRoot, "Cargo.toml"))) {
    return "cargo test";
  }

  if (existsSync(join(repoRoot, "pom.xml"))) {
    return "mvn test";
  }

  if (existsSync(join(repoRoot, "gradlew"))) {
    return "./gradlew test";
  }
  if (existsSync(join(repoRoot, "gradlew.bat"))) {
    return "gradlew.bat test";
  }
  if (
    existsSync(join(repoRoot, "build.gradle")) ||
    existsSync(join(repoRoot, "build.gradle.kts"))
  ) {
    return "gradle test";
  }

  if (hasRubySpecs(repoRoot)) {
    return "bundle exec rspec";
  }

  // Nested single-package: package.json in only subdir is out of scope for v0
  try {
    const st = statSync(repoRoot);
    if (!st.isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  return undefined;
}
