import { describe, expect, it } from "vitest";
import {
  DEPENDENCY_DIRECTORIES,
  PYTHON_VIRTUALENV_MARKER,
  classifyDependencyDirectory,
} from "./dependency-directories.js";

const hasMarker = (m: string) => m === PYTHON_VIRTUALENV_MARKER;
const noMarker = () => false;

describe("shared dependency-directory decision (single source of truth)", () => {
  it("prunes dependency, cache, and VCS directories by name", () => {
    for (const name of [
      "node_modules",
      ".git",
      ".hg",
      ".svn",
      "dist",
      ".next",
      ".turbo",
      "coverage",
      ".venv",
      "__pycache__",
      "site-packages",
      ".gradle",
    ]) {
      expect(DEPENDENCY_DIRECTORIES.has(name)).toBe(true);
      // A dependency name is pruned regardless of any marker probe.
      expect(classifyDependencyDirectory(name, noMarker)).toEqual({ kind: "ignored_name", name });
    }
  });

  it("never prunes tracked-source directories (vendor/build/target/out/bin/obj) by name", () => {
    for (const name of ["vendor", "build", "target", "out", "bin", "obj"]) {
      expect(DEPENDENCY_DIRECTORIES.has(name)).toBe(false);
      // Even if a marker probe returned true, these are not virtualenv names.
      expect(classifyDependencyDirectory(name, hasMarker)).toBeNull();
    }
  });

  it("prunes a custom-named virtualenv only when the pyvenv.cfg marker is present", () => {
    for (const name of ["venv", "env", ".venv-prod"]) {
      expect(classifyDependencyDirectory(name, hasMarker)).toEqual({
        kind: "python_virtualenv",
        marker: PYTHON_VIRTUALENV_MARKER,
      });
      // Same names without the marker are legitimate source dirs — never pruned.
      expect(classifyDependencyDirectory(name, noMarker)).toBeNull();
    }
  });
});
