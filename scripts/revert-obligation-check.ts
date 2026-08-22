/**
 * Revert-obligation check — npm run reverts:check
 *
 * Stops a deferred revert from silently becoming permanent.
 *
 * The failure this prevents (tasks/lessons.md, PR body):
 *
 *   On 13 August, `6a7b2f6` (#93) reverted five merges — 58 files, -7,670
 *   lines — "for isolated diagnosis and reintroduction after production is
 *   healthy." The diagnosis never happened and nothing was reintroduced. The
 *   loss was invisible for nine days because *nothing fails when the code is
 *   gone*: a revert removes capability without breaking a build, so the promise
 *   to bring it back has no forcing function. One concrete casualty — the
 *   same-API model-id substitution from #92 — left the owner's customer/internal
 *   model policy inexpressible, and nobody noticed because customer routing is
 *   default-off.
 *
 * This check gives that promise a forcing function: every revert on `main` is an
 * open obligation until it is discharged, and an undischarged one becomes a hard
 * failure after a grace period.
 *
 * DETECTION covers both shapes a revert takes here:
 *   - conventional `Revert "..."` subjects / `This reverts commit <sha>` bodies;
 *   - a batched "restore to known good" (6a7b2f6's subject is "Restore last
 *     known healthy production source", which a naive `^Revert` grep misses).
 *     These are caught structurally: a deletion-dominant commit (removes a lot,
 *     adds little), the shape a mass revert always takes.
 *
 * RESOLUTION — an obligation is discharged when any of the following is true,
 * all detected from artifacts already in the repo:
 *   - RE-LAND: the reverted work came back (a later commit reintroduces the
 *     reverted PR / title). 2314ce7/#91 was re-landed via #94.
 *   - ADR: an Accepted ADR under docs/adr/ names a file the commit removed,
 *     i.e. someone wrote down the decision to remove it (PolicyRouterRuntime →
 *     ADR-0011; billing + config-as-code → ADR-0012).
 *   - RECORDED DECISION: an inline, greppable marker records a deliberate
 *     decision not to restore, keyed to the commit:
 *         revert-obligation: <sha> <reason>
 *     Audit every one with:  grep -rn "revert-obligation:" .
 *
 * GRACE — a fresh revert during an incident is correct and must never block.
 * The check is silent within WARN_AFTER_DAYS, warns (non-blocking) after it, and
 * fails only after FAIL_AFTER_DAYS. See the constants below for the rationale.
 *
 * SHALLOW CLONES — the check needs full history to see reverts, their diffs, and
 * their re-lands. A shallow clone cannot certify it has seen them all, so it is
 * treated as an explicit could-not-determine and FAILS closed, never a silent
 * pass. Run with full history (CI: actions/checkout with fetch-depth: 0, or
 * `git fetch --unshallow`).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Days before an undischarged revert starts to warn, and before it fails.
 *
 * FAIL_AFTER_DAYS = 14 is two working weeks: comfortably longer than any
 * legitimate incident-diagnosis window (the #93 loss was already too old at nine
 * days), yet short enough that a forgotten revert becomes blocking long before
 * it calcifies into permanent, invisible capability loss. WARN_AFTER_DAYS = 7
 * surfaces it a week earlier without blocking anyone. Hours would punish a live
 * incident; months would repeat #93.
 */
export const WARN_AFTER_DAYS = 7;
export const FAIL_AFTER_DAYS = 14;

/**
 * Deletion-dominant thresholds for the batched-restore shape. A mass revert
 * removes a great deal and adds almost nothing. Requiring both a floor on
 * deletions and deletions >> insertions separates a revert (6a7b2f6: -7670/+42;
 * the two ADR removals: -3487/+192 and -1471/+172) from ordinary refactors and
 * feature work, which add at least as much as they remove. Conventional reverts
 * are caught by message at any size, so a small revert is never missed.
 */
export const MIN_DELETIONS = 500;
export const DELETION_DOMINANCE = 3;

/** Inline escape hatch / recorded-decision marker. Must carry a sha and a reason. */
export const REVERT_OBLIGATION_MARKER = "revert-obligation:";

const ADR_DIRECTORY = join("docs", "adr");

/** Generic filenames whose presence in an ADR proves nothing about a removal. */
const GENERIC_BASENAMES: ReadonlySet<string> = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "index.ts",
  "index.tsx",
]);

export type RevertShape = "conventional" | "deletion-dominant";

/** How a revert obligation was discharged, or that it is still open. */
export type RevertDisposition = "reland" | "adr" | "recorded" | "unresolved";

