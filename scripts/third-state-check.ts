/**
 * Third-state static check — npm run third-state:check
 *
 * Guards against the one defect this repository keeps writing (tasks/lessons.md,
 * docs/reviews/2026-08-19-claude-review-response.md):
 *
 *   A two-valued type is asked to carry three states — true / false /
 *   not-determined — and the third collapses into the reassuring one, so the
 *   system reports a success it has not earned and nothing downstream can
 *   contradict it.
 *
 * Three narrow, high-signal AST shapes are covered. Each is tuned to a
 * near-zero false-positive rate on the current tree rather than to catch every
 * instance — a check that cries wolf is muted and then deleted. Shapes that
 * need type-flow to separate a defect from a legitimate default are left
 * uncovered on purpose; see the PR body.
 *
 * A genuine exception is declared inline and greppable:
 *   // third-state-check-allow: <reason>
 * on the offending line or the line directly above it. List every deliberate
 * exemption with:  grep -rn "third-state-check-allow:" .
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

export type ThirdStateShape =
  | "external-fallback"
  | "metric-zero-denominator"
  | "attestation-literal";

export type ThirdStateViolation = Readonly<{
  path: string;
  line: number;
  shape: ThirdStateShape;
  detail: string;
  sourceText: string;
}>;

/** Inline escape hatch. Must be followed by a non-empty reason. */
export const THIRD_STATE_ALLOW_DIRECTIVE = "third-state-check-allow";

/** Bounded [0,1] metrics whose perfect score is literally 1. */
export const METRIC_FUNCTION_NAME =
  /(?:precision|recall|rate|ratio|accuracy|coverage|fscore|f1|sensitivity|specificity)/i;

/** Field names that read as an observed outcome rather than a policy constant. */
export const OUTCOME_FIELD_NAMES: ReadonlySet<string> = new Set([
  "passed",
  "blocked",
  "verified",
  "ok",
  "valid",
  "observed",
  "allowed",
  "denied",
  "succeeded",
  "contained",
  "reachable",
  "present",
  "matched",
  "safe",
  "secure",
  "clean",
  "healthy",
]);

/** A fallback string shaped like a status/verdict enum member, e.g. "EXTRACTED". */
const SCREAMING_ENUM = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/** Field names whose absent value must not silently read as exit code 0 (success). */
const EXIT_CODE_FIELD =
  /^(?:exit|exitcode|exit_code|code|returncode|return_code|status|statuscode|status_code|signal)$/i;

const SUBPROCESS_CALLEES: ReadonlySet<string> = new Set([
  "spawnSync",
  "execSync",
  "execFileSync",
  "exec",
  "spawn",
  "execFile",
]);

const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
]);

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function snippet(sourceFile: ts.SourceFile, node: ts.Node): string {
  return node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 100);
}

function parseSource(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression as ts.Expression;
  }
  return current;
}

/** Names an external data source when `expression` is a call to one, else null. */
function externalCallTag(expression: ts.Expression | undefined): string | null {
  if (!expression) return null;
  const call = unwrap(expression);
  if (!ts.isCallExpression(call)) return null;
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.name.text === "parse" && ts.isIdentifier(callee.expression) && callee.expression.text === "JSON") {
      return "JSON.parse";
    }
    if (callee.name.text === "json") return ".json()";
    if (SUBPROCESS_CALLEES.has(callee.name.text)) return callee.name.text;
  }
  if (ts.isIdentifier(callee) && SUBPROCESS_CALLEES.has(callee.text)) return callee.text;
  return null;
}

