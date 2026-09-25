/**
 * Adoptive draft delivery — the PR #606 redesign state machine (design-606.md).
 *
 * The GitHub branch is the source of truth; the durable ledger only schedules
 * attempts. Identity is (tenant, owner, repo, baseBranch, branch) — never the
 * base sha, body, files, lineage or generation — so a delivery is ONE branch and
 * ONE ledger operation forever, and GitHub's atomic operations serialise every
 * writer (createRef 422-on-exists, updateRef fast-forward-only, one open PR per
 * head/base).
 *
 * Every attempt begins with lookup L (reconcile + the start of execute), then
 * applies the transition table. A late write from a stalled worker only produces
 * a state L handles on the next attempt (a bare branch, our commit, or the single
 * PR), so it is adopted rather than orphaned; nothing ever force-moves or deletes
 * the branch, so no late write diverges it or opens a duplicate.
 *
 * See design §2 (state machine), §7 D2 (422 classification), D3 (commit-then-
 * createRef), D4 (tree-bound three-valued ours()), D6 (base-filtered ADOPT),
 * D7 (close-late-duplicate).
 */
import { createHash } from "node:crypto";
import {
  guardGitHubWrites,
  TENANT_IDENTITY_DELIVERY_ERROR,
} from "./tenant-identity-guard.js";

/** GitHub rejects pull-request bodies longer than this many characters (D2). */
export const MAX_ADOPTIVE_PR_BODY_CHARS = 65_536;

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MENDPOINT_IDENTITY = { name: "Mendpoint", email: "delivery@mendpoint.ai" } as const;
/** Bound on the re-observe loop after a benign 422 before yielding contention. */
const MAX_REOBSERVE_LOOPS = 4;

/** The Octokit surface the adoptive state machine uses (real Octokit or the fake). */
export interface AdoptiveOctokit {
  git: {
    getRef(args: { owner: string; repo: string; ref: string }): Promise<{ data: { object: { sha: string } } }>;
    getCommit(args: { owner: string; repo: string; commit_sha: string }): Promise<{
      data: {
        sha: string;
        message: string;
        tree: { sha: string };
        parents: Array<{ sha: string }>;
        author?: { name?: string; email?: string; date?: string };
        committer?: { name?: string; email?: string; date?: string };
      };
    }>;
    createBlob(args: { owner: string; repo: string; content: string; encoding: string }): Promise<{ data: { sha: string } }>;
    createTree(args: {
      owner: string;
      repo: string;
      base_tree?: string;
      tree: ReadonlyArray<{ path: string; mode: string; type: "blob"; sha: string | null }>;
    }): Promise<{ data: { sha: string } }>;
    createCommit(args: {
      owner: string;
      repo: string;
      message: string;
      tree: string;
      parents: string[];
      author?: { name?: string; email?: string; date?: string };
      committer?: { name?: string; email?: string; date?: string };
    }): Promise<{ data: { sha: string } }>;
    createRef(args: { owner: string; repo: string; ref: string; sha: string }): Promise<unknown>;
    updateRef(args: { owner: string; repo: string; ref: string; sha: string; force?: boolean }): Promise<unknown>;
  };
  pulls: {
    list(args: {
      owner: string;
      repo: string;
      state?: "open" | "closed" | "all";
      head?: string;
      per_page?: number;
      page?: number;
    }): Promise<{ data: RemotePull[] }>;
    create(args: {
      owner: string;
      repo: string;
      title: string;
      head: string;
      base: string;
      body: string;
      draft?: boolean;
    }): Promise<{ data: RemotePull }>;
    update(args: {
      owner: string;
      repo: string;
      pull_number: number;
      title?: string;
      body?: string;
      state?: "open" | "closed";
    }): Promise<{ data: RemotePull }>;
  };
  issues: {
    createComment(args: { owner: string; repo: string; issue_number: number; body: string }): Promise<unknown>;
  };
}

export type RemotePull = {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged?: boolean;
  draft?: boolean | null;
  title: string;
  body?: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  created_at?: string;
};

