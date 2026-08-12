import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  INTERNAL_API_ACME_USER_RENAME_RECIPE,
  analyzeRecipe,
  applyInverseOperations,
  applyRecipe,
  createInternalApiRenameRecipe,
  getRecipe,
  recipeFilesDigest,
  recipeReference,
  resolveRecipe,
  validateRecipe,
  type RecipeFiles,
} from "./recipe.js";

const FIXTURE_ROOT = "../../../fixtures/consumers/internal-api-acme-user-rename/";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(FIXTURE_ROOT + relative, import.meta.url)), "utf8");
}

function load(sub: string, paths: readonly string[]): RecipeFiles {
  const files: Record<string, string> = {};
  for (const path of paths) files[path] = read(`${sub}/${path}`);
  return files;
}

const SUPPORTED_PATHS = ["src/profile.ts", "src/settings.ts"] as const;
const reference = recipeReference(INTERNAL_API_ACME_USER_RENAME_RECIPE);

// A single supported profile source for inline abstain/member-access cases.
const IMPORT = 'import { getUser } from "@acme/user-service";';

describe("internal-api-acme-user-getuser-to-fetchuser recipe", () => {
  it("is a valid, registered, content-addressed recipe", () => {
    expect(() => validateRecipe(INTERNAL_API_ACME_USER_RENAME_RECIPE)).not.toThrow();
    expect(getRecipe("internal-api-acme-user-getuser-to-fetchuser", 1)).toBe(
      INTERNAL_API_ACME_USER_RENAME_RECIPE,
    );
    expect(resolveRecipe(reference)).toBe(INTERNAL_API_ACME_USER_RENAME_RECIPE);
    expect(INTERNAL_API_ACME_USER_RENAME_RECIPE.allowedPaths).toEqual([
      "src/profile.ts",
      "src/settings.ts",
    ]);
    expect(Object.isFrozen(INTERNAL_API_ACME_USER_RENAME_RECIPE)).toBe(true);
    expect(INTERNAL_API_ACME_USER_RENAME_RECIPE.verificationCommands).toHaveLength(2);
    for (const command of INTERNAL_API_ACME_USER_RENAME_RECIPE.verificationCommands) {
      expect(command.command).toMatch(/^node -e "[^"]+"$/);
    }
  });

  it("applies deterministically to the supported before fixture", () => {
    const before = load("before", SUPPORTED_PATHS);
    const after = load("after", SUPPORTED_PATHS);

    const analysis = analyzeRecipe(reference, before);
    expect(analysis.status).toBe("applicable");
    expect([...analysis.matchedPaths]).toEqual(["src/profile.ts", "src/settings.ts"]);
    expect(analysis.reasons).toEqual([]);
    expect(analysis.estimatedOperations).toBe(2);

    const first = applyRecipe(reference, before);
    const second = applyRecipe(reference, { ...before });
    expect(first.files).toEqual(second.files);
    expect(first.operations.map((operation) => operation.path)).toEqual([
      "src/profile.ts",
      "src/settings.ts",
    ]);

    // The on-disk after/ fixture is the exact deterministic output.
    expect(first.files["src/profile.ts"]).toBe(after["src/profile.ts"]);
    expect(first.files["src/settings.ts"]).toBe(after["src/settings.ts"]);

    // Shape checks: import specifier and call sites renamed, siblings preserved.
    expect(first.files["src/profile.ts"]).toContain(
      'import { fetchUser } from "@acme/user-service";',
    );
    expect(first.files["src/profile.ts"]).toContain("const user = await fetchUser(id);");
    expect(first.files["src/profile.ts"]).toContain(
      'import { formatDisplayName } from "@acme/format";',
    );
    expect(first.files["src/settings.ts"]).toContain(
      'import { fetchUser, updateSettings } from "@acme/user-service";',
    );
    expect(first.files["src/settings.ts"]).toContain("const user = fetchUser(id);");
    expect(first.files["src/settings.ts"]).toContain("return updateSettings(user, prefs);");
    for (const path of SUPPORTED_PATHS) {
      expect(first.files[path]).not.toMatch(/\bgetUser\b/);
    }
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

  it("abstains on the same name imported from a different module (false-positive trap)", () => {
    const files = load("out-of-scope", SUPPORTED_PATHS);
    const analysis = analyzeRecipe(reference, files);
    expect(analysis.status).toBe("unsupported");
    expect(analysis.matchedPaths).toEqual([]);
    expect(analysis.reasons).toContain("recipe_internal_api_binding_unresolved");
    expect(() => applyRecipe(reference, files)).toThrow("recipe_internal_api_binding_unresolved");
  });

  it("renames the imported binding call while ignoring a same-named member call", () => {
    const source = [
      IMPORT,
      "const db = makeDb();",
      "export function run(id) {",
      "  const a = getUser(id);",
      "  const b = db.getUser(id);",
      "  return [a, b];",
      "}",
      "",
    ].join("\n");
    const output = applyRecipe(reference, { "src/profile.ts": source });
    const migrated = output.files["src/profile.ts"]!;
    expect(migrated).toContain('import { fetchUser } from "@acme/user-service";');
    expect(migrated).toContain("const a = fetchUser(id);");
    // The member call on `db` belongs to a different binding and is left intact.
    expect(migrated).toContain("const b = db.getUser(id);");
  });

  it("abstains on an aliased import", () => {
    const source = [
      'import { getUser as loadUser } from "@acme/user-service";',
      "export function run(id) { return loadUser(id); }",
      "",
    ].join("\n");
    const analysis = analyzeRecipe(reference, { "src/profile.ts": source });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons).toContain("recipe_internal_api_aliased_import");
  });

  it("abstains on a non-call reference to the binding", () => {
    const source = [IMPORT, "export const handler = getUser;", ""].join("\n");
    const analysis = analyzeRecipe(reference, { "src/profile.ts": source });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons).toContain("recipe_internal_api_unsupported_reference");
  });

  it("abstains on a spread of the binding", () => {
    const source = [IMPORT, "export function run() { return [...getUser]; }", ""].join("\n");
    const analysis = analyzeRecipe(reference, { "src/profile.ts": source });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons).toContain("recipe_internal_api_unsupported_reference");
  });

  it("abstains when the target name already exists as a code identifier", () => {
    const source = [
      IMPORT,
      "function fetchUser() { return null; }",
      "export function run(id) { fetchUser(); return getUser(id); }",
      "",
    ].join("\n");
    const analysis = analyzeRecipe(reference, { "src/profile.ts": source });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons).toContain("recipe_internal_api_target_conflict");
  });

  it("abstains when the binding is imported from the module on more than one statement", () => {
    const source = [
      IMPORT,
      IMPORT,
      "export function run(id) { return getUser(id); }",
      "",
    ].join("\n");
    const analysis = analyzeRecipe(reference, { "src/profile.ts": source });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons).toContain("recipe_internal_api_multiple_imports");
  });

  it("does not corrupt strings, comments, or template literals that mention the binding", () => {
    const source = [
      IMPORT,
      "// getUser(shouldNotRename)",
      "const note = \"call getUser(id) here\";",
      "const tpl = `still getUser(${id})`;",
      "export function run(id) { return getUser(id); }",
      "",
    ].join("\n");
    const output = applyRecipe(reference, { "src/profile.ts": source });
    const migrated = output.files["src/profile.ts"]!;
    expect(migrated).toContain("// getUser(shouldNotRename)");
    expect(migrated).toContain('const note = "call getUser(id) here";');
    expect(migrated).toContain("const tpl = `still getUser(${id})`;");
    expect(migrated).toContain("return fetchUser(id);");
  });

  it("is a spec-driven factory: a different spec produces a different digest", () => {
    // The spec is folded into the content-addressed digest. Two specs that
    // differ only in their data yield distinct, independently signable digests.
    const billing = createInternalApiRenameRecipe({
      recipeId: "internal-api-acme-billing-charge-to-capture",
      version: 1,
      title: "Internal API refactor: acme billing-service charge to capture",
      source: "acme-billing-service-charge",
      target: "acme-billing-service-capture",
      module: "@acme/billing-service",
      from: "charge",
      to: "capture",
      paths: ["src/checkout.ts"],
    });
    const renamedTarget = createInternalApiRenameRecipe({
      recipeId: "internal-api-acme-billing-charge-to-capture",
      version: 1,
      title: "Internal API refactor: acme billing-service charge to capture",
      source: "acme-billing-service-charge",
      target: "acme-billing-service-capture",
      module: "@acme/billing-service",
      from: "charge",
      to: "settle",
      paths: ["src/checkout.ts"],
    });
    expect(billing.digest).not.toBe(INTERNAL_API_ACME_USER_RENAME_RECIPE.digest);
    expect(billing.digest).not.toBe(renamedTarget.digest);
    expect(() => validateRecipe(billing)).not.toThrow();
    // The spec data rides on the preconditions/transforms that feed the digest.
    expect(billing.preconditions).toEqual([
      {
        kind: "internal_api_rename_source",
        path: "src/checkout.ts",
        module: "@acme/billing-service",
        from: "charge",
        to: "capture",
      },
    ]);
    expect(billing.transforms).toEqual([
      {
        kind: "internal_api_rename",
        path: "src/checkout.ts",
        module: "@acme/billing-service",
        from: "charge",
        to: "capture",
      },
    ]);
  });

  it("rejects a no-op spec whose from and to are identical", () => {
    expect(() =>
      createInternalApiRenameRecipe({
        recipeId: "internal-api-noop",
        version: 1,
        title: "noop",
        source: "a",
        target: "b",
        module: "@acme/user-service",
        from: "getUser",
        to: "getUser",
        paths: ["src/profile.ts"],
      }),
    ).toThrow("recipe_internal_api_noop");
  });
});
