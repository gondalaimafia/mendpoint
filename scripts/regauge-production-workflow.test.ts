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
});
