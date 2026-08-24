/**
 * Deterministic field-rename recipe — the first production
 * `WardenCampaignExecutionDependencies` for the Fettler campaign executor
 * (§14 deterministic recipes are preferred over generative execution when they
 * are safer, cheaper, and more explainable).
 *
 * It plans and applies a single supported migration class — renaming a field
 * identifier across a repository snapshot — with NO model call. Each planned edit
 * fully encodes the rename (target symbol = old name, postcondition carries the
 * canonical `rename:<from>-><to>` token), so `applyEdits` is self-contained from
 * the edits alone and shares no mutable state with `planEdits`. Deriving WHICH
 * rename applies from the change source is an injected adapter (`deriveRename`),
 * so the pure planning/apply logic is testable without a database and the
 * production adapter can evolve independently.
 */
import { cpSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { openGraphLearnMemory } from "@mendpoint/graph-learn";
import type {
  WardenCampaignExecutionDependencies,
  WardenSourceEnvelope,
  WardenTypedEditStrategy,
} from "@mendpoint/pipeline";

export interface FieldRename {
  readonly from: string;
  readonly to: string;
}

/** Resolve the field rename a change source implies, or null when no supported
 * rename applies (the executor then fails closed on an empty edit set). */
export type DeriveFieldRename = (source: WardenSourceEnvelope) => FieldRename | null;

const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", "dist", "build", "coverage"]);
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".java", ".rb", ".rs",
  ".json", ".yaml", ".yml", ".php", ".cs", ".kt", ".scala",
]);

function isTextFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function identifierPattern(identifier: string): RegExp {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "g");
}

const POSTCONDITION_PREFIX = "rename:";

/** Encode a rename onto an edit's postcondition so applyEdits is self-contained. */
export function encodeRenamePostcondition(rename: FieldRename): string {
  return `${POSTCONDITION_PREFIX}${rename.from}->${rename.to}`;
}

/** Parse the rename target back out of an edit produced by this recipe. */
export function decodeRenamePostcondition(postcondition: string): FieldRename | null {
  if (!postcondition.startsWith(POSTCONDITION_PREFIX)) return null;
  const body = postcondition.slice(POSTCONDITION_PREFIX.length);
  const arrow = body.indexOf("->");
  if (arrow <= 0 || arrow >= body.length - 2) return null;
  return { from: body.slice(0, arrow), to: body.slice(arrow + 2) };
}

function* walkTextFiles(root: string): Generator<string> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkTextFiles(join(root, entry.name));
    } else if (entry.isFile() && isTextFile(entry.name)) {
      yield join(root, entry.name);
    }
  }
}

const toPosix = (value: string): string => value.split(sep).join("/");

/**
 * Plan a rename across a snapshot: one edit per snapshot file that references the
 * old identifier as a whole word. Pure and deterministic (sorted by path). Each
 * edit satisfies the executor's `validateTypedEdits` (kind, relative path,
 * symbol, pre/post/rollback, confidence in [0,1], sourceEvidenceIds includes the
 * source artifact id).
 */
export function planFieldRenameEdits(input: {
  rename: FieldRename;
  sourceArtifactId: string;
  snapshotRoot: string;
}): WardenTypedEditStrategy[] {
  const { rename, sourceArtifactId, snapshotRoot } = input;
  const edits: WardenTypedEditStrategy[] = [];
  for (const absolute of walkTextFiles(snapshotRoot)) {
    const pattern = identifierPattern(rename.from);
    if (!pattern.test(readFileSync(absolute, "utf8"))) continue;
    const targetPath = toPosix(relative(snapshotRoot, absolute));
    edits.push(Object.freeze({
      id: `field-rename:${createHash("sha256").update(`${sourceArtifactId}\0${targetPath}\0${rename.from}\0${rename.to}`).digest("hex").slice(0, 24)}`,
      kind: "typed_recipe",
      targetPath,
      targetSymbol: rename.from,
      sourceEvidenceIds: Object.freeze([sourceArtifactId]),
      precondition: `${targetPath} references identifier ${rename.from}`,
      postcondition: encodeRenamePostcondition(rename),
      rollback: "restore the exact snapshot bytes",
      confidence: 0.95,
    }));
  }
  return edits.sort((left, right) => left.targetPath.localeCompare(right.targetPath));
}

/**
 * Apply planned rename edits into an isolated candidate workspace copied from the
 * snapshot. Self-contained: each edit carries the rename via its postcondition.
 * Returns the shape the executor validates — `baseManifestSha256` echoes the
 * snapshot manifest (the executor requires exact match) and `appliedEditIds`
 * mirrors the input edit ids.
 */
export function applyFieldRenameEdits(input: {
  snapshotRoot: string;
  manifestSha256: string;
  edits: readonly WardenTypedEditStrategy[];
}): Readonly<{ baseManifestSha256: string; candidateRoot: string; candidateContent: string; appliedEditIds: readonly string[] }> {
  const candidateRoot = mkdtempSync(join(tmpdir(), "warden-candidate-"));
  cpSync(input.snapshotRoot, candidateRoot, { recursive: true });
  const changed: string[] = [];
  for (const edit of input.edits) {
    const rename = decodeRenamePostcondition(edit.postcondition);
    if (!rename || edit.targetSymbol !== rename.from) continue;
    const target = join(candidateRoot, ...edit.targetPath.split("/"));
    const before = readFileSync(target, "utf8");
    const after = before.replace(identifierPattern(rename.from), rename.to);
    if (after !== before) {
      writeFileSync(target, after, "utf8");
      changed.push(`${edit.targetPath}:${rename.from}->${rename.to}`);
    }
  }
  return Object.freeze({
    baseManifestSha256: input.manifestSha256,
    candidateRoot,
    candidateContent: changed.sort().join("\n"),
    appliedEditIds: Object.freeze(input.edits.map((edit) => edit.id)),
  });
}

/**
 * Assemble the deterministic field-rename recipe as executor dependencies. The
 * caller supplies `deriveRename` (the change-source adapter); `verify` is left to
 * the executor's default local runner, and the graph db defaults to an ephemeral
 * in-memory store.
 */
export function fieldRenameRecipeDependencies(options: {
  deriveRename: DeriveFieldRename;
  graphDb?: WardenCampaignExecutionDependencies["graphDb"];
}): WardenCampaignExecutionDependencies {
  const graphDb = options.graphDb ?? openGraphLearnMemory();
  return {
    graphDb,
    async planEdits(input) {
      const rename = options.deriveRename(input.source);
      if (!rename) return [];
      return planFieldRenameEdits({
        rename,
        sourceArtifactId: input.source.sourceArtifactId,
        snapshotRoot: input.snapshotRoot,
      });
    },
    async applyEdits(input) {
      return applyFieldRenameEdits({
        snapshotRoot: input.snapshotRoot,
        manifestSha256: input.manifestSha256,
        edits: input.edits,
      });
    },
  };
}
