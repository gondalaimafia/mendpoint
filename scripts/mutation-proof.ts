/**
 * Mutation proof — npm run verified:mutation-check (and on-demand modes).
 *
 * Makes the word `verified` in docs/PRODUCT_REQUIREMENTS.json mean something a
 * machine can check: for a requirement's test-type evidence, mutating or
 * removing the implementation the test imports must make that test FAIL. A
 * control whose test survives every mutation is not a control — it is
 * decoration, and this reports it as a failure of the CLAIM, not of the tooling.
 *
 * The property, stated operationally (the thing every agent proved by hand):
 *   delete the control -> a specific cited test dies -> restore it.
 *
 * Three outcomes, and the third never folds into the first:
 *   - killed        at least one crude mutation of the implementation made the
 *                   cited test fail. The citation is load-bearing.
 *   - survived      the implementation was neutered (guards deleted, conditions
 *                   inverted, throws stripped, returns voided) and the cited
 *                   test still passed. The citation does not exercise it.
 *   - undetermined  the implementation could not be located, could not be
 *                   mutated, or the test was already red — reported explicitly,
 *                   NEVER silently passed. Folding this into "fine" would
 *                   reproduce the exact defect this exists to catch.
 *
 * Cost control (why this is affordable): the default mode gates the DIFF only.
 * When a pull request moves a requirement to `verified` or changes its evidence,
 * the property is proved for THAT requirement, not the whole 84-entry register.
 * Every citation stops at the first killing mutant, so a genuine control costs a
 * mutant or two. On-demand modes (--requirement, --all-verified) let the 41
 * existing `verified` entries be audited deliberately over time.
 *
 * Mutation is crude on purpose (the brief: crude and predictable beats clever;
 * do not add a mutation-testing dependency). Four operators, applied by string
 * splice over TypeScript AST offsets so every other byte is preserved exactly:
 *   - delete-if-guard   remove an entire `if` statement (delete the control)
 *   - invert-if         negate an `if` condition
 *   - strip-throw       remove a `throw` statement
 *   - void-return       replace a returned expression with `undefined`
 *
 * The file on disk is restored byte-for-byte after every mutant (original bytes
 * held in memory, written back in a finally), and the working tree is asserted
 * clean before the process exits — an agent today collapsed template-literal
 * whitespace during revert-testing and had to reconstruct seven lines.
 *
 * Usage:
 *   tsx scripts/mutation-proof.ts                      diff-gated vs origin/main
 *   tsx scripts/mutation-proof.ts --base <ref>         diff-gated vs <ref>
 *   tsx scripts/mutation-proof.ts --requirement ME-... one or comma-separated ids
 *   tsx scripts/mutation-proof.ts --all-verified       audit every `verified` entry
 *   tsx scripts/mutation-proof.ts --all-verified --limit N --seed S   sampled audit
 *   tsx scripts/mutation-proof.ts --control <test.ts>::<impl.ts>      raw control
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Register model
// ---------------------------------------------------------------------------

/** Evidence types that name a test file we can mutate against. */
export const TEST_EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  "unit",
  "integration",
  "benchmark",
  "security",
  "e2e",
]);

export type Evidence = Readonly<{ id?: string; type: string; locator: string }>;
export type Acceptance = Readonly<{ id?: string; evidence: readonly Evidence[] }>;
export type Requirement = Readonly<{
  id: string;
  implementationStatus: string;
  acceptance: readonly Acceptance[];
}>;

export function readRegister(json: string): Requirement[] {
  const parsed = JSON.parse(json) as { requirements?: Requirement[] };
  return parsed.requirements ?? [];
}

/** The test-file locators a requirement cites as its verification evidence. */
export function testCitations(requirement: Requirement): Evidence[] {
  const out: Evidence[] = [];
  for (const acceptance of requirement.acceptance ?? []) {
    for (const evidence of acceptance.evidence ?? []) {
      if (TEST_EVIDENCE_TYPES.has(evidence.type)) out.push(evidence);
    }
  }
  return out;
}

