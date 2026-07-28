/**
 * Git temporal backfill — Commit / Author / File nodes + temporal MODIFIES/TOUCHES/AUTHORED.
 * Uses `git log` (no network). valid_from = commit time; valid_to closed on next file touch.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { upsertEdge, upsertNode, type GraphLearnDb } from "./store.js";

export type GitTemporalOptions = {
  /** Path to a git working tree (must contain .git or be a worktree) */
  repoPath: string;
  /** Stable repo id for node scoping (default: basename) */
  repoId?: string;
  /** Lookback window in months (default 12) */
  months?: number;
  /** Cap commits processed (default 2000) */
  maxCommits?: number;
  /** ISO or git since string override */
  since?: string;
  /** Optional branch/ref (default HEAD) */
  ref?: string;
};

export type GitTemporalResult = {
  repoId: string;
  since: string;
  commits: number;
  authors: number;
  files: number;
  edges: number;
  skipped: number;
};

type ParsedCommit = {
  sha: string;
  author: string;
  date: string;
  subject: string;
  files: string[];
};

function runGit(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

function monthsAgoIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

function slugId(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

/** Parse git log --name-only with COMMIT markers. */
export function parseGitLog(raw: string): ParsedCommit[] {
  const lines = raw.split(/\r?\n/);
  const out: ParsedCommit[] = [];
  let cur: ParsedCommit | null = null;
  for (const line of lines) {
    if (line.startsWith("COMMIT\t")) {
      if (cur) out.push(cur);
      const parts = line.split("\t");
      cur = {
        sha: parts[1] ?? "",
        author: parts[2] ?? "unknown",
        date: parts[3] ?? new Date().toISOString(),
        subject: parts.slice(4).join("\t") || "(no subject)",
        files: [],
      };
      continue;
    }
    if (!cur) continue;
    const f = line.trim();
    if (!f) continue;
    cur.files.push(f.replace(/\\/g, "/"));
  }
  if (cur) out.push(cur);
  return out.filter((c) => c.sha.length >= 6);
}

export function backfillGitTemporal(
  db: GraphLearnDb,
  opts: GitTemporalOptions,
): GitTemporalResult {
  const repoPath = resolve(opts.repoPath);
  if (!existsSync(repoPath)) {
    throw new Error(`git-temporal: repo path not found: ${repoPath}`);
  }
  // Allow bare or worktree
  try {
    runGit(repoPath, ["rev-parse", "--git-dir"]);
  } catch {
    throw new Error(`git-temporal: not a git repository: ${repoPath}`);
  }

  const months = opts.months ?? 12;
  const since = opts.since ?? monthsAgoIso(months);
  const maxCommits = opts.maxCommits ?? 2000;
  const ref = opts.ref ?? "HEAD";
  const repoId =
    opts.repoId ??
    slugId(
      runGit(repoPath, ["rev-parse", "--show-toplevel"])
        .trim()
        .split(/[/\\]/)
        .pop() || "repo",
    );

  const raw = runGit(repoPath, [
    "log",
    ref,
    `--since=${since}`,
    `--max-count=${maxCommits}`,
    "--name-only",
    "--pretty=format:COMMIT%x09%H%x09%an%x09%aI%x09%s",
  ]);

  const commits = parseGitLog(raw);
  // Oldest first so we can close valid_to on next touch
  commits.reverse();

  upsertNode(db, {
    id: `repo:${repoId}`,
    kind: "Repository",
    label: repoId,
    repo_id: repoId,
    props: { path: repoPath, since, months },
  });

  const authors = new Set<string>();
  const files = new Set<string>();
  let edges = 0;
  let skipped = 0;

  /** file path → open MODIFIES edge (closed when file is touched again) */
  const openModify = new Map<
    string,
    { edgeId: string; commitId: string; from: string }
  >();
  const openTouch = new Map<
    string,
    { edgeId: string; commitId: string; from: string }
  >();

  for (const c of commits) {
    if (!c.sha) {
      skipped++;
      continue;
    }
    const short = c.sha.slice(0, 12);
    const commitId = `commit:${repoId}:${short}`;
    const authorId = `author:${slugId(c.author)}`;
    authors.add(authorId);

    upsertNode(db, {
      id: commitId,
      kind: "Commit",
      label: c.subject.slice(0, 120),
      repo_id: repoId,
      first_seen: c.date,
      last_seen: c.date,
      props: {
        sha: c.sha,
        author: c.author,
        timestamp: c.date,
        message: c.subject.slice(0, 500),
      },
    });

    upsertNode(db, {
      id: authorId,
      kind: "Author",
      label: c.author,
      repo_id: repoId,
      props: { name: c.author },
    });

    upsertEdge(db, {
      id: `AUTHORED:${commitId}`,
      kind: "AUTHORED",
      source: authorId,
      target: commitId,
      valid_from: c.date,
      valid_to: null,
      source_system: "git",
      confidence: 1,
    });
    edges++;

    upsertEdge(db, {
      id: `INCLUDES_COMMIT:repo:${repoId}:${short}`,
      kind: "INCLUDES_COMMIT",
      source: `repo:${repoId}`,
      target: commitId,
      valid_from: c.date,
      valid_to: null,
      source_system: "git",
      confidence: 1,
    });
    edges++;

    for (const path of c.files.slice(0, 200)) {
      const fileId = `file:${repoId}:${path}`;
      files.add(fileId);
      upsertNode(db, {
        id: fileId,
        kind: "File",
        label: path,
        repo_id: repoId,
        last_seen: c.date,
        props: { path, language: guessLang(path) },
      });

      const prev = openModify.get(path);
      if (prev) {
        upsertEdge(db, {
          id: prev.edgeId,
          kind: "MODIFIES",
          source: prev.commitId,
          target: fileId,
          valid_from: prev.from,
          valid_to: c.date,
          source_system: "git",
          confidence: 1,
        });
      }

      const modId = `MODIFIES:${short}:${path}`.slice(0, 240);
      upsertEdge(db, {
        id: modId,
        kind: "MODIFIES",
        source: commitId,
        target: fileId,
        valid_from: c.date,
        valid_to: null,
        source_system: "git",
        confidence: 1,
      });
      edges++;
      openModify.set(path, { edgeId: modId, commitId, from: c.date });

      const touchId = `TOUCHES:${short}:${path}`.slice(0, 240);
      const previousTouch = openTouch.get(path);
      if (previousTouch) {
        upsertEdge(db, {
          id: previousTouch.edgeId,
          kind: "TOUCHES",
          source: previousTouch.commitId,
          target: fileId,
          valid_from: previousTouch.from,
          valid_to: c.date,
          source_system: "git",
          confidence: 1,
        });
      }
      upsertEdge(db, {
        id: touchId,
        kind: "TOUCHES",
        source: commitId,
        target: fileId,
        valid_from: c.date,
        valid_to: null,
        source_system: "git",
        confidence: 1,
      });
      edges++;
      openTouch.set(path, {
        edgeId: touchId,
        commitId,
        from: c.date,
      });
    }
  }

  return {
    repoId,
    since,
    commits: commits.length,
    authors: authors.size,
    files: files.size,
    edges,
    skipped,
  };
}

function guessLang(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    go: "go",
    java: "java",
    rb: "ruby",
    rs: "rust",
    md: "markdown",
    json: "json",
  };
  return map[ext] ?? (ext || "unknown");
}

/**
 * Seed a tiny synthetic temporal graph (no git) for tests / offline demos.
 */
export function seedSyntheticTemporal(
  db: GraphLearnDb,
  repoId = "demo",
): void {
  const t1 = "2025-01-01T00:00:00.000Z";
  const t2 = "2025-06-01T00:00:00.000Z";
  const t3 = "2026-01-01T00:00:00.000Z";
  upsertNode(db, {
    id: `repo:${repoId}`,
    kind: "Repository",
    label: repoId,
    repo_id: repoId,
  });
  for (const [sha, date, file] of [
    ["aaa111", t1, "src/a.ts"],
    ["bbb222", t2, "src/a.ts"],
    ["ccc333", t3, "src/b.ts"],
  ] as const) {
    const commitId = `commit:${repoId}:${sha}`;
    upsertNode(db, {
      id: commitId,
      kind: "Commit",
      label: `commit ${sha}`,
      repo_id: repoId,
      props: { sha, timestamp: date },
    });
    const fileId = `file:${repoId}:${file}`;
    upsertNode(db, {
      id: fileId,
      kind: "File",
      label: file,
      repo_id: repoId,
      props: { path: file },
    });
    const validTo = sha === "aaa111" ? t2 : null;
    upsertEdge(db, {
      id: `MODIFIES:${sha}:${file}`,
      kind: "MODIFIES",
      source: commitId,
      target: fileId,
      valid_from: date,
      valid_to: validTo,
      source_system: "git",
      confidence: 1,
    });
    // Synthetic CALLS for time_travel_calls
    if (file.endsWith("a.ts")) {
      const sym = `symbol:${repoId}:A`;
      upsertNode(db, {
        id: sym,
        kind: "Symbol",
        label: "A",
        repo_id: repoId,
        props: { qualified_name: "A" },
      });
      upsertEdge(db, {
        id: `CALLS:${sha}:A`,
        kind: "CALLS",
        source: sym,
        target: `symbol:${repoId}:dep`,
        valid_from: date,
        valid_to: validTo,
        source_system: "git",
        confidence: 0.9,
      });
      upsertNode(db, {
        id: `symbol:${repoId}:dep`,
        kind: "Symbol",
        label: "dep",
        repo_id: repoId,
      });
    }
  }
}
