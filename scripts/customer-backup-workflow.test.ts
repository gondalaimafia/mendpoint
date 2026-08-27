import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { customerBackupInputFromEnv } from "@mendpoint/ops";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(
  resolve(root, ".github/workflows/customer-backup.yml"),
  "utf8",
);
const workflow = parse(source) as Record<string, any>;
const job = workflow.jobs.backup as Record<string, any>;
const steps = job.steps as Record<string, any>[];
const profileGate = workflow.jobs["profile-gate"] as Record<string, any>;
const profileScript = (profileGate.steps as Record<string, any>[]).find(
  (candidate) => candidate.id === "check",
)?.run as string;
const incidentJob = workflow.jobs["backup-incident"] as Record<string, any>;
const incidentScript = (incidentJob.steps as Record<string, any>[]).find(
  (candidate) => candidate.name === "Reconcile customer backup incident",
)?.run as string;
const temporaryRoots: string[] = [];

function executable(directory: string, name: string, body: string): void {
  const path = join(directory, name);
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
}

function installProfileStubs(directory: string): void {
  executable(directory, "flyctl", `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "apps" && args[1] === "list") {
  if (process.env.STUB_APPS_AVAILABLE === "false") process.exit(1);
  process.stdout.write((process.env.STUB_APPS_JSON ?? process.env.STUB_VISIBLE_APPS) + "\\n");
} else if (args[0] === "status") {
  if (process.env.STUB_STATUS_AVAILABLE === "false") process.exit(1);
  process.stdout.write(JSON.stringify({ ID: Number(process.env.STUB_APP_ID) }) + "\\n");
} else if (args[0] === "tokens" && args[1] === "debug") {
  if (process.env.STUB_TOKEN_DEBUG_AVAILABLE === "false") process.exit(1);
  process.stdout.write(process.env.STUB_TOKEN_DEBUG_JSON + "\\n");
} else if (args[0] === "ssh" && args[1] === "console") {
  if (process.env.STUB_RUNTIME_AVAILABLE === "false") process.exit(1);
  process.stdout.write(process.env.STUB_RUNTIME_JSON ?? JSON.stringify({
    deploymentProfile: process.env.STUB_LIVE_PROFILE,
    releaseRevision: process.env.STUB_LIVE_RELEASE,
  }));
  process.stdout.write("\\n");
} else {
  process.stderr.write("unexpected flyctl invocation: " + args.join(" ") + "\\n");
  process.exit(64);
}
`);
  executable(directory, "jq", `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const filter = args.at(-1) || "";
if (args.includes("-n")) {
  const values = {};
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] !== "--arg" && args[index] !== "--argjson") continue;
    const json = args[index] === "--argjson";
    const key = args[index + 1];
    const raw = args[index + 2];
    values[key] = json ? JSON.parse(raw) : raw;
    index += 2;
  }
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    kind: "customer_backup_preflight",
    app: values.app,
    workflowRevision: values.workflowRevision,
    liveReleaseRevision: values.liveReleaseRevision,
    releaseRevisionMatchesWorkflow: values.releaseRevisionMatchesWorkflow,
    runId: values.runId,
    runAttempt: values.runAttempt,
    observedAt: values.observedAt,
    result: values.result,
    reason: values.reason,
    liveProfile: values.liveProfile,
    expectedCustomerProfile: values.expectedCustomerProfile,
    backupTaken: values.backupTaken,
    operatorActionRequired: values.operatorActionRequired,
  }) + "\\n");
  process.exit(0);
}
let input;
try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(4); }
if (filter.includes("[.[]") && !filter.includes("ascii_downcase")) {
  const names = [...new Set(input.map((entry) => entry.Name ?? entry.name))];
  process.stdout.write(JSON.stringify(names) + "\\n");
} else if (filter === "length") {
  process.stdout.write(String(input.length) + "\\n");
} else if (filter.includes(".[0]")) {
  process.stdout.write(String(input[0] ?? "") + "\\n");
} else if (filter.includes("deploymentProfile")) {
  if (typeof input.deploymentProfile !== "string") process.exit(4);
  process.stdout.write(input.deploymentProfile + "\\n");
} else if (filter.includes("releaseRevision")) {
  if (typeof input.releaseRevision !== "string" || !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(input.releaseRevision)) process.exit(4);
  process.stdout.write(input.releaseRevision + "\\n");
} else if (filter.includes(".ID // .id")) {
  const id = input.ID ?? input.id ?? input.App?.ID ?? input.app?.id;
  if (!Number.isInteger(Number(id)) || Number(id) <= 0) process.exit(4);
  process.stdout.write(String(id) + "\\n");
} else if (filter.includes("ascii_downcase")) {
  if (!Array.isArray(input)) process.exit(1);
  const permissions = input.filter((token) => /api\\.fly\\.io/.test(token.location ?? ""));
  const appIdIndex = args.indexOf("--arg");
  const appId = appIdIndex >= 0 ? args[appIdIndex + 2] : "";
  const ok = permissions.length > 0 && permissions.every((token) => {
    const apps = (token.caveats ?? []).filter((caveat) =>
      String(caveat.type ?? caveat.name ?? caveat.kind ?? "").toLowerCase() === "apps"
    ).map((caveat) => caveat.value ?? caveat.values ?? caveat.args ?? caveat.apps ?? []);
    return apps.length === 1 && Array.isArray(apps[0]) && apps[0].length === 1 &&
      String(apps[0][0]) === appId && /^[1-9][0-9]*$/.test(String(apps[0][0]));
  });
  process.exit(ok ? 0 : 1);
} else if (filter.includes(".[$source]")) {
  const sourceIndex = args.indexOf("--arg");
  const source = sourceIndex >= 0 ? args[sourceIndex + 2] : "";
  const value = input?.[source];
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) process.exit(4);
  process.stdout.write(value + "\\n");
} else {
  process.stderr.write("unexpected jq filter: " + filter + "\\n");
  process.exit(64);
}
`);
}