/**
 * Requirement ids the diff-gated mode must prove: those that moved TO `verified`
 * (new, or a status change into verified) or whose evidence changed while
 * `verified`. A requirement left untouched by the diff is not re-proved — that
 * is what keeps the check cheap and what stops the register getting worse.
 */
export function diffRequirements(baseJson: string | null, headJson: string): string[] {
  const head = readRegister(headJson);
  const base = baseJson ? readRegister(baseJson) : [];
  const baseById = new Map(base.map((requirement) => [requirement.id, requirement]));
  const ids: string[] = [];
  for (const requirement of head) {
    if (requirement.implementationStatus !== "verified") continue;
    const previous = baseById.get(requirement.id);
    const becameVerified = !previous || previous.implementationStatus !== "verified";
    const evidenceChanged =
      !!previous && evidenceFingerprint(previous) !== evidenceFingerprint(requirement);
    if (becameVerified || evidenceChanged) ids.push(requirement.id);
  }
  return ids;
}

function evidenceFingerprint(requirement: Requirement): string {
  return JSON.stringify(
    (requirement.acceptance ?? []).map((acceptance) =>
      (acceptance.evidence ?? []).map((evidence) => [evidence.type, evidence.locator]),
    ),
  );
}

// ---------------------------------------------------------------------------
// Implementation resolution — sibling source + the test's own local imports
// ---------------------------------------------------------------------------

/**
 * The source files a cited test exercises: its sibling implementation
 * (foo.test.ts -> foo.ts) plus every source file it imports by relative path.
 * Workspace imports (`@mendpoint/*`) and node built-ins are out of scope on
 * purpose — mutating a whole other package to prove one citation is neither
 * affordable nor a fair attribution. Returns an empty list when nothing local
 * resolves, which the caller reports as `undetermined`, never as a pass.
 */
