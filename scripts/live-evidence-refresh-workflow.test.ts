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
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const reference of uses) expect(reference).toMatch(/@[0-9a-f]{40}$/);
    const checkout = steps.find((s) => String(s.uses).includes("actions/checkout"))!;
    expect(checkout.with["fetch-depth"]).toBe(0);
  });

  it("uses one fixed branch name, not a dated one", () => {
    const act = step("Open a review PR, or a tracking issue, for the refresh");
    expect(act.run).toContain('BRANCH="bot/live-evidence-refresh"');
    expect(act.run).not.toMatch(/bot\/live-evidence-refresh-\$\(date/);
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

  it("falls back to the issue path only on the specific 403, not any pr-create failure", () => {
    const act = step("Open a review PR, or a tracking issue, for the refresh");
    expect(act.run).toContain('grep -qi "not permitted to create or approve pull requests"');
  });

  it("filters open PRs to same-repo (non-fork) heads on the exact branch", () => {
    const act = step("Open a review PR, or a tracking issue, for the refresh");
    expect(act.run).toContain("isCrossRepository");
    expect(act.run).toContain(".isCrossRepository|not");
    expect(act.run).toContain("isCrossRepository,headRefName");
  });

  it("checks both author and committer email on the branch", () => {
    const act = step("Open a review PR, or a tracking issue, for the refresh");
    expect(act.run).toContain("--format='%ae%n%ce'");
  });

  it("installs an ERR trap so unexpected failures open the FAILED issue", () => {
    const act = step("Open a review PR, or a tracking issue, for the refresh");
    expect(act.run).toContain("set -Eeuo pipefail");
    expect(act.run).toContain("trap 'report_unexpected_failure");
  });
});

// The Act step's branch/PR/issue logic, run under the exact shell GitHub uses,
// with stubbed gh/git so no network or repository is touched. jq is real. The
// stubs are stateful: env vars make gh return an existing open issue / open PR
// and make git report a foreign committer, so the dedup, branch-safety, and
// close paths are exercised.
const GITHUB_BASH_FLAGS = ["--noprofile", "--norc", "-e", "-o", "pipefail"];

const GH_STUB = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$GH_CALL_LOG"',
  'label=""',
  "prev=''",
  'for a in "$@"; do',
  '  if [ "$prev" = "--label" ]; then label="$a"; fi',
  '  prev="$a"',
  "done",
  'case "$1 $2" in',
  '  "issue list")',
  '    case "$label" in',
  '      live-evidence-refresh-failed) [ -n "${STUB_FAILED_ISSUE:-}" ] && echo "$STUB_FAILED_ISSUE" ;;',
  '      live-evidence-refresh-ready) [ -n "${STUB_READY_ISSUE:-}" ] && echo "$STUB_READY_ISSUE" ;;',
  "    esac ;;",
  '  "pr list")',
  '    if [ -n "${STUB_PR_LIST_EXIT:-}" ]; then exit "$STUB_PR_LIST_EXIT"; fi',
  // Apply the workflow's real --jq expression to a fixture dataset with real jq,
  // so the fork/same-repo filter (which lives in that jq string) is exercised —
  // removing it from the source changes what this returns and kills its test.
  '    jqexpr=""; prev="";',
  '    for a in "$@"; do [ "$prev" = "--jq" ] && jqexpr="$a"; prev="$a"; done',
  '    if [ -n "${STUB_PR_LIST_JSON:-}" ]; then data="$STUB_PR_LIST_JSON";',
  '    elif [ -n "${STUB_OPEN_PR:-}" ]; then data="[{\\"number\\":${STUB_OPEN_PR},\\"isCrossRepository\\":false,\\"headRefName\\":\\"bot/live-evidence-refresh\\"}]";',
  '    else data="[]"; fi',
  '    if [ -n "$jqexpr" ]; then printf "%s" "$data" | jq "$jqexpr"; else printf "%s" "$data"; fi ;;',
  '  "pr create")',
  '    if [ "${STUB_PR_CREATE_EXIT:-0}" != "0" ]; then',
  '      if [ -n "${STUB_PR_CREATE_403:-}" ]; then',
  '        echo "pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)" >&2',
  "      else",
  '        echo "pull request create failed: could not resolve to a Repository" >&2',
  "      fi",
  '      exit "$STUB_PR_CREATE_EXIT"',
  "    fi ;;",
  "esac",
  "exit 0",
  "",
].join("\n");

