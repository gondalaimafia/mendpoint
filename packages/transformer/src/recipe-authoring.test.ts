import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INTERNAL_API_ACME_USER_RENAME_RECIPE,
  analyzeRecipe,
  applyInverseOperations,
  applyRecipe,
  authorFactoryRecipe,
  getRecipe,
  recipeFilesDigest,
  recipeReference,
  resolveRecipe,
  validateRecipe,
  type RecipeFiles,
} from "./recipe.js";

// The runtime authoring flag is default-off; every authoring test enables it
// explicitly and restores the prior value afterwards so the flag-off suite below
// observes the true default.
const FLAG = "MENDPOINT_REGAUGE_RECIPE_AUTHORING_ENABLED";

function withFlag(value: string | undefined): void {
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
}

// A synthetic bare-module rename: `getInvoice` -> `fetchInvoice` imported from an
// external package, so no declaration path is required. Byte-round-trippable.
const BILLING_SOURCE = [
  'import { getInvoice } from "@acme/billing-service";',
  'import { formatMoney } from "@acme/format";',
  "",
  "export async function loadInvoice(id: string): Promise<string> {",
  "  const invoice = await getInvoice(id);",
  "  return formatMoney(invoice);",
  "}",
  "",
].join("\n");

function billingSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recipeId: "internal-api-runtime-billing-rename",
    version: 1,
    title: "Internal API refactor: billing getInvoice to fetchInvoice",
    source: "billing-getInvoice",
    target: "billing-fetchInvoice",
    module: "@acme/billing-service",
    from: "getInvoice",
    to: "fetchInvoice",
    paths: ["src/billing.ts"],
    ...overrides,
  };
}

