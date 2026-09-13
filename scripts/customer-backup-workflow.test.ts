import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(
  resolve(root, ".github/workflows/customer-backup.yml"),
  "utf8",
);
const workflow = parse(source) as Record<string, any>;
const job = workflow.jobs.backup as Record<string, any>;
const steps = job.steps as Record<string, any>[];

function step(name: string): Record<string, any> {
  const found = steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`step not found: ${name}`);
  return found;
}

describe("customer backup workflow", () => {
  it("runs every 30 minutes on the default branch under the protected environment", () => {
    expect(workflow.on.schedule).toEqual([{ cron: "*/30 * * * *" }]);
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.on).not.toHaveProperty("push");
    expect(job.if).toContain("github.event.repository.default_branch");
    expect(job.environment).toBe("customer-production-backup");
    expect(job["timeout-minutes"]).toBe(270);
    expect(workflow.concurrency).toMatchObject({
      group: "customer-production-backup",
      "cancel-in-progress": false,
    });
  });

  it("pins the Fly CLI so a floating latest cannot silently break app-scoped auth", () => {
    // flyctl 0.4.101+ answers `apps list` with "unauthorized" for an app-scoped
    // token, which is exactly what the validation step relies on. Without this
    // pin the setup step floated to latest and broke production backups for five
    // days. Guard the version so deleting `with: version` fails a test, not a
    // production run.
    const install = step("Install Fly CLI");
    expect(install.uses).toContain("superfly/flyctl-actions/setup-flyctl@");
    expect(install["with"]?.version).toBe("0.4.100");
  });

  it("requires an exact app binding and proves the Fly token is app scoped", () => {
    const validate = step("Validate app-scoped backup authority");
    expect(validate.env.FLY_API_TOKEN).toBe("${{ secrets.MENDPOINT_CUSTOMER_BACKUP_FLY_TOKEN }}");
    expect(validate.env.CUSTOMER_APP).toBe("${{ vars.MENDPOINT_CUSTOMER_FLY_APP }}");
    expect(validate.run).toContain("flyctl apps list --json");
    expect(validate.run).toContain("jq -r '.[] | (.Name // .name)'");
    expect(validate.run).not.toContain(".[].Name");
    // The listing failing or returning non-array output is scope-UNDETERMINED,
    // never a scope violation.
    expect(validate.run).toContain("customer_backup_scope_undetermined");
    expect(validate.run).toContain("customer_backup_token_not_app_scoped");
    expect(validate.run).toContain('flyctl status --app "$CUSTOMER_APP"');
  });

  it("executes the authenticated backup remotely with bounded evidence retention", () => {
    const initialize = step("Initialize backup evidence");
    expect(initialize.run).toContain("GITHUB_RUN_ATTEMPT");
    expect(initialize.run).toContain("GITHUB_SHA");
    const run = step("Run authenticated customer backup");
    expect(run.env.FLY_API_TOKEN).toBe("${{ secrets.MENDPOINT_CUSTOMER_BACKUP_FLY_TOKEN }}");
    expect(run.run).toContain('flyctl ssh console --app "$CUSTOMER_APP"');
    expect(run.run).toContain("scripts/customer-backup.ts");
    expect(run.run).toContain('tee -a "$evidence"');
    const upload = step("Retain backup evidence");
    expect(upload.if).toBe("${{ always() }}");
    expect(upload["with"]["retention-days"]).toBe(90);
    expect(upload["with"]["if-no-files-found"]).toBe("error");
  });

  it("opens one deduplicated GitHub issue on failure and closes it after recovery", () => {
    expect(job.permissions).toMatchObject({ contents: "read", issues: "write" });
    const alert = step("Alert on backup failure");
    expect(alert.if).toBe("${{ failure() }}");
    expect(alert.run).toContain("gh issue create");
    expect(alert.run).toContain("customer-production-backup-failure");
    const resolveAlert = step("Resolve backup failure alert");
    expect(resolveAlert.if).toBe("${{ success() }}");
    expect(resolveAlert.run).toContain("gh issue close");
  });


  it("gates the backup on explicit customer-profile activation, loudly", () => {
    const gate = workflow.jobs["profile-gate"] as Record<string, any>;
    expect(gate, "profile-gate job must exist").toBeTruthy();
    const gateStep = (gate.steps as Record<string, any>[]).find(
      (candidate) => candidate.id === "check",
    ) as Record<string, any>;
    expect(gateStep.env.ACTIVE).toBe("${{ vars.MENDPOINT_CUSTOMER_PROFILE_ACTIVE }}");
    // The inactive path must be LOUD (a ::notice naming the pending activation),
    // never a silent skip that fakes "we have backups".
    expect(gateStep.run).toContain("::notice");
    expect(gateStep.run).toContain("No backup was taken");
    expect(job.needs).toEqual(expect.arrayContaining(["profile-gate", "execution-gate"]));
    expect(job.if).toContain("needs.profile-gate.outputs.active == 'true'");
    // The original default-branch guard must survive composition.
    expect(job.if).toContain("github.event.repository.default_branch");
  });
});