function parseOutputs(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").trim().split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

interface ProfileGateInput {
  intent?: string;
  liveProfile?: string;
  liveRelease?: string;
  flyToken?: string;
  customerApp?: string;
  visibleApps?: string[];
  appsAvailable?: boolean;
  appsJson?: string;
  workflowRevision?: string;
  statusAvailable?: boolean;
  runtimeAvailable?: boolean;
  runtimeJson?: string;
  tokenDebugJson?: string;
  appId?: string;
  releaseMap?: string;
}

function flyPermissionToken(
  apps: Readonly<Record<string, string>>,
  extraCaveats: readonly unknown[] = [],
): Record<string, unknown> {
  return {
    location: "https://api.fly.io/v1",
    caveats: [
      { type: "Apps", body: { apps } },
      ...extraCaveats,
    ],
  };
}

function runProfileGate(input: ProfileGateInput): {
  status: number | null;
  stderr: string;
  evidence: Record<string, unknown>;
  outputs: Record<string, string>;
} {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-profile-gate-"));
  temporaryRoots.push(directory);
  installProfileStubs(directory);
  mkdirSync(join(directory, "scripts"), { recursive: true });
  copyFileSync(
    resolve(root, "scripts/verify-fly-app-token-scope.mjs"),
    join(directory, "scripts/verify-fly-app-token-scope.mjs"),
  );
  mkdirSync(join(directory, "test-results/customer-backup-preflight"), { recursive: true });
  const output = join(directory, "github-output.txt");
  const summary = join(directory, "github-summary.md");
  const sha = input.workflowRevision ?? "d".repeat(40);
  const customerApp = input.customerApp ?? "mendpoint-customer";
  const visibleApps = input.visibleApps ?? [customerApp];
  const derivedTokenDebug = JSON.stringify([flyPermissionToken(Object.fromEntries(
    visibleApps.map((name) => [name === customerApp ? "123" : "999", "rw"]),
  ))]);
  const result = spawnSync("bash", ["-c", profileScript], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      EXPECTED_ACTIVE: input.intent ?? "",
      FLY_API_TOKEN: input.flyToken ?? "FlyV1 fm2_YQ==",
      CUSTOMER_APP: customerApp,
      STUB_VISIBLE_APPS: JSON.stringify(visibleApps.map((Name) => ({ Name }))),
      STUB_APPS_AVAILABLE: input.appsAvailable === false ? "false" : "true",
      ...(input.appsJson === undefined ? {} : { STUB_APPS_JSON: input.appsJson }),
      STUB_STATUS_AVAILABLE: input.statusAvailable === false ? "false" : "true",
      STUB_RUNTIME_AVAILABLE: input.runtimeAvailable === false ? "false" : "true",
      ...(input.runtimeJson === undefined ? {} : { STUB_RUNTIME_JSON: input.runtimeJson }),
      STUB_LIVE_PROFILE: input.liveProfile ?? "demo",
      STUB_LIVE_RELEASE: input.liveRelease ?? sha,
      STUB_TOKEN_DEBUG_JSON: input.tokenDebugJson ??
        (input.appsJson === undefined ? derivedTokenDebug : input.appsJson),
      STUB_TOKEN_DEBUG_AVAILABLE: input.appsAvailable === false ? "false" : "true",
      STUB_APP_ID: input.appId ?? "123",
      RELEASE_MAP: input.releaseMap ?? "",
      GITHUB_SHA: sha,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_WORKSPACE: directory,
    },
  });
  const evidence = JSON.parse(readFileSync(
    join(directory, "test-results/customer-backup-preflight/preflight-123-2.json"),
    "utf8",
  )) as Record<string, unknown>;
  return {
    status: result.status,
    stderr: result.stderr,
    evidence,
    outputs: parseOutputs(output),
  };
}

