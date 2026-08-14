/**
 * Dogfood proof for the declaring-module rename (Gap 1).
 *
 * Renames this repository's own internal API `isHumanWardenReviewer` to
 * `isHumanFettlerReviewer` through the genuine recipe execution path
 * (analyzeRecipe -> applyRecipe), writes the transformed files, typechecks the
 * apps/api workspace against the renamed sources, then inverse-restores every
 * file byte-identical so the repository is left unchanged.
 *
 * This is the concrete real-repo case that measured 0 usable renames before the
 * declaration rewrite landed: the old engine rewrote the three consumers and
 * left the producer exporting the old name (TS2305). Run:
 *   npx tsx scripts/rename-dogfood-proof.ts
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
const recipe = getRecipe("internal-api-warden-ishuman-reviewer-rename", 1);
const reference = recipeReference(recipe);
const paths = [...recipe.allowedPaths];

function absolute(path: string): string {
  return fileURLToPath(new URL(`../${path}`, import.meta.url));
}

function readAll(): RecipeFiles {
  const files: Record<string, string> = {};
  for (const path of paths) files[path] = readFileSync(absolute(path), "utf8");
  return files;
}

function writeAll(files: RecipeFiles): void {
  for (const path of paths) writeFileSync(absolute(path), files[path]!, "utf8");
}

const originals = readAll();
let restored = false;
const restore = (): void => {
  if (restored) return;
  writeAll(originals);
  restored = true;
};
process.on("exit", restore);

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

  let typecheckOk = false;
  try {
    execFileSync("npm", ["run", "typecheck", "-w", "@mendpoint/api"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    typecheckOk = true;
  } catch {
    typecheckOk = false;
  }
  console.log(`typecheck-after-apply: ${typecheckOk ? "PASS (exit 0)" : "FAIL"}`);

  const inverse = applyInverseOperations(reference, application.files, application.operations);
  writeAll(inverse);
  restored = true;
  const restoredDigest = recipeFilesDigest(readAll());
  const byteIdentical = restoredDigest === application.inputDigest;
  console.log(`inverse-restore byte-identical: ${byteIdentical}`);

  if (!typecheckOk || !byteIdentical) process.exitCode = 1;
} finally {
  restore();
}
