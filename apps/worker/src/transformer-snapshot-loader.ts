import {
  lstatSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import {
  listRepositorySnapshots,
  type AppDb,
  type RepositorySnapshotRow,
} from "@mendpoint/db";
import {
  recipeFilesDigest,
  resolveRecipe,
  type ExactSourceSnapshot,
  type RecipeFiles,
  type TransformerAttemptLease,
} from "@mendpoint/transformer";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const REQUIRED_RECIPE_PATH = "package.json";
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function instant(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

function activeSnapshot(
  rows: readonly RepositorySnapshotRow[],
  snapshotId: string,
  revision: string,
  manifestSha256: string,
  observedAtMs: number,
): RepositorySnapshotRow {
  const matching = rows.filter((row) => row.id === snapshotId);
  if (!matching.length) throw new Error("transformer_snapshot_missing");
  if (matching.length !== 1) throw new Error("transformer_snapshot_ambiguous");
  const selected = matching[0]!;
  if (selected.resolved_sha !== revision) {
    throw new Error("transformer_snapshot_revision_mismatch");
  }
  if (!SHA256.test(selected.manifest_sha256)) {
    throw new Error("transformer_snapshot_manifest_invalid");
  }
  if (selected.manifest_sha256 !== manifestSha256) {
    throw new Error("transformer_snapshot_manifest_mismatch");
  }

  if (instant(selected.expires_at, "transformer_snapshot_expiry_invalid") <= observedAtMs) {
    throw new Error("transformer_snapshot_expired");
  }
  return selected;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function statIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function snapshotRoot(path: string): string {
  if (!path.trim() || !isAbsolute(path)) {
    throw new Error("transformer_snapshot_root_invalid");
  }
  let stat: Stats;
  let root: string;
  try {
    stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("transformer_snapshot_root_symlink_forbidden");
    if (!stat.isDirectory()) throw new Error("transformer_snapshot_root_invalid");
    root = realpathSync(resolve(path));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("transformer_snapshot_")) {
      throw error;
    }
    throw new Error("transformer_snapshot_root_invalid");
  }
  return root;
}

function allowedFile(root: string, path: string): { bytes: number; text: string } | undefined {
  const segments = path.split("/");
  let cursor = root;
  for (let index = 0; index < segments.length; index++) {
    cursor = join(cursor, segments[index]!);
    let stat: Stats | undefined;
    try {
      stat = statIfPresent(cursor);
    } catch {
      throw new Error(`transformer_snapshot_source_unreadable:${path}`);
    }
    if (!stat) return undefined;
    if (stat.isSymbolicLink()) {
      throw new Error(`transformer_snapshot_symlink_forbidden:${path}`);
    }
    if (index < segments.length - 1) {
      if (!stat.isDirectory()) {
        throw new Error(`transformer_snapshot_entry_invalid:${path}`);
      }
      continue;
    }
    if (!stat.isFile()) throw new Error(`transformer_snapshot_entry_invalid:${path}`);
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`transformer_snapshot_file_too_large:${path}`);
    }
  }

  let real: string;
  let bytes: Buffer;
  try {
    real = realpathSync(cursor);
    if (!isWithin(root, real)) throw new Error(`transformer_snapshot_path_escape:${path}`);
    bytes = readFileSync(real);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("transformer_snapshot_")) {
      throw error;
    }
    throw new Error(`transformer_snapshot_source_unreadable:${path}`);
  }
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error(`transformer_snapshot_file_too_large:${path}`);
  }
  try {
    const decoded = UTF8.decode(bytes);
    return {
      bytes: bytes.byteLength,
      text: decoded.replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n"),
    };
  } catch {
    throw new Error(`transformer_snapshot_utf8_invalid:${path}`);
  }
}

export function loadTransformerRecipeSnapshot(
  db: AppDb,
  lease: TransformerAttemptLease,
  observedAt: string,
): ExactSourceSnapshot {
  const observedAtMs = instant(observedAt, "transformer_snapshot_observed_at_invalid");
  const recipe = resolveRecipe(lease.recipe);
  if (!recipe.allowedPaths.includes(REQUIRED_RECIPE_PATH)) {
    throw new Error("transformer_snapshot_required_input_not_allowed");
  }

  const row = activeSnapshot(
    listRepositorySnapshots(db, lease.tenantId, lease.snapshot.repositoryId),
    lease.snapshot.snapshotId,
    lease.snapshot.revision,
    lease.snapshot.manifestSha256,
    observedAtMs,
  );
  const root = snapshotRoot(row.storage_path);
  const files: Record<string, string> = {};
  let totalBytes = 0;
  for (const path of recipe.allowedPaths) {
    const loaded = allowedFile(root, path);
    if (!loaded) {
      if (path === REQUIRED_RECIPE_PATH) {
        throw new Error(`transformer_snapshot_required_input_missing:${path}`);
      }
      continue;
    }
    totalBytes += loaded.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("transformer_snapshot_total_too_large");
    }
    files[path] = loaded.text;
  }

  const normalizedFiles: RecipeFiles = Object.freeze(
    Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))),
  );
  if (recipeFilesDigest(normalizedFiles) !== lease.snapshot.digest) {
    throw new Error("transformer_snapshot_source_drift");
  }
  return Object.freeze({
    repositoryId: lease.snapshot.repositoryId,
    revision: lease.snapshot.revision,
    digest: lease.snapshot.digest,
    files: normalizedFiles,
  });
}
