// Runs the two halves of the root `npm test` independently: the per-workspace
// test suites, then the scripts/ gate tests (third-state, evidence-reachability,
// reverts, and the rest). Both halves ALWAYS run — a failing or flaky workspace
// must never skip the scripts/ gates, which are the repo's own guardrails. The
// process exits non-zero if either half fails, so overall `npm test` still fails
// closed. Node is the runtime, so this is identical on Ubuntu CI and Windows dev.
import { spawnSync } from "node:child_process";

const steps = [
  { name: "workspaces", command: "npm run test --workspaces --if-present" },
  { name: "scripts", command: "vitest run scripts" },
];

let failed = false;
for (const step of steps) {
  const result = spawnSync(step.command, { stdio: "inherit", shell: true });
  const code = result.status;
  if (code !== 0 || result.error) {
    failed = true;
    const reason = result.error
      ? result.error.message
      : code === null
        ? `signal ${result.signal}`
        : `exit code ${code}`;
    console.error(`[run-root-tests] "${step.name}" failed (${reason})`);
  }
}

process.exit(failed ? 1 : 0);
