/**
 * Refresh production live evidence on a schedule — the automation behind
 * `docs/PUBLIC_CLAIMS.json`'s three `type: "live"` entries.
 *
 * Live evidence pins `observedAt`/`freshUntil` (observedAt + 7 days) and the
 * `revision` production was serving when the probe ran. `npm run claims:check`
 * fails the required CI job with LIVE_EVIDENCE_STALE once `freshUntil` passes, so
 * without a refresh the registry turns main (and every open PR) red on a
 * calendar, not on a code change. This script re-observes the endpoints and
 * advances the registry the same way a human would — but only when doing so is
 * TRUTHFUL, refusing loudly and writing nothing otherwise.
 *
 * The file is split into a pure core and a thin IO wrapper on purpose. The core
 * ({@link refreshLiveEvidence}, {@link refreshDueness}) takes the registry text,
 * the observations already made, the deployed revision, `now`, and the
 * OLD-audited-revision-to-deployed-revision staleness comparison, and returns
 * either the new file text or a refusal reason — no clock, no network, no Git —
 * so every refusal path is exercised in a unit test without a working tree. The
 * IO wrapper (`main`) does the HTTP probing, the Git comparison, and the write.
 *
 * Why the refusals exist (each is a way the move could assert something false):
 *  - non-200 / healthz ok:false: the surface is not actually serving, so an
 *    observation would be fabricated.
 *  - version changed mid-run: production redeployed between the two /version
 *    reads, so no single revision was serving throughout the observations.
 *  - deployed revision not an ancestor of origin/main: the revision is not a
 *    commit on the shipped line, so pinning it would be meaningless.
 *  - claim surface-stale: a claim's audited surface changed between the current
 *    auditedRevision and the deployed revision, so moving auditedRevision would
 *    claim an audit that never happened at the new revision — a human must
 *    re-audit.
 *  - the resulting registry fails contract validation (claims check would fail).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectStaleClaims,
  validatePublicClaimRegistry,
  type ClaimStalenessComparison,
  type PublicClaimIssue,
  type PublicClaimRegistry,
} from "../packages/contract/src/public-claims.js";
import type {
  ProductRequirementManifest,
} from "../packages/contract/src/product-requirements.js";

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const REVISION = /^[a-f0-9]{40}$/;
const ISO_TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

/**
 * One re-observation of a live-evidence surface, produced by the IO wrapper. The
 * `observedAt` is a millisecond ISO instant read from the clock IMMEDIATELY
 * before the request, so the three observations carry distinct sub-second stamps
 * and cannot read as a single batch stamp copied across endpoints (the contract
 * flags repeated second-resolution stamps). `healthzOk` is only meaningful for
 * the `/healthz` locator, which must additionally return JSON `ok: true`.
 */
export interface LiveObservation {
  readonly evidenceId: string;
  readonly locator: string;
  readonly httpStatus: number;
  readonly observedAt: string;
  readonly healthzOk?: boolean;
}

/**
 * The result of a `git merge-base --is-ancestor` test. `ancestor` and
 * `not-ancestor` are the two definitive answers (git exit 0 and 1); everything
 * else (a bad object, a git failure) is `undetermined` and must never collapse
 * to `not-ancestor`.
 */
export type AncestryResult = "ancestor" | "not-ancestor" | "undetermined";

