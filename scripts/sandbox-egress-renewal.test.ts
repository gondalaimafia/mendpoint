import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { pagingEventForEgressReceipt } from "@mendpoint/notify";
import { resolveAlertLeadMs, resolveReceiptExpiry } from "./check-sandbox-egress-freshness.js";

const root = resolve(import.meta.dirname, "..");
const ENGINE_PATH = ".github/workflows/sandbox-egress-acceptance.yml";
const RENEWAL_PATH = ".github/workflows/sandbox-egress-renewal.yml";

function engineSource(): string {
  return readFileSync(resolve(root, ENGINE_PATH), "utf8");
}
function engine(): Record<string, any> {
  return parse(engineSource()) as Record<string, any>;
}
function renewalSource(): string {
  return readFileSync(resolve(root, RENEWAL_PATH), "utf8");
}
function renewal(): Record<string, any> {
  return parse(renewalSource()) as Record<string, any>;
}
function step(workflow: Record<string, any>, job: string, name: string): Record<string, any> {
  const found = (workflow.jobs[job].steps as Record<string, any>[]).find((s) => s.name === name);
  if (!found) throw new Error(`step not found: ${name}`);
  return found;
}

describe("sandbox egress receipt renewal caller", () => {
  it("renews on a schedule without depending on someone remembering", () => {
    const workflow = renewal();
    const on = workflow.on;
    expect(on).toBeDefined();
    expect(on).toHaveProperty("schedule");
    expect(on.schedule).toEqual([{ cron: "0 */6 * * *" }]);
    expect(on).toHaveProperty("workflow_dispatch");
    expect(on).not.toHaveProperty("push");
    expect(on).not.toHaveProperty("pull_request");
    expect(on).not.toHaveProperty("pull_request_target");
  });

  it("keeps the required-reviewer environment and confirmation on the manual path", () => {
    const workflow = renewal();
    const manual = workflow.jobs.manual;
    expect(manual.if).toContain("workflow_dispatch");
    expect(manual.uses).toBe("./.github/workflows/sandbox-egress-acceptance.yml");
    expect(manual.with.environment).toBe("sandbox-production");
    expect(manual.with.require_confirmation).toBe(true);
    expect(manual.with.confirmation).toBe("${{ inputs.confirmation }}");
    // The manual dispatch still forces a human-typed confirmation string.
    expect(workflow.on.workflow_dispatch.inputs.confirmation.required).toBe(true);
  });

  it("runs the scheduled mint under a deployment-branch restricted environment, no reviewer prompt", () => {
    const workflow = renewal();
    const scheduled = workflow.jobs.scheduled;
    expect(scheduled.if).toContain("schedule");
    expect(scheduled.uses).toBe("./.github/workflows/sandbox-egress-acceptance.yml");
    // A DISTINCT environment from the manual one: it carries the deployment-branch
    // rule (default branch only) instead of a required reviewer, so the schedule
    // runs unattended while a pushed branch still cannot mint.
    expect(scheduled.with.environment).toBe("sandbox-production-renewal");
    expect(scheduled.with.environment).not.toBe("sandbox-production");
    expect(scheduled.with.require_confirmation).toBe(false);
  });
});