/** Whether the check as a whole tolerates, warns on, or fails on an obligation. */
export type RevertGrade = "resolved" | "within-grace" | "warn" | "fail";

export type CommitMeta = Readonly<{
  sha: string;
  isoDate: string;
  subject: string;
  body: string;
}>;

export type RevertObligation = Readonly<{
  sha: string;
  isoDate: string;
  subject: string;
  shape: RevertShape;
  ageDays: number;
  disposition: RevertDisposition;
  grade: RevertGrade;
  detail: string;
}>;

export type AnalysisStatus = "pass" | "fail" | "undetermined";

export type Analysis = Readonly<{
  status: AnalysisStatus;
  reason: string;
  obligations: readonly RevertObligation[];
}>;

/** A git binding narrow enough that tests can point it at a fixture repo. */
export type GitEnv = Readonly<{
  isShallow: () => boolean;
  hasCommits: () => boolean;
  /** Every commit reachable from HEAD, newest first. */
  log: () => readonly CommitMeta[];
  /** Insertions and deletions per commit sha (0/0 for merges), in one pass. */
  stats: () => Map<string, { insertions: number; deletions: number }>;
  /** Files the commit deleted outright (diff-filter=D), repo-relative. */
  deletedPaths: (sha: string) => readonly string[];
}>;

const RECORD_SEP = "\x1e";
const UNIT_SEP = "\x1f";

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function realGitEnv(root: string): GitEnv {
  return {
    isShallow: () => git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true",
    hasCommits: () => {
      try {
        git(root, ["rev-parse", "--verify", "HEAD"]);
        return true;
      } catch {
        return false;
      }
    },
    log: () => {
      const format = ["%H", "%cI", "%s", "%b"].join(UNIT_SEP) + RECORD_SEP;
      const raw = git(root, ["log", "--no-color", `--format=${format}`, "HEAD"]);
      const commits: CommitMeta[] = [];
      for (const record of raw.split(RECORD_SEP)) {
        const trimmed = record.replace(/^\r?\n/, "");
        if (!trimmed.trim()) continue;
        const [sha, isoDate, subject, ...bodyParts] = trimmed.split(UNIT_SEP);
        if (!sha) continue;
        commits.push({
          sha: sha.trim(),
          isoDate: (isoDate ?? "").trim(),
          subject: subject ?? "",
          body: bodyParts.join(UNIT_SEP),
        });
      }
      return commits;
    },
    stats: () => {
      const raw = git(root, ["log", "--no-color", `--format=${RECORD_SEP}%H`, "--shortstat", "HEAD"]);
      const map = new Map<string, { insertions: number; deletions: number }>();
      for (const chunk of raw.split(RECORD_SEP)) {
        const trimmed = chunk.replace(/^\r?\n/, "");
        if (!trimmed.trim()) continue;
        const sha = trimmed.split(/\r?\n/, 1)[0]!.trim();
        if (!sha) continue;
        const insertions = /(\d+) insertions?\(\+\)/.exec(trimmed);
        const deletions = /(\d+) deletions?\(-\)/.exec(trimmed);
        map.set(sha, {
          insertions: insertions ? Number(insertions[1]) : 0,
          deletions: deletions ? Number(deletions[1]) : 0,
        });
      }
      return map;
    },
    deletedPaths: (sha) =>
      git(root, ["show", "--no-color", "--diff-filter=D", "--name-only", "--format=", sha])
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
  };
}

