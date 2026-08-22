import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const LEGACY_NAME = /\b(?:warden|transformer)\b/gi;

type SurfaceMode =
  | "typescript-all"
  | "typescript-output"
  | "typescript-properties"
  | "markdown"
  | "python"
  | "workflow-names";

type PublicSurface = Readonly<{
  path: string;
  mode: SurfaceMode;
  properties?: readonly string[];
}>;

export type ProductNameCompatibilityException = Readonly<{
  path: string;
  sourceText: string;
  reason: string;
}>;

export type ProductNameViolation = Readonly<{
  path: string;
  line: number;
  legacyName: string;
  sourceText: string;
}>;

export type ProductNameScanReport = Readonly<{
  violations: readonly ProductNameViolation[];
  unusedExceptions: readonly ProductNameCompatibilityException[];
}>;

export const PRODUCT_NAME_COMPATIBILITY_EXCEPTIONS = Object.freeze([
  {
    path: "apps/web/app/consumer/prs/[id]/evidence.ts",
    sourceText: "### Structured Warden draft package",
    reason: "Historical pull request evidence must remain readable.",
  },
  {
    path: "apps/web/app/nav.tsx",
    sourceText: "/transformer",
    reason: "The existing Regauge workspace URL remains a compatibility route.",
  },
  {
    path: "apps/web/app/docs/catalog.ts",
    sourceText: "npm run eval:warden",
    reason: "eval:warden is the existing Fettler benchmark command.",
  },
  {
    path: "apps/web/app/docs/catalog.ts",
    sourceText: "apps/worker/src/warden-candidate-update.test.ts",
    reason: "The evidence locator is an existing source file path.",
  },
  {
    path: "apps/web/app/docs/catalog.ts",
    sourceText: "Submit a migration objective to POST /transformer/missions.",
    reason: "The existing Regauge mission API remains a compatibility route.",
  },
  {
    path: "apps/web/app/docs/catalog.ts",
    sourceText: "POST /transformer/missions",
    reason: "The existing Regauge mission API remains a compatibility route.",
  },
  {
    path: "apps/web/app/docs/catalog.ts",
    sourceText: "POST /transformer/control-plane/campaigns/:campaignId/review",
    reason: "The existing Regauge review API remains a compatibility route.",
  },
  {
    path: "apps/web/app/docs/catalog.ts",
    sourceText: "GET /transformer/executions/:campaignId",
    reason: "The existing Regauge execution API remains a compatibility route.",
  },
  {
    path: "apps/web/app/docs/catalog.ts",
    sourceText: "npm run eval:transformer:canary",
    reason: "eval:transformer:canary is the existing Regauge benchmark command.",
  },
  {
    path: "apps/web/app/docs/catalog.ts",
    sourceText: "packages/transformer/src/mission-planner.test.ts",
    reason: "The evidence locator is an existing source file path.",
  },
  {
    path: "apps/web/app/docs/catalog.ts",
    sourceText: "packages/transformer/src/pilot-execution.test.ts",
    reason: "The evidence locator is an existing source file path.",
  },
  {
    path: "apps/web/app/docs/catalog.ts",
    sourceText: "apps/worker/src/transformer-multinode-service.test.ts",
    reason: "The evidence locator is an existing source file path.",
  },
  {
    path: "apps/web/app/docs/catalog.ts",
    sourceText: "apps/worker/src/transformer-learning.test.ts",
    reason: "The evidence locator is an existing source file path.",
  },
  {
    path: "apps/web/app/docs/catalog.ts",
    sourceText: "apps/worker/src/warden-model-accounting.test.ts",
    reason: "The evidence locator is an existing source file path.",
  },
  {
    path: "apps/web/app/docs/catalog.ts",
    sourceText: "scripts/customer-warden-profile.test.ts",
    reason: "The evidence locator is an existing source file path.",
  },
  {
    path: "apps/web/app/docs/catalog.ts",
    sourceText: "fly.transformer.toml",
    reason: "The existing Regauge Fly manifest path remains a deployment interface.",
  },
  {
    path: "apps/web/app/docs/catalog.ts",
    sourceText: "apps/worker/src/transformer-production-profile.test.ts",
    reason: "The evidence locator is an existing source file path.",
  },
  {
    path: "scripts/build-investor-onepager-pdf.py",
    sourceText: "        \"Fettler agent: on-demand API debug tool-loop; multi-category failure training; internal warden-bench 5/5.\",",
    reason: "warden-bench is the existing executable benchmark identifier.",
  },
  {
    path: "scripts/build-investor-onepager-pdf.py",
    sourceText: "        \"Open source monorepo (MIT) for diligence—20+ packages; reproducible demo: npm test && npm run demo && npm run eval:warden.\",",
    reason: "eval:warden is the existing npm compatibility command.",
  },
  {
    path: "scripts/build-investor-onepager-pdf.py",
    sourceText: "        \"Clone the repo. Run: npm install && npm test && npm run demo && npm run eval:warden.  \"",
    reason: "eval:warden is the existing npm compatibility command.",
  },
  {
    path: "scripts/platform-dev.ts",
    sourceText: "warden",
    reason: "The planner context selector is an existing machine identifier.",
  },
  {
    path: "apps/worker/src/cli.ts",
    sourceText: "Usage: worker [demo|watch|poll-once|poll|feeds|jobs|process-jobs|run-jobs|run-service|run-transformer-service|sdk-signals|reconcile-installations]\n  poll-once [--local] [--no-pipeline] [--slug acme-payments]\n  poll [--local] [--interval 60000]\n  process-jobs\n  run-jobs [--interval 5000]\n  run-service [--interval 5000]\n  run-transformer-service\n  sdk-signals [--local]\n  reconcile-installations [--tenant tenant_default] [--installation 151614362]",
    reason: "run-transformer-service is the existing CLI compatibility command.",
  },
] satisfies readonly ProductNameCompatibilityException[]);

