import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  INTERNAL_API_ACME_USER_RENAME_RECIPE,
  INTERNAL_API_LEDGER_BALANCE_RENAME_RECIPE,
  analyzeRecipe,
  applyInverseOperations,
  applyRecipe,
  authorFactoryRecipe,
  createInternalApiRenameRecipe,
  createInternalApiTypeRenameRecipe,
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

  it("renames a safe non-call value reference to the binding (Gap 3)", () => {
    const source = [IMPORT, "export const handler = getUser;", ""].join("\n");
    const output = applyRecipe(reference, { "src/profile.ts": source });
    const migrated = output.files["src/profile.ts"]!;
    expect(migrated).toContain('import { fetchUser } from "@acme/user-service";');
    expect(migrated).toContain("export const handler = fetchUser;");
    expect(migrated).not.toMatch(/\bgetUser\b/);
  });

  it("abstains on an ambiguous call-argument value reference (Gap 3 refusal)", () => {
    const source = [IMPORT, "export const wired = [1, 2].map(getUser);", ""].join("\n");
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

// ---------------------------------------------------------------------------
// Declaring-module rename (Gap 1) and barrel re-export chains (Gap 2).
// ---------------------------------------------------------------------------

const ORDERS_REF = recipeReference(getRecipe("internal-api-orders-place-to-submit", 1));
const BARREL_REF = recipeReference(getRecipe("internal-api-auth-verify-to-check", 1));

describe("internal-api declaring-module rename (Gap 1)", () => {
  const producer = ['export function placeOrder(id: string): string {', '  return `order:${id}`;', "}", ""].join(
    "\n",
  );
  const cart = [
    'import { placeOrder } from "./orders.js";',
    "export function addToCart(id: string): string {",
    "  return placeOrder(id);",
    "}",
    "",
  ].join("\n");
  const checkout = [
    'import { placeOrder } from "./orders.js";',
    "export function checkout(id: string): string {",
    "  return placeOrder(id);",
    "}",
    "",
  ].join("\n");
  const files = (): RecipeFiles => ({
    "src/orders.ts": producer,
    "src/cart.ts": cart,
    "src/checkout.ts": checkout,
  });

  it("rewrites the declaration, export, imports, and call sites across producer and consumers", () => {
    const analysis = analyzeRecipe(ORDERS_REF, files());
    expect(analysis.status).toBe("applicable");
    expect([...analysis.matchedPaths]).toEqual(["src/cart.ts", "src/checkout.ts", "src/orders.ts"]);
    expect(analysis.reasons).toEqual([]);

    const output = applyRecipe(ORDERS_REF, files());
    expect(output.operations.map((operation) => operation.path)).toEqual([
      "src/cart.ts",
      "src/checkout.ts",
      "src/orders.ts",
    ]);
    // Producer declaration and export renamed.
    expect(output.files["src/orders.ts"]).toContain("export function submitOrder(id: string): string");
    // Consumers: imports and call sites renamed.
    expect(output.files["src/cart.ts"]).toContain('import { submitOrder } from "./orders.js";');
    expect(output.files["src/cart.ts"]).toContain("return submitOrder(id);");
    expect(output.files["src/checkout.ts"]).toContain('import { submitOrder } from "./orders.js";');
    expect(output.files["src/checkout.ts"]).toContain("return submitOrder(id);");
    for (const path of ["src/orders.ts", "src/cart.ts", "src/checkout.ts"]) {
      expect(output.files[path]).not.toMatch(/\bplaceOrder\b/);
    }
  });

  it("is idempotent and reports already_applied once producer and consumers are renamed", () => {
    const output = applyRecipe(ORDERS_REF, files());
    const reanalysis = analyzeRecipe(ORDERS_REF, output.files);
    expect(reanalysis.status).toBe("already_applied");
    expect(() => applyRecipe(ORDERS_REF, output.files)).toThrow("recipe_already_applied");
  });

  it("restores every new edit type byte-identical via inverse operations", () => {
    const before = files();
    const output = applyRecipe(ORDERS_REF, before);
    const restored = applyInverseOperations(ORDERS_REF, output.files, output.operations);
    expect(recipeFilesDigest(restored)).toBe(output.inputDigest);
    expect(restored).toEqual(before);
  });

  it("abstains when the declaration site is unresolvable (completeness invariant)", () => {
    // Consumers are individually applicable, but the designated producer no longer
    // exports the binding, so the whole spec must abstain rather than emit a
    // partial rename that would not compile.
    const broken = { ...files(), "src/orders.ts": "export const somethingElse = 1;\n" };
    const analysis = analyzeRecipe(ORDERS_REF, broken);
    expect(analysis.status).toBe("unsupported");
    expect(analysis.matchedPaths).toEqual([]);
    expect(analysis.reasons).toContain("recipe_internal_api_declaration_unresolved");
    expect(() => applyRecipe(ORDERS_REF, broken)).toThrow(
      "recipe_internal_api_declaration_unresolved",
    );
  });

  it("abstains on a target-name collision in the defining module with no edit", () => {
    const source = [
      "export function placeOrder(id: string): string {",
      "  return submitOrder(id);",
      "}",
      "function submitOrder(id: string): string {",
      "  return id;",
      "}",
      "",
    ].join("\n");
    const analysis = analyzeRecipe(ORDERS_REF, { "src/orders.ts": source });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons).toContain("recipe_internal_api_declaration_target_conflict");
    expect(() => applyRecipe(ORDERS_REF, { "src/orders.ts": source })).toThrow(
      "recipe_internal_api_declaration_target_conflict",
    );
  });

  it("abstains on an aliased export of the binding", () => {
    const source = [
      "const placeOrder = (id: string): string => id;",
      "export { placeOrder as publicPlaceOrder };",
      "",
    ].join("\n");
    const analysis = analyzeRecipe(ORDERS_REF, { "src/orders.ts": source });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons).toContain("recipe_internal_api_declaration_aliased_export");
  });

  it("renames a safe non-call value reference to the exported binding (Gap 3)", () => {
    const source = [
      "export function placeOrder(id: string): string {",
      "  return id;",
      "}",
      "export const handler = placeOrder;",
      "",
    ].join("\n");
    const output = applyRecipe(ORDERS_REF, { "src/orders.ts": source });
    const migrated = output.files["src/orders.ts"]!;
    expect(migrated).toContain("export function submitOrder(id: string): string");
    expect(migrated).toContain("export const handler = submitOrder;");
    expect(migrated).not.toMatch(/\bplaceOrder\b/);
  });

  it("abstains on an ambiguous call-argument reference to the exported binding (Gap 3 refusal)", () => {
    const source = [
      "export function placeOrder(id: string): string {",
      "  return id;",
      "}",
      "export const wired = [id].map(placeOrder);",
      "",
    ].join("\n");
    const analysis = analyzeRecipe(ORDERS_REF, { "src/orders.ts": source });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons).toContain("recipe_internal_api_declaration_unsupported_reference");
  });

  it("renames the exported declaration while leaving a same-named member access intact", () => {
    const source = [
      "export function placeOrder(id: string): string {",
      "  if (globalThis.placeOrder) return id;",
      "  return placeOrder(id);",
      "}",
      "",
    ].join("\n");
    const output = applyRecipe(ORDERS_REF, { "src/orders.ts": source });
    const migrated = output.files["src/orders.ts"]!;
    expect(migrated).toContain("export function submitOrder(id: string): string");
    // Internal recursive call renamed; the member access on another object stays.
    expect(migrated).toContain("return submitOrder(id);");
    expect(migrated).toContain("if (globalThis.placeOrder)");
  });
});

