import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { CORE_DISASTER_RECOVERY_POLICY } from "@mendpoint/ops";
import {
  customerBackupIntervalMs,
  customerBackupOperationTimeoutMs,
} from "./customer-backup-scheduler.js";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  BACKUP_FRESHNESS_INDETERMINATE_REASONS,
  assessBackupEvidenceFreshness,
  resolveBackupEvidenceCapture,
  resolveBackupRpoSeconds,
  redactedReport,
  type BackupFreshnessIndeterminateReason,
} from "./check-customer-backup-freshness.js";

const root = resolve(import.meta.dirname, "..");
const RPO = CORE_DISASTER_RECOVERY_POLICY.rpoSeconds;
const NOW = "2026-08-30T12:00:00.000Z";

/** Obviously fake, never a real digest or key id. */
const FAKE_DIGEST = "f".repeat(64);
const FAKE_KEY_ID = "fake-test-key-id";

function evidenceDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    backupId: "customer-2026-08-30T11-45-00-000Z",
    backupRoot: "/data/db/backups/customer-2026-08-30T11-45-00-000Z",
    createdAt: "2026-08-30T11:45:00.000Z",
    verifiedAt: "2026-08-30T11:46:00.000Z",
    keyId: FAKE_KEY_ID,
    manifestAuthentication: FAKE_DIGEST,
    integrity: { algorithm: "hmac-sha256", keyId: FAKE_KEY_ID, digest: FAKE_DIGEST },
    ...overrides,
  };
}

function judge(text: string | null, status: number | null = 0, now = NOW) {
  return assessBackupEvidenceFreshness({
    capture: { status, text },
    now,
    rpoSeconds: RPO,
  });
}

/**
 * The shared harness for running SHIPPED workflow step scripts under the shell
 * GitHub actually uses. Module scope because both the read-step suite and the
 * remediation suite below run the same steps the same way; a second private
 * copy of these stubs is how one suite would start testing a different shell
 * than the other.
 */
/** Exactly what GitHub passes for `shell: bash`. Not our own choice of flags. */
const GITHUB_BASH_FLAGS = ["--noprofile", "--norc", "-e", "-o", "pipefail"];

/** A fake app that cannot resolve, so a PATH miss can never reach production. */
const STUB_APP = "stub-app-that-does-not-exist";
const STUB_TOKEN = "stub-token-not-a-real-secret";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "watchdog-step-"));
}

function stubBin(dir: string, name: string, body: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, name);
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return bin;
}

/**
 * `flyctl ssh console --command` does NOT hand the string to a shell on the
 * machine: fly word-splits it and execs the result. This stub reproduces that
 * exactly, because a stub that ran the command through a shell would have
 * made the shipped command look fine while production read nothing. Against
 * the real machine the un-shelled form produced, verbatim:
 *
 *     cat: '$MENDPOINT_BACKUP_EVIDENCE_PATH': No such file or directory
 */
