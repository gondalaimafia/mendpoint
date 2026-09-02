import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { CORE_DISASTER_RECOVERY_POLICY } from "@mendpoint/ops";

const root = resolve(import.meta.dirname, "..");
const deliveryPath = resolve(root, ".github/workflows/customer-backup-delivery.yml");
const deliverySource = readFileSync(deliveryPath, "utf8");
const delivery = parse(deliverySource) as Record<string, any>;
const controller = delivery.jobs.controller as Record<string, any>;
const steps = controller.steps as Record<string, any>[];
const backupPath = resolve(root, ".github/workflows/customer-backup.yml");
const backup = parse(readFileSync(backupPath, "utf8")) as Record<string, any>;
const executionGate = backup.jobs["execution-gate"] as Record<string, any> | undefined;

function step(name: string): Record<string, any> {
  const found = steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`step not found: ${name}`);
  return found;
}

function executable(dir: string, name: string, source: string): string {
  const path = join(dir, process.platform === "win32" ? name : name);
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function runController(options: {
  activeRunId?: string;
  activeCreatedAt?: string;
  latestSuccess?: string;
  backupJobSuccess?: boolean;
  acknowledgedRunId?: string;
  handoffRunId?: string;
  dispatchStatus?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), "customer-backup-delivery-"));
  const bin = join(dir, "bin");
  const log = join(dir, "gh.log");
  const ledger = join(dir, "delivery.jsonl");
  const dispatched = join(dir, "dispatched");
  mkdirSync(bin, { recursive: true });
  writeFileSync(log, "", "utf8");
  executable(bin, "sleep", "#!/bin/sh\nexit 0\n");
  executable(
    bin,
    "gh",
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_STUB_LOG"
case "$1 $2" in
  'run list')
    case "$*" in
      *customer-backup-delivery.yml*) printf '%s\\n' "\${GH_STUB_HANDOFF_RUN_ID:-}" ;;
      *displayTitle*) printf '%s\\n' "\${GH_STUB_ACKNOWLEDGED_RUN_ID:-}" ;;
      *'status != "completed"'*)
        if [ -n "\${GH_STUB_ACTIVE_RUN_ID:-}" ]; then
          printf '%s\\t%s\\n' "$GH_STUB_ACTIVE_RUN_ID" "$GH_STUB_ACTIVE_CREATED_AT"
        fi
        ;;
      *)
        if [ -f "$GH_STUB_DISPATCHED" ]; then
          printf '%s\\t%s\\n' '4242' "$GH_STUB_DISPATCHED_SUCCESS"
        elif [ -n "\${GH_STUB_LATEST_SUCCESS:-}" ]; then
          printf '%s\\t%s\\n' '777' "$GH_STUB_LATEST_SUCCESS"
        fi
        ;;
    esac
    ;;
  'run view') printf '%s\\n' "\${GH_STUB_BACKUP_JOB_SUCCESS:-1}" ;;
  'workflow run')
    case "$*" in
      *customer-backup.yml*)
        status="\${GH_STUB_DISPATCH_STATUS:-0}"
        if [ "$status" = 0 ]; then : > "$GH_STUB_DISPATCHED"; fi
        exit "$status"
        ;;
    esac
    ;;
