/**
 * Generated-file detection.
 *
 * Generated output must never be an edit target: a hand-edit is overwritten the
 * next time the customer regenerates from the spec. We detect it by *signal* —
 * an AUTO-GENERATED / DO NOT EDIT / @generated header, or membership in an
 * openapi-generator FILES manifest — never by a path containing "generated",
 * which both misses generated files stored elsewhere and wrongly flags
 * hand-written files that merely live under a `generated/` directory.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodebaseIndex } from "@mendpoint/codebase-index";

/** Header markers that codegen tools stamp on their output. */
const GENERATED_MARKER = /auto[-\s]?generated|do not edit|@generated|openapi-generator/i;

/** Only the top of a file is a header; scanning further risks false positives. */
const HEADER_SCAN_LINES = 20;

/** Files listed in a `.openapi-generator/FILES` manifest, repo-relative. */
function openApiGeneratorManifest(repoRoot: string): Set<string> {
  const out = new Set<string>();
  try {
    const raw = readFileSync(join(repoRoot, ".openapi-generator", "FILES"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const p = line.trim();
      if (p && !p.startsWith("#")) out.add(p.replace(/\\/g, "/"));
    }
  } catch {
    /* no manifest */
  }
  return out;
}

/**
 * Whether a single file is generated. Keys on the manifest and the file's own
 * header — never on the path. `manifest` is passed in so callers scanning a
 * whole repo read the manifest once.
 */
export function isGeneratedFile(
  repoRoot: string,
  filePath: string,
  manifest: Set<string>,
): boolean {
  if (manifest.has(filePath.replace(/\\/g, "/"))) return true;
  try {
    const text = readFileSync(join(repoRoot, filePath), "utf8");
    const header = text.split(/\r?\n/).slice(0, HEADER_SCAN_LINES).join("\n");
    return GENERATED_MARKER.test(header);
  } catch {
    return false;
  }
}

/** The set of generated file paths in a codebase index. */
export function detectGeneratedFiles(index: CodebaseIndex): Set<string> {
  const manifest = openApiGeneratorManifest(index.repoRoot);
  const out = new Set<string>();
  for (const f of index.files) {
    if (isGeneratedFile(index.repoRoot, f.path, manifest)) out.add(f.path);
  }
  return out;
}
