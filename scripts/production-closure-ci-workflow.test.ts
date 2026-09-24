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

    // Build and push is its own step: local build, registry push, deterministic
    // label from the commit sha, a bounded push retry, and a named failure.
    const buildPush = steps.find(
      (step) => step.name === "Build and push customer production image",
    )!;
    expect(buildPush.env).toEqual({
      FLY_API_TOKEN: "${{ secrets.FLY_API_TOKEN_CUSTOMER }}",
    });
    expect(buildPush.shell).toBe("bash");
    expect(buildPush.run).toContain("--build-only");
    expect(buildPush.run).toContain("--push");
    expect(buildPush.run).toContain("--local-only");
    expect(buildPush.run).toContain('--image-label "${label}"');
    expect(buildPush.run).toContain('label="deploy-${{ github.sha }}"');
    expect(buildPush.run).toContain("--config fly.customer-warden.toml");
    expect(buildPush.run).not.toContain("--remote-only");
    expect(buildPush.run).not.toContain("--depot");
    // The exhausted-push failure is named, and the release does not ride here.
    expect(buildPush.run).toContain("registry_push_failed");
    expect(buildPush.run).not.toContain("MENDPOINT_RELEASE_REVISION");

    // The release is a separate no-retry step that names the exact pushed image;
    // it neither rebuilds nor re-pushes.
    const deploy = steps.find((step) => step.name === "Deploy customer production")!;
    expect(deploy.env).toEqual({
      FLY_API_TOKEN: "${{ secrets.FLY_API_TOKEN_CUSTOMER }}",
    });
    expect(deploy.run.trimStart().startsWith("flyctl deploy ")).toBe(true);
    expect(deploy.run).toContain("--image ${{ steps.build_push.outputs.image }}");
    expect(deploy.run).toContain("--ha=false --app mendpoint-fettler-production");
    expect(deploy.run).not.toContain("--build-only");
    expect(deploy.run).not.toContain("--push");
    expect(deploy.run).not.toContain("--local-only");
    expect(deploy.run).not.toContain("--remote-only");
    expect(deploy.run).not.toContain("--depot");
    expect(deploy.run).not.toContain("registry_push_failed");
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

/**
 * The SHIPPED build/push and release steps run under GitHub's own shell against a
 * stubbed flyctl. A single `flyctl deploy` builds, pushes and releases with no
 * retry, so one TLS handshake timeout on the push turned main red on f1ce6a6b for
 * a transport blip. The push is now retried (bounded, transient-only, idempotent
 * fixed label); the release runs exactly once with no retry, because a partial
 * release is possible. These prove: a transient push error retries and then
 * succeeds; a persistent transient error stops at three attempts with a named
 * `registry_push_failed`; a non-transient error (auth 401, build failure) fails on
 * the first attempt with the real output and never retries; the release runs once
 * even when it fails; and the release names the exact pushed label and carries
 * MENDPOINT_RELEASE_REVISION.
 *
 * GitHub substitutes `${{ ... }}` expressions before the shell sees the script;
 * renderExpressions() reproduces exactly that substitution (the commit sha, and
 * the release's reference to the push step's `image` output) so the bytes that run
 * are the bytes that ship, with only the values GitHub would already have filled.
 */
const DEPLOY_SHA = "f1ce6a6b233455dcacaac297fc11f2736fef1e77";
const PUSHED_IMAGE = `registry.fly.io/${CUSTOMER_APP}:deploy-${DEPLOY_SHA}`;

/** flyctl push that fails once with a transient error, then succeeds. */
const FLYCTL_PUSH_TRANSIENT_THEN_OK = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$FLYCTL_CALL_LOG"',
  'attempts="$(wc -l < "$FLYCTL_CALL_LOG")"',
  'if [ "$1" = "deploy" ]; then',
  '  if [ "$attempts" -le 1 ]; then',
  '    echo "Error: failed to fetch an image or build from source: error rendering push status stream: Get \\"https://registry.fly.io/v2/\\": net/http: TLS handshake timeout" >&2',
  "    exit 1",
  "  fi",
  '  echo "--> pushing image done"; exit 0',
  "fi",
  "exit 0",
  "",
].join("\n");

