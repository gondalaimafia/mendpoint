import { describe, it, expect } from "vitest";
import { validateGroundTruth } from "../ground-truth/schema.js";
import { isAnswerKeyFile } from "../runners/stage.js";
import { materializeRepo } from "../generators/index.js";
import { runRegauge } from "../runners/regauge-runner.js";
import { REGRESSION_CASES } from "./cases.js";
import { regressionScenarios } from "./build.js";
import { validateRegressionCase, type RegressionCase } from "./schema.js";
import { assertAdmissible, RegressionGovernanceError } from "./governance.js";

const ctx = { gitCommit: "test", productVersion: "test" };

describe("regression catalog shape", () => {
  it("every case is well-formed", () => {
    for (const c of REGRESSION_CASES) {
      expect(validateRegressionCase(c), c.id).toEqual([]);
    }
  });

  it("case ids are unique", () => {
    const ids = REGRESSION_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a 'fixed' case records what fixed it", () => {
    for (const c of REGRESSION_CASES.filter((c) => c.status === "fixed")) {
      expect(c.fixedBy, c.id).toBeTruthy();
    }
  });
});

describe("governance gate", () => {
  it("admits every committed case", () => {
    for (const c of REGRESSION_CASES) {
      expect(() => assertAdmissible(c), c.id).not.toThrow();
    }
  });

  it("refuses a case that claims customer data is present", () => {
    const base = REGRESSION_CASES[0]!;
    const dirty: RegressionCase = {
      ...base,
      id: "reg-customer-data-test",
      governance: { ...base.governance, containsCustomerData: true as unknown as false },
    };
    expect(() => assertAdmissible(dirty)).toThrow(RegressionGovernanceError);
  });

  it("refuses a redacted-from-customer case with no redaction reference", () => {
    const base = REGRESSION_CASES[0]!;
    const undocumented: RegressionCase = {
      ...base,
      id: "reg-redaction-missing-test",
      governance: {
        dataProvenance: "redacted-from-customer",
        containsCustomerData: false,
        rationale: "reduced from a real repo",
      },
    };
    expect(() => assertAdmissible(undocumented)).toThrow(/redactionRef/);
  });

  it("refuses a reproduction that carries an answer-key file", () => {
    const base = REGRESSION_CASES[0]!;
    const leaky: RegressionCase = {
      ...base,
      id: "reg-answer-key-leak-test",
      build: () => {
        const r = base.build();
        return { ...r, repo: { ...r.repo, files: { ...r.repo.files, "EXPECTED.md": "the answer" } } };
      },
    };
    expect(() => assertAdmissible(leaky)).toThrow(/answer-key/);
  });
});

describe("failure -> eval conversion", () => {
  const scenarios = regressionScenarios();

  it("produces a scenario per case", () => {
    expect(scenarios.map((s) => s.scenario_id).sort()).toEqual(
      REGRESSION_CASES.map((c) => c.id).sort(),
    );
  });

  it("every scenario has a valid, regression-split ground truth", () => {
    for (const s of scenarios) {
      expect(validateGroundTruth(s.gt), s.scenario_id).toEqual([]);
      expect(s.gt.dataset_split, s.scenario_id).toBe("regression");
      expect(s.gt.scenario_id).toBe(s.scenario_id);
    }
  });

  it("no reproducing repo contains an answer-key file (isolation preserved)", () => {
    for (const s of scenarios) {
      const keys = Object.keys(s.repo.files).filter((p) => isAnswerKeyFile(p));
      expect(keys, s.scenario_id).toEqual([]);
    }
  });
});

// The self-validating re-check: each case records what the CURRENT shipped engine
// does with it (`fixed` -> the engine now refuses; `open` -> the engine is still
// wrong). Run the REAL analyze path and assert reality matches the record, so a
// stale catalog (a case marked fixed that regressed, or an open case that was
// quietly fixed without updating the record) fails the suite. This is the
// "re-check, don't assume" discipline encoded as a test.
describe("recorded status matches the live engine (ReGauge cases)", () => {
  for (const c of REGRESSION_CASES.filter((c) => c.product === "regauge")) {
    it(`${c.id} is ${c.status}`, async () => {
      const mat = materializeRepo(c.build().repo);
      try {
        const cfg = { scenario_id: c.id, product: "regauge" as const, repoPath: mat.repoPath };
        const gt = regressionScenarios().find((s) => s.scenario_id === c.id)!.gt;
        const rec = await runRegauge(cfg, gt, ctx);
        expect(rec.passed).toBe(c.status === "fixed");
      } finally {
        mat.cleanup();
      }
    });
  }
});
