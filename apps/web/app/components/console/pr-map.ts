import type { DiffHunk, DiffLine, Status } from "../ds/index.js";
import type { MigrationPr } from "../../../lib/api";

/**
 * Server-side mapping helpers shared by the `/prs` and `/prs/[id]` console
 * pages. They translate the live migration-PR API shape into the props the DS
 * components expect: lifecycle status, +/- patch stats, relative timestamps, and
 * a unified-diff parse into `DiffView` hunks.
 */

/** Shape of `MigrationPr.coverage` — the §11.7 / §12.4 analysis-coverage channel. */
export type PrCoverage = NonNullable<MigrationPr["coverage"]>;

/**
 * API PR status (draft|open|merged|closed|low_confidence) -> DS `Status`.
 *
 * `low_confidence` is set by the pipeline for ANY non-actionable result, so the
 * status alone cannot say whether the repo was cleanly analyzed (verified no
 * impact) or never analyzed (no basis for a conclusion). The `coverage` channel
 * is the discriminator, so it is threaded in here:
 *
 *  - `basis === "analyzed"`: full coverage, empty findings => VERIFIED CLEAN.
 *    A positive result — never the red "failing" pill. Mapped to `open`
 *    (emerald), the nearest positive lifecycle state. The DS `Status` vocabulary
 *    has no dedicated "verified clean" value, so the coverage card/badge carries
 *    the wording the pill cannot; see {@link coverageSummary}.
 *  - `partial` / `not_analyzed` / absent coverage: no (or only partial) basis
 *    for a no-impact conclusion. Genuinely weak => `pending` (amber,
 *    indeterminate). Never fabricated as a red failure, never dressed up as
 *    clean.
 *
 * The old `low_confidence -> failing` mapping collapsed both cases into the same
 * red state, which is the exact §11.7 bug this fixes. Coverage defaults to
 * unknown (not analyzed) when absent, so a missing channel never reads as clean.
 */
export function mapPrStatus(status: string, coverage?: PrCoverage | null): Status {
  switch (status) {
    case "draft":
      return "draft";
    case "merged":
      return "merged";
    case "closed":
      return "failing";
    case "low_confidence":
      return coverage?.basis === "analyzed" ? "open" : "pending";
    case "open":
    default:
      return "open";
  }
}

/** DS tone for a coverage state (maps onto `Badge` tones + card accents). */
export type CoverageTone = "emerald" | "amber" | "neutral";

/**
 * The distinct coverage states the console must keep apart. `clean` (analyzed +
 * empty) is a positive result; `no_known_impact` (partial) and `no_basis`
 * (not_analyzed) are weak; `unknown` is absent coverage; `covered` is an
 * actionable PR whose analysis had full coverage.
 */
export type CoverageState =
  | "clean"
  | "no_known_impact"
  | "no_basis"
  | "unknown"
  | "covered";

/** A rendered view-model for the coverage card (`/prs/[id]`) and list badge (`/prs`). */
export type CoverageSummary = {
  state: CoverageState;
  tone: CoverageTone;
  /** Short label for the list-card badge. */
  badge: string;
  /** Headline for the detail card. */
  headline: string;
  /** Body sentence(s) for the detail card. */
  detail: string;
  /** "N of M files inspected" when the counts are known, else null. */
  files: string | null;
  /** Typed coverage gaps rendered as reason + detail (for `partial`). */
  gaps: Array<{ reason: string; detail: string }>;
};

/** Human labels for the typed {@link PrCoverage} gap reasons (shared/src CoverageGapReason). */
const COVERAGE_GAP_REASON_LABEL: Record<string, string> = {
  unsupported_language: "Unsupported language",
  skipped_directory: "Skipped directory",
  file_cap: "File-count cap reached",
  byte_cap: "Byte cap reached",
  query_truncated: "Graph query truncated",
};

function coverageFilesLine(coverage: PrCoverage): string | null {
  const { filesInspected, filesInScope } = coverage;
  if (filesInspected === undefined) return null;
  if (filesInScope === undefined) {
    return `${filesInspected} file${filesInspected === 1 ? "" : "s"} inspected`;
  }
  return `${filesInspected} of ${filesInScope} files inspected`;
}

function coverageGaps(coverage: PrCoverage): Array<{ reason: string; detail: string }> {
  return (coverage.gaps ?? []).map((gap) => ({
    reason: COVERAGE_GAP_REASON_LABEL[gap.reason] ?? gap.reason,
    detail: gap.detail,
  }));
}

/**
 * Build the coverage view-model from the raw PR status and coverage channel.
 *
 * `status === "low_confidence"` is the pipeline's signal that the result was
 * non-actionable (empty findings); combined with `coverage.basis` it yields the
 * three states §11.7 requires be kept apart. Absent coverage is `unknown`, never
 * defaulted to `analyzed` — the fail-open default is precisely the bug being
 * fixed.
 */
export function coverageSummary(
  status: string,
  coverage?: PrCoverage | null,
): CoverageSummary {
  const empty = status === "low_confidence";

  if (!coverage) {
    return {
      state: "unknown",
      tone: "neutral",
      badge: "coverage unknown",
      headline: "Coverage not recorded",
      detail:
        "This pull request predates impact-coverage tracking, so we cannot tell whether an empty result means no impact or code that was never analyzed. Treat it as unverified.",
      files: null,
      gaps: [],
    };
  }

  const files = coverageFilesLine(coverage);
  const reason = coverage.reason ? `${coverage.reason} ` : "";

  switch (coverage.basis) {
    case "analyzed":
      return empty
        ? {
            state: "clean",
            tone: "emerald",
            badge: "no impact",
            headline: "No impact — verified",
            detail:
              "Fettler analyzed the code in scope with full coverage and found nothing affected. This is complete evidence of no impact, not merely an empty result.",
            files,
            gaps: [],
          }
        : {
            state: "covered",
            tone: "emerald",
            badge: "full coverage",
            headline: "Analyzed with full coverage",
            detail:
              "The repository was analyzed with full coverage, so the impacted sites below are the complete set — nothing in scope was left unexamined.",
            files,
            gaps: [],
          };
    case "partial":
      return {
        state: "no_known_impact",
        tone: "amber",
        badge: "partial coverage",
        headline: empty ? "No known impact — partial coverage" : "Partial coverage",
        detail: `${reason}Some code in scope was not analyzed, so this is no KNOWN impact rather than verified clean: there may be impact in code Fettler could not see.`,
        files,
        gaps: coverageGaps(coverage),
      };
    case "not_analyzed":
      return {
        state: "no_basis",
        tone: "amber",
        badge: "not analyzed",
        headline: "Not analyzed — no basis",
        detail: `${reason}No analysis ran against real code, so an empty result carries no information at all. This is not a clean result.`,
        files,
        gaps: coverageGaps(coverage),
      };
    default:
      // An unrecognized basis is treated as unknown, never as analyzed/clean.
      return {
        state: "unknown",
        tone: "neutral",
        badge: "coverage unknown",
        headline: "Coverage not recognized",
        detail:
          "The analysis reported a coverage basis this console does not recognize. Treat it as unverified rather than assuming no impact.",
        files,
        gaps: coverageGaps(coverage),
      };
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
