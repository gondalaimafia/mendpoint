import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const CHANGE_GRAPH_AUTHORITY = Object.freeze({
  path: "docs/authority/Mendpoint_CODEX_Change_Graph_Intelligence_Prompt.md",
  sha256: "5a37d827a4a1126ea1323d41bde8cbc5aa6b7ffca843b21895f5f942da8c58cc",
  adrPath: "docs/adr/0005-change-graph-foundational-intelligence.md",
});
export const GRAPHIFY_AUTHORITY = Object.freeze({
  path: "docs/authority/Codex_Master_Prompt_Integrate_Graphify_Into_the_Mendpoint_Change_Graph.md",
  sha256: "1d68a6a76bbed1bc1d92310e193b22505266aab58a73043e83917b8a12d53ba0",
  sourceSha256: "083069e29c6711d309c6af2ed07ae1968a103f18374232a55a493d00ef7105b0",
  adrPath: "docs/adr/0006-graphify-structural-extractor-boundary.md",
});

export function checkChangeGraphAuthority(repoRoot: string): string[] {
  const issues: string[] = [];
  for (const authority of [CHANGE_GRAPH_AUTHORITY, GRAPHIFY_AUTHORITY]) {
    const authorityPath = resolve(repoRoot, authority.path);
    const adrPath = resolve(repoRoot, authority.adrPath);
    if (!existsSync(authorityPath)) {
      issues.push(`authority missing: ${authority.path}`);
    } else {
      const actual = createHash("sha256").update(readFileSync(authorityPath)).digest("hex");
      if (actual !== authority.sha256) {
        issues.push(`authority digest mismatch: expected ${authority.sha256}, actual ${actual}`);
      }
    }
    if (!existsSync(adrPath)) {
      issues.push(`ADR missing: ${authority.adrPath}`);
    } else {
      const adr = readFileSync(adrPath, "utf8");
      const authorityName = authority.path.split("/").at(-1)!;
      if (!adr.includes(`../authority/${authorityName}`)) issues.push(`ADR does not link the checked in authority document: ${authority.adrPath}`);
      if (!adr.includes(authority.sha256)) issues.push(`ADR does not bind the authority digest: ${authority.adrPath}`);
    }
  }
  return issues;
}

function main(): void {
  const issues = checkChangeGraphAuthority(process.cwd());
  if (issues.length) {
    for (const issue of issues) console.error(`CHANGE GRAPH AUTHORITY FAIL: ${issue}`);
    process.exitCode = 1;
    return;
  }
  console.log(`CHANGE GRAPH AUTHORITY PASS: ${CHANGE_GRAPH_AUTHORITY.path} and ${GRAPHIFY_AUTHORITY.path}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
