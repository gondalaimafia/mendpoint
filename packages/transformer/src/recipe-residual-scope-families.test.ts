import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AWS_SDK_JS_V2_TO_V3_RECIPE,
  GOOGLEAPIS_V25_TO_V26_RECIPE,
  INTERNAL_API_ACME_USER_RENAME_RECIPE,
  INTERNAL_API_LEDGER_BALANCE_RENAME_RECIPE,
  NODE_RUNTIME_18_TO_20_RECIPE,
  REACT_DOM_17_TO_18_RECIPE,
  STRIPE_NODE_V10_TO_V11_RECIPE,
  analyzeRecipe,
  applyRecipe,
  getRecipe,
  recipeReference,
  type MigrationRecipeContract,
  type RecipeFiles,
} from "./recipe.js";

// Load a family's `before` fixture (the allowlisted source that classifies as a
// clean, applicable migration) so each residual case starts from a genuinely
// applicable snapshot and only the extra out-of-scope file is under test.
function loadBefore(fixture: string, paths: readonly string[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const path of paths) {
    files[path] = readFileSync(
      fileURLToPath(new URL(`../../../fixtures/consumers/${fixture}/before/${path}`, import.meta.url)),
      "utf8",
    );
  }
  return files;
}

function expectIncomplete(
  recipe: MigrationRecipeContract,
  input: RecipeFiles,
  residualPaths: readonly string[],
): void {
  const reference = recipeReference(recipe);
  const analysis = analyzeRecipe(reference, input);
  expect(analysis.status).toBe("incomplete");
  expect([...analysis.residualPaths]).toEqual([...residualPaths]);
  for (const path of residualPaths) {
    expect(analysis.reasons).toContain(`recipe_incomplete_residual:${path}`);
  }
  // Applying an incomplete migration is refused, never reported as a success.
  expect(() => applyRecipe(reference, input)).toThrow(
    `recipe_incomplete_residual:${residualPaths[0]}`,
  );
  // The residual sites are never edited: they are outside allowedPaths.
  for (const path of residualPaths) {
    expect(recipe.allowedPaths).not.toContain(path);
  }
}

function expectApplicable(recipe: MigrationRecipeContract, input: RecipeFiles): void {
  const analysis = analyzeRecipe(recipeReference(recipe), input);
  expect(analysis.status).toBe("applicable");
  expect(analysis.residualPaths).toEqual([]);
}

// ---------------------------------------------------------------------------
// Repo-global manifest transforms: a dependency removed/bumped for the WHOLE
// repository while a file outside allowedPaths still imports or uses it. Before
// this fix, every one of these classified as a clean, verified success.
// ---------------------------------------------------------------------------

describe("aws-sdk residual detection (dependency removal, repo-global)", () => {
  const AWS_PATHS = ["package.json", "src/s3.js", "src/dynamo.js"] as const;

  it("refuses when a file outside allowedPaths still imports the removed aws-sdk", () => {
    const input: RecipeFiles = {
      ...loadBefore("aws-sdk-v2-to-v3", AWS_PATHS),
      // The exact demonstrated regression: aws-sdk is dropped from dependencies
      // repo-wide, but this file still requires it and would fail to install.
      "src/queue.js": 'const AWS = require("aws-sdk");\n\nmodule.exports = AWS;\n',
    };
    expectIncomplete(AWS_SDK_JS_V2_TO_V3_RECIPE, input, ["src/queue.js"]);
  });

  it("also refuses an out-of-scope import form (ESM named) of the removed module", () => {
    const input: RecipeFiles = {
      ...loadBefore("aws-sdk-v2-to-v3", AWS_PATHS),
      // The recipe's source rewrite does not recognize a named import, but the
      // package still vanishes from under it, so it is residue all the same.
      "src/extra.js": 'import { S3 } from "aws-sdk";\n\nexport const client = new S3();\n',
    };
    expectIncomplete(AWS_SDK_JS_V2_TO_V3_RECIPE, input, ["src/extra.js"]);
  });

  it("does not flag an already-migrated @aws-sdk/* importer (no false alarm)", () => {
    const input: RecipeFiles = {
      ...loadBefore("aws-sdk-v2-to-v3", AWS_PATHS),
      "src/other.js":
        'const { S3Client } = require("@aws-sdk/client-s3");\n\nmodule.exports = new S3Client({});\n',
    };
    expectApplicable(AWS_SDK_JS_V2_TO_V3_RECIPE, input);
  });

  it("does not scan node_modules or lockfiles for the removed module", () => {
    const input: RecipeFiles = {
      ...loadBefore("aws-sdk-v2-to-v3", AWS_PATHS),
      "node_modules/legacy/index.js": 'const AWS = require("aws-sdk");\nmodule.exports = AWS;\n',
      "package-lock.json": JSON.stringify(
        { packages: { "node_modules/aws-sdk": { version: "2.1600.0" } } },
        null,
        2,
      ),
    };
    expectApplicable(AWS_SDK_JS_V2_TO_V3_RECIPE, input);
  });
});

