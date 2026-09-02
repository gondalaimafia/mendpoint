import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  latestSuccess?: string;
  acknowledgedRunId?: string;
  dispatchStatus?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), "customer-backup-delivery-"));
  const bin = join(dir, "bin");
  const log = join(dir, "gh.log");
  const ledger = join(dir, "delivery.jsonl");
  spawnSync("mkdir", ["-p", bin]);
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
      *displayTitle*) printf '%s\\n' "\${GH_STUB_ACKNOWLEDGED_RUN_ID:-}" ;;
      *'status != "completed"'*) printf '%s\\n' "\${GH_STUB_ACTIVE_RUN_ID:-}" ;;
      *) printf '%s\\n' "\${GH_STUB_LATEST_SUCCESS:-}" ;;
    esac
    ;;
  'workflow run')
    case "$*" in
      *customer-backup.yml*) exit "\${GH_STUB_DISPATCH_STATUS:-0}" ;;
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
        DELIVERY_CYCLES: "1",
        DELIVERY_SLEEP_SECONDS: "0",
        DELIVERY_MAX_AGE_SECONDS: "1500",
        DELIVERY_OBSERVE_ATTEMPTS: "1",
        DELIVERY_OBSERVE_SLEEP_SECONDS: "0",
        GH_STUB_LOG: log,
        GH_STUB_ACTIVE_RUN_ID: options.activeRunId ?? "",
        GH_STUB_LATEST_SUCCESS: options.latestSuccess ?? "2026-01-01T00:00:00Z",
        GH_STUB_ACKNOWLEDGED_RUN_ID: options.acknowledgedRunId ?? "4242",
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

describe("customer backup delivery controller workflow", () => {
  it("keeps an event-driven controller alive across dropped schedules", () => {
    expect(delivery.on.schedule).toEqual([{ cron: "17 * * * *" }]);
    expect(delivery.on.workflow_run).toMatchObject({ workflows: ["CI"], types: ["completed"] });
    expect(delivery.on).toHaveProperty("workflow_dispatch");
    expect(delivery.concurrency).toEqual({
      group: "customer-production-backup-delivery",
      "cancel-in-progress": false,
    });
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
    expect(result.ledger).toContainEqual(expect.objectContaining({
      event: "backup_dispatched",
      deliveryId: "backup-delivery-9001-1",
      backupRunId: "4242",
    }));
  });

  it("does not queue a duplicate while an exact backup run is active", () => {
    const result = runController({ activeRunId: "31337" });
    expect(result.status).toBe(0);
    expect(result.calls.some((call) => call.startsWith("workflow run customer-backup.yml"))).toBe(false);
    expect(result.ledger).toContainEqual(expect.objectContaining({
      event: "backup_active",
      backupRunId: "31337",
    }));
  });

  it("fails loudly when GitHub accepts a dispatch but never exposes its exact run", () => {
    const result = runController({ acknowledgedRunId: "" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_delivery_run_not_observed");
    expect(result.calls.some((call) => call.startsWith("workflow run customer-backup-delivery.yml")))
      .toBe(false);
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
    expect(backup).toContain("scripts/customer-backup.ts");
    expect(producer).toContain("recordVerifiedBackup");
    expect(readiness).toContain('name: "last_verified_backup"');
  });
});