/** Identifiers bound in this file to an external call: `const r = JSON.parse(x)`. */
function collectExternalBindings(sourceFile: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const tag = externalCallTag(node.initializer);
      if (tag) bindings.set(node.name.text, tag);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

/** The external source feeding a member-access chain, or null if not external. */
function externalRoot(expression: ts.Expression, bindings: Map<string, string>): string | null {
  let current = unwrap(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrap(current.expression);
  }
  const tag = externalCallTag(current);
  if (tag) return tag;
  if (ts.isIdentifier(current) && bindings.has(current.text)) return bindings.get(current.text)!;
  return null;
}

/** The last property name in a member-access chain, e.g. `a.b.status` -> "status". */
function terminalFieldName(expression: ts.Expression): string {
  let current = expression;
  while (ts.isNonNullExpression(current)) current = current.expression;
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (ts.isElementAccessExpression(current) && ts.isStringLiteral(current.argumentExpression)) {
    return current.argumentExpression.text;
  }
  return "";
}

/**
 * Shape 1 — an absent external value defaulted to a positive claim.
 * `?? "EXTRACTED"` / `exit_code ?? 0`: the left side comes from parsed JSON, an
 * HTTP body, or a subprocess result, and the fallback is a status enum or an
 * exit code silently read as success.
 */
export function findExternalFallbacks(source: string, path: string): ThirdStateViolation[] {
  return collectExternalFallbacks(parseSource(path, source));
}

function collectExternalFallbacks(sourceFile: ts.SourceFile): ThirdStateViolation[] {
  const path = sourceFile.fileName;
  const bindings = collectExternalBindings(sourceFile);
  const violations: ThirdStateViolation[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      const rhs = node.right;
      const enumFallback =
        ts.isStringLiteral(rhs) && rhs.text.length >= 3 && SCREAMING_ENUM.test(rhs.text);
      const exitCodeFallback =
        ts.isNumericLiteral(rhs) && rhs.text === "0" && EXIT_CODE_FIELD.test(terminalFieldName(node.left));
      if (enumFallback || exitCodeFallback) {
        const root = externalRoot(node.left, bindings);
        if (root) {
          violations.push({
            path,
            line: lineOf(sourceFile, node),
            shape: "external-fallback",
            detail: enumFallback
              ? `absent value from ${root} defaults to status enum ${JSON.stringify((rhs as ts.StringLiteral).text)}`
              : `absent ${terminalFieldName(node.left)} from ${root} reads as exit code 0 (success)`,
            sourceText: snippet(sourceFile, node),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

function enclosingFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
      return current.name && ts.isIdentifier(current.name) ? current.name.text : "";
    }
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      const parent = current.parent;
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    }
    current = current.parent;
  }
  return "";
}

/** True for a guard that fires when a denominator is empty: `d === 0`, `!x`, `x.length === 0`. */
function isZeroDenominatorTest(condition: ts.Expression): boolean {
  const node = ts.isParenthesizedExpression(condition) ? condition.expression : condition;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    const comparisons = [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.LessThanEqualsToken,
      ts.SyntaxKind.LessThanToken,
    ];
    if (comparisons.includes(op) && ts.isNumericLiteral(node.right) && (node.right.text === "0" || node.right.text === "1")) {
      return true;
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      return isZeroDenominatorTest(node.left) || isZeroDenominatorTest(node.right);
    }
  }
  return false;
}

function isPerfectScore(expression: ts.Expression): boolean {
  return ts.isNumericLiteral(expression) && (expression.text === "1" || expression.text === "1.0");
}

/**
 * Shape 2 — a metric that scores absence as perfection.
 * `d === 0 ? 1 : n / d` inside a `precision`/`recall`/... function converts
 * "we measured nothing" into "we measured perfection", so a qualification gate
 * passes on an extractor that produced nothing. Returning 0 on an empty
 * denominator is deliberately not flagged: it does not manufacture success.
 */
export function findMetricZeroDenominator(source: string, path: string): ThirdStateViolation[] {
  return collectMetricZeroDenominator(parseSource(path, source));
}

function collectMetricZeroDenominator(sourceFile: ts.SourceFile): ThirdStateViolation[] {
  const path = sourceFile.fileName;
  const violations: ThirdStateViolation[] = [];
  const record = (node: ts.Node): void => {
    const fnName = enclosingFunctionName(node);
    if (!METRIC_FUNCTION_NAME.test(fnName)) return;
    violations.push({
      path,
      line: lineOf(sourceFile, node),
      shape: "metric-zero-denominator",
      detail: `metric ${fnName} scores an empty denominator as a perfect 1`,
      sourceText: snippet(sourceFile, node),
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isConditionalExpression(node) && isZeroDenominatorTest(node.condition)) {
      if (isPerfectScore(node.whenTrue) || isPerfectScore(node.whenFalse)) record(node);
    }
    if (ts.isIfStatement(node) && isZeroDenominatorTest(node.expression)) {
      const then = node.thenStatement;
      const returned = ts.isReturnStatement(then)
        ? then
        : ts.isBlock(then) && then.statements.length === 1 && ts.isReturnStatement(then.statements[0])
          ? (then.statements[0] as ts.ReturnStatement)
          : undefined;
      if (returned?.expression && isPerfectScore(returned.expression)) record(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

/**
 * Shape 3 — an attestation record that cannot represent a negative.
 * `{ blocked: true; passed: true }` typed with literal booleans makes a failed
 * receipt unrepresentable. Requiring two or more monovalued outcome fields
 * targets that bundle-of-positives smell while leaving single-field
 * discriminated unions (`{ ok: true } | { ok: false }`) alone.
 */
export function findAttestationLiterals(source: string, path: string): ThirdStateViolation[] {
  return collectAttestationLiterals(parseSource(path, source));
}

function collectAttestationLiterals(sourceFile: ts.SourceFile): ThirdStateViolation[] {
  const path = sourceFile.fileName;
  const compact = sourceFile.text.replace(/\s+/g, "");
  const oppositePresent = (name: string, value: boolean): boolean => {
    const opposite = value ? "false" : "true";
    return compact.includes(`${name}:${opposite}`) || compact.includes(`${name}?:${opposite}`);
  };
  const violations: ThirdStateViolation[] = [];
  const inspect = (members: ts.NodeArray<ts.TypeElement>, node: ts.Node): void => {
    const hits: string[] = [];
    for (const member of members) {
      if (!ts.isPropertySignature(member) || !member.type || !ts.isLiteralTypeNode(member.type)) continue;
      const literal = member.type.literal;
      const isTrue = literal.kind === ts.SyntaxKind.TrueKeyword;
      const isFalse = literal.kind === ts.SyntaxKind.FalseKeyword;
      if (!isTrue && !isFalse) continue;
      if (!member.name || !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) continue;
      const name = member.name.text;
      if (OUTCOME_FIELD_NAMES.has(name) && !oppositePresent(name, isTrue)) hits.push(`${name}: ${isTrue}`);
    }
    if (hits.length >= 2) {
      violations.push({
        path,
        line: lineOf(sourceFile, node),
        shape: "attestation-literal",
        detail: `record asserts ${hits.length} outcome fields as unconditional literals: { ${hits.join("; ")} }`,
        sourceText: snippet(sourceFile, node),
      });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTypeLiteralNode(node)) inspect(node.members, node);
    else if (ts.isInterfaceDeclaration(node)) inspect(node.members, node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

/** True when line `line` (1-based) carries an inline exemption with a reason. */
function suppressed(lines: readonly string[], line: number): boolean {
  const hasDirective = (text: string | undefined): boolean => {
    if (!text) return false;
    const index = text.indexOf(`${THIRD_STATE_ALLOW_DIRECTIVE}:`);
    if (index < 0) return false;
    return text.slice(index + THIRD_STATE_ALLOW_DIRECTIVE.length + 1).trim().length > 0;
  };
  return hasDirective(lines[line - 1]) || hasDirective(lines[line - 2]);
}

/** Run every shape on one source, minus inline exemptions. */
export function scanSource(path: string, source: string): ThirdStateViolation[] {
  const sourceFile = parseSource(path, source);
  const raw = [
    ...collectExternalFallbacks(sourceFile),
    ...collectMetricZeroDenominator(sourceFile),
    ...collectAttestationLiterals(sourceFile),
  ];
  const lines = source.split(/\r?\n/);
  return raw.filter((violation) => !suppressed(lines, violation.line));
}

function walk(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.(?:ts|tsx|mts|cts)$/.test(entry)) files.push(full);
  }
}

export function scanThirdState(root = resolve(import.meta.dirname, "..")): ThirdStateViolation[] {
  const files: string[] = [];
  walk(root, files);
  return files.flatMap((file) => {
    const relative = file.slice(root.length + 1).split("\\").join("/");
    return scanSource(relative, readFileSync(file, "utf8"));
  });
}

function main(): void {
  const violations = scanThirdState();
  if (violations.length) {
    for (const violation of violations) {
      console.error(`${violation.path}:${violation.line} [${violation.shape}] ${violation.detail}`);
      console.error(`    ${violation.sourceText}`);
    }
    console.error(
      `\nThird-state check FAIL: ${violations.length} site(s). ` +
        `A value that can be absent must not share a representation with the reassuring outcome. ` +
        `If an instance is genuinely safe, annotate it inline with "${THIRD_STATE_ALLOW_DIRECTIVE}: <reason>".`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    "Third-state check passed: no external-fallback, metric-zero-denominator, or attestation-literal defects.",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