describe("googleapis residual detection (dependency bump, repo-global)", () => {
  const GOOGLEAPIS_PATHS = ["package.json", "src/client.js"] as const;

  it("refuses when a file outside allowedPaths still uses the v25 default import", () => {
    const input: RecipeFiles = {
      ...loadBefore("googleapis-v25-to-v26", GOOGLEAPIS_PATHS),
      "src/other.js":
        'const google = require("googleapis");\n\n' +
        "module.exports = () => google.sheets({ version: \"v4\" });\n",
    };
    expectIncomplete(GOOGLEAPIS_V25_TO_V26_RECIPE, input, ["src/other.js"]);
  });

  it("does not flag a file already on the named v26 import (no false alarm)", () => {
    const input: RecipeFiles = {
      ...loadBefore("googleapis-v25-to-v26", GOOGLEAPIS_PATHS),
      "src/named.js":
        'const { google } = require("googleapis");\n\n' +
        "module.exports = () => google.drive({ version: \"v3\" });\n",
    };
    expectApplicable(GOOGLEAPIS_V25_TO_V26_RECIPE, input);
  });
});

describe("stripe residual detection (dependency bump, repo-global)", () => {
  const STRIPE_PATHS = ["package.json", "src/payments.js"] as const;

  it("refuses when a file outside allowedPaths still calls a removed v10 setter", () => {
    const input: RecipeFiles = {
      ...loadBefore("stripe-node-v10-to-v11", STRIPE_PATHS),
      "src/refunds.js":
        'const Stripe = require("stripe");\n\n' +
        "const stripe = Stripe(process.env.STRIPE_SECRET_KEY);\n" +
        'stripe.setApiVersion("2019-08-08");\n\n' +
        "module.exports = { stripe };\n",
    };
    expectIncomplete(STRIPE_NODE_V10_TO_V11_RECIPE, input, ["src/refunds.js"]);
  });

  it("does not flag a stray setTimeout on an unrelated object (no false alarm)", () => {
    const input: RecipeFiles = {
      ...loadBefore("stripe-node-v10-to-v11", STRIPE_PATHS),
      // `.setTimeout(` matches the removed-setter surface, but there is no Stripe
      // construction to anchor it: the recipe abstains, so it is not residue.
      "src/logger.js": "const socket = getSocket();\nsocket.setTimeout(1000);\n",
    };
    expectApplicable(STRIPE_NODE_V10_TO_V11_RECIPE, input);
  });
});

describe("react-dom residual detection (dependency bump, repo-global)", () => {
  const REACT_PATHS = ["package.json", "src/index.jsx"] as const;

  it("refuses when a file outside allowedPaths still uses the legacy render API", () => {
    const input: RecipeFiles = {
      ...loadBefore("react-dom-17-to-18", REACT_PATHS),
      "src/admin.jsx":
        'import ReactDOM from "react-dom";\nimport Admin from "./Admin";\n\n' +
        'ReactDOM.render(<Admin />, document.getElementById("admin"));\n',
    };
    expectIncomplete(REACT_DOM_17_TO_18_RECIPE, input, ["src/admin.jsx"]);
  });

  it("does not flag a file already on the react-dom/client root API (no false alarm)", () => {
    const input: RecipeFiles = {
      ...loadBefore("react-dom-17-to-18", REACT_PATHS),
      "src/modern.jsx":
        'import { createRoot } from "react-dom/client";\nimport Widget from "./Widget";\n\n' +
        'createRoot(document.getElementById("widget")).render(<Widget />);\n',
    };
    expectApplicable(REACT_DOM_17_TO_18_RECIPE, input);
  });
});

// ---------------------------------------------------------------------------
// Runtime family: six ordinary declaration forms the residual guard used to miss,
// even though the SAME values in the allowlisted root files are refused. Each is
// asserted individually so a single failing form is unambiguous.
// ---------------------------------------------------------------------------