/**
 * The SHIPPED "Validate app-scoped backup authority" step run under the shell
 * GitHub actually uses (`bash --noprofile --norc -e -o pipefail`), against a
 * stubbed flyctl. String assertions alone missed the third-state defect: a
 * process-substitution failure escaped the runner's -e, so "flyctl could not
 * answer" (unauthorized, network) was reported as "token not app scoped". These
 * run the real step and prove the two states are now distinct.
 */
/** Exactly what GitHub passes for `shell: bash`. Not our own choice of flags. */
const GITHUB_BASH_FLAGS = ["--noprofile", "--norc", "-e", "-o", "pipefail"];
/** A fake app that cannot resolve, so a PATH miss can never reach production. */
const STUB_APP = "stub-app-that-does-not-exist";
const STUB_TOKEN = "stub-token-not-a-real-secret";

/**
 * The GitHub ubuntu runner's jq emits LF, which `mapfile -t` strips cleanly.
 * Some dev hosts ship a Windows jq build that appends CRLF, which would leave a
 * stray \r on each app name and make the exact-match check spuriously fail
 * locally while the real runner passes. Delegate to the real jq and strip the
 * CR so the test reproduces the runner regardless of host, preserving jq's own
 * exit status (which `jq -e` relies on). No effect where jq already emits LF.
 */
const REAL_JQ =
  spawnSync("bash", ["-c", "command -v jq"], { encoding: "utf8" }).stdout.trim() || "jq";
const JQ_LF_WRAPPER = [
  "#!/usr/bin/env bash",
  `"${REAL_JQ}" "$@" | tr -d '\\r'`,
  'exit "${PIPESTATUS[0]}"',
  "",
].join("\n");

/** flyctl whose `apps list` fails the way 0.4.101+ does for an app-scoped token. */
const FLYCTL_UNAUTHORIZED = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$FLYCTL_CALL_LOG"',
  'if [ "$1" = "apps" ]; then echo "Error: unauthorized" >&2; exit 1; fi',
  'if [ "$1" = "status" ]; then exit 0; fi',
  "exit 0",
  "",
].join("\n");

/** flyctl whose token can see more than the one bound app: a real scope violation. */
const FLYCTL_TWO_APPS = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$FLYCTL_CALL_LOG"',
  `if [ "$1" = "apps" ]; then printf '%s' '[{"Name":"${STUB_APP}"},{"Name":"other-app"}]'; exit 0; fi`,
  'if [ "$1" = "status" ]; then exit 0; fi',
  "exit 0",
  "",
].join("\n");

/** flyctl scoped to exactly the bound app: the determined, passing case. */
const FLYCTL_ONE_APP = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$FLYCTL_CALL_LOG"',
  `if [ "$1" = "apps" ]; then printf '%s' '[{"Name":"${STUB_APP}"}]'; exit 0; fi`,
  'if [ "$1" = "status" ]; then exit 0; fi',
  "exit 0",
  "",
].join("\n");

function runValidateStep(flyctlBody: string): {
  status: number | null;
  stderr: string;
  calls: string;
} {
  const validate = step("Validate app-scoped backup authority");
  // If this step ever stops being `shell: bash`, GITHUB_BASH_FLAGS are no longer
  // the flags it runs under and every assertion below would measure fiction.
  expect(validate.shell).toBe("bash");
  const dir = mkdtempSync(join(tmpdir(), "customer-backup-validate-"));
  const callLog = join(dir, "flyctl-calls.log");
  writeFileSync(callLog, "", "utf8");
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const flyctlPath = join(bin, "flyctl");
  writeFileSync(flyctlPath, flyctlBody, "utf8");
  chmodSync(flyctlPath, 0o755);
  const jqPath = join(bin, "jq");
  writeFileSync(jqPath, JQ_LF_WRAPPER, "utf8");
  chmodSync(jqPath, 0o755);
  writeFileSync(join(dir, "step.sh"), validate.run, "utf8");
  const result = spawnSync("bash", [...GITHUB_BASH_FLAGS, "step.sh"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      FLYCTL_CALL_LOG: callLog,
      FLY_API_TOKEN: STUB_TOKEN,
      CUSTOMER_APP: STUB_APP,
    },
  });
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    calls: readFileSync(callLog, "utf8"),
  };
}

describe("Validate app-scoped backup authority — the shipped step under GitHub's shell", () => {
  it("reports scope UNDETERMINED when flyctl cannot answer, and never runs status", () => {
    const result = runValidateStep(FLYCTL_UNAUTHORIZED);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("customer_backup_scope_undetermined");
    // The regression: an unauthorized listing must NOT be reported as a scope violation.
    expect(result.stderr).not.toContain("customer_backup_token_not_app_scoped");
    expect(result.calls).toContain("apps list");
    expect(result.calls).not.toContain("status");
  });

  it("still fails with token_not_app_scoped when more than the bound app is visible", () => {
    const result = runValidateStep(FLYCTL_TWO_APPS);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("customer_backup_token_not_app_scoped");
    expect(result.stderr).not.toContain("customer_backup_scope_undetermined");
    // A proven scope violation must not fall through to a status probe.
    expect(result.calls).not.toContain("status");
  });

  it("passes through to flyctl status when exactly the bound app is visible", () => {
    const result = runValidateStep(FLYCTL_ONE_APP);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.calls).toContain("status --app");
  });
});