function runIncident(input: {
  profileJobResult: string;
  profileAuthorityResult: string;
  profileActive: string;
  backupJobResult: string;
  existingIssue?: string;
}): { status: number | null; stderr: string; commands: string[][] } {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-backup-incident-"));
  temporaryRoots.push(directory);
  const log = join(directory, "gh.jsonl");
  writeFileSync(log, "", "utf8");
  executable(directory, "gh", `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "issue" && args[1] === "list") {
  const query = args[args.indexOf("--jq") + 1] || "";
  const existing = process.env.STUB_EXISTING_ISSUE || "";
  if (existing && (query.includes("[0]") || query.includes("[]"))) process.stdout.write(existing + "\\n");
}
`);
  const result = spawnSync("bash", ["-c", incidentScript], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      GH_TOKEN: "token",
      GH_REPO: "gondalaimafia/mendpoint",
      RUN_URL: "https://github.example.test/actions/runs/123",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
      PROFILE_JOB_RESULT: input.profileJobResult,
      PROFILE_AUTHORITY_RESULT: input.profileAuthorityResult,
      PROFILE_ACTIVE: input.profileActive,
      BACKUP_JOB_RESULT: input.backupJobResult,
      STUB_EXISTING_ISSUE: input.existingIssue ?? "",
      STUB_GH_LOG: log,
    },
  });
  const commands = readFileSync(log, "utf8").trim()
    ? readFileSync(log, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[])
    : [];
  return { status: result.status, stderr: result.stderr, commands };
}

