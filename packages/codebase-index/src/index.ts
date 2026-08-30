/**
 * Codebase Indexing Layer (pre-computation).
 *
 * Extracts a lightweight, queryable index without retaining full source longer
 * than needed for a given analysis window. MVP uses regex/heuristic front-ends
 * in the spirit of tree-sitter; plug in tree-sitter / LSP / CodeQL later without
 * changing the Impact pipeline contract.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  join,
  relative,
  dirname,
  basename,
  extname,
  isAbsolute,
  resolve,
  sep,
} from "node:path";
import { hostname } from "node:os";
import {
  buildCallGraph,
  buildCallGraphIncremental,
  reverseReachability,
  type CallGraph,
} from "@mendpoint/call-graph";
import { classifyDependencyDirectory } from "@mendpoint/shared";
import {
  extractWithTypescript,
  isTypescriptFile,
  loadTypescriptSync,
} from "./ts-frontend.js";
import {
  classifyMemberChain,
  providerBindingsForFile,
  resolveSdkContext,
  type SdkDetection,
  type SdkDetectionContext,
  type SdkMatchSets,
} from "./sdk-detect.js";

export type { SdkDetection, SdkDetectionContext } from "./sdk-detect.js";

const CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".java",
  ".rb",
  ".kt",
]);
const STRUCTURED_EXTS = new Set([".json"]);
const INDEX_EXTS = new Set([...CODE_EXTS, ...STRUCTURED_EXTS]);

/** Whether the deterministic index can read a path during source discovery. */
export function isCodebaseIndexPath(path: string): boolean {
  return INDEX_EXTS.has(extname(path).toLowerCase());
}

export type IndexedFunction = {
  name: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  /** Approximate callee names referenced in body */
  callees: string[];
};

export type ApiUsageRecord = {
  filePath: string;
  line: number;
  kind: "sdk_call" | "http_path" | "import" | "config" | "graphql" | "field_token";
  value: string;
  functionName?: string;
  /**
   * For `sdk_call` / `field_token` usages: whether the match was against a known
   * provider surface or the provider-agnostic fallback heuristic. Absent for
   * kinds that carry no such distinction.
   */
  detection?: SdkDetection;
  /**
   * For `http_path` usages: the path literal was found inside a comment (a doc
   * comment documenting which endpoint a class talks to). Such a path still
   * anchors provider provenance, but it is not itself a code edit site, so it
   * must not create a promotable candidate.
   */
  inComment?: boolean;
};

export type FileRecord = {
  path: string;
  language: "typescript" | "javascript" | "python" | "go" | "java" | "ruby" | "other";
  isTest: boolean;
  imports: string[];
  contentHash: string;
  lineCount: number;
};

export type StructuredFileRecord = {
  path: string;
  format: "json";
  isTest: boolean;
  contentHash: string;
  lineCount: number;
};

/** A directory pruned during discovery, recorded so the skip is auditable. */
export type SkippedDirectory = {
  /** Repo-relative path of the skipped directory. */
  path: string;
  /** Why it was skipped, e.g. `ignored_name:node_modules` or `python_virtualenv:pyvenv.cfg`. */
  reason: string;
};

export type CodebaseIndex = {
  repoRoot: string;
  builtAt: string;
  /** Digest and usage for the exact immutable bytes consumed by this index. */
  repositoryIdentity?: CodebaseIndexRepositoryIdentity;
  files: FileRecord[];
  /**
   * Bounded structured payloads are indexed separately from executable source.
   * Optional preserves compatibility with persisted indexes written before the
   * structured-payload channel existed.
   */
  structuredFiles?: StructuredFileRecord[];
  functions: IndexedFunction[];
  /** name → functions that call it (legacy name-only reverse edges) */
  callersOf: Record<string, string[]>;
  /** name → callees */
  calleesOf: Record<string, string[]>;
  apiUsages: ApiUsageRecord[];
  packageImports: string[];
  /**
   * Graph-based call graph (primary mechanism for transitive impact).
   * Prefer this over callersOf/calleesOf for expansion.
   */
  callGraph: CallGraph;
  /** Directories pruned during discovery (dependency trees, caches, virtualenvs). */
  skippedDirectories: SkippedDirectory[];
};

export type CodebaseIndexLimits = Readonly<{
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxTraversalDepth: number;
}>;

export type CodebaseIndexRepositoryIdentity = Readonly<{
  schemaVersion: "mendpoint.codebase-index-repository-identity.v1";
  repositorySnapshotId: string;
  repositoryRevision: string;
  repositoryContentDigest: string;
  filesInspected: number;
  bytesInspected: number;
}>;

export type CodebaseIndexOptions = Readonly<{
  callGraph?: CallGraph;
  limits?: Partial<CodebaseIndexLimits>;
  /**
   * Provider surface signals that drive SDK-call / field detection. When absent,
   * detection uses the provider-agnostic fallback and marks results as
   * `general_heuristic` (lower confidence) rather than returning nothing.
   */
  sdkContext?: SdkDetectionContext;
}>;

export type CodebaseIndexSafetyCode =
  | "codebase_index_limits_invalid"
  | "codebase_index_symlink_not_allowed"
  | "codebase_index_file_count_limit"
  | "codebase_index_total_bytes_limit"
  | "codebase_index_file_bytes_limit"
  | "codebase_index_traversal_depth_limit"
  | "codebase_index_file_changed_during_index"
  | "codebase_index_persisted_path_invalid"
  | "codebase_index_persisted_file_invalid"
  | "codebase_index_persisted_file_bytes_limit"
  | "codebase_index_persisted_schema_unsupported"
  | "codebase_index_persisted_shape_invalid"
  | "codebase_index_persisted_authority_mismatch"
  | "codebase_index_persisted_digest_mismatch"
  | "codebase_index_persisted_generation_conflict"
  | "codebase_index_persisted_lock_conflict";

export class CodebaseIndexSafetyError extends Error {
  readonly code: CodebaseIndexSafetyCode;
  readonly diagnostic: Readonly<{
    path: string;
    limit?: number;
    actual?: number;
  }>;

  constructor(
    code: CodebaseIndexSafetyCode,
    diagnostic: { path: string; limit?: number; actual?: number },
    readonly repositoryIdentity?: CodebaseIndexRepositoryIdentity,
  ) {
    super(code);
    this.name = "CodebaseIndexSafetyError";
    this.code = code;
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

export const DEFAULT_CODEBASE_INDEX_LIMITS: CodebaseIndexLimits = Object.freeze({
  maxFiles: 50_000,
  maxTotalBytes: 1_073_741_824,
  maxFileBytes: 5_242_880,
  maxTraversalDepth: 64,
});

type DiscoveredFile = {
  abs: string;
  rel: string;
  size: number;
  text?: string;
  contentHash?: string;
  contentDigest?: string;
};

type DiscoveryUsage = { files: number; totalBytes: number };

/**
 * Detect a dependency/generated directory that we should NOT walk, preferring a
 * structural marker over a bare name so we never drop tracked source that merely
 * happens to be named `venv` / `env`. Returns the reason for the skip, or null.
 *
 * The list and marker decision are the shared definition in `@mendpoint/shared`
 * (`classifyDependencyDirectory`), so this walker, the call graph, and the agent
 * cannot drift apart again; only the reason-string format is local.
 */
function ignoredDirectoryReason(name: string, absPath: string): string | null {
  if (name === ".mendpoint") return "mendpoint_state";
  const decision = classifyDependencyDirectory(name, (marker) =>
    existsSync(join(absPath, marker)),
  );
  if (!decision) return null;
  return decision.kind === "ignored_name"
    ? `ignored_name:${decision.name}`
    : `python_virtualenv:${decision.marker}`;
}

function normalizedLimits(input?: Partial<CodebaseIndexLimits>): CodebaseIndexLimits {
  const limits = { ...DEFAULT_CODEBASE_INDEX_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new CodebaseIndexSafetyError("codebase_index_limits_invalid", {
        path: name,
        actual: value,
      });
    }
  }
  return Object.freeze(limits);
}

function relativePath(repoRoot: string, path: string): string {
  const rel = relative(repoRoot, path).replace(/\\/g, "/");
  return rel || ".";
}

function fail(
  code: CodebaseIndexSafetyCode,
  repoRoot: string,
  path: string,
  limit?: number,
  actual?: number,
): never {
  throw new CodebaseIndexSafetyError(code, {
    path: relativePath(repoRoot, path),
    ...(limit === undefined ? {} : { limit }),
    ...(actual === undefined ? {} : { actual }),
  });
}

function accountFile(
  repoRoot: string,
  path: string,
  size: number,
  limits: CodebaseIndexLimits,
  usage: DiscoveryUsage,
): void {
  if (size > limits.maxFileBytes) {
    fail("codebase_index_file_bytes_limit", repoRoot, path, limits.maxFileBytes, size);
  }
  const files = usage.files + 1;
  if (files > limits.maxFiles) {
    fail("codebase_index_file_count_limit", repoRoot, path, limits.maxFiles, files);
  }
  const totalBytes = usage.totalBytes + size;
  if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
    fail("codebase_index_total_bytes_limit", repoRoot, path, limits.maxTotalBytes, totalBytes);
  }
  usage.files = files;
  usage.totalBytes = totalBytes;
}