const FLY_EXEC_STUB = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
const command = argv[argv.indexOf("--command") + 1];
const words = [];
let cur = "";
let quote = null;
let started = false;
for (const ch of command) {
if (quote) {
  if (ch === quote) quote = null;
  else cur += ch;
  continue;
}
if (ch === "'" || ch === '"') {
  quote = ch;
  started = true;
  continue;
}
if (ch === " ") {
  if (started || cur) {
    words.push(cur);
    cur = "";
    started = false;
  }
  continue;
}
cur += ch;
started = true;
}
if (started || cur) words.push(cur);
const result = spawnSync(words[0], words.slice(1), { stdio: "inherit", env: process.env });
process.exit(result.status === null ? 1 : result.status);
`;

describe("customer backup freshness — the fresh case", () => {
  it("passes when the newest verified backup is inside the RPO", () => {
    const verdict = judge(JSON.stringify(evidenceDocument()));
    expect(verdict.state).toBe("fresh");
    expect(verdict).toMatchObject({ ageSeconds: 900, rpoSeconds: RPO });
  });

  it("takes the RPO from the recovery policy, not a second constant", () => {
    expect(resolveBackupRpoSeconds()).toBe(CORE_DISASTER_RECOVERY_POLICY.rpoSeconds);
    // Exactly at the boundary the readiness check calls current, so does this.
    const boundary = judge(
      JSON.stringify(evidenceDocument({ createdAt: "2026-08-30T11:00:00.000Z" })),
    );
    expect(boundary.state).toBe("fresh");
    expect(boundary).toMatchObject({ ageSeconds: RPO });
  });
});

describe("customer backup freshness — the alarm fires when backups stop", () => {
  it("fires when evidence is older than the RPO even though nothing failed", () => {
    // One second past the RPO: no workflow failed, no run errored, and the
    // backup is nonetheless out of policy. This is the skipped-run case.
    const verdict = judge(
      JSON.stringify(evidenceDocument({ createdAt: "2026-08-30T10:59:59.000Z" })),
    );
    expect(verdict.state).toBe("stale");
    expect(verdict).toMatchObject({ ageSeconds: RPO + 1 });
    expect(verdict.summary).toContain("PAST");
  });

  it("fires on the multi-hour gap that a dropped */30 schedule actually produced", () => {
    const verdict = judge(
      JSON.stringify(evidenceDocument({
        createdAt: "2026-08-30T06:11:00.000Z",
        verifiedAt: "2026-08-30T06:12:00.000Z",
      })),
    );
    expect(verdict.state).toBe("stale");
    expect(verdict).toMatchObject({ ageSeconds: 20_940 });
  });
});

describe("customer backup freshness — every unreachable answer alarms, none passes", () => {
  const cases: ReadonlyArray<{
    reason: BackupFreshnessIndeterminateReason;
    build: () => ReturnType<typeof assessBackupEvidenceFreshness>;
  }> = [
    { reason: "capture_status_unknown", build: () => judge("{}", null) },
    // ssh refused, machine stopped, remote file absent, or the read timed out.
    { reason: "remote_read_failed", build: () => judge("", 1) },
    // flyctl can exit 0 having produced nothing; that is not an empty backup log.
    { reason: "evidence_empty", build: () => judge("   ", 0) },
    { reason: "evidence_empty", build: () => judge(null, 0) },
    { reason: "evidence_unparseable", build: () => judge("{not json") },
    { reason: "evidence_not_object", build: () => judge("[]") },
    {
      reason: "integrity_block_absent",
      build: () => judge(JSON.stringify(evidenceDocument({ integrity: undefined }))),
    },
    {
      reason: "backup_id_absent",
      build: () => judge(JSON.stringify(evidenceDocument({ backupId: "" }))),
    },
    {
      reason: "created_at_absent",
      build: () => judge(JSON.stringify(evidenceDocument({ createdAt: undefined }))),
    },
    {
      reason: "created_at_unparseable",
      build: () => judge(JSON.stringify(evidenceDocument({ createdAt: "not-a-date" }))),
    },
    {
      reason: "verified_at_absent",
      build: () => judge(JSON.stringify(evidenceDocument({ verifiedAt: undefined }))),
    },
    {
      reason: "verified_at_unparseable",
      build: () => judge(JSON.stringify(evidenceDocument({ verifiedAt: "not-a-date" }))),
    },
    {
      reason: "verification_precedes_creation",
      build: () =>
        judge(JSON.stringify(evidenceDocument({ verifiedAt: "2026-08-30T11:44:00.000Z" }))),
    },
    {
      reason: "clock_skew_future",
      build: () =>
        judge(JSON.stringify(evidenceDocument({
          createdAt: "2026-08-30T13:00:00.000Z",
          verifiedAt: "2026-08-30T13:01:00.000Z",
        }))),
    },
    { reason: "now_unreadable", build: () => judge(JSON.stringify(evidenceDocument()), 0, "later") },
    {
      reason: "rpo_unreadable",
      build: () =>
        assessBackupEvidenceFreshness({
          capture: { status: 0, text: JSON.stringify(evidenceDocument()) },
          now: NOW,
          rpoSeconds: Number.NaN,
        }),
    },
  ];

  for (const { reason, build } of cases) {
    it(`reports ${reason} as indeterminate, never as fresh`, () => {
      const verdict = build();
      expect(verdict.state).toBe("indeterminate");
      expect(verdict.state === "indeterminate" && verdict.reason).toBe(reason);
      expect(verdict.state).not.toBe("fresh");
    });
  }

  it("covers every declared indeterminate reason with a case", () => {
    // A reason that no test can produce is a reason nobody has proved reachable.
    expect(new Set(cases.map((entry) => entry.reason))).toEqual(
      new Set(BACKUP_FRESHNESS_INDETERMINATE_REASONS),
    );
  });

  it("never lets an unreachable answer become the reassuring one", () => {
    for (const { build } of cases) {
      expect(build().state).not.toBe("fresh");
    }
  });
});

describe("customer backup freshness — the reported verdict leaks no key material", () => {
  it("omits the evidence key id and integrity digest from the report", () => {
    const verdict = judge(JSON.stringify(evidenceDocument()));
    const serialized = JSON.stringify(redactedReport(verdict, NOW));
    expect(serialized).not.toContain(FAKE_DIGEST);
    expect(serialized).not.toContain(FAKE_KEY_ID);
    expect(serialized).toContain("customer-2026-08-30T11-45-00-000Z");
  });
});

describe("customer backup freshness — the script's exit codes", () => {
  function runScript(env: Record<string, string>): { status: number; stderr: string; report: string } {
    const dir = mkdtempSync(join(tmpdir(), "backup-watchdog-"));
    const reportPath = join(dir, "verdict.json");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/check-customer-backup-freshness.ts"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MENDPOINT_BACKUP_FRESHNESS_REPORT_PATH: reportPath,
          ...env,
        },
      },
    );
    return {
      status: result.status ?? -1,
      stderr: result.stderr ?? "",
      report: readFileSync(reportPath, "utf8"),
    };
  }

  function captureFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "backup-capture-"));
    const path = join(dir, "evidence-capture.json");
    writeFileSync(path, contents, "utf8");
    return path;
  }

  it("exits 0 only for a provably fresh backup", () => {
    const fresh = evidenceDocument({
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      verifiedAt: new Date(Date.now() - 30_000).toISOString(),
    });
    const run = runScript({
      MENDPOINT_BACKUP_EVIDENCE_CAPTURE_PATH: captureFile(JSON.stringify(fresh)),
      MENDPOINT_BACKUP_EVIDENCE_CAPTURE_STATUS: "0",
    });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.report).state).toBe("fresh");
  });

  it("exits 1 for a stale backup", () => {
    const stale = evidenceDocument({
      createdAt: new Date(Date.now() - (RPO + 600) * 1_000).toISOString(),
      verifiedAt: new Date(Date.now() - (RPO + 500) * 1_000).toISOString(),
    });
    const run = runScript({
      MENDPOINT_BACKUP_EVIDENCE_CAPTURE_PATH: captureFile(JSON.stringify(stale)),
      MENDPOINT_BACKUP_EVIDENCE_CAPTURE_STATUS: "0",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("customer_backup_stale");
  });

  it("exits 1 when the remote read failed, and never reports fresh", () => {
    const run = runScript({
      MENDPOINT_BACKUP_EVIDENCE_CAPTURE_PATH: captureFile(""),
      MENDPOINT_BACKUP_EVIDENCE_CAPTURE_STATUS: "255",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("customer_backup_indeterminate reason=remote_read_failed");
    expect(JSON.parse(run.report).state).toBe("indeterminate");
  });

  it("exits 1 when the capture file is absent entirely", () => {
    const run = runScript({
      MENDPOINT_BACKUP_EVIDENCE_CAPTURE_PATH: join(tmpdir(), "backup-watchdog-does-not-exist.json"),
      MENDPOINT_BACKUP_EVIDENCE_CAPTURE_STATUS: "0",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("customer_backup_indeterminate reason=evidence_empty");
  });

  it("exits 1 when the evidence is malformed", () => {
    const run = runScript({
      MENDPOINT_BACKUP_EVIDENCE_CAPTURE_PATH: captureFile("{truncated"),
      MENDPOINT_BACKUP_EVIDENCE_CAPTURE_STATUS: "0",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("customer_backup_indeterminate reason=evidence_unparseable");
  });

  it("exits 1 when no capture was configured at all", () => {
    const run = runScript({
      MENDPOINT_BACKUP_EVIDENCE_CAPTURE_PATH: "",
      MENDPOINT_BACKUP_EVIDENCE_CAPTURE_STATUS: "",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("customer_backup_indeterminate reason=capture_status_unknown");
  });
});

describe("resolveBackupEvidenceCapture", () => {
  it("keeps a lost status and a missing file as nulls rather than benign defaults", () => {
    expect(resolveBackupEvidenceCapture({})).toEqual({ status: null, text: null });
    expect(
      resolveBackupEvidenceCapture({ MENDPOINT_BACKUP_EVIDENCE_CAPTURE_STATUS: "nonsense" }),
    ).toEqual({ status: null, text: null });
    expect(
      resolveBackupEvidenceCapture({
        MENDPOINT_BACKUP_EVIDENCE_CAPTURE_STATUS: "0",
        MENDPOINT_BACKUP_EVIDENCE_CAPTURE_PATH: join(tmpdir(), "absent-capture-file.json"),
      }),
    ).toEqual({ status: 0, text: null });
  });
});

describe("customer backup watchdog workflow", () => {
  const workflow = parse(
    readFileSync(resolve(root, ".github/workflows/customer-backup-watchdog.yml"), "utf8"),
  ) as Record<string, any>;
  const steps = workflow.jobs.freshness.steps as Record<string, any>[];

  function step(name: string): Record<string, any> {
    const found = steps.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`step not found: ${name}`);
    return found;
  }

  it("does not run on the same dropped */30 schedule it exists to catch", () => {
    expect(workflow.on.schedule).toEqual([{ cron: "29 * * * *" }]);
    expect(workflow.on.schedule).not.toContainEqual({ cron: "*/30 * * * *" });
  });

  it("has a second delivery path that does not depend on the cron scheduler", () => {
    expect(workflow.on.workflow_run).toMatchObject({
      workflows: ["CI"],
      types: ["completed"],
    });
    expect(workflow.jobs["profile-gate"].if).toContain("default_branch");
    // And production is only ever read from the reviewed default branch.
    expect(workflow.jobs.freshness.if).toContain(
      "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
    );
  });

  it("never cancels a scheduled run, so the alarm cannot be lost to a merge burst", () => {
    expect(workflow.concurrency.group).toContain("github.run_id");
    expect(workflow.concurrency["cancel-in-progress"]).toContain(
      "github.event_name == 'workflow_run'",
    );
  });

  it("reads the evidence path from the machine rather than restating it", () => {
    const read = step("Read backup evidence from the customer machine");
    expect(read.run).toContain(String.raw`cat \"\$MENDPOINT_BACKUP_EVIDENCE_PATH\"`);
    expect(read.run).not.toContain("/data/db/.backup-state");
    // fly execs `--command` without a remote shell, so the expansion has to be
    // asked for explicitly or the machine receives the literal `$VAR` name.
    expect(read.run).toContain(String.raw`--command "sh -c 'cat \"\$MENDPOINT_BACKUP_EVIDENCE_PATH\"'"`);
    // A hung or blocked read must become a status, never a hang or a pass.
    expect(read.run).toContain("timeout 300 flyctl ssh console");
    expect(read.run).toContain("</dev/null");
    expect(read.run).toContain('echo "status=$status" >> "$GITHUB_OUTPUT"');
  });

  it("introduces no new secret or variable", () => {
    const read = step("Read backup evidence from the customer machine");
    expect(read.env.FLY_API_TOKEN).toBe("${{ secrets.MENDPOINT_CUSTOMER_BACKUP_FLY_TOKEN }}");
    expect(read.env.CUSTOMER_APP).toBe("${{ vars.MENDPOINT_CUSTOMER_FLY_APP }}");
  });

  it("never uploads or echoes the raw capture, which carries key material", () => {
    const retain = step("Retain the redacted freshness verdict");
    expect(retain.with.path).toBe("test-results/customer-backup-watchdog/verdict.json");
    expect(retain.with.path).not.toContain("evidence-capture");
    const read = step("Read backup evidence from the customer machine");
    expect(read.run).not.toContain('cat "$capture"');
  });

  it("deduplicates the alert into one issue instead of filing one per run", () => {
    const alert = step("Alert on stale or undetermined backup freshness");
    expect(alert.if).toBe("${{ failure() }}");
    expect(alert.run).toContain('gh issue list --repo "$GH_REPO" --state open --label "$label"');
    expect(alert.run).toContain('if [ -n "$existing" ]; then');
    expect(alert.run).toContain("gh issue comment");
    expect(alert.run).toContain("gh issue create");
  });

  it("alerts under its own label so a single late success cannot silence it", () => {
    const alert = step("Alert on stale or undetermined backup freshness");
    expect(alert.run).toContain('label="customer-production-backup-stale"');
    expect(alert.run).not.toContain("customer-production-backup-failure");
    // The watchdog failing to produce a verdict is itself an alert, not a pass.
    expect(alert.run).toContain("watchdog_produced_no_verdict");
  });

  it("closes the alert only on a proven-fresh verdict", () => {
    const resolveStep = step("Resolve the staleness alert once backups are provably current");
    expect(resolveStep.if).toBe("${{ success() }}");
    expect(resolveStep.run).toContain("gh issue close");
  });

  it("leaves the backup workflow's fallback schedule, RPO and alert untouched", () => {
    const backup = parse(
      readFileSync(resolve(root, ".github/workflows/customer-backup.yml"), "utf8"),
    ) as Record<string, any>;
    // The cron is now the dead-machine fallback, not the primary trigger. What
    // this watchdog needs from it is unchanged: it still exists, it is still
    // dispatchable, and it still alerts when a run fails.
    expect(backup.on.schedule).toEqual([{ cron: "47 * * * *" }]);
    expect(backup.on).toHaveProperty("workflow_dispatch");
    const alert = (backup.jobs.backup.steps as Record<string, any>[]).find(
      (candidate) => candidate.name === "Alert on backup failure",
    );
    expect(alert?.if).toBe("${{ failure() }}");
    expect(alert?.run).toContain('label="customer-production-backup-failure"');
  });
});

