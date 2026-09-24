/**
 * Stateful, content-addressed fake GitHub for the delivery state-machine model
 * test. It is Octokit-shaped (`git.*`, `pulls.*`, `repos.*`, `issues.*`) so it
 * plugs straight into `GitHubAppDelivery` (via the private `octokit` override)
 * and into the adoptive-draft observer/advancer.
 *
 * Semantics modelled from real GitHub, so the model test exercises the same
 * atomicity the production state machine relies on:
 *  - Objects (blobs, trees, commits) are content-addressed by sha256 of their
 *    canonical form, so an identical tree/commit built twice collides on the
 *    same sha (deterministic-commit reconciliation) and a different body/tree
 *    yields a different sha.
 *  - `createRef` throws 422 "Reference already exists" when the branch exists.
 *  - `updateRef({force:false})` throws 422 "Update is not a fast forward"
 *    unless the new commit descends from the current ref (fast-forward only).
 *  - `pulls.create` throws 422 "A pull request already exists" when an OPEN pull
 *    already targets the same (head, base). A PR's `head.sha` is bound to the
 *    branch head AT CREATION, exactly like GitHub.
 *  - `pulls.list` filters by head/base/state and paginates (per_page, page).
 *  - Every ref move is appended to a ref log so the model test can assert refs
 *    only ever move by create or fast-forward (I3).
 *
 * A fault controller turns every method into a yield point: before it applies
 * its effect the fake asks the controller what to do, so a test can fail a call
 * before it lands (503), apply then lose the response (ECONNRESET), or hold the
 * caller until a release is signalled (interleaving). The controller reads the
 * shared virtual clock, so an "outage window" is a clock interval during which
 * calls fail — the same clock the durable queue advances.
 */
import { createHash } from "node:crypto";

export type FakeClock = () => string;

/** What the fault controller decides for one method invocation. */
export type FakeFault =
  | { readonly kind: "pass" }
  | { readonly kind: "fail-before"; readonly status: number; readonly message?: string; readonly code?: string }
  | { readonly kind: "apply-then-lose"; readonly code?: string; readonly status?: number }
  | { readonly kind: "hold"; readonly release: Promise<void>; readonly then?: FakeFault };

export type FakeFaultContext = Readonly<{
  method: string;
  callIndex: number;
  now: string;
  args: Readonly<Record<string, unknown>>;
}>;

export type FakeFaultController = (ctx: FakeFaultContext) => FakeFault;

const PASS: FakeFault = { kind: "pass" };

type BlobObject = { kind: "blob"; content: string };
type TreeEntry = { path: string; mode: string; type: "blob"; sha: string };
type TreeObject = { kind: "tree"; entries: ReadonlyArray<TreeEntry> };
type CommitAuthor = { name?: string; email?: string; date?: string };
type CommitObject = {
  kind: "commit";
  message: string;
  treeSha: string;
  parents: string[];
  author: CommitAuthor;
  committer: CommitAuthor;
};
type GitObject = BlobObject | TreeObject | CommitObject;

export type FakePull = {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  title: string;
  body: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  created_at: string;
};

export type FakeRefLogEntry = Readonly<{
  op: "create" | "update" | "force" | "delete";
  ref: string;
  from: string | null;
  to: string;
  at: string;
  fastForward: boolean;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function githubError(status: number, message: string, code?: string): Error {
  const error = new Error(message) as Error & { status: number; code?: string };
  error.status = status;
  if (code) error.code = code;
  return error;
}

/**
 * One repository's mutable content-addressed state. `owner/repo` scoped stores
 * live in the FakeGitHub map so a test can drive several repositories.
 */
class FakeRepo {
  readonly objects = new Map<string, GitObject>();
  readonly branches = new Map<string, string>();
  readonly pulls: FakePull[] = [];
  readonly comments: Array<{ issue: number; body: string }> = [];
  readonly refLog: FakeRefLogEntry[] = [];
  private pullCounter = 0;

  store(object: GitObject): string {
    const sha = sha256(JSON.stringify(object));
    if (!this.objects.has(sha)) this.objects.set(sha, object);
    return sha;
  }

  commit(sha: string): CommitObject | undefined {
    const object = this.objects.get(sha);
    return object?.kind === "commit" ? object : undefined;
  }

  /** True when `ancestor` is `descendant` or reachable through its parents. */
  isAncestor(ancestor: string, descendant: string): boolean {
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length) {
      const current = stack.pop()!;
      if (current === ancestor) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.commit(current);
      if (commit) stack.push(...commit.parents);
    }
    return false;
  }

  nextPullNumber(): number {
    this.pullCounter += 1;
    return this.pullCounter;
  }
}