export const PRODUCT_NAME_PUBLIC_SURFACES = Object.freeze([
  { path: "README.md", mode: "markdown" },
  { path: ".github/workflows/ci.yml", mode: "workflow-names" },
  { path: "scripts/build-investor-onepager-pdf.py", mode: "python" },
  { path: "scripts/ga-check.ts", mode: "typescript-output" },
  { path: "scripts/customer-warden-profile.ts", mode: "typescript-output" },
  { path: "scripts/platform-dev.ts", mode: "typescript-output" },
  { path: "packages/branding/src/packs.ts", mode: "typescript-all" },
  { path: "packages/github/src/checks.ts", mode: "typescript-all" },
  { path: "packages/notify/src/index.ts", mode: "typescript-all" },
  { path: "packages/ops/src/release.ts", mode: "typescript-properties", properties: ["product"] },
  { path: "packages/pipeline/src/warden-pr-package.ts", mode: "typescript-all" },
  { path: "packages/pipeline/src/index.ts", mode: "typescript-properties", properties: ["displayName"] },
  { path: "packages/platform/src/knowledge.ts", mode: "typescript-properties", properties: ["title"] },
  { path: "apps/worker/src/cli.ts", mode: "typescript-output" },
  { path: "apps/worker/src/transformer-adaptive-planner.ts", mode: "typescript-properties", properties: ["content"] },
  { path: "apps/worker/src/transformer-pilot-lane.ts", mode: "typescript-properties", properties: ["goal"] },
  { path: "apps/worker/src/transformer-router.ts", mode: "typescript-properties", properties: ["goal"] },
  { path: "apps/web/app/nav.tsx", mode: "typescript-all" },
  { path: "apps/web/app/docs/catalog.ts", mode: "typescript-all" },
  { path: "apps/web/app/docs/page.tsx", mode: "typescript-all" },
  { path: "apps/web/app/consumer/prs/[id]/evidence.ts", mode: "typescript-all" },
  { path: "scripts/build-public-docs.ts", mode: "typescript-all" },
] satisfies readonly PublicSurface[]);