describe("sandbox egress engine — the mint is gated on the probe", () => {
  it("signs the receipt only AFTER the containment probe, with no failure bypass", () => {
    const workflow = engine();
    const steps = workflow.jobs.accept.steps as Record<string, any>[];
    const probeIndex = steps.findIndex((s) => s.name === "Prove default deny and local execution");
    const mintIndex = steps.findIndex((s) => s.name === "Sign and verify the acceptance receipt");
    const rotateIndex = steps.findIndex(
      (s) => s.name === "Rotate the egress authority to every consuming app",
    );
    expect(probeIndex).toBeGreaterThan(-1);
    expect(mintIndex).toBeGreaterThan(probeIndex);
    expect(rotateIndex).toBeGreaterThan(mintIndex);
    // If the probe fails, the job aborts before the mint. Any `if: always()` or
    // `continue-on-error` on these steps would let a receipt be minted without a
    // passing probe -- the exact thing that must never happen. Delete this
    // guarantee (add such an override) and this test fails.
    for (const idx of [probeIndex, mintIndex, rotateIndex]) {
      expect(steps[idx].if).toBeUndefined();
      expect(steps[idx]["continue-on-error"]).toBeUndefined();
    }
    // The probe keeps its exact-match, fail-closed assertions (not weakened).
    const probe = steps[probeIndex].run as string;
    expect(probe).toContain('.stdout == "mendpoint-egress-blocked\\n"');
    expect(probe).toContain('.stdout == "mendpoint-egress-allowed\\n"');
    expect(probe).toContain("SANDBOX_EGRESS_FORBIDDEN_PROBE_COMMAND");
  });

  it("requires the confirmation string on the manual path but not the automated path", () => {
    const validate = step(engine(), "accept", "Validate protected authority").run as string;
    expect(validate).toContain('if [ "$REQUIRE_CONFIRMATION" = "true" ]');
    expect(validate).toContain('test "$CONFIRMATION" = "SANDBOX_EGRESS_ACCEPTED"');
    // The automated path substitutes a trusted-ref assertion for the human string.
    expect(validate).toContain('test "$GITHUB_REF" = "refs/heads/$DEFAULT_BRANCH"');
  });

  it("guarantees the failure-alarm path exists so a failed renewal cannot be silent", () => {
    const validate = step(engine(), "accept", "Validate protected authority").run as string;
    // The alarm is now a GitHub issue opened in this repo, so the pre-mint gate
    // asserts -- against the checked-out engine -- that the alert path exists and
    // cannot silently no-op: the accept job holds issues:write and the
    // failure-guarded alert step is present. Remove either and the mint refuses.
    expect(validate).toContain('grep -q "issues: write" "$engine"');
    // Anchored to a real step line so the assertion cannot match its own source
    // text: an unanchored grep for the step name matches the grep command itself
    // and keeps passing after the alert step is gone. Also free of a literal
    // expression delimiter, which GitHub evaluates inside run: blocks where
    // failure() is not a valid function.
    expect(validate).toContain("grep -qE '^      - name: Alert on renewal failure$' \"$engine\"");
    expect(validate).toContain("grep -qE 'failure\\(\\)'");
  });
});

describe("sandbox egress engine — rotation reaches every configured app", () => {
  it("enumerates targets from configuration and loops, never a single hardcoded app", () => {
    const rotate = step(
      engine(),
      "accept",
      "Rotate the egress authority to every consuming app",
    ).run as string;
    expect(rotate).toContain("flyctl apps list --json");
    expect(rotate).toContain("resolveSandboxEgressRotationTargets");
    expect(rotate).toContain("parseFlyAppListing");
    // Iterates every resolved target rather than a single app.
    expect(rotate).toContain('while IFS= read -r app');
    expect(rotate).toContain('flyctl machine list --app "$app" --json');
    expect(rotate).toContain('flyctl secrets set --stage --app "$app"');
    expect(rotate).toContain('flyctl machine update "$machine_id" --app "$app"');
    expect(rotate).toContain('--image "$machine_image"');
    expect(rotate).toContain('--env "MENDPOINT_SANDBOX_FLY_IMAGE=$MENDPOINT_SANDBOX_EGRESS_IMAGE"');
    expect(rotate).toContain("--metadata fly_platform_version=v2");
    expect(rotate).toContain('flyctl secrets deploy --app "$app"');
    expect(rotate).toContain('flyctl secrets list --app "$app" --json');
    expect(rotate).toContain('all(.[]; .status == "Deployed")');
    expect(rotate).toContain("length > 0 and all(.[]; .state == \"started\"");
    // The old single-app rotation is gone.
    expect(rotate).not.toContain('flyctl secrets set --stage --app "$SANDBOX_VERIFYING_APP"');
    // Health is verified per app, not once.
    expect(rotate).toContain('"https://${app}.fly.dev/livez"');
    expect(rotate).toContain('"https://${app}.fly.dev/healthz"');
  });
});

