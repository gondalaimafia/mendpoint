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

  it("deploys only the gated customer production target", () => {
    const workflowText = readFileSync(".github/workflows/ci.yml", "utf8");
    const workflow = parse(workflowText) as Record<string, any>;
    const jobs = workflow.jobs as Record<string, Record<string, any>>;

    expect(jobs.deploy).toBeUndefined();
    expect(workflowText).not.toContain("mendpoint-talal");

    const deploymentJobs = Object.entries(jobs)
      .filter(([, job]) => JSON.stringify(job).includes("flyctl deploy"))
      .map(([name]) => name);
    expect(deploymentJobs).toEqual(["deploy-customer-production"]);

    const customer = jobs["deploy-customer-production"];
    expect(customer).toBeDefined();
    expect(customer.needs).toEqual([
      "test",
      "release-gates",
      "container-builds",
      "deployment-e2e",
    ]);
    expect(customer.if).toContain("github.event_name == 'push'");
    expect(customer.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(customer.if).toContain("github.ref == 'refs/heads/main'");
    expect(customer.concurrency).toEqual({
      group: "customer-production-deploy",
      "cancel-in-progress": false,
    });

    const steps = customer.steps as Record<string, any>[];
    const head = steps.find((step) => step.name === "Re-assert this run deploys current main head")!;
    expect(head.run).toContain("git ls-remote origin refs/heads/main");
    expect(head.run).toContain('echo "superseded=true"');

    const authority = steps.find(
      (step) => step.name === "Prove deploy authority over the customer app",
    )!;
    expect(authority.env).toEqual({
      FLY_API_TOKEN: "${{ secrets.FLY_API_TOKEN_CUSTOMER }}",
    });
    expect(authority.run).toContain("flyctl status --app mendpoint-fettler-production");

    const deploy = steps.find((step) => step.name === "Deploy customer production")!;
    expect(deploy.env).toEqual({
      FLY_API_TOKEN: "${{ secrets.FLY_API_TOKEN_CUSTOMER }}",
    });
    expect(deploy.run).toContain(
      "flyctl deploy --remote-only --ha=false --app mendpoint-fettler-production",
    );
    expect(deploy.run).toContain("--config fly.customer-warden.toml");
    expect(deploy.run).toContain("--env MENDPOINT_RELEASE_REVISION=${{ github.sha }}");

    const machines = steps.find(
      (step) => step.name === "Ensure customer production machines are running",
    )!;
    expect(machines.env).toEqual({
      FLY_API_TOKEN: "${{ secrets.FLY_API_TOKEN_CUSTOMER }}",
    });
    expect(machines.run).toContain("app=mendpoint-fettler-production");
    expect(machines.run).toContain('flyctl machine start "$id" --app "$app"');

    const verify = steps.find(
      (step) => step.name === "Verify deployed revision and customer production health",
    )!;
    expect(verify.run).toContain('base="https://mendpoint-fettler-production.fly.dev"');
    expect(verify.run).toContain(
      '[ "$revision" = "$expected" ] && [ "$live_code" = "200" ]',
    );
    expect(verify.run).not.toContain(
      '[ "$revision" = "$expected" ] && [ "$live_code" = "200" ] && [ "$health_code" = "200" ]',
    );
  });
});