describe("internal-api barrel re-export chain (Gap 2)", () => {
  const producer = [
    "export function verifyToken(token: string): boolean {",
    '  return token.length > 0;',
    "}",
    "",
  ].join("\n");
  const barrel = ['export { verifyToken } from "./token.js";', ""].join("\n");
  const consumer = [
    'import { verifyToken } from "./auth/index.js";',
    "export function guard(token: string): boolean {",
    "  return verifyToken(token);",
    "}",
    "",
  ].join("\n");
  const files = (): RecipeFiles => ({
    "src/auth/token.ts": producer,
    "src/auth/index.ts": barrel,
    "src/middleware.ts": consumer,
  });

  it("rewrites the whole chain: producer declaration, barrel re-export, and consumer import/call", () => {
    const analysis = analyzeRecipe(BARREL_REF, files());
    expect(analysis.status).toBe("applicable");
    expect([...analysis.matchedPaths]).toEqual([
      "src/auth/index.ts",
      "src/auth/token.ts",
      "src/middleware.ts",
    ]);

    const output = applyRecipe(BARREL_REF, files());
    expect(output.files["src/auth/token.ts"]).toContain("export function checkToken(token: string)");
    expect(output.files["src/auth/index.ts"]).toBe('export { checkToken } from "./token.js";\n');
    expect(output.files["src/middleware.ts"]).toContain(
      'import { checkToken } from "./auth/index.js";',
    );
    expect(output.files["src/middleware.ts"]).toContain("return checkToken(token);");
    for (const path of Object.keys(files())) {
      expect(output.files[path]).not.toMatch(/\bverifyToken\b/);
    }
  });

  it("restores the barrel chain byte-identical via inverse operations", () => {
    const before = files();
    const output = applyRecipe(BARREL_REF, before);
    const restored = applyInverseOperations(BARREL_REF, output.files, output.operations);
    expect(recipeFilesDigest(restored)).toBe(output.inputDigest);
    expect(restored).toEqual(before);
  });
});

