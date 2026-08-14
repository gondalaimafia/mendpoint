import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildIndex } from "./index.js";

const tmpDirs: string[] = [];
function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}
function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "discovery-ignore-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("discovery prunes dependency/generated trees, not tracked source", () => {
  it("indexes only a Python project's own sources, skipping its .venv", () => {
    const root = makeRoot();
    write(root, "app/main.py", "def handler():\n    return 1\n");
    write(root, "app/service.py", "def charge():\n    return 2\n");
    // A real virtualenv: name + pyvenv.cfg marker + a site-packages tree.
    write(root, ".venv/pyvenv.cfg", "home = /usr/bin\n");
    write(root, ".venv/Lib/site-packages/thirdparty/dep.py", "def library_fn():\n    return 3\n");
    write(root, "app/__pycache__/main.cpython-311.pyc.py", "def generated():\n    return 4\n");
    write(root, "requirements.txt", "fastapi\n");

    const index = buildIndex(root);
    const paths = index.files.map((f) => f.path);
    expect(paths).toContain("app/main.py");
    expect(paths).toContain("app/service.py");
    expect(paths.some((p) => p.includes(".venv"))).toBe(false);
    expect(paths.some((p) => p.includes("site-packages"))).toBe(false);
    expect(paths.some((p) => p.includes("__pycache__"))).toBe(false);
    expect(index.functions.some((f) => f.name === "library_fn")).toBe(false);
    expect(index.functions.some((f) => f.name === "handler")).toBe(true);
  });

  it("records skipped directories with a reason (never a silent truncation)", () => {
    const root = makeRoot();
    write(root, "src/app.py", "def main():\n    return 1\n");
    write(root, ".venv/pyvenv.cfg", "home = /usr/bin\n");
    write(root, ".venv/lib/x.py", "def y():\n    return 2\n");

    const index = buildIndex(root);
    const venv = index.skippedDirectories.find((s) => s.path === ".venv");
    expect(venv).toBeDefined();
    expect(venv!.reason).toContain("ignored_name");
  });

  it("catches a custom-named virtualenv via its pyvenv.cfg marker", () => {
    const root = makeRoot();
    write(root, "src/app.py", "def main():\n    return 1\n");
    write(root, "env/pyvenv.cfg", "home = /usr/bin\n");
    write(root, "env/lib/dep.py", "def dep():\n    return 2\n");

    const index = buildIndex(root);
    expect(index.functions.some((f) => f.name === "dep")).toBe(false);
    expect(index.skippedDirectories.some((s) => s.reason.includes("pyvenv.cfg"))).toBe(true);
  });

  it("does NOT skip tracked source in ambiguously-named dirs (vendor/build/target/env)", () => {
    const root = makeRoot();
    // Go-style committed vendoring and generated-but-checked-in dirs are real source.
    write(root, "vendor/pkg/lib.go", "func VendorFn() int { return 1 }\n");
    write(root, "build/gen.ts", "export function generated() { return 1; }\n");
    write(root, "target/kept.java", "class Kept { void m() {} }\n");
    // A source module literally named "env" with no virtualenv marker.
    write(root, "env/settings.py", "def load():\n    return 1\n");

    const index = buildIndex(root);
    const paths = index.files.map((f) => f.path);
    expect(paths).toContain("vendor/pkg/lib.go");
    expect(paths).toContain("build/gen.ts");
    expect(paths).toContain("target/kept.java");
    expect(paths).toContain("env/settings.py");
  });
});
