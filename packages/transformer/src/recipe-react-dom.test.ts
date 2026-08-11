import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REACT_DOM_17_TO_18_RECIPE,
  analyzeRecipe,
  applyInverseOperations,
  applyRecipe,
  getRecipe,
  recipeFilesDigest,
  recipeReference,
  resolveRecipe,
  validateRecipe,
  type RecipeFiles,
} from "./recipe.js";

const FIXTURE_ROOT = "../../../fixtures/consumers/react-dom-17-to-18/";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(FIXTURE_ROOT + relative, import.meta.url)), "utf8");
}

function load(sub: string, paths: readonly string[]): RecipeFiles {
  const files: Record<string, string> = {};
  for (const path of paths) files[path] = read(`${sub}/${path}`);
  return files;
}

const SUPPORTED_PATHS = ["package.json", "src/index.jsx"] as const;
const reference = recipeReference(REACT_DOM_17_TO_18_RECIPE);

describe("react-dom-17-to-18 recipe", () => {
  it("is a valid, registered, content-addressed recipe", () => {
    expect(() => validateRecipe(REACT_DOM_17_TO_18_RECIPE)).not.toThrow();
    expect(getRecipe("react-dom-17-to-18", 1)).toBe(REACT_DOM_17_TO_18_RECIPE);
    expect(resolveRecipe(reference)).toBe(REACT_DOM_17_TO_18_RECIPE);
    expect(REACT_DOM_17_TO_18_RECIPE.allowedPaths).toEqual([
      "package.json",
      "src/index.jsx",
      "src/index.tsx",
    ]);
    expect(Object.isFrozen(REACT_DOM_17_TO_18_RECIPE)).toBe(true);
    for (const command of REACT_DOM_17_TO_18_RECIPE.verificationCommands) {
      expect(command.command).toMatch(/^node -e "[^"]+"$/);
    }
  });

  it("applies deterministically to the supported before fixture", () => {
    const before = load("before", SUPPORTED_PATHS);
    const after = load("after", SUPPORTED_PATHS);

    const analysis = analyzeRecipe(reference, before);
    expect(analysis.status).toBe("applicable");
    expect([...analysis.matchedPaths]).toEqual(["package.json", "src/index.jsx"]);
    expect(analysis.reasons).toEqual([]);
    expect(analysis.estimatedOperations).toBe(2);

    const first = applyRecipe(reference, before);
    const second = applyRecipe(reference, { ...before });
    expect(first.files).toEqual(second.files);
    expect(first.operations.map((operation) => operation.path)).toEqual([
      "package.json",
      "src/index.jsx",
    ]);

    // The on-disk after/ fixture is the exact deterministic output.
    expect(first.files["src/index.jsx"]).toBe(after["src/index.jsx"]);
    expect(first.files["package.json"]).toBe(after["package.json"]);

    // Shape checks: client root API, used-symbol import, no legacy surface.
    expect(first.files["src/index.jsx"]).toContain(
      'import { createRoot } from "react-dom/client";',
    );
    expect(first.files["src/index.jsx"]).toContain(
      'createRoot(document.getElementById("root")).render(<App name="world" />);',
    );
    expect(first.files["src/index.jsx"]).not.toMatch(/from "react-dom"/);
    expect(first.files["src/index.jsx"]).not.toMatch(/ReactDOM\.render\(/);
    const dependencies = JSON.parse(first.files["package.json"]!).dependencies;
    expect(dependencies["react-dom"]).toBe("^18.2.0");
    expect(dependencies["react"]).toBe("^18.2.0");
  });

  it("rewrites hydrate to hydrateRoot with a used-symbol client import", () => {
    const source = [
      'const ReactDOM = require("react-dom");',
      "ReactDOM.hydrate(<App />, document.getElementById(\"root\"));",
      "",
    ].join("\n");
    const output = applyRecipe(reference, {
      "package.json": read("before/package.json"),
      "src/index.jsx": source,
    });
    expect(output.files["src/index.jsx"]).toContain(
      'const { hydrateRoot } = require("react-dom/client");',
    );
    expect(output.files["src/index.jsx"]).toContain(
      'hydrateRoot(document.getElementById("root"), <App />);',
    );
  });

  it("is idempotent and reports already_applied on migrated sources", () => {
    const before = load("before", SUPPORTED_PATHS);
    const output = applyRecipe(reference, before);
    const reanalysis = analyzeRecipe(reference, output.files);
    expect(reanalysis.status).toBe("already_applied");
    expect(() => applyRecipe(reference, output.files)).toThrow("recipe_already_applied");
  });

  it("restores the exact input via inverse operations", () => {
    const before = load("before", SUPPORTED_PATHS);
    const output = applyRecipe(reference, before);
    const restored = applyInverseOperations(reference, output.files, output.operations);
    expect(recipeFilesDigest(restored)).toBe(output.inputDigest);
    expect(restored).toEqual(before);
  });

  it("abstains on the removed render callback argument (out-of-scope)", () => {
    const files = load("out-of-scope", SUPPORTED_PATHS);
    const analysis = analyzeRecipe(reference, files);
    expect(analysis.status).toBe("unsupported");
    expect(analysis.matchedPaths).toEqual([]);
    expect(analysis.reasons).toContain("recipe_react_render_callback");
    expect(() => applyRecipe(reference, files)).toThrow("recipe_react_render_callback");
  });

  it("abstains on unmountComponentAtNode, which has no deterministic root handle", () => {
    const source = [
      'import ReactDOM from "react-dom";',
      "ReactDOM.render(<App />, document.getElementById(\"root\"));",
      "ReactDOM.unmountComponentAtNode(document.getElementById(\"root\"));",
      "",
    ].join("\n");
    const analysis = analyzeRecipe(reference, {
      "package.json": read("before/package.json"),
      "src/index.jsx": source,
    });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons).toContain("recipe_react_unmount_unsupported");
  });

  it("abstains on a named react-dom import form", () => {
    const source = [
      'import { render } from "react-dom";',
      "render(<App />, document.getElementById(\"root\"));",
      "",
    ].join("\n");
    const analysis = analyzeRecipe(reference, {
      "package.json": read("before/package.json"),
      "src/index.jsx": source,
    });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons).toContain("recipe_react_named_import");
  });

  it("abstains when two render calls share the same container", () => {
    const source = [
      'import ReactDOM from "react-dom";',
      "ReactDOM.render(<A />, document.getElementById(\"root\"));",
      "ReactDOM.render(<B />, document.getElementById(\"root\"));",
      "",
    ].join("\n");
    const analysis = analyzeRecipe(reference, {
      "package.json": read("before/package.json"),
      "src/index.jsx": source,
    });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons).toContain("recipe_react_shared_container");
  });
});