function assertRegularFile(
  repoRoot: string,
  path: string,
  expectedSize: number | undefined,
  limits: CodebaseIndexLimits,
): number {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    fail("codebase_index_symlink_not_allowed", repoRoot, path);
  }
  if (!stat.isFile()) {
    fail("codebase_index_file_changed_during_index", repoRoot, path);
  }
  if (stat.size > limits.maxFileBytes) {
    fail("codebase_index_file_bytes_limit", repoRoot, path, limits.maxFileBytes, stat.size);
  }
  if (expectedSize !== undefined && stat.size !== expectedSize) {
    fail("codebase_index_file_changed_during_index", repoRoot, path, expectedSize, stat.size);
  }
  return stat.size;
}

function readDiscoveredFile(
  repoRoot: string,
  file: DiscoveredFile,
  limits: CodebaseIndexLimits,
): string {
  assertRegularFile(repoRoot, file.abs, file.size, limits);
  const text = readFileSync(file.abs, "utf8");
  assertRegularFile(repoRoot, file.abs, Buffer.byteLength(text), limits);
  return text;
}

function repositoryIdentity(
  files: readonly DiscoveredFile[],
  boundary?: Readonly<{ code: string; path: string; limit?: number; actual?: number }>,
): CodebaseIndexRepositoryIdentity {
  const rows = files
    .map((file) => ({
      path: file.rel,
      size: file.size,
      contentDigest: file.contentDigest ?? createHash("sha256").update(file.text ?? "").digest("hex"),
    }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const repositoryContentDigest = createHash("sha256")
    .update(JSON.stringify({ rows, boundary: boundary ?? null }), "utf8")
    .digest("hex");
  return Object.freeze({
    schemaVersion: "mendpoint.codebase-index-repository-identity.v1",
    repositorySnapshotId: `repository-snapshot:${repositoryContentDigest}`,
    repositoryRevision: repositoryContentDigest,
    repositoryContentDigest: `sha256:${repositoryContentDigest}`,
    filesInspected: rows.length,
    bytesInspected: rows.reduce((total, row) => total + row.size, 0),
  });
}

function captureDiscoveredFile(
  repoRoot: string,
  file: DiscoveredFile,
  limits: CodebaseIndexLimits,
): DiscoveredFile {
  const text = readDiscoveredFile(repoRoot, file, limits);
  const contentDigest = createHash("sha256").update(text).digest("hex");
  return { ...file, text, contentDigest, contentHash: contentDigest.slice(0, 16) };
}

function walk(
  repoRoot: string,
  dir: string,
  limits: CodebaseIndexLimits,
  usage: DiscoveryUsage,
  skipped: SkippedDirectory[],
  depth = 0,
  out: DiscoveredFile[] = [],
): DiscoveredFile[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const skipReason = ignoredDirectoryReason(name, p);
    if (skipReason) {
      // Record the skip so a pruned dependency/cache tree is auditable, never a
      // silent truncation. Only record directories that actually exist as such.
      try {
        if (lstatSync(p).isDirectory()) {
          skipped.push({ path: relativePath(repoRoot, p), reason: skipReason });
        }
      } catch {
        /* vanished during walk — nothing to record */
      }
      continue;
    }
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      fail("codebase_index_symlink_not_allowed", repoRoot, p);
    }
    if (st.isDirectory()) {
      const nextDepth = depth + 1;
      if (nextDepth > limits.maxTraversalDepth) {
        fail("codebase_index_traversal_depth_limit", repoRoot, p, limits.maxTraversalDepth, nextDepth);
      }
      walk(repoRoot, p, limits, usage, skipped, nextDepth, out);
    } else if (st.isFile()) {
      const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";
      if (INDEX_EXTS.has(ext)) {
        accountFile(repoRoot, p, st.size, limits, usage);
        out.push(captureDiscoveredFile(repoRoot, {
          abs: p,
          rel: relativePath(repoRoot, p),
          size: st.size,
        }, limits));
      }
    }
  }
  return out;
}

function discoverFiles(
  repoRoot: string,
  limits: CodebaseIndexLimits,
): {
  files: DiscoveredFile[];
  manifests: DiscoveredFile[];
  usage: DiscoveryUsage;
  skipped: SkippedDirectory[];
  identity: CodebaseIndexRepositoryIdentity;
} {
  const rootStat = lstatSync(repoRoot);
  if (rootStat.isSymbolicLink()) {
    fail("codebase_index_symlink_not_allowed", repoRoot, repoRoot);
  }
  if (!rootStat.isDirectory()) {
    fail("codebase_index_file_changed_during_index", repoRoot, repoRoot);
  }
  const usage: DiscoveryUsage = { files: 0, totalBytes: 0 };
  const skipped: SkippedDirectory[] = [];
  const files: DiscoveredFile[] = [];
  const manifests: DiscoveredFile[] = [];
  try {
    walk(repoRoot, repoRoot, limits, usage, skipped, 0, files);
    const discoveredPaths = new Set(files.map((file) => file.abs));
    for (const manifest of ["package.json", "requirements.txt", "go.mod", "Gemfile"]) {
      const path = join(repoRoot, manifest);
      if (!existsSync(path)) continue;
      if (discoveredPaths.has(path)) continue;
      const size = assertRegularFile(repoRoot, path, undefined, limits);
      accountFile(repoRoot, path, size, limits, usage);
      manifests.push(captureDiscoveredFile(repoRoot, {
        abs: path,
        rel: relativePath(repoRoot, path),
        size,
      }, limits));
    }
  } catch (error) {
    if (!(error instanceof CodebaseIndexSafetyError)) throw error;
    throw new CodebaseIndexSafetyError(error.code, error.diagnostic, repositoryIdentity(
      [...files, ...manifests],
      { code: error.code, ...error.diagnostic },
    ));
  }
  return {
    files,
    manifests,
    usage,
    skipped,
    identity: repositoryIdentity([...files, ...manifests]),
  };
}

function langOf(file: string): FileRecord["language"] {
  if (file.endsWith(".py")) return "python";
  if (file.endsWith(".go")) return "go";
  if (file.endsWith(".java") || file.endsWith(".kt")) return "java";
  if (file.endsWith(".rb")) return "ruby";
  if (file.endsWith(".ts") || file.endsWith(".tsx")) return "typescript";
  if (file.endsWith(".js") || file.endsWith(".jsx") || file.endsWith(".mjs") || file.endsWith(".cjs"))
    return "javascript";
  return "other";
}

