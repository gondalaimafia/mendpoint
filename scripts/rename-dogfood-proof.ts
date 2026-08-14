/**
 * Dogfood proof for the internal-API rename engine on this repository's own code.
 *
 * Each case renames a real in-repo binding through the genuine recipe execution
 * path (analyzeRecipe -> applyRecipe), writes the transformed files, typechecks
 * the apps/api workspace against the renamed sources, then inverse-restores every
 * file byte-identical so the repository is left unchanged.
 *
 * Case 1 (Gap 1, declaration rename) renames the function `isHumanWardenReviewer`
 * to `isHumanFettlerReviewer` across its producer and three consumers. This is the
 * concrete real-repo case that measured 0 usable renames before the declaration
 * rewrite landed (the old engine left the producer exporting the old name, TS2305).
 *
 * Case 2 (Gap 4, type rename) renames the exported type `HumanReviewDecision` to
 * `HumanReviewVerdict` across its producer (`apps/api/src/reviews.ts`) and its
 * consumer (`apps/api/src/review-routes.ts`), exercising a type declaration, an
 * inline `type` import specifier, and type-position `as` references. This is a
 * class of rename that was entirely out of reach before Gap 4.
 *
 * Run: npx tsx scripts/rename-dogfood-proof.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  analyzeRecipe,
  applyInverseOperations,
  applyRecipe,
  getRecipe,
  recipeFilesDigest,
  recipeReference,
  type RecipeFiles,
} from "@mendpoint/transformer";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function absolute(path: string): string {
  return fileURLToPath(new URL(`../${path}`, import.meta.url));
}

function typecheckApi(): boolean {
  try {
    execFileSync("npm", ["run", "typecheck", "-w", "@mendpoint/api"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    return true;
  } catch {
    return false;
  }
}

type ProofCase = Readonly<{ label: string; recipeId: string }>;

const CASES: readonly ProofCase[] = [
  { label: "Case 1 (Gap 1, declaration rename)", recipeId: "internal-api-warden-ishuman-reviewer-rename" },
  { label: "Case 2 (Gap 4, type rename)", recipeId: "internal-api-review-decision-type-rename" },
];

function runCase(proof: ProofCase): boolean {
  const recipe = getRecipe(proof.recipeId, 1);
  const reference = recipeReference(recipe);
  const paths = [...recipe.allowedPaths];

  const readAll = (): RecipeFiles => {
    const files: Record<string, string> = {};
    for (const path of paths) files[path] = readFileSync(absolute(path), "utf8");
    return files;
  };
  const writeAll = (files: RecipeFiles): void => {
    for (const path of paths) writeFileSync(absolute(path), files[path]!, "utf8");
  };

  const originals = readAll();
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    writeAll(originals);
    restored = true;
  };

  console.log(`\n=== ${proof.label} ===`);
  try {
    const analysis = analyzeRecipe(reference, originals);
    console.log(`recipe: ${recipe.id}@${recipe.version}`);
    console.log(`analysis.status: ${analysis.status}`);
    console.log(`analysis.matchedPaths: ${[...analysis.matchedPaths].join(", ")}`);
    if (analysis.status !== "applicable") {
      throw new Error(`expected applicable, got ${analysis.status}: ${analysis.reasons.join(", ")}`);
    }

    const application = applyRecipe(reference, originals);
    writeAll(application.files);
    console.log(`operations: ${application.operations.map((operation) => operation.path).join(", ")}`);
    console.log("apply: wrote transformed sources, running apps/api typecheck...");

    const typecheckOk = typecheckApi();
    console.log(`typecheck-after-apply: ${typecheckOk ? "PASS (exit 0)" : "FAIL"}`);

    const inverse = applyInverseOperations(reference, application.files, application.operations);
    writeAll(inverse);
    restored = true;
    const restoredDigest = recipeFilesDigest(readAll());
    const byteIdentical = restoredDigest === application.inputDigest;
    console.log(`inverse-restore byte-identical: ${byteIdentical}`);
    return typecheckOk && byteIdentical;
  } finally {
    restore();
  }
}

let ok = true;
for (const proof of CASES) {
  try {
    ok = runCase(proof) && ok;
  } catch (error) {
    ok = false;
    console.error(`${proof.label} FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (!ok) process.exitCode = 1;