/**
 * Running the SHIPPED step scripts under the SHELL GITHUB ACTUALLY USES.
 *
 * The tests above assert on the text of the workflow, which is worth doing but
 * cannot see a defect that exists only because of the runner's shell flags. The
 * read step's status capture was written `set -uo pipefail` — deliberately
 * without `-e` — so that `status=$?` could observe a failed remote read. But
 * GitHub invokes a `shell: bash` step as
 *
 *     /usr/bin/bash --noprofile --norc -e -o pipefail {0}
 *
 * (quoted verbatim from run 33302784500), and a script's own `set -uo pipefail`
 * does not cancel the `-e` it was invoked with. The step therefore died ON the
 * failing command: `status=$?` never ran, no status output was written, the
 * judge step was SKIPPED, and the whole failure surfaced two steps later as an
 * artifact-upload error about a missing verdict.json. That is exactly the
 * third-state defect this watchdog was built to prevent, reproduced inside the
 * watchdog: "could not read" had no way to be reported, so it came out as
 * something unrelated.
 *
 * A test that runs the extracted script under the test harness's own flags
 * cannot catch that class of bug, because the bug IS the flags. So these run it
 * under GitHub's, against a stubbed flyctl, and assert the step keeps going.
 */
describe("customer backup watchdog — the shipped steps under GitHub's real shell", () => {
  const workflowSteps = (
    parse(
      readFileSync(resolve(root, ".github/workflows/customer-backup-watchdog.yml"), "utf8"),
    ) as Record<string, any>
  ).jobs.freshness.steps as Record<string, any>[];

  function shippedStep(name: string): Record<string, any> {
    const found = workflowSteps.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`step not found: ${name}`);
    // If a step ever stops being `shell: bash`, the flags below stop being the
    // ones it runs under and every assertion here would be measuring fiction.
    expect(found.shell).toBe("bash");
    return found;
  }

  function runShippedStep(
    run: string,
    options: { cwd: string; bin?: string; env?: Record<string, string> },
  ): { status: number | null; stdout: string; stderr: string; output: string } {
    writeFileSync(join(options.cwd, "step.sh"), run, "utf8");
    const outputPath = join(options.cwd, "github-output");
    writeFileSync(outputPath, "", "utf8");
    const result = spawnSync("bash", [...GITHUB_BASH_FLAGS, "step.sh"], {
      cwd: options.cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: options.bin ? `${options.bin}${delimiter}${process.env.PATH ?? ""}` : process.env.PATH,
        GITHUB_OUTPUT: outputPath,
        ...options.env,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      output: readFileSync(outputPath, "utf8"),
    };
  }

  function verdictFor(cwd: string, captureStatus: string): { status: number; report: any } {
    const reportPath = join(cwd, "verdict.json");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/check-customer-backup-freshness.ts"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MENDPOINT_BACKUP_EVIDENCE_CAPTURE_PATH: join(
            cwd,
            "test-results/customer-backup-watchdog/evidence-capture.json",
          ),
          MENDPOINT_BACKUP_EVIDENCE_CAPTURE_STATUS: captureStatus,
          MENDPOINT_BACKUP_FRESHNESS_REPORT_PATH: reportPath,
        },
      },
    );
    return { status: result.status ?? -1, report: JSON.parse(readFileSync(reportPath, "utf8")) };
  }

  it("declares the same strictness the runner imposes, instead of disagreeing with it", () => {
    // The regression was a script that quietly assumed flags it was not given.
    // Stating `-e` here means the file and its harness say the same thing, and
    // the single command allowed to fail says so explicitly.
    const read = shippedStep("Read backup evidence from the customer machine");
    expect(read.run).toContain("set -euo pipefail");
    expect(read.run).not.toContain("set -uo pipefail\n");
    expect(read.run).toContain("|| status=$?");
    // `status=$?` on its own line is the form that `-e` killed before it ran.
    expect(read.run).not.toMatch(/^\s*status=\$\?\s*$/m);
  });

  it("records a failing remote read as a status instead of dying on the runner's -e", () => {
    const dir = workspace();
    const bin = stubBin(
      dir,
      "flyctl",
      "#!/bin/sh\necho 'ssh: connect to host failed' >&2\nexit 14\n",
    );
    const result = runShippedStep(
      shippedStep("Read backup evidence from the customer machine").run,
      { cwd: dir, bin, env: { FLY_API_TOKEN: STUB_TOKEN, CUSTOMER_APP: STUB_APP } },
    );

    // The step SURVIVES the failure it exists to observe.
    expect(result.status).toBe(0);
    expect(result.output).toContain("status=14");
    expect(result.stdout).toContain("read exit status: 14");
    // Nothing was captured, and the capture file still exists rather than being
    // absent, so the judge sees "empty", not "missing step".
    expect(
      readFileSync(join(dir, "test-results/customer-backup-watchdog/evidence-capture.json"), "utf8"),
    ).toBe("");
  });

  it("turns that recorded failure into remote_read_failed, the named third state", () => {
    const dir = workspace();
    const bin = stubBin(dir, "flyctl", "#!/bin/sh\nexit 14\n");
    const step = runShippedStep(
      shippedStep("Read backup evidence from the customer machine").run,
      { cwd: dir, bin, env: { FLY_API_TOKEN: STUB_TOKEN, CUSTOMER_APP: STUB_APP } },
    );
    const captured = /status=(\d+)/.exec(step.output)?.[1];
    expect(captured).toBe("14");

    const judged = verdictFor(dir, captured as string);
    expect(judged.status).toBe(1);
    expect(judged.report.state).toBe("indeterminate");
    expect(judged.report.reason).toBe("remote_read_failed");
    // A verdict on disk is what the retain step uploads. Its absence was the
    // error the operator actually saw.
    expect(judged.report.summary).toContain("exit 14");
  });

  it("records a missing app binding as status 78 rather than aborting the step", () => {
    const dir = workspace();
    const bin = stubBin(dir, "flyctl", "#!/bin/sh\nexit 0\n");
    const result = runShippedStep(
      shippedStep("Read backup evidence from the customer machine").run,
      { cwd: dir, bin, env: { FLY_API_TOKEN: "", CUSTOMER_APP: "" } },
    );
    expect(result.status).toBe(0);
    expect(result.output).toContain("status=78");
    expect(result.stderr).toContain("customer_backup_watchdog_binding_missing");
    expect(verdictFor(dir, "78").report.reason).toBe("remote_read_failed");
  });

  it("has the MACHINE expand its own evidence path, which needs a shell on the machine", () => {
    const dir = workspace();
    const bin = stubBin(dir, "flyctl", FLY_EXEC_STUB);
    const evidencePath = join(dir, "last-verified.json");
    const document = evidenceDocument();
    writeFileSync(evidencePath, JSON.stringify(document), "utf8");

    const result = runShippedStep(
      shippedStep("Read backup evidence from the customer machine").run,
      {
        cwd: dir,
        bin,
        env: {
          FLY_API_TOKEN: STUB_TOKEN,
          CUSTOMER_APP: STUB_APP,
          // The machine's own value, exactly as the workflow intends to use it.
          MENDPOINT_BACKUP_EVIDENCE_PATH: evidencePath,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.output).toContain("status=0");
    const captured = readFileSync(
      join(dir, "test-results/customer-backup-watchdog/evidence-capture.json"),
      "utf8",
    );
    // Without the remote `sh -c`, this file is empty and the run says
    // `remote_read_failed` forever while the backups are perfectly healthy.
    expect(JSON.parse(captured).backupId).toBe(document.backupId);
  });

  it("still reaches a fresh verdict end to end through the shipped read step", () => {
    const dir = workspace();
    const bin = stubBin(dir, "flyctl", FLY_EXEC_STUB);
    const evidencePath = join(dir, "last-verified.json");
    writeFileSync(evidencePath, JSON.stringify(evidenceDocument({
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      verifiedAt: new Date(Date.now() - 30_000).toISOString(),
    })), "utf8");

    const step = runShippedStep(
      shippedStep("Read backup evidence from the customer machine").run,
      {
        cwd: dir,
        bin,
        env: {
          FLY_API_TOKEN: STUB_TOKEN,
          CUSTOMER_APP: STUB_APP,
          MENDPOINT_BACKUP_EVIDENCE_PATH: evidencePath,
        },
      },
    );
    expect(step.output).toContain("status=0");
    const judged = verdictFor(dir, "0");
    expect(judged.status).toBe(0);
    expect(judged.report.state).toBe("fresh");
  });

  it("never echoes the capture, so key material cannot reach the run log", () => {
    const dir = workspace();
    const bin = stubBin(dir, "flyctl", FLY_EXEC_STUB);
    const evidencePath = join(dir, "last-verified.json");
    writeFileSync(evidencePath, JSON.stringify(evidenceDocument()), "utf8");
    const result = runShippedStep(
      shippedStep("Read backup evidence from the customer machine").run,
      {
        cwd: dir,
        bin,
        env: {
          FLY_API_TOKEN: STUB_TOKEN,
          CUSTOMER_APP: STUB_APP,
          MENDPOINT_BACKUP_EVIDENCE_PATH: evidencePath,
        },
      },
    );
    // Asserted against the real captured bytes, not against the source text.
    expect(result.stdout).not.toContain(FAKE_DIGEST);
    expect(result.stdout).not.toContain(FAKE_KEY_ID);
    expect(result.stderr).not.toContain(FAKE_DIGEST);
    expect(result.stderr).not.toContain(FAKE_KEY_ID);
  });
});

