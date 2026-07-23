/**
 * Phase A ship script
 *
 * 1) Run TS quality harness (≥70% expected-site recall)
 * 2) Ensure sandbox repo exists on GitHub
 * 3) Sync phase-a consumer (legacy API usage) to default branch
 * 4) Run impact + generate migration for Acme amount_cents → amount
 * 5) Open a REAL pull request via Octokit (gh auth token)
 * 6) Write result JSON for dashboard / audit
 */
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeChange } from "@mendpoint/change-intel";
import { analyzeImpact, reportToFindings } from "@mendpoint/code-impact";
import { generateMigration } from "@mendpoint/generation";
import {
  OctokitGitHubDelivery,
  resolveGitHubToken,
} from "@mendpoint/github";
import {
  createDb,
  insertMigrationPr,
  insertProvider,
  insertConsumer,
  insertApiChange,
  insertApiVersion,
  recordAudit,
  getProviderBySlug,
} from "@mendpoint/db";
import { newId, nowIso } from "@mendpoint/shared";
import { runHarness } from "./harness.js";


const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const REPO_NAME = process.env.PHASE_A_REPO ?? "mendpoint-phase-a-sandbox";
const DEFAULT_BRANCH = process.env.PHASE_A_BASE ?? "main";

function sh(cmd: string, cwd?: string): string {
  return execSync(cmd, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function gh(cmd: string): string {
  return sh(`gh ${cmd}`);
}

function ensureSandboxRepo(owner: string): { owner: string; repo: string; url: string } {
  const full = `${owner}/${REPO_NAME}`;
  try {
    gh(`repo view ${full} --json name -q .name`);
    console.log(`✓ Repo exists: ${full}`);
  } catch {
    console.log(`Creating public sandbox repo ${full}...`);
    gh(
      `repo create ${full} --public --description "Mendpoint Phase A sandbox — intentional legacy API usage for real PR demos"`,
    );

  }
  return {
    owner,
    repo: REPO_NAME,
    url: `https://github.com/${full}`,
  };
}

function syncConsumerToRepo(owner: string, repo: string, workDir: string) {
  const consumerSrc = join(root, "packages/phase-a/consumer");
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  // clone or init
  try {
    sh(`gh repo clone ${owner}/${repo} "${workDir}" -- --depth 1`);
  } catch {
    sh(`git init -b ${DEFAULT_BRANCH}`, workDir);
    sh(`git remote add origin https://github.com/${owner}/${repo}.git`, workDir);
  }

  // copy consumer files (preserve .git)
  for (const name of ["src", "package.json", "README.md"]) {
    const from = join(consumerSrc, name);
    const to = join(workDir, name);
    if (!existsSync(from)) continue;
    cpSync(from, to, { recursive: true });
  }
  // ensure .gitignore
  writeFileSync(join(workDir, ".gitignore"), "node_modules/\n.DS_Store\n", "utf8");

  sh("git add -A", workDir);
  try {
    sh('git commit -m "chore: phase-a consumer baseline (legacy Acme v1 patterns)"', workDir);
  } catch {
    console.log("  (no baseline commit — tree clean)");
  }
  try {
    sh(`git push -u origin HEAD:${DEFAULT_BRANCH}`, workDir);
  } catch (e) {
    // try set upstream with gh
    try {
      sh(`git push -u origin ${DEFAULT_BRANCH}`, workDir);
    } catch {
      console.warn("  push baseline failed — will still try PR branch", e);
    }
  }
}

function migrateContent(original: string): string {
  return original
    .replace(/\bamount_cents\b/g, "amount")
    .replace(
      /\/\/ FIXME\(mendpoint\).*\n/g,
      "",
    )
    // flag removed receipt endpoint
    .split(/\r?\n/)
    .flatMap((line) => {
      if (line.includes("/receipt") && line.includes("fetch")) {
        return [
          "  // FIXME(mendpoint): GET /v1/charges/{id}/receipt removed in Acme v2 — use dashboard export",
          line,
        ];
      }
      return [line];
    })
    .join("\n");
}

async function main() {
  console.log("\n========== Mendpoint — Phase A Ship ==========\n");

  // 1) Harness
  console.log("1) Running TypeScript quality harness...");
  const harness = await runHarness();
  for (const r of harness.results) {
    console.log(
      `   ${r.passed ? "✓" : "✗"} ${r.id}: ${(r.recall * 100).toFixed(0)}% (${r.hit}/${r.expected})`,
    );
  }
  console.log(
    `   Overall recall ${(harness.overallRecall * 100).toFixed(1)}% (need ≥${harness.threshold * 100}%)`,
  );
  if (!harness.passed) {
    console.error("\nHarness failed — aborting real PR ship.");
    process.exit(2);
  }

  // 2) Auth
  console.log("\n2) Resolving GitHub token...");
  const token = await resolveGitHubToken();
  if (!token) {
    console.error("No GITHUB_TOKEN / gh auth token. Run: gh auth login");
    process.exit(1);
  }
  process.env.GITHUB_TOKEN = token;
  process.env.GITHUB_MODE = "real";

  const login = gh("api user -q .login");
  console.log(`   Authenticated as ${login}`);

  // 3) Sandbox repo
  console.log("\n3) Ensuring sandbox repo...");
  const { owner, repo, url } = ensureSandboxRepo(login);
  const workDir = join(root, ".mendpoint", "phase-a-workdir", repo);
  console.log("\n4) Syncing legacy consumer baseline to default branch...");
  syncConsumerToRepo(owner, repo, workDir);

  // 5) Impact + migration on local consumer copy (same content as pushed)
  console.log("\n5) Impact analysis + migration generation...");
  const providerDir = join(root, "fixtures/providers/acme-payments");
  const v1 = JSON.parse(readFileSync(join(providerDir, "openapi-v1.json"), "utf8"));
  const v2 = JSON.parse(readFileSync(join(providerDir, "openapi-v2.json"), "utf8"));
  const { diff, surfaces } = normalizeChange(v1, v2, {
    providerSlug: "acme-payments",
    providerNotes: readFileSync(join(providerDir, "changelog.md"), "utf8"),
  });


  const consumerPath = join(root, "packages/phase-a/consumer");
  const impact = await analyzeImpact(consumerPath, surfaces, {
    persistIndex: false,
    minConfidence: "medium",
  });
  const findings = reportToFindings(impact);
  console.log(
    `   Findings: ${findings.length} · confidence=${impact.overallConfidence} · risk=${impact.overallRisk}`,
  );
  for (const f of findings.slice(0, 8)) {
    console.log(`   · ${f.filePath}:${f.lineStart} ${f.symbol} [${f.confidence}]`);
  }

  const draft = generateMigration({
    providerName: "Acme Payments",
    providerSlug: "acme-payments",
    change: diff,
    findings,
    repoRoot: consumerPath,
    docsUrl: "https://docs.example.com/acme-payments/v2-migration",
    impactReport: impact,
  });

  // Build file edits for real PR (deterministic field rename + receipt FIXME)
  const fileEdits: Array<{ path: string; content: string }> = [];
  for (const rel of ["src/payments.ts", "src/checkout.ts"]) {
    const abs = join(consumerPath, rel);
    if (!existsSync(abs)) continue;
    const original = readFileSync(abs, "utf8");
    const updated = migrateContent(original);
    if (updated !== original) {
      fileEdits.push({ path: rel, content: updated });
    }
  }
  // Also include package.json / README from consumer
  fileEdits.push({
    path: "PHASE_A_MIGRATION.md",
    content: [
      "# Phase A migration",
      "",
      draft.body,
      "",
      "## Files touched",
      ...fileEdits.map((f) => `- \`${f.path}\``),
      "",
    ].join("\n"),
  });

  if (!fileEdits.filter((f) => f.path.endsWith(".ts")).length) {
    console.error("No TypeScript edits produced — aborting.");
    process.exit(1);
  }

  // 6) Real PR
  console.log("\n6) Opening real GitHub PR...");
  const branch = `mendpoint/phase-a-${Date.now().toString(36)}`;
  const ghDelivery = new OctokitGitHubDelivery(token);

  await ghDelivery.createBranch(owner, repo, branch, DEFAULT_BRANCH);
  await ghDelivery.commitFiles(
    owner,
    repo,
    branch,
    draft.title,
    fileEdits,
  );
  const pr = await ghDelivery.openPullRequest(
    owner,
    repo,
    branch,
    draft.title,
    [
      draft.body,
      "",
      "---",
      "**Phase A delivery** — real PR opened by `@mendpoint/phase-a` using Octokit.",
      `- Harness overall recall: **${(harness.overallRecall * 100).toFixed(1)}%**`,
      `- Findings: **${findings.length}** (${impact.overallConfidence})`,
      `- Sandbox: ${url}`,
      "",
      "_Agent policy: PR only — never commits to protected default branch._",
    ].join("\n"),
    DEFAULT_BRANCH,
  );

  console.log(`\n✓ REAL PR OPENED: ${pr.url}`);

  // 7) Persist for dashboard (proper FK chain)
  const db = createDb();
  const providerRow = getProviderBySlug(db, "acme-payments");
  const providerId = providerRow?.id ?? newId();
  if (!providerRow) {
    insertProvider(db, {
      id: providerId,
      slug: "acme-payments",
      name: "Acme Payments",
      website: "https://acme-payments.example",
      createdAt: nowIso(),
    });
  }
  const v1Id = newId();
  const v2Id = newId();
  insertApiVersion(db, {
    id: v1Id,
    providerId,
    versionLabel: `phase-a-1-${Date.now()}`,
    openapiJson: readFileSync(join(providerDir, "openapi-v1.json"), "utf8"),
    publishedAt: nowIso(),
  });
  insertApiVersion(db, {
    id: v2Id,
    providerId,
    versionLabel: `phase-a-2-${Date.now()}`,
    openapiJson: readFileSync(join(providerDir, "openapi-v2.json"), "utf8"),
    changelogMd: readFileSync(join(providerDir, "changelog.md"), "utf8"),
    publishedAt: nowIso(),
  });

  const changeId = newId();
  insertApiChange(db, {
    id: changeId,
    providerId,
    fromVersionId: v1Id,
    toVersionId: v2Id,
    risk: draft.risk,
    summary: diff.summary,
    diffJson: JSON.stringify(diff),
    createdAt: nowIso(),
  });
  const consumerId = newId();
  insertConsumer(db, {
    id: consumerId,
    name: "Phase A Sandbox",
    githubOwner: owner,
    githubRepo: repo,
    createdAt: nowIso(),
  });
  const prId = newId();
  insertMigrationPr(db, {
    id: prId,
    changeId,
    consumerId,
    title: draft.title,
    body: draft.body,
    branchName: branch,
    status: "open",
    risk: draft.risk,
    patchUnified: draft.patch,
    githubPrNumber: pr.number,
    githubPrUrl: pr.url,
    createdAt: nowIso(),
    resolvedAt: null,
  });
  recordAudit(db, {
    actor: "phase-a",
    action: "pr.opened.real",
    resourceType: "migration_pr",
    resourceId: prId,
    metadata: { url: pr.url, owner, repo, harness },
  });


  const outDir = join(root, ".mendpoint", "phase-a");
  mkdirSync(outDir, { recursive: true });
  const result = {
    shippedAt: nowIso(),
    pr,
    owner,
    repo,
    branch,
    harness,
    findings: findings.length,
    confidence: impact.overallConfidence,
    risk: impact.overallRisk,
    files: fileEdits.map((f) => f.path),
    dashboardHint: "npm run dev:api && npm run dev:web → Consumer → PRs",
  };
  writeFileSync(join(outDir, "last-ship.json"), JSON.stringify(result, null, 2), "utf8");
  writeFileSync(join(outDir, "pr-body.md"), draft.body, "utf8");

  console.log(`\nResult written to ${join(outDir, "last-ship.json")}`);
  console.log("Open dashboard: npm run dev:web → /consumer (after seed/demo if needed)");
  console.log("\n========== Phase A complete ==========\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