export interface RefreshInput {
  /** Exact bytes of docs/PUBLIC_CLAIMS.json. */
  readonly registryText: string;
  /** One observation per live-evidence entry in the registry. */
  readonly observations: readonly LiveObservation[];
  /** `.revision` reported by GET /version, the revision production is serving. */
  readonly deployedRevision: string;
  /** GET /version `.revision` read BEFORE the observations. */
  readonly versionBefore: string;
  /** GET /version `.revision` read AFTER the observations. */
  readonly versionAfter: string;
  /**
   * Whether `<deployedRevision>` is an ancestor of origin/main. `undetermined`
   * (a git error rather than a definitive answer) must not be read as
   * "not-ancestor"; it refuses with its own reason.
   */
  readonly deployedRevisionIsAncestorOfMain: AncestryResult;
  /**
   * Whether `<currentAuditedRevision>` is an ancestor of `<deployedRevision>`.
   * auditedRevision must only ever move forward: if the current audited revision
   * is not an ancestor of the deployed one, advancing it would move the audit
   * backward (or sideways), so this refuses. `undetermined` (a git error) is
   * distinguished from a definitive `not-ancestor` and refuses with its own
   * reason rather than the backward-move reason.
   */
  readonly auditedRevisionIsAncestorOfDeployed: AncestryResult;
  /** Now, for the future-observation and contract-validation checks. */
  readonly now: Date;
  /**
   * The staleness comparison between the CURRENT auditedRevision and the
   * deployed revision (git diff old..deployed, audited surfaces read at old).
   * If any claim's audited surface changed across that range the move is not
   * truthful and this refuses.
   */
  readonly comparison: ClaimStalenessComparison;
  /** Product requirements, so the produced registry is contract-validated. */
  readonly requirements: ProductRequirementManifest;
  /** Freshness window; defaults to 7 days. */
  readonly freshnessWindowMs?: number;
}

export interface RefreshedChange {
  readonly evidenceId: string;
  readonly observedAt: string;
  readonly freshUntil: string;
  readonly revision: string;
}

export type RefreshOutcome =
  | { readonly status: "refused"; readonly reason: string }
  | {
      readonly status: "refreshed";
      readonly text: string;
      readonly oldRevision: string;
      readonly newRevision: string;
      readonly changes: readonly RefreshedChange[];
    };

interface LiveEntryLine {
  readonly evidenceId: string;
  readonly locator: string;
  readonly lineIndex: number;
}

function refuse(reason: string): RefreshOutcome {
  return { status: "refused", reason };
}

/** Extracts the `"key": "value"` string value from a single JSON line, or null. */
function fieldValue(line: string, key: string): string | null {
  const match = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(line);
  return match ? match[1] : null;
}

/**
 * Replaces the `"key": "value"` string value on a single JSON line, preserving
 * every other byte of the line. Returns null when the key is absent, so an
 * unexpected line shape refuses rather than silently no-ops.
 */
