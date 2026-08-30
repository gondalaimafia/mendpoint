import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("CI workflow", () => {
  it("proves dedicated mendpoint-talal authority before deploying", () => {
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as Record<
      string,
      any
    >;
    const deploySteps = workflow.jobs.deploy.steps as Record<string, any>[];
    const preflightIndex = deploySteps.findIndex(
      (step) => step.name === "Preflight mendpoint-talal deploy authority",
    );
    const deployIndex = deploySteps.findIndex(
      (step) => step.name === "Deploy verified revision",
    );

    expect(preflightIndex).toBeGreaterThan(-1);
    expect(deployIndex).toBeGreaterThan(preflightIndex);

    const preflight = deploySteps[preflightIndex]!;
    const deploy = deploySteps[deployIndex]!;
    const dedicatedSecret = "${{ secrets.FLY_API_TOKEN_MENDPOINT_TALAL }}";

    expect(preflight).toMatchObject({
      if: "steps.head.outputs.superseded != 'true'",
      shell: "bash",
      env: { FLY_API_TOKEN: dedicatedSecret },
    });
    expect(preflight.run).toContain('test -n "${FLY_API_TOKEN:-}"');
    expect(preflight.run).toContain("flyctl status --app mendpoint-talal");
    expect(preflight.run).not.toContain("flyctl deploy");
    expect(deploy.env).toEqual({ FLY_API_TOKEN: dedicatedSecret });
    expect(JSON.stringify(workflow.jobs.deploy)).not.toContain(
      "secrets.FLY_API_TOKEN }}",
    );
  });

  it("installs the deployment browser without refreshing hosted-runner packages", () => {
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as Record<
      string,
      any
    >;
    const installBrowser = (workflow.jobs["deployment-e2e"].steps as Record<string, any>[]).find(
      (step) => step.name === "Install browser",
    )!;

    expect(installBrowser).toBeDefined();
    expect(installBrowser.run).toBe("npx playwright install chromium");
    expect(installBrowser.run).not.toContain("--with-deps");
  });

  it("declares local sandbox execution explicitly for every production-mode CI runtime", () => {
    const workflowText = readFileSync(".github/workflows/ci.yml", "utf8");
    const workflow = parse(workflowText) as Record<string, any>;
    const testSteps = workflow.jobs.test.steps as Record<string, any>[];
    const releaseSteps = workflow.jobs["release-gates"].steps as Record<string, any>[];
    const containerSteps = workflow.jobs["container-builds"].steps as Record<string, any>[];

    expect(testSteps.find((step) => step.name === "GA preflight")?.env)
      .toMatchObject({ MENDPOINT_SANDBOX_KIND: "local" });
    expect(releaseSteps.find((step) => step.name === "API startup smoke")?.run)
      .toContain("export MENDPOINT_SANDBOX_KIND=local");

    const containerRun = containerSteps.find((step) => step.name === "Start production images")
      ?.run as string;
    expect(containerRun.match(/MENDPOINT_SANDBOX_KIND=local/gu)).toHaveLength(3);

    const deploymentJourney = readFileSync("tests/e2e/deployment.spec.ts", "utf8");
    expect(deploymentJourney).toContain('MENDPOINT_SANDBOX_KIND: "local"');
  });
});
