import { describe, it, expect } from "vitest";
import { validateGroundTruth } from "../ground-truth/schema.js";
import {
  generateScenarios,
  holdoutRefVariations,
  holdoutJsonPayloadVariations,
  materializeRepo,
} from "./index.js";
import { listFilesRecursive } from "../runners/stage.js";
import { tsPaymentsService } from "./templates.js";

describe("generateScenarios", () => {
  const scenarios = generateScenarios();

  it("emits scenarios with unique ids and valid, self-consistent ground truth", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(20);
    const ids = new Set(scenarios.map((s) => s.scenario_id));
    expect(ids.size).toBe(scenarios.length);
    for (const s of scenarios) {
      expect(validateGroundTruth(s.gt), s.scenario_id).toEqual([]);
      expect(s.gt.scenario_id).toBe(s.scenario_id);
      expect(s.gt.intended_product).toEqual([s.product]);
    }
  });

  it("GATE 5: the ref-blindness family auto-generates >=4 flag_files scenarios", () => {
    const refFamily = scenarios.filter(
      (s) => s.gt.tags.includes("ref-blindness") && s.gt.correct_behavior === "flag_files",
    );
    expect(refFamily.length).toBeGreaterThanOrEqual(4);
    for (const s of refFamily) {
      // Auto-emitted ground truth must be internally correct: every expected file
      // exists in the repo and actually carries the renamed field token; and the
      // spec pair is present for the Fettler path.
      expect(s.repo.specV1, s.scenario_id).toBeDefined();
      expect(s.repo.specV2, s.scenario_id).toBeDefined();
      expect(s.gt.expected_findings.length).toBeGreaterThan(0);
      for (const f of s.gt.expected_findings) {
        expect(s.repo.files[f], `${s.scenario_id}:${f}`).toBeDefined();
        expect(s.repo.files[f]).toContain("source");
      }
    }
  });

  it("covers every family the brief calls for", () => {
    const behaviors = new Set(scenarios.map((s) => s.gt.correct_behavior));
    expect(behaviors.has("flag_files")).toBe(true); // rename / generated-vendored
    expect(behaviors.has("abstain")).toBe(true); // ambiguity
    expect(behaviors.has("no_op")).toBe(true); // counterfactual / already-migrated
    expect(behaviors.has("apply_recipe")).toBe(true); // dependency runtime
    expect(behaviors.has("coverage_gap")).toBe(true); // unsupported runtime bump
    // Counterfactual (Phase 14) is present and scored as no_op.
    expect(scenarios.some((s) => s.gt.tags.includes("counterfactual"))).toBe(true);
  });

  it("assigns every dataset tier, including the regression and holdout tiers", () => {
    const splits = new Set(scenarios.map((s) => s.gt.dataset_split));
    expect(splits.has("development")).toBe(true);
    expect(splits.has("regression")).toBe(true); // spec §18.9 middle tier
    expect(splits.has("validation")).toBe(true);
    expect(splits.has("holdout")).toBe(true);
  });

  it("the regression tier is a real, valid, previously-fixed-defect guard", () => {
    const regression = scenarios.filter((s) => s.gt.dataset_split === "regression");
    expect(regression.length).toBeGreaterThan(0);
    for (const s of regression) {
      expect(validateGroundTruth(s.gt), s.scenario_id).toEqual([]);
    }
  });
});

describe("holdoutRefVariations", () => {
  it("procedurally emits N unseen holdout scenarios, reproducibly", () => {
    const a = holdoutRefVariations(6);
    const b = holdoutRefVariations(6);
    expect(a.length).toBe(6);
    expect(a.every((s) => s.gt.dataset_split === "holdout")).toBe(true);
    // Deterministic: same seeds -> same ids and same ground truth.
    expect(a.map((s) => s.scenario_id)).toEqual(b.map((s) => s.scenario_id));
    expect(JSON.stringify(a.map((s) => s.gt))).toBe(JSON.stringify(b.map((s) => s.gt)));
  });
});

