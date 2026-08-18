import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("CI workflow", () => {
  it("installs the deployment browser without refreshing hosted-runner packages", () => {
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as Record<
      string,
      any
    >;
    const installBrowser = (workflow.jobs["deployment-e2e"].steps as Record<string, any>[]).find(
      (step) => step.name === "Install browser",
    );

    expect(installBrowser).toBeDefined();
    expect(installBrowser.run).toBe("npx playwright install chromium");
    expect(installBrowser.run).not.toContain("--with-deps");
  });
});
