import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPlatform, planFromOpenApiPair } from "./index.js";
import { wardenSpecDiffStub } from "./specialists/warden-stub.js";
import { transformerCampaignStub } from "./specialists/transformer-stub.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("platform SDK", () => {
  it("exposes graph_query plan execute record_outcome", () => {
    const p = createPlatform({ tenantId: "sdk-test" });
    const stats = p.graphQuery({ op: "stats" });
    expect(stats.summary).toBeTruthy();
    expect(p.plannerContext("warden")).toMatch(/Idempotency|Knowledge|style/i);
  });

  it("warden stub plans from acme openapi", async () => {
    const r = await wardenSpecDiffStub({
      providerSlug: "acme-payments",
      oldSpecPath: join(root, "fixtures/providers/acme-payments/openapi-v1.json"),
      newSpecPath: join(root, "fixtures/providers/acme-payments/openapi-v2.json"),
      execute: false,
    });
    expect(r.plan.steps.length).toBeGreaterThan(2);
    expect(r.markdown).toContain("Plan:");
  });

  it("transformer stub builds campaign plan", async () => {
    const r = await transformerCampaignStub({
      name: "demo",
      sourceSystem: "vb6",
      targetStack: "node",
      dag: [
        { id: "1", title: "core", repoKey: "core", dependsOn: [] },
        { id: "2", title: "api", repoKey: "api", dependsOn: ["1"] },
      ],
      execute: false,
    });
    expect(r.plan.agent).toBe("transformer");
    expect(r.multiRepoMarkdown).toContain("Multi-repo");
  });

  it("planFromOpenApiPair works", () => {
    const v1 = JSON.parse(
      readFileSync(join(root, "fixtures/providers/acme-payments/openapi-v1.json"), "utf8"),
    );
    const v2 = JSON.parse(
      readFileSync(join(root, "fixtures/providers/acme-payments/openapi-v2.json"), "utf8"),
    );
    const plan = planFromOpenApiPair("acme", v1, v2);
    expect(plan.kind).toBe("spec_diff");
  });

  it("exposes backfillGit latencySlo dogfood", () => {
    const p = createPlatform({ tenantId: "sdk-test" });
    p.graphQuery({ op: "stats" });
    p.graphQuery({ op: "stats" });
    p.graphQuery({ op: "stats" });
    const slo = p.latencySlo();
    expect(slo.markdown).toMatch(/latency/i);
    const dog = p.dogfood(root);
    expect(dog.markdown).toMatch(/Dogfood/);
    expect(typeof dog.reportPath).toBe("string");
  });

  it("derives VM build-cache authority from the client tenant scope", () => {
    const tenantA = createPlatform({ tenantId: "sdk-vm-tenant-a" });
    const tenantB = createPlatform({ tenantId: "sdk-vm-tenant-b" });

    const firstA = tenantA.createVm({ cacheKey: "shared-build" });
    const secondA = tenantA.createVm({ cacheKey: "shared-build" });
    const firstB = tenantB.createVm({ cacheKey: "shared-build" });

    try {
      expect(firstA.cacheHit).toBe(false);
      expect(secondA.cacheHit).toBe(true);
      expect(secondA.root).toBe(firstA.root);
      expect(firstB.cacheHit).toBe(false);
      expect(firstB.root).not.toBe(firstA.root);
    } finally {
      firstA.dispose();
      secondA.dispose();
      firstB.dispose();
    }
  });

  it("threads client tenant scope through harness execution and plan access", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "sdk-harness-scope-"));
    try {
      const tenantA = createPlatform({ tenantId: "sdk-harness-a" });
      const tenantB = createPlatform({ tenantId: "sdk-harness-b" });
      const a = await tenantA.executeHello(baseDir);
      const b = await tenantB.executeHello(baseDir);

      expect(a.paths.root).not.toBe(b.paths.root);
      expect(a.score.tenantId).toBe("sdk-harness-a");
      expect(b.score.tenantId).toBe("sdk-harness-b");
      expect(tenantA.listPlans(baseDir).map((plan) => plan.runId)).toEqual([a.runId]);
      expect(tenantB.listPlans(baseDir).map((plan) => plan.runId)).toEqual([b.runId]);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
