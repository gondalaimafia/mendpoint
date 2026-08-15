/** Safety rails for the API bug agent. */

import { DEPENDENCY_DIRECTORIES } from "@mendpoint/shared";

/**
 * Directories a Warden *candidate* scan skips: package caches, VCS metadata, and
 * build outputs that are never source and, on a real customer repo, dwarf the
 * tracked tree (an installed `node_modules` alone can be hundreds of thousands of
 * files).
 *
 * Built from the one shared prune list (`DEPENDENCY_DIRECTORIES` in
 * `@mendpoint/shared`) so this scanner, the codebase index, and the call graph
 * cannot drift apart again. The agent adds `build` / `out` / `target` / `vendor`
 * on top: unlike the pure index walkers, a candidate scan runs over an untracked
 * workspace where these are verifier-generated build output, and it is safe to
 * prune them here only because the candidate scan pairs this set with a
 * `keepDirectories` guard (see `scanTree` in attempt-engine) that preserves any
 * of these directories that the tracked source itself carried. The immutable
 * source scan passes no exclusion at all, so its digest still covers every
 * tracked file.
 */
export const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  ...DEPENDENCY_DIRECTORIES,
  "build",
  "out",
  "target",
  "vendor",
]);

export const DEFAULT_NEVER_TOUCH = [
  ".env",
  ".env.local",
  ".env.production",
  "secrets/",
  "credentials",
  "id_rsa",
  ".pem",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "node_modules/",
  ".git/",
  ".github/",
  ".husky/",
  ".githooks/",
  ".vscode/",
  ".idea/",
  ".npmrc",
  ".yarnrc",
  ".pnpmfile",
  ".gitlab-ci",
];

export function pathBlocked(relPath: string, neverTouch: string[] = DEFAULT_NEVER_TOUCH): boolean {
  const p = relPath.replace(/\\/g, "/").toLowerCase();
  if (p.includes("..")) return true;
  return neverTouch.some((r) => p.includes(r.toLowerCase()));
}

export function verificationControlPath(relPath: string): boolean {
  const path = relPath.replace(/\\/g, "/").toLowerCase();
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  if (parts.some((part) => ["test", "tests", "__tests__", "spec", "specs", "fixtures"].includes(part))) {
    return true;
  }
  return (
    /(?:^|\.)((?:test|spec))\.[a-z0-9]+$/.test(name) ||
    /^check[^/]*\.(?:mjs|cjs|js|ts|py|rb)$/.test(name) ||
    /^(?:package\.json|pytest\.ini|tox\.ini|go\.mod|cargo\.toml|pom\.xml)$/.test(name) ||
    /^(?:vitest|vite|jest|eslint|playwright|cypress|tsconfig)(?:\.[^/]*)?\.(?:js|cjs|mjs|ts|json)$/.test(name)
  );
}

/** Block dangerous shell commands */
export function commandBlocked(cmd: string): boolean {
  const c = cmd.toLowerCase();
  const banned = [
    "rm -rf /",
    "format ",
    "mkfs",
    "dd if=",
    ":(){",
    "curl | sh",
    "wget | sh",
    "shutdown",
    "reboot",
    "reg delete",
    "remove-item -recurse c:\\",
  ];
  return banned.some((b) => c.includes(b));
}

export function isCodeExt(name: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|rb|kt|json|md)$/i.test(name);
}
