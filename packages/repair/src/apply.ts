/**
 * Stage and apply repair actions inside a canonical repository boundary.
 */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AppliedEdit, RepairAction } from "./types.js";

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

const HARD_MAX_ACTIONS = 30;
const HARD_MAX_FILES = 50;

export type PristineFile = {
  filePath: string;
  absolutePath: string;
  existed: boolean;
  content: string;
};

export class RepairPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepairPolicyError";
  }
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathBlocked(path: string, neverTouch: string[]): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return neverTouch.some((rule) => normalized.includes(rule.replace(/\\/g, "/").toLowerCase()));
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function canonicalRoot(repoRoot: string): string {
  const root = realpathSync(resolve(repoRoot));
  if (!lstatSync(root).isDirectory()) {
    throw new RepairPolicyError("Repair repository root must be a directory");
  }
  return root;
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function containedPath(
  root: string,
  requestedPath: string,
  opts: { allowMissing?: boolean; allowTargetSymlink?: boolean } = {},
): { relativePath: string; absolutePath: string } {
  const normalized = requestedPath.replace(/\\/g, "/");
  if (
    !normalized ||
    normalized === "." ||
    normalized.includes("\0") ||
    isAbsolute(requestedPath)
  ) {
    throw new RepairPolicyError(`Repair path is not a relative file path: ${requestedPath}`);
  }

  const absolutePath = resolve(root, requestedPath);
  if (!isWithin(root, absolutePath) || absolutePath === root) {
    throw new RepairPolicyError(`Repair path escapes repository root: ${requestedPath}`);
  }

  const relativePath = relative(root, absolutePath).replace(/\\/g, "/");
  const segments = relative(root, absolutePath).split(/[\\/]+/).filter(Boolean);
  let cursor = root;
  for (let index = 0; index < segments.length; index++) {
    cursor = join(cursor, segments[index]!);
    const stat = lstatIfPresent(cursor);
    if (!stat) {
      if (!opts.allowMissing && index === segments.length - 1) {
        throw new RepairPolicyError(`Repair path does not exist: ${relativePath}`);
      }
      continue;
    }
    const target = index === segments.length - 1;
    if (stat.isSymbolicLink() && !(target && opts.allowTargetSymlink)) {
      throw new RepairPolicyError(`Repair path contains a symbolic link: ${relativePath}`);
    }
  }

  const targetStat = lstatIfPresent(absolutePath);
  if (targetStat && !targetStat.isSymbolicLink()) {
    const canonical = realpathSync(absolutePath);
    if (!isWithin(root, canonical)) {
      throw new RepairPolicyError(`Repair path resolves outside repository root: ${relativePath}`);
    }
  }
  return { relativePath, absolutePath };
}

function walkCodeFiles(root: string, current = root, out: string[] = []): string[] {
  for (const name of readdirSync(current)) {
    if (name === "node_modules" || name === ".git" || name === "dist" || name === ".next") {
      continue;
    }
    const path = join(current, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new RepairPolicyError(
        `Repair repository contains a symbolic link: ${relative(root, path).replace(/\\/g, "/")}`,
      );
    }
    if (stat.isDirectory()) {
      walkCodeFiles(root, path, out);
    } else {
      const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";
      if (CODE_EXTS.has(ext)) out.push(path);
    }
  }
  return out;
}

function applyReplace(content: string, from: string, to: string, global = true): string {
  const re = new RegExp(`\\b${escapeReg(from)}\\b`, global ? "g" : "");
  let out = content.replace(re, to);
  out = out.replace(new RegExp(`(['"\`])${escapeReg(from)}\\1\\s*:`, "g"), `$1${to}$1:`);
  out = out.replace(new RegExp(`\\b${escapeReg(from)}\\s*=`, "g"), `${to}=`);
  return out;
}

function boundedInteger(value: number | undefined, fallback: number, hardMax: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value!), hardMax));
}

export type ApplyOptions = {
  repoRoot: string;
  dryRun?: boolean;
  neverTouchPaths?: string[];
  maxActions?: number;
  maxFilesChanged?: number;
  /** Shared across attempts so every edit retains the session's pristine original. */
  pristineFiles?: Map<string, PristineFile>;
};