describe("node runtime residual detection (previously missed forms)", () => {
  const ROOT_18: RecipeFiles = {
    "package.json": `${JSON.stringify(
      { name: "svc", private: true, engines: { node: ">=18 <19" } },
      null,
      2,
    )}\n`,
    ".nvmrc": "18\n",
    ".node-version": "18.20.4\n",
    Dockerfile: "FROM node:18-alpine AS build\n\nFROM node:18-alpine AS runtime\n",
  };
  const recipe = NODE_RUNTIME_18_TO_20_RECIPE;

  const dockerCases: ReadonlyArray<readonly [string, string, string]> = [
    [
      "a FROM with a --platform build flag",
      "docker/Dockerfile.ci",
      "FROM --platform=linux/amd64 node:18-alpine\nWORKDIR /app\n",
    ],
    [
      "a FROM pinned by digest",
      "docker/Dockerfile.pin",
      "FROM node:18@sha256:1111111111111111111111111111111111111111111111111111111111111111\n",
    ],
    [
      "a partially-migrated multi-stage build (one stage already on 20)",
      "docker/Dockerfile.multi",
      "FROM node:20-alpine AS build\n\nFROM node:18-alpine AS runtime\n",
    ],
  ];

  for (const [label, path, content] of dockerCases) {
    it(`flags ${label} as residual`, () => {
      expectIncomplete(recipe, { ...ROOT_18, [path]: content }, [path]);
    });
  }

  const engineCases: ReadonlyArray<readonly [string, string]> = [
    [">=18", "packages/a/package.json"],
    ["18.20.4", "packages/b/package.json"],
    ["^18", "packages/c/package.json"],
  ];

  for (const [value, path] of engineCases) {
    it(`flags a nested engines.node "${value}" as residual`, () => {
      const input: RecipeFiles = {
        ...ROOT_18,
        [path]: `${JSON.stringify({ engines: { node: value } }, null, 2)}\n`,
      };
      expectIncomplete(recipe, input, [path]);
    });
  }

  it("does not flag a nested Dockerfile or manifest already on the target (no false alarm)", () => {
    const input: RecipeFiles = {
      ...ROOT_18,
      "docker/Dockerfile.ci":
        "FROM --platform=linux/amd64 node:20@sha256:2222222222222222222222222222222222222222222222222222222222222222\n",
      "packages/a/package.json": `${JSON.stringify({ engines: { node: ">=20 <21" } }, null, 2)}\n`,
    };
    expectApplicable(recipe, input);
  });
});

// ---------------------------------------------------------------------------
// Internal-API rename family (the sixth family, previously missed entirely).
// The consumer-source preconditions (`internal_api_rename_source` and
// `internal_api_type_rename_source`) fell through the residual dispatch's bare
// `return false`, so a call site left on the old name outside allowedPaths made a
// partial rename read as a verified, applicable success. Both the value rename and
// the type rename are covered here, each with a clean-repo no-false-alarm case.
// ---------------------------------------------------------------------------

describe("internal-api value rename residual detection (consumer source)", () => {
  const ACME_PATHS = ["src/profile.ts", "src/settings.ts"] as const;

  it("refuses when a file outside allowedPaths still imports and calls the old name", () => {
    const input: RecipeFiles = {
      ...loadBefore("internal-api-acme-user-rename", ACME_PATHS),
      // The demonstrated regression: the rename lands in the two allowlisted
      // consumers, but this out-of-scope module still imports `getUser` from the
      // same package and calls it, so the workspace is only partially migrated.
      "src/legacy-report.ts":
        'import { getUser } from "@acme/user-service";\n\n' +
        "export async function report(id: string): Promise<string> {\n" +
        "  const user = await getUser(id);\n" +
        "  return String(user);\n" +
        "}\n",
    };
    expectIncomplete(INTERNAL_API_ACME_USER_RENAME_RECIPE, input, ["src/legacy-report.ts"]);
  });

  it("does not flag a file already on the renamed fetchUser call (no false alarm)", () => {
    const input: RecipeFiles = {
      ...loadBefore("internal-api-acme-user-rename", ACME_PATHS),
      "src/report.ts":
        'import { fetchUser } from "@acme/user-service";\n\n' +
        "export async function report(id: string): Promise<string> {\n" +
        "  const user = await fetchUser(id);\n" +
        "  return String(user);\n" +
        "}\n",
    };
    expectApplicable(INTERNAL_API_ACME_USER_RENAME_RECIPE, input);
  });

  it("does not flag a same-named import from a different module (recipe abstains)", () => {
    const input: RecipeFiles = {
      ...loadBefore("internal-api-acme-user-rename", ACME_PATHS),
      // `getUser` here comes from an unrelated package, so the classifier abstains
      // rather than guess: it is not the surface this recipe migrates.
      "src/other.ts":
        'import { getUser } from "@other/directory";\n\n' +
        "export const lookup = (id: string) => getUser(id);\n",
    };
    expectApplicable(INTERNAL_API_ACME_USER_RENAME_RECIPE, input);
  });
});