describe("authorFactoryRecipe: factory-only runtime authoring", () => {
  let priorFlag: string | undefined;

  beforeEach(() => {
    priorFlag = process.env[FLAG];
    withFlag("1");
  });

  afterEach(() => {
    withFlag(priorFlag);
  });

  it("authors, analyzes, applies end-to-end, and inverse-restores byte-identical", () => {
    const tenantId = "tenant-alpha";
    const recipe = authorFactoryRecipe("internal_api_rename", billingSpec(), { tenantId });
    expect(() => validateRecipe(recipe)).not.toThrow();

    // The authored recipe is resolvable only through the runtime registry for its
    // tenant; it is not in the static registry.
    const reference = recipeReference(recipe);
    expect(resolveRecipe(reference, { tenantId })).toBe(recipe);

    const before: RecipeFiles = { "src/billing.ts": BILLING_SOURCE };
    const analysis = analyzeRecipe(reference, before, { tenantId });
    expect(analysis.status).toBe("applicable");
    expect([...analysis.matchedPaths]).toEqual(["src/billing.ts"]);
    expect(analysis.reasons).toEqual([]);

    const application = applyRecipe(reference, before, { tenantId });
    expect(application.operations.map((operation) => operation.path)).toEqual([
      "src/billing.ts",
    ]);
    expect(application.files["src/billing.ts"]).toContain(
      'import { fetchInvoice } from "@acme/billing-service";',
    );
    expect(application.files["src/billing.ts"]).toContain("await fetchInvoice(id)");
    expect(application.files["src/billing.ts"]).not.toContain("getInvoice");

    const restored = applyInverseOperations(
      reference,
      application.files,
      application.operations,
      { tenantId },
    );
    expect(restored).toEqual(before);
    expect(recipeFilesDigest(restored)).toBe(application.inputDigest);
  });

  it("supports the type-rename factory as a second built-in", () => {
    const tenantId = "tenant-types";
    const recipe = authorFactoryRecipe(
      "internal_api_type_rename",
      {
        recipeId: "internal-api-runtime-order-type-rename",
        version: 1,
        title: "Internal API type refactor: OrderRecord to OrderRow",
        source: "types-OrderRecord",
        target: "types-OrderRow",
        module: "@acme/order-types",
        from: "OrderRecord",
        to: "OrderRow",
        paths: ["src/order-view.ts"],
      },
      { tenantId },
    );
    expect(() => validateRecipe(recipe)).not.toThrow();
    expect(resolveRecipe(recipeReference(recipe), { tenantId })).toBe(recipe);
  });

  it("rejects an unknown factory name and registers nothing", () => {
    expect(() =>
      // @ts-expect-error deliberately invalid factory name
      authorFactoryRecipe("register_arbitrary_contract", billingSpec()),
    ).toThrow("recipe_factory_unknown");
    expect(() => getRecipe("internal-api-runtime-billing-rename", 1)).toThrow(
      /recipe_not_found/,
    );
  });

  // Each malformed-params test uses a unique recipeId + tenant so the
  // "registers nothing" assertion targets an id no other test ever authors,
  // independent of the shared module-level registry and test order.
  it("rejects an unknown params key with a clear code and registers nothing", () => {
    const id = "internal-api-runtime-unknown-key";
    const tenantId = "tenant-unknown-key";
    expect(() =>
      authorFactoryRecipe(
        "internal_api_rename",
        billingSpec({ recipeId: id, verificationCommand: "node -e \"process.exit(0)\"" }),
        { tenantId },
      ),
    ).toThrow("recipe_params_unknown_key:verificationCommand");
    expect(() => getRecipe(id, 1, { tenantId })).toThrow(/recipe_not_found/);
  });

  it("rejects a wrong-typed field with a clear code and registers nothing", () => {
    const id = "internal-api-runtime-wrong-type";
    const tenantId = "tenant-wrong-type";
    expect(() =>
      authorFactoryRecipe(
        "internal_api_rename",
        billingSpec({ recipeId: id, paths: "src/billing.ts" }),
        { tenantId },
      ),
    ).toThrow("recipe_params_invalid:paths");
    expect(() =>
      authorFactoryRecipe(
        "internal_api_rename",
        billingSpec({ recipeId: id, version: "1" }),
        { tenantId },
      ),
    ).toThrow("recipe_params_invalid:version");
    expect(() => getRecipe(id, 1, { tenantId })).toThrow(/recipe_not_found/);
  });

  it("rejects a missing required field with a clear code and registers nothing", () => {
    const id = "internal-api-runtime-missing";
    const tenantId = "tenant-missing";
    const spec = billingSpec({ recipeId: id });
    delete spec.from;
    expect(() => authorFactoryRecipe("internal_api_rename", spec, { tenantId })).toThrow(
      "recipe_params_missing:from",
    );
    expect(() => getRecipe(id, 1, { tenantId })).toThrow(/recipe_not_found/);
  });

  it("rejects an over-cap paths spec and registers nothing", () => {
    const id = "internal-api-runtime-overcap";
    const tenantId = "tenant-overcap";
    const tooMany = Array.from({ length: 201 }, (_unused, index) => `src/file-${index}.ts`);
    expect(() =>
      authorFactoryRecipe("internal_api_rename", billingSpec({ recipeId: id, paths: tooMany }), {
        tenantId,
      }),
    ).toThrow("recipe_params_paths_over_cap");
    expect(() => getRecipe(id, 1, { tenantId })).toThrow(/recipe_not_found/);
  });

  it("rejects an invalid tenant id", () => {
    expect(() =>
      authorFactoryRecipe("internal_api_rename", billingSpec(), { tenantId: "bad tenant!" }),
    ).toThrow("recipe_tenant_id_invalid");
  });

  it("isolates recipes per tenant: tenant A cannot resolve tenant B's recipe", () => {
    const recipe = authorFactoryRecipe(
      "internal_api_rename",
      billingSpec({ recipeId: "internal-api-runtime-tenant-scoped" }),
      { tenantId: "tenant-b" },
    );
    const reference = recipeReference(recipe);

    // Owner tenant resolves it.
    expect(resolveRecipe(reference, { tenantId: "tenant-b" })).toBe(recipe);
    // A different tenant cannot, even holding the exact id/version/digest.
    expect(() => resolveRecipe(reference, { tenantId: "tenant-a" })).toThrow(
      /recipe_not_found/,
    );
    // The untenanted global scope cannot either.
    expect(() => resolveRecipe(reference)).toThrow(/recipe_not_found/);
    // And analysis for the wrong tenant is refused before any file work.
    expect(() =>
      analyzeRecipe(reference, { "src/billing.ts": BILLING_SOURCE }, { tenantId: "tenant-a" }),
    ).toThrow(/recipe_not_found/);
  });

  it("re-authoring an identical spec for the same tenant is idempotent", () => {
    const first = authorFactoryRecipe(
      "internal_api_rename",
      billingSpec({ recipeId: "internal-api-runtime-idempotent" }),
      { tenantId: "tenant-idem" },
    );
    const second = authorFactoryRecipe(
      "internal_api_rename",
      billingSpec({ recipeId: "internal-api-runtime-idempotent" }),
      { tenantId: "tenant-idem" },
    );
    expect(second).toBe(first);
  });

  it("rejects a conflicting spec re-using an authored id@version for the same tenant", () => {
    authorFactoryRecipe(
      "internal_api_rename",
      billingSpec({ recipeId: "internal-api-runtime-conflict" }),
      { tenantId: "tenant-conflict" },
    );
    expect(() =>
      authorFactoryRecipe(
        "internal_api_rename",
        billingSpec({ recipeId: "internal-api-runtime-conflict", to: "readInvoice" }),
        { tenantId: "tenant-conflict" },
      ),
    ).toThrow("recipe_authoring_conflict");
  });

  it("refuses to shadow a shipped static recipe id@version", () => {
    expect(() =>
      authorFactoryRecipe(
        "internal_api_rename",
        {
          recipeId: "internal-api-acme-user-getuser-to-fetchuser",
          version: 1,
          title: "shadow attempt",
          source: "s",
          target: "t",
          module: "@acme/user-service",
          from: "getUser",
          to: "fetchUser",
          paths: ["src/profile.ts"],
        },
        { tenantId: "tenant-alpha" },
      ),
    ).toThrow("recipe_authoring_conflict");
  });
});

describe("authorFactoryRecipe: flag off (default)", () => {
  let priorFlag: string | undefined;

  beforeEach(() => {
    priorFlag = process.env[FLAG];
    withFlag(undefined);
  });

  afterEach(() => {
    withFlag(priorFlag);
  });

  it("refuses authoring with a clear code when the flag is off", () => {
    expect(() =>
      authorFactoryRecipe("internal_api_rename", billingSpec(), { tenantId: "tenant-alpha" }),
    ).toThrow("recipe_authoring_disabled");
  });

  it("leaves static recipe resolution exactly as before", () => {
    const reference = recipeReference(INTERNAL_API_ACME_USER_RENAME_RECIPE);
    expect(getRecipe("internal-api-acme-user-getuser-to-fetchuser", 1)).toBe(
      INTERNAL_API_ACME_USER_RENAME_RECIPE,
    );
    expect(resolveRecipe(reference)).toBe(INTERNAL_API_ACME_USER_RENAME_RECIPE);
  });
});

describe("static registry stability", () => {
  it("keeps the acme recipe signed digest pinned (must not move)", () => {
    expect(INTERNAL_API_ACME_USER_RENAME_RECIPE.digest).toBe(
      "sha256:29b53d3c8669e0d940d2a1eb2b50e5259784e585d7d8292f58ff4e2a110577d1",
    );
  });
});
