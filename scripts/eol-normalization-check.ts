/**
 * EOL normalization check — npm run eol:check
 *
 * Guards the one failure mode line-ending normalization keeps producing: a CRLF
 * text blob entering the git index. On a Windows checkout with git's default
 * core.autocrlf=true, any digest-pinned file stored as CRLF checks out as CRLF
 * and hashes wrong, tripping a spurious AUTHORITY_ROTATION_PROTECTED_DIGEST_INVALID.
 * .gitattributes normalizes text files to LF, but nothing FAILED if a CRLF blob
 * slipped in anyway — so this check does.
 *
 * The subtle trap this check is built to survive: git's own text/binary
 * heuristic (`text=auto`, and what `git ls-files --eol` reports in its `i/`
 * column) classifies any file containing a NUL byte as BINARY and skips it.
 * Several TypeScript sources embed a literal NUL in a template-literal key
 * separator, so a heuristic-based check would look right past a fully-CRLF NUL
 * file. This check therefore does NOT trust the NUL heuristic: it decides
 * text-vs-binary from an explicit `-text` attribute and a binary-extension
 * denylist only, then fails on ANY carriage return in a text blob — NUL or not.
 *
 * A file that is genuinely binary but has an extension this check does not know
 * opts out the same way real binaries already do: mark it `-text` in
 * .gitattributes. That is the single, explicit escape hatch; "the heuristic
 * couldn't tell" is never one.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const CR = 0x0d;

/**
 * Extensions whose blobs are binary and may legitimately contain CR bytes.
 * Lowercased, without the leading dot. Anything not listed here and not marked
 * `-text` is treated as text and must be LF-only in the index.
 */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf",
  "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "bmp", "tif", "tiff", "ico", "icns",
  "woff", "woff2", "ttf", "otf", "eot",
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "jar", "war", "ear", "class", "wasm", "node",
  "exe", "dll", "so", "dylib", "bin", "o", "a", "lib",
  "mp3", "mp4", "m4a", "mov", "avi", "webm", "mkv", "ogg", "oga", "ogv", "wav", "flac", "aac",
  "keystore", "jks", "p12", "pfx", "der", "crt", "cer",
  "snap", "br", "zst", "lz4", "parquet", "avro", "pyc",
]);

export type PathClass = "text" | "binary";

/** Lowercased final extension of a path, or "" when it has none. */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * Classify a path as text or binary. `textAttr` is the value git reports for the
 * `text` attribute (`set` | `unset` | `auto` | `unspecified`). Only an explicit
 * `-text` (value `unset`) forces binary; the NUL-fooled `auto`/`unspecified`
 * heuristics never do — extension is the only other binary signal.
 */
export function classifyPath(path: string, textAttr: string): PathClass {
  if (textAttr === "unset") return "binary";
  if (BINARY_EXTENSIONS.has(extensionOf(path))) return "binary";
  return "text";
}

/** True when a blob contains a carriage return (the CRLF/CR marker). */
export function blobHasCr(blob: Buffer): boolean {
  return blob.includes(CR);
}

export type CrlfOffender = Readonly<{ path: string; crCount: number }>;

function git(root: string, args: readonly string[], input?: Buffer): Buffer {
  return execFileSync("git", args, {
    cwd: root,
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Tracked path -> its `text` attribute value, resolved by .gitattributes. */
function textAttributes(root: string, paths: readonly string[]): Map<string, string> {
  const attrs = new Map<string, string>();
  if (!paths.length) return attrs;
  const out = git(root, ["check-attr", "--stdin", "-z", "text"], Buffer.from(paths.join("\0") + "\0"))
    .toString("utf8");
  const fields = out.split("\0");
  // check-attr -z emits repeating (path, attr, value) triples.
  for (let i = 0; i + 2 < fields.length; i += 3) {
    attrs.set(fields[i], fields[i + 2]);
  }
  return attrs;
}

/** index path -> blob sha, for every tracked file (`git ls-files -s`). */
function indexBlobShas(root: string): Map<string, string> {
  const shas = new Map<string, string>();
  const out = git(root, ["ls-files", "-s", "-z"]).toString("utf8");
  for (const entry of out.split("\0")) {
    if (!entry) continue;
    // "<mode> <sha> <stage>\t<path>"
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const meta = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (meta.length >= 2) shas.set(path, meta[1]);
  }
  return shas;
}

/** Blob shas that contain a CR byte, read in one `git cat-file --batch` stream. */
function shasWithCr(root: string, shas: readonly string[]): Set<string> {
  const withCr = new Set<string>();
  if (!shas.length) return withCr;
  const out = git(root, ["cat-file", "--batch"], Buffer.from(shas.join("\n") + "\n"));
  let pos = 0;
  while (pos < out.length) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = out.toString("utf8", pos, nl); // "<sha> <type> <size>"
    pos = nl + 1;
    const parts = header.split(" ");
    if (parts.length < 3) break;
    const sha = parts[0];
    if (parts[1] === "missing") continue;
    const size = Number(parts[parts.length - 1]);
    const content = out.subarray(pos, pos + size);
    if (content.includes(CR)) withCr.add(sha);
    pos += size + 1; // trailing LF after content
  }
  return withCr;
}

/**
 * Every text blob in the index that carries a CR byte. Empty means the index is
 * fully LF-normalized for all text files.
 */
export function scanIndexForCrlf(root = resolve(import.meta.dirname, "..")): CrlfOffender[] {
  const tracked = git(root, ["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean);
  const attrs = textAttributes(root, tracked);
  const textPaths = tracked.filter((path) => classifyPath(path, attrs.get(path) ?? "unspecified") === "text");
  const allBlobShas = indexBlobShas(root);
  const blobShas = new Map<string, string>();
  for (const path of textPaths) {
    const sha = allBlobShas.get(path);
    if (sha) blobShas.set(path, sha);
  }
  const uniqueShas = [...new Set(blobShas.values())];
  const crShas = shasWithCr(root, uniqueShas);

  const offenders: CrlfOffender[] = [];
  for (const path of textPaths) {
    const sha = blobShas.get(path);
    if (sha && crShas.has(sha)) {
      const blob = git(root, ["cat-file", "blob", sha]);
      let crCount = 0;
      for (let i = 0; i < blob.length; i++) if (blob[i] === CR) crCount++;
      offenders.push({ path, crCount });
    }
  }
  offenders.sort((a, b) => a.path.localeCompare(b.path));
  return offenders;
}

function main(): void {
  const offenders = scanIndexForCrlf();
  if (offenders.length) {
    for (const { path, crCount } of offenders) {
      console.error(`${path}: ${crCount} carriage return(s) in the indexed blob`);
    }
    console.error(
      `\nEOL normalization check FAIL: ${offenders.length} text file(s) carry CRLF in the ` +
        `git index. Renormalize with \`git add --renormalize <path>\` (or add a \`text eol=lf\` ` +
        `rule to .gitattributes). A genuinely binary file must be marked \`-text\` instead.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("EOL normalization check passed: no CRLF text blobs in the git index.");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
