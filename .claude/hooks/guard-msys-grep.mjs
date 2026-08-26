#!/usr/bin/env node
/**
 * PreToolUse guard: refuse a `git grep` whose pattern MSYS will silently mangle.
 *
 * On this Windows/Git Bash host, MSYS path conversion rewrites arguments that
 * look like paths before git sees them. A pattern containing an equals sign
 * followed by a quote and a slash matches that rule, so git searches for a
 * rewritten string and reports ZERO MATCHES — indistinguishable from an honest
 * absence, and "nothing references this" is exactly the sort of negative that
 * gets acted on: code deleted, a feature declared unlinked, an audit closed.
 *
 * `-F` does not avoid it. `MSYS_NO_PATHCONV=1` does.
 *
 * This produced four near-miss false findings in a single session, including one
 * where a missing entry would have "proven" a live deployment path did not
 * exist. See docs/agents/FAILURE_MODES.md sections 6 and 15.
 *
 * Exit codes: 0 allow, 2 block (stderr is shown to the agent).
 */

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
  // No stdin: allow rather than block real work on a harness change.
  setTimeout(() => resolve(null), 2000);
});

const command = payload?.tool_input?.command;
if (typeof command !== "string") process.exit(0);

// Only git grep is affected in the way that produces a silent empty result.
if (!/\bgit\s+grep\b/.test(command)) process.exit(0);

// Already guarded anywhere in the command line.
if (/MSYS_NO_PATHCONV\s*=\s*1/.test(command)) process.exit(0);

// The mangling trigger: an equals sign followed by a quote and a slash, or by a
// bare slash — i.e. anything shaped like `key=/path` or `attr="/path`.
const vulnerable = /=\s*["']?\//.test(command);
if (!vulnerable) process.exit(0);

process.stderr.write(
  "BLOCKED: this `git grep` pattern contains an equals-quote-slash sequence, which\n" +
    "MSYS path conversion rewrites before git sees it. The search will return ZERO\n" +
    "MATCHES regardless of the file contents, and an empty result is indistinguishable\n" +
    "from an honest absence.\n\n" +
    "Prefix the command with MSYS_NO_PATHCONV=1 and run it again. `-F` does not help.\n\n" +
    "Before reporting ANY absence as a finding, also run a control search for a string\n" +
    "you know is present in the same file, and state both results — a search that\n" +
    "cannot produce a hit has not established anything.\n" +
    "See docs/agents/FAILURE_MODES.md sections 6 and 15.\n",
);
process.exit(2);