export function resolveImplFiles(testPathAbs: string, source: string): string[] {
  const files = new Set<string>();
  const sibling = testPathAbs.replace(/\.(test|spec)\.tsx?$/, ".ts");
  if (sibling !== testPathAbs && existsSync(sibling)) files.add(sibling);
  const siblingTsx = testPathAbs.replace(/\.(test|spec)\.tsx?$/, ".tsx");
  if (siblingTsx !== testPathAbs && existsSync(siblingTsx)) files.add(siblingTsx);

  const dir = dirname(testPathAbs);
  // Skip type-only imports (`import type ... from` / `export type ... from`):
  // they are erased at runtime, so mutating their target can never change what
  // the test executes. Counting them as mutation targets manufactures false
  // survivors (a component with expressional logic and a type-only import would
  // look like decoration when it is simply untestable by if/throw removal).
  const importRe = /(?:import|export)\s+(?!type\b)[^;'"]*?from\s*["'](\.[^"']+)["']/g;
  const bareImportRe = /import\s*["'](\.[^"']+)["']/g;
  for (const re of [importRe, bareImportRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(source))) {
      const specifier = match[1]!;
      const resolved = resolveLocalSource(dir, specifier);
      if (resolved && !/\.(test|spec)\.tsx?$/.test(resolved)) files.add(resolved);
    }
  }
  return [...files];
}

function resolveLocalSource(fromDir: string, specifier: string): string | null {
  const base = resolve(fromDir, specifier);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    base,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mutation operators — crude, string-splice, byte-preserving
// ---------------------------------------------------------------------------

export type MutationOperator =
  | "delete-if-guard"
  | "invert-if"
  | "strip-throw"
  | "void-return";

/**
 * Removal operators decide the verdict; diagnostic operators never do.
 *
 * The property the brief states is REMOVAL: "delete the control, watch a test
 * fail." A removal (delete an `if`, strip a `throw`) changes behavior only on
 * the inputs that would have TRIGGERED the control, so a test that never drives
 * the triggering path correctly leaves it surviving — that is the inert control
 * we must catch. Inverting a condition or voiding a return, by contrast,
 * perturbs the ALREADY-tested path too, so it kills even when the control's
 * triggering branch has no test (a false sense of coverage — exactly the
 * delegated-verifier defect). So inversion and void-return are kept only as
 * DIAGNOSTICS: they can tell a "survived because the test never runs this code
 * at all" apart from a "survived because the control is inert", but they never
 * turn a survived removal into a kill.
 */
export const REMOVAL_OPERATORS: ReadonlySet<MutationOperator> = new Set([
  "delete-if-guard",
  "strip-throw",
]);

export type Mutant = Readonly<{
  operator: MutationOperator;
  kind: "removal" | "diagnostic";
  /** Character offsets into the source; [start, end) is replaced. */
  start: number;
  end: number;
  replacement: string;
  line: number;
  /** Priority: lower runs first (guard-shaped removals lead). */
  priority: number;
  description: string;
}>;

/**
 * Enumerate crude mutants of one source file, ordered so guard-shaped removals
 * run first. The order only affects how fast a kill is found; a survived verdict
 * still requires the whole (capped) removal set to be exhausted.
 */
export function generateMutants(path: string, source: string): Mutant[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const mutants: Mutant[] = [];
  const lineOf = (pos: number): number =>
    sourceFile.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const guards =
        containsExit(node.thenStatement) || (node.elseStatement != null && containsExit(node.elseStatement));
      // Delete the whole control. A guard that returns/throws is the classic
      // "control", so it leads; a plain branching `if` still gets deleted but
      // ranks lower.
      // Removal (verdict-deciding): delete the whole control. A guard that
      // returns/throws is the classic control, so it leads; a plain branching
      // `if` is still deletable but ranks lower.
      mutants.push({
        operator: "delete-if-guard",
        kind: "removal",
        start: node.getStart(sourceFile),
        end: node.getEnd(),
        replacement: ";",
        line: lineOf(node.getStart(sourceFile)),
        priority: guards ? 0 : 2,
        description: `delete if-statement${guards ? " (guard)" : ""}`,
      });
      // Diagnostic only: inverting perturbs the tested path, so it can tell
      // "code is executed" from "code is dead", but it never decides killed.
      const condition = node.expression;
      mutants.push({
        operator: "invert-if",
        kind: "diagnostic",
        start: condition.getStart(sourceFile),
        end: condition.getEnd(),
        replacement: `!(${condition.getText(sourceFile)})`,
        line: lineOf(condition.getStart(sourceFile)),
        priority: 10,
        description: "invert if-condition (diagnostic)",
      });
    } else if (ts.isThrowStatement(node)) {
      // Removal (verdict-deciding).
      mutants.push({
        operator: "strip-throw",
        kind: "removal",
        start: node.getStart(sourceFile),
        end: node.getEnd(),
        replacement: ";",
        line: lineOf(node.getStart(sourceFile)),
        priority: 1,
        description: "strip throw-statement",
      });
    } else if (ts.isReturnStatement(node) && node.expression) {
      const text = node.expression.getText(sourceFile);
      if (text !== "undefined") {
        // Diagnostic only: voiding a return perturbs the tested path.
        mutants.push({
          operator: "void-return",
          kind: "diagnostic",
          start: node.expression.getStart(sourceFile),
          end: node.expression.getEnd(),
          replacement: "undefined",
          line: lineOf(node.expression.getStart(sourceFile)),
          priority: 11,
          description: "replace returned expression with undefined (diagnostic)",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return mutants.sort((a, b) => a.priority - b.priority || a.start - b.start);
}

function containsExit(node: ts.Node): boolean {
  let found = false;
  const walk = (current: ts.Node): void => {
    if (found) return;
    // Do not descend into nested function bodies — their returns belong to a
    // different control, not this guard.
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return;
    }
    if (ts.isReturnStatement(current) || ts.isThrowStatement(current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, walk);
  };
  walk(node);
  return found;
}

/** Apply one mutant by splicing its replacement over [start, end). */
export function applyMutant(source: string, mutant: Mutant): string {
  return source.slice(0, mutant.start) + mutant.replacement + source.slice(mutant.end);
}

// ---------------------------------------------------------------------------
// The prove loop
// ---------------------------------------------------------------------------

export type TestRun = Readonly<{ ran: boolean; passed: boolean; detail?: string }>;
/** Runs the cited test file(s); production shells to vitest, tests inject a fake. */
export type TestRunner = (testFilesRel: readonly string[]) => TestRun;

export type Verdict = "killed" | "survived" | "undetermined";

export type CitationResult = Readonly<{
  locator: string;
  verdict: Verdict;
  reason: string;
  implFiles: readonly string[];
  mutantsTried: number;
  killedBy?: Readonly<{ file: string; line: number; operator: MutationOperator; description: string }>;
}>;

export type ProveOptions = Readonly<{
  repoRoot: string;
  /** Cited test file, repo-relative (as it appears in the register). */
  testFileRel: string;
  runTest: TestRunner;
  /** Max mutants attempted per citation before declaring survived. */
  cap?: number;
  /** File writer/reader hooks (defaults touch disk); overridable for tests. */
  readFile?: (absPath: string) => string;
  writeFile?: (absPath: string, contents: string) => void;
}>;

const DEFAULT_CAP = 40;

/**
 * Prove that mutating the implementation a cited test imports makes that test
 * fail. Restores every mutated file byte-for-byte in a finally, whatever the
 * outcome or a thrown error.
 */
export function proveCitation(options: ProveOptions & { locator: string }): CitationResult {
  const {
    repoRoot,
    testFileRel,
    runTest,
    locator,
    cap = DEFAULT_CAP,
    readFile = (absPath) => readFileSync(absPath, "utf8"),
    writeFile = (absPath, contents) => writeFileSync(absPath, contents),
  } = options;

  const testAbs = resolve(repoRoot, testFileRel);
  if (!existsSync(testAbs)) {
    return undetermined(locator, `cited test file does not exist: ${testFileRel}`, []);
  }
  const testSource = readFile(testAbs);
  const implFilesAbs = resolveImplFiles(testAbs, testSource);
  const implFilesRel = implFilesAbs.map((absPath) => rel(repoRoot, absPath));
  if (implFilesAbs.length === 0) {
    return undetermined(
      locator,
      "could not locate the implementation the test imports (no sibling source, no local relative imports)",
      [],
    );
  }

  // Baseline. A kill can only be attributed against a green start.
  const baseline = runTest([testFileRel]);
  if (!baseline.ran) {
    return undetermined(
      locator,
      `cited test did not run at baseline${baseline.detail ? `: ${baseline.detail}` : ""}`,
      implFilesRel,
    );
  }
  if (!baseline.passed) {
    return undetermined(
      locator,
      `cited test is red at baseline; a mutant kill could not be attributed to the mutation${baseline.detail ? `: ${baseline.detail}` : ""}`,
      implFilesRel,
    );
  }

  // Gather mutants across every implementation file, split by kind. Only
  // REMOVAL mutants decide the verdict (see REMOVAL_OPERATORS); diagnostics are
  // used to explain a survival, never to manufacture a kill.
  const perFile = implFilesAbs.map((absPath) => ({
    absPath,
    original: readFile(absPath),
  }));
  const allMutants: Array<{ absPath: string; original: string; mutant: Mutant }> = [];
  for (const file of perFile) {
    for (const mutant of generateMutants(rel(repoRoot, file.absPath), file.original)) {
      allMutants.push({ absPath: file.absPath, original: file.original, mutant });
    }
  }
  const removalMutants = allMutants
    .filter((item) => item.mutant.kind === "removal")
    .sort((a, b) => a.mutant.priority - b.mutant.priority);
  const diagnosticMutants = allMutants
    .filter((item) => item.mutant.kind === "diagnostic")
    .sort((a, b) => a.mutant.priority - b.mutant.priority);

  if (removalMutants.length === 0) {
    return undetermined(
      locator,
      `no removable control (guard or throw) found in ${implFilesRel.join(", ")}; ` +
        `the "delete the control, watch a test fail" property cannot be evaluated for this citation`,
      implFilesRel,
    );
  }

  const runMutant = (item: { absPath: string; original: string; mutant: Mutant }): TestRun | null => {
    const mutated = applyMutant(item.original, item.mutant);
    if (mutated === item.original) return null;
    writeFile(item.absPath, mutated);
    try {
      return runTest([testFileRel]);
    } finally {
      writeFile(item.absPath, item.original); // byte-exact restore
    }
  };

  let tried = 0;
  try {
    // Verdict pass: removal operators only, stop at the first kill.
    const removalBudget = removalMutants.slice(0, cap);
    for (const item of removalBudget) {
      const result = runMutant(item);
      if (result === null) continue;
      tried += 1;
      if (result.ran && !result.passed) {
        return {
          locator,
          verdict: "killed",
          reason: `removing a control killed the cited test (${item.mutant.operator} at ${rel(repoRoot, item.absPath)}:${item.mutant.line})`,
          implFiles: implFilesRel,
          mutantsTried: tried,
          killedBy: {
            file: rel(repoRoot, item.absPath),
            line: item.mutant.line,
            operator: item.mutant.operator,
            description: item.mutant.description,
          },
        };
      }
      // A mutant that could not run (e.g. a transform error) is not a kill; it
      // is skipped, not counted as evidence either way.
    }

    // No removal killed the test. Before declaring survived, use one diagnostic
    // mutant to tell "the test executes this code but not the control" apart
    // from "the test does not run this code at all" — both are survivals, but
    // the wording should not overclaim.
    let executed = false;
    for (const item of diagnosticMutants.slice(0, Math.min(diagnosticMutants.length, 8))) {
      const result = runMutant(item);
      if (result === null) continue;
      tried += 1;
      if (result.ran && !result.passed) {
        executed = true;
        break;
      }
    }

    const cappedNote =
      removalMutants.length > cap ? ` (removal set capped at ${cap} of ${removalMutants.length})` : "";
    const detail = executed
      ? `the cited test executes ${implFilesRel.join(", ")} but does not exercise the removed control — the control can be deleted and the test still passes`
      : `no mutation of ${implFilesRel.join(", ")} perturbs the cited test — the test does not exercise this implementation`;
    return {
      locator,
      verdict: "survived",
      reason: `${removalBudgetSize(removalMutants, cap)} control removal(s) survived${cappedNote}; ${detail}; the requirement is not verified by this citation`,
      implFiles: implFilesRel,
      mutantsTried: tried,
    };
  } finally {
    // Defense in depth: guarantee every file is back to its original bytes even
    // if the loop threw between write and restore.
    for (const file of perFile) writeFile(file.absPath, file.original);
  }
}

function removalBudgetSize(removalMutants: readonly unknown[], cap: number): number {
  return Math.min(removalMutants.length, cap);
}

function undetermined(locator: string, reason: string, implFiles: string[]): CitationResult {
  return { locator, verdict: "undetermined", reason, implFiles, mutantsTried: 0 };
}

// ---------------------------------------------------------------------------
// Requirement-level aggregation
// ---------------------------------------------------------------------------

export type RequirementResult = Readonly<{
  id: string;
  verdict: Verdict;
  reason: string;
  citations: readonly CitationResult[];
}>;

/**
 * A requirement's verdict from its citation results:
 *   - survived      if ANY test citation survived mutation (it carries
 *                   decoration; the strongest, most actionable signal).
 *   - undetermined  if it has no test citations at all, or none could be
 *                   evaluated — a `verified` entry we cannot mechanically check.
 *   - killed        if at least one citation was killed and none survived.
 * Survived and undetermined are both failures of the claim; killed is the only
 * pass.
 */
export function aggregateRequirement(id: string, citations: CitationResult[]): RequirementResult {
  if (citations.length === 0) {
    return {
      id,
      verdict: "undetermined",
      reason: "marked verified but cites no test-type evidence to mutate against",
      citations,
    };
  }
  if (citations.some((citation) => citation.verdict === "survived")) {
    const survivors = citations.filter((citation) => citation.verdict === "survived");
    return {
      id,
      verdict: "survived",
      reason: `${survivors.length} citation(s) survived mutation: ${survivors.map((survivor) => survivor.locator).join(", ")}`,
      citations,
    };
  }
  if (citations.some((citation) => citation.verdict === "killed")) {
    return {
      id,
      verdict: "killed",
      reason: "every evaluable citation has a test that dies when its implementation is mutated",
      citations,
    };
  }
  return {
    id,
    verdict: "undetermined",
    reason: `no citation could be evaluated: ${citations.map((citation) => citation.reason).join("; ")}`,
    citations,
  };
}

// ---------------------------------------------------------------------------
// Production test runner (shells to vitest)
// ---------------------------------------------------------------------------

/**
 * Runs one or more test files through vitest from the repo root and reads the
 * verdict from the exit code. A clean exit is a pass; a non-zero exit with the
 * vitest failure banner is a fail (a kill); anything else — a crash, a config
 * error, no test collected — is reported as `ran: false`, so a broken run can
 * never masquerade as a passing test.
 */
export function makeVitestRunner(repoRoot: string): TestRunner {
  // Invoke vitest through node against its resolved entry, never through a shell,
  // so the register-supplied test paths are passed as argv, not concatenated
  // into a command line.
  const vitestEntry = resolve(repoRoot, "node_modules/vitest/vitest.mjs");
  return (testFilesRel) => {
    try {
      const stdout = execFileSync(
        process.execPath,
        [vitestEntry, "run", ...testFilesRel, "--reporter=dot", "--no-color"],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const passed = /Test Files\s+\d+ passed/.test(stdout) && !/failed/.test(stdout);
      const collected = /Test Files\s/.test(stdout);
      return { ran: collected, passed, detail: collected ? undefined : "no test files collected" };
    } catch (error) {
      const stdout = String((error as { stdout?: Buffer | string }).stdout ?? "");
      const stderr = String((error as { stderr?: Buffer | string }).stderr ?? "");
      const output = stdout + stderr;
      // A real test failure: vitest ran, collected, and reported failures.
      if (/Test Files\s+.*failed/.test(output) || /\d+ failed/.test(output)) {
        return { ran: true, passed: false };
      }
      // Otherwise the run itself broke — undetermined, not a kill.
      return { ran: false, passed: false, detail: firstLine(stderr || stdout) };
    }
  };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.slice(0, 200) ?? "no output";
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export function proveRequirement(
  requirement: Requirement,
  options: Omit<ProveOptions, "testFileRel" | "locator">,
): RequirementResult {
  const citations = testCitations(requirement).map((evidence) =>
    proveCitation({ ...options, testFileRel: evidence.locator, locator: evidence.locator }),
  );
  return aggregateRequirement(requirement.id, citations);
}

function rel(repoRoot: string, absPath: string): string {
  return absPath.slice(resolve(repoRoot).length + 1).split("\\").join("/");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Cli = Readonly<{
  mode: "diff" | "requirement" | "all-verified" | "control";
  base?: string;
  ids?: string[];
  limit?: number;
  seed?: number;
  control?: { testFileRel: string; implHint?: string };
  cap?: number;
}>;

function parseArgs(argv: string[]): Cli {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (argv.includes("--control")) {
    const value = get("--control") ?? "";
    const [testFileRel] = value.split("::");
    return { mode: "control", control: { testFileRel: testFileRel! }, cap: numeric(get("--cap")) };
  }
  if (argv.includes("--all-verified")) {
    return {
      mode: "all-verified",
      limit: numeric(get("--limit")),
      seed: numeric(get("--seed")),
      cap: numeric(get("--cap")),
    };
  }
  const requirement = get("--requirement");
  if (requirement) {
    return { mode: "requirement", ids: requirement.split(","), cap: numeric(get("--cap")) };
  }
  return { mode: "diff", base: get("--base") ?? "origin/main", cap: numeric(get("--cap")) };
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function registerAtRef(repoRoot: string, ref: string): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:docs/PRODUCT_REQUIREMENTS.json`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function assertTreeClean(repoRoot: string): void {
  const status = execFileSync("git", ["status", "--porcelain", "--", "packages", "apps", "scripts", "evals"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  // Our own new files (mutation-proof.ts/.test.ts) are expected; any OTHER dirty
  // path under source would mean a mutation leaked. Fail loudly if so.
  const leaked = status
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .filter((line) => !/scripts\/mutation-proof\.(test\.)?ts/.test(line));
  if (leaked.length > 0) {
    console.error("Mutation proof ABORTED: working tree not clean after restore — a mutation may have leaked:");
    for (const line of leaked) console.error(`  ${line}`);
    process.exitCode = 2;
  }
}

function report(results: RequirementResult[]): number {
  let killed = 0;
  let survived = 0;
  let undeterminedCount = 0;
  for (const result of results) {
    const tag =
      result.verdict === "killed" ? "KILLED  " : result.verdict === "survived" ? "SURVIVED" : "UNDETERM";
    console.log(`${tag}  ${result.id}  ${result.reason}`);
    for (const citation of result.citations) {
      console.log(`           - [${citation.verdict}] ${citation.locator} :: ${citation.reason}`);
    }
    if (result.verdict === "killed") killed += 1;
    else if (result.verdict === "survived") survived += 1;
    else undeterminedCount += 1;
  }
  console.log(
    `\nMutation proof: ${killed} proven (a test dies), ${survived} SURVIVED mutation (decoration), ${undeterminedCount} undetermined.`,
  );
  if (survived > 0) {
    console.log(
      "SURVIVED means the capability can be removed and the cited test still passes — those requirements are not verified.",
    );
  }
  // Survived is a claim failure and fails the check. Undetermined also fails the
  // gate (a `verified` entry that cannot be mechanically checked is exactly the
  // defect this exists to catch) — but see the --all-verified audit note.
  return survived + undeterminedCount;
}

function main(): void {
  const repoRoot = resolve(import.meta.dirname, "..");
  const cli = parseArgs(process.argv.slice(2));
  const runTest = makeVitestRunner(repoRoot);
  const options = { repoRoot, runTest, cap: cli.cap };
  const headJson = readFileSync(resolve(repoRoot, "docs/PRODUCT_REQUIREMENTS.json"), "utf8");
  const register = readRegister(headJson);
  const byId = new Map(register.map((requirement) => [requirement.id, requirement]));

  if (cli.mode === "control") {
    const testFileRel = cli.control!.testFileRel;
    const citation = proveCitation({ ...options, testFileRel, locator: testFileRel });
    console.log(`${citation.verdict.toUpperCase()}  ${testFileRel}`);
    console.log(`  impl: ${citation.implFiles.join(", ") || "(none located)"}`);
    console.log(`  ${citation.reason}`);
    if (citation.killedBy) {
      console.log(`  killed by: ${citation.killedBy.operator} at ${citation.killedBy.file}:${citation.killedBy.line}`);
    }
    assertTreeClean(repoRoot);
    if (citation.verdict !== "killed") process.exitCode = 1;
    return;
  }

  let targets: Requirement[];
  if (cli.mode === "diff") {
    const baseJson = registerAtRef(repoRoot, cli.base!);
    const ids = diffRequirements(baseJson, headJson);
    if (ids.length === 0) {
      console.log(
        `Mutation proof: no requirement moved to verified or changed evidence vs ${cli.base}. Nothing to prove.`,
      );
      assertTreeClean(repoRoot);
      return;
    }
    console.log(`Diff-gated against ${cli.base}: proving ${ids.length} requirement(s): ${ids.join(", ")}`);
    targets = ids.map((id) => byId.get(id)!).filter(Boolean);
  } else if (cli.mode === "requirement") {
    targets = cli.ids!.map((id) => byId.get(id)).filter((r): r is Requirement => {
      if (!r) console.error(`Unknown requirement id (skipped): not in register`);
      return !!r;
    });
  } else {
    let verified = register.filter((requirement) => requirement.implementationStatus === "verified");
    if (cli.seed !== undefined) verified = sample(verified, cli.seed);
    if (cli.limit !== undefined) verified = verified.slice(0, cli.limit);
    console.log(`Auditing ${verified.length} verified requirement(s)${cli.limit ? " (sampled/limited)" : ""}.`);
    targets = verified;
  }

  const results = targets.map((requirement) => proveRequirement(requirement, options));
  const failures = report(results);
  assertTreeClean(repoRoot);
  // On-demand audit is exploratory: it reports and never fails the build. The
  // diff-gated and requirement/control modes are gates and exit non-zero on a
  // survived or undetermined claim.
  if (cli.mode !== "all-verified" && failures > 0) process.exitCode = 1;
}

/** Deterministic seeded shuffle, so a sampled audit names exactly what it ran. */
function sample<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
