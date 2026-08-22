import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_CONTENT_CHARS = 16_000;
const MAX_LOCATOR_CHARS = 1_024;

export type VerifierRepositoryExcerpt = Readonly<{
  digest: string;
  locator: string;
  content: string;
}>;

export function buildVerifierRepositoryExcerpt(input: Readonly<{
  candidateWorkspace: string;
  changedPaths: readonly string[];
}>): VerifierRepositoryExcerpt | null {
  const root = realpathSync(input.candidateWorkspace);
  const paths = [...new Set(input.changedPaths)].sort(compareText);
  const includedPaths: string[] = [];
  const sections: string[] = [];
  let usedChars = 0;

  for (const path of paths) {
    validateRepositoryPath(path);
    const target = resolve(root, ...path.split("/"));
    if (!isWithin(root, target)) throw new Error("verifier_repository_excerpt_path_invalid");
    if (!existsSync(target)) continue;
    const info = lstatSync(target);
    if (info.isSymbolicLink()) throw new Error("verifier_repository_excerpt_symlink");
    if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
    const realTarget = realpathSync(target);
    if (!isWithin(root, realTarget)) throw new Error("verifier_repository_excerpt_path_invalid");
    const bytes = readFileSync(realTarget);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    if (text.includes("\uFFFD")) continue;
    const nextLocator = [...includedPaths, path].join(",");
    if (nextLocator.length > MAX_LOCATOR_CHARS) break;
    const header = `[FILE ${path}]\n`;
    const separatorChars = sections.length ? 2 : 0;
    const remaining = MAX_CONTENT_CHARS - usedChars - separatorChars - header.length;
    if (remaining <= 0) break;
    const body = text.length <= remaining ? text : `${text.slice(0, Math.max(0, remaining - 12))}\n[truncated]`;
    const section = `${header}${body}`;
    sections.push(section);
    includedPaths.push(path);
    usedChars += separatorChars + section.length;
    if (text.length > remaining) break;
  }

  if (!sections.length) return null;
  const content = sections.join("\n\n");
  return Object.freeze({
    digest: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    locator: includedPaths.join(","),
    content,
  });
}

function validateRepositoryPath(path: string): void {
  if (typeof path !== "string" || !path || path.includes("\\") || isAbsolute(path) ||
      path.startsWith("/") || path.includes("//") || /[\u0000-\u001f\u007f]/u.test(path) ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("verifier_repository_excerpt_path_invalid");
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
