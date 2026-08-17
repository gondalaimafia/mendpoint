import { describe, it, expect } from "vitest";
import { normalizeChange } from "@mendpoint/change-intel";
import {
  ambiguousApiRename,
  bumpNodeRuntime,
  counterfactualNoRename,
  mulberry32,
  renameApiRequestField,
  type RefStyle,
  type SyntheticRepo,
} from "./engine.js";

const base: SyntheticRepo = { files: { "src/a.ts": "export const x = 1;\n" } };
const renameOpts = {
  path: "/v1/charges",
  method: "POST",
  from: "source",
  to: "payment_method",
  example: "pm_card_visa",
  impactedFiles: ["src/infra/client.ts", "src/services/checkout.ts"],
  decoyFiles: ["src/analytics/tracker.ts"],
};

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("renameApiRequestField", () => {
  const styles: RefStyle[] = ["flat", "ref", "nested2", "allOf", "refToRef"];

  it("emits exactly one request_field_renamed surface for every ref style", () => {
    for (const refStyle of styles) {
      const m = renameApiRequestField(base, { ...renameOpts, refStyle });
      const { surfaces } = normalizeChange(m.mutated.specV1, m.mutated.specV2, {
        providerSlug: "meridian",
      });
      expect(surfaces.length, refStyle).toBe(1);
      expect(surfaces[0]!.op, refStyle).toBe("request_field_renamed");
      expect(surfaces[0]!.fromField, refStyle).toBe("source");
      expect(surfaces[0]!.toField, refStyle).toBe("payment_method");
    }
  });

  it("records the answer key from what it changed", () => {
    const m = renameApiRequestField(base, { ...renameOpts, refStyle: "ref" });
    expect(m.groundTruth.correct_behavior).toBe("flag_files");
    expect(m.groundTruth.expected_findings).toEqual([
      "src/infra/client.ts",
      "src/services/checkout.ts",
    ]);
    expect(m.groundTruth.false_positive_traps).toEqual(["src/analytics/tracker.ts"]);
    expect(m.groundTruth.blast_radius_truth.affectedFiles).toBe(2);
    expect(m.changeLog.join(" ")).toContain("source' -> 'payment_method");
  });

  it("is deterministic (same input -> byte-identical spec)", () => {
    const a = renameApiRequestField(base, { ...renameOpts, refStyle: "allOf" });
    const b = renameApiRequestField(base, { ...renameOpts, refStyle: "allOf" });
    expect(JSON.stringify(a.mutated)).toBe(JSON.stringify(b.mutated));
  });

  it("is reversible: inverse restores the pre-mutation repo", () => {
    const m = renameApiRequestField(base, { ...renameOpts, refStyle: "ref" });
    expect(m.inverse()).toEqual(base);
    expect(m.mutated.specV2).toBeDefined(); // mutation actually changed something
  });
});

describe("counterfactualNoRename", () => {
  it("produces no diff (v2 == v1) so a correct engine flags nothing", () => {
    const m = counterfactualNoRename(base, { ...renameOpts, refStyle: "ref" });
    const { surfaces } = normalizeChange(m.mutated.specV1, m.mutated.specV2, {
      providerSlug: "meridian",
    });
    expect(surfaces.length).toBe(0);
    expect(m.groundTruth.correct_behavior).toBe("no_op");
    expect(m.groundTruth.expected_findings).toEqual([]);
    // Every field-bearing file becomes a false-positive trap.
    expect(m.groundTruth.false_positive_traps).toContain("src/infra/client.ts");
    expect(m.groundTruth.false_positive_traps).toContain("src/analytics/tracker.ts");
  });
});

describe("ambiguousApiRename", () => {
  it("requires >=2 successors", () => {
    expect(() =>
      ambiguousApiRename(base, {
        path: "/v1/charges",
        method: "POST",
        from: "source",
        successors: ["payment_method"],
        example: "pm_card_visa",
        fieldFiles: ["src/a.ts"],
      }),
    ).toThrow();
  });

  it("produces an ambiguous change (no rename surface) and demands abstention", () => {
    for (const successors of [
      ["payment_method", "payment_source"],
      ["payment_method", "payment_source", "pay_method"],
    ]) {
      const m = ambiguousApiRename(base, {
        path: "/v1/charges",
        method: "POST",
        from: "source",
        successors,
        example: "pm_card_visa",
        fieldFiles: ["src/a.ts"],
      });
      const { surfaces } = normalizeChange(m.mutated.specV1, m.mutated.specV2, {
        providerSlug: "meridian",
      });
      expect(surfaces.length).toBe(1);
      expect(surfaces[0]!.op).toBe("request_field_ambiguous");
      expect(m.groundTruth.correct_behavior).toBe("abstain");
      expect(m.groundTruth.expected_findings).toEqual([]);
    }
  });
});

describe("bumpNodeRuntime", () => {
  it("writes the runtime pins and records them as the answer key", () => {
    const m = bumpNodeRuntime(base, {
      fromMajor: 18,
      toMajor: 20,
      files: ["package.json", ".nvmrc"],
      shippedRecipeId: "node-runtime-18-to-20",
    });
    expect(m.mutated.files[".nvmrc"]).toBe("18\n");
    expect(JSON.parse(m.mutated.files["package.json"]!).engines.node).toBe(">=18 <19");
    expect(m.groundTruth.correct_behavior).toBe("apply_recipe");
    expect(m.groundTruth.expected_findings).toEqual([".nvmrc", "package.json"]);
    expect(m.groundTruth.recipe_expectation?.shippedRecipeId).toBe("node-runtime-18-to-20");
  });

  it("marks an uncovered bump as a coverage gap", () => {
    const m = bumpNodeRuntime(base, {
      fromMajor: 21,
      toMajor: 23,
      files: ["package.json", ".nvmrc"],
      shippedRecipeId: null,
    });
    expect(m.groundTruth.correct_behavior).toBe("coverage_gap");
    expect(m.groundTruth.recipe_expectation?.shippedRecipeId).toBeNull();
  });

  it("is reversible: inverse restores the pre-mutation repo", () => {
    const m = bumpNodeRuntime(base, {
      fromMajor: 18,
      toMajor: 20,
      files: ["package.json", ".nvmrc"],
      shippedRecipeId: "node-runtime-18-to-20",
    });
    expect(m.inverse()).toEqual(base);
  });
});