function replaceFieldValue(line: string, key: string, value: string): string | null {
  const pattern = new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`);
  if (!pattern.test(line)) return null;
  return line.replace(pattern, `$1${value}$2`);
}

/**
 * Locates every `type: "live"` evidence entry in the registry text. The registry
 * stores each evidence object on its own single line (see the byte-for-byte
 * formatting contract in docs/PUBLIC_CLAIMS.json), so each live entry maps to
 * exactly one line, identified by its evidence ID appearing with `"type": "live"`.
 * Returns null when the shape is unexpected (an ID on zero or several lines, or
 * without an inline live type) so the caller refuses rather than edit blindly.
 */
function findLiveEntryLines(
  lines: readonly string[],
  liveEvidenceIds: readonly string[],
): LiveEntryLine[] | null {
  const found: LiveEntryLine[] = [];
  for (const evidenceId of liveEvidenceIds) {
    const matches: number[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (
        line.includes(`"id": "${evidenceId}"`) &&
        /"type"\s*:\s*"live"/.test(line)
      ) {
        matches.push(index);
      }
    }
    if (matches.length !== 1) return null;
    const lineIndex = matches[0];
    const locator = fieldValue(lines[lineIndex], "locator");
    if (locator === null) return null;
    found.push({ evidenceId, locator, lineIndex });
  }
  return found;
}

function liveEvidenceIds(registry: PublicClaimRegistry): string[] {
  const ids: string[] = [];
  for (const claim of registry.claims ?? []) {
    for (const evidence of claim.evidence ?? []) {
      if (evidence.type === "live") ids.push(evidence.id);
    }
  }
  return ids;
}

function issuesToReason(prefix: string, issues: readonly PublicClaimIssue[]): string {
  return `${prefix}: ${issues
    .map((issue) => `${issue.code} ${issue.subject}: ${issue.message}`)
    .join("; ")}`;
}

/**
 * Pure core. Given the registry text, the observations, the deployed revision,
 * `now`, and the current-audited-revision-to-deployed staleness comparison,
 * returns the new registry text (with ONLY `auditedRevision` and the live
 * entries' `observedAt`/`freshUntil`/`revision` changed) or a refusal reason.
 * Never touches `lastVerifiedAt` (a human audit claim) or any other byte.
 */
export function refreshLiveEvidence(input: RefreshInput): RefreshOutcome {
  const windowMs = input.freshnessWindowMs ?? SEVEN_DAYS_MS;
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) return refuse("`now` is not a valid date");

  let registry: PublicClaimRegistry;
  try {
    registry = JSON.parse(input.registryText) as PublicClaimRegistry;
  } catch (error) {
    return refuse(`registry is not valid JSON: ${(error as Error).message}`);
  }

  const oldRevision = registry.auditedRevision;
  if (typeof oldRevision !== "string" || !REVISION.test(oldRevision)) {
    return refuse("registry auditedRevision is not a full lowercase Git revision");
  }

  // The deployed revision must be a real, full revision that both /version reads
  // agree on and that is a commit on the shipped line.
  if (!REVISION.test(input.deployedRevision)) {
    return refuse(`deployed revision ${input.deployedRevision} is not a full lowercase Git revision`);
  }
  if (!REVISION.test(input.versionBefore) || !REVISION.test(input.versionAfter)) {
    return refuse("could not read a well-formed revision from /version before and after the observations");
  }
  if (input.versionBefore !== input.versionAfter) {
    return refuse(
      `version changed mid-run: /version reported ${input.versionBefore} before the observations and ${input.versionAfter} after`,
    );
  }
  if (input.deployedRevision !== input.versionBefore) {
    return refuse(
      `deployed revision ${input.deployedRevision} does not equal the revision /version served (${input.versionBefore})`,
    );
  }
  if (input.deployedRevisionIsAncestorOfMain === "undetermined") {
    return refuse(
      `could not determine whether deployed revision ${input.deployedRevision} is an ancestor of origin/main (git error)`,
    );
  }
  if (input.deployedRevisionIsAncestorOfMain !== "ancestor") {
    return refuse(
      `deployed revision ${input.deployedRevision} is not an ancestor of origin/main`,
    );
  }
  // auditedRevision must only ever move forward. If the deployed revision equals
  // the current auditedRevision there is nothing to move; otherwise the current
  // one must be a strict ancestor of the deployed one.
  if (input.deployedRevision !== oldRevision) {
    if (input.auditedRevisionIsAncestorOfDeployed === "undetermined") {
      return refuse(
        `could not determine whether the current auditedRevision ${oldRevision} is an ancestor of the deployed revision ${input.deployedRevision} (git error)`,
      );
    }
    if (input.auditedRevisionIsAncestorOfDeployed !== "ancestor") {
      return refuse(
        `would move auditedRevision backward: ${oldRevision} is not an ancestor of the deployed revision ${input.deployedRevision}`,
      );
    }
  }

  // Truthfulness: moving auditedRevision to the deployed revision only holds if
  // no claim's audited surface changed between the current auditedRevision and
  // the deployed revision. The contract's own staleness machinery decides this.
  const staleIssues = detectStaleClaims(registry, input.comparison);
  if (staleIssues.length > 0) {
    return refuse(
      issuesToReason(
        "claims are surface-stale between the current auditedRevision and the deployed revision; a human must re-audit",
        staleIssues,
      ),
    );
  }

  const expectedIds = liveEvidenceIds(registry).sort();
  const observedIds = input.observations.map((observation) => observation.evidenceId).sort();
  if (
    expectedIds.length !== observedIds.length ||
    expectedIds.some((id, index) => id !== observedIds[index])
  ) {
    return refuse(
      `observations do not match the registry's live evidence: expected [${expectedIds.join(", ")}], got [${observedIds.join(", ")}]`,
    );
  }

  const lines = input.registryText.split("\n");
  const liveLines = findLiveEntryLines(lines, expectedIds);
  if (liveLines === null) {
    return refuse("unexpected registry formatting: a live evidence entry is not on a single identifiable line");
  }
  const liveLineById = new Map(liveLines.map((entry) => [entry.evidenceId, entry] as const));

  const observationById = new Map(
    input.observations.map((observation) => [observation.evidenceId, observation] as const),
  );

  // Every observed instant must be well formed, not in the future, and distinct
  // from the others: distinct millisecond stamps are what make the three
  // observations independent rather than a copied batch stamp.
  const seenObservedAt = new Set<string>();
  const changes: RefreshedChange[] = [];
  for (const evidenceId of expectedIds) {
    const observation = observationById.get(evidenceId)!;
    const entry = liveLineById.get(evidenceId)!;

    if (observation.httpStatus !== 200) {
      return refuse(`live surface ${observation.locator} returned HTTP ${observation.httpStatus}, not 200`);
    }
    if (/\/healthz(?:$|[?#])/.test(entry.locator) && observation.healthzOk !== true) {
      return refuse(`live surface ${observation.locator} did not return JSON ok: true`);
    }
    if (!ISO_TIMESTAMP.test(observation.observedAt)) {
      return refuse(`observedAt ${observation.observedAt} for ${evidenceId} is not a millisecond ISO instant`);
    }
    const observedAtMs = Date.parse(observation.observedAt);
    if (!Number.isFinite(observedAtMs)) {
      return refuse(`observedAt ${observation.observedAt} for ${evidenceId} is not a valid instant`);
    }
    if (observedAtMs > nowMs) {
      return refuse(`observedAt ${observation.observedAt} for ${evidenceId} is in the future`);
    }
    if (seenObservedAt.has(observation.observedAt)) {
      return refuse(
        `observedAt ${observation.observedAt} is shared across observations; each surface must carry its own instant`,
      );
    }
    seenObservedAt.add(observation.observedAt);

    const freshUntil = new Date(observedAtMs + windowMs).toISOString();
    changes.push({
      evidenceId,
      observedAt: observation.observedAt,
      freshUntil,
      revision: input.deployedRevision,
    });
  }

  // Apply the edits by targeted string replacement so every other byte
  // (including all one-line evidence objects, lastVerifiedAt, and whitespace) is
  // preserved exactly.
  const auditedPattern = /("auditedRevision"\s*:\s*")[a-f0-9]{40}(")/;
  if (!auditedPattern.test(input.registryText)) {
    return refuse("unexpected registry formatting: auditedRevision is not a single 40-hex value");
  }
  const editedLines = lines.slice();
  for (const change of changes) {
    const entry = liveLineById.get(change.evidenceId)!;
    let line = editedLines[entry.lineIndex];
    const withObserved = replaceFieldValue(line, "observedAt", change.observedAt);
    const withFresh = withObserved === null ? null : replaceFieldValue(withObserved, "freshUntil", change.freshUntil);
    const withRevision = withFresh === null ? null : replaceFieldValue(withFresh, "revision", change.revision);
    if (withRevision === null) {
      return refuse(`unexpected registry formatting: could not rewrite ${change.evidenceId}`);
    }
    line = withRevision;
    editedLines[entry.lineIndex] = line;
  }
  let newText = editedLines.join("\n");
  newText = newText.replace(auditedPattern, `$1${input.deployedRevision}$2`);

  // Final guard: the produced registry must pass contract validation (this is
  // the pure half of what `npm run claims:check` enforces). Only the IO wrapper
  // (runRefresh) re-runs the full claims check against the written file, and
  // restores the original bytes if it fails.
  let produced: PublicClaimRegistry;
  try {
    produced = JSON.parse(newText) as PublicClaimRegistry;
  } catch (error) {
    return refuse(`produced registry is not valid JSON: ${(error as Error).message}`);
  }
  const contractIssues = validatePublicClaimRegistry(produced, {
    requirements: input.requirements.requirements ?? [],
    asOf: input.now,
  });
  if (contractIssues.length > 0) {
    return refuse(issuesToReason("the refreshed registry would fail the claims check", contractIssues));
  }

  return {
    status: "refreshed",
    text: newText,
    oldRevision,
    newRevision: input.deployedRevision,
    changes,
  };
}

export interface DuenessResult {
  readonly due: boolean;
  readonly force: boolean;
  readonly withinHours: number;
  readonly earliestEvidenceId: string | null;
  readonly earliestFreshUntil: string | null;
  /** Hours from `now` until the earliest live entry expires (negative if past). */
  readonly hoursUntilEarliest: number | null;
}

/**
 * Decides whether a refresh is due: due when `force`, or when the earliest live
 * `freshUntil` is within `withinHours` of `now`. Not due when the earliest live
 * entry is further away than the threshold — the IO wrapper then exits 0 and
 * probes nothing. Pure; reads only the current registry text and the clock value
 * passed in.
 */
export function refreshDueness(
  registryText: string,
  now: Date,
  options: { withinHours: number; force: boolean },
): DuenessResult {
  const nowMs = now.getTime();
  let earliestMs = Number.POSITIVE_INFINITY;
  let earliestEvidenceId: string | null = null;
  let earliestFreshUntil: string | null = null;
  let hasUnparseableFreshUntil = false;
  try {
    const registry = JSON.parse(registryText) as PublicClaimRegistry;
    for (const claim of registry.claims ?? []) {
      for (const evidence of claim.evidence ?? []) {
        if (evidence.type !== "live") continue;
        const ms = Date.parse(evidence.freshUntil);
        if (!Number.isFinite(ms)) {
          // An unparseable freshUntil is treated as DUE, never as "not
          // expiring": the refresh then rewrites it to a well-formed instant or
          // refuses. Skipping it here would let a malformed entry pin the gate
          // red while the scheduler reports "not due" forever.
          hasUnparseableFreshUntil = true;
          continue;
        }
        if (ms < earliestMs) {
          earliestMs = ms;
          earliestEvidenceId = evidence.id;
          earliestFreshUntil = evidence.freshUntil;
        }
      }
    }
  } catch {
    // A registry we cannot parse is treated as due so the refresh path runs and
    // its own JSON refusal reports the real problem, rather than silently
    // reporting "not due" on an unreadable file.
    return {
      due: true,
      force: options.force,
      withinHours: options.withinHours,
      earliestEvidenceId: null,
      earliestFreshUntil: null,
      hoursUntilEarliest: null,
    };
  }

  const hoursUntilEarliest =
    earliestMs === Number.POSITIVE_INFINITY ? null : (earliestMs - nowMs) / (60 * 60 * 1000);
  const withinWindow =
    earliestMs !== Number.POSITIVE_INFINITY &&
    earliestMs - nowMs <= options.withinHours * 60 * 60 * 1000;
  return {
    due: options.force || hasUnparseableFreshUntil || withinWindow,
    force: options.force,
    withinHours: options.withinHours,
    earliestEvidenceId,
    earliestFreshUntil,
    hoursUntilEarliest,
  };
}

// ---------------------------------------------------------------------------
// IO wrapper. Everything below performs HTTP, Git, or filesystem work and is not
// exercised by the pure-core unit tests.
// ---------------------------------------------------------------------------

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", args as string[], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function isAncestor(
  repoRoot: string,
  ancestor: string,
  descendant: string,
): AncestryResult {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return "ancestor";
  } catch (error) {
    // `git merge-base --is-ancestor` exits 1 ONLY when the commit is definitively
    // not an ancestor. Any other exit code (128 for a bad object, a git failure,
    // or a spawn error with no status) leaves ancestry undetermined and must NOT
    // be read as "not an ancestor".
    const status = (error as { status?: number | null }).status;
    return status === 1 ? "not-ancestor" : "undetermined";
  }
}

