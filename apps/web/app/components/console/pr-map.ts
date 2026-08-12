import type { DiffHunk, DiffLine, Status } from "../ds/index.js";

/**
 * Server-side mapping helpers shared by the `/prs` and `/prs/[id]` console
 * pages. They translate the live migration-PR API shape into the props the DS
 * components expect: lifecycle status, +/- patch stats, relative timestamps, and
 * a unified-diff parse into `DiffView` hunks.
 */

/** API PR status (draft|open|merged|closed|low_confidence) -> DS `Status`. */
export function mapPrStatus(status: string): Status {
  switch (status) {
    case "draft":
      return "draft";
    case "merged":
      return "merged";
    case "closed":
    case "low_confidence":
      return "failing";
    case "open":
    default:
      return "open";
  }
}

/** Count +/- lines and touched files in a unified patch. */
export function patchStats(patch: string): {
  additions: number;
  deletions: number;
  files: number;
} {
  if (!patch) return { additions: 0, deletions: 0, files: 0 };
  let additions = 0;
  let deletions = 0;
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      // File header (present in both git and plain unified diffs); the sole
      // signal we count files from, so a git "diff --git" line above it does not
      // double-count.
      files.add(line.slice(4).replace(/^b\//, "").trim());
    } else if (line.startsWith("---")) {
      // old-file header, not a deletion
    } else if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions, files: files.size };
}

/** ISO timestamp -> compact "4m ago" / "3h ago" / "2d ago" label. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export type ParsedFile = {
  path: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
};

/** Parse a git unified diff into per-file `DiffView` hunks with line numbers. */
export function parseUnifiedDiff(patch: string): ParsedFile[] {
  if (!patch) return [];
  const files: ParsedFile[] = [];
  let current: ParsedFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const pushHunk = () => {
    if (current && hunk && hunk.lines.length > 0) current.hunks.push(hunk);
    hunk = null;
  };
  const pushFile = () => {
    pushHunk();
    if (current && (current.hunks.length > 0 || current.path)) files.push(current);
    current = null;
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git")) {
      pushFile();
      const match = line.match(/ b\/(\S+)\s*$/);
      current = { path: match?.[1] ?? "", hunks: [], additions: 0, deletions: 0 };
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "").trim();
      if (!current) current = { path, hunks: [], additions: 0, deletions: 0 };
      else if (!current.path) current.path = path;
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file")) {
      continue;
    }
    const header = line.match(HUNK_HEADER);
    if (header) {
      pushHunk();
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      if (!current) current = { path: "", hunks: [], additions: 0, deletions: 0 };
      hunk = { header: line.trim(), lines: [] };
      continue;
    }
    if (!current || !hunk) continue;
    if (line.startsWith("+")) {
      const entry: DiffLine = { type: "add", line: newLine, text: line.slice(1) };
      hunk.lines.push(entry);
      current.additions += 1;
      newLine += 1;
    } else if (line.startsWith("-")) {
      const entry: DiffLine = { type: "del", line: oldLine, text: line.slice(1) };
      hunk.lines.push(entry);
      current.deletions += 1;
      oldLine += 1;
    } else {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      hunk.lines.push({ type: "ctx", line: newLine, text });
      oldLine += 1;
      newLine += 1;
    }
  }
  pushFile();
  return files;
}
