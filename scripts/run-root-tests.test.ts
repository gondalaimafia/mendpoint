import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const readRepoFile = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");

const rootPackage = JSON.parse(readRepoFile("package.json")) as {
  scripts: Record<string, string>;
};
const testScript = rootPackage.scripts.test;

describe("root npm test runs the scripts/ gate regardless of workspace outcome", () => {
  it("does not short-circuit the two halves with &&", () => {
    // Regression guard for the `npm run test --workspaces && vitest run scripts`
    // form: a single failing (or green-on-retry flaky) workspace short-circuited
    // the `&&` and silently skipped every scripts/ gate test — third-state,
    // evidence-reachability, reverts — the repo's own guardrails. Both halves
    // must run unconditionally, so the sequencing must not use `&&`.
    expect(testScript).not.toMatch(/&&/);
  });

  it("delegates to the runner that executes both halves", () => {
    expect(testScript).toContain("scripts/run-root-tests.mjs");
  });

  it("runner runs both the workspace suites and the scripts/ gate", () => {
    const runner = readRepoFile("scripts/run-root-tests.mjs");
    // Both commands must be present and the runner must not break out of its
    // loop on the first failure, or the scripts/ gate could be skipped again.
    expect(runner).toContain("npm run test --workspaces --if-present");
    expect(runner).toContain("vitest run scripts");
    expect(runner).not.toMatch(/\bbreak\b/);
  });
});