/**
 * Builds the staleness comparison between the CURRENT auditedRevision and the
 * deployed revision: the changed set is `git diff --name-only old..deployed`
 * (NUL-delimited), and the audited surfaces are read from docs/PUBLIC_CLAIMS.json
 * as it stood at the current auditedRevision. Every branch that cannot yield a
 * trustworthy comparison returns `indeterminate`, which the pure core turns into
 * a refusal rather than a silent pass.
 */
export function buildComparison(
  repoRoot: string,
  oldAuditedRevision: string,
  deployedRevision: string,
): ClaimStalenessComparison {
  if (!REVISION.test(oldAuditedRevision) || !REVISION.test(deployedRevision)) {
    return { status: "indeterminate", reason: "a revision is not a well-formed 40-character Git revision" };
  }
  for (const revision of [oldAuditedRevision, deployedRevision]) {
    try {
      execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], { cwd: repoRoot, stdio: "ignore" });
    } catch {
      return { status: "indeterminate", reason: `revision ${revision} is not a known commit object` };
    }
  }
  let auditedSurfacePathsByClaim: Map<string, readonly string[]>;
  try {
    const raw = git(repoRoot, ["show", `${oldAuditedRevision}:docs/PUBLIC_CLAIMS.json`, "--"]);
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
    auditedSurfacePathsByClaim = byClaim;
  } catch {
    return { status: "indeterminate", reason: "docs/PUBLIC_CLAIMS.json could not be read at the current auditedRevision" };
  }
  let changedPaths: string[];
  try {
    changedPaths = execFileSync(
      "git",
      ["diff", "--name-only", "-z", oldAuditedRevision, deployedRevision, "--"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .split("\0")
      .filter(Boolean);
  } catch {
    return { status: "indeterminate", reason: "diff between the current auditedRevision and the deployed revision failed" };
  }
  return {
    status: "comparable",
    headRevision: deployedRevision,
    changedPaths,
    auditedSurfacePathsByClaim,
  };
}

interface CliOptions {
  withinHours: number;
  force: boolean;
  dryRun: boolean;
  summaryPath: string | null;
  registryPath: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    withinHours: 72,
    force: false,
    dryRun: false,
    summaryPath: null,
    registryPath: "docs/PUBLIC_CLAIMS.json",
  };
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg.startsWith("--if-expiring-within-hours=")) {
      const value = Number(arg.slice("--if-expiring-within-hours=".length));
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`--if-expiring-within-hours must be a non-negative number, got ${arg}`);
      }
      options.withinHours = value;
    } else if (arg.startsWith("--summary=")) options.summaryPath = arg.slice("--summary=".length);
    else if (arg.startsWith("--registry=")) options.registryPath = arg.slice("--registry=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

type FetchLike = (input: string, init?: { redirect?: "manual" }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  clone: () => { json: () => Promise<unknown> };
}>;

async function readVersionRevision(doFetch: FetchLike, origin: string): Promise<string> {
  const response = await doFetch(`${origin}/version`, { redirect: "manual" });
  if (!response.ok) throw new Error(`GET ${origin}/version returned HTTP ${response.status}`);
  const body = (await response.json()) as { revision?: unknown };
  if (typeof body.revision !== "string" || !REVISION.test(body.revision)) {
    throw new Error(`GET ${origin}/version did not return a well-formed .revision`);
  }
  return body.revision;
}

function writeSummary(summaryPath: string | null, summary: Record<string, unknown>): void {
  if (!summaryPath) return;
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

export interface RunRefreshOptions {
  /** Repository root; buildComparison, isAncestor, and file paths resolve here. */
  readonly cwd: string;
  /** CLI arguments (without node/script). */
  readonly argv: readonly string[];
  /** Injectable fetch, so the IO wiring is testable without a network. */
  readonly fetchImpl?: FetchLike;
  /**
   * Injectable post-edit verification (the claims check). Defaults to spawning
   * `node --import tsx scripts/public-claims-check.ts`. Throwing means the check
   * failed, which triggers the restore-and-refuse path.
   */
  readonly verifyClaims?: (repoRoot: string) => void;
}

export interface RunRefreshResult {
  readonly exitCode: number;
  readonly summary: Record<string, unknown>;
}

/**
 * The full IO run: due check, per-surface observation, git comparison, the pure
 * core, and (for a real run) write plus post-edit claims check. Returns the exit
 * code and the summary object rather than touching `process.exitCode`, so it is
 * driven both by the CLI wrapper and by in-process tests with a stub fetch.
 */
export async function runRefresh(opts: RunRefreshOptions): Promise<RunRefreshResult> {
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const repoRoot = resolve(opts.cwd);
  const options = parseArgs(opts.argv);
  const registryPath = resolve(repoRoot, options.registryPath);
  const requirementsPath = resolve(repoRoot, "docs", "PRODUCT_REQUIREMENTS.json");
  if (!existsSync(registryPath)) throw new Error(`${options.registryPath} is missing`);
  if (!existsSync(requirementsPath)) throw new Error("docs/PRODUCT_REQUIREMENTS.json is missing");

  const registryText = readFileSync(registryPath, "utf8");
  const requirements = JSON.parse(readFileSync(requirementsPath, "utf8")) as ProductRequirementManifest;
  const startedAt = new Date();
  const checkedAt = startedAt.toISOString();

  const dueness = refreshDueness(registryText, startedAt, {
    withinHours: options.withinHours,
    force: options.force,
  });

  if (!dueness.due) {
    const summary = {
      checkedAt,
      outcome: "not_due",
      due: false,
      force: dueness.force,
      withinHours: dueness.withinHours,
      dryRun: options.dryRun,
      earliestEvidenceId: dueness.earliestEvidenceId,
      earliestFreshUntil: dueness.earliestFreshUntil,
      hoursUntilEarliest: dueness.hoursUntilEarliest,
      wrote: false,
    };
    writeSummary(options.summaryPath, summary);
    console.log(
      `not due: earliest live evidence ${dueness.earliestEvidenceId ?? "<none>"} expires ${dueness.earliestFreshUntil ?? "<none>"} (` +
        `${dueness.hoursUntilEarliest === null ? "unknown" : dueness.hoursUntilEarliest.toFixed(1)}h away, threshold ${options.withinHours}h)`,
    );
    return { exitCode: 0, summary };
  }

  const registry = JSON.parse(registryText) as PublicClaimRegistry;
  const liveIds = liveEvidenceIds(registry);
  const liveLocators = new Map<string, string>();
  for (const claim of registry.claims ?? []) {
    for (const evidence of claim.evidence ?? []) {
      if (evidence.type === "live") liveLocators.set(evidence.id, evidence.locator);
    }
  }
  if (liveIds.length === 0) throw new Error("registry has no live evidence to refresh");

  const origins = new Set(
    [...liveLocators.values()].map((locator) => new URL(locator).origin),
  );
  if (origins.size !== 1) {
    throw new Error(`live evidence spans multiple origins: ${[...origins].join(", ")}`);
  }
  const origin = [...origins][0];

  const versionBefore = await readVersionRevision(doFetch, origin);

  // One observation per live surface, each with its own instant read from the
  // clock immediately before the request.
  const observations: LiveObservation[] = [];
  for (const evidenceId of liveIds) {
    const locator = liveLocators.get(evidenceId)!;
    const observedAt = new Date().toISOString();
    const response = await doFetch(locator, { redirect: "manual" });
    let healthzOk: boolean | undefined;
    if (/\/healthz(?:$|[?#])/.test(locator)) {
      try {
        const body = (await response.clone().json()) as { ok?: unknown };
        healthzOk = body.ok === true;
      } catch {
        healthzOk = false;
      }
    }
    observations.push({ evidenceId, locator, httpStatus: response.status, observedAt, healthzOk });
  }

  const versionAfter = await readVersionRevision(doFetch, origin);
  // Captured AFTER the observations so a legitimately-later observedAt is not
  // read as "in the future"; observations naturally carry instants after the
  // run started.
  const now = new Date();
  const deployedRevision = versionBefore;
  const comparison = buildComparison(repoRoot, registry.auditedRevision, deployedRevision);
  const deployedRevisionIsAncestorOfMain = isAncestor(repoRoot, deployedRevision, "origin/main");
  const auditedRevisionIsAncestorOfDeployed: AncestryResult =
    deployedRevision === registry.auditedRevision
      ? "ancestor"
      : isAncestor(repoRoot, registry.auditedRevision, deployedRevision);

  const outcome = refreshLiveEvidence({
    registryText,
    observations,
    deployedRevision,
    versionBefore,
    versionAfter,
    deployedRevisionIsAncestorOfMain,
    auditedRevisionIsAncestorOfDeployed,
    now,
    comparison,
    requirements,
  });

  const observationSummary = observations.map((observation) => ({
    evidenceId: observation.evidenceId,
    locator: observation.locator,
    httpStatus: observation.httpStatus,
    observedAt: observation.observedAt,
    healthzOk: observation.healthzOk ?? null,
  }));

  if (outcome.status === "refused") {
    const summary = {
      checkedAt,
      outcome: "refused",
      due: true,
      force: dueness.force,
      withinHours: dueness.withinHours,
      dryRun: options.dryRun,
      refusalReason: outcome.reason,
      oldRevision: registry.auditedRevision,
      deployedRevision,
      versionBefore,
      versionAfter,
      observations: observationSummary,
      wrote: false,
    };
    writeSummary(options.summaryPath, summary);
    console.error(`refused: ${outcome.reason}`);
    return { exitCode: 1, summary };
  }

  const summary: Record<string, unknown> = {
    checkedAt,
    outcome: options.dryRun ? "dry_run" : "refreshed",
    due: true,
    force: dueness.force,
    withinHours: dueness.withinHours,
    dryRun: options.dryRun,
    oldRevision: outcome.oldRevision,
    newRevision: outcome.newRevision,
    deployedRevision,
    versionBefore,
    versionAfter,
    earliestEvidenceId: dueness.earliestEvidenceId,
    earliestFreshUntil: dueness.earliestFreshUntil,
    observations: observationSummary,
    changes: outcome.changes,
    wrote: false,
  };

  if (options.dryRun) {
    writeSummary(options.summaryPath, summary);
    console.log(
      `dry run: would refresh ${outcome.changes.length} live entries and move auditedRevision ${outcome.oldRevision} -> ${outcome.newRevision}; writing nothing`,
    );
    return { exitCode: 0, summary };
  }

  writeFileSync(registryPath, outcome.text, "utf8");
  // After editing, the full claims check must pass; else refuse and restore the
  // original bytes so a refusal writes nothing net.
  const verify =
    opts.verifyClaims ??
    ((root: string) =>
      execFileSync(process.execPath, ["--import", "tsx", "scripts/public-claims-check.ts"], {
        cwd: root,
        stdio: "inherit",
      }));
  try {
    verify(repoRoot);
  } catch (error) {
    writeFileSync(registryPath, registryText, "utf8");
    const refused = {
      ...summary,
      outcome: "refused",
      refusalReason: `claims check failed after editing: ${(error as Error).message}`,
      wrote: false,
    };
    writeSummary(options.summaryPath, refused);
    console.error("refused: claims check failed after editing; restored the original registry");
    return { exitCode: 1, summary: refused };
  }

  const wrote = { ...summary, wrote: true };
  writeSummary(options.summaryPath, wrote);
  console.log(
    `refreshed ${outcome.changes.length} live entries; auditedRevision ${outcome.oldRevision} -> ${outcome.newRevision}`,
  );
  return { exitCode: 0, summary: wrote };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRefresh({ cwd: process.cwd(), argv: process.argv.slice(2) })
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
