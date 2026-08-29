import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("Regauge production workflow", () => {
  it("is manual, protected, draft only, and retains every production proof", () => {
    const path = ".github/workflows/regauge-production.yml";
    expect(existsSync(path)).toBe(true);
    const source = readFileSync(path, "utf8");
    const workflow = parse(source) as Record<string, any>;
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.on).not.toHaveProperty("push");
    expect(workflow.jobs.deploy.environment).toBe("regauge-production");
    expect(source).toContain("REGAUGE_DRAFT_ONLY");
    expect(source).toContain("REGAUGE_CANARY_OWNER");
    expect(source).toContain("REGAUGE_CANARY_REPOSITORY");
    expect(source).toContain("fly.regauge.toml");
    expect(source).toContain("eval:agents:live");
    expect(source).toContain("--product=transformer");
    expect(source).toContain("regauge:production:proof");
    expect(source).toContain("live-model.json");
    expect(source).toContain("draft-canary.json");
    expect(source).toContain("verifier-evidence.json");
    expect(source).toContain("--mode=verifier-evidence");
    expect(source).toContain("readiness-soak.json");
    expect(source).not.toContain("pull_request_target");
  });

  it("can prove Fly authority read only before the protected activation job", () => {
    const source = readFileSync(".github/workflows/regauge-production.yml", "utf8");
    const workflow = parse(source) as Record<string, any>;
    const dispatch = workflow.on.workflow_dispatch.inputs;
    const preflight = workflow.jobs.preflight;
    const deploy = workflow.jobs.deploy;
    const preflightRun = preflight.steps.find(
      (step: Record<string, unknown>) => step.name === "Prove Fly authority without mutation",
    ).run as string;

    expect(dispatch.phase).toMatchObject({
      type: "choice",
      default: "preflight",
      options: ["preflight", "activate"],
    });
    expect(preflight.environment).toBeUndefined();
    expect(preflight.env.FLY_API_TOKEN).toBe("${{ secrets.FLY_API_TOKEN }}");
    expect(deploy.needs).toBe("preflight");
    expect(deploy.if).toBe("${{ inputs.phase == 'activate' && github.repository == 'gondalaimafia/mendpoint' && github.ref == 'refs/heads/main' }}");
    expect(source).toContain("flyctl auth whoami");
    expect(source).toContain("flyctl orgs list --json");
    expect(source).toContain("flyctl status --app mendpoint-regauge-production --json");
    expect(source).toContain("regauge-fly-preflight-${{ github.sha }}");
    expect(preflightRun).not.toMatch(/flyctl (?:apps create|deploy|scale|secrets set|volumes create)/);
  });

  it("requires pre-provisioned private Tigris storage under the app-scoped deploy token", () => {
    const source = readFileSync(".github/workflows/regauge-production.yml", "utf8");
    const workflow = parse(source) as Record<string, any>;
    const deploy = workflow.jobs.deploy;
    const infrastructure = deploy.steps.find(
      (step: Record<string, unknown>) => step.name === "Verify dedicated app and coordinator volume",
    );
    expect(infrastructure).toBeDefined();
    expect(infrastructure.run).toContain("regauge_fly_app_bootstrap_required");
    expect(infrastructure.run).not.toContain("flyctl apps create");
    expect(infrastructure.run).toContain('.name == "mendpoint_regauge_prod_data"');
    expect(infrastructure.run).not.toContain(".zone ==");
    expect(infrastructure.run).toContain(".encrypted == true");
    expect(infrastructure.run).toContain(".snapshot_retention >= 14");
    expect(infrastructure.run).toContain("length == 1");
    expect(infrastructure.run).toContain("flyctl machines list --app mendpoint-regauge-production --json");
    expect(infrastructure.run).toContain('.config.metadata.fly_process_group == "coordinator"');
    expect(infrastructure.run).toContain("coordinator-volume-machine.json");
    expect(infrastructure.run).toContain("regauge_fly_volume_authority_invalid");
    expect(infrastructure.run).not.toContain("flyctl volumes create");
    expect(infrastructure.run).not.toMatch(/\.name == "mendpoint_transformer_data"/);
    const flyProfile = readFileSync("fly.regauge.toml", "utf8");
    const volumeName = flyProfile.match(/^\s*source = "([a-z0-9_]+)"$/m)?.[1];
    expect(volumeName).toBe("mendpoint_regauge_prod_data");
    expect(volumeName?.length).toBeLessThanOrEqual(30);
    expect(flyProfile).toContain('MENDPOINT_BACKUP_FENCE_ROOT = "/data/db/.backup-fence"');
    expect(flyProfile).toContain('MENDPOINT_BACKUP_TRANSPORT = "rclone_s3"');
    expect(flyProfile).toContain('MENDPOINT_BACKUP_STAGING_ROOT = "/tmp/mendpoint-regauge-transfer"');
    expect(flyProfile).toContain('MENDPOINT_BACKUP_OBJECT_PREFIX = "regauge-state-transfer"');
    const sourceProfile = readFileSync("fly.transformer.toml", "utf8");
    expect(sourceProfile).toContain('MENDPOINT_BACKUP_FENCE_ROOT = "/data/db/.backup-fence"');
    expect(sourceProfile).toContain('MENDPOINT_BACKUP_TRANSPORT = "rclone_s3"');
    expect(sourceProfile).toContain('MENDPOINT_BACKUP_STAGING_ROOT = "/tmp/mendpoint-regauge-transfer"');
    expect(sourceProfile).toContain('MENDPOINT_BACKUP_OBJECT_PREFIX = "regauge-state-transfer"');
    const dockerfile = readFileSync("Dockerfile", "utf8");
    expect(dockerfile).toMatch(/FROM api AS transformer[\s\S]*install -y --no-install-recommends gosu rclone/);
    const storage = deploy.steps.find(
      (step: Record<string, unknown>) => step.name === "Verify private checkpoint storage",
    );
    expect(storage).toBeDefined();
    expect(storage.run).toContain("flyctl secrets list --app mendpoint-regauge-production --json");
    for (const name of [
      "AWS_ENDPOINT_URL_S3",
      "AWS_REGION",
      "BUCKET_NAME",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "MENDPOINT_REGAUGE_TRANSFER_KEY",
      "MENDPOINT_APPLICATION_DATA_KEY",
      "MENDPOINT_REGAUGE_CHECKPOINT_KEY",
    ]) expect(storage.run).toContain(name);
    expect(storage.run).toContain("regauge_storage_bootstrap_required");
    expect(storage.run).not.toContain("flyctl storage status");
    expect(storage.run).not.toContain("flyctl storage create");
    // The five base storage credentials stay unconditional; the three transfer
    // keys are required only when a transfer is configured, and a configured
    // transfer missing any of them still hard-fails with the same message shape.
    const unconditionalLoop = storage.run.match(/for name in ([^\n]*?); do/)?.[1] ?? "";
    for (const name of [
      "AWS_ENDPOINT_URL_S3",
      "AWS_REGION",
      "BUCKET_NAME",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ]) expect(unconditionalLoop).toContain(name);
    for (const name of [
      "MENDPOINT_REGAUGE_TRANSFER_KEY",
      "MENDPOINT_APPLICATION_DATA_KEY",
      "MENDPOINT_REGAUGE_CHECKPOINT_KEY",
    ]) expect(unconditionalLoop).not.toContain(name);
    expect(storage.run).toContain('if [[ -n "${MENDPOINT_REGAUGE_TRANSFER_ID:-}" ]]; then');
    expect(source).not.toContain("secrets.MENDPOINT_REGAUGE_S3_ACCESS_KEY_ID");
    expect(source).not.toContain("secrets.MENDPOINT_REGAUGE_S3_SECRET_ACCESS_KEY");
  });

  it("binds deployment to the exact approved repository revision and independent reviewer", () => {
    const source = readFileSync(".github/workflows/regauge-production.yml", "utf8");
    const workflow = parse(source) as Record<string, any>;
    const env = workflow.jobs.deploy.env;
    expect(env).toMatchObject({
      MENDPOINT_REGAUGE_CANARY_REPOSITORY_ID: "${{ vars.REGAUGE_CANARY_REPOSITORY_ID }}",
      MENDPOINT_REGAUGE_CANARY_DEFAULT_BRANCH: "${{ vars.REGAUGE_CANARY_DEFAULT_BRANCH }}",
      MENDPOINT_REGAUGE_CANARY_BRANCH: "${{ vars.REGAUGE_CANARY_BRANCH }}",
      MENDPOINT_REGAUGE_CANARY_REVISION: "${{ vars.REGAUGE_CANARY_REVISION }}",
      MENDPOINT_REGAUGE_GITHUB_INSTALLATION_ID: "${{ vars.REGAUGE_GITHUB_INSTALLATION_ID }}",
      MENDPOINT_REGAUGE_REVIEWER_ISSUER: "${{ vars.REGAUGE_REVIEWER_ISSUER }}",
      MENDPOINT_REGAUGE_REVIEWER_SUBJECT: "${{ vars.REGAUGE_REVIEWER_SUBJECT }}",
      MENDPOINT_REGAUGE_REVIEWER_DISPLAY_NAME: "${{ vars.REGAUGE_REVIEWER_DISPLAY_NAME }}",
    });
    expect(env).not.toHaveProperty("MENDPOINT_REGAUGE_PRODUCTION_APPROVAL_REF");
    expect(env).not.toHaveProperty("MENDPOINT_REGAUGE_GATE");
    expect(env).not.toHaveProperty("MENDPOINT_REGAUGE_EVIDENCE_REFS");
    expect(source).not.toContain("secrets.MENDPOINT_REGAUGE_PRODUCTION_APPROVAL_REF");
    expect(source).not.toContain("secrets.MENDPOINT_REGAUGE_GATE");
    expect(source).not.toContain("secrets.MENDPOINT_REGAUGE_EVIDENCE_REFS");

    const authority = workflow.jobs.deploy.steps.find(
      (step: Record<string, unknown>) => step.name === "Derive one-run production authority",
    ).run as string;
    expect(authority).toContain("${GITHUB_RUN_ID}");
    expect(authority).toContain("${GITHUB_RUN_ATTEMPT}");
    expect(authority).toContain("${GITHUB_SHA}");
    expect(authority).toContain("revision:${MENDPOINT_REGAUGE_CANARY_REVISION}:draft:1");
    expect(authority).not.toContain("revision:${GITHUB_SHA}:draft:1");
    expect(authority).toContain("${MENDPOINT_REGAUGE_CAMPAIGN_ID}");
    expect(authority).toContain("${MENDPOINT_REGAUGE_CANARY_REPOSITORY_ID}");
    expect(authority).toContain("draft:1");
    expect(authority).toContain("serializePilotTransformerGateConfig");
    expect(authority).toContain("MENDPOINT_REGAUGE_PRODUCTION_APPROVAL_REF=");
    expect(authority).toContain("MENDPOINT_REGAUGE_GATE=");
    expect(authority).toContain("MENDPOINT_REGAUGE_EVIDENCE_REFS=");
    expect(authority).toContain("date -u -d '+70 minutes'");
    expect(authority).toContain("MENDPOINT_REGAUGE_ACTIVATION_EXPIRES_AT=");
    expect(authority).toContain("MENDPOINT_REGAUGE_VERIFIER_CONSENT_EFFECTIVE_AT=2026-08-24T00:00:00.000Z");
    expect(authority).toContain("MENDPOINT_REGAUGE_VERIFIER_CONSENT_EXPIRES_AT=2026-11-20T23:59:59.000Z");
    expect(authority).toContain('repositoryScope: ["gondalaimafia/mendpoint-canary-drill-20260801"]');
    expect(authority).toContain('--arg branch "$MENDPOINT_REGAUGE_CANARY_BRANCH"');
    expect(authority).toContain("branchScope: [$branch]");
    expect(authority).toContain("version: 2");
    expect(authority).not.toContain("repositoryScope: []");
    expect(authority).not.toContain("branchScope: []");
    const generatedRepositoryScope = authority.match(/repositoryScope:\s*(\[[^\n]+\])/);
    expect(JSON.parse(generatedRepositoryScope?.[1] ?? "null"))
      .toEqual(["gondalaimafia/mendpoint-canary-drill-20260801"]);
    const firstEnvironmentWrite = authority.indexOf('>> "$GITHUB_ENV"');
    for (const name of [
      "MENDPOINT_REGAUGE_TENANT_ID",
      "MENDPOINT_REGAUGE_CAMPAIGN_ID",
      "MENDPOINT_REGAUGE_CANARY_REPOSITORY_ID",
      "MENDPOINT_REGAUGE_CANARY_REVISION",
      "GITHUB_SHA",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
    ]) {
      const guard = authority.indexOf(`[[ \"$${name}\" =~`);
      expect(guard, `${name} must be validated before GITHUB_ENV`).toBeGreaterThan(-1);
      expect(guard, `${name} must be validated before GITHUB_ENV`).toBeLessThan(
        firstEnvironmentWrite,
      );
    }

    const stage = workflow.jobs.deploy.steps.find(
      (step: Record<string, unknown>) => step.name === "Stage production secrets",
    ).run as string;
    const validation = workflow.jobs.deploy.steps.find(
      (step: Record<string, unknown>) => step.name === "Validate exact authority before mutation",
    ).run as string;
    expect(validation).toContain('test "$GITHUB_REPOSITORY" = "gondalaimafia/mendpoint"');
    expect(validation).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(validation).toContain("MENDPOINT_APPLICATION_DATA_KEY");
    for (const name of [
      "MENDPOINT_REGAUGE_CANARY_REPOSITORY_ID",
      "MENDPOINT_REGAUGE_CANARY_DEFAULT_BRANCH",
      "MENDPOINT_REGAUGE_CANARY_BRANCH",
      "MENDPOINT_REGAUGE_CANARY_REVISION",
      "MENDPOINT_REGAUGE_GITHUB_INSTALLATION_ID",
      "MENDPOINT_REGAUGE_REVIEWER_ISSUER",
      "MENDPOINT_REGAUGE_REVIEWER_SUBJECT",
      "MENDPOINT_REGAUGE_REVIEWER_DISPLAY_NAME",
      "MENDPOINT_REGAUGE_PRODUCTION_APPROVAL_REF",
      "MENDPOINT_REGAUGE_ACTIVATION_EXPIRES_AT",
    ]) expect(stage).toContain(`${name}=\"$${name}\"`);
    expect(validation).toContain('test "$MENDPOINT_REGAUGE_TENANT_ID" = "tenant_regauge_canary"');
    expect(validation).toContain('test "$MENDPOINT_REGAUGE_CAMPAIGN_ID" = "campaign_regauge_canary_20260814"');
    expect(validation).toContain('test "$MENDPOINT_REGAUGE_CANARY_OWNER" = "gondalaimafia"');
    expect(validation).toContain('test "$MENDPOINT_REGAUGE_CANARY_REPOSITORY" = "mendpoint-canary-drill-20260801"');
    expect(validation).toContain(
      'test "$MENDPOINT_REGAUGE_CANARY_BRANCH" = "codex/regauge-canary-baseline"',
    );
    expect(validation).toContain('.repositoryScope == ["gondalaimafia/mendpoint-canary-drill-20260801"]');
    expect(validation).toContain('.branchScope == [$branch]');
    expect(stage).toContain('MENDPOINT_REGAUGE_S3_PREFIX="transformer/$MENDPOINT_REGAUGE_TENANT_ID/$MENDPOINT_REGAUGE_CAMPAIGN_ID"');
    expect(stage).not.toContain('MENDPOINT_REGAUGE_S3_PREFIX="regauge/');
  });

  it("stages only the bounded DeepSeek advisory verifier authority", () => {
    const source = readFileSync(".github/workflows/regauge-production.yml", "utf8");
    const workflow = parse(source) as Record<string, any>;
    const env = workflow.jobs.deploy.env;
    expect(env).toMatchObject({
      DEEPSEEK_API_KEY: "${{ secrets.DEEPSEEK_API_KEY }}",
      MENDPOINT_APPLICATION_DATA_KEY: "${{ secrets.MENDPOINT_APPLICATION_DATA_KEY }}",
      MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON: "${{ vars.REGAUGE_DEEPSEEK_GOVERNANCE_JSON }}",
      MENDPOINT_AGENT_VERIFIER_PRICING_JSON: "${{ vars.REGAUGE_DEEPSEEK_PRICING_JSON }}",
    });
    const stage = workflow.jobs.deploy.steps.find(
      (step: Record<string, unknown>) => step.name === "Stage production secrets",
    ).run as string;
    for (const binding of [
      'MENDPOINT_APPLICATION_DATA_KEY="$MENDPOINT_APPLICATION_DATA_KEY"',
      "DEEPSEEK_VERIFIER_ENABLED=true",
      "DEEPSEEK_API_KEY=\"$DEEPSEEK_API_KEY\"",
      "MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE=advisory",
      "MENDPOINT_AGENT_VERIFIER_SCORING_MODE=nonthinking_logprobs",
      "MENDPOINT_AGENT_VERIFIER_EVALUATIONS=1",
      "MENDPOINT_AGENT_VERIFIER_PIVOTS=1",
      "MENDPOINT_AGENT_VERIFIER_MAXIMUM_CANDIDATES=1",
      "MENDPOINT_AGENT_VERIFIER_MAXIMUM_COST_USD=0.05",
      "MENDPOINT_AGENT_VERIFIER_TIMEOUT_MS=660000",
      "MENDPOINT_AGENT_VERIFIER_MAXIMUM_RETRIES=0",
      "MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON=\"$MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON\"",
      "MENDPOINT_AGENT_VERIFIER_PRICING_JSON=\"$MENDPOINT_AGENT_VERIFIER_PRICING_JSON\"",
      "MENDPOINT_REGAUGE_VERIFIER_POLICY_ENVELOPE_JSON=\"$MENDPOINT_REGAUGE_VERIFIER_POLICY_ENVELOPE_JSON\"",
      "MENDPOINT_REGAUGE_VERIFIER_CONSENT_EFFECTIVE_AT=\"$MENDPOINT_REGAUGE_VERIFIER_CONSENT_EFFECTIVE_AT\"",
      "MENDPOINT_REGAUGE_VERIFIER_CONSENT_EXPIRES_AT=\"$MENDPOINT_REGAUGE_VERIFIER_CONSENT_EXPIRES_AT\"",
    ]) expect(stage).toContain(binding);
    expect(source).not.toContain('echo "$MENDPOINT_APPLICATION_DATA_KEY"');
    expect(source).not.toContain('printf \'%s\\n\' "$MENDPOINT_APPLICATION_DATA_KEY"');
    expect(stage).not.toContain("MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE=active");
    expect(stage).not.toContain("MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE=shadow");
  });

  it("keeps the verified coordinator and worker continuously active", () => {
    const workflow = parse(
      readFileSync(".github/workflows/regauge-production.yml", "utf8"),
    ) as Record<string, any>;
    const steps = workflow.jobs.deploy.steps as Record<string, any>[];
    const continuous = steps.find(
      (step) => step.name === "Preserve continuous production after activation",
    )!;
    const uploadIndex = steps.findIndex(
      (step) => step.name === "Upload Regauge production evidence",
    );
    const continuousIndex = steps.indexOf(continuous);

    expect(continuous).toBeDefined();
    expect(continuous.if).toBe("${{ success() }}");
    expect(continuous.run).toContain("flyctl machines list --app mendpoint-regauge-production --json");
    expect(continuous.run).toContain("flyctl scale count coordinator=1 worker=1");
    expect(continuous.run).toContain("continuous-production.json");
    expect(continuous.run).not.toContain("worker=0");
    expect(continuousIndex).toBeGreaterThan(-1);
    expect(uploadIndex).toBeGreaterThan(continuousIndex);
  });

  it("deploys and proves the coordinator before starting a dependent worker", () => {
    const workflow = parse(
      readFileSync(".github/workflows/regauge-production.yml", "utf8"),
    ) as Record<string, any>;
    const steps = workflow.jobs.deploy.steps as Record<string, any>[];
    const coordinatorIndex = steps.findIndex(
      (step) => step.name === "Deploy coordinator",
    );
    const coordinatorHealthIndex = steps.findIndex(
      (step) => step.name === "Verify coordinator revision and health",
    );
    const workerIndex = steps.findIndex((step) => step.name === "Deploy worker");

    expect(coordinatorIndex).toBeGreaterThan(-1);
    expect(coordinatorHealthIndex).toBeGreaterThan(coordinatorIndex);
    expect(workerIndex).toBeGreaterThan(coordinatorHealthIndex);
    expect(steps[coordinatorIndex].run).toContain("--process-groups coordinator");
    expect(steps[coordinatorIndex].run).toContain("for attempt in 1 2 3");
    expect(steps[coordinatorIndex].run).toContain('test "$attempt" -lt 3');
    expect(steps[coordinatorIndex].run).toContain("sleep 15");
    expect(steps[coordinatorIndex].run).toContain(
      "insufficient resources to create new machine with existing volume",
    );
    expect(steps[workerIndex].run).toContain("--process-groups worker");
    expect(steps[coordinatorHealthIndex].run).toContain(
      "https://mendpoint-regauge-production.fly.dev/version",
    );
    expect(steps[coordinatorHealthIndex].run).toContain(
      "https://mendpoint-regauge-production.fly.dev/ready",
    );
    expect(
      steps.some((step) => step.name === "Deploy one coordinator and one worker"),
    ).toBe(false);
  });

  it("requires a fresh exact-volume restore attestation before target credentials or processes can start", () => {
    const workflow = parse(
      readFileSync(".github/workflows/regauge-production.yml", "utf8"),
    ) as Record<string, any>;
    const steps = workflow.jobs.deploy.steps as Record<string, any>[];
    const index = (name: string) => steps.findIndex((step) => step.name === name);

    expect(index("Attest exact restored state on target volume")).toBeGreaterThan(-1);
    expect(steps[index("Attest exact restored state on target volume")].if).toBe(
      "${{ vars.REGAUGE_TRANSFER_ID != '' }}",
    );
    expect(index("Stage production secrets")).toBeGreaterThan(
      index("Attest exact restored state on target volume"),
    );
    expect(index("Deploy coordinator")).toBeGreaterThan(index("Stage production secrets"));
    expect(index("Deploy worker")).toBeGreaterThan(index("Deploy coordinator"));
    const receipt = steps[index("Attest exact restored state on target volume")].run as string;
    expect(receipt).toContain("flyctl console --app mendpoint-regauge-production");
    expect(receipt).toContain('--volume "$target_volume_id:/data"');
    expect(receipt).toContain("scripts/regauge-state-transfer.ts attest-restored");
    expect(receipt).toContain('.targetVolume == $target_volume');
    expect(receipt).toContain('.sourceRevision == $revision');
    expect(receipt).toContain('test "$((now_epoch - verified_epoch))" -le 300');
    expect(receipt).toContain("restored-state-receipt.json");
    expect(receipt).not.toContain("MENDPOINT_REGAUGE_TRANSFER_KEY=");
    const failure = steps.find((step) => step.name === "Contain target after activation failure")!;
    expect(failure.if).toBe("${{ failure() }}");
    expect(failure.run).toContain("flyctl machines list --app mendpoint-regauge-production --json");
    expect(failure.run).toContain('flyctl machine stop "$machine_id"');
    expect(failure.run).toContain('test "$remaining_started_workers" = "0"');
    expect(failure.run).toContain("failure-containment.json");
    expect(failure.run).not.toContain("flyctl scale count worker=0");
    expect(failure.run).not.toContain("volumes delete");
    // Transfer authority is enforced only when a transfer is configured, but a
    // partial transfer config (id set, key or fence missing) still hard-fails.
    const validation = steps.find(
      (step) => step.name === "Validate exact authority before mutation",
    )!.run as string;
    expect(validation).not.toMatch(/required=\([^)]*MENDPOINT_REGAUGE_TRANSFER_ID/);
    expect(validation).toContain('if [[ -n "${MENDPOINT_REGAUGE_TRANSFER_ID:-}" ]]; then');
    expect(validation).toContain("MENDPOINT_REGAUGE_TRANSFER_KEY_ID");
    expect(validation).toContain("MENDPOINT_REGAUGE_TRANSFER_FENCE_ID");
    expect(steps.some((step) => (step.run as string | undefined)?.includes(
      "flyctl scale count coordinator=0 worker=0 --app mendpoint-transformer-pilot",
    ))).toBe(false);
  });

  it("bounds every public deployment health request", () => {
    const workflow = parse(
      readFileSync(".github/workflows/regauge-production.yml", "utf8"),
    ) as Record<string, any>;
    const steps = workflow.jobs.deploy.steps as Record<string, any>[];

    for (const name of [
      "Verify coordinator revision and health",
      "Verify exact deployed revision and process health",
    ]) {
      const run = steps.find((step) => step.name === name)?.run as string;
      expect(run).toBeDefined();
      expect(run.match(/curl --fail --silent --max-time 10/g)).toHaveLength(2);
    }
  });

  it("keeps the readiness soak within the protected activation window", () => {
    const workflow = parse(
      readFileSync(".github/workflows/regauge-production.yml", "utf8"),
    ) as Record<string, any>;
    const validation = (workflow.jobs.deploy.steps as Record<string, any>[]).find(
      (step) => step.name === "Validate exact authority before mutation",
    )!.run as string;

    expect(workflow.jobs.deploy["timeout-minutes"]).toBe(60);
    expect(validation).toContain('test "$READINESS_SOAK_SECONDS" -le 1800');
    expect(validation).not.toContain('test "$READINESS_SOAK_SECONDS" -le 21600');
  });

  it("retains workflow context even when activation fails before deployment", () => {
    const workflow = parse(
      readFileSync(".github/workflows/regauge-production.yml", "utf8"),
    ) as Record<string, any>;
    const steps = workflow.jobs.deploy.steps as Record<string, any>[];
    const validation = steps.find(
      (step) => step.name === "Validate exact authority before mutation",
    )!.run as string;
    const upload = steps.find(
      (step) => step.name === "Upload Regauge production evidence",
    )!;

    expect(validation).toContain("workflow-context.json");
    expect(validation).toContain('revision: $revision');
    expect(upload.if).toBe("always()");
    expect(upload.with["if-no-files-found"]).toBe("error");
  });
});