describe("internal-api declaration-path construction guards", () => {
  it("requires a declaration path when the module is a relative in-repo specifier", () => {
    expect(() =>
      createInternalApiRenameRecipe({
        recipeId: "internal-api-relative-missing-decl",
        version: 1,
        title: "relative without declaration",
        source: "a",
        target: "b",
        module: "./orders.js",
        from: "placeOrder",
        to: "submitOrder",
        paths: ["src/cart.ts"],
      }),
    ).toThrow("recipe_internal_api_declaration_required");
  });

  it("rejects a path listed as both consumer and declaration", () => {
    expect(() =>
      createInternalApiRenameRecipe({
        recipeId: "internal-api-overlap",
        version: 1,
        title: "overlap",
        source: "a",
        target: "b",
        module: "./orders.js",
        from: "placeOrder",
        to: "submitOrder",
        paths: ["src/orders.ts"],
        declarationPaths: ["src/orders.ts"],
      }),
    ).toThrow("recipe_internal_api_declaration_path_conflict");
  });

  it("still permits consumer-only renames for external/bare modules", () => {
    expect(() =>
      createInternalApiRenameRecipe({
        recipeId: "internal-api-bare-ok",
        version: 1,
        title: "bare module ok",
        source: "a",
        target: "b",
        module: "@acme/user-service",
        from: "getUser",
        to: "fetchUser",
        paths: ["src/profile.ts"],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Non-call value references (Gap 3).
// ---------------------------------------------------------------------------

describe("internal-api value references (Gap 3)", () => {
  it("renames a member-root read on the binding (X.bind)", () => {
    const source = [
      IMPORT,
      "export const bound = getUser.bind(globalThis);",
      "",
    ].join("\n");
    const output = applyRecipe(reference, { "src/profile.ts": source });
    const migrated = output.files["src/profile.ts"]!;
    expect(migrated).toContain('import { fetchUser } from "@acme/user-service";');
    expect(migrated).toContain("export const bound = fetchUser.bind(globalThis);");
    expect(migrated).not.toMatch(/\bgetUser\b/);
  });

  it("renames a default export and a return-position value reference", () => {
    const source = [
      IMPORT,
      "export function pick(flag) { if (flag) return getUser; return null; }",
      "export default getUser;",
      "",
    ].join("\n");
    const output = applyRecipe(reference, { "src/profile.ts": source });
    const migrated = output.files["src/profile.ts"]!;
    expect(migrated).toContain("return fetchUser;");
    expect(migrated).toContain("export default fetchUser;");
    expect(migrated).not.toMatch(/\bgetUser\b/);
  });

  it("abstains when a local parameter shadows the imported binding", () => {
    const source = [
      IMPORT,
      "export function run(getUser: () => number) { return getUser(); }",
      "",
    ].join("\n");
    const analysis = analyzeRecipe(reference, { "src/profile.ts": source });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons).toContain("recipe_internal_api_unsupported_reference");
  });

  it("restores a value-reference edit byte-identical via inverse operations", () => {
    const before = { "src/profile.ts": [IMPORT, "export const handler = getUser;", ""].join("\n") };
    const output = applyRecipe(reference, before);
    const restored = applyInverseOperations(reference, output.files, output.operations);
    expect(recipeFilesDigest(restored)).toBe(output.inputDigest);
    expect(restored).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Namespace member expressions (Gap 5).
// ---------------------------------------------------------------------------

describe("internal-api namespace member expressions (Gap 5)", () => {
  it("renames ns.X where ns is the namespace import of the target module", () => {
    const source = [
      'import * as api from "@acme/user-service";',
      "export function run(id) { return api.getUser(id); }",
      "",
    ].join("\n");
    const output = applyRecipe(reference, { "src/profile.ts": source });
    const migrated = output.files["src/profile.ts"]!;
    expect(migrated).toContain('import * as api from "@acme/user-service";');
    expect(migrated).toContain("return api.fetchUser(id);");
    expect(migrated).not.toMatch(/\bgetUser\b/);
  });

  it("leaves a same-named member on an unrelated object untouched", () => {
    const source = [
      'import * as api from "@acme/user-service";',
      "const db = makeDb();",
      "export function run(id) {",
      "  const a = api.getUser(id);",
      "  const b = db.getUser(id);",
      "  return [a, b];",
      "}",
      "",
    ].join("\n");
    const output = applyRecipe(reference, { "src/profile.ts": source });
    const migrated = output.files["src/profile.ts"]!;
    expect(migrated).toContain("const a = api.fetchUser(id);");
    // The member access on the unrelated `db` object is left intact.
    expect(migrated).toContain("const b = db.getUser(id);");
  });

  it("restores a namespace-member edit byte-identical via inverse operations", () => {
    const before = {
      "src/profile.ts": [
        'import * as api from "@acme/user-service";',
        "export const wired = api.getUser;",
        "",
      ].join("\n"),
    };
    const output = applyRecipe(reference, before);
    const restored = applyInverseOperations(reference, output.files, output.operations);
    expect(recipeFilesDigest(restored)).toBe(output.inputDigest);
    expect(restored).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Type and interface renames (Gap 4).
// ---------------------------------------------------------------------------

const ORDER_TYPE_REF = recipeReference(getRecipe("internal-api-order-record-to-order-row", 1));

describe("internal-api type rename (Gap 4)", () => {
  const producer = [
    "export interface OrderRecord {",
    "  id: string;",
    "  total: number;",
    "}",
    "",
  ].join("\n");
  const service = [
    'import type { OrderRecord } from "./order-types.js";',
    "export function total(order: OrderRecord): number {",
    "  return order.total;",
    "}",
    "export const build = (id: string): OrderRecord => ({ id, total: 0 });",
    "",
  ].join("\n");
  const view = [
    'import type { OrderRecord } from "./order-types.js";',
    "export function render(order: OrderRecord): string {",
    "  return order.id;",
    "}",
    "",
  ].join("\n");
  const files = (): RecipeFiles => ({
    "src/order-types.ts": producer,
    "src/order-service.ts": service,
    "src/order-view.ts": view,
  });

  it("rewrites the interface declaration, type imports, and type-position references", () => {
    const analysis = analyzeRecipe(ORDER_TYPE_REF, files());
    expect(analysis.status).toBe("applicable");
    expect([...analysis.matchedPaths]).toEqual([
      "src/order-service.ts",
      "src/order-types.ts",
      "src/order-view.ts",
    ]);
    expect(analysis.reasons).toEqual([]);

    const output = applyRecipe(ORDER_TYPE_REF, files());
    expect(output.files["src/order-types.ts"]).toContain("export interface OrderRow {");
    expect(output.files["src/order-service.ts"]).toContain(
      'import type { OrderRow } from "./order-types.js";',
    );
    expect(output.files["src/order-service.ts"]).toContain("order: OrderRow");
    expect(output.files["src/order-service.ts"]).toContain("(id: string): OrderRow =>");
    expect(output.files["src/order-view.ts"]).toContain("order: OrderRow");
    for (const path of Object.keys(files())) {
      expect(output.files[path]).not.toMatch(/\bOrderRecord\b/);
    }
  });

  it("is idempotent and reports already_applied once renamed", () => {
    const output = applyRecipe(ORDER_TYPE_REF, files());
    const reanalysis = analyzeRecipe(ORDER_TYPE_REF, output.files);
    expect(reanalysis.status).toBe("already_applied");
    expect(() => applyRecipe(ORDER_TYPE_REF, output.files)).toThrow("recipe_already_applied");
  });

  it("restores every type edit byte-identical via inverse operations", () => {
    const before = files();
    const output = applyRecipe(ORDER_TYPE_REF, before);
    const restored = applyInverseOperations(ORDER_TYPE_REF, output.files, output.operations);
    expect(recipeFilesDigest(restored)).toBe(output.inputDigest);
    expect(restored).toEqual(before);
  });

  it("abstains when the declaration is unresolvable (completeness invariant)", () => {
    const broken = { ...files(), "src/order-types.ts": "export interface SomethingElse { id: string; }\n" };
    const analysis = analyzeRecipe(ORDER_TYPE_REF, broken);
    expect(analysis.status).toBe("unsupported");
    expect(analysis.matchedPaths).toEqual([]);
    expect(analysis.reasons).toContain("recipe_internal_api_type_declaration_unresolved");
  });

  it("abstains on a same-named type imported from a different module (false-positive trap)", () => {
    // References the recipe module (for a different symbol) but binds OrderRecord
    // from a different module, so the binding cannot be resolved to this rename.
    const wrongModule = [
      'import type { OrderTotal } from "./order-types.js";',
      'import type { OrderRecord } from "./other-types.js";',
      "export function total(order: OrderRecord): OrderTotal {",
      "  return { total: order.total };",
      "}",
      "",
    ].join("\n");
    const analysis = analyzeRecipe(ORDER_TYPE_REF, { ...files(), "src/order-service.ts": wrongModule });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons).toContain("recipe_internal_api_type_binding_unresolved");
  });

  it("abstains when the type name is also declared as a value (collision/shadow)", () => {
    const collision = [
      "export interface OrderRecord { id: string; total: number; }",
      "export const OrderRecord = { id: '', total: 0 };",
      "",
    ].join("\n");
    const analysis = analyzeRecipe(ORDER_TYPE_REF, { ...files(), "src/order-types.ts": collision });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons).toContain("recipe_internal_api_type_value_collision");
  });

  it("abstains when the type name is used as a value reference", () => {
    const asValue = [
      'import type { OrderRecord } from "./order-types.js";',
      "export const marker = OrderRecord;",
      "",
    ].join("\n");
    const analysis = analyzeRecipe(ORDER_TYPE_REF, { ...files(), "src/order-service.ts": asValue });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons).toContain("recipe_internal_api_type_value_reference");
  });

  it("leaves a same-named member access on an unrelated object untouched", () => {
    const withMember = [
      'import type { OrderRecord } from "./order-types.js";',
      "export function total(order: OrderRecord): number {",
      "  return schema.OrderRecord ? order.total : 0;",
      "}",
      "",
    ].join("\n");
    const output = applyRecipe(ORDER_TYPE_REF, { ...files(), "src/order-service.ts": withMember });
    const migrated = output.files["src/order-service.ts"]!;
    expect(migrated).toContain("order: OrderRow");
    expect(migrated).toContain("schema.OrderRecord");
  });

  it("is a spec-driven factory with an independent digest and validates", () => {
    const other = createInternalApiTypeRenameRecipe({
      recipeId: "internal-api-type-widget-to-gadget",
      version: 1,
      title: "Internal API type refactor: Widget to Gadget",
      source: "types-Widget",
      target: "types-Gadget",
      module: "@acme/widgets",
      from: "Widget",
      to: "Gadget",
      paths: ["src/use-widget.ts"],
    });
    expect(() => validateRecipe(other)).not.toThrow();
    expect(other.digest).not.toBe(getRecipe("internal-api-order-record-to-order-row", 1).digest);
    expect(other.preconditions[0]!.kind).toBe("internal_api_type_rename_source");
    expect(other.transforms[0]!.kind).toBe("internal_api_type_rename");
  });
});

// ---------------------------------------------------------------------------
// Workspace-wide rename across a mixed barrel and two module specifiers.
//
// The `internal-api-ledgerkit-compute-to-derive-balance` recipe renames the
// exported value `computeLedgerBalance` to `deriveLedgerBalance` across a
// multi-package workspace. It exercises, in one campaign, every form the engine
// supports: the declaration + internal call, a barrel that mixes a plain
// re-export with an aliased re-export (whose public alias must be preserved), a
// `typeof` consumer that reaches the symbol through a sibling relative specifier
// (`./ledger`), and three cross-package consumers reached through the package
// name (`@ledgerkit/core`): a named import, a value import + typed assignment,
// and a namespace member access. Fixtures below mirror the corpus subject
// `regauge/internal-api-rename` so the assertions are machine-independent.
// ---------------------------------------------------------------------------

const LEDGER_REF = recipeReference(INTERNAL_API_LEDGER_BALANCE_RENAME_RECIPE);

const LEDGER_LEDGER_TS = [
  'export type EntryDirection = "debit" | "credit";',
  "export interface LedgerEntry { id: string; direction: EntryDirection; minorUnits: number; }",
  "export function computeLedgerBalance(entries: readonly LedgerEntry[]): number {",
  "  let balance = 0;",
  "  for (const entry of entries) {",
  '    balance += entry.direction === "credit" ? entry.minorUnits : -entry.minorUnits;',
  "  }",
  "  return balance;",
  "}",
  "export function isLedgerSettled(entries: readonly LedgerEntry[]): boolean {",
  "  return computeLedgerBalance(entries) === 0;",
  "}",
  "",
].join("\n");

const LEDGER_INDEX_TS = [
  "// Public barrel for @ledgerkit/core.",
  'export { computeLedgerBalance, isLedgerSettled } from "./ledger";',
  "// Stable public alias. Do not rename `legacyBalance`: it is a supported name.",
  'export { computeLedgerBalance as legacyBalance } from "./ledger";',
  'export type { LedgerEntry, EntryDirection, LedgerBalanceFn } from "./types";',
  "",
].join("\n");

const LEDGER_TYPES_TS = [
  'import { computeLedgerBalance, type LedgerEntry } from "./ledger";',
  'export type { LedgerEntry } from "./ledger";',
  "export type LedgerBalanceFn = typeof computeLedgerBalance;",
  "export interface BalanceReport { entries: readonly LedgerEntry[]; balanceMinorUnits: number; }",
  "",
].join("\n");

const LEDGER_ROUTES_TS = [
  'import { computeLedgerBalance, type LedgerEntry } from "@ledgerkit/core";',
  "export interface BalanceRequest { accountId: string; entries: readonly LedgerEntry[]; }",
  "export function handleBalance(request: BalanceRequest): number {",
  "  return computeLedgerBalance(request.entries);",
  "}",
  "export function handleBatchBalances(requests: readonly BalanceRequest[]): number[] {",
  "  return requests.map((request) => computeLedgerBalance(request.entries));",
  "}",
  "",
].join("\n");

const LEDGER_TYPED_TS = [
  'import type { LedgerBalanceFn, LedgerEntry } from "@ledgerkit/core";',
  'import { computeLedgerBalance } from "@ledgerkit/core";',
  "const balanceFn: LedgerBalanceFn = computeLedgerBalance;",
  "export function defaultBalanceFn(entries: readonly LedgerEntry[]): number {",
  "  return balanceFn(entries);",
  "}",
  "",
].join("\n");

const LEDGER_JOB_TS = [
  'import * as core from "@ledgerkit/core";',
  "export interface SettlementJob { accountId: string; entries: core.LedgerEntry[]; }",
  "export function runSettlement(job: SettlementJob): number {",
  "  return core.computeLedgerBalance(job.entries);",
  "}",
  "",
].join("\n");

// Intra-package unit test: imports the symbol through the barrel (`../src/index`)
// and calls it. The import + call sites must rename, but the descriptive test
// name strings that mention the old name are string literals and must survive.
const LEDGER_CORE_TEST_TS = [
  'import { test } from "node:test";',
  'import { computeLedgerBalance, type LedgerEntry } from "../src/index";',
  "const entries: LedgerEntry[] = [];",
  'test("computeLedgerBalance nets credits against debits", () => {',
  "  computeLedgerBalance(entries);",
  "});",
  "",
].join("\n");

function ledgerFiles(): RecipeFiles {
  return {
    "packages/api/src/routes.ts": LEDGER_ROUTES_TS,
    "packages/api/src/typed.ts": LEDGER_TYPED_TS,
    "packages/core/src/index.ts": LEDGER_INDEX_TS,
    "packages/core/src/ledger.ts": LEDGER_LEDGER_TS,
    "packages/core/src/types.ts": LEDGER_TYPES_TS,
    "packages/core/test/ledger.test.ts": LEDGER_CORE_TEST_TS,
    "packages/worker/src/job.ts": LEDGER_JOB_TS,
  };
}

const LEDGER_ALLOWED_PATHS = [
  "packages/api/src/routes.ts",
  "packages/api/src/typed.ts",
  "packages/core/src/index.ts",
  "packages/core/src/ledger.ts",
  "packages/core/src/types.ts",
  "packages/core/test/ledger.test.ts",
  "packages/worker/src/job.ts",
];

describe("internal-api ledgerkit workspace rename (mixed barrel, two specifiers)", () => {
  it("is a valid, registered, content-addressed recipe with the expected scope", () => {
    expect(() => validateRecipe(INTERNAL_API_LEDGER_BALANCE_RENAME_RECIPE)).not.toThrow();
    expect(getRecipe("internal-api-ledgerkit-compute-to-derive-balance", 1)).toBe(
      INTERNAL_API_LEDGER_BALANCE_RENAME_RECIPE,
    );
    expect(resolveRecipe(LEDGER_REF)).toBe(INTERNAL_API_LEDGER_BALANCE_RENAME_RECIPE);
    expect([...INTERNAL_API_LEDGER_BALANCE_RENAME_RECIPE.allowedPaths]).toEqual(LEDGER_ALLOWED_PATHS);
    // The intra-package consumer carries its own relative specifier; the rest use
    // the package name. Paths are data, not hardcoded to one layout.
    const modules = new Map(
      INTERNAL_API_LEDGER_BALANCE_RENAME_RECIPE.transforms
        .filter(
          (t): t is Extract<typeof t, { kind: "internal_api_rename" }> =>
            t.kind === "internal_api_rename",
        )
        .map((t) => [t.path, t.module] as const),
    );
    expect(modules.get("packages/core/src/types.ts")).toBe("./ledger");
    expect(modules.get("packages/api/src/routes.ts")).toBe("@ledgerkit/core");
  });

  it("migrates all five forms across the workspace and leaves the sources coherent", () => {
    const before = ledgerFiles();
    const analysis = analyzeRecipe(LEDGER_REF, before);
    expect(analysis.status).toBe("applicable");
    expect([...analysis.matchedPaths]).toEqual(LEDGER_ALLOWED_PATHS);
    expect(analysis.reasons).toEqual([]);

    const out = applyRecipe(LEDGER_REF, before);

    // Form 1: declaration + internal call.
    expect(out.files["packages/core/src/ledger.ts"]).toContain(
      "export function deriveLedgerBalance(entries: readonly LedgerEntry[]): number",
    );
    expect(out.files["packages/core/src/ledger.ts"]).toContain(
      "return deriveLedgerBalance(entries) === 0;",
    );

    // Form 2: barrel plain re-export renamed; aliased re-export source renamed but
    // the public alias name `legacyBalance` preserved (Case A abstain).
    expect(out.files["packages/core/src/index.ts"]).toContain(
      'export { deriveLedgerBalance, isLedgerSettled } from "./ledger";',
    );
    expect(out.files["packages/core/src/index.ts"]).toContain(
      'export { deriveLedgerBalance as legacyBalance } from "./ledger";',
    );

    // Form 3: named import + both call sites.
    expect(out.files["packages/api/src/routes.ts"]).toContain(
      'import { deriveLedgerBalance, type LedgerEntry } from "@ledgerkit/core";',
    );
    expect(out.files["packages/api/src/routes.ts"]).toContain(
      "return deriveLedgerBalance(request.entries);",
    );

    // Form 4: type position. `typeof` target + value import + typed assignment
    // renamed; the `LedgerBalanceFn` type name itself is unchanged.
    expect(out.files["packages/core/src/types.ts"]).toContain(
      "export type LedgerBalanceFn = typeof deriveLedgerBalance;",
    );
    expect(out.files["packages/core/src/types.ts"]).toContain(
      'import { deriveLedgerBalance, type LedgerEntry } from "./ledger";',
    );
    expect(out.files["packages/api/src/typed.ts"]).toContain(
      "const balanceFn: LedgerBalanceFn = deriveLedgerBalance;",
    );
    expect(out.files["packages/api/src/typed.ts"]).toContain(
      'import type { LedgerBalanceFn, LedgerEntry } from "@ledgerkit/core";',
    );

    // Form 5: namespace member access renamed; the `core.LedgerEntry` member and
    // the namespace binding are untouched.
    expect(out.files["packages/worker/src/job.ts"]).toContain(
      "return core.deriveLedgerBalance(job.entries);",
    );
    expect(out.files["packages/worker/src/job.ts"]).toContain("entries: core.LedgerEntry[]");
    expect(out.files["packages/worker/src/job.ts"]).toContain(
      'import * as core from "@ledgerkit/core";',
    );

    // Extra form: the intra-package unit test imports through the barrel
    // (`../src/index`). Its import and call site rename; the descriptive string
    // that happens to mention the old name is a literal and is left intact.
    expect(out.files["packages/core/test/ledger.test.ts"]).toContain(
      'import { deriveLedgerBalance, type LedgerEntry } from "../src/index";',
    );
    expect(out.files["packages/core/test/ledger.test.ts"]).toContain("  deriveLedgerBalance(entries);");
    expect(out.files["packages/core/test/ledger.test.ts"]).toContain(
      'test("computeLedgerBalance nets credits against debits"',
    );

    // No form leaves a live `computeLedgerBalance` reference behind (calls,
    // imports, exports); only string literals may still mention it. The
    // deliberately stable public alias `legacyBalance` also survives.
    for (const path of INTERNAL_API_LEDGER_BALANCE_RENAME_RECIPE.allowedPaths) {
      expect(out.files[path]).not.toMatch(/\bcomputeLedgerBalance\s*\(/);
      expect(out.files[path]).not.toMatch(/\{[^}]*\bcomputeLedgerBalance\b[^}]*\}\s*(?:from|;)/);
    }
    expect(out.files["packages/core/src/index.ts"]).toMatch(/\blegacyBalance\b/);
  });

  it("is idempotent: a fully migrated tree reports already_applied and refuses to re-apply", () => {
    const out = applyRecipe(LEDGER_REF, ledgerFiles());
    const reanalysis = analyzeRecipe(LEDGER_REF, out.files);
    expect(reanalysis.status).toBe("already_applied");
    expect(() => applyRecipe(LEDGER_REF, out.files)).toThrow("recipe_already_applied");
  });

  it("restores the exact input via inverse operations", () => {
    const before = ledgerFiles();
    const out = applyRecipe(LEDGER_REF, before);
    const restored = applyInverseOperations(LEDGER_REF, out.files, out.operations);
    expect(recipeFilesDigest(restored)).toBe(out.inputDigest);
    expect(restored).toEqual(before);
  });

  it("leaves aliased-export consumers and a same-named reports symbol out of scope", () => {
    // Neither the alias consumer (`legacyBalance` from @ledgerkit/core) nor the
    // reports package (its own `computeLedgerBalance` from @ledgerkit/reports) is
    // in scope. The campaign never lists them, so they cannot be edited.
    const scope = new Set(INTERNAL_API_LEDGER_BALANCE_RENAME_RECIPE.allowedPaths);
    expect(scope.has("packages/api/src/legacy.ts")).toBe(false);
    expect(scope.has("packages/reports/src/stats.ts")).toBe(false);
  });
});

describe("internal-api rename parameterization and abstention traps", () => {
  const TENANT = "recipes-test";
  const withAuthoring = <T>(run: () => T): T => {
    const prior = process.env.MENDPOINT_REGAUGE_RECIPE_AUTHORING_ENABLED;
    process.env.MENDPOINT_REGAUGE_RECIPE_AUTHORING_ENABLED = "1";
    try {
      return run();
    } finally {
      if (prior === undefined) delete process.env.MENDPOINT_REGAUGE_RECIPE_AUTHORING_ENABLED;
      else process.env.MENDPOINT_REGAUGE_RECIPE_AUTHORING_ENABLED = prior;
    }
  };

  it("matches a repo whose layout differs entirely from any fixture", () => {
    withAuthoring(() => {
      // A flat, single-package layout the shipped recipes never mention.
      const recipe = authorFactoryRecipe(
        "internal_api_rename",
        {
          recipeId: "internal-api-flat-layout",
          version: 1,
          title: "flat layout rename",
          source: "flat-a",
          target: "flat-b",
          module: "./balance.js",
          from: "computeLedgerBalance",
          to: "deriveLedgerBalance",
          paths: ["lib/api.ts"],
          declarationPaths: ["lib/balance.ts"],
        },
        { tenantId: TENANT },
      );
      const ref = recipeReference(recipe);
      const files: RecipeFiles = {
        "lib/balance.ts":
          "export function computeLedgerBalance(n: number[]): number { return n.length; }\n",
        "lib/api.ts": [
          'import { computeLedgerBalance } from "./balance.js";',
          "export const total = (n: number[]): number => computeLedgerBalance(n);",
          "",
        ].join("\n"),
      };
      const analysis = analyzeRecipe(ref, files, { tenantId: TENANT });
      expect(analysis.status).toBe("applicable");
      const out = applyRecipe(ref, files, { tenantId: TENANT });
      expect(out.files["lib/balance.ts"]).toContain("export function deriveLedgerBalance(");
      expect(out.files["lib/api.ts"]).toContain(
        'import { deriveLedgerBalance } from "./balance.js";',
      );
      expect(out.files["lib/api.ts"]).toContain("=> deriveLedgerBalance(n);");
    });
  });

  it("abstains with a reason when asked to rename a stable public alias (Case A)", () => {
    withAuthoring(() => {
      const recipe = authorFactoryRecipe(
        "internal_api_rename",
        {
          recipeId: "internal-api-alias-trap",
          version: 1,
          title: "alias trap",
          source: "alias-a",
          target: "alias-b",
          module: "./ledger.js",
          from: "legacyBalance",
          to: "renamedBalance",
          paths: ["src/consumer.ts"],
          declarationPaths: ["src/index.ts"],
        },
        { tenantId: TENANT },
      );
      const ref = recipeReference(recipe);
      const files: RecipeFiles = {
        // The public name `legacyBalance` exists only as the target of a re-export
        // alias, which the engine refuses to move.
        "src/index.ts": 'export { computeLedgerBalance as legacyBalance } from "./ledger";\n',
        "src/consumer.ts": [
          'import { legacyBalance } from "./ledger.js";',
          "export const run = (n: number[]): number => legacyBalance(n);",
          "",
        ].join("\n"),
      };
      const analysis = analyzeRecipe(ref, files, { tenantId: TENANT });
      expect(analysis.status).toBe("unsupported");
      expect(analysis.reasons).toContain("recipe_internal_api_declaration_aliased_export");
      expect(() => applyRecipe(ref, files, { tenantId: TENANT })).toThrow(
        "recipe_internal_api_declaration_aliased_export",
      );
    });
  });

  it("abstains with a reason on a same-named symbol bound from a different module (Case B)", () => {
    withAuthoring(() => {
      const recipe = authorFactoryRecipe(
        "internal_api_rename",
        {
          recipeId: "internal-api-samename-trap",
          version: 1,
          title: "same-name trap",
          source: "samename-a",
          target: "samename-b",
          module: "@ledgerkit/core",
          from: "computeLedgerBalance",
          to: "deriveLedgerBalance",
          paths: ["src/summary.ts"],
        },
        { tenantId: TENANT },
      );
      const ref = recipeReference(recipe);
      const files: RecipeFiles = {
        // References @ledgerkit/core (so the module guard passes) but binds the
        // name `computeLedgerBalance` from the unrelated @ledgerkit/reports.
        "src/summary.ts": [
          'import { type LedgerEntry } from "@ledgerkit/core";',
          'import { computeLedgerBalance } from "@ledgerkit/reports";',
          "export const summarize = (entries: readonly LedgerEntry[]): number =>",
          "  computeLedgerBalance(entries);",
          "",
        ].join("\n"),
      };
      const analysis = analyzeRecipe(ref, files, { tenantId: TENANT });
      expect(analysis.status).toBe("unsupported");
      expect(analysis.reasons).toContain("recipe_internal_api_binding_unresolved");
    });
  });
});