/**
 * The meta case. If the judge step itself cannot run to completion there is no
 * verdict, and the operator used to learn this as `No files were found with the
 * provided path` from the artifact upload — an error about storage, describing
 * an unknown backup age. `watchdog_produced_no_verdict` is the name for it, and
 * these tests make that name a real, retained document rather than a string
 * that only ever appeared in an unreachable branch of the alert step.
 */
describe("customer backup watchdog — the watchdog's own failure has a name", () => {
  const workflow = parse(
    readFileSync(resolve(root, ".github/workflows/customer-backup-watchdog.yml"), "utf8"),
  ) as Record<string, any>;
  const steps = workflow.jobs.freshness.steps as Record<string, any>[];
  const META_REASON = "watchdog_produced_no_verdict";

  function step(name: string): Record<string, any> {
    const found = steps.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`step not found: ${name}`);
    return found;
  }

  function runMetaStep(cwd: string): number | null {
    writeFileSync(join(cwd, "meta.sh"), step("Record the meta verdict when the watchdog produced none").run, "utf8");
    return spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "meta.sh"], {
      cwd,
      encoding: "utf8",
    }).status;
  }

  it("judges the read even when the read step failed, instead of being skipped", () => {
    // Skipping was how a failed read became an artifact error. `!cancelled()`
    // rather than `always()`: a cancelled watchdog must not alert, which is the
    // reason the workflow's concurrency group avoids cancelling in the first
    // place.
    expect(step("Judge backup freshness against the policy RPO").if).toBe("${{ !cancelled() }}");
    expect(step("Record the meta verdict when the watchdog produced none").if).toBe(
      "${{ !cancelled() }}",
    );
  });

  it("writes the named meta verdict when the judge produced nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "watchdog-meta-"));
    expect(runMetaStep(dir)).toBe(0);
    const report = JSON.parse(
      readFileSync(join(dir, "test-results/customer-backup-watchdog/verdict.json"), "utf8"),
    );
    expect(report.state).toBe("indeterminate");
    expect(report.reason).toBe(META_REASON);
    // Never "fresh", never silent: an unknown age reads as unknown.
    expect(report.summary).toContain("NOT determined");
  });

  it("leaves a real verdict alone, so it can never overwrite a genuine answer", () => {
    const dir = mkdtempSync(join(tmpdir(), "watchdog-meta-"));
    const reportPath = join(dir, "test-results/customer-backup-watchdog/verdict.json");
    mkdirSync(dirname(reportPath), { recursive: true });
    const real = { checkedAt: NOW, state: "stale", summary: "backups have stopped", rpoSeconds: RPO };
    writeFileSync(reportPath, JSON.stringify(real), "utf8");
    expect(runMetaStep(dir)).toBe(0);
    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toEqual(real);
  });

  it("uses the same reason the alert step reports, so the two cannot drift", () => {
    expect(step("Record the meta verdict when the watchdog produced none").run).toContain(META_REASON);
    expect(step("Alert on stale or undetermined backup freshness").run).toContain(META_REASON);
  });

  it("keeps the meta reason out of the check's own reason list, which stays reachable", () => {
    // The check enumerates answers IT can reach. This one is only reachable
    // when the check did not run, so adding it there would create a member no
    // case could ever produce — a reason that exists but never fires.
    expect(BACKUP_FRESHNESS_INDETERMINATE_REASONS).not.toContain(META_REASON);
  });

  it("keeps the artifact upload strict, now that a verdict always exists", () => {
    // `error` stays meaningful precisely because the meta step guarantees a
    // file: a missing verdict now means the runner itself is broken, not that
    // an earlier step failed.
    const retain = step("Retain the redacted freshness verdict");
    expect(retain.with["if-no-files-found"]).toBe("error");
    expect(retain.if).toBe("${{ always() }}");
  });
});
/**
 * Remediation, proved on the SHIPPED steps under GitHub's real shell.
 *
 * The failure these cover is not a broken backup. Every scheduled
 * `Customer production backup` run that fires SUCCEEDS; GitHub drops its
 * every-30-minutes cron for hours at a time (observed scheduled runs 6h and 8.4h apart against a
 * 3600s RPO), the evidence ages out, `/healthz` goes red, and this watchdog
 * correctly alarms — every hour, forever. The watchdog was right; the delivery
 * was wrong. So the watchdog, which has strictly better delivery than the cron
 * it watches, now dispatches one backup and re-measures before it decides.
 *
 * The whole risk of that change is that remediation quietly becomes a way for a
 * real failure to pass. These tests exist to make that impossible to ship:
 * every one of them asserts on the step scripts as the runner executes them,
 * under `bash --noprofile --norc -e -o pipefail`, against a `gh` and a `flyctl`
 * that cannot reach anything real.
 */