describe("internal-api type rename residual detection (consumer source)", () => {
  // The registered OrderRecord -> OrderRow interface rename. Its producer and the
  // two consumers form the applicable base; only the extra out-of-scope file varies.
  const ORDER_TYPE = getRecipe("internal-api-order-record-to-order-row", 1);
  const ORDER_BASE = (): RecipeFiles => ({
    "src/order-types.ts": "export interface OrderRecord {\n  id: string;\n  total: number;\n}\n",
    "src/order-service.ts":
      'import type { OrderRecord } from "./order-types.js";\n' +
      "export function total(order: OrderRecord): number {\n  return order.total;\n}\n",
    "src/order-view.ts":
      'import type { OrderRecord } from "./order-types.js";\n' +
      "export function render(order: OrderRecord): string {\n  return order.id;\n}\n",
  });

  it("refuses when a file outside allowedPaths still uses the old type name", () => {
    const input: RecipeFiles = {
      ...ORDER_BASE(),
      "src/order-report.ts":
        'import type { OrderRecord } from "./order-types.js";\n' +
        "export function summarize(order: OrderRecord): string {\n  return order.id;\n}\n",
    };
    expectIncomplete(ORDER_TYPE, input, ["src/order-report.ts"]);
  });

  it("does not flag a file already on the renamed OrderRow type (no false alarm)", () => {
    const input: RecipeFiles = {
      ...ORDER_BASE(),
      "src/order-report.ts":
        'import type { OrderRow } from "./order-types.js";\n' +
        "export function summarize(order: OrderRow): string {\n  return order.id;\n}\n",
    };
    expectApplicable(ORDER_TYPE, input);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed contract: residual detection must classify EVERY precondition kind
// a shipped recipe emits. An unhandled kind now resolves to "unresolved" and
// surfaces as an explicit `recipe_residual_unresolved:` exception instead of a
// silent clean success. This locks the dispatch against a new kind being added
// (to a recipe) without residual handling — the compile-time `never` guard is the
// primary enforcement; this is its runtime counterpart. The recipe set below
// collectively exercises all thirteen precondition kinds.
// ---------------------------------------------------------------------------

describe("residual detection covers every shipped precondition kind (fail closed)", () => {
  const ALL_FAMILY_RECIPES: readonly MigrationRecipeContract[] = [
    NODE_RUNTIME_18_TO_20_RECIPE,
    AWS_SDK_JS_V2_TO_V3_RECIPE,
    STRIPE_NODE_V10_TO_V11_RECIPE,
    GOOGLEAPIS_V25_TO_V26_RECIPE,
    REACT_DOM_17_TO_18_RECIPE,
    INTERNAL_API_ACME_USER_RENAME_RECIPE,
    INTERNAL_API_LEDGER_BALANCE_RENAME_RECIPE,
    getRecipe("internal-api-order-record-to-order-row", 1),
  ];

  it("never reports an unresolved coverage gap for a handled kind", () => {
    // A single out-of-allowlist probe file forces the whole-snapshot scan to run
    // every one of each recipe's preconditions through `isResidualSite`. With all
    // files for the recipe's own preconditions absent (neutral), no precondition
    // failure short-circuits the scan, so any kind that returned "unresolved"
    // would surface here.
    const probe: RecipeFiles = { "residual-scope-probe/marker.md": "probe\n" };
    for (const recipe of ALL_FAMILY_RECIPES) {
      const analysis = analyzeRecipe(recipeReference(recipe), probe);
      const gaps = analysis.reasons.filter((reason) =>
        reason.startsWith("recipe_residual_unresolved:"),
      );
      expect(gaps).toEqual([]);
    }
  });
});