/** True for a commit that declares itself a revert in its message. */
export function isConventionalRevert(subject: string, body: string): boolean {
  if (/^Revert ["']/.test(subject.trim())) return true;
  return /^This reverts commit [0-9a-f]{7,40}\b/m.test(body);
}

/** True when a commit removes a lot and adds little — the mass-revert shape. */
export function isDeletionDominant(insertions: number, deletions: number): boolean {
  return deletions >= MIN_DELETIONS && deletions >= DELETION_DOMINANCE * Math.max(insertions, 1);
}

/**
 * The reverted work's identity, parsed from a conventional revert subject.
 * `Revert "Preserve ... (#88)" (#91)` -> { title: "Preserve ...", pr: "88" }.
 */
export function parseRevertedRef(subject: string): { title: string; pr: string | null } | null {
  const match = /^Revert ["'](.+)["'](?:\s*\(#\d+\))?\s*$/.exec(subject.trim());
  if (!match) return null;
  const quoted = match[1]!;
  const prMatch = /\(#(\d+)\)\s*$/.exec(quoted);
  const title = quoted.replace(/\s*\(#\d+\)\s*$/, "").trim();
  return { title, pr: prMatch ? prMatch[1]! : null };
}

const normalizeTitle = (subject: string): string =>
  subject.replace(/\s*\(#\d+\)\s*$/g, "").trim().toLowerCase();

/**
 * True when one of `laterCommits` (all newer than the revert) reintroduces the
 * reverted work: it re-uses the reverted PR number or repeats its title, and is
 * not itself a revert.
 */
export function isReland(
  reverted: { title: string; pr: string | null },
  laterCommits: readonly CommitMeta[],
): boolean {
  const wantedTitle = reverted.title.toLowerCase();
  const prToken = reverted.pr ? `(#${reverted.pr})` : null;
  return laterCommits.some((commit) => {
    if (isConventionalRevert(commit.subject, commit.body)) return false;
    if (prToken && commit.subject.includes(prToken)) return true;
    return wantedTitle.length > 0 && normalizeTitle(commit.subject) === wantedTitle;
  });
}

/** Parse `revert-obligation: <sha> <reason>` markers out of arbitrary text. */
export function parseObligationMarkers(text: string): { sha: string; reason: string }[] {
  const markers: { sha: string; reason: string }[] = [];
  const pattern = new RegExp(`${REVERT_OBLIGATION_MARKER}\\s*([0-9a-f]{7,40})\\b(.*)`, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const reason = match[2]!.replace(/-->\s*$/, "").trim();
    markers.push({ sha: match[1]!.toLowerCase(), reason });
  }
  return markers;
}

/** True when a recorded-decision marker names this commit and gives a reason. */
export function markerResolves(
  sha: string,
  markers: readonly { sha: string; reason: string }[],
): boolean {
  return markers.some((marker) => sha.startsWith(marker.sha) && marker.reason.length > 0);
}

/**
 * True when an Accepted ADR names an outright-deleted file of the commit. A
 * generic filename (package.json, index.ts, ...) does not count — the ADR must
 * point at the distinctive removed source, which is how a real removal decision
 * reads.
 */
export function adrResolves(
  deletedPaths: readonly string[],
  acceptedAdrTexts: readonly string[],
): boolean {
  const distinctive = deletedPaths.filter((path) => {
    const base = path.split("/").pop() ?? path;
    return !GENERIC_BASENAMES.has(base);
  });
  return distinctive.some((path) => acceptedAdrTexts.some((adr) => adr.includes(path)));
}

/** Grade an undischarged obligation by age against the grace thresholds. */
export function gradeAge(ageDays: number): "within-grace" | "warn" | "fail" {
  if (ageDays >= FAIL_AFTER_DAYS) return "fail";
  if (ageDays >= WARN_AFTER_DAYS) return "warn";
  return "within-grace";
}

/** Read Accepted ADR bodies. Missing directory is legitimately empty, not an error. */
export function readAcceptedAdrTexts(root: string): string[] {
  const dir = join(root, ADR_DIRECTORY);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const texts: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const text = readFileSync(join(dir, entry), "utf8");
    if (/^-?\s*\*\*Status:\*\*\s*Accepted/im.test(text) || /\bStatus:\s*Accepted\b/i.test(text)) {
      texts.push(text);
    }
  }
  return texts;
}

/** Read every recorded-decision marker in the working tree via one grep. */
export function readObligationMarkers(root: string): { sha: string; reason: string }[] {
  let raw: string;
  try {
    raw = git(root, ["grep", "--no-color", "--untracked", "-hI", "-e", REVERT_OBLIGATION_MARKER]);
  } catch {
    // git grep exits non-zero when there are no matches; that is not an error.
    return [];
  }
  return parseObligationMarkers(raw);
}

function daysBetween(now: Date, isoDate: string): number {
  const then = new Date(isoDate).getTime();
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - then) / 86_400_000;
}

/**
 * Core analysis over an injected git binding and repo root. Returns a status the
 * caller turns into an exit code; never throws for an ordinary repository state.
 */
export function analyzeRepository(options: {
  root?: string;
  now?: Date;
  gitEnv?: GitEnv;
}): Analysis {
  const root = options.root ?? resolve(import.meta.dirname, "..");
  const now = options.now ?? new Date();
  const gitEnv = options.gitEnv ?? realGitEnv(root);

  // Shallow history cannot certify it has seen every revert or re-land. Fail
  // closed rather than pass silently on a truncated clone.
  let shallow: boolean;
  try {
    shallow = gitEnv.isShallow();
  } catch {
    return {
      status: "undetermined",
      reason:
        "could not determine whether the clone is shallow (git unavailable or not a repository); " +
        "run inside a full checkout",
      obligations: [],
    };
  }
  if (shallow) {
    return {
      status: "undetermined",
      reason:
        "shallow clone: cannot see full history, so reverts and their re-lands cannot be certified. " +
        "Fetch full history (CI: actions/checkout with fetch-depth: 0, or `git fetch --unshallow`).",
      obligations: [],
    };
  }

  if (!gitEnv.hasCommits()) {
    return { status: "pass", reason: "no commits", obligations: [] };
  }

  const commits = gitEnv.log();
  const statsMap = gitEnv.stats();
  const acceptedAdrTexts = readAcceptedAdrTexts(root);
  const markers = readObligationMarkers(root);

  const obligations: RevertObligation[] = [];
  for (let index = 0; index < commits.length; index += 1) {
    const commit = commits[index]!;
    const conventional = isConventionalRevert(commit.subject, commit.body);
    const { insertions, deletions } = statsMap.get(commit.sha) ?? { insertions: 0, deletions: 0 };
    const dominant = isDeletionDominant(insertions, deletions);
    if (!conventional && !dominant) continue;
    const shape: RevertShape = conventional ? "conventional" : "deletion-dominant";

    // Commits newer than this revert (git log is newest-first, so they precede it).
    const laterCommits = commits.slice(0, index);

    let disposition: RevertDisposition = "unresolved";
    let detail = "";
    const reverted = parseRevertedRef(commit.subject);
    if (reverted && isReland(reverted, laterCommits)) {
      disposition = "reland";
      detail = `reverted work re-landed on main${reverted.pr ? ` (#${reverted.pr})` : ""}`;
    } else if (adrResolves(gitEnv.deletedPaths(commit.sha), acceptedAdrTexts)) {
      disposition = "adr";
      detail = "an Accepted ADR records the decision to remove the deleted files";
    } else if (markerResolves(commit.sha, markers)) {
      disposition = "recorded";
      detail = "a recorded-decision marker records a deliberate decision not to restore";
    }

    const ageDays = daysBetween(now, commit.isoDate);
    const grade: RevertGrade = disposition === "unresolved" ? gradeAge(ageDays) : "resolved";
    if (disposition === "unresolved") {
      detail =
        `open ${Math.floor(ageDays)}d — re-land the reverted work, or record the decision not to with ` +
        `an inline "${REVERT_OBLIGATION_MARKER} ${commit.sha.slice(0, 7)} <reason>" marker ` +
        `(an Accepted ADR naming the removed files also discharges it)`;
    }

    obligations.push({
      sha: commit.sha,
      isoDate: commit.isoDate,
      subject: commit.subject,
      shape,
      ageDays,
      disposition,
      grade,
      detail,
    });
  }

  const failing = obligations.filter((o) => o.grade === "fail");
  if (failing.length > 0) {
    return {
      status: "fail",
      reason: `${failing.length} revert(s) undischarged past the ${FAIL_AFTER_DAYS}-day grace period`,
      obligations,
    };
  }
  return { status: "pass", reason: "every revert on main is discharged or within grace", obligations };
}

function main(): void {
  const analysis = analyzeRepository({});

  const shortSha = (sha: string): string => sha.slice(0, 7);
  for (const o of analysis.obligations) {
    const tag = o.grade === "resolved" ? o.disposition : o.grade;
    const line = `${shortSha(o.sha)} [${o.shape}/${tag}] ${o.subject.split("\n")[0]}`;
    if (o.grade === "fail") {
      console.error(line);
      console.error(`    ${o.detail}`);
    } else if (o.grade === "warn") {
      console.warn(line);
      console.warn(`    ${o.detail}`);
    } else {
      console.log(line);
    }
  }

  if (analysis.status === "undetermined") {
    console.error(`\nRevert-obligation check COULD NOT DETERMINE: ${analysis.reason}`);
    process.exitCode = 1;
    return;
  }
  if (analysis.status === "fail") {
    console.error(
      `\nRevert-obligation check FAIL: ${analysis.reason}. ` +
        `A revert is dangerous precisely because nothing fails when the code is gone. ` +
        `Discharge each one above, then re-run. ` +
        `Audit recorded decisions with:  grep -rn "${REVERT_OBLIGATION_MARKER}" .`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`\nRevert-obligation check passed: ${analysis.reason}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
