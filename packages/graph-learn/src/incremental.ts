/**
 * Real per-file incremental graph-learn reingest.
 * Only re-processes files whose content hash changed vs snapshot.
 * Target: <30s for typical PR-sized deltas.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import {
  ingestAstFile,
  listCodeFiles,
  type AstIngestResult,
} from "./ast-ingest.js";
import type { GraphLearnDb } from "./store.js";
import { upsertNode } from "./store.js";

export type FileHashSnapshot = {
  repoId: string;
  updatedAt: string;
  /** rel path → content hash */
  hashes: Record<string, string>;
};

export type IncrementalResult = {
  repoId: string;
  changed: string[];
  removed: string[];
  unchanged: number;
  durationMs: number;
  under30s: boolean;
  symbols: number;
  calls: number;
  fullRebuild: boolean;
  ast?: AstIngestResult;
};

function hashContent(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export function loadSnapshot(path: string): FileHashSnapshot | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FileHashSnapshot;
  } catch {
    return null;
  }
}

export function saveSnapshot(path: string, snap: FileHashSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snap, null, 2), "utf8");
}

function fileHash(absPath: string): string | null {
  try {
    return hashContent(readFileSync(absPath, "utf8").slice(0, 500_000));
  } catch {
    return null;
  }
}

/**
 * Per-file incremental reingest.
 * - First run / forceFull: ingest all files and write hashes
 * - Subsequent: only ingestAstFile for changed/new paths; drop hashes for deleted files
 */
export function incrementalReingest(
  db: GraphLearnDb,
  opts: {
    repoPath: string;
    repoId?: string;
    snapshotPath?: string;
    maxFiles?: number;
    forceFull?: boolean;
  },
): IncrementalResult {
  const t0 = Date.now();
  const repoId =
    opts.repoId ??
    opts.repoPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ??
    "repo";
  const snapPath =
    opts.snapshotPath ?? join(opts.repoPath, ".mendpoint", "graph-hash.json");
  const prev = loadSnapshot(snapPath);
  const absFiles = listCodeFiles(opts.repoPath, opts.maxFiles ?? 400);

  const currentHashes: Record<string, string> = {};
  const relToAbs = new Map<string, string>();
  for (const abs of absFiles) {
    const rel = relative(opts.repoPath, abs).replace(/\\/g, "/");
    const h = fileHash(abs);
    if (!h) continue;
    currentHashes[rel] = h;
    relToAbs.set(rel, abs);
  }

  const prevHashes = prev?.hashes ?? {};
  const fullRebuild = opts.forceFull || !prev || prev.repoId !== repoId;

  const changed: string[] = [];
  const removed: string[] = [];

  if (fullRebuild) {
    changed.push(...Object.keys(currentHashes));
  } else {
    for (const [rel, h] of Object.entries(currentHashes)) {
      if (prevHashes[rel] !== h) changed.push(rel);
    }
    for (const rel of Object.keys(prevHashes)) {
      if (!(rel in currentHashes) && rel !== "__gen") removed.push(rel);
    }
  }

  upsertNode(db, {
    id: `repo:${repoId}`,
    kind: "Repository",
    label: repoId,
    repo_id: repoId,
    props: {
      path: opts.repoPath,
      last_incremental: new Date().toISOString(),
      under30s_target: true,
      mode: fullRebuild ? "full" : "delta",
    },
  });

  let symbols = 0;
  let calls = 0;
  for (const rel of changed) {
    const abs = relToAbs.get(rel);
    if (!abs) continue;
    const r = ingestAstFile(db, {
      repoPath: opts.repoPath,
      repoId,
      absPath: abs,
      relPath: rel,
    });
    symbols += r.symbols;
    calls += r.calls;
  }

  // Mark removed files in graph (label only — soft tombstone)
  for (const rel of removed) {
    upsertNode(db, {
      id: `file:${repoId}:${rel}`,
      kind: "File",
      label: rel,
      repo_id: repoId,
      props: { path: rel, deleted: true },
    });
  }

  const snap: FileHashSnapshot = {
    repoId,
    updatedAt: new Date().toISOString(),
    hashes: currentHashes,
  };
  saveSnapshot(snapPath, snap);

  const durationMs = Date.now() - t0;
  const unchanged = Math.max(0, Object.keys(currentHashes).length - changed.length);

  return {
    repoId,
    changed,
    removed,
    unchanged,
    durationMs,
    under30s: durationMs < 30_000,
    symbols,
    calls,
    fullRebuild,
    ast: {
      repoId,
      files: changed.length,
      symbols,
      calls,
      languages: {},
    },
  };
}

/** Test helper: wipe snapshot */
export function clearSnapshot(snapshotPath: string): void {
  try {
    if (existsSync(snapshotPath)) unlinkSync(snapshotPath);
  } catch {
    /* */
  }
}