esac
exit 0
`,
  );
  const script = join(dir, "controller.sh");
  writeFileSync(script, step("Maintain continuous backup delivery").run, "utf8");
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-e", "-o", "pipefail", script.replaceAll("\\", "/")],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        GH_TOKEN: "not-a-real-token",
        GH_REPO: "mendpoint-tests/repository-that-does-not-exist",
        BACKUP_WORKFLOW: "customer-backup.yml",
        DELIVERY_WORKFLOW: "customer-backup-delivery.yml",
        BACKUP_REF: "main",
        CONTROLLER_RUN_ID: "9001",
        DELIVERY_LEDGER_PATH: ledger,
        DELIVERY_CYCLES: "2",
        DELIVERY_SLEEP_SECONDS: "0",
        DELIVERY_MAX_AGE_SECONDS: "1500",
        DELIVERY_MAX_ACTIVE_AGE_SECONDS: "1800",
        DELIVERY_OBSERVE_ATTEMPTS: "1",
        DELIVERY_OBSERVE_SLEEP_SECONDS: "0",
        GH_STUB_LOG: log,
        GH_STUB_DISPATCHED: dispatched,
        GH_STUB_DISPATCHED_SUCCESS: new Date().toISOString(),
        GH_STUB_ACTIVE_RUN_ID: options.activeRunId ?? "",
        GH_STUB_ACTIVE_CREATED_AT: options.activeCreatedAt ?? new Date().toISOString(),
        GH_STUB_LATEST_SUCCESS: options.latestSuccess ?? "2026-01-01T00:00:00Z",
        GH_STUB_BACKUP_JOB_SUCCESS: options.backupJobSuccess === false ? "0" : "1",
        GH_STUB_ACKNOWLEDGED_RUN_ID: options.acknowledgedRunId ?? "4242",
        GH_STUB_HANDOFF_RUN_ID: options.handoffRunId ?? "5252",
        GH_STUB_DISPATCH_STATUS: options.dispatchStatus ?? "0",
      },
    },
  );
  return {
    ...result,
    calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
    ledger: readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
}

function runExecutionGate(completedAfterCurrentCreation: boolean) {
  if (!executionGate) throw new Error("execution-gate job not found");
  const dir = mkdtempSync(join(tmpdir(), "customer-backup-execution-gate-"));
  const bin = join(dir, "bin");
  const output = join(dir, "github-output");
  mkdirSync(bin, { recursive: true });
  writeFileSync(output, "", "utf8");
  executable(bin, "gh", `#!/bin/sh
case "$1 $2 $3" in
  'run view 9001') printf '%s\\n' '2026-09-02T12:00:00Z' ;;
  'run view 222') printf '%s\\n' '${completedAfterCurrentCreation ? "1" : "0"}' ;;
  'run list --repo') printf '%s\\n' '222' ;;