export type FakeGitHubOptions = Readonly<{
  clock?: FakeClock;
  faults?: FakeFaultController;
}>;

export class FakeGitHub {
  private readonly repoStore = new Map<string, FakeRepo>();
  private readonly clock: FakeClock;
  private controller: FakeFaultController;
  private callIndex = 0;

  constructor(options: FakeGitHubOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.controller = options.faults ?? (() => PASS);
  }

  /** Replace the fault controller mid-run (the scheduler drives one worker's faults). */
  setFaults(controller: FakeFaultController): void {
    this.controller = controller;
  }

  private repo(owner: string, name: string): FakeRepo {
    const key = `${owner}\u0000${name}`;
    let repo = this.repoStore.get(key);
    if (!repo) {
      repo = new FakeRepo();
      this.repoStore.set(key, repo);
    }
    return repo;
  }

  /** Seed a repository's default branch at a real commit and return its sha. */
  seedDefaultBranch(input: Readonly<{
    owner: string;
    repo: string;
    branch: string;
    content: Readonly<Record<string, string>>;
    message?: string;
    date?: string;
  }>): string {
    const repo = this.repo(input.owner, input.repo);
    const entries: TreeEntry[] = Object.entries(input.content)
      .map(([path, content]) => ({ path, mode: "100644", type: "blob" as const, sha: repo.store({ kind: "blob", content }) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const treeSha = repo.store({ kind: "tree", entries });
    const identity = { name: "Seed", email: "seed@mendpoint.ai", date: input.date ?? this.clock() };
    const commitSha = repo.store({
      kind: "commit",
      message: input.message ?? "seed",
      treeSha,
      parents: [],
      author: identity,
      committer: identity,
    });
    repo.branches.set(input.branch, commitSha);
    return commitSha;
  }

  /**
   * Register a base commit at a caller-chosen sha (not content-addressed) and
   * point a branch at it. Used by MockGitHubDelivery so the pipeline's resolved
   * base sha (a git/content digest, not a fake sha) is a real commit the adoptive
   * machine can build a tree and commit against. Idempotent.
   */
  registerBase(input: Readonly<{
    owner: string;
    repo: string;
    branch: string;
    sha: string;
    content?: Readonly<Record<string, string>>;
    date?: string;
  }>): void {
    const repo = this.repo(input.owner, input.repo);
    if (!repo.objects.has(input.sha)) {
      const entries: TreeEntry[] = Object.entries(input.content ?? {})
        .map(([path, content]) => ({ path, mode: "100644", type: "blob" as const, sha: repo.store({ kind: "blob", content }) }))
        .sort((a, b) => a.path.localeCompare(b.path));
      const treeSha = repo.store({ kind: "tree", entries });
      const identity = { name: "Base", email: "base@mendpoint.ai", date: input.date ?? this.clock() };
      repo.objects.set(input.sha, {
        kind: "commit",
        message: "base",
        treeSha,
        parents: [],
        author: identity,
        committer: identity,
      });
    }
    if (!repo.branches.has(input.branch)) repo.branches.set(input.branch, input.sha);
  }

  /** Move the default (or any) branch head to a fresh commit; scheduler-driven. */
  moveBranch(input: Readonly<{
    owner: string;
    repo: string;
    branch: string;
    content: Readonly<Record<string, string>>;
    message?: string;
    date?: string;
  }>): string {
    return this.seedDefaultBranch(input);
  }

  /** Direct head read for assertions (no fault yield point). */
  refHead(owner: string, repo: string, branch: string): string | undefined {
    return this.repo(owner, repo).branches.get(branch);
  }

  refLog(owner: string, repo: string): ReadonlyArray<FakeRefLogEntry> {
    return this.repo(owner, repo).refLog;
  }

  openPulls(owner: string, repo: string, branch: string): FakePull[] {
    return this.repo(owner, repo).pulls.filter(
      (pull) => pull.head.ref === branch && pull.state === "open",
    );
  }

  allPulls(owner: string, repo: string): ReadonlyArray<FakePull> {
    return this.repo(owner, repo).pulls;
  }

  comments(owner: string, repo: string): ReadonlyArray<{ issue: number; body: string }> {
    return this.repo(owner, repo).comments;
  }

  /** Human actor: close a pull the way a reviewer would in the GitHub UI. */
  humanClosePull(owner: string, repo: string, number: number): void {
    const pull = this.repo(owner, repo).pulls.find((candidate) => candidate.number === number);
    if (pull) pull.state = "closed";
  }

  /** Human actor: edit a pull's body. */
  humanEditPullBody(owner: string, repo: string, number: number, body: string): void {
    const pull = this.repo(owner, repo).pulls.find((candidate) => candidate.number === number);
    if (pull) pull.body = body;
  }

  /**
   * Human actor: push a commit ON TOP of the branch's current head (so it stays a
   * descendant), advancing both the branch ref and the pull's head sha the way
   * GitHub does. Used to test that ADOPT does not overwrite a human's push.
   */
  humanCommitOnto(input: Readonly<{
    owner: string;
    repo: string;
    branch: string;
    prNumber: number;
    content: Readonly<Record<string, string>>;
  }>): string {
    const repo = this.repo(input.owner, input.repo);
    const parent = repo.branches.get(input.branch)!;
    const entries: TreeEntry[] = Object.entries(input.content)
      .map(([path, content]) => ({ path, mode: "100644", type: "blob" as const, sha: repo.store({ kind: "blob", content }) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const treeSha = repo.store({ kind: "tree", entries });
    const identity = { name: "Human", email: "human@example.com", date: this.clock() };
    const sha = repo.store({ kind: "commit", message: "human push", treeSha, parents: [parent], author: identity, committer: identity });
    repo.branches.set(input.branch, sha);
    const pull = repo.pulls.find((candidate) => candidate.number === input.prNumber);
    if (pull) pull.head.sha = sha;
    return sha;
  }

  /** Yield point: consult the controller, then apply `work` (possibly losing the response). */
  private async yield<T>(
    method: string,
    args: Readonly<Record<string, unknown>>,
    work: () => T,
  ): Promise<T> {
    let fault = this.controller({ method, callIndex: this.callIndex++, now: this.clock(), args });
    while (fault.kind === "hold") {
      await fault.release;
      fault = fault.then ?? PASS;
    }
    if (fault.kind === "fail-before") {
      throw githubError(fault.status, fault.message ?? `fake_github_${method}_failed`, fault.code);
    }
    const result = work();
    if (fault.kind === "apply-then-lose") {
      throw githubError(fault.status ?? 0, "fake_github_response_lost", fault.code ?? "ECONNRESET");
    }
    return result;
  }

  // --- Octokit-shaped surface -------------------------------------------------

  readonly git = {
    getRef: (args: { owner: string; repo: string; ref: string }) =>
      this.yield("git.getRef", args, () => {
        const branch = args.ref.replace(/^(refs\/)?heads\//, "");
        const sha = this.repo(args.owner, args.repo).branches.get(branch);
        if (sha === undefined) throw githubError(404, "Not Found");
        return { data: { object: { sha } } };
      }),

    getCommit: (args: { owner: string; repo: string; commit_sha: string }) =>
      this.yield("git.getCommit", args, () => {
        const commit = this.repo(args.owner, args.repo).commit(args.commit_sha);
        if (!commit) throw githubError(404, "Not Found");
        return {
          data: {
            sha: args.commit_sha,
            message: commit.message,
            tree: { sha: commit.treeSha },
            parents: commit.parents.map((sha) => ({ sha })),
            author: commit.author,
            committer: commit.committer,
          },
        };
      }),

    getTree: (args: { owner: string; repo: string; tree_sha: string; recursive?: string }) =>
      this.yield("git.getTree", args, () => {
        const object = this.repo(args.owner, args.repo).objects.get(args.tree_sha);
        if (!object || object.kind !== "tree") throw githubError(404, "Not Found");
        return { data: { truncated: false, tree: object.entries.map((entry) => ({ ...entry })) } };
      }),

    createBlob: (args: { owner: string; repo: string; content: string; encoding: string }) =>
      this.yield("git.createBlob", args, () => {
        const content = args.encoding === "base64"
          ? Buffer.from(args.content, "base64").toString("utf8")
          : args.content;
        return { data: { sha: this.repo(args.owner, args.repo).store({ kind: "blob", content }) } };
      }),

    createTree: (args: {
      owner: string;
      repo: string;
      base_tree?: string;
      tree: ReadonlyArray<{ path: string; mode: string; type: string; sha: string | null }>;
    }) =>
      this.yield("git.createTree", args, () => {
        const repo = this.repo(args.owner, args.repo);
        const merged = new Map<string, TreeEntry>();
        if (args.base_tree) {
          const base = repo.objects.get(args.base_tree);
          if (base?.kind === "tree") for (const entry of base.entries) merged.set(entry.path, { ...entry });
        }
        for (const entry of args.tree) {
          if (entry.sha === null) merged.delete(entry.path);
          else merged.set(entry.path, { path: entry.path, mode: entry.mode, type: "blob", sha: entry.sha });
        }
        const entries = [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
        return { data: { sha: repo.store({ kind: "tree", entries }) } };
      }),

    createCommit: (args: {
      owner: string;
      repo: string;
      message: string;
      tree: string;
      parents: string[];
      author?: CommitAuthor;
      committer?: CommitAuthor;
    }) =>
      this.yield("git.createCommit", args, () => {
        const sha = this.repo(args.owner, args.repo).store({
          kind: "commit",
          message: args.message,
          treeSha: args.tree,
          parents: [...args.parents],
          author: args.author ?? {},
          committer: args.committer ?? args.author ?? {},
        });
        return { data: { sha } };
      }),

    createRef: (args: { owner: string; repo: string; ref: string; sha: string }) =>
      this.yield("git.createRef", args, () => {
        const repo = this.repo(args.owner, args.repo);
        const branch = args.ref.replace(/^refs\/heads\//, "");
        if (repo.branches.has(branch)) {
          throw githubError(422, "Reference already exists");
        }
        repo.branches.set(branch, args.sha);
        repo.refLog.push({ op: "create", ref: branch, from: null, to: args.sha, at: this.clock(), fastForward: true });
        return { data: { ref: args.ref, object: { sha: args.sha } } };
      }),

    updateRef: (args: { owner: string; repo: string; ref: string; sha: string; force?: boolean }) =>
      this.yield("git.updateRef", args, () => {
        const repo = this.repo(args.owner, args.repo);
        const branch = args.ref.replace(/^(refs\/)?heads\//, "");
        const current = repo.branches.get(branch) ?? null;
        const fastForward = current !== null && repo.isAncestor(current, args.sha);
        if (args.force !== true && current !== null && !fastForward) {
          throw githubError(422, "Update is not a fast forward");
        }
        repo.branches.set(branch, args.sha);
        repo.refLog.push({
          op: args.force === true && !fastForward ? "force" : "update",
          ref: branch,
          from: current,
          to: args.sha,
          at: this.clock(),
          fastForward,
        });
        return { data: { ref: args.ref, object: { sha: args.sha } } };
      }),
  };

  readonly repos = {
    getContent: (args: { owner: string; repo: string; path: string; ref: string }) =>
      this.yield("repos.getContent", args, () => {
        const repo = this.repo(args.owner, args.repo);
        const commitSha = repo.branches.get(args.ref.replace(/^(refs\/)?heads\//, "")) ?? args.ref;
        const commit = repo.commit(commitSha);
        if (!commit) throw githubError(404, "Not Found");
        const tree = repo.objects.get(commit.treeSha);
        const entry = tree?.kind === "tree" ? tree.entries.find((candidate) => candidate.path === args.path) : undefined;
        if (!entry) throw githubError(404, "Not Found");
        const blob = repo.objects.get(entry.sha);
        if (!blob || blob.kind !== "blob") throw githubError(404, "Not Found");
        return {
          data: {
            type: "file",
            encoding: "base64",
            content: Buffer.from(blob.content, "utf8").toString("base64"),
          },
        };
      }),

    get: (args: { owner: string; repo: string }) =>
      this.yield("repos.get", args, () => ({
        data: { id: 1, owner: { login: args.owner }, name: args.repo, default_branch: "main" },
      })),

    compareCommitsWithBasehead: (args: { owner: string; repo: string; basehead: string }) =>
      this.yield("repos.compareCommitsWithBasehead", args, () => {
        const repo = this.repo(args.owner, args.repo);
        const [base, head] = args.basehead.split("...");
        const identical = base === head;
        const ahead = !identical && repo.isAncestor(base!, head!);
        const behind = !identical && repo.isAncestor(head!, base!);
        return {
          data: {
            status: identical ? "identical" : ahead ? "ahead" : behind ? "behind" : "diverged",
          },
        };
      }),
  };

  readonly pulls = {
    list: (args: {
      owner: string;
      repo: string;
      state?: "open" | "closed" | "all";
      head?: string;
      base?: string;
      per_page?: number;
      page?: number;
    }) =>
      this.yield("pulls.list", args, () => {
        const repo = this.repo(args.owner, args.repo);
        const headRef = args.head ? args.head.split(":").slice(-1)[0] : undefined;
        const matched = repo.pulls.filter((pull) =>
          (args.state === undefined || args.state === "all" || pull.state === args.state) &&
          (headRef === undefined || pull.head.ref === headRef) &&
          (args.base === undefined || pull.base.ref === args.base));
        const perPage = args.per_page ?? (matched.length || 1);
        const page = args.page ?? 1;
        const start = (page - 1) * perPage;
        return { data: matched.slice(start, start + perPage).map((pull) => ({ ...pull })) };
      }),

    create: (args: {
      owner: string;
      repo: string;
      title: string;
      head: string;
      base: string;
      body: string;
      draft?: boolean;
    }) =>
      this.yield("pulls.create", args, () => {
        const repo = this.repo(args.owner, args.repo);
        const headRef = args.head.split(":").slice(-1)[0]!;
        const headSha = repo.branches.get(headRef);
        if (headSha === undefined) throw githubError(422, "Head sha can't be blank; No commits between base and head");
        if (repo.branches.get(args.base) === undefined) {
          throw githubError(422, "Base ref must be a branch; invalid base");
        }
        if (repo.pulls.some((pull) => pull.state === "open" && pull.head.ref === headRef && pull.base.ref === args.base)) {
          throw githubError(422, "A pull request already exists");
        }
        const number = repo.nextPullNumber();
        const pull: FakePull = {
          number,
          html_url: `https://github.com/${args.owner}/${args.repo}/pull/${number}`,
          state: "open",
          merged: false,
          draft: args.draft === true,
          title: args.title,
          body: args.body,
          head: { ref: headRef, sha: headSha },
          base: { ref: args.base, sha: repo.branches.get(args.base)! },
          created_at: this.clock(),
        };
        repo.pulls.push(pull);
        return { data: { ...pull } };
      }),

    update: (args: {
      owner: string;
      repo: string;
      pull_number: number;
      title?: string;
      body?: string;
      state?: "open" | "closed";
    }) =>
      this.yield("pulls.update", args, () => {
        const repo = this.repo(args.owner, args.repo);
        const pull = repo.pulls.find((candidate) => candidate.number === args.pull_number);
        if (!pull) throw githubError(404, "Not Found");
        if (args.title !== undefined) pull.title = args.title;
        if (args.body !== undefined) pull.body = args.body;
        if (args.state !== undefined) pull.state = args.state;
        return { data: { ...pull } };
      }),
  };

  readonly issues = {
    createComment: (args: { owner: string; repo: string; issue_number: number; body: string }) =>
      this.yield("issues.createComment", args, () => {
        this.repo(args.owner, args.repo).comments.push({ issue: args.issue_number, body: args.body });
        return { data: { id: 1 } };
      }),
  };

  /** `octokit.paginate` shim over `pulls.list` for the paginated lookup L. */
  async paginate(
    endpoint: unknown,
    params: { owner: string; repo: string; state?: "open" | "closed" | "all"; head?: string; base?: string; per_page?: number },
  ): Promise<FakePull[]> {
    void endpoint;
    const out: FakePull[] = [];
    let page = 1;
    for (;;) {
      const { data } = await this.pulls.list({ ...params, page, per_page: params.per_page ?? 100 });
      out.push(...data);
      if (data.length < (params.per_page ?? 100)) break;
      page += 1;
    }
    return out;
  }
}
