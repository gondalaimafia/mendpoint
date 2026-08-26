import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { customerBackupInputFromEnv } from "@mendpoint/ops";
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
    expect(validate.run).toContain('apps_json="$(flyctl apps list --json)"');
    expect(validate.run).toContain("'[.[] | (.Name // .name)] | unique'");
    expect(validate.run).not.toContain("mapfile -t visible_apps < <(");
    expect(validate.run).not.toContain(".[].Name");
    expect(validate.run).toContain("customer_backup_token_not_app_scoped");
    expect(validate.run).toContain('flyctl status --app "$CUSTOMER_APP"');
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
    expect(run.run).toContain("MENDPOINT_EXPECTED_BACKUP_RELEASE_REVISION=$GITHUB_SHA");
    expect(run.run).toContain("scripts/customer-backup.ts");
    expect(run.run).toContain('tee -a "$evidence"');
    expect(run.run).toContain('bash scripts/verify-customer-backup-result.sh "$evidence" "$GITHUB_SHA"');
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
    const gateStep = (gate.steps as Record<string, any>[]).find(
      (candidate) => candidate.id === "check",
    ) as Record<string, any>;
    expect(gateStep.env.EXPECTED_ACTIVE).toBe("${{ vars.MENDPOINT_CUSTOMER_PROFILE_ACTIVE }}");
    expect(gateStep.env.FLY_API_TOKEN).toBe("${{ secrets.MENDPOINT_CUSTOMER_BACKUP_FLY_TOKEN }}");
    expect(gateStep.env.CUSTOMER_APP).toBe("${{ vars.MENDPOINT_CUSTOMER_FLY_APP }}");
    expect(gateStep.run).toContain('apps_json="$(flyctl apps list --json)"');
    expect(gateStep.run).toContain("'[.[] | (.Name // .name)] | unique'");
    expect(gateStep.run).not.toContain("mapfile -t visible_apps < <(");
    expect(gateStep.run).toContain('flyctl ssh console --app "$CUSTOMER_APP"');
    expect(gateStep.run).toContain("MENDPOINT_DEPLOYMENT_PROFILE");
    expect(gateStep.run).toContain("MENDPOINT_RELEASE_REVISION");
    expect(gateStep.run).toContain('live_release_revision="$(');
    expect(gateStep.run).toContain('[ "$live_release_revision" != "$GITHUB_SHA" ]');
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

  it("keeps the backup producer fail closed outside the customer profile", () => {
    expect(() => customerBackupInputFromEnv({
      MENDPOINT_DEPLOYMENT_PROFILE: "demo",
    })).toThrow("customer_backup_profile_required");
  });
});
