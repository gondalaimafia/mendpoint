import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AWS_SDK_JS_V2_TO_V3_RECIPE,
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

const FIXTURE_ROOT = "../../../fixtures/consumers/aws-sdk-v2-to-v3/";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(FIXTURE_ROOT + relative, import.meta.url)), "utf8");
}

function load(sub: string, paths: readonly string[]): RecipeFiles {
  const files: Record<string, string> = {};
  for (const path of paths) files[path] = read(`${sub}/${path}`);
  return files;
}

const SUPPORTED_PATHS = ["package.json", "src/s3.js", "src/dynamo.js"] as const;
const reference = recipeReference(AWS_SDK_JS_V2_TO_V3_RECIPE);

describe("aws-sdk-js-v2-to-v3 recipe", () => {
  it("is a valid, registered, content-addressed recipe", () => {
    expect(() => validateRecipe(AWS_SDK_JS_V2_TO_V3_RECIPE)).not.toThrow();
    expect(getRecipe("aws-sdk-js-v2-to-v3", 1)).toBe(AWS_SDK_JS_V2_TO_V3_RECIPE);
    expect(resolveRecipe(reference)).toBe(AWS_SDK_JS_V2_TO_V3_RECIPE);
    expect(AWS_SDK_JS_V2_TO_V3_RECIPE.allowedPaths).toEqual([
      "package.json",
      "src/dynamo.js",
      "src/s3.js",
    ]);
    expect(Object.isFrozen(AWS_SDK_JS_V2_TO_V3_RECIPE)).toBe(true);
    for (const command of AWS_SDK_JS_V2_TO_V3_RECIPE.verificationCommands) {
      expect(command.command).toMatch(/^node -e "[^"]+"$/);
    }
  });

  it("applies deterministically to the supported before fixture", () => {
    const before = load("before", SUPPORTED_PATHS);
    const after = load("after", SUPPORTED_PATHS);

    const analysis = analyzeRecipe(reference, before);
    expect(analysis.status).toBe("applicable");
    expect([...analysis.matchedPaths]).toEqual(["package.json", "src/dynamo.js", "src/s3.js"]);
    expect(analysis.reasons).toEqual([]);
    expect(analysis.estimatedOperations).toBe(3);

    const first = applyRecipe(reference, before);
    const second = applyRecipe(reference, { ...before });
    expect(first.files).toEqual(second.files);
    expect(first.operations.map((operation) => operation.path)).toEqual([
      "package.json",
      "src/dynamo.js",
      "src/s3.js",
    ]);
    expect(analysis.estimatedOperations).toBe(first.operations.length);

    // The on-disk after/ fixture is the exact deterministic output.
    expect(first.files["src/s3.js"]).toBe(after["src/s3.js"]);
    expect(first.files["src/dynamo.js"]).toBe(after["src/dynamo.js"]);
    expect(first.files["package.json"]).toBe(after["package.json"]);

    // Shape checks: no v2 surface, v3 imports present.
    expect(first.files["src/s3.js"]).toContain('from "@aws-sdk/client-s3"');
    expect(first.files["src/s3.js"]).toContain("new S3Client({ region: \"us-east-1\" })");
    expect(first.files["src/s3.js"]).toContain("s3.send(new GetObjectCommand({ Bucket, Key }))");
    expect(first.files["src/dynamo.js"]).toContain(
      "DynamoDBDocumentClient.from(new DynamoDBClient({ region: \"us-east-1\" }))",
    );
    for (const path of ["src/s3.js", "src/dynamo.js"] as const) {
      expect(first.files[path]).not.toMatch(/\bnew AWS\./);
      expect(first.files[path]).not.toMatch(/\.promise\(\)/);
      expect(first.files[path]).not.toMatch(/["']aws-sdk["']/);
    }
    expect(JSON.parse(first.files["package.json"]!).dependencies["aws-sdk"]).toBeUndefined();
    expect(JSON.parse(first.files["package.json"]!).dependencies["@aws-sdk/client-s3"]).toBe(
      "^3.658.0",
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

  it("abstains on unsupported service usage", () => {
    const files = load("out-of-scope", ["package.json", "src/s3.js"]);
    const analysis = analyzeRecipe(reference, files);
    expect(analysis.status).toBe("unsupported");
    expect(analysis.matchedPaths).toEqual([]);
    expect(analysis.reasons).toContain("recipe_aws_unsupported_service:SQS");
    expect(() => applyRecipe(reference, files)).toThrow("recipe_aws_unsupported_service:SQS");
  });

  it("abstains on callback-style and unsupported operations", () => {
    const base = read("before/src/s3.js");
    const callbackStyle = base.replace(
      "const data = await s3.getObject({ Bucket, Key }).promise();\n  return data.Body.toString();",
      "s3.getObject({ Bucket, Key }, (error, data) => data);\n  return Key;",
    );
    const callbackAnalysis = analyzeRecipe(reference, {
      "package.json": read("before/package.json"),
      "src/s3.js": callbackStyle,
    });
    expect(callbackAnalysis.status).toBe("unsupported");
    expect(callbackAnalysis.reasons.some((reason) => reason.startsWith("recipe_aws_"))).toBe(true);

    const unsupportedOp = base.replace("listObjectsV2", "selectObjectContent");
    const opAnalysis = analyzeRecipe(reference, {
      "package.json": read("before/package.json"),
      "src/s3.js": unsupportedOp,
    });
    expect(opAnalysis.status).toBe("unsupported");
  });

  it("leaves non-aws source untouched (neutral)", () => {
    const files: RecipeFiles = {
      "package.json": read("before/package.json"),
      "src/s3.js": read("before/src/s3.js"),
      "src/dynamo.js": "export const noop = () => 42;\n",
    };
    const output = applyRecipe(reference, files);
    expect(output.files["src/dynamo.js"]).toBe(files["src/dynamo.js"]);
    expect(output.operations.map((operation) => operation.path)).toEqual([
      "package.json",
      "src/s3.js",
    ]);
  });
});
