/**
 * The single source of truth for which directories a source-tree walk prunes.
 *
 * Three walkers each grew their own copy of this decision and drifted:
 *   - @mendpoint/codebase-index (indexing)
 *   - @mendpoint/call-graph (graph construction)
 *   - @mendpoint/agent (Warden candidate/workspace scans)
 * Two of those copies shipped bugs found separately (a Python virtualenv indexed
 * whole; a call graph built over ~20k dependency nodes). Consolidated here so the
 * next walker inherits the fix instead of rediscovering it.
 *
 * Each walker still formats its own skip-reason string and keeps its own
 * recording; only the list and the marker-based decision live here. Filesystem
 * access is injected by the caller (see `classifyDependencyDirectory`) so this
 * module stays free of node built-ins and remains safe to bundle in the web app.
 */

/**
 * Directory names that are unambiguously dependency trees, build/tool caches, or
 * VCS metadata across ecosystems — never hand-written source, safe to prune by
 * name in a source walk.
 *
 * Deliberately EXCLUDES the ambiguous `vendor` / `build` / `target` / `out` /
 * `bin` / `obj`: those are frequently *tracked* source (committed Go vendoring,
 * generated-but-checked-in code), so pruning them by name alone would drop real
 * files — the eval suite tracks a real file under `vendor/`. A walker that must
 * also prune generated build outputs from an *untracked* workspace (the agent's
 * candidate scan) layers those names on top of this set behind its own
 * tracked-source guard, never here.
 */
export const DEPENDENCY_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  ".next",
  ".turbo",
  "coverage",
  ".venv",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "site-packages",
  ".gradle",
]);

/** Marker file identifying a Python virtualenv regardless of its directory name. */
export const PYTHON_VIRTUALENV_MARKER = "pyvenv.cfg";

/**
 * Why a directory was pruned. Structured (not a formatted string) so each walker
 * can render the exact skip label its own callers and tests expect while sharing
 * this one decision.
 */
export type DependencyDirectoryDecision =
  | { kind: "ignored_name"; name: string }
  | { kind: "python_virtualenv"; marker: typeof PYTHON_VIRTUALENV_MARKER };

/**
 * Decide whether a directory should be pruned from a source walk, preferring a
 * structural marker (`pyvenv.cfg`) over a bare name so a source module merely
 * named `venv` / `env` is never dropped. Returns the decision, or null to descend.
 *
 * `markerExists(marker)` is the caller-supplied probe for a marker file inside the
 * directory (e.g. `(m) => existsSync(join(absPath, m))`). It is injected rather
 * than performed here so this module carries no `node:fs` dependency and stays
 * bundler-safe; it is only consulted for the ambiguous `venv` / `env` / `.venv*`
 * names, never for a name that is already an unambiguous dependency directory.
 */
export function classifyDependencyDirectory(
  name: string,
  markerExists: (marker: string) => boolean,
): DependencyDirectoryDecision | null {
  if (DEPENDENCY_DIRECTORIES.has(name)) {
    return { kind: "ignored_name", name };
  }
  if (
    (name === "venv" || name === "env" || name.startsWith(".venv")) &&
    markerExists(PYTHON_VIRTUALENV_MARKER)
  ) {
    return { kind: "python_virtualenv", marker: PYTHON_VIRTUALENV_MARKER };
  }
  return null;
}