export function applyActions(
  actions: RepairAction[],
  opts: ApplyOptions,
): AppliedEdit[] {
  const root = canonicalRoot(opts.repoRoot);
  const neverTouch = opts.neverTouchPaths ?? [
    ".env",
    "secrets/",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
  ];
  const actionBudget = boundedInteger(opts.maxActions, HARD_MAX_ACTIONS, HARD_MAX_ACTIONS);
  const fileBudget = boundedInteger(opts.maxFilesChanged, 20, HARD_MAX_FILES);
  if (actions.length > actionBudget) {
    throw new RepairPolicyError(
      `Repair action budget exceeded: ${actions.length}/${actionBudget}`,
    );
  }

  const pristineFiles = opts.pristineFiles ?? new Map<string, PristineFile>();
  const fileCache = new Map<string, string>();
  const staged = new Map<string, { content: string; reasons: string[] }>();

  const read = (requestedPath: string): string | null => {
    const safe = containedPath(root, requestedPath, { allowMissing: true });
    if (fileCache.has(safe.relativePath)) return fileCache.get(safe.relativePath)!;
    const stat = lstatIfPresent(safe.absolutePath);
    if (!stat) return null;
    if (!stat.isFile()) {
      throw new RepairPolicyError(`Repair path is not a regular file: ${safe.relativePath}`);
    }
    const content = readFileSync(safe.absolutePath, "utf8");
    fileCache.set(safe.relativePath, content);
    return content;
  };

  const stage = (requestedPath: string, content: string, reason: string) => {
    const safe = containedPath(root, requestedPath, { allowMissing: true });
    if (pathBlocked(safe.relativePath, neverTouch)) {
      throw new RepairPolicyError(`Repair path is blocked by policy: ${safe.relativePath}`);
    }
    const current = fileCache.get(safe.relativePath) ?? read(safe.relativePath) ?? "";
    if (current === content) return;
    if (!pristineFiles.has(safe.relativePath)) {
      const stat = lstatIfPresent(safe.absolutePath);
      pristineFiles.set(safe.relativePath, {
        filePath: safe.relativePath,
        absolutePath: safe.absolutePath,
        existed: Boolean(stat),
        content: stat?.isFile() ? readFileSync(safe.absolutePath, "utf8") : "",
      });
    }
    fileCache.set(safe.relativePath, content);
    const previous = staged.get(safe.relativePath);
    staged.set(safe.relativePath, {
      content,
      reasons: [...(previous?.reasons ?? []), reason],
    });
    if (pristineFiles.size > fileBudget) {
      throw new RepairPolicyError(
        `Repair file budget exceeded: ${pristineFiles.size}/${fileBudget}`,
      );
    }
  };

  for (const action of actions) {
    if (action.type === "replace_in_file") {
      const targets =
        action.filePath === "*"
          ? walkCodeFiles(root).map((absolutePath) =>
              relative(root, absolutePath).replace(/\\/g, "/"),
            )
          : [containedPath(root, action.filePath, { allowMissing: true }).relativePath];
      for (const target of targets) {
        if (pathBlocked(target, neverTouch)) continue;
        const content = read(target);
        if (content === null) continue;
        const updated = applyReplace(content, action.from, action.to, action.global ?? true);
        if (updated !== content) stage(target, updated, action.reason);
      }
    } else if (action.type === "write_file") {
      stage(action.filePath, action.content, action.reason);
    } else if (action.type === "patch_line") {
      const content = read(action.filePath);
      if (content === null) continue;
      const lines = content.split(/\r?\n/);
      const index = action.line - 1;
      if (index < 0 || index >= lines.length) continue;
      lines[index] = action.newLine;
      stage(action.filePath, lines.join("\n"), action.reason);
    } else if (action.type === "remove_fixme") {
      const content = read(action.filePath);
      if (content === null) continue;
      const updated = content
        .split(/\r?\n/)
        .filter((line) => !/FIXME\(mendpoint\)/.test(line))
        .join("\n");
      if (updated !== content) stage(action.filePath, updated, action.reason);
    }
  }

  const edits: AppliedEdit[] = [];
  for (const [filePath, change] of staged) {
    const pristine = pristineFiles.get(filePath)!;
    const safe = containedPath(root, filePath, { allowMissing: true });
    if (!opts.dryRun) {
      mkdirSync(dirname(safe.absolutePath), { recursive: true });
      writeFileSync(safe.absolutePath, change.content, "utf8");
    }
    edits.push({
      filePath,
      original: pristine.content,
      updated: change.content,
      reason: [...new Set(change.reasons)].join("; "),
      existed: pristine.existed,
    });
  }
  return edits;
}

export function rollbackPristineFiles(
  repoRoot: string,
  pristineFiles: Map<string, PristineFile>,
): void {
  const root = canonicalRoot(repoRoot);
  const files = [...pristineFiles.values()].sort(
    (left, right) => right.filePath.length - left.filePath.length,
  );
  for (const pristine of files) {
    const safe = containedPath(root, pristine.filePath, {
      allowMissing: true,
      allowTargetSymlink: true,
    });
    const currentStat = lstatIfPresent(safe.absolutePath);
    if (currentStat?.isSymbolicLink()) {
      rmSync(safe.absolutePath, { force: true });
    }
    if (pristine.existed) {
      mkdirSync(dirname(safe.absolutePath), { recursive: true });
      writeFileSync(safe.absolutePath, pristine.content, "utf8");
    } else if (lstatIfPresent(safe.absolutePath)) {
      rmSync(safe.absolutePath, { force: true });
    }
  }
}

export function listCodeFilesWithContent(
  repoRoot: string,
  maxFiles = 80,
): Array<{ path: string; content: string }> {
  const root = canonicalRoot(repoRoot);
  const limit = boundedInteger(maxFiles, 80, 500);
  return walkCodeFiles(root)
    .slice(0, limit)
    .map((absolutePath) => {
      const safe = containedPath(root, relative(root, absolutePath));
      return {
        path: safe.relativePath,
        content: readFileSync(safe.absolutePath, "utf8"),
      };
    });
}