export type ProductNameCandidate = Readonly<{ sourceText: string; line: number }>;
type Candidate = ProductNameCandidate;
type SurfaceCandidates = Readonly<{ path: string; candidates: readonly Candidate[] }>;

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function stringCandidates(source: string, path: string): Candidate[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const candidates: Candidate[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (!ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) {
        candidates.push({ sourceText: node.text, line: lineOf(sourceFile, node) });
      }
    } else if (ts.isJsxText(node) && node.text.trim()) {
      candidates.push({ sourceText: node.text.trim(), line: lineOf(sourceFile, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return candidates;
}

function outputCandidates(source: string, path: string): Candidate[] {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const candidates: Candidate[] = [];
  const collect = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      candidates.push({ sourceText: node.text, line: lineOf(sourceFile, node) });
    }
    ts.forEachChild(node, collect);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const isConsole = ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "console";
      const isErrorsPush = ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "errors" &&
        expression.name.text === "push";
      if (isConsole || isErrorsPush) node.arguments.forEach(collect);
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Error"
    ) {
      node.arguments?.forEach(collect);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return candidates;
}

function propertyCandidates(source: string, path: string, properties: readonly string[]): Candidate[] {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const candidates: Candidate[] = [];
  const collect = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      candidates.push({ sourceText: node.text, line: lineOf(sourceFile, node) });
    }
    ts.forEachChild(node, collect);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : "";
      if (properties.includes(name)) collect(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return candidates;
}

function markdownCandidates(source: string): Candidate[] {
  const candidates: Candidate[] = [];
  let fenced = false;
  source.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) {
      const comment = line.indexOf("#");
      if (comment >= 0) candidates.push({ sourceText: line.slice(comment + 1), line: index + 1 });
      return;
    }
    const prose = line
      .replace(/`[^`]*`/g, "")
      .replace(/\]\([^)]*\)/g, "]");
    if (prose.trim()) candidates.push({ sourceText: prose, line: index + 1 });
  });
  return candidates;
}

function lineCandidates(source: string, include: (line: string) => boolean = () => true): Candidate[] {
  return source.split(/\r?\n/).flatMap((line, index) =>
    include(line) ? [{ sourceText: line, line: index + 1 }] : []
  );
}

function candidatesFor(surface: PublicSurface, source: string): Candidate[] {
  switch (surface.mode) {
    case "typescript-all":
      return stringCandidates(source, surface.path);
    case "typescript-output":
      return outputCandidates(source, surface.path);
    case "typescript-properties":
      return propertyCandidates(source, surface.path, surface.properties ?? []);
    case "markdown":
      return markdownCandidates(source);
    case "workflow-names":
      return lineCandidates(source, (line) => /^\s*-\s+name:/.test(line));
    case "python":
      return lineCandidates(source);
  }
}

export function findLegacyProductNames(
  path: string,
  candidates: readonly Candidate[],
  exceptions: readonly ProductNameCompatibilityException[] = PRODUCT_NAME_COMPATIBILITY_EXCEPTIONS,
): ProductNameViolation[] {
  const allowed = new Set(
    exceptions.filter((exception) => exception.path === path).map((exception) => exception.sourceText),
  );
  return candidates.flatMap((candidate) => {
    if (allowed.has(candidate.sourceText)) return [];
    return [...candidate.sourceText.matchAll(LEGACY_NAME)].map((match) => ({
      path,
      line: candidate.line,
      legacyName: match[0],
      sourceText: candidate.sourceText,
    }));
  });
}

export function productNameTokenCandidates(source: string): ProductNameCandidate[] {
  return [...source.matchAll(LEGACY_NAME)].map((match) => {
    let start = match.index;
    let end = start + match[0].length;
    while (start > 0 && /[A-Za-z0-9_./:-]/.test(source[start - 1])) start -= 1;
    while (end < source.length && /[A-Za-z0-9_./:-]/.test(source[end])) end += 1;
    return {
      sourceText: source.slice(start, end),
      line: source.slice(0, start).split(/\r?\n/).length,
    };
  });
}

export function findUnusedProductNameExceptions(
  surfaces: readonly SurfaceCandidates[],
  exceptions: readonly ProductNameCompatibilityException[] = PRODUCT_NAME_COMPATIBILITY_EXCEPTIONS,
): ProductNameCompatibilityException[] {
  return exceptions.filter((exception) => {
    const surface = surfaces.find((candidateSurface) => candidateSurface.path === exception.path);
    return !surface?.candidates.some((candidate) => candidate.sourceText === exception.sourceText);
  });
}

export function scanProductNamesReport(
  root = resolve(import.meta.dirname, ".."),
): ProductNameScanReport {
  const surfaces = PRODUCT_NAME_PUBLIC_SURFACES.map((surface) => {
    const source = readFileSync(resolve(root, surface.path), "utf8");
    return { path: surface.path, candidates: candidatesFor(surface, source) };
  });
  return {
    violations: surfaces.flatMap(({ path, candidates }) => findLegacyProductNames(path, candidates)),
    unusedExceptions: findUnusedProductNameExceptions(surfaces),
  };
}

export function scanProductNames(
  root = resolve(import.meta.dirname, ".."),
): ProductNameViolation[] {
  return [...scanProductNamesReport(root).violations];
}

function main(): void {
  const { violations, unusedExceptions } = scanProductNamesReport();
  if (violations.length || unusedExceptions.length) {
    for (const violation of violations) {
      console.error(
        `${violation.path}:${violation.line} legacy product name ${JSON.stringify(violation.legacyName)} in ${JSON.stringify(violation.sourceText)}`,
      );
    }
    for (const exception of unusedExceptions) {
      console.error(
        `${exception.path} unused product-name compatibility exception ${JSON.stringify(exception.sourceText)}: ${exception.reason}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `Product names check passed: ${PRODUCT_NAME_PUBLIC_SURFACES.length} surfaces, ${PRODUCT_NAME_COMPATIBILITY_EXCEPTIONS.length} documented compatibility exceptions.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
