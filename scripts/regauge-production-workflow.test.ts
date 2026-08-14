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
});
