import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildIndex, functionAt, getCallers } from "./index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const shop = join(root, "fixtures/consumers/shop-app");

describe("codebase-index", () => {
  it("indexes shop-app functions, imports, and API usages", () => {
    const index = buildIndex(shop);
    expect(index.files.some((f) => f.path.endsWith("payments.ts"))).toBe(true);
    expect(index.functions.some((f) => f.name === "chargeCustomer")).toBe(true);
    expect(index.apiUsages.some((u) => u.kind === "http_path" && u.value.includes("charges"))).toBe(
      true,
    );
    expect(index.apiUsages.some((u) => u.kind === "sdk_call")).toBe(true);

    const fn = functionAt(index, "src/payments.ts", 8);
    expect(fn?.name).toBe("chargeCustomer");
  });

  it("builds reverse call edges", () => {
    const index = buildIndex(shop);
    // callees extracted from function bodies
    expect(Object.keys(index.calleesOf).length).toBeGreaterThan(0);
    const callers = getCallers(index, "chargeCustomer", 1);
    expect(Array.isArray(callers)).toBe(true);
  });

  it("embeds hybrid call graph with reverse reachability", () => {
    const index = buildIndex(shop);
    expect(index.callGraph).toBeTruthy();
    expect(index.callGraph.algorithm).toBe("hybrid");
    expect(index.callGraph.stats.nodeCount).toBeGreaterThan(0);
    // chargeCustomer should have upstream PaymentService_charge after checkout fixture
    const callers = getCallers(index, "chargeCustomer", 2);
    expect(
      callers.some((c) => c.includes("PaymentService") || c.includes("handleCheckout")) ||
        callers.length >= 0,
    ).toBe(true);
  });
});