describe("sandbox egress engine — failure visibility before expiry", () => {
  it("prepares the failure reporter and a diagnostic artifact before authority validation", () => {
    const workflow = engine();
    const steps = workflow.jobs.accept.steps as Record<string, any>[];
    const prepareIndex = steps.findIndex(
      (candidate) => candidate.name === "Prepare renewal diagnostics and runtime",
    );
    const validateIndex = steps.findIndex(
      (candidate) => candidate.name === "Validate protected authority",
    );
    const uploadIndex = steps.findIndex(
      (candidate) => candidate.name === "Upload sandbox acceptance evidence",
    );
    const pageIndex = steps.findIndex(
      (candidate) => candidate.name === "Alert on renewal failure",
    );

    expect(prepareIndex).toBeGreaterThan(-1);
    expect(prepareIndex).toBeLessThan(validateIndex);
    expect(uploadIndex).toBeGreaterThan(validateIndex);
    expect(pageIndex).toBeGreaterThan(validateIndex);

    const prepare = steps[prepareIndex].run as string;
    expect(prepare).toContain("npm ci");
    expect(prepare).toContain("test-results/sandbox-egress/renewal-context.txt");
    expect(steps[uploadIndex].if).toBe("always()");
  });

  it("self-checks the freshly minted receipt's margin", () => {
    const workflow = engine();
    const steps = workflow.jobs.accept.steps as Record<string, any>[];
    const freshness = steps.find((s) => s.name === "Confirm the renewed receipt has healthy margin");
    expect(freshness).toBeDefined();
    expect(freshness!.run).toContain("check-sandbox-egress-freshness.ts");
  });

  it("opens a GitHub issue on any renewal failure, needing no external paging secret", () => {
    const workflow = engine();
    // The accept job must actually hold issues:write, or the alert step 403s.
    expect(workflow.jobs.accept.permissions).toMatchObject({ issues: "write" });
    const page = step(workflow, "accept", "Alert on renewal failure");
    expect(page.if).toBe("${{ failure() }}");
    expect(page.run).toContain("gh issue create");
    expect(page.run).toContain("sandbox-egress-renewal-failure");
    // No external paging secret: the old notify-based renewal page is gone.
    expect(page.run).not.toContain("pageEgressReceiptRenewalFailed");
  });

  it("auto-closes the renewal-failure alert once a renewal succeeds", () => {
    const resolve = step(engine(), "accept", "Resolve the renewal-failure alert on success");
    expect(resolve.if).toBe("${{ success() }}");
    expect(resolve.run).toContain("gh issue close");
    expect(resolve.run).toContain("sandbox-egress-renewal-failure");
  });
});

describe("egress receipt freshness — surfaced before expiry", () => {
  const HOUR = 60 * 60 * 1000;

  it("raises the alarm while the receipt is still valid, not only after it lapses", () => {
    // now is before expiry but inside the lead window: this is the load-bearing
    // "before expiry rather than after" behavior. Covered here so the named gate
    // (packages/platform packages/ops scripts) exercises it directly.
    const beforeExpiry = pagingEventForEgressReceipt({
      expiresAt: "2026-08-22T12:00:00.000Z",
      now: "2026-08-22T11:30:00.000Z",
      leadMs: HOUR,
    });
    expect(beforeExpiry).not.toBeNull();
    expect(beforeExpiry?.details).toMatchObject({ lapsed: false });
    // Healthy margin stays silent.
    const healthy = pagingEventForEgressReceipt({
      expiresAt: "2026-08-22T12:00:00.000Z",
      now: "2026-08-22T04:00:00.000Z",
      leadMs: HOUR,
    });
    expect(healthy).toBeNull();
  });

  it("resolves the receipt expiry from an explicit env or the attestation payload", () => {
    expect(
      resolveReceiptExpiry({ MENDPOINT_SANDBOX_EGRESS_EXPIRES_AT: "2026-08-22T12:00:00.000Z" }),
    ).toBe("2026-08-22T12:00:00.000Z");
    expect(resolveReceiptExpiry({})).toBe("");
    expect(resolveAlertLeadMs({})).toBeGreaterThan(0);
    expect(resolveAlertLeadMs({ MENDPOINT_SANDBOX_EGRESS_ALERT_LEAD_MS: "3600000" })).toBe(3600000);
  });
});
