/**
 * Answer-key-safe repository staging.
 *
 * WHY THIS EXISTS. Every corpus repository carries a human-readable grading key
 * INSIDE the repo (`EXPECTED.md`, `SYNTHETIC_REPO_NOTES.md`). The deterministic
 * runners never consult those files, so today's numbers are clean — but the
 * moment an LLM-enabled runner points a product at a corpus repo, the product
 * can read its own answer key off disk and every number after that is worthless.
 * The brief forbids editing the shared corpus, so the fix lives here: before a
 * repo is handed to any product, copy it into scratch with the grading keys
 * excluded, and hand the product the staged copy. `stage.test.ts` asserts that
 * no answer-key file survives into the staged tree.
 *
 * The staged tree is what the product SEES, so it mirrors what a source-tree
 * walk reads: dependency/VCS/cache directories are pruned with the SAME shared
 * decision the product's own walkers use (`classifyDependencyDirectory`), so the
 * staged tree never diverges from what the product would index, and staging a
 * huge repo does not copy `node_modules`/`.git`. Only the answer-key files are
 * removed beyond that; tracked source (including `vendor/`, generated trees, and
 * ordinary `README.md` / `CHANGELOG.md`) is preserved verbatim so scenarios that
 * depend on those files still grade correctly.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { classifyDependencyDirectory } from "@mendpoint/shared";

/**
 * Filename patterns that are grading keys, not repository content. Deliberately
 * narrow so it never strips a legitimate `README.md` / `CHANGELOG.md` / license:
 *   - `EXPECTED.md` (and `EXPECTED.<suffix>.md`)  — the per-repo Fettler/ReGauge key
 *   - `SYNTHETIC_REPO_NOTES.md` (and any `SYNTHETIC[-_]*NOTES.md`)
 *   - defensive future-proofing for keys named `GROUND_TRUTH*` / `ANSWER_KEY*`
 * These are matched on the BASENAME only.
 */
export const ANSWER_KEY_PATTERNS: readonly RegExp[] = [
  /^expected(\.[^/\\]*)?\.md$/i,
  /^synthetic[-_].*notes\.md$/i,
  /^ground[-_]?truth\b.*$/i,
  /^answer[-_]?key\b.*$/i,
];

/** True when a file BASENAME is a grading key that must never reach a product. */
export function isAnswerKeyFile(fileName: string): boolean {
  const base = basename(fileName);
  return ANSWER_KEY_PATTERNS.some((re) => re.test(base));
}

export interface StagedRepo {
  /** Absolute path to the staged copy the product should read from. */
  stagedPath: string;
  /** Repo-relative posix paths of answer-key files that were excluded. */
  excludedAnswerKeys: string[];
  /** Remove the staged tree. Safe to call more than once. */
  cleanup: () => void;
}

/** Recursively list every file under `dir` as posix paths relative to `dir`. */
export function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs).sort()) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(childAbs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) out.push(childRel);
    }
  };
  walk(dir, "");
  return out;
}

/**
 * Copy `repoPath` into a fresh scratch directory with grading keys and
 * dependency/VCS directories excluded, and return the staged path plus a
 * cleanup. The original repo is never modified.
 */
export function stageRepo(repoPath: string): StagedRepo {
  if (!existsSync(repoPath)) {
    throw new Error(`stageRepo: repo does not exist: ${repoPath}`);
  }
  const stagedPath = mkdtempSync(join(tmpdir(), "mendpoint-eval-stage-"));
  const excludedAnswerKeys: string[] = [];

  cpSync(repoPath, stagedPath, {
    recursive: true,
    dereference: false,
    force: true,
    errorOnExist: false,
    filter: (src): boolean => {
      // The destination root itself is passed once; always keep it.
      if (src === repoPath) return true;
      let st;
      try {
        st = statSync(src);
      } catch {
        return false;
      }
      if (st.isDirectory()) {
        // Prune the same directories the product's own walkers prune, using the
        // shared decision so the staged tree never diverges from what a product
        // indexes. venv detection needs a marker probe inside the directory.
        const decision = classifyDependencyDirectory(basename(src), (marker) =>
          existsSync(join(src, marker)),
        );
        return decision === null;
      }
      if (isAnswerKeyFile(src)) {
        // record repo-relative posix path
        const rel = src.slice(repoPath.length).replace(/^[/\\]+/, "").replace(/\\/g, "/");
        excludedAnswerKeys.push(rel);
        return false;
      }
      return true;
    },
  });

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      rmSync(stagedPath, { recursive: true, force: true });
    } catch {
      /* best effort — scratch dir, OS will reclaim */
    }
  };

  return { stagedPath, excludedAnswerKeys: excludedAnswerKeys.sort(), cleanup };
}
