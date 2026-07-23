/**
 * Apply repair actions to a working tree (in-memory then write, or dry-run).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
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

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathBlocked(path: string, neverTouch: string[]): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  return neverTouch.some((r) => p.includes(r.toLowerCase()));
}

function walkCodeFiles(root: string, out: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    if (name === "node_modules" || name === ".git" || name === "dist" || name === ".next") {
      continue;
    }
    const p = join(root, name);
    const st = statSync(p);
    if (st.isDirectory()) walkCodeFiles(p, out);
    else {
      const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";
      if (CODE_EXTS.has(ext)) out.push(p);
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

export type ApplyOptions = {
  repoRoot: string;
  dryRun?: boolean;
  neverTouchPaths?: string[];
};

export function applyActions(
  actions: RepairAction[],
  opts: ApplyOptions,
): AppliedEdit[] {
  const neverTouch = opts.neverTouchPaths ?? [
    ".env",
    "secrets/",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
  ];
  const edits: AppliedEdit[] = [];
  const fileCache = new Map<string, string>();

  const read = (rel: string) => {
    if (fileCache.has(rel)) return fileCache.get(rel)!;
    const abs = join(opts.repoRoot, rel);
    if (!existsSync(abs)) return null;
    const t = readFileSync(abs, "utf8");
    fileCache.set(rel, t);
    return t;
  };

  const write = (rel: string, content: string, reason: string) => {
    const original = fileCache.get(rel) ?? read(rel) ?? "";
    if (original === content) return;
    fileCache.set(rel, content);
    edits.push({ filePath: rel, original, updated: content, reason });
    if (!opts.dryRun) {
      const abs = join(opts.repoRoot, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    }
  };

  for (const action of actions) {
    if (action.type === "replace_in_file") {
      const targets: string[] =
        action.filePath === "*"
          ? walkCodeFiles(opts.repoRoot).map((abs) =>
              relative(opts.repoRoot, abs).replace(/\\/g, "/"),
            )
          : [action.filePath.replace(/\\/g, "/")];

      for (const rel of targets) {
        if (pathBlocked(rel, neverTouch)) continue;
        const content = read(rel);
        if (content === null) continue;
        const updated = applyReplace(content, action.from, action.to, action.global ?? true);
        if (updated !== content) write(rel, updated, action.reason);
      }
    } else if (action.type === "write_file") {
      if (pathBlocked(action.filePath, neverTouch)) continue;
      write(action.filePath, action.content, action.reason);
    } else if (action.type === "patch_line") {
      if (pathBlocked(action.filePath, neverTouch)) continue;
      const content = read(action.filePath);
      if (content === null) continue;
      const lines = content.split(/\r?\n/);
      const idx = action.line - 1;
      if (idx < 0 || idx >= lines.length) continue;
      lines[idx] = action.newLine;
      write(action.filePath, lines.join("\n"), action.reason);
    } else if (action.type === "remove_fixme") {
      if (pathBlocked(action.filePath, neverTouch)) continue;
      const content = read(action.filePath);
      if (content === null) continue;
      const updated = content
        .split(/\r?\n/)
        .filter((l) => !/FIXME\(mendpoint\)/.test(l))
        .join("\n");
      if (updated !== content) write(action.filePath, updated, action.reason);
    }
  }

  return edits;
}

export function listCodeFilesWithContent(
  repoRoot: string,
  maxFiles = 80,
): Array<{ path: string; content: string }> {
  const abs = walkCodeFiles(repoRoot).slice(0, maxFiles);
  return abs.map((a) => ({
    path: relative(repoRoot, a).replace(/\\/g, "/"),
    content: readFileSync(a, "utf8"),
  }));
}