function shouldRunTypescriptFrontend(
  file: string,
  text: string,
  context: SdkDetectionContext | undefined,
): boolean {
  if (!isTypescriptFile(file)) return false;
  if (/\.tsx?$/i.test(file) || !context) return true;
  // JavaScript repositories can contain tens of thousands of simple modules.
  // The heuristic frontend already captures their imports, functions, and call
  // edges. Invoke the compiler frontend only where a provider signal or module
  // edge can add richer evidence for this exact impact question.
  if (/\bimport\s|\brequire\s*\(|\bfetch\s*\(|\baxios\b|https?:\/\//i.test(text)) {
    return true;
  }
  const lower = text.toLowerCase();
  const hints = [
    ...(context.receivers ?? []),
    ...(context.methodPaths ?? []),
    ...(context.methods ?? []),
    ...(context.fields ?? []),
    ...(context.importHints ?? []),
  ]
    .map((value) => value.toLowerCase())
    .filter((value) => value.length >= 3);
  return hints.some((hint) => lower.includes(hint));
}

function isTestPath(rel: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|spec)(\/|$)/i.test(rel) ||
    /\.(test|spec)\.[jt]sx?$/.test(rel) ||
    /_test\.py$/.test(rel)
  );
}

function extractImports(text: string, language: FileRecord["language"]): string[] {
  const imports: string[] = [];
  if (language === "python") {
    // Leading dots are kept in the class so relative imports (`from . import x`,
    // `from ..pkg import y`) survive for the per-language resolver.
    for (const m of text.matchAll(/^\s*(?:from|import)\s+([a-zA-Z0-9_.]+)/gm)) {
      imports.push(m[1]!);
    }
  } else if (language === "go") {
    // Grouped `import ( "a"\n alias "b"\n _ "c" )` and single `import "a"`.
    for (const block of text.matchAll(/import\s*\(([\s\S]*?)\)/g)) {
      for (const m of block[1]!.matchAll(/(?:[A-Za-z0-9_.]+\s+)?["`]([^"`]+)["`]/g)) {
        imports.push(m[1]!);
      }
    }
    for (const m of text.matchAll(/^\s*import\s+(?:[A-Za-z0-9_.]+\s+)?["`]([^"`]+)["`]/gm)) {
      imports.push(m[1]!);
    }
  } else if (language === "java") {
    // `import a.b.C;`, static imports, and wildcard `import a.b.*;`.
    for (const m of text.matchAll(/^\s*import\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_.]*(?:\.\*)?)\s*;/gm)) {
      imports.push(m[1]!);
    }
  } else {
    for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) imports.push(m[1]!);
    for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) imports.push(m[1]!);
    for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) imports.push(m[1]!);
  }
  return [...new Set(imports)];
}

type FnSpan = { name: string; start: number; end: number; body: string };

function extractFunctions(text: string, language: FileRecord["language"]): FnSpan[] {
  const lines = text.split(/\r?\n/);
  const fns: FnSpan[] = [];

  if (language === "go" || language === "java") {
    for (let i = 0; i < lines.length; i++) {
      // Go: func Name(  Java: modifiers Type name(
      const goM = lines[i]!.match(
        /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
      );
      const javaM = lines[i]!.match(
        /^\s*(?:public|private|protected|static|final|synchronized|\s)*[\w.<>,\[\]]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
      );
      const name = goM?.[1] ?? (language === "java" ? javaM?.[1] : undefined);
      if (!name || name === "if" || name === "for" || name === "while" || name === "switch") continue;
      const start = i + 1;
      let depth = 0;
      let started = false;
      let end = start;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]!) {
          if (ch === "{") {
            depth++;
            started = true;
          } else if (ch === "}") {
            depth--;
          }
        }
        end = j + 1;
        if (started && depth <= 0) break;
      }
      fns.push({
        name,
        start,
        end,
        body: lines.slice(i, end).join("\n"),
      });
    }
    return fns;
  }

  if (language === "ruby") {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/^\s*def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_!?=]*)/);
      if (!m) continue;
      const name = m[1]!;
      const start = i + 1;
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*end\b/.test(lines[j]!) && !/^\s*#/.test(lines[j]!)) {
          // crude: first end at same or lower indent
          const ind = (lines[i]!.match(/^\s*/)?.[0].length ?? 0);
          const jind = lines[j]!.match(/^\s*/)?.[0].length ?? 0;
          if (jind <= ind) {
            end = j + 1;
            break;
          }
        }
      }
      fns.push({
        name,
        start,
        end,
        body: lines.slice(i, end).join("\n"),
      });
    }
    return fns;
  }

  if (language === "python") {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (!m) continue;
      const name = m[1]!;
      const start = i + 1;
      let end = lines.length;
      const indent = lines[i]!.match(/^\s*/)?.[0].length ?? 0;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j]!;
        if (line.trim() === "") continue;
        const ind = line.match(/^\s*/)?.[0].length ?? 0;
        if (ind <= indent && /^(def|class)\s+/.test(line.trim())) {
          end = j;
          break;
        }
      }
      fns.push({
        name,
        start,
        end,
        body: lines.slice(i, end).join("\n"),
      });
    }
    return fns;
  }

  // TS/JS: export function, function, const x = (...) =>, async function
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let name: string | null = null;
    const m1 = line.match(
      /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    );
    const m2 = line.match(
      /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*)\s*=>/,
    );
    if (m1) name = m1[1]!;
    else if (m2) name = m2[1]!;
    if (!name) continue;

    const start = i + 1;
    // crude brace matching from this line
    let depth = 0;
    let started = false;
    let end = start;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]!) {
        if (ch === "{") {
          depth++;
          started = true;
        } else if (ch === "}") {
          depth--;
        }
      }
      end = j + 1;
      if (started && depth <= 0) break;
      // arrow one-liners without braces
      if (!started && j === i && !line.includes("{") && line.includes("=>")) {
        end = j + 1;
        break;
      }
    }
    fns.push({
      name,
      start,
      end,
      body: lines.slice(i, end).join("\n"),
    });
  }
  return fns;
}

function extractCallees(body: string, selfName: string): string[] {
  const names = new Set<string>();
  for (const m of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const n = m[1]!;
    if (n === selfName || n === "if" || n === "for" || n === "while" || n === "switch") continue;
    if (n === "function" || n === "catch" || n === "return") continue;
    names.add(n);
  }
  // method style client.charges.create
  for (const m of body.matchAll(/\b([A-Za-z_][\w.]*)\s*\(/g)) {
    if (m[1]!.includes(".")) names.add(m[1]!);
  }
  return [...names];
}

/**
 * Env-var / config token detection. Provider-agnostic by construction: matches
 * SCREAMING_SNAKE identifiers with a config-ish suffix (URL/KEY/BASE/SECRET/…).
 * This replaces the fixture-specific `ACME_BASE` / `STRIPE_` literals that used
 * to ship in production while still catching them structurally.
 */
const CONFIG_TOKEN_RE =
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:URL|KEY|BASE|SECRET|TOKEN|ENDPOINT|HOST|REGION)\b|\b(?:BASE_URL|API_URL|API_KEY)\b/;

