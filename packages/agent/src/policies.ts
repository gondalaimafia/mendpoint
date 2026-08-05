/** Safety rails for the API bug agent. */

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
