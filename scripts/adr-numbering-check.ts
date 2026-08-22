/**
 * ADR numbering check — npm run adr:check
 *
 * Guards the one failure mode sequential ADR numbering keeps producing under
 * parallel authorship (docs/adr/README.md, three collisions in one week —
 * 0004, 0009, 0011):
 *
 *   Every agent correctly reads "the next free number is N", but two reading at
 *   once get the same N. The number is derived from shared repository state, so
 *   the check "pick max + 1" is a race two authors can both win. Because a
 *   sequential collision produces two *different* filenames that share a number
 *   (`0009-a.md`, `0009-b.md`), git keeps both and one silently loses every
 *   cross-reference that points at "ADR-0009".
 *
 * The fix is a scheme change for NEW ADRs, enforced here:
 *
 *   New ADRs are named  YYYY-MM-DD-short-kebab-title.md.  The identifier is the
 *   whole filename — derived from the author's own date and title, not from a
 *   scan of siblings — so two authors never read the same counter. A genuine
 *   collision would be two identical paths, which git cannot represent: the
 *   second author gets a path conflict and must resolve it, rather than a silent
 *   overwrite. Collisions become structurally impossible to merge silently.
 *
 * The pre-existing sequential range 0000–0013 is grandfathered and never
 * renumbered (its numbers are referenced from code comments, PR bodies, and
 * tasks/todo.md). The line between "tolerated legacy" and "enforced convention"
 * is a single documented boundary constant, LAST_SEQUENTIAL_ADR, not a list of
 * known violations: any sequential ADR at or below it is allowed to remain, and
 * any new sequential number is rejected — that is what closes the racing scheme
 * and forces the dated one.
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Highest four-digit sequential ADR that predates the dated scheme. The
 * sequential space is closed at this number: existing 0000–0013 are tolerated,
 * any higher four-digit ADR is rejected so the racing "max + 1" scheme cannot
 * be extended. Bumping this constant would deliberately re-open the race and
 * must not be done to admit a new ADR — new ADRs use the dated scheme.
 */
export const LAST_SEQUENTIAL_ADR = 13;

/** Files in docs/adr/ that are not themselves ADRs. */
const NON_ADR_FILES: ReadonlySet<string> = new Set(["README.md"]);

/** Legacy scheme: NNNN-short-kebab-title.md (0000-template.md included). */
const SEQUENTIAL_NAME = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/** New scheme: YYYY-MM-DD-short-kebab-title.md. Tested before the legacy form. */
const DATED_NAME = /^(\d{4})-(\d{2})-(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

export type AdrScheme = "sequential" | "dated";

export type AdrEntry = Readonly<{
  file: string;
  scheme: AdrScheme;
  /** The collision key: the four-digit number for legacy, the full base name for dated. */
  identifier: string;
}>;

export type AdrViolation = Readonly<{
  file: string;
  reason: string;
}>;

export type AdrScanReport = Readonly<{
  entries: readonly AdrEntry[];
  violations: readonly AdrViolation[];
}>;

/** True only for a real calendar date (rejects 2026-13-01, 2026-02-30, ...). */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Classify one ADR filename. Returns the entry when it is well-formed, or a
 * violation when it is not. `README.md` and other non-ADR files must be
 * filtered out before calling this.
 */
export function classifyAdrFile(file: string): AdrEntry | AdrViolation {
  const dated = DATED_NAME.exec(file);
  if (dated) {
    const [year, month, day] = [Number(dated[1]), Number(dated[2]), Number(dated[3])];
    if (!isRealDate(year, month, day)) {
      return { file, reason: `dated ADR carries an invalid calendar date (${dated[1]}-${dated[2]}-${dated[3]})` };
    }
    return { file, scheme: "dated", identifier: file.replace(/\.md$/, "") };
  }

  const sequential = SEQUENTIAL_NAME.exec(file);
  if (sequential) {
    const number = Number(sequential[1]);
    if (number > LAST_SEQUENTIAL_ADR) {
      return {
        file,
        reason:
          `sequential number ${sequential[1]} extends the closed range (last is ` +
          `${String(LAST_SEQUENTIAL_ADR).padStart(4, "0")}); new ADRs use the dated ` +
          `scheme YYYY-MM-DD-short-kebab-title.md`,
      };
    }
    return { file, scheme: "sequential", identifier: sequential[1] };
  }

  return {
    file,
    reason:
      "filename matches neither the dated scheme (YYYY-MM-DD-short-kebab-title.md) " +
      "nor the grandfathered sequential scheme (NNNN-short-kebab-title.md)",
  };
}

function isViolation(result: AdrEntry | AdrViolation): result is AdrViolation {
  return "reason" in result;
}

/** Classify a set of ADR filenames and detect any two that claim one identifier. */
export function scanAdrFiles(files: readonly string[]): AdrScanReport {
  const entries: AdrEntry[] = [];
  const violations: AdrViolation[] = [];

  for (const file of files) {
    if (NON_ADR_FILES.has(file)) continue;
    const result = classifyAdrFile(file);
    if (isViolation(result)) violations.push(result);
    else entries.push(result);
  }

  const byIdentifier = new Map<string, AdrEntry[]>();
  for (const entry of entries) {
    const group = byIdentifier.get(entry.identifier) ?? [];
    group.push(entry);
    byIdentifier.set(entry.identifier, group);
  }
  for (const [identifier, group] of byIdentifier) {
    if (group.length < 2) continue;
    const coll = group.map((entry) => entry.file).sort();
    for (const file of coll) {
      violations.push({
        file,
        reason: `identifier "${identifier}" is claimed by ${group.length} ADRs: ${coll.join(", ")}`,
      });
    }
  }

  return { entries, violations };
}

export function scanAdrDirectory(
  dir = resolve(import.meta.dirname, "..", "docs", "adr"),
): AdrScanReport {
  const files = readdirSync(dir).filter((file) => file.endsWith(".md"));
  return scanAdrFiles(files);
}

function main(): void {
  const { entries, violations } = scanAdrDirectory();
  if (violations.length) {
    for (const violation of violations) {
      console.error(`docs/adr/${violation.file}: ${violation.reason}`);
    }
    console.error(
      `\nADR numbering check FAIL: ${violations.length} issue(s). New ADRs are named ` +
        `YYYY-MM-DD-short-kebab-title.md; the sequential range is closed at ` +
        `${String(LAST_SEQUENTIAL_ADR).padStart(4, "0")}. See docs/adr/README.md.`,
    );
    process.exitCode = 1;
    return;
  }
  const dated = entries.filter((entry) => entry.scheme === "dated").length;
  const sequential = entries.filter((entry) => entry.scheme === "sequential").length;
  console.log(
    `ADR numbering check passed: ${entries.length} ADRs (${sequential} grandfathered sequential, ` +
      `${dated} dated), no duplicate identifiers.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
