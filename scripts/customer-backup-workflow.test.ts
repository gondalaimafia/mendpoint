import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runFixtureShellStep } from "./workflow-fixture-shell.js";

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
    // Closes only on a real successful backup. There is no longer any
    // deferred-but-green outcome, so a plain success() guard is exactly right:
    // the job reaches success only after a verified backup.
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
const REAL_JQ = (() => {
  const found = spawnSync("bash", ["-c", "command -v jq"], { encoding: "utf8" }).stdout.trim();
  // Never fall back to the bare word `jq`: the wrapper below is itself named `jq`
  // on the fixture PATH, so a bare-word delegation would make it call itself. If
  // the real jq is not on PATH, fail loudly rather than shipping that recursion.
  if (!found) {
    throw new Error("real jq not found on PATH; the jq LF wrapper cannot delegate to itself");
  }
  return found;
})();
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
  // If this step ever stops being `shell: bash`, the helper's GitHub flags are no
  // longer the flags it runs under and every assertion below would measure fiction.
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
  const stepPath = join(dir, "step.sh");
  writeFileSync(stepPath, validate.run, "utf8");
  // The shared helper restores the fixture PATH inside the shell (Git Bash
  // prepends host tools during startup) and refuses to run unless flyctl AND jq
  // resolve to the fixture, so a shadowed stub fails loudly instead of the step
  // exercising a host binary.
  const result = runFixtureShellStep({
    scriptPath: stepPath,
    cwd: dir,
    fixtureBin: bin,
    guardTools: ["flyctl", "jq"],
    env: {
      ...process.env,
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


describe("customer backup workflow — settle-then-backup and install resilience", () => {
  it("creates the evidence directory first so the retain step never errors on a missing dir", () => {
    // run 35842783709 died at Install Fly CLI (a download blip), so Initialize
    // never ran and "Retain backup evidence" errored with "No files were found"
    // (if-no-files-found: error). Initialize must be the FIRST step and create
    // both the directory and a file.
    expect(steps[0].name).toBe("Initialize backup evidence");
    expect(steps[0].run).toContain("mkdir -p test-results/customer-backup");
    const install = steps.findIndex((s) => s.name === "Install Fly CLI");
    expect(steps.findIndex((s) => s.name === "Initialize backup evidence")).toBeLessThan(install);
  });

  it("retries the Fly CLI install once with the same pinned SHA and version", () => {
    const install = step("Install Fly CLI");
    expect(install.id).toBe("install_flyctl");
    expect(install["continue-on-error"]).toBe(true);
    const retry = step("Install Fly CLI (retry once)");
    expect(retry.if).toBe("${{ steps.install_flyctl.outcome == 'failure' }}");
    expect(retry.uses).toBe(install.uses);
    expect(retry["with"].version).toBe(install["with"].version);
    // The retry itself is NOT continue-on-error, so a genuinely broken install
    // still fails the job loudly.
    expect(retry["continue-on-error"]).toBeUndefined();
  });

  it("has no deferred outcome: it waits for a deploy to settle, then backs up or fails loudly", () => {
    // The BLOCKER this PR came back for: a "deferred = green" outcome made the
    // delivery controller and the execution-gate fence read a cycle that took NO
    // backup as "a backup was taken". The redesign removes that state entirely.
    const names = steps.map((s) => s.name);
    expect(names).not.toContain("Detect a customer deploy in progress");
    expect(names).not.toContain("Report a deferred backup");
    const run = step("Run authenticated customer backup");
    // Settle-then-backup, never defer.
    expect(run.run).toContain("settle_wait");
    expect(run.run).toContain("read_deploy_state");
    expect(run.run).toContain("customer_backup_deploy_did_not_settle");
    expect(run.run).toContain("customer_backup_machine_stopped_no_deploy");
    // The NEWEST release only, sorted descending -- never `any` over all
    // releases (the old bug matched a stuck old release with a jq disjunction).
    expect(run.run).toContain("sort_by(.Version // .version // 0) | last");
    expect(run.run).not.toContain('$s == "running" or');
    expect(run.run).not.toContain("release_in_progress) as $s");
    // No lingering deferral vocabulary or a green exit that skips the backup.
    expect(run.run).not.toContain("customer_backup_deferred_deploy_in_progress");
    expect(run.run).not.toContain("deferred=true");
    // The failure alert still fires on failure(), and the resolve closes only on a
    // genuine success (no deferral guard needed any more).
    expect(step("Alert on backup failure").if).toBe("${{ failure() }}");
    expect(step("Resolve backup failure alert").if).toBe("${{ success() }}");
  });
});

/**
 * The SHIPPED "Run authenticated customer backup" step under GitHub's real
 * shell, against a stubbed flyctl (and the real jq via the LF wrapper). flyctl's
 * `releases` / `machine list` answers are driven by per-call sequences so a
 * settle window can be exercised deterministically; `ssh console` replays a
 * per-attempt output and exit status. Routed through the shared fixture-shell
 * helper so the host flyctl/jq can never shadow the stubs. `sleep` is neutered
 * by setting the poll interval to 0, unless `fakeClock` is set (see below), in
 * which case a stubbed `sleep`/`date` advance a virtual clock deterministically.
 *
 * Release tokens (one word per `flyctl releases` call, last repeats):
 *   inflight       newest release running, created now (a deploy in progress)
 *   settled        newest release complete (v10), created now, machine can be up
 *   settled-v11    newest release complete (v11), created now
 *   old-running    newest complete (v10) + an OLDER release still running (v2):
 *                  proves the NEWEST-only check ignores a stale stuck release
 *   newer          newest release running at a HIGHER version (v11): a deploy
 *                  that started mid-backup
 *   pending        newest release pending (v10), created now: a deploy starting
 *   complete-noage newest complete (v10) with NO CreatedAt: the age is unknown
 *   stale-complete newest complete (v10) but created long ago: no deploy, so a
 *                  stopped machine here is the #659 shape
 *   none           empty listing
 *   fail           flyctl errors (unreadable)
 * Machine tokens (one word per `flyctl machine list` call): started | stopped | fail.
 * SSH tokens (one word per `flyctl ssh console` call):
 *   ok | severed | novm | crash | partial-nomanifest | partA-fail | partB-ok.
 */
const OK_BACKUP_OUTPUT =
  '{"backupId":"customer-x","manifestAuthentication":"abc","publication":{"prefix":"p"}}';

const FLYCTL_SETTLE = [
  "#!/usr/bin/env bash",
  'printf "%s\\n" "$*" >> "$FLYCTL_CALL_LOG"',
  'now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
  "pick() {",
  "  local n=0",
  '  [ -f "$1" ] && n="$(cat "$1")"',
  "  n=$((n + 1))",
  '  printf "%s" "$n" > "$1"',
  "  local -a arr",
  '  read -ra arr <<< "$2"',
  "  local idx=$((n - 1))",
  '  [ "$idx" -ge "${#arr[@]}" ] && idx=$(( ${#arr[@]} - 1 ))',
  '  printf "%s" "${arr[$idx]}"',
  "}",
  'case "$1" in',
  "  releases)",
  // A settle read that hangs: sleeps before answering, so a `timeout` wrapper
  // around this read is what makes it return `unknown` at the bound instead of
  // blocking. Gated on the env var, so every other test is unaffected.
  '    [ -n "${RELEASES_DELAY:-}" ] && sleep "$RELEASES_DELAY"',
  '    tok="$(pick "$REL_COUNT" "$RELEASES_SEQ")"',
  '    case "$tok" in',
  '      inflight) printf \'[{"Version":10,"Status":"running","CreatedAt":"%s"}]\' "$now" ;;',
  '      settled) printf \'[{"Version":10,"Status":"complete","CreatedAt":"%s"}]\' "$now" ;;',
  '      settled-v11) printf \'[{"Version":11,"Status":"complete","CreatedAt":"%s"}]\' "$now" ;;',
  '      old-running) printf \'[{"Version":10,"Status":"complete","CreatedAt":"%s"},{"Version":2,"Status":"running","CreatedAt":"2020-01-01T00:00:00Z"}]\' "$now" ;;',
  '      newer) printf \'[{"Version":11,"Status":"running","CreatedAt":"%s"}]\' "$now" ;;',
  '      pending) printf \'[{"Version":10,"Status":"pending","CreatedAt":"%s"}]\' "$now" ;;',
  '      complete-noage) printf \'[{"Version":10,"Status":"complete"}]\' ;;',
  '      stale-complete) printf \'[{"Version":10,"Status":"complete","CreatedAt":"2020-01-01T00:00:00Z"}]\' ;;',
  '      none) printf \'[]\' ;;',
  '      garbage) printf \'not json at all\' ;;',
  '      noversion) printf \'[{"Status":"complete","CreatedAt":"%s"}]\' "$now" ;;',
  '      fail) echo "Error: unauthorized" >&2; exit 1 ;;',
  "    esac",
  "    exit 0 ;;",
  "  machine)",
  '    [ -n "${MACHINES_DELAY:-}" ] && sleep "$MACHINES_DELAY"',
  '    tok="$(pick "$MACH_COUNT" "$MACHINES_SEQ")"',
  '    case "$tok" in',
  '      started) printf \'[{"id":"m1","state":"started"}]\' ;;',
  '      stopped) printf \'[{"id":"m1","state":"stopped"}]\' ;;',
  '      fail) echo "Error: unauthorized" >&2; exit 1 ;;',
  "    esac",
  "    exit 0 ;;",
  "  ssh)",
  '    tok="$(pick "$SSH_COUNT" "$SSH_SEQ")"',
  '    case "$tok" in',
  '      ok) printf "%s\\n" "$OK_OUTPUT"; exit 0 ;;',
  '      severed) printf "ssh shell: wait: remote command exited without exit status or exit signal\\n"; exit 1 ;;',
  '      novm) printf "Error: app mendpoint-fettler-production has no started VMs\\n"; exit 1 ;;',
  '      crash) printf "Error: object store credentials rejected\\n"; exit 7 ;;',
  // Prints backupId + publication but NO manifestAuthentication, exit 0: proves
  // all three evidence greps must run (a single grep would pass this).
  '      partial-nomanifest) printf \'{"backupId":"customer-x","publication":{"prefix":"p"}}\\n\'; exit 0 ;;',
  // A first attempt that prints part of the manifest then DROPS (exit 1), paired
  // with partB-ok on the retry: proves the evidence check reads only the current
  // attempt, never the previous attempt appended to the shared evidence log.
  '      partA-fail) printf \'{"backupId":"customer-x","publication":{"prefix":"p"}\\n\'; exit 1 ;;',
  '      partB-ok) printf \'  "manifestAuthentication":"abc"}\\n\'; exit 0 ;;',
  "    esac",
  "    exit 0 ;;",
  "esac",
  "exit 0",
  "",
].join("\n");

/**
 * The real `date`, resolved once BEFORE the fixture bin is prepended, so the
 * fake-clock `date` stub can delegate to it by absolute path without recursing
 * into itself (it is named `date` on the fixture PATH).
 */
const REAL_DATE = (() => {
  const found = spawnSync("bash", ["-c", "command -v date"], { encoding: "utf8" }).stdout.trim();
  if (!found) {
    throw new Error("real date not found on PATH; the fake-clock date stub cannot delegate to itself");
  }
  return found;
})();

/** Virtual-clock `date`: `+%s` reads the clock file; everything else is real. */
const FAKE_DATE = [
  "#!/usr/bin/env bash",
  `for a in "$@"; do case "$a" in -d|-d*|--date*) exec "${REAL_DATE}" "$@";; esac; done`,
  'if [ "${!#}" = "+%s" ]; then cat "$CLOCK_FILE"; exit 0; fi',
  `exec "${REAL_DATE}" "$@"`,
  "",
].join("\n");

/** Virtual-clock `sleep`: advances the clock file by N seconds, instantly. */
const FAKE_SLEEP = [
  "#!/usr/bin/env bash",
  'c="$(cat "$CLOCK_FILE")"',
  'printf "%s" "$((c + ${1%s}))" > "$CLOCK_FILE"',
  "",
].join("\n");

const FAKE_CLOCK_START = "1700000000";

function runBackupStep(options: {
  releasesSeq: string;
  machinesSeq: string;
  sshSeq: string;
  settleMaxSeconds?: string;
  settleRecentSeconds?: string;
  settlePollSeconds?: string;
  /** Per-read `timeout` bound for the settle reads (script default is 30). */
  settleReadTimeoutSeconds?: string;
  /** Seconds the stubbed `flyctl releases` sleeps before answering (a hung read). */
  releasesDelay?: string;
  /** Seconds the stubbed `flyctl machine list` sleeps before answering. */
  machinesDelay?: string;
  /**
   * When set, install stubbed `date`/`sleep` that advance a virtual clock, so a
   * settle deadline spanning hundreds of seconds is exercised deterministically
   * and instantly rather than by real wall-clock sleeps.
   */
  fakeClock?: boolean;
}): {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
  sshCalls: string[];
  releasesCalls: string[];
} {
  const run = step("Run authenticated customer backup");
  expect(run.shell).toBe("bash");
  const dir = mkdtempSync(join(tmpdir(), "customer-backup-settle-"));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const callLog = join(dir, "flyctl-calls.log");
  writeFileSync(callLog, "", "utf8");
  const flyctlPath = join(bin, "flyctl");
  writeFileSync(flyctlPath, FLYCTL_SETTLE, "utf8");
  chmodSync(flyctlPath, 0o755);
  const jqPath = join(bin, "jq");
  writeFileSync(jqPath, JQ_LF_WRAPPER, "utf8");
  chmodSync(jqPath, 0o755);
  const guardTools = ["flyctl", "jq"];
  const clockEnv: Record<string, string> = {};
  if (options.fakeClock) {
    const clockFile = join(dir, "clock");
    writeFileSync(clockFile, FAKE_CLOCK_START, "utf8");
    const datePath = join(bin, "date");
    writeFileSync(datePath, FAKE_DATE, "utf8");
    chmodSync(datePath, 0o755);
    const sleepPath = join(bin, "sleep");
    writeFileSync(sleepPath, FAKE_SLEEP, "utf8");
    chmodSync(sleepPath, 0o755);
    guardTools.push("date", "sleep");
    clockEnv.CLOCK_FILE = clockFile;
  }
  mkdirSync(join(dir, "test-results", "customer-backup"), { recursive: true });
  const scriptPath = join(dir, "step.sh");
  writeFileSync(scriptPath, run.run, "utf8");
  const result = runFixtureShellStep({
    scriptPath,
    cwd: dir,
    fixtureBin: bin,
    guardTools,
    env: {
      ...process.env,
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: "deadbeefdeadbeef",
      FLYCTL_CALL_LOG: callLog,
      FLY_API_TOKEN: STUB_TOKEN,
      CUSTOMER_APP: STUB_APP,
      RELEASES_SEQ: options.releasesSeq,
      MACHINES_SEQ: options.machinesSeq,
      SSH_SEQ: options.sshSeq,
      OK_OUTPUT: OK_BACKUP_OUTPUT,
      REL_COUNT: join(dir, "rel.count"),
      MACH_COUNT: join(dir, "mach.count"),
      SSH_COUNT: join(dir, "ssh.count"),
      SETTLE_POLL_SECONDS: options.settlePollSeconds ?? "0",
      SETTLE_MAX_SECONDS: options.settleMaxSeconds ?? "300",
      SETTLE_RECENT_SECONDS: options.settleRecentSeconds ?? "300",
      SETTLE_READ_TIMEOUT_SECONDS: options.settleReadTimeoutSeconds ?? "",
      RELEASES_DELAY: options.releasesDelay ?? "",
      MACHINES_DELAY: options.machinesDelay ?? "",
      ...clockEnv,
    },
  });
  const calls = readFileSync(callLog, "utf8").split("\n").filter(Boolean);
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    calls,
    sshCalls: calls.filter((line) => line.includes("ssh console")),
    releasesCalls: calls.filter((line) => line.startsWith("releases")),
  };
}

describe("Run authenticated customer backup — settle wait under GitHub's shell", () => {
  it("waits for an in-progress deploy to settle, then takes exactly one backup", () => {
    const result = runBackupStep({
      releasesSeq: "inflight settled settled",
      machinesSeq: "stopped started started",
      sshSeq: "ok",
    });
    expect(result.status, result.stderr).toBe(0);
    // Exactly one real backup, after waiting out the deploy.
    expect(result.sshCalls.length).toBe(1);
    // It polled more than once (it actually waited) before the backup.
    expect(result.releasesCalls.length).toBeGreaterThan(1);
  }, 60_000);

  it("fails loudly with deploy_did_not_settle when a deploy never finishes", () => {
    const result = runBackupStep({
      releasesSeq: "inflight",
      machinesSeq: "stopped",
      sshSeq: "ok",
      settleMaxSeconds: "0",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_deploy_did_not_settle");
    // No backup was taken.
    expect(result.sshCalls.length).toBe(0);
  }, 60_000);

  it("does not wait on an OLD stuck 'running' release when the NEWEST is complete", () => {
    // The should-fix: main used any(.[]; running) over ~25 releases, so one old
    // stuck release deferred every backup forever. The newest-only check ignores
    // it and backs up immediately.
    const result = runBackupStep({
      releasesSeq: "old-running old-running",
      machinesSeq: "started started",
      sshSeq: "ok",
      settleMaxSeconds: "0",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.sshCalls.length).toBe(1);
    // It did not spin waiting, and it does NOT re-read after settling: the
    // baseline version comes from settle's own final read, so a single settle
    // read is the only releases call before the backup.
    expect(result.releasesCalls.length).toBe(1);
  }, 60_000);

  it("fails loudly on a stopped machine with no deploy in progress (the #659 shape)", () => {
    // settleMaxSeconds is tiny so that if the #659 fail-loud branch were removed,
    // the fall-through to the deadline is quick to observe (mutation proof).
    const result = runBackupStep({
      releasesSeq: "stale-complete",
      machinesSeq: "stopped",
      sshSeq: "ok",
      settleMaxSeconds: "1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_machine_stopped_no_deploy");
    expect(result.stderr).not.toContain("customer_backup_deploy_did_not_settle");
    expect(result.sshCalls.length).toBe(0);
  }, 60_000);

  it("retries once, and succeeds, when the backup is dropped by a confirmed new deploy", () => {
    const result = runBackupStep({
      // settle (v10, baseline from settle's own read); ssh severed; confirm sees
      // a NEWER release (v11 running) -> confirmed; settle for v11; ssh ok. No
      // separate pre-backup read, so three releases calls, not five.
      releasesSeq: "settled newer settled-v11",
      machinesSeq: "started started started",
      sshSeq: "severed ok",
    });
    expect(result.status, result.stderr).toBe(0);
    // Exactly one retry: two ssh backup attempts, the second one succeeding.
    expect(result.sshCalls.length).toBe(2);
    expect(result.stdout).toContain("customer_backup_retry_after_confirmed_deploy");
  }, 60_000);

  it("fails loudly on a mid-backup drop when NO deploy is confirmed (a crash or OOM)", () => {
    const result = runBackupStep({
      releasesSeq: "settled settled settled",
      machinesSeq: "started started started",
      sshSeq: "crash",
    });
    expect(result.status).toBe(7);
    expect(result.stderr).toContain("customer_backup_run_failed");
    expect(result.stderr).toContain("no_deploy_confirmed");
    // No retry: the crash was not a deploy, so exactly one attempt.
    expect(result.sshCalls.length).toBe(1);
  }, 60_000);

  it("fails loudly even on a severed-ssh error when no deploy is confirmed", () => {
    // The should-fix (b): main classified "remote command exited without exit
    // status" as deploy-caused WITHOUT confirming a deploy, so a VM crash that
    // happens to sever the session went green. Now the classification is by the
    // re-read deploy state, not the error text: a severed session with no deploy
    // fails loudly.
    const result = runBackupStep({
      releasesSeq: "settled settled settled",
      machinesSeq: "started started started",
      sshSeq: "severed",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_run_failed");
    expect(result.stderr).toContain("no_deploy_confirmed");
    expect(result.sshCalls.length).toBe(1);
  }, 60_000);

  it("falls open (attempts the backup) when flyctl cannot answer the settle check", () => {
    const result = runBackupStep({
      releasesSeq: "fail",
      machinesSeq: "fail",
      sshSeq: "ok",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("customer_backup_settle_flyctl_unreadable");
    expect(result.sshCalls.length).toBe(1);
  }, 60_000);

  // --- Follow-up review of #714 (issue #722): bound the settle reads, parse
  // strictly, and make the known-value guard load-bearing.

  it("item 1: wraps BOTH settle reads in a timeout bound", () => {
    const collapsed = step("Run authenticated customer backup").run
      .replace(/\\\n\s+/g, " ")
      .replace(/[ \t]+/g, " ");
    expect(collapsed).toContain('timeout "$SETTLE_READ_TIMEOUT_SECONDS" flyctl releases');
    expect(collapsed).toContain('timeout "$SETTLE_READ_TIMEOUT_SECONDS" flyctl machine list');
  });

  it("item 1: a hung settle read times out to unknown and falls open, instead of blocking", () => {
    // The read is made to hang (RELEASES_DELAY/MACHINES_DELAY) past the 1s bound.
    // With the timeout the hung read is `unknown`, so settle falls open and the
    // backup still runs; WITHOUT it the read would eventually return `settled`
    // and this fall-open message would never appear. Run once per read so
    // removing the timeout from EITHER is caught.
    for (const which of ["releases", "machines"] as const) {
      const result = runBackupStep({
        releasesSeq: "settled",
        machinesSeq: "started",
        sshSeq: "ok",
        settleReadTimeoutSeconds: "1",
        releasesDelay: which === "releases" ? "3" : "",
        machinesDelay: which === "machines" ? "3" : "",
      });
      expect(result.status, `${which}: ${result.stderr}`).toBe(0);
      expect(result.stdout, which).toContain("customer_backup_settle_flyctl_unreadable");
      expect(result.sshCalls.length, which).toBe(1);
    }
  }, 60_000);

  it("item 2: an empty release list at settle is UNKNOWN, so a later crash fails loudly and never retries", () => {
    // flyctl exits 0 but returns []. This app always has releases, so an empty
    // list is a read that cannot be trusted, NOT proof of "no releases": the
    // baseline is `unknown`. The backup then crashes and the now-readable v10
    // must NOT be read as a deploy that dropped the backup. Treating [] as a
    // known -1 (the mutation) would make v10 "newer" and retry a crash into a
    // green run.
    const result = runBackupStep({
      releasesSeq: "none settled",
      machinesSeq: "started started",
      sshSeq: "crash ok",
    });
    expect(result.status).toBe(7);
    expect(result.stderr).toContain("customer_backup_run_failed");
    expect(result.stderr).toContain("no_deploy_confirmed");
    // No retry: exactly one ssh attempt.
    expect(result.sshCalls.length).toBe(1);
  }, 60_000);

  it("item 2: an empty (or garbage) read at settle falls OPEN, not treated as settled", () => {
    // flyctl exits 0 with [] (or non-JSON) and the machine is started. An empty
    // list is not proof of "no releases"; it is a read we cannot trust, so the
    // release read is UNREADABLE and settle falls open and attempts the backup.
    // The old code left release_readable=true and treated [] as "settled" (the
    // comment/code mismatch, re-review finding 2); this proves the code now
    // matches the comment and falls open.
    for (const tok of ["none", "garbage"]) {
      const result = runBackupStep({
        releasesSeq: tok,
        machinesSeq: "started",
        sshSeq: "ok",
      });
      expect(result.status, `${tok}: ${result.stderr}`).toBe(0);
      expect(result.stdout, tok).toContain("customer_backup_settle_flyctl_unreadable");
      expect(result.sshCalls.length, tok).toBe(1);
    }
  }, 60_000);

  it("nit: a newest release with no Version field is UNKNOWN (not a known -1), so a crash fails loudly", () => {
    // Real flyctl 0.4.100 always emits Version, but if it were ever absent the jq
    // default must map it to `unknown`, not a known -1: a -1 baseline plus a later
    // readable v10 would count as "newer" and retry a crash into a green run
    // (re-review finding 3). Settle sees a complete release on a started machine,
    // so it settles; the crash then has an unknown baseline and fails loudly.
    const result = runBackupStep({
      releasesSeq: "noversion settled",
      machinesSeq: "started started",
      sshSeq: "crash ok",
    });
    expect(result.status).toBe(7);
    expect(result.stderr).toContain("no_deploy_confirmed");
    // No retry: exactly one ssh attempt.
    expect(result.sshCalls.length).toBe(1);
  }, 60_000);

  it("item 3: the known-value guard is load-bearing — an unknown baseline plus an in-progress deploy fails loudly", () => {
    // Settle falls open (flyctl unreadable), so the baseline is `unknown`. The
    // backup is dropped (severed ssh) and the post-failure read shows the newest
    // release VISIBLY in progress. The explicit `!= unknown` guard blocks the
    // `release_in_progress` retry branch, so this fails loudly. Deleting the
    // guard lets that branch confirm a deploy and retry into a green run — the
    // case the `unknown` sentinel making `-gt` false does NOT cover, and the
    // reviewer's surviving mutation F1b.
    const result = runBackupStep({
      releasesSeq: "fail inflight settled",
      machinesSeq: "fail started started",
      sshSeq: "severed ok",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_run_failed");
    expect(result.stderr).toContain("no_deploy_confirmed");
    // No retry: exactly one ssh attempt, because the guard refused to confirm.
    expect(result.sshCalls.length).toBe(1);
  }, 60_000);

  // --- Behaviour tests that kill the reviewer's surviving mutations R1-R4, R6,
  // R8, plus the blocker (unknown baseline), the two-read race (item 3), the
  // cross-attempt evidence read (item 2), and the single settle deadline (item 4).

  it("BLOCKER: an unknown baseline plus a crash with no deploy fails loudly, never retries", () => {
    // The third-state defect (FAILURE_MODES §1): a failed pre-backup read used to
    // record version -1, indistinguishable from "no releases", so ANY readable
    // post-failure version counted as "newer" and a crash retried into a green
    // run. The baseline is now UNKNOWN, and an unknown baseline can never confirm
    // a deploy. Settle falls open (flyctl unreadable), the backup crashes, and the
    // now-readable v10 must NOT be read as a deploy that dropped the backup.
    const result = runBackupStep({
      releasesSeq: "fail settled",
      machinesSeq: "fail started",
      sshSeq: "crash",
    });
    expect(result.status).toBe(7);
    expect(result.stderr).toContain("customer_backup_run_failed");
    expect(result.stderr).toContain("no_deploy_confirmed");
    // No retry: exactly one ssh attempt.
    expect(result.sshCalls.length).toBe(1);
  }, 60_000);

  it("item 3: takes the baseline from settle's final read, not a second racing read", () => {
    // A second read after settle could observe a deploy (v11) that began in the
    // gap and record 11 as the baseline; the post-drop read would then see the
    // SAME v11 and miss it, firing a false crash alert. The single read keeps the
    // baseline at v10, so the v11 deploy that dropped the backup is confirmed and
    // the retry succeeds. The retry log proves the baseline stayed v10.
    const result = runBackupStep({
      releasesSeq: "settled newer settled-v11",
      machinesSeq: "started started started",
      sshSeq: "severed ok",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.sshCalls.length).toBe(2);
    expect(result.stdout).toContain("customer_backup_retry_after_confirmed_deploy pre_version=10");
  }, 60_000);

  it("item 2: judges each attempt on its OWN output, not both attempts appended", () => {
    // Attempt 1 prints backupId + publication then drops (a confirmed deploy);
    // attempt 2 exits 0 printing ONLY manifestAuthentication. Grepping the shared
    // evidence log (both attempts) would find all three and pass; grepping the
    // current attempt's output alone correctly fails the partial second attempt.
    const result = runBackupStep({
      releasesSeq: "settled newer settled-v11",
      machinesSeq: "started started started",
      sshSeq: "partA-fail partB-ok",
    });
    expect(result.status).not.toBe(0);
    // Both attempts ran (a retry did happen), and the run still failed.
    expect(result.sshCalls.length).toBe(2);
  }, 60_000);

  it("item 4: shares ONE deadline across both settle windows; the retry cannot buy a second budget", () => {
    // First settle waits out an inflight deploy (one 50s poll) and settles on v10;
    // the backup is dropped by a confirmed v11 deploy; the retry settle then finds
    // v11 still in progress. With ONE shared 100s deadline the retry has no budget
    // left and fails loudly; a per-call deadline would hand it a fresh 100s and let
    // it settle and back up. Fake clock so the 100s budget is exercised instantly.
    const result = runBackupStep({
      releasesSeq: "inflight settled newer newer newer settled-v11",
      machinesSeq: "started",
      sshSeq: "severed ok",
      settleMaxSeconds: "100",
      settlePollSeconds: "50",
      fakeClock: true,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_deploy_did_not_settle");
    // The retry never reached a second ssh: the shared deadline was already spent.
    expect(result.sshCalls.length).toBe(1);
  }, 60_000);

  it("R1: settles before the retry, so it never runs straight into the still-in-progress deploy", () => {
    // Drop the settle_wait before the retry and the confirmed-but-still-running
    // deploy is backed up into immediately. Here the deploy stays in progress and
    // the budget is zero, so settling first fails loudly rather than retrying.
    const result = runBackupStep({
      releasesSeq: "settled newer newer",
      machinesSeq: "started started started",
      sshSeq: "severed ok",
      settleMaxSeconds: "0",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_deploy_did_not_settle");
    // The retry never reached a second ssh: it must settle first.
    expect(result.sshCalls.length).toBe(1);
  }, 60_000);

  it("R2: waits for a just-booted machine (recent release) instead of failing it as #659", () => {
    // A recent complete deploy whose machine is momentarily still starting must be
    // waited out. Drop the recent-boot allowance and this booting machine is
    // failed as a #659 stopped machine.
    const result = runBackupStep({
      releasesSeq: "settled settled",
      machinesSeq: "stopped started",
      sshSeq: "ok",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.sshCalls.length).toBe(1);
    expect(result.stderr).not.toContain("customer_backup_machine_stopped_no_deploy");
  }, 60_000);

  it("R3: treats a pending release as a deploy in progress, so it does not back up mid-deploy", () => {
    // Drop `pending` from release_in_progress and the step backs up during a
    // pending deploy. Here the zero budget makes the correct behaviour fail loudly.
    const result = runBackupStep({
      releasesSeq: "pending",
      machinesSeq: "started",
      sshSeq: "ok",
      settleMaxSeconds: "0",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_deploy_did_not_settle");
    expect(result.sshCalls.length).toBe(0);
  }, 60_000);

  it("R4: treats an unknown release age as OLD, so a stopped machine with no readable age is a #659", () => {
    // A complete release with no CreatedAt has an UNKNOWN age. Treat unknown as
    // recent and a genuine #659 stopped machine becomes a settle-wait that times
    // out; treat it as old (correct) and it fails immediately as the #659 it is.
    const result = runBackupStep({
      releasesSeq: "complete-noage",
      machinesSeq: "stopped",
      sshSeq: "ok",
      settleMaxSeconds: "0",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_machine_stopped_no_deploy");
    expect(result.stderr).not.toContain("customer_backup_deploy_did_not_settle");
    expect(result.sshCalls.length).toBe(0);
  }, 60_000);

  it("R6: confirms a retry on an in-progress newest release even when the version did not advance", () => {
    // Baseline v10 complete; ssh severed; the confirm read sees v10 now RUNNING (a
    // restart of the same version -- version did not advance) which is a deploy in
    // progress. Drop the in-progress confirmation and this fails as no_deploy.
    const result = runBackupStep({
      releasesSeq: "settled inflight settled",
      machinesSeq: "started started started",
      sshSeq: "severed ok",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.sshCalls.length).toBe(2);
    expect(result.stdout).toContain("customer_backup_retry_after_confirmed_deploy");
  }, 60_000);

  it("R8: requires ALL of backupId, manifestAuthentication and publication in the attempt output", () => {
    // ssh exits 0 but the output is missing manifestAuthentication. Cut the three
    // evidence greps to one (backupId) and this partial output passes.
    const result = runBackupStep({
      releasesSeq: "settled",
      machinesSeq: "started",
      sshSeq: "partial-nomanifest",
    });
    expect(result.status).not.toBe(0);
  }, 60_000);
});

/**
 * The two consumers that the BLOCKER was about -- the delivery controller's
 * `latest_successful_backup` filter and the execution-gate fence -- both key on
 * a `backup` job whose conclusion is `success`. With the deferred-green outcome
 * removed, the backup job reaches `success` ONLY after a verified backup; a
 * deploy-in-progress, a stopped machine, or a crash all end in `failure`. The
 * test below EXTRACTS both filters from the shipped YAML and runs them against a
 * conclusion DERIVED from actually running the shipped step, so neither the
 * filter text nor the "a non-backup is a failure" claim is hand-written here.
 */
function jqBool(filter: string, input: unknown): string {
  // Invoke jq through bash (as the workflow does) rather than spawning the binary
  // directly, which is not portable on this Windows host; the filter is passed by
  // env so its quoting never has to survive an argv round-trip.
  const result = spawnSync("bash", ["-c", `"${REAL_JQ}" -r "$JQ_FILTER"`], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, JQ_FILTER: filter },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe("backup-job outcome, derived by running the shipped step, drives both consumers", () => {
  const deliverySource = readFileSync(
    resolve(root, ".github/workflows/customer-backup-delivery.yml"),
    "utf8",
  );
  const backupSource = readFileSync(
    resolve(root, ".github/workflows/customer-backup.yml"),
    "utf8",
  );

  /** The delivery controller's single-quoted jq that counts a successful backup job. */
  function extractDeliveryFilter(): string {
    const found = /--jq '(\[\.jobs\[\][^']*length)'/.exec(deliverySource);
    if (!found) {
      throw new Error("delivery backup-success filter not found in customer-backup-delivery.yml");
    }
    return found[1];
  }

  /**
   * The execution-gate fence's double-quoted jq. Its embedded quotes are
   * backslash-escaped and it interpolates the shell var $current_created_at, so
   * unescape the quotes and bind the timestamp to a concrete floor to run it.
   */
  function extractFenceFilter(completedAtFloor: string): string {
    const found = /--jq "(\[\.jobs\[\].*?length)"/.exec(backupSource);
    if (!found) {
      throw new Error("execution-gate fence filter not found in customer-backup.yml");
    }
    return found[1].replace(/\\"/g, '"').replace(/\$current_created_at/g, completedAtFloor);
  }

  /** GitHub derives a job's conclusion from its steps: a failed step -> failure. */
  function conclusionOf(result: { status: number | null }): "success" | "failure" {
    return result.status === 0 ? "success" : "failure";
  }
  const jobShape = (conclusion: string) => ({
    jobs: [{ name: "backup", conclusion, completedAt: "2026-09-24T12:00:00Z" }],
  });

  it("extracts non-empty backup-success filters from both shipped workflows", () => {
    const delivery = extractDeliveryFilter();
    const fence = extractFenceFilter("2026-09-24T00:00:00Z");
    for (const filter of [delivery, fence]) {
      expect(filter).toContain(".jobs[]");
      expect(filter).toContain('.name == "backup"');
      expect(filter).toContain('.conclusion == "success"');
    }
    // The fence adds the completedAt floor the delivery filter does not.
    expect(fence).toContain(".completedAt >=");
    expect(delivery).not.toContain(".completedAt");
  });

  it("a real backup counts for both consumers; a non-backup cycle never does", () => {
    // The conclusions are DERIVED by running the shipped backup step, not written
    // by hand: a real verified backup (exit 0 -> success) and a #659 stopped-machine
    // cycle that takes no backup (exit != 0 -> failure). If the non-backup path ever
    // went green again (the deferred-green regression), conclusionOf would return
    // "success" and both filters would count it -- exactly what these forbid.
    const realBackup = runBackupStep({
      releasesSeq: "settled",
      machinesSeq: "started",
      sshSeq: "ok",
    });
    expect(realBackup.status, realBackup.stderr).toBe(0);
    const nonBackup = runBackupStep({
      releasesSeq: "stale-complete",
      machinesSeq: "stopped",
      sshSeq: "ok",
      settleMaxSeconds: "1",
    });
    expect(nonBackup.status).not.toBe(0);

    const realConclusion = conclusionOf(realBackup);
    const nonConclusion = conclusionOf(nonBackup);
    expect(realConclusion).toBe("success");
    expect(nonConclusion).toBe("failure");

    const delivery = extractDeliveryFilter();
    const fence = extractFenceFilter("2026-09-24T00:00:00Z");

    expect(jqBool(delivery, jobShape(realConclusion))).toBe("1");
    expect(jqBool(delivery, jobShape(nonConclusion))).toBe("0");
    expect(jqBool(fence, jobShape(realConclusion))).toBe("1");
    expect(jqBool(fence, jobShape(nonConclusion))).toBe("0");
  }, 60_000);
});
