import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  canonicalTextSha256,
  FOUNDATIONAL_REGISTER_SET,
  PRODUCT_REGISTER_SETS,
  validateProductRequirements,
  type ProductRegisterSet,
  type ProductRequirement,
  type ProductRequirementManifest,
} from "@mendpoint/contract";

function fail(message: string): never {
  console.error(`PRODUCT CONTRACT FAIL: ${message}`);
  process.exit(1);
}

function repositoryPath(repoRoot: string, path: string) {
  const resolved = resolve(repoRoot, path);
  const relativePath = relative(resolve(repoRoot), resolved);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    fail(`path escapes repository: ${path}`);
  }
  return resolved;
}

function main() {
  const repoRoot = resolve(process.cwd());
  const manifestPath = resolve(repoRoot, "docs", "PRODUCT_REQUIREMENTS.json");
  if (!existsSync(manifestPath)) fail("docs/PRODUCT_REQUIREMENTS.json is missing");

  let manifest: ProductRequirementManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ProductRequirementManifest;
  } catch (error) {
    fail(`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const issues = validateProductRequirements(manifest);
  const specPath = repositoryPath(repoRoot, manifest.spec.path);
  if (!existsSync(specPath)) {
    issues.push({ code: "SPEC_MISSING", subject: manifest.spec.path, message: "canonical spec does not exist" });
  } else {
    const digest = canonicalTextSha256(readFileSync(specPath, "utf8"));
    if (digest !== manifest.spec.sha256) {
      issues.push({
        code: "SPEC_HASH_MISMATCH",
        subject: manifest.spec.path,
        message: `recorded ${manifest.spec.sha256}, actual ${digest}`,
      });
    }
  }

  const additionalSets: ProductRegisterSet[] = manifest.additionalRegisterSets ?? [];
  const allRequirements: ProductRequirement[] = [
    ...manifest.requirements,
    ...additionalSets.flatMap((set) => set.requirements),
  ];
  for (const requirement of allRequirements) {
    for (const criterion of requirement.acceptance) {
      for (const evidence of criterion.evidence) {
        if (["planned", "external", "live"].includes(evidence.type)) continue;
        const locatorPath = evidence.locator.split("#", 1)[0];
        if (!existsSync(repositoryPath(repoRoot, locatorPath))) {
          issues.push({
            code: "EVIDENCE_MISSING",
            subject: evidence.id,
            message: `${locatorPath} does not exist`,
          });
        }
      }
    }
  }

  issues.sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      left.subject.localeCompare(right.subject) ||
      left.message.localeCompare(right.message),
  );
  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`${issue.code} ${issue.subject}: ${issue.message}`);
    }
    fail(`${issues.length} issue${issues.length === 1 ? "" : "s"}`);
  }

  const registerTitle = (key: string) =>
    PRODUCT_REGISTER_SETS.find((set) => set.key === key)?.title ?? key;

  const reportSet = (
    key: string,
    source: string,
    auditedRevision: string,
    requirements: ProductRequirement[],
  ) => {
    console.log(
      `  ${key} (${registerTitle(key)}): ${requirements.length} requirements`,
    );
    console.log(`    provenance: ${source} @ ${auditedRevision}`);
    const statusCounts = new Map<string, number>();
    for (const requirement of requirements) {
      statusCounts.set(
        requirement.implementationStatus,
        (statusCounts.get(requirement.implementationStatus) ?? 0) + 1,
      );
    }
    for (const [status, count] of [...statusCounts.entries()].sort()) {
      console.log(`    ${status}: ${count}`);
    }
  };

  console.log(
    `PRODUCT CONTRACT PASS: ${allRequirements.length} requirements across ${
      additionalSets.length + 1
    } register sets, spec ${manifest.spec.version}`,
  );
  reportSet(
    FOUNDATIONAL_REGISTER_SET.key,
    manifest.closurePlan.source,
    manifest.closurePlan.auditedRevision,
    manifest.requirements,
  );
  for (const set of additionalSets) {
    reportSet(set.key, set.closurePlan.source, set.closurePlan.auditedRevision, set.requirements);
  }
}

main();