describe("customer backup watchdog — a stale backup is remediated once, before it alerts", () => {
  const steps = (
    parse(
      readFileSync(resolve(root, ".github/workflows/customer-backup-watchdog.yml"), "utf8"),
    ) as Record<string, any>
  ).jobs.freshness.steps as Record<string, any>[];

  function shippedStep(name: string): Record<string, any> {
    const found = steps.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`step not found: ${name}`);
    expect(found.shell).toBe("bash");
    return found;
  }

  const READ = "Read backup evidence from the customer machine";
  const JUDGE = "Judge backup freshness against the policy RPO";
  const REMEDIATE = "Remediate a stale backup with one dispatch, then re-measure";
  const DECIDE = "Fail unless the final verdict is provably fresh";
  const ALERT = "Alert on stale or undetermined backup freshness";

  /**
   * A `gh` that cannot reach GitHub, and that LOGS every invocation, so "how
   * many backups were dispatched" is a counted fact rather than an inference
   * from the script's shape. The env knobs let one stub cover the dispatch
   * refused / run never observed / run failed branches without a second stub
   * that might diverge from this one.
   */
  const GH_STUB = `#!/bin/sh
echo "$1 $2" >> "$GH_STUB_LOG"
case "$1 $2" in
  'workflow run') exit \${GH_STUB_DISPATCH_STATUS:-0} ;;
  'run list') echo "\${GH_STUB_RUN_ID-4242}" ;;
  'run view') echo "\${GH_STUB_RUN_STATE:-completed success}" ;;
esac
exit 0
`;

  interface StepResult {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }

  /**
   * Runs a shipped step under the runner's flags. `cwd` is separate from where
   * the script is written because the remediation step invokes the real judge
   * as `node --import tsx scripts/...`, which only resolves from the repo root,
   * while every path it touches is redirected into the scratch workspace by the
   * step's own env. Nothing this suite runs writes inside the repo.
   */
  function runStep(
    run: string,
    options: { dir: string; cwd: string; bin: string; env: Record<string, string> },
  ): StepResult {
    const scriptPath = join(options.dir, "step.sh");
    writeFileSync(scriptPath, run, "utf8");
    const result = spawnSync("bash", [...GITHUB_BASH_FLAGS, scriptPath.replace(/\\/g, "/")], {
      cwd: options.cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${options.bin}${delimiter}${process.env.PATH ?? ""}`,
        ...options.env,
      },
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  /** Built by the REAL producer, so the fixture cannot be shaped like the test. */
  function verdictOn(machineEvidence: Record<string, unknown>): Record<string, unknown> {
    return redactedReport(judge(JSON.stringify(machineEvidence)), NOW);
  }

  const EIGHT_HOURS_STALE = evidenceDocument({
    createdAt: "2026-08-30T04:00:00.000Z",
    verifiedAt: "2026-08-30T04:01:00.000Z",
  });

  function scenario(options: {
    /** What the customer machine will hand back when it is re-read. */
    machine?: Record<string, unknown>;
    /** The verdict the judge step already wrote, before remediation runs. */
    verdict?: Record<string, unknown>;
    gh?: Record<string, string>;
  }) {
    const dir = workspace();
    const bin = stubBin(dir, "flyctl", FLY_EXEC_STUB);
    stubBin(dir, "gh", GH_STUB);
    // A no-op `sleep`, so a bounded retry loop can never hang the suite and a
    // loop that failed to break shows up as a wrong count, not a timeout.
    stubBin(dir, "sleep", "#!/bin/sh\nexit 0\n");

    const report = join(dir, "verdict.json");
    const capture = join(dir, "evidence-capture.json");
    const machinePath = join(dir, "last-verified.json");
    const ghLog = join(dir, "gh-invocations.log");
    writeFileSync(ghLog, "", "utf8");
    writeFileSync(
      machinePath,
      JSON.stringify(options.machine ?? freshEvidence()),
      "utf8",
    );
    writeFileSync(
      report,
      `${JSON.stringify(options.verdict ?? verdictOn(EIGHT_HOURS_STALE), null, 2)}\n`,
      "utf8",
    );

    return {
      dir,
      bin,
      report,
      env: {
        // Deliberately a repository that does not exist, under a token that is
        // not one: if the stub above were ever missed, the real `gh` 404s
        // instead of dispatching a backup against production.
        GH_REPO: "mendpoint-tests/repository-that-does-not-exist",
        GH_TOKEN: "stub-token-not-a-real-secret",
        BACKUP_WORKFLOW: "customer-backup.yml",
        BACKUP_REF: "main",
        FLY_API_TOKEN: STUB_TOKEN,
        CUSTOMER_APP: STUB_APP,
        MENDPOINT_BACKUP_EVIDENCE_PATH: machinePath,
        MENDPOINT_BACKUP_EVIDENCE_CAPTURE_PATH: capture,
        MENDPOINT_BACKUP_FRESHNESS_REPORT_PATH: report,
        GH_STUB_LOG: ghLog,
        ...options.gh,
      },
      calls(): string[] {
        return readFileSync(ghLog, "utf8").split("\n").filter(Boolean);
      },
      verdict(): any {
        return JSON.parse(readFileSync(report, "utf8"));
      },
    };
  }

  /** Recent against the wall clock, because the real judge reads `new Date()`. */
  function freshEvidence(): Record<string, unknown> {
    return evidenceDocument({
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      verifiedAt: new Date(Date.now() - 30_000).toISOString(),
    });
  }

  function remediate(context: ReturnType<typeof scenario>): StepResult {
    return runStep(shippedStep(REMEDIATE).run, {
      dir: context.dir,
      cwd: root,
      bin: context.bin,
      env: context.env,
    });
  }

  function decide(context: ReturnType<typeof scenario>): StepResult {
    return runStep(shippedStep(DECIDE).run, {
      dir: context.dir,
      cwd: context.dir,
      bin: context.bin,
      env: context.env,
    });
  }

  it("dispatches exactly one backup for a stale verdict, and passes once the re-check is fresh", () => {
    const context = scenario({ machine: freshEvidence() });
    const step = remediate(context);

    expect(step.status).toBe(0);
    // ONE dispatch per watchdog run. A retry loop wrapped around the dispatch,
    // or a dispatch moved inside the wait loop, shows up here as a count of 2+.
    expect(context.calls().filter((call) => call === "workflow run")).toHaveLength(1);
    // It waited: it looked the run up and read its conclusion rather than
    // assuming the dispatch was the same thing as a backup.
    expect(context.calls()).toContain("run list");
    expect(context.calls()).toContain("run view");

    // Re-measured from the MACHINE, not inferred from "the run succeeded".
    const verdict = context.verdict();
    expect(verdict.state).toBe("fresh");
    expect(verdict.remediation).toMatchObject({
      attempted: true,
      dispatched: true,
      runId: "4242",
      outcome: "backup_run_completed",
    });

    // The staleness stays visible even though remediation worked. Without both
    // of these the dropped cron becomes invisible the moment this starts
    // succeeding, which is the silence the watchdog exists to end.
    expect(step.stdout).toContain("::warning title=Customer backup was stale::");
    const decided = decide(context);
    expect(decided.status).toBe(0);
    expect(decided.stdout).toContain("::warning title=Backup freshness required remediation::");
    expect(decided.stdout).toContain("customer_backup_final state=fresh remediated=true");
  });

  it("still fails, and still opens the issue, when the backup is stale after remediation", () => {
    // The backup ran and succeeded, and the machine is STILL past its RPO. A
    // remediation that reported this as recovered would be strictly worse than
    // the noise it replaced.
    const context = scenario({ machine: EIGHT_HOURS_STALE });
    const step = remediate(context);

    expect(step.status).toBe(0);
    expect(context.calls().filter((call) => call === "workflow run")).toHaveLength(1);
    const verdict = context.verdict();
    expect(verdict.state).toBe("stale");
    expect(verdict.remediation).toMatchObject({ dispatched: true });

    const decided = decide(context);
    expect(decided.status).toBe(1);
    expect(decided.stderr).toContain("customer_backup_not_fresh state=stale");

    // And the alarm the operator actually sees still fires, from the same
    // verdict document, under `if: failure()`.
    expect(shippedStep(ALERT).if).toBe("${{ failure() }}");
    const alertDir = join(context.dir, "alert");
    mkdirSync(join(alertDir, "test-results/customer-backup-watchdog"), { recursive: true });
    writeFileSync(
      join(alertDir, "test-results/customer-backup-watchdog/verdict.json"),
      readFileSync(context.report, "utf8"),
      "utf8",
    );
    const alerted = runStep(shippedStep(ALERT).run, {
      dir: alertDir,
      cwd: alertDir,
      bin: context.bin,
      // RUN_URL is the workflow's own; under the runner's `-u` an absent one
      // would abort the alert before it ever reached `gh issue create`.
      env: { ...context.env, RUN_URL: "https://example.invalid/run/1" },
    });
    expect(alerted.status).toBe(0);
    expect(context.calls()).toContain("issue create");
  });

  it("dispatches nothing at all when the backup is fresh", () => {
    // Two independent guards, because either one alone is a single point of
    // failure for "the watchdog started dispatching backups every hour".
    expect(shippedStep(REMEDIATE).if).toBe(
      "${{ !cancelled() && steps.judge.outputs.status != '0' }}",
    );

    const context = scenario({ verdict: verdictOn(evidenceDocument()) });
    const step = remediate(context);

    expect(step.status).toBe(0);
    expect(context.calls()).toEqual([]);
    expect(step.stdout).toContain("no dispatch: verdict state is fresh");
    // A verdict it did not remediate carries no remediation claim.
    expect(context.verdict().remediation).toBeUndefined();
  });

  it("never dispatches for an indeterminate verdict, which a backup cannot answer", () => {
    const context = scenario({ verdict: redactedReport(judge(null, 14), NOW) });
    const step = remediate(context);

    expect(step.status).toBe(0);
    expect(context.calls()).toEqual([]);
    expect(step.stdout).toContain("no dispatch: verdict state is indeterminate");
    // Unchanged from today: it goes straight to failing and alerting.
    expect(decide(context).status).toBe(1);
  });

  it("reports a refused dispatch instead of swallowing it", () => {
    const context = scenario({ gh: { GH_STUB_DISPATCH_STATUS: "1" } });
    const step = remediate(context);

    expect(step.status).toBe(1);
    expect(step.stderr).toContain("customer_backup_remediation_dispatch_failed status=1");
    expect(context.verdict()).toMatchObject({
      state: "stale",
      remediation: { attempted: true, dispatched: false, outcome: "dispatch_failed" },
    });
    // It did not go on to wait for, or claim, a run that was never started.
    expect(context.calls()).toEqual(["workflow run"]);
    expect(decide(context).status).toBe(1);
  });

  it("reports a backup run that completed unsuccessfully instead of re-reading past it", () => {
    const context = scenario({ gh: { GH_STUB_RUN_STATE: "completed failure" } });
    const step = remediate(context);

    expect(step.status).toBe(1);
    expect(step.stderr).toContain("customer_backup_remediation_run_unsuccessful conclusion=failure");
    expect(context.verdict().remediation).toMatchObject({
      outcome: "backup_run_unsuccessful",
      conclusion: "failure",
    });
    expect(decide(context).status).toBe(1);
  });

  it("keeps the job's verdict in ONE place, decided from the document and not from an exit code", () => {
    // The judge's exit is deferred so remediation can run after it. That is only
    // safe because this step re-derives the answer from the verdict on disk: cut
    // the remediation step out of the workflow entirely and a stale backup still
    // fails here, still reaches `if: failure()`, and still opens the issue.
    const judgeStep = shippedStep(JUDGE);
    expect(judgeStep.id).toBe("judge");
    expect(judgeStep.run).toContain("|| status=$?");
    expect(judgeStep.run).toContain('echo "status=$status" >> "$GITHUB_OUTPUT"');

    const decider = shippedStep(DECIDE);
    expect(decider.if).toBe("${{ !cancelled() }}");
    expect(decider.run).toContain('if [ "$state" != "fresh" ]');
    // Ordering is load bearing: the decision must be reached before the step
    // whose `failure()` opens the issue, and after the meta verdict guarantees
    // a document exists.
    const order = steps.map((each) => each.name);
    expect(order.indexOf(JUDGE)).toBeLessThan(order.indexOf(REMEDIATE));
    expect(order.indexOf("Record the meta verdict when the watchdog produced none")).toBeLessThan(
      order.indexOf(DECIDE),
    );
    expect(order.indexOf(DECIDE)).toBeLessThan(order.indexOf(ALERT));
  });

  it("re-reads the machine with the SAME command the first read uses, so neither can drift", () => {
    // Four separate defects were fixed in that one command: the remote `sh -c`
    // expansion, the `</dev/null`, the `timeout`, and `|| status=$?` surviving
    // the runner's `-e`. A second copy that drifted would re-open all four in a
    // place the hardened tests above do not look.
    const collapse = (run: string): string =>
      run.replace(/\\\n\s+/g, " ").replace(/[ \t]+/g, " ");
    const extract = (run: string): string => {
      const found = /timeout 300 flyctl ssh console .*?<\/dev\/null/.exec(collapse(run));
      if (!found) throw new Error("no evidence read found in step");
      return found[0];
    };
    expect(extract(shippedStep(REMEDIATE).run)).toBe(extract(shippedStep(READ).run));
    expect(shippedStep(REMEDIATE).run).toContain("|| status=$?");
  });

  it("bounds its own waiting, so remediation can never cancel the job and mute the alarm", () => {
    // `timeout-minutes` firing CANCELS the job, and `if: failure()` steps do not
    // run on a cancelled job. An unbounded `gh run watch` here would therefore
    // have silenced the alert on exactly the runs that needed it most.
    const run = shippedStep(REMEDIATE).run;
    expect(run).not.toContain("gh run watch");
    expect(run).toContain("for _ in $(seq 1 18); do");
    expect(run).toContain("for _ in $(seq 1 36); do");
    const freshness = (
      parse(
        readFileSync(resolve(root, ".github/workflows/customer-backup-watchdog.yml"), "utf8"),
      ) as Record<string, any>
    ).jobs.freshness;
    // 3min to observe the run + 6min for it to finish + 5min for the re-read,
    // with room left over rather than room exactly consumed.
    expect(freshness["timeout-minutes"]).toBe(25);
    expect(freshness.permissions).toMatchObject({ "actions": "write", "issues": "write" });
  });

  it("cannot be relaxed: the effective backup interval still fits inside the RPO", () => {
    // THE ANTI-RELAXATION GUARD. It was written against the `*/30` cron because
    // the cron was then the only thing that decided how often a backup happened.
    // It is not about the cron; it is about the one property that must never be
    // widened -- that the gap between backups, plus the time one is allowed to
    // take, cannot exceed the recovery commitment the readiness check enforces.
    //
    // The trigger moved on-machine, so the guard moves with it, onto the
    // scheduler's derived interval. Flipping a cron string can no longer satisfy
    // it, and neither can widening the interval or the per-run budget.
    const rpoMs = CORE_DISASTER_RECOVERY_POLICY.rpoSeconds * 1_000;
    const intervalMs = customerBackupIntervalMs();
    const operationMs = customerBackupOperationTimeoutMs();
    expect(intervalMs).toBeLessThanOrEqual(rpoMs - operationMs);
    // Half the RPO or better, so a whole run can be dropped and the evidence is
    // still current when the next one lands.
    expect(intervalMs * 2).toBeLessThanOrEqual(rpoMs);
    // A run can never still be going when the next one is due.
    expect(operationMs).toBeLessThan(intervalMs);
    // The readiness check and the scheduler must read the same RPO.
    expect(resolveBackupRpoSeconds()).toBe(CORE_DISASTER_RECOVERY_POLICY.rpoSeconds);

    const backup = parse(
      readFileSync(resolve(root, ".github/workflows/customer-backup.yml"), "utf8"),
    ) as Record<string, any>;
    expect(backup.on).toHaveProperty("workflow_dispatch");
    expect(backup.concurrency).toMatchObject({
      group: "customer-production-backup",
      "cancel-in-progress": false,
    });
  });
});