esac
exit 0
`);
  const check = executionGate.steps.find((candidate: Record<string, any>) =>
    candidate.name === "Recheck serialized backup freshness");
  if (!check) throw new Error("execution gate check step not found");
  const script = join(dir, "execution-gate.sh");
  writeFileSync(script, check.run, "utf8");
  const result = spawnSync("bash", ["--noprofile", "--norc", script.replaceAll("\\", "/")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      GH_TOKEN: "not-a-real-token",
      GH_REPO: "mendpoint-tests/repository-that-does-not-exist",
      CURRENT_RUN_ID: "9001",
      BACKUP_REF: "main",
      GITHUB_OUTPUT: output,
    },
  });
  return { ...result, output: readFileSync(output, "utf8") };
}

describe("customer backup delivery controller workflow", () => {
  it("keeps an event-driven controller alive across dropped schedules", () => {
    expect(delivery.on.schedule).toEqual([{ cron: "17 * * * *" }]);
    expect(delivery.on.workflow_run).toMatchObject({ workflows: ["CI"], types: ["completed"] });
    expect(delivery.on).toHaveProperty("workflow_dispatch");
    expect(delivery.concurrency["cancel-in-progress"]).toBe(false);
    expect(String(delivery.concurrency.group)).toContain("customer-production-backup-delivery");
    expect(controller["timeout-minutes"]).toBe(330);
    expect(controller.environment).toBe("customer-production-backup");
    expect(controller.if).toContain("default_branch");
    expect(controller.permissions).toMatchObject({ actions: "write", issues: "write" });
  });

  it("dispatches only the exact protected backup workflow outside application startup", () => {
    const maintain = step("Maintain continuous backup delivery");
    expect(maintain.env.BACKUP_WORKFLOW).toBe("customer-backup.yml");
    expect(maintain.env.BACKUP_REF).toBe("${{ github.event.repository.default_branch }}");
    expect(Number(maintain.env.DELIVERY_MAX_AGE_SECONDS)).toBeLessThan(
      CORE_DISASTER_RECOVERY_POLICY.rpoSeconds / 2,
    );
    expect(maintain.run).toContain('gh workflow run "$BACKUP_WORKFLOW"');
    expect(maintain.run).toContain('-f "delivery_id=$delivery_id"');
    expect(maintain.run).toContain("displayTitle");
    expect(maintain.run).toContain("customer_backup_delivery_run_not_observed");
    expect(maintain.run).toContain('gh workflow run "$DELIVERY_WORKFLOW"');
    expect(deliverySource).not.toContain("scripts/customer-backup.ts");
    expect(deliverySource).not.toContain("scripts/start-fly.mjs");
    expect(deliverySource).not.toContain("initializeWithMutationLease");
  });

  it("binds dispatch acknowledgement to a unique delivery identity", () => {
    const result = runController({});
    expect(result.status).toBe(0);
    expect(result.calls.filter((call) => call.startsWith("workflow run customer-backup.yml")))
      .toHaveLength(1);
    expect(result.calls).toContainEqual(
      expect.stringContaining("delivery_id=backup-delivery-9001-1"),
    );
    expect(result.calls).toContainEqual(expect.stringContaining("displayTitle"));
    expect(result.calls.filter((call) => call.startsWith("workflow run customer-backup-delivery.yml")))
      .toHaveLength(1);
    expect(result.calls).toContainEqual(expect.stringContaining("predecessor_run_id=9001"));
    expect(result.ledger).toContainEqual(expect.objectContaining({
      event: "backup_dispatched",
      deliveryId: "backup-delivery-9001-1",
      backupRunId: "4242",
    }));
    expect(result.ledger).toContainEqual(expect.objectContaining({
      event: "controller_handoff",
      predecessorRunId: "9001",
      successorRunId: "5252",
    }));
  });

  it("does not queue a duplicate while an exact backup run is active", () => {
    const result = runController({ activeRunId: "31337" });
    expect(result.status).not.toBe(0);
    expect(result.calls.some((call) => call.startsWith("workflow run customer-backup.yml"))).toBe(false);
    expect(result.ledger).toContainEqual(expect.objectContaining({
      event: "backup_active",
      backupRunId: "31337",
    }));
  });

  it("does not confuse a green workflow with authenticated backup-job completion", () => {
    const maintain = step("Maintain continuous backup delivery");
    expect(maintain.run).toContain('gh run view "$candidate_run_id"');
    expect(maintain.run).toContain('.name == "backup" and .conclusion == "success"');
    expect(maintain.run).toContain("backup_workflow_success_without_backup_job");

    const result = runController({
      latestSuccess: new Date().toISOString(),
      backupJobSuccess: false,
    });
    expect(result.status).not.toBe(0);
    expect(result.calls.some((call) => call.startsWith("run view 777"))).toBe(true);
    expect(result.calls.filter((call) => call.startsWith("workflow run customer-backup.yml")))
      .toHaveLength(2);
    expect(result.ledger).toContainEqual(expect.objectContaining({
      event: "backup_workflow_success_without_backup_job",
      backupRunId: "777",
    }));
  });

  it("fails closed when no dispatched backup ever completes successfully", () => {
    const result = runController({ backupJobSuccess: false });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_delivery_completion_missing");
    expect(result.calls.some((call) => call.startsWith("workflow run customer-backup-delivery.yml")))
      .toBe(false);
  });

  it("isolates irrelevant branch recovery runs from the accepted successor", () => {
    expect(String(delivery.concurrency.group)).toContain("github.event.workflow_run.head_branch");
    expect(String(delivery.concurrency.group)).toContain("github.run_id");
  });

  it("rechecks durable freshness inside serialized backup execution", () => {
    expect(executionGate?.needs).toBe("profile-gate");
    expect(executionGate?.permissions).toMatchObject({ actions: "read" });
    expect(executionGate?.outputs.execute).toBeTruthy();
    expect(executionGate?.steps.some((candidate: Record<string, any>) =>
      candidate.run?.includes("duplicate_backup_execution_fenced"))).toBe(true);
    expect(backup.jobs.backup.needs).toEqual(["profile-gate", "execution-gate"]);
    expect(backup.jobs.backup.if).toContain("needs.execution-gate.outputs.execute == 'true'");

    const raced = runExecutionGate(true);
    expect(raced.status).toBe(0);
    expect(raced.output).toContain("execute=false");
    expect(raced.stdout).toContain("duplicate_backup_execution_fenced superseding_run_id=222");

    const notRaced = runExecutionGate(false);
    expect(notRaced.status).toBe(0);
    expect(notRaced.output).toContain("execute=true");
  });

  it("accepts only an exact successful backup job as recent completion", () => {
    const result = runController({ latestSuccess: new Date().toISOString() });
    expect(result.status).toBe(0);
    expect(result.calls.some((call) => call.startsWith("run view 777"))).toBe(true);
    expect(result.calls.some((call) => call.startsWith("workflow run customer-backup.yml"))).toBe(false);
    expect(result.ledger).toContainEqual(expect.objectContaining({
      event: "backup_recent",
      backupRunId: "777",
    }));
  });

  it("fails loudly when GitHub accepts a dispatch but never exposes its exact run", () => {
    const result = runController({ acknowledgedRunId: "" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_delivery_run_not_observed");
    expect(result.calls.some((call) => call.startsWith("workflow run customer-backup-delivery.yml")))
      .toBe(false);
  });

  it("fails loudly when GitHub accepts a handoff but never exposes the exact successor", () => {
    const result = runController({
      latestSuccess: new Date().toISOString(),
      handoffRunId: "",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_delivery_successor_not_observed");
  });

  it("bounds an active backup instead of treating a hung run as delivery forever", () => {
    const maintain = step("Maintain continuous backup delivery");
    expect(maintain.env.DELIVERY_MAX_ACTIVE_AGE_SECONDS).toBeTruthy();
    expect(Number(maintain.env.DELIVERY_MAX_ACTIVE_AGE_SECONDS)).toBeLessThan(
      CORE_DISASTER_RECOVERY_POLICY.rpoSeconds,
    );
    expect(maintain.run).toContain("customer_backup_delivery_active_stalled");
    const result = runController({
      activeRunId: "31337",
      activeCreatedAt: "2026-01-01T00:00:00Z",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_delivery_active_stalled");
    expect(result.ledger).toContainEqual(expect.objectContaining({
      event: "backup_active_stalled",
      backupRunId: "31337",
    }));
  });

  it("retains a deduplicated alert when controller delivery fails", () => {
    const alert = step("Alert on backup delivery failure");
    expect(alert.if).toBe("${{ failure() }}");
    expect(alert.run).toContain('label="customer-production-backup-delivery-failure"');
    expect(alert.run).toContain("gh issue comment");
    expect(alert.run).toContain("gh issue create");
  });

  it("connects dispatch to authenticated evidence and the production readiness consumer", () => {
    const backup = readFileSync(resolve(root, ".github/workflows/customer-backup.yml"), "utf8");
    const producer = readFileSync(resolve(root, "scripts/customer-backup.ts"), "utf8");
    const readiness = readFileSync(resolve(root, "packages/ops/src/readiness.ts"), "utf8");
    expect(backup).toContain("delivery_id:");
    expect(backup).toContain("inputs.delivery_id");
    expect(deliverySource).toContain("predecessor_run_id:");
    expect(deliverySource).toContain("inputs.predecessor_run_id");
    expect(backup).toContain("scripts/customer-backup.ts");
    expect(producer).toContain("recordLastVerifiedBackupEvidence");
    expect(readiness).toContain('name: "last_verified_backup"');
  });
});
