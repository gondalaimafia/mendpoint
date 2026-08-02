import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  validatePublicClaimRegistry,
  type PublicClaimRegistry,
  type ProductRequirementManifest,
} from "@mendpoint/contract";

function repositoryPath(repoRoot: string, locator: string) {
  const path = locator.split("#", 1)[0];
  const resolved = resolve(repoRoot, path);
  const relativePath = relative(repoRoot, resolved);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`claim evidence escapes repository: ${locator}`);
  }
  return resolved;
}

const repoRoot = resolve(process.cwd());
const registryPath = resolve(repoRoot, "docs", "PUBLIC_CLAIMS.json");
const requirementsPath = resolve(repoRoot, "docs", "PRODUCT_REQUIREMENTS.json");
if (!existsSync(registryPath)) throw new Error("docs/PUBLIC_CLAIMS.json is missing");
if (!existsSync(requirementsPath)) throw new Error("docs/PRODUCT_REQUIREMENTS.json is missing");

const registry = JSON.parse(readFileSync(registryPath, "utf8")) as PublicClaimRegistry;
const requirements = JSON.parse(
  readFileSync(requirementsPath, "utf8"),
) as ProductRequirementManifest;
const issues = validatePublicClaimRegistry(registry, {
  requirements: requirements.requirements ?? [],
  asOf: new Date(),
});
for (const claim of registry.claims ?? []) {
  let boundSurface = false;
  for (const surfacePath of claim.surfacePaths ?? []) {
    const resolvedSurface = repositoryPath(repoRoot, surfacePath);
    if (!existsSync(resolvedSurface)) {
      issues.push({
        code: "SURFACE_PATH_MISSING",
        subject: claim.id,
        message: `${surfacePath} does not exist`,
      });
    } else if (readFileSync(resolvedSurface, "utf8").includes(claim.id)) {
      boundSurface = true;
    }
  }
  if (!boundSurface) {
    issues.push({
      code: "CLAIM_SURFACE_BINDING_MISSING",
      subject: claim.id,
      message: "at least one mapped surface must bind the claim by ID",
    });
  }
  for (const evidence of claim.evidence ?? []) {
    if (["live", "external"].includes(evidence.type)) continue;
    if (!existsSync(repositoryPath(repoRoot, evidence.locator))) {
      issues.push({
        code: "EVIDENCE_MISSING",
        subject: evidence.id,
        message: `${evidence.locator} does not exist`,
      });
    }
  }
}

if (issues.length > 0) {
  for (const issue of issues.sort((left, right) => left.code.localeCompare(right.code))) {
    console.error(`${issue.code} ${issue.subject}: ${issue.message}`);
  }
  throw new Error(`public claim registry has ${issues.length} issue${issues.length === 1 ? "" : "s"}`);
}

console.log(`PUBLIC CLAIMS PASS: ${registry.claims.length} claims, ${registry.destinations.length} destinations`);
