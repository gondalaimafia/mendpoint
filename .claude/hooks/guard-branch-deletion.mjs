#!/usr/bin/env node
/**
 * PreToolUse guard: refuse `gh pr merge --delete-branch` while the head branch
 * still has open pull requests based on it.
 *
 * Deleting a head branch makes GitHub auto-close every open PR whose base was
 * that branch. The closure is silent, reads to a later observer as a deliberate
 * rejection, and is IRREVERSIBLE — `gh pr reopen` fails because the base no
 * longer exists, and a closed PR's base cannot be changed. Two reviewed,
 * gate-passing PRs were lost this way in one week and had to be recovered by
 * cherry-picking onto fresh branches.
 *
 * This does not ask the caller to remember the check; it performs the check.
 * See docs/agents/FAILURE_MODES.md section 11 and OPERATING_PROTOCOL.md 14.1.
 *
 * Exit codes: 0 allow, 2 block (stderr is shown to the agent).
 */
import { execFileSync } from "node:child_process";

const payload = await new Promise((resolve) => {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => {
    try {
      resolve(JSON.parse(raw));
    } catch {
      resolve(null);
    }
  });
  // No stdin at all: allow rather than block real work on a harness change.
  setTimeout(() => resolve(null), 2000);
});

const command = payload?.tool_input?.command;
if (typeof command !== "string") process.exit(0);
if (!/\bgh\s+pr\s+merge\b/.test(command)) process.exit(0);
if (!/--delete-branch\b/.test(command)) process.exit(0);

const prMatch = command.match(/\bgh\s+pr\s+merge\s+(\d+)/);
if (!prMatch) {
  // Cannot identify the PR (e.g. merging the current branch's PR implicitly).
  // Refuse rather than guess: an unidentified PR's children cannot be checked,
  // and "could not check" must never read as "no children".
  process.stderr.write(
    "BLOCKED: `gh pr merge --delete-branch` without an explicit PR number.\n" +
      "The stacked-PR child check cannot run, and deleting a head branch silently\n" +
      "and irreversibly closes every PR based on it (FAILURE_MODES.md 11).\n" +
      "Pass the PR number, or merge without --delete-branch and delete after checking.\n",
  );
  process.exit(2);
}

const pr = prMatch[1];
const repoMatch = command.match(/-R\s+(\S+)/);
const repoArgs = repoMatch ? ["-R", repoMatch[1]] : [];

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", timeout: 30_000 }).trim();
}

let head;
try {
  head = gh(["pr", "view", pr, ...repoArgs, "--json", "headRefName", "-q", ".headRefName"]);
} catch (error) {
  process.stderr.write(
    `BLOCKED: could not read PR #${pr}'s head branch (${String(error).slice(0, 120)}).\n` +
      "Without it the stacked-PR child check cannot run, and an unchecked\n" +
      "--delete-branch is irreversible. Retry, or merge without --delete-branch.\n",
  );
  process.exit(2);
}

let children;
try {
  children = gh(["pr", "list", ...repoArgs, "--base", head, "--json", "number,title"]);
} catch (error) {
  process.stderr.write(
    `BLOCKED: could not list PRs based on ${head} (${String(error).slice(0, 120)}).\n` +
      "\"Could not check\" is not \"no children\". Retry, or merge without --delete-branch.\n",
  );
  process.exit(2);
}

let parsed = [];
try {
  parsed = JSON.parse(children);
} catch {
  process.stderr.write("BLOCKED: child-PR listing was unparseable; refusing an irreversible delete.\n");
  process.exit(2);
}

if (parsed.length === 0) process.exit(0);

const listed = parsed.map((child) => `  #${child.number} ${child.title ?? ""}`.trimEnd()).join("\n");
process.stderr.write(
  `BLOCKED: ${parsed.length} open PR(s) are based on ${head}:\n${listed}\n\n` +
    "Deleting this head branch will auto-close them, silently and IRREVERSIBLY\n" +
    "(a closed PR's base cannot be changed, so they cannot be reopened).\n\n" +
    `Do this instead:\n` +
    `  1. gh pr merge ${pr} --squash            # no --delete-branch\n` +
    `  2. gh pr edit <child> --base main        # retarget each child\n` +
    `  3. verify the child's base actually moved, by reading it back\n` +
    `  4. then delete the branch\n` +
    "See docs/agents/FAILURE_MODES.md 11 and OPERATING_PROTOCOL.md 14.1.\n",
);
process.exit(2);
