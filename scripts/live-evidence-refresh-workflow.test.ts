import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(resolve(root, ".github/workflows/live-evidence-refresh.yml"), "utf8");
const workflow = parse(source) as Record<string, any>;
const job = workflow.jobs.refresh as Record<string, any>;
const steps = job.steps as Record<string, any>[];

function step(name: string): Record<string, any> {
  const found = steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`step not found: ${name}`);
  return found;
}

describe("live-evidence-refresh workflow shape", () => {
  it("runs daily and on manual dispatch with a force input, on main only", () => {
    expect(workflow.on.schedule).toEqual([{ cron: "17 6 * * *" }]);
    expect(workflow.on.workflow_dispatch.inputs.force.type).toBe("boolean");
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job["timeout-minutes"]).toBe(20);
    expect(workflow.concurrency).toMatchObject({
      group: "live-evidence-refresh",
      "cancel-in-progress": false,
    });
  });

  it("reads at the top level and grants only the write scopes it needs at the job", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
      issues: "write",
      actions: "write",
    });
  });

  it("pins every external action by full SHA and checks out full history", () => {
    const uses = steps.filter((s) => s.uses).map((s) => s.uses as string);
    for (const reference of uses) {
      expect(reference).toMatch(/@[0-9a-f]{40}$/);
    }
    expect(uses.length).toBeGreaterThanOrEqual(3);
    const checkout = steps.find((s) => String(s.uses).includes("actions/checkout"))!;
    expect(checkout.with["fetch-depth"]).toBe(0);
  });

  it("never approves or merges", () => {
    expect(source).not.toContain("gh pr review");
    expect(source).not.toContain("gh pr merge");
    expect(source).not.toContain("--approve");
  });

  it("dispatches CI and the closure sweep after opening the PR", () => {
    const act = step("Open a review PR, or a tracking issue, for the refresh");
    expect(act.run).toContain("gh workflow run ci.yml");
    expect(act.run).toContain("gh workflow run closure-authority-systemic-escalation.yml");
    expect(act.run).toContain("--label release-owner:codex");
  });
});

// The Act step's branch/PR/issue logic, run under the exact shell GitHub uses,
// with stubbed gh/git so no network or repository is touched. jq is real.
const GITHUB_BASH_FLAGS = ["--noprofile", "--norc", "-e", "-o", "pipefail"];

const GH_STUB = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$GH_CALL_LOG"',
  'case "$1 $2" in',
  '  "pr list") echo "" ;;',
  '  "issue list") echo "" ;;',
  '  "pr create") exit "${GH_PR_CREATE_EXIT:-0}" ;;',
  "esac",
  "exit 0",
  "",
].join("\n");

const GIT_STUB = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$GIT_CALL_LOG"',
  "exit 0",
  "",
].join("\n");

const REFRESHED_SUMMARY = JSON.stringify({
  outcome: "refreshed",
  oldRevision: "1111111111111111111111111111111111111111",
  newRevision: "2222222222222222222222222222222222222222",
  earliestFreshUntil: "2026-09-30T17:34:44.551Z",
  observations: [
    { evidenceId: "CLM-001-EV01", locator: "https://prod.example.invalid/livez", httpStatus: 200, observedAt: "2026-09-23T17:34:44.551Z", healthzOk: null },
    { evidenceId: "CLM-013-EV02", locator: "https://prod.example.invalid/healthz", httpStatus: 200, observedAt: "2026-09-23T17:34:45.953Z", healthzOk: true },
  ],
  changes: [
    { evidenceId: "CLM-001-EV01", observedAt: "2026-09-23T17:34:44.551Z", freshUntil: "2026-09-30T17:34:44.551Z", revision: "2222222222222222222222222222222222222222" },
    { evidenceId: "CLM-013-EV02", observedAt: "2026-09-23T17:34:45.953Z", freshUntil: "2026-09-30T17:34:45.953Z", revision: "2222222222222222222222222222222222222222" },
  ],
});

function runActStep(summaryJson: string, extraEnv: Record<string, string> = {}): {
  status: number | null;
  gh: string;
  git: string;
} {
  const act = step("Open a review PR, or a tracking issue, for the refresh");
  expect(act.shell).toBe("bash");
  const dir = mkdtempSync(join(tmpdir(), "live-evidence-refresh-"));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const ghLog = join(dir, "gh-calls.log");
  const gitLog = join(dir, "git-calls.log");
  writeFileSync(ghLog, "", "utf8");
  writeFileSync(gitLog, "", "utf8");
  for (const [name, body] of [["gh", GH_STUB], ["git", GIT_STUB]] as const) {
    const path = join(bin, name);
    writeFileSync(path, body, "utf8");
    chmodSync(path, 0o755);
  }
  const summaryPath = join(dir, "refresh-summary.json");
  writeFileSync(summaryPath, summaryJson, "utf8");
  writeFileSync(join(dir, "step.sh"), act.run, "utf8");
  const result = spawnSync("bash", [...GITHUB_BASH_FLAGS, "step.sh"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      GH_CALL_LOG: ghLog,
      GIT_CALL_LOG: gitLog,
      GH_TOKEN: "stub-token",
      GH_REPO: "gondalaimafia/mendpoint",
      SUMMARY: summaryPath,
      RUN_URL: "https://example.invalid/run/1",
      SERVER_URL: "https://github.com",
      GITHUB_OUTPUT: join(dir, "output.txt"),
      GITHUB_STEP_SUMMARY: join(dir, "step-summary.md"),
      ...extraEnv,
    },
  });
  return {
    status: result.status,
    gh: readFileSync(ghLog, "utf8"),
    git: readFileSync(gitLog, "utf8"),
  };
}

describe("live-evidence-refresh Act step under GitHub's shell", () => {
  it("refreshed + PR created: pushes, opens the PR, dispatches CI and the sweep, opens no issue", () => {
    const result = runActStep(REFRESHED_SUMMARY);
    expect(result.status).toBe(0);
    expect(result.git).toContain("push");
    expect(result.gh).toContain("pr create");
    expect(result.gh).toContain("workflow run ci.yml");
    expect(result.gh).toContain("workflow run closure-authority-systemic-escalation.yml");
    expect(result.gh).not.toContain("issue create");
  });

  it("refreshed + PR creation refused: falls back to the tracking issue, still pushes and dispatches", () => {
    const result = runActStep(REFRESHED_SUMMARY, { GH_PR_CREATE_EXIT: "1" });
    expect(result.status).toBe(0);
    expect(result.git).toContain("push");
    expect(result.gh).toContain("issue create");
    expect(result.gh).toContain("workflow run ci.yml");
  });

  it("refused: opens the FAILED issue and fails the job, without pushing", () => {
    const result = runActStep(
      JSON.stringify({ outcome: "refused", refusalReason: "deployed revision is not an ancestor of origin/main" }),
    );
    expect(result.status).toBe(1);
    expect(result.gh).toContain("issue create");
    expect(result.git).not.toContain("push");
  });

  it("not due: does nothing — no push, no issue opened", () => {
    const result = runActStep(JSON.stringify({ outcome: "not_due" }));
    expect(result.status).toBe(0);
    expect(result.git).not.toContain("push");
    expect(result.gh).not.toContain("issue create");
  });
});
