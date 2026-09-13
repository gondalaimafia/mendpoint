import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  detectStaleClaims,
  normalizeSurfacePath,
  validatePublicClaimRegistry,
  type ClaimStalenessComparison,
  type PublicClaimIssue,
  type PublicClaimRegistry,
} from "../packages/contract/src/public-claims.js";
import type { ProductRequirementManifest } from "../packages/contract/src/product-requirements.js";

function repositoryPath(repoRoot: string, locator: string) {
  const resolved = resolve(repoRoot, normalizeSurfacePath(locator));
  const relativePath = relative(repoRoot, resolved);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`claim evidence escapes repository: ${locator}`);
  }
  return resolved;
}

const REVISION = /^[a-f0-9]{40}$/;

/**
 * Live evidence asserts that someone probed a URL at a specific instant and
 * pins the `revision` the deployment was serving. The contract validator checks
 * that the revision is well-formed and equals the registry auditedRevision, but
 * it is a pure function with no repository access, so it cannot tell a real
 * commit from a fabricated forty-hex string. This does: every well-formed live
 * revision must resolve to an actual commit object in this repository. A batch
 * of PRs stamped `observedAt` while pinning a revision that was never committed
 * here; that is exactly what this catches. Malformed or mismatched revisions
 * are left to the contract validator so we do not double-report them.
 */
export function revisionReachabilityIssues(
  registry: PublicClaimRegistry,
  revisionExists: (revision: string) => boolean,
): PublicClaimIssue[] {
  const issues: PublicClaimIssue[] = [];
  for (const claim of registry.claims ?? []) {
    for (const evidence of claim.evidence ?? []) {
      if (evidence.type !== "live") continue;
      if (typeof evidence.revision !== "string" || !REVISION.test(evidence.revision)) continue;
      if (!revisionExists(evidence.revision)) {
        issues.push({
          code: "LIVE_EVIDENCE_REVISION_UNREACHABLE",
          subject: evidence.id,
          message: `revision ${evidence.revision} is not a commit in this repository`,
        });
      }
    }
  }
  return issues;
}