export type AdoptiveDraftInput = Readonly<{
  owner: string;
  repo: string;
  baseBranch: string;
  /** The base commit the files were generated from (G). A stale G is safe (D3). */
  expectedBaseSha: string;
  branch: string;
  /** Identity of this delivery, K = change:consumer. Bound into the commit trailer. */
  deliveryKey: string;
  /**
   * The tenant this delivery belongs to (#724). When set, the transport is
   * wrapped with the fail-closed tenant-identity guard so no customer-facing
   * write can carry the internal tenant id. The state machine itself never reads
   * it — it only threads the guard onto the transport — so a state-machine unit
   * test may omit it.
   */
  tenantId?: string;
  title: string;
  body: string;
  commitDate: string;
  files: ReadonlyArray<
    | { path: string; content: string; mode: "100644" | "100755" }
    | { path: string; delete: true }
  >;
}>;

/**
 * Write-ahead artifact hook (D5). Invoked once, after the delivery commit's tree
 * and commit objects are built (so treeSha is known) but BEFORE any ref/PR write,
 * so the pipeline can persist {title, body, treeSha, parentSha, deliveryKey}
 * keyed by its body digest before the branch or PR exists.
 */
export type AdoptiveDraftHooks = Readonly<{
  persistArtifact?: (artifact: Readonly<{
    deliveryKey: string;
    title: string;
    body: string;
    bodyDigest: string;
    treeSha: string;
    parentSha: string;
  }>) => void | Promise<void>;
  /**
   * D5: is the (treeSha, parentSha) pair a persisted write-ahead artifact for this
   * delivery? Lets ours() recognise OUR OWN commit from a prior attempt after the
   * base moved (its tree and parent differ from the current attempt's, but it
   * matches an artifact we persisted before writing it — unforgeable without a DB
   * write). Absent hook or false = not ours (foreign).
   */
  isOursArtifact?: (content: Readonly<{ treeSha: string; parentSha: string }>) => boolean | Promise<boolean>;
}>;

/** Options for adoptive draft delivery through a GitHubDelivery transport. */
export type AdoptiveDeliveryOptions = Readonly<{
  /**
   * Resolve the current PR body. Called per attempt so a re-delivery uses the
   * freshly generated body; identity excludes the body and ADOPT converges it,
   * so a different body every attempt is safe (no ledger digest conflict).
   */
  resolveBody: () => string;
  hooks?: AdoptiveDraftHooks;
}>;

export type AdoptiveDraftResult = Readonly<{
  number: number;
  url: string;
  branch: string;
  title: string;
  draft: boolean;
  /** "draft" when open, "closed"/"merged" when a human closed/merged the PR. */
  state: "draft" | "closed" | "merged";
  baseBranch: string;
  /** The base sha the adopted commit descends from (parent of our commit). */
  deliveredBaseSha: string;
  /** The delivery-branch head sha at adoption. */
  deliveredHeadSha: string;
  body: string;
}>;

/**
 * A non-progressing terminal state that needs a human action on GitHub. Reported,
 * never thrown, so the ledger records a named delivery_blocked code (design §4).
 */
export type AdoptiveDraftBlocked = Readonly<{
  kind: "blocked";
  code:
    | "github_delivery_pr_ambiguous"
    | "github_delivery_branch_foreign"
    | "github_delivery_pr_base_mismatch"
    | "github_delivery_artifact_missing"
    | "github_delivery_pr_body_too_long"
    | "github_delivery_base_invalid"
    | "github_delivery_pull_unsupported"
    // The generated branch name is not a valid git ref (a legacy provider slug carrying a
    // git-invalid character): needs a human action (rename the provider slug), so it is a
    // reported, non-retryable delivery_blocked rather than a crash of the pipeline run.
    | "branch_name_invalid"
    // A customer-facing write would carry the internal tenant id (#724). The
    // fail-closed guard refuses the write before it reaches GitHub; a human must
    // fix the leak (a re-render bug), so it is reported, non-retryable and never
    // masqueraded as a transient transport failure.
    | typeof TENANT_IDENTITY_DELIVERY_ERROR;
}>;

export class AdoptiveDraftBlockedError extends Error {
  readonly code: AdoptiveDraftBlocked["code"];
  readonly blocked = true;
  constructor(code: AdoptiveDraftBlocked["code"]) {
    super(code);
    this.code = code;
    this.name = "AdoptiveDraftBlockedError";
  }
}

