import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeChange } from "@mendpoint/change-intel";
import { planFromSpecDiff, planProgress, planToMarkdown } from "./index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("spec-first plan", () => {
  it("builds plan-of-record from OpenAPI surfaces", () => {
    const v1 = JSON.parse(
      readFileSync(join(root, "fixtures/providers/acme-payments/openapi-v1.json"), "utf8"),
    );
    const v2 = JSON.parse(
      readFileSync(join(root, "fixtures/providers/acme-payments/openapi-v2.json"), "utf8"),
    );
    const { diff, surfaces } = normalizeChange(v1, v2, { providerSlug: "acme-payments" });
    const plan = planFromSpecDiff({
      providerSlug: "acme-payments",
      providerName: "Acme",
      fromVersion: "v1",
      toVersion: "v2",
      diff,
      surfaces,
    });
    expect(plan.kind).toBe("spec_diff");
    expect(plan.agent).toBe("warden");
    expect(plan.steps.length).toBeGreaterThan(2);
    expect(plan.steps[0]!.action).toBe("spec.lock_diff");
    expect(planToMarkdown(plan)).toContain("Plan:");
    const prog = planProgress(plan);
    expect(prog.pending).toBe(prog.total);
  });
});
