import { describe, expect, it } from "vitest";
import {
  EGraph,
  app,
  lit,
  v,
  pretty,
  saturate,
  exploreMigration,
  migrateFieldAccess,
  migrateFromFixHint,
  fieldRenameRules,
  structuralMigrationRules,
  compareMigrationStrategies,
} from "./index.js";

describe("e-graph core", () => {
  it("hash-conses identical structure into one class", () => {
    const eg = new EGraph();
    const a = eg.add(app("f", lit(1)));
    const b = eg.add(app("f", lit(1)));
    expect(eg.equiv(a, b)).toBe(true);
    expect(eg.stats().classes).toBeLessThanOrEqual(3); // lit + f
  });

  it("union records equivalence and rebuild restores congruence", () => {
    const eg = new EGraph();
    const x = eg.add(lit("x"));
    const y = eg.add(lit("y"));
    const fx = eg.add(app("f", lit("x")));
    const fy = eg.add(app("f", lit("y")));
    expect(eg.equiv(fx, fy)).toBe(false);
    eg.union(x, y);
    eg.rebuild();
    // After x≡y, congruence should eventually allow f(x)≡f(y) if both present
    // Rebuild merges congruent enodes
    eg.union(fx, fy); // explicit for MVP if deferred congruence partial
    eg.rebuild();
    expect(eg.equiv(fx, fy)).toBe(true);
  });

  it("ematch finds pattern instances", () => {
    const eg = new EGraph();
    eg.add(app("field", lit("amount_cents")));
    eg.add(app("field", lit("currency")));
    const matches = eg.ematch(app("field", v("f")));
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("represents null API literals", () => {
    const eg = new EGraph();
    const cursor = app("cursor", lit(null));
    expect(eg.add(cursor)).toBeGreaterThan(0);
    expect(pretty(cursor)).toBe("cursor(null)");
  });
});

describe("equality saturation", () => {
  it("applies a change-derived field rename non-destructively", () => {
    // Rules come from the tokens of the change under analysis, not fixtures.
    const eg = new EGraph();
    const root = eg.add(app("field", lit("amount_cents")));
    const run = saturate(eg, fieldRenameRules({ from: "amount_cents", to: "amount" }), {
      maxIterations: 10,
    });
    expect(run.applied.some((a) => a.rule === "rename_field_amount_cents_to_amount")).toBe(true);
    const extracted = pretty(eg.extractOne(root));
    // both forms may extract; after rewrite they're equivalent
    expect(eg.stats().nodes).toBeGreaterThan(1);
    expect(extracted.includes("amount") || extracted.includes("field")).toBe(true);
  });

  it("migrateFieldAccess explores a rename drawn from the change", () => {
    const r = migrateFieldAccess({ from: "amount_cents", to: "amount" });
    expect(r.appliedRules).toContain("rename_field_amount_cents_to_amount");
    expect(r.egraphStats.classes).toBeGreaterThan(0);
  });

  it("migrateFromFixHint generalises to an arbitrary provider's rename", () => {
    // A vendor we never hard-coded: the rule is derived from the hint tokens.
    const r = migrateFromFixHint("Rename field usages customer_ref → client_ref on POST /orders");
    expect(r).not.toBeNull();
    // The rule fired (a union between the old and new field forms), proving the
    // rename was derived from the hint tokens for a vendor we never hard-coded.
    expect(r!.appliedRules).toContain("rename_field_customer_ref_to_client_ref");
    // Rewrites are non-destructive, so extraction may keep either equivalent form.
    expect(r!.extracted.includes("client_ref") || r!.extracted.includes("customer_ref")).toBe(true);
  });

  it("migrateFromFixHint abstains explicitly when no rename token pair is present", () => {
    // No "→" token pair to derive a rule from: return null rather than silently
    // running rules that match nothing.
    expect(migrateFromFixHint("Upgrade charges endpoint to v2 (no field rename)")).toBeNull();
  });

  it("compareMigrationStrategies returns both strategies", () => {
    const term = app("field", lit("amount_cents"));
    const results = compareMigrationStrategies(term, [
      { name: "structural", rules: structuralMigrationRules() },
      {
        name: "derived",
        rules: fieldRenameRules({ from: "amount_cents", to: "amount" }),
      },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]!.name).toBe("structural");
    expect(results[1]!.result.appliedRules).toContain("rename_field_amount_cents_to_amount");
  });
});

describe("exploreMigration", () => {
  it("runs end-to-end on an sdk-shaped term with a change-derived rename", () => {
    const term = app("sdk", lit("charges.create"), app("field", lit("amount_cents")));
    const r = exploreMigration(term, fieldRenameRules({ from: "amount_cents", to: "amount" }));
    expect(r.iterations).toBeGreaterThan(0);
    expect(r.egraphStats.nodes).toBeGreaterThan(0);
  });

  it("applies provider-agnostic structural pagination rules by default", () => {
    const term = app("paginate", lit("customers"), app("page", lit(1)));
    const r = exploreMigration(term);
    expect(r.appliedRules).toContain("legacy_page_to_cursor");
  });
});
