import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runFixtureShellStep } from "./workflow-fixture-shell.js";

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
  dispatchedWorkflowSuccess?: boolean;
  acknowledgedRunId?: string;
  handoffRunId?: string;
  dispatchStatus?: string;
  dispatchAcceptedOnError?: boolean;
  handoffDispatchStatus?: string;
  handoffAcceptedOnError?: boolean;
  deliveryMaxAgeSeconds?: string;
  deliveryRpoSeconds?: string;
  deliverySleepSeconds?: string;
  deliveryCycles?: string;
  livezCode?: string;
  customerApp?: string;
  activeMetadataValid?: boolean;
  acknowledgedMetadataValid?: boolean;
  handoffMetadataValid?: boolean;
  runListConclusionFail?: boolean;
  runViewFail?: boolean;
  runListObserveFail?: boolean;
  runListHandoffFail?: boolean;
  observeFailTimes?: string;
  handoffFailTimes?: string;
  deliveryObserveAttempts?: string;
  deliveryHandoffAttempts?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), "customer-backup-delivery-"));
  const log = join(dir, "gh.log");
  const flyctlLog = join(dir, "flyctl.log");
  const ledger = join(dir, "delivery.jsonl");
  const dispatched = join(dir, "dispatched");
  const handoffDispatched = join(dir, "handoff-dispatched");
  const observeFailCounter = join(dir, "observe-fail-counter");
  const handoffFailCounter = join(dir, "handoff-fail-counter");
  writeFileSync(log, "", "utf8");
  writeFileSync(flyctlLog, "", "utf8");
  // Keep the workflow integration real while avoiding a new shell process for
  // every simulated GitHub and sleep call. Windows process startup otherwise
  // makes individual default-timeout tests nondeterministic under host load.
  const controllerHarness = `sleep() {
  :
}
curl() {
printf '%s' "\${GH_STUB_LIVEZ_CODE:-200}"
}
flyctl() {
printf '%s\\n' "$*" >> "$GH_STUB_FLYCTL_LOG"
return 127
}
gh() {
printf '%s\\n' "$*" >> "$GH_STUB_LOG"
case "$1 $2" in
  'run list')
    case "$*" in
      *conclusion*)
        if [ -n "\${GH_STUB_RUN_LIST_CONCLUSION_FAIL:-}" ]; then
          echo 'gh: HTTP 502 Bad Gateway (api.github.com)' >&2; return 1
        fi
        ;;
    esac
    case "$*" in
      *displayTitle*)
        case "$*" in
          *customer-backup-delivery.yml*)
            if [ -n "\${GH_STUB_RUN_LIST_HANDOFF_FAIL:-}" ]; then
              echo 'gh: HTTP 502 Bad Gateway (api.github.com)' >&2; return 1
            fi
            if [ -n "\${GH_STUB_HANDOFF_FAIL_TIMES:-}" ]; then
              n="$(cat "$GH_STUB_HANDOFF_FAIL_COUNTER" 2>/dev/null || echo 0)"
              if [ "$n" -lt "$GH_STUB_HANDOFF_FAIL_TIMES" ]; then
                printf '%s' "$((n + 1))" > "$GH_STUB_HANDOFF_FAIL_COUNTER"
                echo 'gh: HTTP 502 Bad Gateway (api.github.com)' >&2; return 1
              fi
            fi
            ;;
          *)
            if [ -n "\${GH_STUB_RUN_LIST_OBSERVE_FAIL:-}" ]; then
              echo 'gh: HTTP 502 Bad Gateway (api.github.com)' >&2; return 1
            fi
            if [ -n "\${GH_STUB_OBSERVE_FAIL_TIMES:-}" ]; then
              n="$(cat "$GH_STUB_OBSERVE_FAIL_COUNTER" 2>/dev/null || echo 0)"
              if [ "$n" -lt "$GH_STUB_OBSERVE_FAIL_TIMES" ]; then
                printf '%s' "$((n + 1))" > "$GH_STUB_OBSERVE_FAIL_COUNTER"
                echo 'gh: HTTP 502 Bad Gateway (api.github.com)' >&2; return 1
              fi
            fi
            ;;
        esac
        ;;
    esac
    case "$*" in
      *customer-backup-delivery.yml*)
        if [ -f "$GH_STUB_HANDOFF_DISPATCHED" ]; then
          printf '%s\\n' "\${GH_STUB_HANDOFF_RUN_ID:-}"
        fi
        ;;
      *displayTitle*)
        if [ -f "$GH_STUB_DISPATCHED" ]; then
          printf '%s\\n' "\${GH_STUB_ACKNOWLEDGED_RUN_ID:-}"
        fi
        ;;
      *'status != "completed"'*)
        if [ -n "\${GH_STUB_ACTIVE_RUN_ID:-}" ]; then
          printf '%s\\t%s\\n' "$GH_STUB_ACTIVE_RUN_ID" "$GH_STUB_ACTIVE_CREATED_AT"
        fi
        ;;
      *)
        if [ -f "$GH_STUB_DISPATCHED" ]; then
          if [ "\${GH_STUB_DISPATCHED_WORKFLOW_SUCCESS:-1}" = 1 ]; then
            printf '%s\\t%s\\n' '4242' "$GH_STUB_DISPATCHED_SUCCESS"
          elif [ -n "\${GH_STUB_LATEST_SUCCESS:-}" ]; then
            printf '%s\\t%s\\n' '777' "$GH_STUB_LATEST_SUCCESS"
          fi
        elif [ -n "\${GH_STUB_LATEST_SUCCESS:-}" ]; then
          printf '%s\\t%s\\n' '777' "$GH_STUB_LATEST_SUCCESS"
        fi
        ;;
    esac
    ;;
  'run view')
    if [ -n "\${GH_STUB_RUN_VIEW_FAIL:-}" ]; then
      echo 'gh: HTTP 502 Bad Gateway (api.github.com)' >&2; return 1
    fi
    printf '%s\\n' "\${GH_STUB_BACKUP_JOB_SUCCESS:-1}" ;;
  'api repos/'*)
    run_id="\${2##*/}"
    case "$run_id" in
      31337) printf '{"status":"in_progress","event":"workflow_dispatch","head_branch":"%s","path":".github/workflows/customer-backup.yml","display_title":"Customer production backup [backup-delivery-9000-1]","created_at":"%s"}\\n' "$GH_STUB_ACTIVE_BRANCH" "$GH_STUB_ACTIVE_CREATED_AT" ;;
      12321) printf '{"status":"in_progress","event":"workflow_dispatch","head_branch":"%s","path":".github/workflows/customer-backup.yml","display_title":"Customer production backup [backup-watchdog-123-1]","created_at":"%s"}\\n' "$GH_STUB_ACTIVE_BRANCH" "$GH_STUB_ACTIVE_CREATED_AT" ;;
      13579) printf '{"status":"in_progress","event":"workflow_dispatch","head_branch":"%s","path":".github/workflows/customer-backup.yml","display_title":"Customer production backup","created_at":"%s"}\\n' "$GH_STUB_ACTIVE_BRANCH" "$GH_STUB_ACTIVE_CREATED_AT" ;;
      4242) printf '{"status":"queued","event":"workflow_dispatch","head_branch":"%s","path":".github/workflows/customer-backup.yml","display_title":"Customer production backup [backup-delivery-9001-1]","created_at":"%s"}\\n' "$GH_STUB_ACK_BRANCH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ;;
      5252) printf '{"status":"queued","event":"workflow_dispatch","head_branch":"%s","path":".github/workflows/customer-backup-delivery.yml","display_title":"Customer production backup delivery [9001]","created_at":"%s"}\\n' "$GH_STUB_HANDOFF_BRANCH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ;;
    esac
    ;;
  'workflow run')
    case "$*" in
      *customer-backup.yml*)
        status="\${GH_STUB_DISPATCH_STATUS:-0}"
        if [ "$status" = 0 ] || [ "\${GH_STUB_DISPATCH_ACCEPTED_ON_ERROR:-0}" = 1 ]; then
          : > "$GH_STUB_DISPATCHED"
        fi
        return "$status"
        ;;
      *customer-backup-delivery.yml*)
        status="\${GH_STUB_HANDOFF_DISPATCH_STATUS:-0}"
        if [ "$status" = 0 ] || [ "\${GH_STUB_HANDOFF_ACCEPTED_ON_ERROR:-0}" = 1 ]; then
          : > "$GH_STUB_HANDOFF_DISPATCHED"
        fi
        return "$status"
        ;;
    esac
    ;;
esac
return 0
}
`;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const env = {
    ...process.env,
    GH_TOKEN: "not-a-real-token",
    GH_REPO: "mendpoint-tests/repository-that-does-not-exist",
    BACKUP_WORKFLOW: "customer-backup.yml",
    DELIVERY_WORKFLOW: "customer-backup-delivery.yml",
    BACKUP_REF: "main",
    CONTROLLER_RUN_ID: "9001",
    DELIVERY_LEDGER_PATH: ledger,
    DELIVERY_CYCLES: options.deliveryCycles ?? "2",
    DELIVERY_SLEEP_SECONDS: options.deliverySleepSeconds ?? "0",
    DELIVERY_MAX_AGE_SECONDS: options.deliveryMaxAgeSeconds ?? "900",
    DELIVERY_RPO_SECONDS: options.deliveryRpoSeconds ?? "3600",
    DELIVERY_MAX_ACTIVE_AGE_SECONDS: "1200",
    DELIVERY_OBSERVATION_MARGIN_SECONDS: "300",
    DELIVERY_OBSERVE_ATTEMPTS: options.deliveryObserveAttempts ?? "1",
    DELIVERY_OBSERVE_SLEEP_SECONDS: "0",
    DELIVERY_HANDOFF_ATTEMPTS: options.deliveryHandoffAttempts ?? "2",
    DELIVERY_HANDOFF_BACKOFF_SECONDS: "0",
    GH_STUB_LOG: log,
    // The controller never receives the Fly token; CUSTOMER_APP is only the
    // token-free /livez probe target. GH_STUB_LIVEZ_CODE is what the stubbed
    // curl returns, defaulting to 200 so the healthy dispatch path is unchanged.
    CUSTOMER_APP: options.customerApp ?? "stub-app-that-does-not-exist",
    GH_STUB_LIVEZ_CODE: options.livezCode ?? "200",
    GH_STUB_FLYCTL_LOG: flyctlLog,
    GH_STUB_DISPATCHED: dispatched,
    GH_STUB_HANDOFF_DISPATCHED: handoffDispatched,
    GH_STUB_DISPATCHED_SUCCESS: now,
    GH_STUB_ACTIVE_RUN_ID: options.activeRunId ?? "",
    GH_STUB_ACTIVE_CREATED_AT: options.activeCreatedAt ?? now,
    GH_STUB_LATEST_SUCCESS: options.latestSuccess ?? "2026-01-01T00:00:00Z",
    GH_STUB_BACKUP_JOB_SUCCESS: options.backupJobSuccess === false ? "0" : "1",
    GH_STUB_DISPATCHED_WORKFLOW_SUCCESS: options.dispatchedWorkflowSuccess === false ? "0" : "1",
    GH_STUB_ACKNOWLEDGED_RUN_ID: options.acknowledgedRunId ?? "4242",
    GH_STUB_HANDOFF_RUN_ID: options.handoffRunId ?? "5252",
    GH_STUB_DISPATCH_STATUS: options.dispatchStatus ?? "0",
    GH_STUB_DISPATCH_ACCEPTED_ON_ERROR: options.dispatchAcceptedOnError ? "1" : "0",
    GH_STUB_HANDOFF_DISPATCH_STATUS: options.handoffDispatchStatus ?? "0",
    GH_STUB_HANDOFF_ACCEPTED_ON_ERROR: options.handoffAcceptedOnError ? "1" : "0",
    GH_STUB_ACTIVE_BRANCH: options.activeMetadataValid === false ? "unprotected-branch" : "main",
    GH_STUB_ACK_BRANCH: options.acknowledgedMetadataValid === false ? "unprotected-branch" : "main",
    GH_STUB_HANDOFF_BRANCH: options.handoffMetadataValid === false ? "unprotected-branch" : "main",
    // HTTP 502 injection for the backup-history lookups, to prove an API outage
    // fails closed instead of reading as "no backup"/"not observed".
    GH_STUB_RUN_LIST_CONCLUSION_FAIL: options.runListConclusionFail ? "1" : "",
    GH_STUB_RUN_VIEW_FAIL: options.runViewFail ? "1" : "",
    GH_STUB_RUN_LIST_OBSERVE_FAIL: options.runListObserveFail ? "1" : "",
    GH_STUB_RUN_LIST_HANDOFF_FAIL: options.runListHandoffFail ? "1" : "",
    GH_STUB_OBSERVE_FAIL_TIMES: options.observeFailTimes ?? "",
    GH_STUB_HANDOFF_FAIL_TIMES: options.handoffFailTimes ?? "",
    GH_STUB_OBSERVE_FAIL_COUNTER: observeFailCounter,
    GH_STUB_HANDOFF_FAIL_COUNTER: handoffFailCounter,
  };
  const run = (name: string, source: string) => {
    const script = join(dir, `${name}.sh`);
    writeFileSync(script, `${controllerHarness}\n${source}`, "utf8");
    // The stubs are shell functions prepended into the script (not PATH
    // executables), so there is no fixture PATH to guard here; routed through the
    // shared helper for the single set of GitHub `shell: bash` flags.
    return runFixtureShellStep({ scriptPath: script, cwd: root, env });
  };
  const maintainResult = run("controller", step("Maintain continuous backup delivery").run);
  const handoff = steps.find((candidate) => candidate.name === "Hand off continuous backup delivery");
  const handoffResult = handoff
    ? run("handoff", handoff.run)
    : { status: 0, stdout: "", stderr: "" };
  const status = maintainResult.status === 0 ? handoffResult.status : maintainResult.status;
  return {
    ...maintainResult,
    status,
    stdout: `${maintainResult.stdout ?? ""}${handoffResult.stdout ?? ""}`,
    stderr: `${maintainResult.stderr ?? ""}${handoffResult.stderr ?? ""}`,
    calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
    flyctlCalls: readFileSync(flyctlLog, "utf8").split("\n").filter(Boolean),
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
  // The execution-gate check drives gh; guard it so the host's gh cannot shadow
  // the stub, and run under GitHub's exact flags via the shared helper.
  const result = runFixtureShellStep({
    scriptPath: script,
    cwd: root,
    fixtureBin: bin,
    guardTools: ["gh"],
    env: {
      ...process.env,
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
    const handoff = step("Hand off continuous backup delivery");
    expect(maintain.env.BACKUP_WORKFLOW).toBe("customer-backup.yml");
    expect(maintain.env.BACKUP_REF).toBe("${{ github.event.repository.default_branch }}");
    const backupObserveWindow = Number(maintain.env.DELIVERY_OBSERVE_ATTEMPTS)
      * Number(maintain.env.DELIVERY_OBSERVE_SLEEP_SECONDS);
    const handoffAttempts = Number(handoff.env.DELIVERY_HANDOFF_ATTEMPTS);
    const handoffObserveWindow = handoffAttempts
      * Number(handoff.env.DELIVERY_OBSERVE_ATTEMPTS)
      * Number(handoff.env.DELIVERY_OBSERVE_SLEEP_SECONDS);
    const handoffBackoffWindow = Number(handoff.env.DELIVERY_HANDOFF_BACKOFF_SECONDS)
      * handoffAttempts
      * (handoffAttempts - 1)
      / 2;
    const combinedRpoEnvelope = Number(maintain.env.DELIVERY_MAX_AGE_SECONDS)
      + Number(maintain.env.DELIVERY_MAX_ACTIVE_AGE_SECONDS)
      + (2 * Number(maintain.env.DELIVERY_SLEEP_SECONDS))
      + backupObserveWindow
      + handoffObserveWindow
      + handoffBackoffWindow
      + Number(maintain.env.DELIVERY_OBSERVATION_MARGIN_SECONDS);
    expect(combinedRpoEnvelope).toBe(3_510);
    expect(deliverySource).toContain("= 3510.");
    expect(combinedRpoEnvelope).toBeLessThan(CORE_DISASTER_RECOVERY_POLICY.rpoSeconds);
    expect(Number(maintain.env.DELIVERY_RPO_SECONDS)).toBe(
      CORE_DISASTER_RECOVERY_POLICY.rpoSeconds,
    );
    expect(maintain.run).toContain('gh workflow run "$BACKUP_WORKFLOW"');
    expect(maintain.run).toContain('-f "delivery_id=$delivery_id"');
    expect(maintain.run).toContain("displayTitle");
    expect(maintain.run).toContain("customer_backup_delivery_run_not_observed");
    expect(handoff.run).toContain('gh workflow run "$DELIVERY_WORKFLOW"');
    expect(handoff.if).toBe("${{ always() && steps.gate.outputs.active == 'true' }}");
    expect(Number(handoff.env.DELIVERY_HANDOFF_ATTEMPTS)).toBeGreaterThan(1);
    expect(Number(handoff.env.DELIVERY_HANDOFF_BACKOFF_SECONDS)).toBeGreaterThan(0);
    expect(handoffBackoffWindow).toBeGreaterThan(0);
    expect(deliverySource).not.toContain("scripts/customer-backup.ts");
    expect(deliverySource).not.toContain("scripts/start-fly.mjs");
    expect(deliverySource).not.toContain("initializeWithMutationLease");
  });

  it("binds dispatch acknowledgement to a unique delivery identity", () => {
    const result = runController({});
    expect(result.status, result.stderr).toBe(0);
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
    const result = runController({ backupJobSuccess: false, deliveryCycles: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_delivery_completion_missing");
    expect(result.calls.some((call) => call.startsWith("workflow run customer-backup-delivery.yml")))
      .toBe(true);
    expect(result.ledger).toContainEqual(expect.objectContaining({ event: "controller_handoff" }));
  });

  it("does not carry an early completion beyond the current freshness window", () => {
    const result = runController({
      latestSuccess: new Date(Date.now() - 2_000).toISOString(),
      deliveryMaxAgeSeconds: "10",
      deliveryRpoSeconds: "1",
      dispatchedWorkflowSuccess: false,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_delivery_completion_missing");
    expect(result.calls.some((call) => call.startsWith("workflow run customer-backup-delivery.yml")))
      .toBe(true);
  });

  it("isolates irrelevant branch recovery runs from the accepted successor", () => {
    expect(String(delivery.concurrency.group)).toContain("github.event.workflow_run.head_branch");
    expect(String(delivery.concurrency.group)).toContain("github.run_id");
    expect(String(delivery.concurrency.group)).toContain("head_repository.full_name");
    expect(String(controller.if)).toContain("head_repository.full_name");
    expect(String(controller.if)).toContain("workflow_run.event == 'push'");
  });

  it("validates exact protected run metadata for active and reconciled runs", () => {
    const maintain = step("Maintain continuous backup delivery");
    const handoff = step("Hand off continuous backup delivery");
    expect(maintain.run).toContain('gh api "repos/$GH_REPO/actions/runs/$active_id"');
    expect(maintain.run).toContain('head_branch == $branch');
    expect(maintain.run).toContain('path == $path');
    expect(maintain.run).toContain('event == "workflow_dispatch"');
    expect(maintain.run).toContain('created_at >= $windowStart');
    expect(maintain.run).toContain('--branch "$BACKUP_REF"');
    expect(handoff.run).toContain('gh api "repos/$GH_REPO/actions/runs/$candidate_run_id"');
    expect(handoff.run).toContain('head_branch == $branch');
    expect(handoff.run).toContain('path == $path');
    expect(handoff.run).toContain('created_at >= $windowStart');
  });

  it("rejects an active run outside the protected branch authority", () => {
    const activeMismatch = runController({ activeRunId: "31337", activeMetadataValid: false });
    expect(activeMismatch.status).not.toBe(0);
    expect(activeMismatch.stderr).toContain("customer_backup_delivery_active_authority_invalid");
  });

  it("treats a watchdog-dispatched backup as delivery in progress, not a metadata mismatch", () => {
    // The remediation the watchdog dispatches carries `backup-watchdog-<run>-
    // <attempt>` as its delivery_id, so its title is
    // `Customer production backup [backup-watchdog-123-1]`. This must read as an
    // active delivery, exactly like the controller's own `backup-delivery-`
    // title, instead of tripping the authority filter and paging the owner —
    // which is what happened on controller run 34760797936.
    const watchdogActive = runController({ activeRunId: "12321" });
    expect(watchdogActive.stderr).not.toContain("metadata_mismatch");
    expect(watchdogActive.ledger).toContainEqual(expect.objectContaining({
      event: "backup_active",
      backupRunId: "12321",
    }));
    expect(watchdogActive.ledger).not.toContainEqual(expect.objectContaining({
      event: "backup_active_authority_invalid",
    }));
  });

  it("still rejects a bare-titled workflow_dispatch backup as a metadata mismatch", () => {
    // The strictness the fix must keep: a workflow_dispatch run with the bare
    // `Customer production backup` title (no `[backup-...]` identity) is still
    // an unauthenticated active run and must fail closed.
    const bareActive = runController({ activeRunId: "13579" });
    expect(bareActive.status).not.toBe(0);
    expect(bareActive.stderr).toContain("customer_backup_delivery_active_authority_invalid");
    expect(bareActive.ledger).toContainEqual(expect.objectContaining({
      event: "backup_active_authority_invalid",
      backupRunId: "13579",
      reason: "metadata_mismatch",
    }));
  });

  it("rejects a lost-response backup dispatch outside the protected branch authority", () => {
    const dispatchMismatch = runController({ acknowledgedMetadataValid: false });
    expect(dispatchMismatch.status).not.toBe(0);
    expect(dispatchMismatch.stderr).toContain("customer_backup_delivery_run_not_observed");
  });

  it("rejects a successor handoff outside the protected branch authority", () => {
    const handoffMismatch = runController({
      latestSuccess: new Date().toISOString(),
      handoffMetadataValid: false,
    });
    expect(handoffMismatch.status).not.toBe(0);
    expect(handoffMismatch.stderr).toContain("customer_backup_delivery_successor_not_observed");
  });

  it("reconciles an accepted backup dispatch after the client loses its response", () => {
    const result = runController({ dispatchStatus: "1", dispatchAcceptedOnError: true });
    expect(result.status).toBe(0);
    expect(result.ledger).toContainEqual(expect.objectContaining({
      event: "backup_dispatched",
      backupRunId: "4242",
    }));
  });

  it("reconciles an accepted controller handoff after the client loses its response", () => {
    const result = runController({
      latestSuccess: new Date().toISOString(),
      handoffDispatchStatus: "1",
      handoffAcceptedOnError: true,
    });
    expect(result.status).toBe(0);
    expect(result.ledger).toContainEqual(expect.objectContaining({
      event: "controller_handoff",
      successorRunId: "5252",
    }));
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
      .toBe(true);
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
      activeCreatedAt: new Date(Date.now() - 1_300_000).toISOString(),
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

  it("never invokes flyctl from the controller, which is bound to no Fly token", () => {
    const maintain = step("Maintain continuous backup delivery");
    // Bound from the same variable the watchdog and backup workflows use.
    expect(maintain.env.CUSTOMER_APP).toBe("${{ vars.MENDPOINT_CUSTOMER_FLY_APP }}");
    // Structural invariant that cannot be behavioural: the controller is bound to
    // no Fly token, so it CANNOT restart a machine even by mistake.
    expect(maintain.env).not.toHaveProperty("FLY_API_TOKEN");
    // Behavioural, not a source scan: a healthy run probes /livez and dispatches,
    // and the harness routes any flyctl call to a logger. An empty log proves the
    // controller stayed token-free rather than merely looking so in the source.
    const result = runController({ livezCode: "200" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.flyctlCalls).toEqual([]);
    expect(result.calls.filter((call) => call.startsWith("workflow run customer-backup.yml")))
      .toHaveLength(1);
  });

  it("fails with the named app-binding error when CUSTOMER_APP is unset or malformed", () => {
    // An unset or malformed binding would make the /livez probe target
    // `https://.fly.dev/livez`, which never returns 200, so every cycle would
    // defer and a config error would read as an app outage. Validate first, with
    // the same regex the backup workflow uses, and fail with the named
    // delivery-specific reason instead.
    for (const badApp of ["", "Bad_App.example"]) {
      const result = runController({ customerApp: badApp });
      expect(result.status, `app=${JSON.stringify(badApp)}`).not.toBe(0);
      expect(result.stderr).toContain("customer_backup_delivery_app_binding_invalid");
      // No backup dispatched, and not mislabelled as an app outage.
      expect(result.calls.some((call) => call.startsWith("workflow run customer-backup.yml"))).toBe(false);
      expect(result.stderr).not.toContain("customer_backup_delivery_deferred_app_down");
      expect(result.ledger).toContainEqual(expect.objectContaining({
        event: "delivery_app_binding_invalid",
      }));
    }
  });

  it("never dispatches a backup into a customer app that is not live, and records why", () => {
    const result = runController({ livezCode: "503", deliveryCycles: "2" });
    // Zero backup dispatches: incident #659 was ~200 dispatches/day into a
    // stopped machine, every one of which failed to back anything up.
    expect(result.calls.filter((call) => call.startsWith("workflow run customer-backup.yml")))
      .toHaveLength(0);
    expect(result.ledger).toContainEqual(expect.objectContaining({
      event: "delivery_deferred_app_not_live",
      livezCode: "503",
    }));
  });

  it("fails once, with the app-down reason, when every cycle deferred on a down app", () => {
    const result = runController({ livezCode: "503", deliveryCycles: "2" });
    expect(result.status).not.toBe(0);
    // The named, specific reason — not the generic completion-missing that masks
    // an app outage as a delivery incident. The existing failure alert dedupes
    // by label, so it fires once.
    expect(result.stderr).toContain("customer_backup_delivery_deferred_app_down");
    expect(result.stderr).not.toContain("customer_backup_delivery_completion_missing");
    expect(result.ledger).toContainEqual(expect.objectContaining({
      event: "delivery_deferred_app_down",
      deferredCycles: 2,
    }));
  });

  it("dispatches as before when the customer app is live", () => {
    // The probe does not change the healthy path: a 200 dispatches exactly one.
    const result = runController({ livezCode: "200" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter((call) => call.startsWith("workflow run customer-backup.yml")))
      .toHaveLength(1);
    expect(result.ledger).not.toContainEqual(expect.objectContaining({
      event: "delivery_deferred_app_not_live",
    }));
  });

  it("fails closed on a backup-history lookup outage instead of dispatching a duplicate", () => {
    // `gh run list` for the successful-backup lookup returns HTTP 502. Before
    // the fix, the command substitution swallowed the error and read as "no
    // recent backup", dispatching a backup and later reporting completion-missing.
    const result = runController({ runListConclusionFail: true, deliveryCycles: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_delivery_lookup_failed");
    expect(result.stderr).not.toContain("customer_backup_delivery_completion_missing");
    // Never dispatch a backup on the strength of an unreadable history.
    expect(result.calls.filter((call) => call.startsWith("workflow run customer-backup.yml")))
      .toHaveLength(0);
    expect(result.ledger).toContainEqual(expect.objectContaining({
      event: "backup_lookup_failed",
      operation: "run_list",
    }));
  });

  it("does not read a 502 on the backup-job lookup as a job that never completed", () => {
    // `gh run view` returns HTTP 502 while inspecting a successful candidate.
    // Before the fix, the empty result read as "workflow green but backup job
    // missing" and dispatched a backup; now it is a distinct lookup failure.
    const result = runController({ runViewFail: true, deliveryCycles: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_delivery_lookup_failed");
    expect(result.calls.filter((call) => call.startsWith("workflow run customer-backup.yml")))
      .toHaveLength(0);
    expect(result.ledger).toContainEqual(expect.objectContaining({
      event: "backup_lookup_failed",
      operation: "run_view",
      backupRunId: "777",
    }));
    expect(result.ledger).not.toContainEqual(expect.objectContaining({
      event: "backup_workflow_success_without_backup_job",
    }));
  });

  it("fails closed when the dispatch-acknowledgement lookup errors instead of re-dispatching", () => {
    // The backup is dispatched, then `gh run list` for the acknowledgement
    // observation returns HTTP 502. Before the fix, the empty word list read as
    // "dispatch unacknowledged"; now it is a distinct lookup failure.
    const result = runController({
      runListObserveFail: true,
      latestSuccess: "",
      deliveryCycles: "1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_delivery_lookup_failed");
    expect(result.ledger).toContainEqual(expect.objectContaining({
      event: "backup_lookup_failed",
      operation: "run_list_observe",
    }));
    expect(result.ledger).not.toContainEqual(expect.objectContaining({
      event: "dispatch_unacknowledged",
    }));
  });

  it("recovers a transient 502 on the acknowledgement poll and still delivers exactly one backup", () => {
    // A single failed acknowledgement poll is transient. The loop must keep
    // polling across its attempts and observe the dispatched run on a later
    // poll, rather than failing the whole run on the first 502.
    const result = runController({
      observeFailTimes: "1",
      deliveryObserveAttempts: "3",
      latestSuccess: "",
      deliveryCycles: "1",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter((call) => call.startsWith("workflow run customer-backup.yml")))
      .toHaveLength(1);
    expect(result.ledger).toContainEqual(expect.objectContaining({ event: "backup_dispatched" }));
    // The transient failure was still recorded, but did not fail the run.
    expect(result.ledger).toContainEqual(expect.objectContaining({
      event: "backup_lookup_failed",
      operation: "run_list_observe",
    }));
  });

  it("fails closed as lookup_failed when every acknowledgement poll errors, without a duplicate dispatch", () => {
    const result = runController({
      runListObserveFail: true,
      deliveryObserveAttempts: "3",
      latestSuccess: "",
      deliveryCycles: "1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_delivery_lookup_failed");
    // Exactly one backup dispatch; the observation outage never re-dispatches.
    expect(result.calls.filter((call) => call.startsWith("workflow run customer-backup.yml")))
      .toHaveLength(1);
    expect(result.stderr).not.toContain("customer_backup_delivery_run_not_observed");
  });

  it("recovers a transient 502 on the successor poll and still completes the handoff once", () => {
    const result = runController({
      latestSuccess: new Date().toISOString(),
      handoffFailTimes: "1",
      deliveryObserveAttempts: "3",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter((call) => call.startsWith("workflow run customer-backup-delivery.yml")))
      .toHaveLength(1);
    expect(result.ledger).toContainEqual(expect.objectContaining({ event: "controller_handoff" }));
  });

  it("fails closed as lookup_failed when every successor poll errors, without re-dispatching a successor", () => {
    // The handoff dispatches once, then every successor observation poll errors.
    // A re-dispatch on an API outage would create a duplicate successor, so the
    // handoff must fail closed as a lookup failure with exactly one dispatch,
    // even though DELIVERY_HANDOFF_ATTEMPTS would otherwise re-dispatch.
    const result = runController({
      latestSuccess: new Date().toISOString(),
      runListHandoffFail: true,
      deliveryObserveAttempts: "2",
      deliveryHandoffAttempts: "3",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_delivery_lookup_failed");
    expect(result.calls.filter((call) => call.startsWith("workflow run customer-backup-delivery.yml")))
      .toHaveLength(1);
    expect(result.stderr).not.toContain("customer_backup_delivery_successor_not_observed");
  });

  it("still re-dispatches when a transient 502 is followed by a poll that shows no successor", () => {
    // A single 502 must not suppress re-dispatch when a later poll succeeds and
    // shows the successor is genuinely absent: that is main's re-dispatch case,
    // not an API outage. Only an all-failed observation window skips re-dispatch.
    const result = runController({
      latestSuccess: new Date().toISOString(),
      handoffRunId: "",
      handoffFailTimes: "1",
      deliveryObserveAttempts: "2",
      deliveryHandoffAttempts: "2",
    });
    expect(result.status).not.toBe(0);
    // Two dispatches: the transient 502 did not suppress the re-dispatch.
    expect(result.calls.filter((call) => call.startsWith("workflow run customer-backup-delivery.yml")))
      .toHaveLength(2);
    // A genuinely-absent successor is reported as not-observed, not lookup_failed.
    expect(result.stderr).toContain("customer_backup_delivery_successor_not_observed");
  });

  it("reports a final-lookup outage as lookup_failed, never as completion-missing", () => {
    // Every cycle sees an active backup, so the per-cycle history lookup is never
    // taken; the final reconciliation lookup then errors. That must read as a
    // lookup failure, not the generic completion-missing that masks an outage.
    const result = runController({
      activeRunId: "31337",
      runListConclusionFail: true,
      deliveryCycles: "1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("customer_backup_delivery_lookup_failed");
    expect(result.stderr).not.toContain("customer_backup_delivery_completion_missing");
    expect(result.ledger).toContainEqual(expect.objectContaining({
      event: "backup_lookup_failed",
      operation: "run_list",
    }));
  });
});
