import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CORE_DISASTER_RECOVERY_POLICY } from "@mendpoint/ops";
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

  it("leaves the existing backup workflow's schedule, RPO and alert untouched", () => {
    const backup = parse(
      readFileSync(resolve(root, ".github/workflows/customer-backup.yml"), "utf8"),
    ) as Record<string, any>;
    expect(backup.on.schedule).toEqual([{ cron: "*/30 * * * *" }]);
    const alert = (backup.jobs.backup.steps as Record<string, any>[]).find(
      (candidate) => candidate.name === "Alert on backup failure",
    );
    expect(alert?.if).toBe("${{ failure() }}");
    expect(alert?.run).toContain('label="customer-production-backup-failure"');
  });
});