function gitRevisionExists(repoRoot: string, revision: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/**
 * Reads the public-claim registry as it stood at auditedRevision and maps each
 * claim ID to the surfacePaths it declared there. auditedRevision has already
 * been validated as a 40-hex commit object by the caller; `--` still terminates
 * options. Throws if the blob is absent (shallow clone, or the registry did not
 * exist at that revision) or is not parseable JSON, which {@link compareSurfaces}
 * turns into a fail-closed `indeterminate`.
 */
function readAuditedSurfacePaths(
  repoRoot: string,
  auditedRevision: string,
): Map<string, readonly string[]> {
  const raw = git(repoRoot, [
    "show",
    `${auditedRevision}:docs/PUBLIC_CLAIMS.json`,
    "--",
  ]);
  const parsed = JSON.parse(raw) as { claims?: unknown };
  const byClaim = new Map<string, readonly string[]>();
  const claims = Array.isArray(parsed.claims) ? parsed.claims : [];
  for (const claim of claims) {
    if (!claim || typeof claim !== "object") continue;
    const entry = claim as { id?: unknown; surfacePaths?: unknown };
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    const surfacePaths = Array.isArray(entry.surfacePaths)
      ? entry.surfacePaths.filter((path): path is string => typeof path === "string")
      : [];
    byClaim.set(entry.id, surfacePaths);
  }
  return byClaim;
}

/**
 * Compares the audited revision against the shipped HEAD so {@link
 * detectStaleClaims} can tell which claims describe code that moved since the
 * audit and which dropped or retargeted an audited surface. Every branch that
 * cannot yield a trustworthy comparison returns `indeterminate`, which fails the
 * gate instead of passing silently. CI often checks out shallow, so a missing
 * audited object (commit or registry blob) is reported explicitly. The audited
 * revision is validated as a 40-hex string before it reaches any Git argument,
 * and the changed set is read NUL-delimited so quoted, non-ASCII paths survive.
 */
export function compareSurfaces(
  repoRoot: string,
  auditedRevision: string,
): ClaimStalenessComparison {
  if (!REVISION.test(auditedRevision)) {
    return {
      status: "indeterminate",
      reason: "auditedRevision is not a well-formed 40-character Git revision",
    };
  }

  let insideWorkTree: string;
  try {
    insideWorkTree = git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { status: "indeterminate", reason: "not a Git work tree" };
  }
  if (insideWorkTree !== "true") {
    return { status: "indeterminate", reason: "not a Git work tree" };
  }

  let headRevision: string;
  try {
    headRevision = git(repoRoot, ["rev-parse", "HEAD"]);
  } catch {
    return { status: "indeterminate", reason: "HEAD could not be resolved" };
  }

  let shallow = "false";
  try {
    shallow = git(repoRoot, ["rev-parse", "--is-shallow-repository"]);
  } catch {
    // Older Git versions lack this flag; fall through and let cat-file decide.
  }

  try {
    git(repoRoot, ["cat-file", "-e", `${auditedRevision}^{commit}`]);
  } catch {
    return {
      status: "indeterminate",
      reason:
        shallow === "true"
          ? `auditedRevision is absent from this shallow clone; fetch full history (git fetch --unshallow) to audit`
          : `auditedRevision is not a known commit object in this repository`,
    };
  }

  try {
    execFileSync("git", ["merge-base", "--is-ancestor", auditedRevision, headRevision], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) {
      return {
        status: "indeterminate",
        reason: `auditedRevision is not an ancestor of HEAD ${headRevision}`,
      };
    }
    return {
      status: "indeterminate",
      reason: `ancestry check between auditedRevision and HEAD ${headRevision} failed`,
    };
  }

  let auditedSurfacePathsByClaim: Map<string, readonly string[]>;
  try {
    auditedSurfacePathsByClaim = readAuditedSurfacePaths(repoRoot, auditedRevision);
  } catch {
    return {
      status: "indeterminate",
      reason:
        shallow === "true"
          ? `docs/PUBLIC_CLAIMS.json is unreadable at auditedRevision in this shallow clone; fetch full history (git fetch --unshallow) to audit`
          : `docs/PUBLIC_CLAIMS.json could not be read at auditedRevision`,
    };
  }

  let changedPaths: string[];
  try {
    changedPaths = execFileSync(
      "git",
      ["diff", "--name-only", "-z", auditedRevision, headRevision, "--"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .split("\0")
      .filter(Boolean);
  } catch {
    return {
      status: "indeterminate",
      reason: `diff between auditedRevision and HEAD ${headRevision} failed`,
    };
  }

  return {
    status: "comparable",
    headRevision,
    changedPaths,
    auditedSurfacePathsByClaim,
  };
}

/**
 * Collects every public-claim issue for the registry at repoRoot: contract
 * validation, staleness (a mapped surface changed, an audited surface dropped or
 * retargeted, or a claim added after the audit), surface existence and ID
 * binding, non-live evidence existence, and live evidence revision
 * reachability. {@link main} prints and throws on any issue; keeping collection
 * separate lets the staleness wiring be exercised end-to-end against a real
 * temporary repository in tests.
 */
export function collectPublicClaimIssues(
  repoRoot: string,
  registry: PublicClaimRegistry,
  requirements: ProductRequirementManifest,
): PublicClaimIssue[] {
  const issues = validatePublicClaimRegistry(registry, {
    requirements: requirements.requirements ?? [],
    asOf: new Date(),
  });
  issues.push(
    ...detectStaleClaims(registry, compareSurfaces(repoRoot, registry.auditedRevision)),
  );
  for (const claim of registry.claims ?? []) {
    let boundSurface = false;
    for (const surfacePath of claim.surfacePaths ?? []) {
      const resolvedSurface = repositoryPath(repoRoot, surfacePath);
      if (!existsSync(resolvedSurface)) {
        issues.push({
          code: "SURFACE_PATH_MISSING",
          subject: claim.id,
          message: `${surfacePath} does not exist`,
        });
      } else if (readFileSync(resolvedSurface, "utf8").includes(claim.id)) {
        boundSurface = true;
      }
    }
    if (!boundSurface) {
      issues.push({
        code: "CLAIM_SURFACE_BINDING_MISSING",
        subject: claim.id,
        message: "at least one mapped surface must bind the claim by ID",
      });
    }
    for (const evidence of claim.evidence ?? []) {
      if (["live", "external"].includes(evidence.type)) continue;
      if (!existsSync(repositoryPath(repoRoot, evidence.locator))) {
        issues.push({
          code: "EVIDENCE_MISSING",
          subject: evidence.id,
          message: `${evidence.locator} does not exist`,
        });
      }
    }
  }
  issues.push(
    ...revisionReachabilityIssues(registry, (revision) => gitRevisionExists(repoRoot, revision)),
  );
  return issues;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Full ISO 8601 date-time with an explicit UTC `Z` or numeric offset. A hold is
 * a recorded exception, so its timestamps must be unambiguous instants, not bare
 * dates or local wall-clock strings that {@link Date.parse} would read
 * inconsistently across runners.
 */
const ISO_8601_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A time-boxed, recorded exception that lets one stale live-evidence entry pass
 * while its production surface is unreachable. Held evidence is still reported,
 * never hidden: the hold only downgrades a `LIVE_EVIDENCE_STALE` blocker to a
 * warning until `expiresAt`, after which staleness blocks again.
 */
export interface PublicClaimEvidenceHold {
  evidenceId: string;
  recordedAt: string;
  expiresAt: string;
  reason: string;
  authorizedBy: string;
}

export interface EvidenceHoldOutcome {
  /** Issues that still fail the gate; {@link main} prints these and throws. */
  blocking: PublicClaimIssue[];
  /** Non-blocking notices (held-stale, unused, or not-yet-effective holds) printed as warnings. */
  held: PublicClaimIssue[];
}

function isoInstant(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_8601_INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function collectLiveEvidenceIds(registry: PublicClaimRegistry): Set<string> {
  const ids = new Set<string>();
  for (const claim of registry.claims ?? []) {
    for (const evidence of claim.evidence ?? []) {
      if (evidence.type === "live") ids.add(evidence.id);
    }
  }
  return ids;
}

const byCodeThenSubject = (left: PublicClaimIssue, right: PublicClaimIssue): number =>
  left.code.localeCompare(right.code) || left.subject.localeCompare(right.subject);

/**
 * Why a hold is rejected outright, or null when it is well-formed. A rejected
 * hold provides no cover, so the staleness it names still blocks. The 7-day
 * ceiling on the recorded-to-expiry span keeps every exception short-lived and
 * re-authorized each rotation. A hold recorded after the observation clock is
 * NOT rejected here: it is well-formed but not yet in effect, and the caller
 * reports it as a non-blocking `EVIDENCE_HOLD_NOT_YET_EFFECTIVE` notice while
 * the staleness it names, if any, stays blocking (a future-dated hold is inert
 * until its `recordedAt`, so it extends no cover yet).
 */
function evidenceHoldRejection(
  hold: Record<string, unknown>,
  evidenceId: string,
  liveEvidenceIds: Set<string>,
): string | null {
  if (evidenceId === "") return "evidenceId must be a non-empty string";
  if (typeof hold.reason !== "string" || hold.reason.trim() === "") {
    return "reason must be a non-empty string";
  }
  if (typeof hold.authorizedBy !== "string" || hold.authorizedBy.trim() === "") {
    return "authorizedBy must be a non-empty string";
  }
  const recordedAtMs = isoInstant(hold.recordedAt);
  if (recordedAtMs === null) return "recordedAt must be an ISO 8601 instant";
  const expiresAtMs = isoInstant(hold.expiresAt);
  if (expiresAtMs === null) return "expiresAt must be an ISO 8601 instant";
  if (expiresAtMs <= recordedAtMs) return "expiresAt must be after recordedAt";
  if (expiresAtMs - recordedAtMs > SEVEN_DAYS_MS) return "a hold may not exceed 7 days";
  if (!liveEvidenceIds.has(evidenceId)) {
    return `evidenceId ${evidenceId} is not a live evidence entry in the registry`;
  }
  return null;
}

/**
 * Partitions public-claim issues against a set of recorded evidence holds. A
 * valid, effective, unexpired hold moves its `LIVE_EVIDENCE_STALE` issue to
 * `held` (reported, not hidden); an expired hold whose evidence is still stale
 * becomes a blocking `EVIDENCE_HOLD_EXPIRED` (stale evidence cannot hide behind
 * a lapsed hold); a well-formed hold recorded after the observation clock is a
 * non-blocking `EVIDENCE_HOLD_NOT_YET_EFFECTIVE` notice that extends no cover,
 * so the staleness it names, if any, stays blocking; a hold whose evidence is
 * fresh is a non-blocking `EVIDENCE_HOLD_UNUSED` warning so cleanup never forces
 * a ceremony; a malformed or duplicate hold is a blocking `EVIDENCE_HOLD_INVALID`.
 * Every other issue code stays blocking. Pure so the matrix can be exercised
 * without a working tree.
 */
export function applyEvidenceHolds(
  issues: PublicClaimIssue[],
  holds: readonly PublicClaimEvidenceHold[],
  context: { registry: PublicClaimRegistry; now: Date },
): EvidenceHoldOutcome {
  const liveEvidenceIds = collectLiveEvidenceIds(context.registry);
  const nowMs = context.now.getTime();
  const staleSubjects = new Set(
    issues.filter((issue) => issue.code === "LIVE_EVIDENCE_STALE").map((issue) => issue.subject),
  );

  const blocking: PublicClaimIssue[] = [];
  const held: PublicClaimIssue[] = [];
  const validHolds = new Map<string, { expiresAt: string; reason: string; expired: boolean }>();
  const seen = new Set<string>();

  for (const raw of holds ?? []) {
    const hold = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const evidenceId = typeof hold.evidenceId === "string" ? hold.evidenceId : "";
    const subject = evidenceId === "" ? "(missing evidenceId)" : evidenceId;
    const rejection =
      evidenceId !== "" && seen.has(evidenceId)
        ? "duplicate evidenceId"
        : evidenceHoldRejection(hold, evidenceId, liveEvidenceIds);
    if (evidenceId !== "") seen.add(evidenceId);
    if (rejection !== null) {
      blocking.push({ code: "EVIDENCE_HOLD_INVALID", subject, message: rejection });
      continue;
    }
    // A well-formed hold recorded after the observation clock is not yet in
    // effect: it is inert until its recordedAt, so it extends no cover and never
    // enters the cover map. It is reported as a non-blocking notice, and the
    // staleness it names, if any, stays blocking (handled below by the absent
    // cover-map entry).
    if (Date.parse(hold.recordedAt as string) > nowMs) {
      held.push({
        code: "EVIDENCE_HOLD_NOT_YET_EFFECTIVE",
        subject: evidenceId,
        message: `hold recorded at ${hold.recordedAt as string} is after the observation clock; it is not yet in effect`,
      });
      continue;
    }
    validHolds.set(evidenceId, {
      expiresAt: hold.expiresAt as string,
      reason: hold.reason as string,
      expired: Date.parse(hold.expiresAt as string) <= nowMs,
    });
  }

  for (const issue of issues) {
    if (issue.code !== "LIVE_EVIDENCE_STALE") {
      blocking.push(issue);
      continue;
    }
    const hold = validHolds.get(issue.subject);
    if (!hold) {
      blocking.push(issue);
    } else if (hold.expired) {
      blocking.push({
        code: "EVIDENCE_HOLD_EXPIRED",
        subject: issue.subject,
        message: `hold expired at ${hold.expiresAt}; ${issue.message}`,
      });
    } else {
      held.push({
        code: "LIVE_EVIDENCE_STALE_HELD",
        subject: issue.subject,
        message: `${issue.message}; held until ${hold.expiresAt} (${hold.reason})`,
      });
    }
  }

  for (const [evidenceId, hold] of validHolds) {
    if (!staleSubjects.has(evidenceId)) {
      held.push({
        code: "EVIDENCE_HOLD_UNUSED",
        subject: evidenceId,
        message: `live evidence is fresh; remove this hold in the next rotation (${hold.reason})`,
      });
    }
  }

  return { blocking: blocking.sort(byCodeThenSubject), held: held.sort(byCodeThenSubject) };
}

/**
 * Reads the optional `publicClaimEvidenceHolds` array from the closure authority
 * policy under `repoRoot`. An absent file or key yields no holds, so the gate's
 * behaviour is unchanged wherever no exception has been recorded.
 */
function readEvidenceHolds(repoRoot: string): PublicClaimEvidenceHold[] {
  const policyPath = resolve(repoRoot, "config", "production-closure-authority.json");
  if (!existsSync(policyPath)) return [];
  const policy = JSON.parse(readFileSync(policyPath, "utf8")) as {
    publicClaimEvidenceHolds?: unknown;
  };
  return Array.isArray(policy.publicClaimEvidenceHolds)
    ? (policy.publicClaimEvidenceHolds as PublicClaimEvidenceHold[])
    : [];
}

function main() {
  const repoRoot = resolve(process.cwd());
  const registryPath = resolve(repoRoot, "docs", "PUBLIC_CLAIMS.json");
  const requirementsPath = resolve(repoRoot, "docs", "PRODUCT_REQUIREMENTS.json");
  if (!existsSync(registryPath)) throw new Error("docs/PUBLIC_CLAIMS.json is missing");
  if (!existsSync(requirementsPath)) throw new Error("docs/PRODUCT_REQUIREMENTS.json is missing");

  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as PublicClaimRegistry;
  const requirements = JSON.parse(
    readFileSync(requirementsPath, "utf8"),
  ) as ProductRequirementManifest;
  const issues = collectPublicClaimIssues(repoRoot, registry, requirements);
  const { blocking, held } = applyEvidenceHolds(issues, readEvidenceHolds(repoRoot), {
    registry,
    now: new Date(),
  });

  for (const notice of held) {
    const line = `${notice.code} ${notice.subject}: ${notice.message}`;
    console.error(line);
    console.error(`::warning title=Live evidence held::${line}`);
  }

  if (blocking.length > 0) {
    for (const issue of blocking) {
      console.error(`${issue.code} ${issue.subject}: ${issue.message}`);
    }
    throw new Error(
      `public claim registry has ${blocking.length} blocking issue${blocking.length === 1 ? "" : "s"}`,
    );
  }

  console.log(
    `PUBLIC CLAIMS PASS: ${registry.claims.length} claims, ${registry.destinations.length} destinations` +
      (held.length > 0
        ? `, ${held.length} held/unused/not-yet-effective evidence warning${held.length === 1 ? "" : "s"}`
        : ""),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