/** flyctl push that always fails with a transient transport error. */
const FLYCTL_PUSH_TRANSIENT_PERSISTENT = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$FLYCTL_CALL_LOG"',
  'if [ "$1" = "deploy" ]; then echo "Error: error rendering push status stream: Get \\"https://registry.fly.io/v2/\\": net/http: TLS handshake timeout" >&2; exit 1; fi',
  "exit 0",
  "",
].join("\n");

/** flyctl push that fails with an authorization error (token not scoped to push). */
const FLYCTL_PUSH_UNAUTHORIZED = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$FLYCTL_CALL_LOG"',
  'if [ "$1" = "deploy" ]; then echo "Error: 401 Unauthorized: the deploy token is not authorized to push to this registry repository" >&2; exit 1; fi',
  "exit 0",
  "",
].join("\n");

/** flyctl push that fails with a build error before any push happens. */
const FLYCTL_BUILD_ERROR = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$FLYCTL_CALL_LOG"',
  'if [ "$1" = "deploy" ]; then echo "Error: failed to build: Dockerfile parse error on line 3: unknown instruction" >&2; exit 1; fi',
  "exit 0",
  "",
].join("\n");

/** flyctl whose `deploy` succeeds and records its arguments. */
const FLYCTL_DEPLOY_OK = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$FLYCTL_CALL_LOG"',
  'if [ "$1" = "deploy" ]; then echo "--> deploy done"; exit 0; fi',
  "exit 0",
  "",
].join("\n");

/** flyctl whose `deploy --image` release fails (no transient signal). */
const FLYCTL_RELEASE_FAIL = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$FLYCTL_CALL_LOG"',
  'if [ "$1" = "deploy" ]; then echo "Error: release command failed: could not update machine 84e696a22eee68" >&2; exit 1; fi',
  "exit 0",
  "",
].join("\n");

function renderExpressions(run: string, values: { sha?: string; image?: string }): string {
  let rendered = run;
  if (values.sha !== undefined) rendered = rendered.split("${{ github.sha }}").join(values.sha);
  if (values.image !== undefined) {
    rendered = rendered.split("${{ steps.build_push.outputs.image }}").join(values.image);
  }
  return rendered;
}

function runDeploySplitStep(
  stepName: string,
  flyctlBody: string,
  values: { sha?: string; image?: string } = {},
): {
  status: number | null;
  stdout: string;
  calls: string;
  outputs: string;
} {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as Record<string, any>;
  const customer = (workflow.jobs as Record<string, any>)["deploy-customer-production"];
  const steps = customer.steps as Record<string, any>[];
  const step = steps.find((candidate) => candidate.name === stepName)!;
  // If a step ever stops running under bash, GITHUB_BASH_FLAGS are no longer the
  // flags it runs under. `shell: bash` is explicit on the push step; the release
  // step omits it and inherits the ubuntu runner's default, which is bash.
  expect(step.shell === "bash" || step.shell === undefined).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), "deploy-split-"));
  const callLog = join(dir, "flyctl-calls.log");
  writeFileSync(callLog, "", "utf8");
  const outputFile = join(dir, "github-output");
  writeFileSync(outputFile, "", "utf8");
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const flyctlPath = join(bin, "flyctl");
  writeFileSync(flyctlPath, flyctlBody, "utf8");
  chmodSync(flyctlPath, 0o755);
  writeFileSync(join(dir, "step.sh"), renderExpressions(step.run, values), "utf8");
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
      GITHUB_OUTPUT: outputFile,
      // Real backoff on CI; 0 here so the retry tests do not sleep.
      FLY_PUSH_RETRY_BACKOFF_SECONDS: "0",
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    calls: readFileSync(callLog, "utf8"),
    outputs: readFileSync(outputFile, "utf8"),
  };
}

const BUILD_PUSH_STEP = "Build and push customer production image";
const RELEASE_STEP = "Deploy customer production";

function deployCalls(calls: string): string[] {
  return calls.split("\n").filter((line) => line.startsWith("deploy "));
}