function extractApiUsages(
  rel: string,
  text: string,
  fns: FnSpan[],
  sdkSets: SdkMatchSets,
  fileReceivers: ReadonlySet<string>,
): ApiUsageRecord[] {
  const lines = text.split(/\r?\n/);
  const out: ApiUsageRecord[] = [];

  const fnAt = (lineNo: number): string | undefined => {
    const hit = fns.find((f) => lineNo >= f.start && lineNo <= f.end);
    return hit?.name;
  };

  let inBlockComment = false;
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const trimmed = line.trimStart();
    // A path in a doc/line comment documents an endpoint but is not a code site.
    // Track block comments across lines and recognise line/javadoc comments.
    const lineIsComment =
      inBlockComment ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("#");
    if (line.includes("/*") && !line.includes("*/")) inBlockComment = true;
    else if (inBlockComment && line.includes("*/")) inBlockComment = false;
    const commentTag = lineIsComment ? { inComment: true as const } : {};
    // HTTP path literals (quoted or embedded in template strings / concatenations)
    for (const m of line.matchAll(/['"`](\/v\d+\/[^'"`\s]+)['"`]/g)) {
      out.push({
        filePath: rel,
        line: lineNo,
        kind: "http_path",
        value: m[1]!,
        functionName: fnAt(lineNo),
        ...commentTag,
      });
    }
    for (const m of line.matchAll(/(\/v\d+\/[A-Za-z0-9_{}\/-]+)/g)) {
      out.push({
        filePath: rel,
        line: lineNo,
        kind: "http_path",
        value: m[1]!,
        functionName: fnAt(lineNo),
        ...commentTag,
      });
    }

    // SDK-ish patterns: member-access chains, classified against the provider
    // surface. A provider-matched chain is recorded even without a trailing call
    // (it may be passed around); a general-heuristic chain requires a call `(` to
    // suppress plain property reads (`res.ok`, `err.message`).
    // Declaration lines (`package a.b.c;`, `import a.b.C;`, `from a.b import x`)
    // are dotted namespaces, not call sites — a Go/Java/Python package path such
    // as `com.acme.settlement.payments` is not an SDK call and must not be
    // classified as one just because a segment matches a provider token.
    const isDeclaration = /^\s*(?:import|package|from|using|require)\b/.test(line);
    if (!isDeclaration)
    for (const m of line.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*(\()?/g)) {
      const chain = m[1]!;
      const detection = classifyMemberChain(chain, sdkSets, fileReceivers);
      if (!detection) continue;
      if (detection === "general_heuristic" && !m[2]) continue;
      out.push({
        filePath: rel,
        line: lineNo,
        kind: "sdk_call",
        value: chain,
        functionName: fnAt(lineNo),
        detection,
      });
    }
    // config / base URL
    if (CONFIG_TOKEN_RE.test(line)) {
      out.push({
        filePath: rel,
        line: lineNo,
        kind: "config",
        value: line.trim().slice(0, 120),
        functionName: fnAt(lineNo),
      });
    }
    // GraphQL operation hints
    for (const m of line.matchAll(/\b(query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
      out.push({
        filePath: rel,
        line: lineNo,
        kind: "graphql",
        value: `${m[1]} ${m[2]}`,
        functionName: fnAt(lineNo),
      });
    }
  });

  return out;
}

export function buildIndex(
  repoRoot: string,
  opts: CodebaseIndexOptions = {},
): CodebaseIndex {
  const limits = normalizedLimits(opts.limits);
  const discovery = discoverFiles(repoRoot, limits);
  return buildIndexFromDiscovered(
    repoRoot,
    opts,
    limits,
    discovery.files,
    discovery.skipped,
    discovery.identity,
    discovery.manifests,
  );
}

function buildIndexFromDiscovered(
  repoRoot: string,
  opts: CodebaseIndexOptions,
  limits: CodebaseIndexLimits,
  discoveredFiles: DiscoveredFile[],
  skippedDirectories: SkippedDirectory[] = [],
  identity: CodebaseIndexRepositoryIdentity = repositoryIdentity(discoveredFiles),
  repositoryManifests: DiscoveredFile[] = [],
): CodebaseIndex {
  const files: FileRecord[] = [];
  const structuredFiles: StructuredFileRecord[] = [];
  const functions: IndexedFunction[] = [];
  const apiUsages: ApiUsageRecord[] = [];
  const packageImports = new Set<string>();
  // null prototype — avoid 'constructor' / other Object.prototype keys breaking spreads.
  // Accumulate reverse/forward edges in Sets so adding one caller/callee is O(1);
  // the previous `[...new Set([...prev, next])]` per occurrence was O(K) each,
  // making a symbol with K callers cost O(K^2). Materialized to string[] once,
  // preserving insertion order (Set iteration order) so output is unchanged.
  const calleesSet: Record<string, Set<string>> = Object.create(null);
  const callersSet: Record<string, Set<string>> = Object.create(null);
  const addCallees = (name: string, callees: Iterable<string>): void => {
    const set = (calleesSet[name] ??= new Set<string>());
    for (const c of callees) set.add(c);
  };
  const addCaller = (callee: string, caller: string): void => {
    (callersSet[callee] ??= new Set<string>()).add(caller);
  };


  const tsApi = loadTypescriptSync();
  const sdkSets = resolveSdkContext(opts.sdkContext);

  // Buffers for every code file read here, keyed by absolute path. Threaded into
  // buildCallGraph below so the graph reuses them instead of re-reading the whole
  // tree — one read pass over the repo instead of two.
  const sources = new Map<string, string>();

  for (const discovered of discoveredFiles) {
    const abs = discovered.abs;
    const rel = discovered.rel;
    const text = discovered.text ?? readDiscoveredFile(repoRoot, discovered, limits);
    if (STRUCTURED_EXTS.has(extname(rel).toLowerCase())) {
      structuredFiles.push({
        path: rel,
        format: "json",
        isTest: isTestPath(rel),
        contentHash:
          discovered.contentHash ?? createHash("sha256").update(text).digest("hex").slice(0, 16),
        lineCount: text.split(/\r?\n/).length,
      });
      continue;
    }
    sources.set(abs, text);
    const language = langOf(rel);
    let imports = extractImports(text, language);
    let fns = extractFunctions(text, language);
    // Import resolution: binding names bound to the provider's package are
    // trusted as receivers for this file (a stronger signal than a name guess).
    const fileReceivers = providerBindingsForFile(text, language, sdkSets.importHints);

    // Phase B: prefer TypeScript compiler API for .ts/.tsx/.js when available
    if (tsApi && shouldRunTypescriptFrontend(rel, text, opts.sdkContext)) {
      try {
        const richer = extractWithTypescript(repoRoot, abs, tsApi, text, {
          sets: sdkSets,
          fileReceivers,
        });
        if (richer.imports.length) imports = [...new Set([...imports, ...richer.imports])];
        if (richer.functions.length) {
          // merge compiler functions with heuristic spans
          for (const rf of richer.functions) {
            if (!fns.some((f) => f.name === rf.name && f.start === rf.lineStart)) {
              fns.push({
                name: rf.name,
                start: rf.lineStart,
                end: rf.lineEnd,
                body: "",
              });
            }
          }
        }
        for (const u of richer.usages) {
          apiUsages.push({
            filePath: u.filePath,
            line: u.line,
            kind: u.kind === "field_token" ? "config" : u.kind,
            value: u.value,
            functionName: u.functionName,
            detection: u.detection,
          });
        }
        for (const rf of richer.functions) {
          addCallees(rf.name, rf.callees);
          for (const c of rf.callees) addCaller(c, rf.name);
        }
      } catch {
        /* keep heuristic */
      }
    }

    imports.forEach((i) => packageImports.add(i));

    files.push({
      path: rel,
      language,
      isTest: isTestPath(rel),
      imports,
      contentHash:
        discovered.contentHash ?? createHash("sha256").update(text).digest("hex").slice(0, 16),
      lineCount: text.split(/\r?\n/).length,
    });

    for (const fn of fns) {
      const callees =
        fn.body && fn.body.length
          ? extractCallees(fn.body, fn.name)
          : [...(calleesSet[fn.name] ?? [])];
      functions.push({
        name: fn.name,
        filePath: rel,
        lineStart: fn.start,
        lineEnd: fn.end,
        callees,
      });
      addCallees(fn.name, callees);
      for (const c of callees) addCaller(c, fn.name);
    }

    apiUsages.push(...extractApiUsages(rel, text, fns, sdkSets, fileReceivers));
  }


  // Lockfile package names (lightweight)
  const capturedByPath = new Map(
    [...discoveredFiles, ...repositoryManifests].map((file) => [file.rel, file.text ?? ""]),
  );
  for (const lock of ["package.json", "requirements.txt", "go.mod", "Gemfile"]) {
    const raw = capturedByPath.get(lock);
    if (raw === undefined) continue;
    if (lock === "package.json") {
      try {
        const pkg = JSON.parse(raw) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        for (const k of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
          packageImports.add(k);
        }
      } catch {
        /* ignore */
      }
    }
  }

  const callGraph =
    opts?.callGraph ?? buildCallGraph(repoRoot, { algorithm: "hybrid", sources });

  // Materialize the accumulated edges to arrays (insertion order preserved).
  const calleesOf: Record<string, string[]> = Object.create(null);
  const callersOf: Record<string, string[]> = Object.create(null);
  for (const name in calleesSet) calleesOf[name] = [...calleesSet[name]!];
  for (const name in callersSet) callersOf[name] = [...callersSet[name]!];

  // Prefer graph-derived reverse edges when available (richer than name-only)
  const nameMaps = deriveNameMaps(callGraph);
  Object.assign(calleesOf, nameMaps.calleesOf);
  Object.assign(callersOf, nameMaps.callersOf);

  return {
    repoRoot,
    builtAt: new Date().toISOString(),
    repositoryIdentity: identity,
    files,
    structuredFiles,
    functions,
    callersOf,
    calleesOf,
    apiUsages,
    packageImports: [...packageImports],
    callGraph,
    skippedDirectories,
  };
}



export const CODEBASE_INDEX_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const CODEBASE_INDEX_EXTRACTOR_VERSION = "1" as const;
export const MAX_PERSISTED_CODEBASE_INDEX_BYTES = 268_435_456;

export type CodebaseIndexAuthority = Readonly<{
  tenantId: string;
  repositoryId: string;
}>;

export type CodebaseIndexReuseClassification = "exact" | "incremental" | "rebuilt";

export type CodebaseIndexReuseEvidence = Readonly<{
  schemaVersion: typeof CODEBASE_INDEX_ENVELOPE_SCHEMA_VERSION;
  extractorVersion: typeof CODEBASE_INDEX_EXTRACTOR_VERSION;
  classification: CodebaseIndexReuseClassification;
  tenantId: string;
  repositoryId: string;
  canonicalRepoRootDigest: string;
  sdkContextDigest: string;
  indexContentDigest: string;
  generation: number;
  previousIndexContentDigest?: string;
  rejectedReason?: CodebaseIndexSafetyCode | "missing" | "persistence_disabled";
}>;

type PersistedCodebaseIndexEnvelope = Readonly<{
  schemaVersion: typeof CODEBASE_INDEX_ENVELOPE_SCHEMA_VERSION;
  extractor: Readonly<{ id: "mendpoint-codebase-index"; version: string }>;
  authority: Readonly<{
    tenantId: string;
    repositoryId: string;
    canonicalRepoRoot: string;
    sdkContextDigest: string;
  }>;
  indexContentDigest: string;
  generation: number;
  index: CodebaseIndex;
}>;

export type MaterializeCodebaseIndexOptions = Readonly<{
  authority: CodebaseIndexAuthority;
  /** Mendpoint-owned durable root. The cache path must be outside the analyzed checkout. */
  storageRoot: string;
  sdkContext?: SdkDetectionContext;
  limits?: Partial<CodebaseIndexLimits>;
  persist?: boolean;
  persistenceHooks?: Readonly<{
    beforePublish?: (context: Readonly<{
      path: string;
      observedGeneration: number;
      nextGeneration: number;
      observedFileDigest: string;
    }>) => void;
    afterPublish?: (context: Readonly<{ path: string; committedGeneration: number }>) => void;
  }>;
}>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(record).sort()) out[key] = canonicalValue(record[key]);
    return out;
  }
  return value;
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)), "utf8")
    .digest("hex");
}

function canonicalSdkContext(context?: SdkDetectionContext): SdkDetectionContext {
  const values = (items: readonly string[] | undefined) =>
    [...new Set((items ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean))].sort();
  return {
    receivers: values(context?.receivers),
    methodPaths: values(context?.methodPaths),
    methods: values(context?.methods),
    fields: values(context?.fields),
    importHints: values(context?.importHints),
  };
}

function canonicalRepositoryRoot(repoRoot: string): string {
  const stat = lstatSync(repoRoot);
  if (stat.isSymbolicLink()) fail("codebase_index_symlink_not_allowed", repoRoot, repoRoot);
  if (!stat.isDirectory()) fail("codebase_index_file_changed_during_index", repoRoot, repoRoot);
  return realpathSync(repoRoot);
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function persistedAuthority(
  repoRoot: string,
  authority: CodebaseIndexAuthority,
  sdkContext?: SdkDetectionContext,
) {
  const tenantId = authority.tenantId.trim();
  const repositoryId = authority.repositoryId.trim();
  const canonicalRepoRoot = canonicalRepositoryRoot(repoRoot);
  if (!tenantId || tenantId.length > 256 || !repositoryId || repositoryId.length > 256) {
    fail("codebase_index_persisted_authority_mismatch", canonicalRepoRoot,
      defaultIndexPath(canonicalRepoRoot));
  }
  return {
    tenantId,
    repositoryId,
    canonicalRepoRoot,
    sdkContextDigest: canonicalDigest(canonicalSdkContext(sdkContext)),
  } as const;
}

function pathWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

function assertOwnedDirectoryComponent(
  repoRoot: string,
  storageRoot: string,
  component: string,
): void {
  const stat = lstatSync(component);
  if (stat.isSymbolicLink()) {
    fail("codebase_index_symlink_not_allowed", repoRoot, component);
  }
  if (!stat.isDirectory()) {
    fail("codebase_index_persisted_path_invalid", repoRoot, component);
  }
  const canonical = realpathSync(component);
  if (!samePath(canonical, component)) {
    fail("codebase_index_symlink_not_allowed", repoRoot, component);
  }
  if (!pathWithin(storageRoot, canonical)) {
    fail("codebase_index_persisted_path_invalid", repoRoot, component);
  }
}

function assertOwnedDirectoryChain(
  repoRoot: string,
  storageRoot: string,
  parent: string,
  create: boolean,
): void {
  if (!pathWithin(storageRoot, parent)) {
    fail("codebase_index_persisted_path_invalid", repoRoot, parent);
  }
  assertOwnedDirectoryComponent(repoRoot, storageRoot, storageRoot);
  const rel = relative(storageRoot, parent);
  let component = storageRoot;
  for (const segment of rel ? rel.split(sep) : []) {
    if (!segment || segment === "." || segment === "..") {
      fail("codebase_index_persisted_path_invalid", repoRoot, parent);
    }
    component = join(component, segment);
    if (create && !existsSync(component)) {
      try {
        mkdirSync(component, { mode: 0o700 });
      } catch (error) {
        if (!isRecord(error) || error.code !== "EEXIST") throw error;
      }
    }
    assertOwnedDirectoryComponent(repoRoot, storageRoot, component);
  }
}

function assertOwnedRegularFile(repoRoot: string, storageRoot: string, path: string): void {
  if (!pathWithin(storageRoot, path)) {
    fail("codebase_index_persisted_path_invalid", repoRoot, path);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) fail("codebase_index_symlink_not_allowed", repoRoot, path);
  if (!stat.isFile()) fail("codebase_index_persisted_file_invalid", repoRoot, path);
  const canonical = realpathSync(path);
  if (!samePath(canonical, path)) {
    fail("codebase_index_symlink_not_allowed", repoRoot, path);
  }
}

export function persistedIndexPath(
  storageRoot: string,
  authority: CodebaseIndexAuthority,
  sdkContext?: SdkDetectionContext,
): string {
  const tenant = authority.tenantId.trim();
  const repository = authority.repositoryId.trim();
  if (!tenant || !repository || !storageRoot.trim()) {
    throw new CodebaseIndexSafetyError("codebase_index_persisted_authority_mismatch", {
      path: "codebase-index",
    });
  }
  return join(
    resolve(storageRoot),
    "codebase-index",
    `schema-${CODEBASE_INDEX_ENVELOPE_SCHEMA_VERSION}`,
    `extractor-${CODEBASE_INDEX_EXTRACTOR_VERSION}`,
    canonicalDigest(tenant),
    canonicalDigest(repository),
    canonicalDigest(canonicalSdkContext(sdkContext)),
    "index.json",
  );
}

function validateOwnedPath(
  repoRoot: string,
  path: string,
  options: MaterializeCodebaseIndexOptions,
  forWrite = false,
): string {
  const canonicalRoot = canonicalRepositoryRoot(repoRoot);
  const requestedStorageRoot = resolve(options.storageRoot);
  if (pathWithin(canonicalRoot, requestedStorageRoot)) {
    fail("codebase_index_persisted_path_invalid", canonicalRoot, requestedStorageRoot);
  }
  if (forWrite) mkdirSync(requestedStorageRoot, { recursive: true, mode: 0o700 });
  if (!existsSync(requestedStorageRoot)) {
    return persistedIndexPath(requestedStorageRoot, options.authority, options.sdkContext);
  }
  const storageStat = lstatSync(requestedStorageRoot);
  if (storageStat.isSymbolicLink()) {
    fail("codebase_index_symlink_not_allowed", canonicalRoot, requestedStorageRoot);
  }
  if (!storageStat.isDirectory()) {
    fail("codebase_index_persisted_path_invalid", canonicalRoot, requestedStorageRoot);
  }
  const storageRoot = realpathSync(requestedStorageRoot);
  if (!samePath(requestedStorageRoot, storageRoot)) {
    fail("codebase_index_symlink_not_allowed", canonicalRoot, requestedStorageRoot);
  }
  const expected = persistedIndexPath(storageRoot, options.authority, options.sdkContext);
  if (pathWithin(canonicalRoot, expected) || !samePath(path, expected)) {
    fail("codebase_index_persisted_path_invalid", canonicalRoot, path);
  }
  const parent = dirname(expected);
  assertOwnedDirectoryChain(canonicalRoot, storageRoot, parent, forWrite);
  if (existsSync(expected)) assertOwnedRegularFile(canonicalRoot, storageRoot, expected);
  return expected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 4_096 || value.includes("\0")) {
    return false;
  }
  const normalized = value.replace(/\\/g, "/");
  return !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split("/").some((part) => !part || part === "." || part === "..");
}

function validStringArray(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max &&
    value.every((item) => typeof item === "string" && item.length <= 16_384);
}

function validStringMap(value: unknown, maxKeys: number, maxValues: number): boolean {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= maxKeys &&
    entries.every(([key, items]) => key.length <= 4_096 && validStringArray(items, maxValues));
}

function validateIndexShape(
  value: unknown,
  canonicalRoot: string,
  limits: CodebaseIndexLimits,
): asserts value is CodebaseIndex {
  const invalid = (): never => fail("codebase_index_persisted_shape_invalid", canonicalRoot,
    defaultIndexPath(canonicalRoot));
  if (!isRecord(value)) invalid();
  const record = value as Record<string, unknown>;
  if (typeof record.repoRoot !== "string" || !samePath(record.repoRoot, canonicalRoot) ||
      typeof record.builtAt !== "string" || !Number.isFinite(Date.parse(record.builtAt))) invalid();
  const identity = record.repositoryIdentity;
  if (identity !== undefined &&
      (!isRecord(identity) ||
       identity.schemaVersion !== "mendpoint.codebase-index-repository-identity.v1" ||
       typeof identity.repositorySnapshotId !== "string" ||
       typeof identity.repositoryRevision !== "string" ||
       typeof identity.repositoryContentDigest !== "string" ||
       !Number.isSafeInteger(identity.filesInspected) || Number(identity.filesInspected) < 0 ||
       !Number.isSafeInteger(identity.bytesInspected) || Number(identity.bytesInspected) < 0)) invalid();
  const files = record.files;
  const structured = record.structuredFiles ?? [];
  const functions = record.functions;
  const usages = record.apiUsages;
  const skipped = record.skippedDirectories;
  if (!Array.isArray(files) || files.length > limits.maxFiles ||
      !Array.isArray(structured) || structured.length > limits.maxFiles ||
      !Array.isArray(functions) || functions.length > limits.maxFiles * 20 ||
      !Array.isArray(usages) || usages.length > limits.maxFiles * 40 ||
      !Array.isArray(skipped) || skipped.length > limits.maxFiles) invalid();
  const fileItems = files as unknown[];
  const structuredItems = structured as unknown[];
  const functionItems = functions as unknown[];
  const usageItems = usages as unknown[];
  const skippedItems = skipped as unknown[];
  if (!fileItems.every((file) => isRecord(file) && validRelativePath(file.path) &&
      typeof file.language === "string" && typeof file.isTest === "boolean" &&
      validStringArray(file.imports, 10_000) && typeof file.contentHash === "string" &&
      /^[a-f0-9]{16}$/.test(file.contentHash) && Number.isSafeInteger(file.lineCount))) invalid();
  if (!structuredItems.every((file) => isRecord(file) && validRelativePath(file.path) &&
      file.format === "json" && typeof file.isTest === "boolean" &&
      typeof file.contentHash === "string" && /^[a-f0-9]{16}$/.test(file.contentHash) &&
      Number.isSafeInteger(file.lineCount))) invalid();
  if (!functionItems.every((fn) => isRecord(fn) && typeof fn.name === "string" &&
      fn.name.length <= 4_096 && validRelativePath(fn.filePath) &&
      Number.isSafeInteger(fn.lineStart) && Number.isSafeInteger(fn.lineEnd) &&
      validStringArray(fn.callees, 100_000))) invalid();
  if (!usageItems.every((usage) => isRecord(usage) && validRelativePath(usage.filePath) &&
      Number.isSafeInteger(usage.line) && typeof usage.kind === "string" &&
      typeof usage.value === "string" && usage.value.length <= 65_536)) invalid();
  if (!skippedItems.every((item) => isRecord(item) && validRelativePath(item.path) &&
      typeof item.reason === "string" && item.reason.length <= 1_024)) invalid();
  if (!validStringMap(record.callersOf, limits.maxFiles * 20, limits.maxFiles * 20) ||
      !validStringMap(record.calleesOf, limits.maxFiles * 20, limits.maxFiles * 20) ||
      !validStringArray(record.packageImports, limits.maxFiles * 10)) invalid();
  const graph = record.callGraph;
  if (!isRecord(graph) || typeof graph.repoRoot !== "string" ||
      !samePath(graph.repoRoot, canonicalRoot) || !isRecord(graph.nodes) ||
      Object.keys(graph.nodes).length > limits.maxFiles * 20 || !Array.isArray(graph.edges) ||
      graph.edges.length > limits.maxFiles * 100 ||
      !validStringMap(graph.outEdges, limits.maxFiles * 20, limits.maxFiles * 100) ||
      !validStringMap(graph.inEdges, limits.maxFiles * 20, limits.maxFiles * 100) ||
      !validStringMap(graph.byName, limits.maxFiles * 20, limits.maxFiles * 20) ||
      !isRecord(graph.hierarchy) || !isRecord(graph.stats)) invalid();
}

function readOwnedPersisted(
  repoRoot: string,
  path: string,
  limits: CodebaseIndexLimits,
  options: MaterializeCodebaseIndexOptions,
): PersistedCodebaseIndexEnvelope {
  const safePath = validateOwnedPath(repoRoot, path, options);
  const stat = lstatSync(safePath);
  if (stat.isSymbolicLink()) fail("codebase_index_symlink_not_allowed", repoRoot, safePath);
  if (!stat.isFile()) fail("codebase_index_persisted_file_invalid", repoRoot, safePath);
  if (stat.size > MAX_PERSISTED_CODEBASE_INDEX_BYTES) {
    fail("codebase_index_persisted_file_bytes_limit", repoRoot, safePath,
      MAX_PERSISTED_CODEBASE_INDEX_BYTES, stat.size);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(safePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    fail("codebase_index_persisted_shape_invalid", repoRoot, safePath);
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== CODEBASE_INDEX_ENVELOPE_SCHEMA_VERSION) {
    fail("codebase_index_persisted_schema_unsupported", repoRoot, safePath);
  }
  if (!isRecord(parsed.extractor) || parsed.extractor.id !== "mendpoint-codebase-index" ||
      parsed.extractor.version !== CODEBASE_INDEX_EXTRACTOR_VERSION ||
      !isRecord(parsed.authority) || typeof parsed.indexContentDigest !== "string" ||
      !Number.isSafeInteger(parsed.generation) || Number(parsed.generation) < 1) {
    fail("codebase_index_persisted_shape_invalid", repoRoot, safePath);
  }
  validateIndexShape(parsed.index, canonicalRepositoryRoot(repoRoot), limits);
  if (canonicalDigest(parsed.index) !== parsed.indexContentDigest) {
    fail("codebase_index_persisted_digest_mismatch", repoRoot, safePath);
  }
  return parsed as unknown as PersistedCodebaseIndexEnvelope;
}

function fileState(
  repoRoot: string,
  path: string,
  options: MaterializeCodebaseIndexOptions,
): string {
  const safePath = validateOwnedPath(repoRoot, path, options, true);
  if (!existsSync(safePath)) return "missing";
  const stat = lstatSync(safePath);
  if (stat.size > MAX_PERSISTED_CODEBASE_INDEX_BYTES) {
    fail("codebase_index_persisted_file_bytes_limit", repoRoot, safePath,
      MAX_PERSISTED_CODEBASE_INDEX_BYTES, stat.size);
  }
  return createHash("sha256").update(readFileSync(safePath)).digest("hex");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

function acquireAuthorityLock(
  repoRoot: string,
  path: string,
  options: MaterializeCodebaseIndexOptions,
): () => void {
  const safePath = validateOwnedPath(repoRoot, path, options, true);
  const lockPath = `${safePath}.lock`;
  const nonce = randomBytes(16).toString("hex");
  const create = (): number => {
    try {
      return openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
      try {
        const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
          pid?: number;
          host?: string;
        };
        if (lock.host === hostname() && Number.isSafeInteger(lock.pid) &&
            lock.pid! > 0 && !processAlive(lock.pid!)) {
          unlinkSync(lockPath);
          return openSync(lockPath, "wx", 0o600);
        }
      } catch {
        // An unreadable or live lock is never removed speculatively.
      }
      fail("codebase_index_persisted_lock_conflict", repoRoot, lockPath);
    }
  };
  const fd = create();
  try {
    validateOwnedPath(repoRoot, safePath, options, true);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  const lockValue = JSON.stringify({ pid: process.pid, host: hostname(), nonce });
  writeFileSync(fd, lockValue, "utf8");
  fsyncSync(fd);
  closeSync(fd);
  return () => {
    try {
      validateOwnedPath(repoRoot, safePath, options);
      if (existsSync(lockPath) && readFileSync(lockPath, "utf8") === lockValue) {
        unlinkSync(lockPath);
      }
    } catch {
      // A redirected or replaced authority path is never followed during cleanup.
    }
  };
}

function publishIndex(
  index: CodebaseIndex,
  path: string,
  options: MaterializeCodebaseIndexOptions,
  authority: ReturnType<typeof persistedAuthority>,
  observedFileDigest: string,
  observedGeneration: number,
): PersistedCodebaseIndexEnvelope {
  const safePath = validateOwnedPath(authority.canonicalRepoRoot, path, options, true);
  validateIndexShape(index, authority.canonicalRepoRoot, normalizedLimits(options.limits));
  const envelope: PersistedCodebaseIndexEnvelope = {
    schemaVersion: CODEBASE_INDEX_ENVELOPE_SCHEMA_VERSION,
    extractor: { id: "mendpoint-codebase-index", version: CODEBASE_INDEX_EXTRACTOR_VERSION },
    authority,
    indexContentDigest: canonicalDigest(index),
    generation: observedGeneration + 1,
    index,
  };
  const temporary = join(dirname(safePath),
    `.${basename(safePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    validateOwnedPath(authority.canonicalRepoRoot, safePath, options, true);
    assertOwnedRegularFile(
      authority.canonicalRepoRoot, realpathSync(resolve(options.storageRoot)), temporary,
    );
    writeFileSync(fd, JSON.stringify(envelope, null, 2), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    options.persistenceHooks?.beforePublish?.({
      path: safePath,
      observedGeneration,
      nextGeneration: envelope.generation,
      observedFileDigest,
    });
    if (fileState(authority.canonicalRepoRoot, safePath, options) !== observedFileDigest) {
      fail("codebase_index_persisted_generation_conflict", authority.canonicalRepoRoot, safePath);
    }
    const publicationPath = validateOwnedPath(
      authority.canonicalRepoRoot, safePath, options, true,
    );
    assertOwnedRegularFile(
      authority.canonicalRepoRoot, realpathSync(resolve(options.storageRoot)), temporary,
    );
    renameSync(temporary, publicationPath);
    options.persistenceHooks?.afterPublish?.({
      path: safePath,
      committedGeneration: envelope.generation,
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      validateOwnedPath(authority.canonicalRepoRoot, safePath, options);
      if (existsSync(temporary)) {
        assertOwnedRegularFile(
          authority.canonicalRepoRoot, realpathSync(resolve(options.storageRoot)), temporary,
        );
        unlinkSync(temporary);
      }
    } catch {
      // Never clean up through a redirected authority component.
    }
  }
  return envelope;
}

/** Compatibility reader for the graph read path; validates envelopes and legacy indexes. */
export function loadIndex(path: string): CodebaseIndex {
  const repoRoot = dirname(dirname(path));
  const raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as unknown;
  const parsed = isRecord(raw) && "index" in raw ? raw.index : raw;
  validateIndexShape(parsed, canonicalRepositoryRoot(repoRoot), normalizedLimits());
  if (isRecord(raw) && "index" in raw &&
      (typeof raw.indexContentDigest !== "string" ||
       canonicalDigest(parsed) !== raw.indexContentDigest)) {
    fail("codebase_index_persisted_digest_mismatch", repoRoot, path);
  }
  return { ...(parsed as CodebaseIndex),
    structuredFiles: (parsed as CodebaseIndex).structuredFiles ?? [] };
}

export function materializeCodebaseIndex(
  repoRoot: string,
  options: MaterializeCodebaseIndexOptions,
): { index: CodebaseIndex; evidence: CodebaseIndexReuseEvidence } {
  const limits = normalizedLimits(options.limits);
  const authority = persistedAuthority(repoRoot, options.authority, options.sdkContext);
  const persist = options.persist !== false;
  if (!persist) {
    const index = buildIndexIncremental(authority.canonicalRepoRoot, null, {
      limits,
      sdkContext: canonicalSdkContext(options.sdkContext),
    });
    return {
      index,
      evidence: {
        schemaVersion: CODEBASE_INDEX_ENVELOPE_SCHEMA_VERSION,
        extractorVersion: CODEBASE_INDEX_EXTRACTOR_VERSION,
        classification: "rebuilt",
        tenantId: authority.tenantId,
        repositoryId: authority.repositoryId,
        canonicalRepoRootDigest: canonicalDigest(authority.canonicalRepoRoot),
        sdkContextDigest: authority.sdkContextDigest,
        indexContentDigest: canonicalDigest(index),
        generation: 0,
        rejectedReason: "persistence_disabled",
      },
    };
  }
  const requestedPath = persistedIndexPath(options.storageRoot, options.authority, options.sdkContext);
  const path = validateOwnedPath(authority.canonicalRepoRoot, requestedPath, options, true);
  for (let attempt = 0; attempt < 2; attempt++) {
    const release = acquireAuthorityLock(authority.canonicalRepoRoot, path, options);
    try {
      const observedFileDigest = fileState(authority.canonicalRepoRoot, path, options);
      let previous: CodebaseIndex | null = null;
      let previousDigest: string | undefined;
      let observedGeneration = 0;
      let rejectedReason: CodebaseIndexReuseEvidence["rejectedReason"] =
        observedFileDigest === "missing" ? "missing" : undefined;
      if (observedFileDigest !== "missing") {
        try {
          const envelope = readOwnedPersisted(authority.canonicalRepoRoot, path, limits, options);
          if (envelope.authority.tenantId !== authority.tenantId ||
              envelope.authority.repositoryId !== authority.repositoryId ||
              !samePath(envelope.authority.canonicalRepoRoot, authority.canonicalRepoRoot) ||
              envelope.authority.sdkContextDigest !== authority.sdkContextDigest) {
            throw new CodebaseIndexSafetyError("codebase_index_persisted_authority_mismatch", {
              path: relativePath(authority.canonicalRepoRoot, path),
            });
          }
          previous = envelope.index;
          previousDigest = envelope.indexContentDigest;
          observedGeneration = envelope.generation;
        } catch (error) {
          if (!(error instanceof CodebaseIndexSafetyError)) throw error;
          rejectedReason = error.code;
        }
      }
      const index = buildIndexIncremental(authority.canonicalRepoRoot, previous, {
        limits,
        sdkContext: canonicalSdkContext(options.sdkContext),
      });
      const classification: CodebaseIndexReuseClassification =
        previous && index === previous ? "exact" : previous ? "incremental" : "rebuilt";
      let committedGeneration = observedGeneration;
      let indexContentDigest = canonicalDigest(index);
      if (classification !== "exact") {
        const committed = publishIndex(
          index,
          path,
          options,
          authority,
          observedFileDigest,
          observedGeneration,
        );
        committedGeneration = committed.generation;
        indexContentDigest = committed.indexContentDigest;
      }
      return {
        index,
        evidence: {
          schemaVersion: CODEBASE_INDEX_ENVELOPE_SCHEMA_VERSION,
          extractorVersion: CODEBASE_INDEX_EXTRACTOR_VERSION,
          classification,
          tenantId: authority.tenantId,
          repositoryId: authority.repositoryId,
          canonicalRepoRootDigest: canonicalDigest(authority.canonicalRepoRoot),
          sdkContextDigest: authority.sdkContextDigest,
          indexContentDigest,
          generation: committedGeneration,
          ...(previousDigest ? { previousIndexContentDigest: previousDigest } : {}),
          ...(rejectedReason ? { rejectedReason } : {}),
        },
      };
    } catch (error) {
      if (!(error instanceof CodebaseIndexSafetyError) ||
          error.code !== "codebase_index_persisted_generation_conflict" || attempt === 1) {
        throw error;
      }
    } finally {
      release();
    }
  }
  throw new Error("codebase_index_materialization_unreachable");
}

/**
 * Incremental index update (reset-recompute for the call graph).
 * - Detect changed files via content hashes
 * - Reset-recompute only the affected call-graph region
 * - Refresh non-graph metadata once, reusing the incremental graph
 */
export function buildIndexIncremental(
  repoRoot: string,
  previous?: CodebaseIndex | null,
  opts: Omit<CodebaseIndexOptions, "callGraph"> = {},
): CodebaseIndex {
  if (!previous) return buildIndex(repoRoot, opts);

  // Hash probe without building a second full graph
  const limits = normalizedLimits(opts.limits);
  const discovery = discoverFiles(repoRoot, limits);
  const currentHashes = new Map<string, string>();
  for (const file of discovery.files) {
    currentHashes.set(file.rel, file.contentHash!);
  }
  const prevMap = new Map(
    [...previous.files, ...(previous.structuredFiles ?? [])].map((f) => [f.path, f.contentHash]),
  );
  const changedFiles = [...currentHashes.entries()]
    .filter(([path, hash]) => prevMap.get(path) !== hash)
    .map(([path]) => path);
  const deleted = [...previous.files, ...(previous.structuredFiles ?? [])]
    .filter((f) => !currentHashes.has(f.path))
    .map((f) => f.path);
  const allChanged = [...new Set([...changedFiles, ...deleted])];

  if (!allChanged.length &&
      previous.repositoryIdentity?.repositoryContentDigest ===
        discovery.identity.repositoryContentDigest) return previous;

  const changedCodeFiles = allChanged.filter(
    (path) => !STRUCTURED_EXTS.has(extname(path).toLowerCase()),
  );
  const callGraph = changedCodeFiles.length
    ? buildCallGraphIncremental(repoRoot, previous.callGraph, changedCodeFiles, {
        algorithm: "hybrid",
        strategy: "hybrid",
      })
    : previous.callGraph;

  // Single metadata pass, inject incremental graph (no second full graph build)
  return buildIndexFromDiscovered(
    repoRoot,
    { ...opts, callGraph },
    limits,
    discovery.files,
    discovery.skipped,
    discovery.identity,
    discovery.manifests,
  );
}


function deriveNameMaps(callGraph: CallGraph): {
  callersOf: Record<string, string[]>;
  calleesOf: Record<string, string[]>;
} {
  // Set accumulators keep adding an edge O(1); the previous per-edge
  // `[...new Set([...prev, next])]` was O(K), i.e. O(K^2) for a hot name.
  const callersSet: Record<string, Set<string>> = Object.create(null);
  const calleesSet: Record<string, Set<string>> = Object.create(null);
  for (const edge of callGraph.edges) {
    const caller = callGraph.nodes[edge.callerId];
    const callee = callGraph.nodes[edge.calleeId];
    if (!caller || !callee) continue;
    (calleesSet[caller.name] ??= new Set<string>()).add(callee.name);
    (callersSet[callee.name] ??= new Set<string>()).add(caller.name);
  }
  const callersOf: Record<string, string[]> = Object.create(null);
  const calleesOf: Record<string, string[]> = Object.create(null);
  for (const name in calleesSet) calleesOf[name] = [...calleesSet[name]!];
  for (const name in callersSet) callersOf[name] = [...callersSet[name]!];
  return { callersOf, calleesOf };
}



export function functionAt(
  index: CodebaseIndex,
  filePath: string,
  line: number,
): IndexedFunction | undefined {
  return index.functions.find(
    (f) => f.filePath === filePath && line >= f.lineStart && line <= f.lineEnd,
  );
}

export function getCallers(index: CodebaseIndex, functionName: string, hops = 1): string[] {
  // Prefer graph-based reverse reachability (qualified, depth-limited)
  if (index.callGraph) {
    const ids = index.callGraph.byName[functionName] ?? [];
    if (ids.length >= 1) {
      const names = new Set<string>();
      for (const id of ids) {
        for (const hit of reverseReachability(index.callGraph, id, { maxDepth: hops })) {
          names.add(hit.node.name);
        }
      }
      if (names.size) return [...names];
    }
  }
  const out = new Set<string>();
  let frontier = [functionName];
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const name of frontier) {
      for (const c of index.callersOf[name] ?? []) {
        if (!out.has(c)) {
          out.add(c);
          next.push(c);
        }
      }
    }
    frontier = next;
  }
  return [...out];
}

/** Re-export call-graph types for consumers of the index package. */
export type { CallGraph } from "@mendpoint/call-graph";



export function defaultIndexPath(repoRoot: string): string {
  return join(repoRoot, ".mendpoint", "codebase-index.json");
}

export function packageBoundary(filePath: string): string {
  const parts = filePath.split("/");
  if (parts[0] === "packages" && parts[1]) return `packages/${parts[1]}`;
  if (parts[0] === "apps" && parts[1]) return `apps/${parts[1]}`;
  if (parts[0] === "src") return "src";
  return dirname(filePath) === "." ? basename(filePath) : parts[0] ?? ".";
}
