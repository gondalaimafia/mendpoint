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
    expect(source).toContain("fly.transformer.toml");
    expect(source).toContain("eval:agents:live");
    expect(source).toContain("--product=transformer");
    expect(source).toContain("regauge:production:proof");
    expect(source).toContain("live-model.json");
    expect(source).toContain("draft-canary.json");
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
    expect(deploy.if).toBe("${{ inputs.phase == 'activate' }}");
    expect(source).toContain("flyctl auth whoami");
    expect(source).toContain("flyctl orgs list --json");
    expect(source).toContain("flyctl status --app mendpoint-transformer-pilot --json");
    expect(source).toContain("regauge-fly-preflight-${{ github.sha }}");
    expect(preflightRun).not.toMatch(/flyctl (?:apps create|deploy|scale|secrets set|volumes create)/);
  });

  it("provisions private Tigris storage directly on the dedicated app", () => {
    const source = readFileSync(".github/workflows/regauge-production.yml", "utf8");
    const workflow = parse(source) as Record<string, any>;
    const deploy = workflow.jobs.deploy;
    const storage = deploy.steps.find(
      (step: Record<string, unknown>) => step.name === "Provision private checkpoint storage",
    );
    expect(storage).toBeDefined();
    expect(storage.run).toContain("flyctl storage status --app mendpoint-transformer-pilot");
    expect(storage.run).toContain("flyctl storage create");
    expect(storage.run).toContain("--app mendpoint-transformer-pilot");
    expect(storage.run).toContain("--org \"$FLY_ORG\"");
    expect(storage.run).toContain("--yes");
    expect(storage.run).not.toContain("--public");
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
    expect(authority).toContain("${MENDPOINT_REGAUGE_CAMPAIGN_ID}");
    expect(authority).toContain("${MENDPOINT_REGAUGE_CANARY_REPOSITORY_ID}");
    expect(authority).toContain("draft:1");
    expect(authority).toContain("serializePilotTransformerGateConfig");
    expect(authority).toContain("MENDPOINT_REGAUGE_PRODUCTION_APPROVAL_REF=");
    expect(authority).toContain("MENDPOINT_REGAUGE_GATE=");
    expect(authority).toContain("MENDPOINT_REGAUGE_EVIDENCE_REFS=");
    expect(authority).toContain("date -u -d '+70 minutes'");
    expect(authority).toContain("MENDPOINT_REGAUGE_ACTIVATION_EXPIRES_AT=");
    const firstEnvironmentWrite = authority.indexOf('>> "$GITHUB_ENV"');
    for (const name of [
      "MENDPOINT_REGAUGE_TENANT_ID",
      "MENDPOINT_REGAUGE_CAMPAIGN_ID",
      "MENDPOINT_REGAUGE_CANARY_REPOSITORY_ID",
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
  });

  it("contains the delivery worker after every activation outcome", () => {
    const workflow = parse(
      readFileSync(".github/workflows/regauge-production.yml", "utf8"),
    ) as Record<string, any>;
    const steps = workflow.jobs.deploy.steps as Record<string, any>[];
    const containment = steps.find(
      (step) => step.name === "Contain one-draft activation",
    );
    const uploadIndex = steps.findIndex(
      (step) => step.name === "Upload Regauge production evidence",
    );
    const containmentIndex = steps.indexOf(containment);

    expect(containment).toBeDefined();
    expect(containment.if).toBe("${{ always() }}");
    expect(containment.run).toContain("flyctl scale count coordinator=1 worker=0");
    expect(containment.run).toContain("containment.json");
    expect(containmentIndex).toBeGreaterThan(-1);
    expect(uploadIndex).toBeGreaterThan(containmentIndex);
  });

  it("keeps the readiness soak within the protected activation window", () => {
    const workflow = parse(
      readFileSync(".github/workflows/regauge-production.yml", "utf8"),
    ) as Record<string, any>;
    const validation = (workflow.jobs.deploy.steps as Record<string, any>[]).find(
      (step) => step.name === "Validate exact authority before mutation",
    ).run as string;

    expect(workflow.jobs.deploy["timeout-minutes"]).toBe(60);
    expect(validation).toContain('test "$READINESS_SOAK_SECONDS" -le 1800');
    expect(validation).not.toContain('test "$READINESS_SOAK_SECONDS" -le 21600');
  });
});