describe("holdoutJsonPayloadVariations", () => {
  it("emits holdout scenarios from a family the development split does not use, with JSON fixtures in novel directories", () => {
    const dev = new Set(
      generateScenarios()
        .filter((s) => s.gt.dataset_split === "development")
        .flatMap((s) => Object.keys(s.repo.files)),
    );
    // Directory names the development split uses for its fixtures.
    const devDirs = new Set([...dev].map((p) => p.split("/").slice(0, -1).join("/")));

    const holdout = holdoutJsonPayloadVariations();
    expect(holdout.length).toBeGreaterThan(0);
    for (const s of holdout) {
      expect(s.gt.dataset_split).toBe("holdout");
      expect(validateGroundTruth(s.gt), s.scenario_id).toEqual([]);
      const jsonFixtures = Object.keys(s.repo.files).filter((p) => p.endsWith(".json") && p !== "package.json");
      // The holdout actually exercises the JSON-payload path.
      expect(jsonFixtures.length).toBeGreaterThan(0);
      // Every JSON fixture is an expected finding (the impact really lives there).
      for (const f of jsonFixtures) expect(s.gt.expected_findings).toContain(f);
      // At least one fixture sits in a directory name absent from the dev split.
      const inNovelDir = jsonFixtures.some(
        (f) => !devDirs.has(f.split("/").slice(0, -1).join("/")),
      );
      expect(inNovelDir, s.scenario_id).toBe(true);
    }
  });

  it("is deterministic run-to-run", () => {
    const a = holdoutJsonPayloadVariations();
    const b = holdoutJsonPayloadVariations();
    expect(a.map((s) => s.scenario_id)).toEqual(b.map((s) => s.scenario_id));
    expect(JSON.stringify(a.map((s) => s.gt))).toBe(JSON.stringify(b.map((s) => s.gt)));
  });
});

describe("materializeRepo", () => {
  it("writes files + the spec pair to scratch, without any answer-key file", () => {
    const t = tsPaymentsService({ seed: 7 });
    const mat = materializeRepo({ ...t.repo, specV1: { openapi: "3.0.3" }, specV2: { openapi: "3.0.3" } });
    try {
      const files = listFilesRecursive(mat.repoPath);
      expect(files).toContain("spec/openapi-v1.json");
      expect(files).toContain("spec/openapi-v2.json");
      expect(files).toContain("src/infra/provider/client.ts");
      // Generated repos never contain a grading key.
      expect(files.some((f) => /EXPECTED\.md|SYNTHETIC.*NOTES/i.test(f))).toBe(false);
    } finally {
      mat.cleanup();
    }
  });
});

describe("tsPaymentsService template", () => {
  it("declares impacted files that carry the field and decoys that do not import the provider", () => {
    const t = tsPaymentsService({ seed: 123, slug: "meridian" });
    for (const f of t.roles.impacted) {
      expect(t.repo.files[f]).toContain("source");
    }
    for (const d of t.roles.decoys) {
      expect(t.repo.files[d]).toContain("source");
      // A decoy must never import the provider package (that would make it reachable).
      expect(t.repo.files[d]).not.toContain('from "meridian"');
    }
    // The anchor imports the provider so the provenance gate is enabled.
    expect(t.repo.files["src/infra/provider/client.ts"]).toContain('from "meridian"');
  });

  it("models a vendored trap with a foreign package boundary reached from first-party code", () => {
    const t = tsPaymentsService({ seed: 124, slug: "meridian", withVendored: true });
    const manifest = JSON.parse(t.repo.files["vendor/provider-sdk/package.json"] ?? "null") as {
      name?: string;
    } | null;

    expect(manifest?.name).toBe("provider-sdk-copy");
    expect(t.repo.files["src/vendorProvider.ts"]).toContain(
      'from "../vendor/provider-sdk/index.js"',
    );
    expect(t.roles.vendored).toEqual(["vendor/provider-sdk/index.ts"]);
  });
});