function called(commands: readonly string[][], ...prefix: string[]): boolean {
  return commands.some((command) => prefix.every((part, index) => command[index] === part));
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
    const gate = workflow.jobs["profile-gate"] as Record<string, any>;
    expect(gate.if).toBe("${{ github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}");
    expect(job.environment).toBe("customer-production-backup");
    expect(job["timeout-minutes"]).toBe(270);
    expect(workflow.concurrency).toMatchObject({
      group: "customer-production-backup",
      "cancel-in-progress": false,
    });
  });

  it("requires an exact app binding and proves the Fly token is app scoped", () => {
    const validate = step("Validate app-scoped backup authority");
    expect(validate.env.FLY_API_TOKEN).toBe("${{ secrets.MENDPOINT_CUSTOMER_BACKUP_FLY_TOKEN }}");
    expect(validate.env.CUSTOMER_APP).toBe("${{ vars.MENDPOINT_CUSTOMER_FLY_APP }}");
    expect(validate.run).toContain('token_debug_json="$(flyctl tokens debug)"');
    expect(validate.run).toContain("customer_backup_token_debug_invalid");
    expect(validate.run).toContain("customer_backup_token_not_app_scoped");
    expect(validate.run).toContain("MENDPOINT_FLY_TOKEN_DEBUG_JSON");
    expect(validate.run).toContain(
      'node "$GITHUB_WORKSPACE/scripts/verify-fly-app-token-scope.mjs"',
    );
    expect(validate.run).toContain("--credential-only");
    expect(validate.run.indexOf("--credential-only")).toBeLessThan(
      validate.run.indexOf("flyctl tokens debug"),
    );
    expect(validate.run).not.toContain("node -e");
    expect(validate.run).not.toContain('apps_json="$(flyctl apps list --json)"');
    expect(validate.run).not.toContain("mapfile -t visible_apps < <(");
    expect(validate.run).not.toContain(".[].Name");
    expect(validate.run).toContain('flyctl status --app "$CUSTOMER_APP"');
    expect(source.match(/node "\$GITHUB_WORKSPACE\/scripts\/verify-fly-app-token-scope\.mjs"/g))
      .toHaveLength(4);
  });

  it("executes the authenticated backup remotely with bounded evidence retention", () => {
    const checkoutIndex = steps.findIndex((candidate) => candidate.name === "Check out verifier");
    const runIndex = steps.findIndex((candidate) => candidate.name === "Run authenticated customer backup");
    expect(checkoutIndex).toBeGreaterThanOrEqual(0);
    expect(checkoutIndex).toBeLessThan(runIndex);
    expect(steps[checkoutIndex]?.uses).toBe(
      "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
    );
    expect(steps[checkoutIndex]?.with).toEqual({ "persist-credentials": false });
    expect(source).toContain(
      "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0",
    );

    const initialize = step("Initialize backup evidence");
    expect(initialize.run).toContain("GITHUB_RUN_ATTEMPT");
    expect(initialize.run).toContain("GITHUB_SHA");
    const run = step("Run authenticated customer backup");
    expect(run.env.FLY_API_TOKEN).toBe("${{ secrets.MENDPOINT_CUSTOMER_BACKUP_FLY_TOKEN }}");
    expect(run.run).toContain('flyctl ssh console --app "$CUSTOMER_APP"');
    expect(run.env.EXPECTED_RELEASE).toBe("${{ needs.profile-gate.outputs.release }}");
    expect(run.run).toContain("--expected-release $EXPECTED_RELEASE");
    expect(run.run).toContain("scripts/customer-backup.ts");
    expect(run.run).toContain('tee -a "$evidence"');
    expect(run.run).toContain('bash scripts/verify-customer-backup-result.sh "$evidence" "$EXPECTED_RELEASE"');
    expect(run.run).not.toContain("grep -q '\"backupId\"'");
    expect(run.run).not.toContain("grep -q '\"manifestAuthentication\"'");
    expect(run.run).not.toContain("grep -q '\"publication\"'");
    expect(run.run.indexOf("verify-customer-backup-result.sh")).toBeLessThan(
      run.run.indexOf("backupTaken=true"),
    );
    const upload = step("Retain backup evidence");
    expect(upload.if).toBe("${{ always() }}");
    expect(upload["with"]["retention-days"]).toBe(90);
    expect(upload["with"]["if-no-files-found"]).toBe("error");
  });

  it("opens one deduplicated GitHub issue on failure and closes it after recovery", () => {
    const notifier = workflow.jobs["backup-incident"] as Record<string, any>;
    expect(notifier, "backup-incident job must exist").toBeTruthy();
    expect(notifier.needs).toEqual(["profile-gate", "backup"]);
    expect(notifier.if).toContain("always()");
    expect(notifier.if).toContain("github.event.repository.default_branch");
    expect(notifier.permissions).toMatchObject({ contents: "read", issues: "write" });

    const notify = (notifier.steps as Record<string, any>[]).find(
      (candidate) => candidate.name === "Reconcile customer backup incident",
    ) as Record<string, any>;
    expect(notify, "incident reconciler step must exist").toBeTruthy();
    expect(notify.env.PROFILE_JOB_RESULT).toBe("${{ needs.profile-gate.result }}");
    expect(notify.env.PROFILE_AUTHORITY_RESULT).toBe("${{ needs.profile-gate.outputs.result }}");
    expect(notify.env.PROFILE_ACTIVE).toBe("${{ needs.profile-gate.outputs.active }}");
    expect(notify.env.BACKUP_JOB_RESULT).toBe("${{ needs.backup.result }}");
    expect(notify.run).toContain("customer-production-backup-failure");
    expect(notify.run).toContain("gh issue create");
    expect(notify.run).toContain("gh issue comment");
    expect(notify.run).toContain("gh issue close");
    expect(notify.run).toContain('PROFILE_AUTHORITY_RESULT" = "not_configured"');
    expect(notify.run).toContain("No incident state changes are permitted");
    expect(notify.run).toContain('PROFILE_JOB_RESULT" = "success"');
    expect(notify.run).toContain('PROFILE_ACTIVE" = "true"');
    expect(notify.run).toContain('BACKUP_JOB_RESULT" = "success"');
    expect(notify.run).toContain("Evidence artifact:");
    expect(notify.run).toContain("$RUN_URL#artifacts");

    expect(steps.some((candidate) => candidate.name === "Alert on backup failure")).toBe(false);
    expect(steps.some((candidate) => candidate.name === "Resolve backup failure alert")).toBe(false);
  });


  it("binds operator intent to the live app profile through exact Fly authority", () => {
    const gate = workflow.jobs["profile-gate"] as Record<string, any>;
    expect(gate, "profile-gate job must exist").toBeTruthy();
    expect(gate.environment).toBe("customer-production-backup");
    const gateCheckout = (gate.steps as Record<string, any>[]).find(
      (candidate) => candidate.name === "Check out authority verifier",
    ) as Record<string, any>;
    expect(gateCheckout.uses).toBe(
      "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
    );
    expect(gateCheckout.with).toEqual({ "persist-credentials": false });
    const gateStep = (gate.steps as Record<string, any>[]).find(
      (candidate) => candidate.id === "check",
    ) as Record<string, any>;
    expect(gateStep.env.EXPECTED_ACTIVE).toBe("${{ vars.MENDPOINT_CUSTOMER_PROFILE_ACTIVE }}");
    expect(gateStep.env.FLY_API_TOKEN).toBe("${{ secrets.MENDPOINT_CUSTOMER_BACKUP_FLY_TOKEN }}");
    expect(gateStep.env.CUSTOMER_APP).toBe("${{ vars.MENDPOINT_CUSTOMER_FLY_APP }}");
    expect(gateStep.env.RELEASE_MAP).toBe("${{ vars.MENDPOINT_CUSTOMER_BACKUP_RELEASE_MAP }}");
    expect(gateStep.run).toContain('token_debug_json="$(flyctl tokens debug)"');
    expect(gateStep.run).not.toContain("mapfile -t visible_apps < <(");
    expect(gateStep.run).toContain('flyctl ssh console --app "$CUSTOMER_APP"');
    expect(gateStep.run).toContain("MENDPOINT_DEPLOYMENT_PROFILE");
    expect(gateStep.run).toContain("MENDPOINT_RELEASE_REVISION");
    expect(gateStep.run).toContain('live_release_revision="$(');
    expect(gateStep.run).toContain('[ "$live_release_revision" != "$expected_release" ]');
    expect(gateStep.run).toContain("customer_backup_release_revision_mismatch");
    expect(gateStep.run.indexOf("customer_backup_release_revision_mismatch")).toBeLessThan(
      gateStep.run.lastIndexOf("active=true"),
    );
    expect(gateStep.run).toContain("customer_backup_profile_authority_mismatch");
    expect(gateStep.run).toContain("operator_action_required");
  });

  it("retains an explicit non-success result when the inactive profile takes no backup", () => {
    const gate = workflow.jobs["profile-gate"] as Record<string, any>;
    const gateStep = (gate.steps as Record<string, any>[]).find(
      (candidate) => candidate.id === "check",
    ) as Record<string, any>;
    expect(gateStep.run).toContain("::notice");
    expect(gateStep.run).toContain("No backup was taken");
    expect(gateStep.run).toContain('result="not_configured"');
    expect(gateStep.run).toContain("--argjson backupTaken false");
    expect(gateStep.run).toContain('--arg workflowRevision "$GITHUB_SHA"');
    expect(gateStep.run).toContain('--arg liveReleaseRevision "$live_release_revision"');
    expect(gateStep.run).toContain("--argjson releaseRevisionMatchesWorkflow");
    expect(gateStep.run).not.toContain('--arg revision "$GITHUB_SHA"');

    const retain = (gate.steps as Record<string, any>[]).find(
      (candidate) => candidate.name === "Retain backup preflight evidence",
    ) as Record<string, any>;
    expect(retain.if).toBe("${{ always() }}");
    expect(retain["with"]["if-no-files-found"]).toBe("error");
    expect(retain["with"]["retention-days"]).toBe(90);

    expect(job.needs).toBe("profile-gate");
    expect(job.if).toContain("needs.profile-gate.outputs.active == 'true'");
    expect(job.if).toContain("github.event.repository.default_branch");
  });

  it("fails closed on missing profile intent and opens the deduplicated incident", () => {
    const gate = runProfileGate({ liveProfile: "demo" });
    expect(gate.status).toBe(1);
    expect(gate.outputs).toMatchObject({ active: "false", result: "authority_invalid" });
    expect(gate.evidence).toMatchObject({
      result: "authority_invalid",
      reason: "customer_profile_intent_missing",
      expectedCustomerProfile: null,
      operatorActionRequired: true,
      backupTaken: false,
    });

    const incident = runIncident({
      profileJobResult: "failure",
      profileAuthorityResult: gate.outputs.result!,
      profileActive: gate.outputs.active!,
      backupJobResult: "skipped",
      existingIssue: "42",
    });
    expect(incident.status, incident.stderr).toBe(0);
    expect(called(incident.commands, "issue", "comment", "42")).toBe(true);
    expect(called(incident.commands, "issue", "create")).toBe(false);
  });

  it("fails closed on invalid profile intent with retained operator evidence", () => {
    const gate = runProfileGate({ intent: "TRUE", liveProfile: "demo" });
    expect(gate.status).toBe(1);
    expect(gate.outputs).toMatchObject({ active: "false", result: "authority_invalid" });
    expect(gate.evidence).toMatchObject({
      result: "authority_invalid",
      reason: "customer_profile_intent_invalid",
      expectedCustomerProfile: null,
      operatorActionRequired: true,
      backupTaken: false,
    });
  });

  it("treats only explicit false plus a live non-customer profile as not configured", () => {
    const gate = runProfileGate({ intent: "false", liveProfile: "demo" });
    expect(gate.status, gate.stderr).toBe(0);
    expect(gate.outputs).toMatchObject({ active: "false", result: "not_configured" });
    expect(gate.evidence).toMatchObject({
      result: "not_configured",
      reason: "customer_profile_inactive",
      operatorActionRequired: false,
      backupTaken: false,
    });

    const incident = runIncident({
      profileJobResult: "success",
      profileAuthorityResult: "not_configured",
      profileActive: "false",
      backupJobResult: "skipped",
      existingIssue: "42",
    });
    expect(incident.status, incident.stderr).toBe(0);
    expect(incident.commands).toEqual([]);
  });

  it("marks explicit true with the exact live customer release eligible", () => {
    const gate = runProfileGate({ intent: "true", liveProfile: "customer" });
    expect(gate.status, gate.stderr).toBe(0);
    expect(gate.outputs).toMatchObject({ active: "true", result: "eligible" });
    expect(gate.evidence).toMatchObject({
      result: "eligible",
      reason: "live_customer_profile_verified",
      releaseRevisionMatchesWorkflow: true,
      operatorActionRequired: false,
      backupTaken: false,
    });
  });

  it.each([
    {
      name: "organization token",
      tokenDebug: [{
        location: "https://api.fly.io/v1",
        caveats: [{ type: "Organization", body: { id: 7, mask: "rw" } }],
      }],
    },
    { name: "personal token omitted by debug", flyToken: "fo1_personal", tokenDebug: [] },
    {
      name: "mixed personal and app credential omitted by debug",
      flyToken: "FlyV1 fm2_YQ==,fo1_personal",
      tokenDebug: [flyPermissionToken({ "123": "rw" })],
    },
    {
      name: "multiple raw macaroons",
      flyToken: "FlyV1 fm2_YQ==,fm2_Yg==",
      tokenDebug: [flyPermissionToken({ "123": "rw" }), flyPermissionToken({ "123": "rw" })],
    },
    { name: "wildcard app caveat", tokenDebug: [flyPermissionToken({ "0": "rw" })] },
    { name: "wrong app caveat", tokenDebug: [flyPermissionToken({ "999": "rw" })] },
    {
      name: "multiple app caveat",
      tokenDebug: [flyPermissionToken({ "123": "rw", "999": "rw" })],
    },
    {
      name: "wrapped app caveat",
      tokenDebug: [{
        location: "https://api.fly.io/v1",
        caveats: [{
          type: "IfPresent",
          body: { caveats: [{ type: "Apps", body: { apps: { "123": "rw" } } }] },
        }],
      }],
    },
    {
      name: "mixed permission tokens",
      tokenDebug: [flyPermissionToken({ "123": "rw" }), flyPermissionToken({ "999": "rw" })],
    },
  ])("rejects $name from backup authority", ({ tokenDebug, flyToken }) => {
    const gate = runProfileGate({
      intent: "true",
      liveProfile: "customer",
      tokenDebugJson: JSON.stringify(tokenDebug),
      ...(flyToken === undefined ? {} : { flyToken }),
    });
    expect(gate.status).toBe(1);
    expect(gate.evidence).toMatchObject({
      result: "authority_unavailable",
      reason: "customer_backup_token_not_app_scoped",
      backupTaken: false,
    });
  });

  it("rejects a mixed raw credential before token debugging", () => {
    const gate = runProfileGate({
      intent: "true",
      liveProfile: "customer",
      flyToken: "FlyV1 fm2_YQ==,fo1_personal",
      appsAvailable: false,
    });
    expect(gate.status).toBe(1);
    expect(gate.evidence).toMatchObject({
      result: "authority_unavailable",
      reason: "customer_backup_token_not_app_scoped",
      backupTaken: false,
    });
  });

  it("requires a protected exact mapping before a 64 character release is eligible", () => {
    const workflowRevision = "d".repeat(40);
    const release = "e".repeat(64);
    const missing = runProfileGate({ intent: "true", liveProfile: "customer", liveRelease: release });
    expect(missing.status).toBe(1);
    expect(missing.evidence).toMatchObject({ reason: "customer_backup_release_mapping_missing" });
    const mapped = runProfileGate({
      intent: "true",
      liveProfile: "customer",
      liveRelease: release,
      releaseMap: JSON.stringify({ [workflowRevision]: release }),
    });
    expect(mapped.status, mapped.stderr).toBe(0);
    expect(mapped.outputs).toMatchObject({ active: "true", release });
  });

  it.each([
    {
      name: "missing intent",
      input: { liveProfile: "demo" },
      status: 1,
      result: "authority_invalid",
      reason: "customer_profile_intent_missing",
      expectedCustomerProfile: null,
      operatorActionRequired: true,
      incident: "comment",
    },
    {
      name: "blank intent",
      input: { intent: "", liveProfile: "demo" },
      status: 1,
      result: "authority_invalid",
      reason: "customer_profile_intent_missing",
      expectedCustomerProfile: null,
      operatorActionRequired: true,
      incident: "create",
    },
    {
      name: "invalid intent",
      input: { intent: "TRUE", liveProfile: "demo" },
      status: 1,
      result: "authority_invalid",
      reason: "customer_profile_intent_invalid",
      expectedCustomerProfile: null,
      operatorActionRequired: true,
      incident: "create",
    },
    {
      name: "explicit inactive demo profile",
      input: { intent: "false", liveProfile: "demo" },
      status: 0,
      result: "not_configured",
      reason: "customer_profile_inactive",
      expectedCustomerProfile: false,
      operatorActionRequired: false,
      liveProfile: "demo",
      liveReleaseRevision: "d".repeat(40),
      releaseRevisionMatchesWorkflow: true,
      incident: "none",
    },
    {
      name: "explicit active exact customer release",
      input: { intent: "true", liveProfile: "customer" },
      status: 0,
      result: "eligible",
      reason: "live_customer_profile_verified",
      expectedCustomerProfile: true,
      operatorActionRequired: false,
      liveProfile: "customer",
      liveReleaseRevision: "d".repeat(40),
      releaseRevisionMatchesWorkflow: true,
      incident: "close",
    },
    {
      name: "release mismatch",
      input: { intent: "true", liveProfile: "customer", liveRelease: "e".repeat(40) },
      status: 1,
      result: "operator_action_required",
      reason: "customer_backup_release_revision_mismatch",
      expectedCustomerProfile: true,
      operatorActionRequired: true,
      liveProfile: "customer",
      liveReleaseRevision: "e".repeat(40),
      releaseRevisionMatchesWorkflow: false,
      incident: "create",
    },
    {
      name: "missing live release authority",
      input: { intent: "true", runtimeJson: JSON.stringify({ deploymentProfile: "customer" }) },
      status: 1,
      result: "authority_unavailable",
      reason: "customer_backup_live_runtime_invalid",
      expectedCustomerProfile: true,
      operatorActionRequired: true,
      liveProfile: "customer",
      liveReleaseRevision: "unknown",
      releaseRevisionMatchesWorkflow: false,
      incident: "create",
    },
    {
      name: "invalid live release authority",
      input: { intent: "true", liveProfile: "customer", liveRelease: "not-a-revision" },
      status: 1,
      result: "authority_unavailable",
      reason: "customer_backup_live_runtime_invalid",
      expectedCustomerProfile: true,
      operatorActionRequired: true,
      liveProfile: "customer",
      liveReleaseRevision: "unknown",
      releaseRevisionMatchesWorkflow: false,
      incident: "create",
    },
    {
      name: "active intent with noncustomer drift",
      input: { intent: "true", liveProfile: "demo" },
      status: 1,
      result: "operator_action_required",
      reason: "customer_backup_profile_authority_mismatch",
      expectedCustomerProfile: true,
      operatorActionRequired: true,
      liveProfile: "demo",
      liveReleaseRevision: "d".repeat(40),
      releaseRevisionMatchesWorkflow: true,
      incident: "create",
    },
    {
      name: "inactive intent with customer drift",
      input: { intent: "false", liveProfile: "customer" },
      status: 1,
      result: "operator_action_required",
      reason: "customer_backup_profile_authority_mismatch",
      expectedCustomerProfile: false,
      operatorActionRequired: true,
      liveProfile: "customer",
      liveReleaseRevision: "d".repeat(40),
      releaseRevisionMatchesWorkflow: true,
      incident: "create",
    },
    {
      name: "missing Fly token",
      input: { intent: "true", flyToken: "", liveProfile: "customer" },
      status: 1,
      result: "authority_unavailable",
      reason: "customer_backup_fly_token_missing",
      expectedCustomerProfile: true,
      operatorActionRequired: true,
      incident: "create",
    },
    {
      name: "wrong app scope",
      input: { intent: "true", visibleApps: ["another-app"], liveProfile: "customer" },
      status: 1,
      result: "authority_unavailable",
      reason: "customer_backup_token_not_app_scoped",
      expectedCustomerProfile: true,
      operatorActionRequired: true,
      incident: "create",
    },
    {
      name: "unavailable app-scope authority",
      input: { intent: "true", appsAvailable: false },
      status: 1,
      result: "authority_unavailable",
      reason: "customer_backup_token_scope_unavailable",
      expectedCustomerProfile: true,
      operatorActionRequired: true,
      incident: "create",
    },
    {
      name: "invalid app-scope authority",
      input: { intent: "true", appsJson: "not-json" },
      status: 1,
      result: "authority_unavailable",
      reason: "customer_backup_token_not_app_scoped",
      expectedCustomerProfile: true,
      operatorActionRequired: true,
      incident: "create",
    },
    {
      name: "multi-app scope",
      input: {
        intent: "true",
        visibleApps: ["mendpoint-customer", "another-app"],
        liveProfile: "customer",
      },
      status: 1,
      result: "authority_unavailable",
      reason: "customer_backup_token_not_app_scoped",
      expectedCustomerProfile: true,
      operatorActionRequired: true,
      incident: "create",
    },
    {
      name: "invalid runtime",
      input: { intent: "true", runtimeJson: "not-json" },
      status: 1,
      result: "authority_unavailable",
      reason: "customer_backup_live_runtime_invalid",
      expectedCustomerProfile: true,
      operatorActionRequired: true,
      incident: "create",
    },
    {
      name: "missing live profile authority",
      input: {
        intent: "true",
        runtimeJson: JSON.stringify({ releaseRevision: "d".repeat(40) }),
      },
      status: 1,
      result: "authority_unavailable",
      reason: "customer_backup_live_runtime_invalid",
      expectedCustomerProfile: true,
      operatorActionRequired: true,
      incident: "create",
    },
    {
      name: "unavailable runtime",
      input: { intent: "true", runtimeAvailable: false },
      status: 1,
      result: "authority_unavailable",
      reason: "customer_backup_live_runtime_unavailable",
      expectedCustomerProfile: true,
      operatorActionRequired: true,
      incident: "create",
    },
    {
      name: "unavailable app status",
      input: { intent: "true", statusAvailable: false },
      status: 1,
      result: "authority_unavailable",
      reason: "customer_backup_live_runtime_unavailable",
      expectedCustomerProfile: true,
      operatorActionRequired: true,
      incident: "create",
    },
    {
      name: "invalid live profile",
      input: { intent: "true", liveProfile: "staging" },
      status: 1,
      result: "authority_invalid",
      reason: "customer_backup_live_profile_invalid",
      expectedCustomerProfile: true,
      operatorActionRequired: true,
      liveProfile: "staging",
      liveReleaseRevision: "d".repeat(40),
      releaseRevisionMatchesWorkflow: true,
      incident: "create",
    },
    {
      name: "invalid workflow revision",
      input: { intent: "true", workflowRevision: "not-a-revision" },
      status: 1,
      result: "authority_invalid",
      reason: "customer_backup_workflow_revision_invalid",
      expectedCustomerProfile: true,
      operatorActionRequired: true,
      incident: "create",
    },
    {
      name: "invalid app binding",
      input: { intent: "true", customerApp: "INVALID_APP" },
      status: 1,
      result: "authority_unavailable",
      reason: "customer_backup_app_binding_invalid",
      expectedCustomerProfile: true,
      operatorActionRequired: true,
      incident: "create",
    },
  ])("executes the profile and incident controls for $name", (testCase) => {
    const gate = runProfileGate(testCase.input);
    expect(gate.status, gate.stderr).toBe(testCase.status);
    expect(gate.outputs).toMatchObject({
      active: testCase.result === "eligible" ? "true" : "false",
      result: testCase.result,
    });
    expect(gate.evidence).toMatchObject({
      app: testCase.input.customerApp ?? "mendpoint-customer",
      workflowRevision: testCase.input.workflowRevision ?? "d".repeat(40),
      liveProfile: testCase.liveProfile ?? "unknown",
      liveReleaseRevision: testCase.liveReleaseRevision ?? "unknown",
      releaseRevisionMatchesWorkflow: testCase.releaseRevisionMatchesWorkflow ?? false,
      result: testCase.result,
      reason: testCase.reason,
      expectedCustomerProfile: testCase.expectedCustomerProfile,
      operatorActionRequired: testCase.operatorActionRequired,
      backupTaken: false,
    });

    const existingIssue = testCase.incident === "comment" || testCase.incident === "close"
      ? "42"
      : undefined;
    const incident = runIncident({
      profileJobResult: testCase.status === 0 ? "success" : "failure",
      profileAuthorityResult: gate.outputs.result!,
      profileActive: gate.outputs.active!,
      backupJobResult: testCase.result === "eligible" ? "success" : "skipped",
      existingIssue,
    });
    expect(incident.status, incident.stderr).toBe(0);
    if (testCase.incident === "none") {
      expect(incident.commands).toEqual([]);
    } else if (testCase.incident === "comment") {
      expect(called(incident.commands, "issue", "comment", "42")).toBe(true);
      expect(called(incident.commands, "issue", "create")).toBe(false);
      expect(called(incident.commands, "issue", "close")).toBe(false);
    } else if (testCase.incident === "close") {
      expect(called(incident.commands, "issue", "close", "42")).toBe(true);
      expect(called(incident.commands, "issue", "create")).toBe(false);
      expect(called(incident.commands, "issue", "comment")).toBe(false);
    } else {
      expect(called(incident.commands, "issue", "create")).toBe(true);
      expect(called(incident.commands, "issue", "comment")).toBe(false);
      expect(called(incident.commands, "issue", "close")).toBe(false);
    }
  });

  it("opens an incident when eligible backup execution or verification fails", () => {
    const incident = runIncident({
      profileJobResult: "success",
      profileAuthorityResult: "eligible",
      profileActive: "true",
      backupJobResult: "failure",
    });
    expect(incident.status, incident.stderr).toBe(0);
    expect(called(incident.commands, "issue", "create")).toBe(true);
    expect(called(incident.commands, "issue", "close")).toBe(false);
  });

  it("closes the incident only after eligible authority and authenticated backup success", () => {
    const incident = runIncident({
      profileJobResult: "success",
      profileAuthorityResult: "eligible",
      profileActive: "true",
      backupJobResult: "success",
      existingIssue: "42",
    });
    expect(incident.status, incident.stderr).toBe(0);
    expect(called(incident.commands, "issue", "close", "42")).toBe(true);
    expect(called(incident.commands, "issue", "create")).toBe(false);
    expect(called(incident.commands, "issue", "comment")).toBe(false);
  });

  it("opens an incident for unexpected or skipped dependency state", () => {
    const incident = runIncident({
      profileJobResult: "skipped",
      profileAuthorityResult: "",
      profileActive: "",
      backupJobResult: "skipped",
    });
    expect(incident.status, incident.stderr).toBe(0);
    expect(called(incident.commands, "issue", "create")).toBe(true);
    expect(called(incident.commands, "issue", "close")).toBe(false);
  });

  it("keeps the backup producer fail closed outside the customer profile", () => {
    expect(() => customerBackupInputFromEnv({
      MENDPOINT_DEPLOYMENT_PROFILE: "demo",
    })).toThrow("customer_backup_profile_required");
  });
});
