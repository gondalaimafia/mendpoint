import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("production closure CI deployment authority", () => {
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
      "flyctl deploy --local-only --ha=false --app mendpoint-fettler-production",
    );
    expect(deploy.run.trimStart().startsWith("flyctl deploy ")).toBe(true);
    expect(deploy.run).toContain("--local-only");
    expect(deploy.run).not.toContain("--remote-only");
    expect(deploy.run).not.toContain("--depot");
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

/**
 * The SHIPPED "Prove deploy authority over the customer app" step run under the
 * shell GitHub actually uses (`bash --noprofile --norc -e -o pipefail`), against
 * a stubbed flyctl. The old form discarded flyctl's output with `>/dev/null 2>&1`
 * and reported EVERY failure -- a network timeout, a Fly outage, a flyctl bug --
 * as a proven scope violation ("Re-scope the FLY_API_TOKEN_CUSTOMER secret"),
 * hiding the real error. That third state (flyctl could not answer) masquerading
 * as "not scoped" is the defect. These run the real step and prove the two states
 * are now distinct: an authorization signal reports "not scoped"; anything else is
 * scope-UNDETERMINED with the real error; both still fail the step closed.
 */
const GITHUB_BASH_FLAGS = ["--noprofile", "--norc", "-e", "-o", "pipefail"];
const CUSTOMER_APP = "mendpoint-fettler-production";
const STUB_TOKEN = "stub-token-not-a-real-secret";

/** flyctl whose `status` fails with a non-authorization network error. */
const FLYCTL_NETWORK_TIMEOUT = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$FLYCTL_CALL_LOG"',
  'if [ "$1" = "status" ]; then echo "Error: failed to fetch app: Get \\"https://api.fly.io\\": lookup api.fly.io: i/o timeout" >&2; exit 1; fi',
  "exit 0",
  "",
].join("\n");

/** flyctl whose `status` fails with an authorization error (token not scoped). */
const FLYCTL_UNAUTHORIZED = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$FLYCTL_CALL_LOG"',
  'if [ "$1" = "status" ]; then echo "Error: 401 Unauthorized: the token is not authorized to access this app" >&2; exit 1; fi',
  "exit 0",
  "",
].join("\n");

/** flyctl whose `status` succeeds: the credential has authority over the app. */
const FLYCTL_OK = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$FLYCTL_CALL_LOG"',
  'if [ "$1" = "status" ]; then echo "App: '
    + CUSTOMER_APP
    + '"; exit 0; fi',
  "exit 0",
  "",
].join("\n");

function runProveAuthorityStep(flyctlBody: string): {
  status: number | null;
  stdout: string;
  calls: string;
} {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as Record<string, any>;
  const customer = (workflow.jobs as Record<string, any>)["deploy-customer-production"];
  const steps = customer.steps as Record<string, any>[];
  const authority = steps.find(
    (step) => step.name === "Prove deploy authority over the customer app",
  )!;
  // If this step ever stops being `shell: bash`, GITHUB_BASH_FLAGS are no longer
  // the flags it runs under and every assertion below would measure fiction.
  expect(authority.shell).toBe("bash");
  const dir = mkdtempSync(join(tmpdir(), "prove-deploy-authority-"));
  const callLog = join(dir, "flyctl-calls.log");
  writeFileSync(callLog, "", "utf8");
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const flyctlPath = join(bin, "flyctl");
  writeFileSync(flyctlPath, flyctlBody, "utf8");
  chmodSync(flyctlPath, 0o755);
  writeFileSync(join(dir, "step.sh"), authority.run, "utf8");
  // Git Bash prepends host tools during startup, ahead of the inherited PATH.
  // Restore fixture precedence inside that shell before sourcing the real step.
  const result = spawnSync("bash", [...GITHUB_BASH_FLAGS, "-c", `
    fixture_bin="$(cd "$1" && pwd)"
    export PATH="$fixture_bin:$PATH"
    hash -r
    [[ "$(command -v flyctl)" == "$fixture_bin/flyctl" ]] || {
      echo "fixture_tool_selection_failed:flyctl" >&2; exit 127;
    }
    source "$2"
  `, "workflow-fixture", bin.replace(/\\/g, "/"), "./step.sh"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      FLYCTL_CALL_LOG: callLog,
      FLY_API_TOKEN: STUB_TOKEN,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    calls: readFileSync(callLog, "utf8"),
  };
}

describe("Prove deploy authority — the shipped step under GitHub's shell", () => {
  it("reports scope UNDETERMINED with the real error when flyctl cannot answer", () => {
    const result = runProveAuthorityStep(FLYCTL_NETWORK_TIMEOUT);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("undetermined");
    expect(result.stdout).toContain("i/o timeout");
    // The regression: a non-authorization failure must NOT claim the token is unscoped.
    expect(result.stdout).not.toContain("Re-scope the FLY_API_TOKEN_CUSTOMER");
    expect(result.calls).toContain("status --app");
  });

  it("reports NOT SCOPED only on an authorization failure", () => {
    const result = runProveAuthorityStep(FLYCTL_UNAUTHORIZED);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Re-scope the FLY_API_TOKEN_CUSTOMER");
    expect(result.stdout).not.toContain("undetermined");
  });

  it("passes when flyctl status proves authority over the customer app", () => {
    const result = runProveAuthorityStep(FLYCTL_OK);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Deploy credential has authority over mendpoint-fettler-production.");
    expect(result.calls).toContain("status --app");
  });
});