/** A benign contention state: re-run L on the next attempt (design §2). */
export class AdoptiveDraftContentionError extends Error {
  readonly code = "github_delivery_contention";
  readonly retryable = true;
  constructor() {
    super("github_delivery_contention");
    this.name = "AdoptiveDraftContentionError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

/** The {title, body} artifact digest carried by the commit's Mendpoint-Body trailer. */
export function adoptiveBodyDigest(title: string, body: string): string {
  return sha256(stable({ title, body }));
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

/**
 * D2: classify a 422. Only the three race conditions re-run L; every other 422 is
 * a named, non-retryable blocked state (never masqueraded as contention).
 */
function classify422(error: unknown): "reobserve" | AdoptiveDraftBlocked["code"] {
  if (statusOf(error) !== 422) throw error as Error;
  const message = messageOf(error);
  if (/reference already exists/i.test(message)) return "reobserve";
  if (/not a fast forward/i.test(message)) return "reobserve";
  if (/pull request already exists/i.test(message)) return "reobserve";
  if (/base|no commits between/i.test(message)) return "github_delivery_base_invalid";
  if (/draft.*not|not.*draft/i.test(message)) return "github_delivery_pull_unsupported";
  if (/too long|exceeds/i.test(message)) return "github_delivery_pr_body_too_long";
  return "github_delivery_base_invalid";
}

/** Build the commit message with the identity trailers ours() verifies. */
function commitMessageFor(input: AdoptiveDraftInput, bodyDigest: string): string {
  return `${input.title}\n\nMendpoint-Delivery: ${input.deliveryKey}\nMendpoint-Body: ${bodyDigest}`;
}

function trailer(message: string, key: string): string | undefined {
  for (const line of message.split("\n")) {
    const match = line.match(new RegExp(`^${key}:\\s*(.+)$`));
    if (match) return match[1]!.trim();
  }
  return undefined;
}

async function refHead(
  octokit: AdoptiveOctokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | undefined> {
  try {
    const { data } = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
    const sha = String(data.object.sha ?? "");
    if (!SHA.test(sha)) throw new Error("github_delivery_ref_invalid");
    return sha;
  } catch (error) {
    if (statusOf(error) === 404) return undefined;
    throw error;
  }
}

/** All pulls for the head branch, paginated (design §7 gap: per_page=100, follow pages). */
async function listAllPulls(
  octokit: AdoptiveOctokit,
  input: AdoptiveDraftInput,
): Promise<RemotePull[]> {
  const out: RemotePull[] = [];
  const perPage = 100;
  for (let page = 1; ; page += 1) {
    const { data } = await octokit.pulls.list({
      owner: input.owner,
      repo: input.repo,
      state: "all",
      head: `${input.owner}:${input.branch}`,
      per_page: perPage,
      page,
    });
    out.push(...data);
    if (data.length < perPage) break;
  }
  return out;
}

type Observation = Readonly<{
  open: RemotePull[];
  closed: RemotePull[];
  head: string | undefined;
}>;

/** Lookup L (design §2, steps 1-2): pulls by head (open/closed) + branch head. */
async function observe(octokit: AdoptiveOctokit, input: AdoptiveDraftInput): Promise<Observation> {
  const pulls = await listAllPulls(octokit, input);
  const open = pulls.filter((pull) => pull.head.ref === input.branch && pull.state === "open");
  const closed = pulls.filter((pull) => pull.head.ref === input.branch && pull.state === "closed");
  const head = await refHead(octokit, input.owner, input.repo, input.branch);
  return Object.freeze({ open, closed, head });
}

type OursVerdict = "ours" | "foreign" | "unknown";

/**
 * D4: three-valued, content-bound ours(). A commit is ours iff its Mendpoint
 * trailer names this delivery AND its tree equals the tree we would build AND its
 * sole parent is our base. Unknown when a read failed (retryable, never foreign).
 */
async function oursCommit(
  octokit: AdoptiveOctokit,
  input: AdoptiveDraftInput,
  head: string,
  expectedTreeSha: string,
  isOursArtifact?: AdoptiveDraftHooks["isOursArtifact"],
): Promise<{ verdict: OursVerdict; commit?: { tree: string; parents: string[]; message: string } }> {
  let data: Awaited<ReturnType<AdoptiveOctokit["git"]["getCommit"]>>["data"];
  try {
    ({ data } = await octokit.git.getCommit({ owner: input.owner, repo: input.repo, commit_sha: head }));
  } catch (error) {
    if (statusOf(error) === 404) return { verdict: "foreign" };
    return { verdict: "unknown" };
  }
  const parents = data.parents.map((parent) => parent.sha);
  const commit = { tree: data.tree.sha, parents, message: data.message };
  const trailerOk = trailer(data.message, "Mendpoint-Delivery") === input.deliveryKey && parents.length === 1;
  // The current attempt's exact commit is ours.
  const currentMatch = data.tree.sha === expectedTreeSha && parents[0] === input.expectedBaseSha;
  // C (D8 no-PR legacy): main's exact-draft commit carries the Mendpoint author
  // identity but not our trailer. A Mendpoint-authored commit with our exact tree
  // and base is ours to adopt (open the PR from it), so a main-era branch whose
  // PR creation failed is recovered instead of judged foreign.
  const mendpointAuthored =
    data.author?.name === "Mendpoint" && data.author?.email === "delivery@mendpoint.ai" &&
    data.committer?.name === "Mendpoint" && data.committer?.email === "delivery@mendpoint.ai" &&
    parents.length === 1;
  let isOurs = (trailerOk || mendpointAuthored) && currentMatch;
  // Otherwise, OUR OWN commit from a prior attempt (its tree/parent differ because
  // the base moved) is ours iff its (tree, parent) matches a write-ahead artifact
  // we persisted — an unforgeable DB write. A foreign push (different tree, no
  // matching artifact) stays foreign.
  if (trailerOk && !currentMatch && isOursArtifact) {
    isOurs = await isOursArtifact({ treeSha: data.tree.sha, parentSha: parents[0]! });
  }
  return { verdict: isOurs ? "ours" : "foreign", commit };
}

/** True when `ancestor` is reachable from `head` by walking first parents (bounded). */
async function reachableByFirstParents(
  octokit: AdoptiveOctokit,
  input: AdoptiveDraftInput,
  head: string,
  ancestor: string,
  limit = 200,
): Promise<boolean> {
  let cursor: string | undefined = head;
  for (let step = 0; step < limit && cursor; step += 1) {
    if (cursor === ancestor) return true;
    try {
      const { data } = await octokit.git.getCommit({ owner: input.owner, repo: input.repo, commit_sha: cursor });
      cursor = data.parents[0]?.sha;
    } catch {
      return false;
    }
  }
  return false;
}

function resultFrom(
  input: AdoptiveDraftInput,
  pull: RemotePull,
  state: AdoptiveDraftResult["state"],
  deliveredBaseSha: string,
  deliveredHeadSha: string,
): AdoptiveDraftResult {
  return Object.freeze({
    number: pull.number,
    url: pull.html_url,
    branch: input.branch,
    title: pull.title,
    draft: pull.draft === true,
    state,
    baseBranch: input.baseBranch,
    deliveredBaseSha,
    deliveredHeadSha,
    body: pull.body ?? "",
  });
}

/**
 * ADOPT (design §2 + D6 + D7). Records the open PR after: base filter (only a PR
 * targeting baseBranch is ours to adopt), first-parent walk to our commit for the
 * delivered head/base facts, body convergence when the head is still ours (skip
 * when a human pushed on top), and close-late-duplicate.
 */
async function adopt(
  octokit: AdoptiveOctokit,
  input: AdoptiveDraftInput,
  pull: RemotePull,
  expectedTreeSha: string,
  bodyDigest: string,
  isOursArtifact?: AdoptiveDraftHooks["isOursArtifact"],
): Promise<AdoptiveDraftResult> {
  if (pull.base.ref !== input.baseBranch) {
    throw new AdoptiveDraftBlockedError("github_delivery_pr_base_mismatch");
  }
  const head = pull.head.sha;
  // Walk first parents to the first ours() commit to record delivered facts.
  let deliveredHeadSha = head;
  let deliveredBaseSha = input.expectedBaseSha;
  let headIsOurs = false;
  let cursor: string | undefined = head;
  for (let step = 0; step < 200 && cursor; step += 1) {
    const verdict = await oursCommit(octokit, input, cursor, expectedTreeSha, isOursArtifact);
    if (verdict.verdict === "ours" && verdict.commit) {
      deliveredHeadSha = cursor;
      deliveredBaseSha = verdict.commit.parents[0]!;
      headIsOurs = cursor === head;
      break;
    }
    if (!verdict.commit) break;
    cursor = verdict.commit.parents[0];
  }
  // D6: converge the PR body only when the branch head is still our commit (a
  // human push on top is respected, not overwritten).
  if (headIsOurs) {
    const currentDigest = adoptiveBodyDigest(pull.title, pull.body ?? "");
    if (currentDigest !== bodyDigest) {
      const { data } = await octokit.pulls.update({
        owner: input.owner,
        repo: input.repo,
        pull_number: pull.number,
        title: input.title,
        body: input.body,
      });
      pull = data;
    }
  }
  return resultFrom(input, pull, "draft", deliveredBaseSha, deliveredHeadSha);
}

function closedOutcome(input: AdoptiveDraftInput, closed: RemotePull[]): AdoptiveDraftResult {
  // The oldest closed PR is the recorded delivery outcome; never recreate it.
  const oldest = [...closed].sort((a, b) => (a.number - b.number))[0]!;
  const state: AdoptiveDraftResult["state"] = oldest.merged === true ? "merged" : "closed";
  return resultFrom(input, oldest, state, input.expectedBaseSha, oldest.head.sha);
}

/**
 * Build the delivery commit (blobs, tree from G's tree, commit with parent G and
 * identity trailers). Object writes only — safe and idempotent, they never move a
 * ref or open a PR, so this precedes createRef (D3, commit-then-createRef).
 */
async function buildCommit(
  octokit: AdoptiveOctokit,
  input: AdoptiveDraftInput,
  bodyDigest: string,
): Promise<{ commitSha: string; treeSha: string }> {
  const baseCommit = await octokit.git.getCommit({
    owner: input.owner,
    repo: input.repo,
    commit_sha: input.expectedBaseSha,
  });
  const tree = await Promise.all(input.files.map(async (file) => {
    if ("delete" in file) {
      return { path: file.path, mode: "100644" as const, type: "blob" as const, sha: null };
    }
    const { data: blob } = await octokit.git.createBlob({
      owner: input.owner,
      repo: input.repo,
      content: Buffer.from(file.content, "utf8").toString("base64"),
      encoding: "base64",
    });
    return { path: file.path, mode: file.mode, type: "blob" as const, sha: blob.sha };
  }));
  const { data: createdTree } = await octokit.git.createTree({
    owner: input.owner,
    repo: input.repo,
    base_tree: baseCommit.data.tree.sha,
    tree,
  });
  const identity = { ...MENDPOINT_IDENTITY, date: input.commitDate };
  const { data: commit } = await octokit.git.createCommit({
    owner: input.owner,
    repo: input.repo,
    message: commitMessageFor(input, bodyDigest),
    tree: createdTree.sha,
    parents: [input.expectedBaseSha],
    author: identity,
    committer: identity,
  });
  return { commitSha: commit.sha, treeSha: createdTree.sha };
}

/**
 * Deliver (or reconcile) one adoptive draft. Starts with L, applies the amended
 * transition table in a bounded re-observe loop, and returns the adopted PR (or a
 * closed/merged outcome). Throws AdoptiveDraftBlockedError for a named human-action
 * state and AdoptiveDraftContentionError for benign contention (retry next attempt).
 */
export async function deliverAdoptiveDraftWithOctokit(
  octokit: AdoptiveOctokit,
  input: AdoptiveDraftInput,
  hooks: AdoptiveDraftHooks = {},
): Promise<AdoptiveDraftResult> {
  if (input.body.length > MAX_ADOPTIVE_PR_BODY_CHARS) {
    throw new AdoptiveDraftBlockedError("github_delivery_pr_body_too_long");
  }
  // #724: the single lowest choke point. All three adoptive adapters (mock, PAT,
  // GitHub App) deliver through this function, so wrapping the transport here
  // fails every customer-facing write (branch, commit, file, PR title/body,
  // comment, check-run) closed on a tenant-id leak — object writes in buildCommit
  // included — before it reaches the repo. The guard throws AdoptiveDraftBlockedError
  // so the App outage path classifies it permanent and the pipeline records the
  // named, non-retryable delivery_blocked code.
  const tx = input.tenantId
    ? guardGitHubWrites(octokit, input.tenantId, () =>
        new AdoptiveDraftBlockedError(TENANT_IDENTITY_DELIVERY_ERROR))
    : octokit;
  const bodyDigest = adoptiveBodyDigest(input.title, input.body);
  // Build our commit up front (object writes only). Its tree sha is the content
  // bound into ours(); its sha is the commit createRef/updateRef will point at.
  const built = await buildCommit(tx, input, bodyDigest);
  // D5: persist the write-ahead artifact now — tree/commit objects exist, but no
  // ref or PR has been written yet, so the artifact precedes every side effect.
  if (hooks.persistArtifact) {
    await hooks.persistArtifact({
      deliveryKey: input.deliveryKey,
      title: input.title,
      body: input.body,
      bodyDigest,
      treeSha: built.treeSha,
      parentSha: input.expectedBaseSha,
    });
  }
  let createdNewPull = false;

  for (let loop = 0; loop < MAX_REOBSERVE_LOOPS; loop += 1) {
    const observation = await observe(tx, input);

    if (observation.open.length > 1) throw new AdoptiveDraftBlockedError("github_delivery_pr_ambiguous");
    if (observation.open.length === 1) {
      // D7 (runs on EVERY L, not just after our own create): if an OLDER closed PR
      // exists for the branch, a human closed the original and this open PR is a
      // duplicate (opened by us after a lost create response + a stale pulls.list,
      // possibly on a later attempt). Close the duplicate and record the original's
      // closed outcome — never re-open what a human closed.
      const older = observation.closed.filter((pull) => pull.number < observation.open[0]!.number);
      void createdNewPull;
      if (older.length > 0) {
        await tx.pulls.update({
          owner: input.owner,
          repo: input.repo,
          pull_number: observation.open[0]!.number,
          state: "closed",
        });
        await tx.issues.createComment({
          owner: input.owner,
          repo: input.repo,
          issue_number: observation.open[0]!.number,
          body: "Closing this duplicate; the original delivery pull request already exists.",
        });
        return closedOutcome(input, older);
      }
      return adopt(tx, input, observation.open[0]!, built.treeSha, bodyDigest, hooks.isOursArtifact);
    }
    if (observation.closed.length > 0) return closedOutcome(input, observation.closed);

    // No pull for the branch. Ensure the branch holds our commit, then open a PR.
    if (observation.head === undefined) {
      try {
        await tx.git.createRef({
          owner: input.owner,
          repo: input.repo,
          ref: `refs/heads/${input.branch}`,
          sha: built.commitSha,
        });
      } catch (error) {
        const outcome = classify422(error);
        if (outcome === "reobserve") continue;
        throw new AdoptiveDraftBlockedError(outcome);
      }
      continue;
    }

    const ours = await oursCommit(tx, input, observation.head, built.treeSha, hooks.isOursArtifact);
    if (ours.verdict === "unknown") throw new AdoptiveDraftContentionError();
    if (ours.verdict === "ours") {
      // Open the PR from the commit already on the branch. We never rewrite it, so an
      // adopted main-era or prior-attempt commit keeps its own commit message; only the
      // PR title/body are ours (title/body are the delivery's, the commit is untouched).
      try {
        await tx.pulls.create({
          owner: input.owner,
          repo: input.repo,
          title: input.title,
          head: input.branch,
          base: input.baseBranch,
          body: input.body,
          draft: true,
        });
        createdNewPull = true;
      } catch (error) {
        const outcome = classify422(error);
        if (outcome === "reobserve") continue;
        throw new AdoptiveDraftBlockedError(outcome);
      }
      continue;
    }

    // Foreign head. D3: a legacy bare branch (h an ancestor of our base G) can be
    // fast-forwarded to our commit; anything else is a genuine foreign push.
    if (await reachableByFirstParents(tx, input, input.expectedBaseSha, observation.head)) {
      try {
        await tx.git.updateRef({
          owner: input.owner,
          repo: input.repo,
          ref: `heads/${input.branch}`,
          sha: built.commitSha,
          force: false,
        });
      } catch (error) {
        const outcome = classify422(error);
        if (outcome === "reobserve") continue;
        throw new AdoptiveDraftBlockedError(outcome);
      }
      continue;
    }
    throw new AdoptiveDraftBlockedError("github_delivery_branch_foreign");
  }
  throw new AdoptiveDraftContentionError();
}
