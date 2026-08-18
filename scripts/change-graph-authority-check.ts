import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const CHANGE_GRAPH_AUTHORITY = Object.freeze({
  path: "docs/authority/Mendpoint_CODEX_Change_Graph_Intelligence_Prompt.md",
  sha256: "5a37d827a4a1126ea1323d41bde8cbc5aa6b7ffca843b21895f5f942da8c58cc",
  adrPath: "docs/adr/0005-change-graph-foundational-intelligence.md",
});

export function checkChangeGraphAuthority(repoRoot: string): string[] {
  const issues: string[] = [];
  const authorityPath = resolve(repoRoot, CHANGE_GRAPH_AUTHORITY.path);
  const adrPath = resolve(repoRoot, CHANGE_GRAPH_AUTHORITY.adrPath);
  if (!existsSync(authorityPath)) {
    issues.push(`authority missing: ${CHANGE_GRAPH_AUTHORITY.path}`);
  } else {
    const actual = createHash("sha256").update(readFileSync(authorityPath)).digest("hex");
    if (actual !== CHANGE_GRAPH_AUTHORITY.sha256) {
      issues.push(`authority digest mismatch: expected ${CHANGE_GRAPH_AUTHORITY.sha256}, actual ${actual}`);
    }
  }
  if (!existsSync(adrPath)) {
    issues.push(`ADR missing: ${CHANGE_GRAPH_AUTHORITY.adrPath}`);
  } else {
    const adr = readFileSync(adrPath, "utf8");
    if (!adr.includes(`../authority/Mendpoint_CODEX_Change_Graph_Intelligence_Prompt.md`)) {
      issues.push("ADR does not link the checked in authority document");
    }
    if (!adr.includes(CHANGE_GRAPH_AUTHORITY.sha256)) {
      issues.push("ADR does not bind the authority digest");
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
  console.log(`CHANGE GRAPH AUTHORITY PASS: ${CHANGE_GRAPH_AUTHORITY.path} @ sha256:${CHANGE_GRAPH_AUTHORITY.sha256}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