describe("Build and push — the shipped step under GitHub's shell", () => {
  it("retries a transient push error and then succeeds", () => {
    const result = runDeploySplitStep(BUILD_PUSH_STEP, FLYCTL_PUSH_TRANSIENT_THEN_OK, {
      sha: DEPLOY_SHA,
    });
    expect(result.status).toBe(0);
    // Exactly two push attempts: one transient failure, one success.
    expect(deployCalls(result.calls)).toHaveLength(2);
    expect(result.stdout).toContain("retrying after a short backoff");
    // The image reference is exported for the release step to consume.
    expect(result.outputs).toContain(`image=${PUSHED_IMAGE}`);
    expect(result.stdout).not.toContain("registry_push_failed");
  });

  it("stops at exactly three attempts on a persistent transient error and names the failure", () => {
    const result = runDeploySplitStep(BUILD_PUSH_STEP, FLYCTL_PUSH_TRANSIENT_PERSISTENT, {
      sha: DEPLOY_SHA,
    });
    expect(result.status).toBe(1);
    expect(deployCalls(result.calls)).toHaveLength(3);
    expect(result.stdout).toContain("::error::registry_push_failed:");
    // The real flyctl output is preserved, not discarded.
    expect(result.stdout).toContain("TLS handshake timeout");
  });

  it("fails immediately on an authorization error without retrying", () => {
    const result = runDeploySplitStep(BUILD_PUSH_STEP, FLYCTL_PUSH_UNAUTHORIZED, {
      sha: DEPLOY_SHA,
    });
    expect(result.status).toBe(1);
    expect(deployCalls(result.calls)).toHaveLength(1);
    expect(result.stdout).toContain("401 Unauthorized");
    expect(result.stdout).toContain("non-transient error");
    expect(result.stdout).not.toContain("registry_push_failed");
  });

  it("fails immediately on a build error without retrying", () => {
    const result = runDeploySplitStep(BUILD_PUSH_STEP, FLYCTL_BUILD_ERROR, {
      sha: DEPLOY_SHA,
    });
    expect(result.status).toBe(1);
    expect(deployCalls(result.calls)).toHaveLength(1);
    expect(result.stdout).toContain("Dockerfile parse error");
    expect(result.stdout).not.toContain("registry_push_failed");
  });

  it("pushes the exact label it advertises to the release step (no label drift)", () => {
    const result = runDeploySplitStep(BUILD_PUSH_STEP, FLYCTL_DEPLOY_OK, { sha: DEPLOY_SHA });
    expect(result.status).toBe(0);
    const pushCall = deployCalls(result.calls)[0];
    expect(pushCall).toContain(`--image-label deploy-${DEPLOY_SHA}`);
    expect(result.outputs.trim()).toBe(`image=${PUSHED_IMAGE}`);
  });
});

describe("Release — the shipped step under GitHub's shell", () => {
  it("releases the exact pushed image once, carrying MENDPOINT_RELEASE_REVISION", () => {
    const result = runDeploySplitStep(RELEASE_STEP, FLYCTL_DEPLOY_OK, {
      sha: DEPLOY_SHA,
      image: PUSHED_IMAGE,
    });
    expect(result.status).toBe(0);
    const releaseCalls = deployCalls(result.calls);
    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0]).toContain(`--image ${PUSHED_IMAGE}`);
    expect(releaseCalls[0]).toContain(`--env MENDPOINT_RELEASE_REVISION=${DEPLOY_SHA}`);
    expect(releaseCalls[0]).toContain("--ha=false");
    expect(releaseCalls[0]).toContain("--config fly.customer-warden.toml");
    // The release must not rebuild or re-push.
    expect(releaseCalls[0]).not.toContain("--build-only");
    expect(releaseCalls[0]).not.toContain("--push");
  });

  it("fails loudly on a release error and never retries", () => {
    const result = runDeploySplitStep(RELEASE_STEP, FLYCTL_RELEASE_FAIL, {
      sha: DEPLOY_SHA,
      image: PUSHED_IMAGE,
    });
    expect(result.status).not.toBe(0);
    const releaseCalls = deployCalls(result.calls);
    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0]).toContain(`--image ${PUSHED_IMAGE}`);
  });
});