const GIT_STUB = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$GIT_CALL_LOG"',
  'case "$1" in',
  '  ls-remote)',
  '    if [ -n "${STUB_LS_REMOTE_FAIL:-}" ]; then exit 2; fi',
  '    [ -n "${STUB_REMOTE_BRANCH:-}" ] && echo "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef refs/heads/bot/live-evidence-refresh"; exit 0 ;;',
  '  log)',
  '    if [ -n "${STUB_LOG_FAIL:-}" ]; then exit 3; fi',
  // A commit whose AUTHOR is the bot but COMMITTER is a human (an amend/rebase).
  // The committer line is emitted only when the format asks for %ce, so dropping
  // %ce from the source (author-only) hides it and kills its test.
  '    if [ -n "${STUB_COMMITTER_FOREIGN:-}" ]; then',
  '      echo "41898282+github-actions[bot]@users.noreply.github.com";',
  '      printf "%s" "$*" | grep -q "%ce" && echo "$STUB_COMMITTER_FOREIGN";',
  '      exit 0;',
  '    fi',
  // Honour the commit range: only report a foreign author when the real
  // main..origin/branch range is asked for, so an emptied/altered range in the
  // source (a mutation) makes the non-bot branch look bot-only and its test die.
  '    if [ -n "${STUB_FOREIGN:-}" ] && printf "%s" "$*" | grep -q "origin/main[.][.]origin/bot/live-evidence-refresh"; then',
  '      echo "$STUB_FOREIGN";',
  '    else',
  '      echo "41898282+github-actions[bot]@users.noreply.github.com";',
  '    fi; exit 0 ;;',
  '  diff) exit "${STUB_DIFF_EMPTY:-1}" ;;',
  '  push)',
  '    if [ -n "${STUB_PUSH_FAIL:-}" ]; then exit 1; fi',
  '    if [ -n "${STUB_PUSH_LEASE_FAIL:-}" ] && printf "%s" "$*" | grep -q "force-with-lease"; then exit 1; fi',
  '    exit 0 ;;',
  "esac",
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
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "PUBLIC_CLAIMS.json"), "{}\n", "utf8");
  const runnerTemp = join(dir, "runner-temp");
  mkdirSync(runnerTemp, { recursive: true });
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
      RUNNER_TEMP: runnerTemp,
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
  it("refreshed + PR created: pushes a new branch, opens the PR, dispatches, no issue", () => {
    const result = runActStep(REFRESHED_SUMMARY);
    expect(result.status).toBe(0);
    expect(result.git).toContain("push -u origin HEAD:bot/live-evidence-refresh");
    expect(result.gh).toContain("pr create");
    expect(result.gh).toContain("workflow run ci.yml");
    expect(result.gh).toContain("workflow run closure-authority-systemic-escalation.yml");
    expect(result.gh).not.toContain("issue create");
  });

  it("refreshed + closes an open FAILED issue on success", () => {
    const result = runActStep(REFRESHED_SUMMARY, { STUB_FAILED_ISSUE: "7" });
    expect(result.status).toBe(0);
    expect(result.gh).toContain("issue close 7");
  });

  it("refreshed + PR creation refused with the exact 403: opens the READY issue, still pushes and dispatches", () => {
    const result = runActStep(REFRESHED_SUMMARY, { STUB_PR_CREATE_EXIT: "1", STUB_PR_CREATE_403: "1" });
    expect(result.status).toBe(0);
    expect(result.git).toContain("push -u origin HEAD:bot/live-evidence-refresh");
    expect(result.gh).toContain("issue create");
    expect(result.gh).toContain("live-evidence-refresh-ready");
    expect(result.gh).toContain("workflow run ci.yml");
  });

  it("refreshed + a NON-403 pr-create failure fails the job via the FAILED issue, no dispatch", () => {
    const result = runActStep(REFRESHED_SUMMARY, { STUB_PR_CREATE_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(result.gh).toContain("issue create");
    expect(result.gh).toContain("live-evidence-refresh-failed");
    expect(result.gh).not.toContain("live-evidence-refresh-ready");
    expect(result.gh).not.toContain("workflow run");
  });

  it("refreshed + an existing open PR: updates the branch in place, refreshes it, opens no second PR", () => {
    const result = runActStep(REFRESHED_SUMMARY, { STUB_OPEN_PR: "42", STUB_REMOTE_BRANCH: "1" });
    expect(result.status).toBe(0);
    expect(result.gh).not.toContain("pr create");
    // Builds on the reviewer's branch, not main.
    expect(result.git).toContain("checkout -B bot/live-evidence-refresh origin/bot/live-evidence-refresh");
    // Non-force push of a new commit on top of the reviewer's branch.
    expect(result.git).toContain("push origin HEAD:bot/live-evidence-refresh");
    expect(result.git).not.toContain("force");
    // Refreshes the open PR's title/table.
    expect(result.gh).toContain("pr edit 42");
    expect(result.gh).toContain("workflow run ci.yml");
  });

  it("refreshed + an open PR whose branch has non-bot commits: refuses, no push", () => {
    const result = runActStep(REFRESHED_SUMMARY, {
      STUB_OPEN_PR: "42",
      STUB_REMOTE_BRANCH: "1",
      STUB_FOREIGN: "someone-else@example.com",
    });
    expect(result.status).toBe(1);
    expect(result.gh).toContain("issue create");
    expect(result.gh).toContain("live-evidence-refresh-failed");
    expect(result.git).not.toContain("push");
  });

  it("refreshed + remote branch, no open PR, bot-only: resets FROM MAIN and force-with-lease pinned", () => {
    const result = runActStep(REFRESHED_SUMMARY, { STUB_REMOTE_BRANCH: "1" });
    expect(result.status).toBe(0);
    // Built from main, not the old branch tip.
    expect(result.git).toContain("checkout -B bot/live-evidence-refresh main");
    expect(result.git).not.toContain("checkout -B bot/live-evidence-refresh origin/bot/live-evidence-refresh");
    // Lease pinned to the observed remote sha, not a bare --force.
    expect(result.git).toContain(
      "push --force-with-lease=bot/live-evidence-refresh:deadbeefdeadbeefdeadbeefdeadbeefdeadbeef origin HEAD:bot/live-evidence-refresh",
    );
    expect(result.git).not.toMatch(/push --force (?!-with-lease)/);
    // With no open PR it then tries to open one.
    expect(result.gh).toContain("pr create");
  });

  it("refreshed + remote branch, no open PR, has a non-bot commit: refuses, no push", () => {
    const result = runActStep(REFRESHED_SUMMARY, {
      STUB_REMOTE_BRANCH: "1",
      STUB_FOREIGN: "someone-else@example.com",
    });
    expect(result.status).toBe(1);
    expect(result.gh).toContain("issue create");
    expect(result.gh).toContain("live-evidence-refresh-failed");
    expect(result.git).not.toContain("push");
  });

  it("refreshed + gh pr list fails: fails the job, pushes nothing", () => {
    const result = runActStep(REFRESHED_SUMMARY, { STUB_PR_LIST_EXIT: "1", STUB_REMOTE_BRANCH: "1" });
    expect(result.status).toBe(1);
    expect(result.gh).toContain("issue create");
    expect(result.gh).toContain("live-evidence-refresh-failed");
    expect(result.git).not.toContain("push");
    expect(result.gh).not.toContain("pr create");
  });

  it("refreshed + git log fails on the open-PR path: fails the job, no push", () => {
    const result = runActStep(REFRESHED_SUMMARY, {
      STUB_OPEN_PR: "42",
      STUB_REMOTE_BRANCH: "1",
      STUB_LOG_FAIL: "1",
    });
    expect(result.status).toBe(1);
    expect(result.gh).toContain("issue create");
    expect(result.gh).toContain("live-evidence-refresh-failed");
    expect(result.git).not.toContain("push");
  });

  it("refreshed + git log fails on the no-PR reset path: fails the job, no push", () => {
    const result = runActStep(REFRESHED_SUMMARY, { STUB_REMOTE_BRANCH: "1", STUB_LOG_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.gh).toContain("issue create");
    expect(result.gh).toContain("live-evidence-refresh-failed");
    expect(result.git).not.toContain("push");
  });

  it("refreshed + git ls-remote fails (no open PR): fails the job, no push", () => {
    const result = runActStep(REFRESHED_SUMMARY, { STUB_LS_REMOTE_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.gh).toContain("issue create");
    expect(result.gh).toContain("live-evidence-refresh-failed");
    expect(result.git).not.toContain("push");
    expect(result.gh).not.toContain("pr create");
  });

  it("refreshed + a rejected force-with-lease push: routes to the FAILED issue", () => {
    const result = runActStep(REFRESHED_SUMMARY, {
      STUB_REMOTE_BRANCH: "1",
      STUB_PUSH_LEASE_FAIL: "1",
    });
    expect(result.status).toBe(1);
    expect(result.gh).toContain("issue create");
    expect(result.gh).toContain("live-evidence-refresh-failed");
    // It attempted the lease push, then failed the job via the issue.
    expect(result.git).toContain("push --force-with-lease=bot/live-evidence-refresh:");
    expect(result.gh).not.toContain("pr create");
  });

  it("not due + PR lookup fails: does NOT close the READY issue (no resolution on uncertainty)", () => {
    const result = runActStep(JSON.stringify({ outcome: "not_due" }), {
      STUB_PR_LIST_EXIT: "1",
      STUB_READY_ISSUE: "8",
    });
    expect(result.status).toBe(0);
    expect(result.gh).not.toContain("issue close 8");
  });

  it("refreshed + only a FORK PR matches the branch name: treated as none, never edits the fork PR", () => {
    const result = runActStep(REFRESHED_SUMMARY, {
      STUB_PR_LIST_JSON:
        '[{"number":99,"isCrossRepository":true,"headRefName":"bot/live-evidence-refresh"}]',
    });
    expect(result.status).toBe(0);
    // The fork PR is filtered out, so the bot opens its OWN PR and never edits #99.
    expect(result.gh).not.toContain("pr edit");
    expect(result.gh).toContain("pr create");
  });

  it("refreshed + a fork PR newer than the same-repo bot PR: chooses the bot PR", () => {
    const result = runActStep(REFRESHED_SUMMARY, {
      STUB_REMOTE_BRANCH: "1",
      // Fork listed FIRST (newer); a naive .[0] would pick it.
      STUB_PR_LIST_JSON:
        '[{"number":99,"isCrossRepository":true,"headRefName":"bot/live-evidence-refresh"},' +
        '{"number":42,"isCrossRepository":false,"headRefName":"bot/live-evidence-refresh"}]',
    });
    expect(result.status).toBe(0);
    expect(result.gh).toContain("pr edit 42");
    expect(result.gh).not.toContain("pr edit 99");
    expect(result.gh).not.toContain("pr create");
  });

  it("refreshed + two same-repo PRs on the branch: ambiguous, fails the job, no push", () => {
    const result = runActStep(REFRESHED_SUMMARY, {
      STUB_PR_LIST_JSON:
        '[{"number":42,"isCrossRepository":false,"headRefName":"bot/live-evidence-refresh"},' +
        '{"number":43,"isCrossRepository":false,"headRefName":"bot/live-evidence-refresh"}]',
    });
    expect(result.status).toBe(1);
    expect(result.gh).toContain("issue create");
    expect(result.gh).toContain("live-evidence-refresh-failed");
    expect(result.git).not.toContain("push");
  });

  it("refreshed + a commit whose committer is human (bot author): refuses, no push", () => {
    const result = runActStep(REFRESHED_SUMMARY, {
      STUB_OPEN_PR: "42",
      STUB_REMOTE_BRANCH: "1",
      STUB_COMMITTER_FOREIGN: "human@example.com",
    });
    expect(result.status).toBe(1);
    expect(result.gh).toContain("issue create");
    expect(result.gh).toContain("live-evidence-refresh-failed");
    expect(result.git).not.toContain("push");
  });

  it("refreshed + an unexpected push failure: the ERR trap opens the FAILED issue", () => {
    const result = runActStep(REFRESHED_SUMMARY, { STUB_OPEN_PR: "42", STUB_REMOTE_BRANCH: "1", STUB_PUSH_FAIL: "1" });
    expect(result.status).not.toBe(0);
    expect(result.gh).toContain("issue create");
    expect(result.gh).toContain("live-evidence-refresh-failed");
  });

  it("refused + an existing FAILED issue: comments (dedup), never a second issue", () => {
    const result = runActStep(
      JSON.stringify({ outcome: "refused", refusalReason: "deployed revision is not an ancestor of origin/main" }),
      { STUB_FAILED_ISSUE: "9" },
    );
    expect(result.status).toBe(1);
    expect(result.gh).toContain("issue comment 9");
    expect(result.gh).not.toContain("issue create");
    expect(result.git).not.toContain("push");
  });

  it("refused + no existing issue: opens the FAILED issue and fails", () => {
    const result = runActStep(JSON.stringify({ outcome: "refused", refusalReason: "healthz not ok" }));
    expect(result.status).toBe(1);
    expect(result.gh).toContain("issue create");
    expect(result.gh).not.toContain("issue comment");
  });

  it("not due + an open FAILED issue, PR still open: closes FAILED, keeps READY, no push", () => {
    const result = runActStep(JSON.stringify({ outcome: "not_due" }), {
      STUB_FAILED_ISSUE: "5",
      STUB_READY_ISSUE: "8",
      STUB_OPEN_PR: "42",
    });
    expect(result.status).toBe(0);
    expect(result.gh).toContain("issue close 5");
    // A refresh PR is still open, so the READY issue must NOT be closed.
    expect(result.gh).not.toContain("issue close 8");
    expect(result.git).not.toContain("push");
  });

  it("not due + the refresh PR has merged: closes the READY issue too", () => {
    const result = runActStep(JSON.stringify({ outcome: "not_due" }), {
      STUB_READY_ISSUE: "8",
    });
    expect(result.status).toBe(0);
    // No open refresh PR remains, so the READY tracking issue is resolved.
    expect(result.gh).toContain("issue close 8");
  });
});
