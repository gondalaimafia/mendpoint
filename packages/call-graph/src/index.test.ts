import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import {
  buildCallGraph,
  reverseReachability,
  impactSubgraph,
  findWrappers,
  nodeByFileName,
  directCallers,
} from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
});

function writeFixture(): string {
  const root = join(tmpdir(), `call-graph-${Date.now()}`);
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });

  writeFileSync(
    join(root, "src", "acme.ts"),
    `
export function chargeCustomer(cents: number) {
  return fetch("/v1/charges", { method: "POST", body: JSON.stringify({ amount_cents: cents }) });
}
`,
    "utf8",
  );

  writeFileSync(
    join(root, "src", "payments.ts"),
    `
import { chargeCustomer } from "./acme";

export function PaymentService_charge(orderTotal: number) {
  return chargeCustomer(orderTotal);
}

export function PaymentService_checkout(orderTotal: number) {
  return PaymentService_charge(orderTotal);
}
`,
    "utf8",
  );

  writeFileSync(
    join(root, "src", "controller.ts"),
    `
import { PaymentService_checkout } from "./payments";

export function handleCheckout(req: { total: number }) {
  return PaymentService_checkout(req.total);
}
`,
    "utf8",
  );

  return root;
}

describe("call-graph construction", () => {
  it("builds nodes and direct call edges", () => {
    const root = writeFixture();
    const g = buildCallGraph(root, { algorithm: "hybrid" });
    expect(g.stats.nodeCount).toBeGreaterThanOrEqual(4);
    expect(g.stats.edgeCount).toBeGreaterThan(0);
    expect(g.stats.directEdges + g.stats.approxEdges).toBe(g.stats.edgeCount);

    const leaf = nodeByFileName(g, "src/acme.ts", "chargeCustomer");
    expect(leaf).toBeTruthy();
  });

  it("reverse reachability finds wrappers and controllers (depth ≤ 3)", () => {
    const root = writeFixture();
    const g = buildCallGraph(root);
    const leaf = nodeByFileName(g, "src/acme.ts", "chargeCustomer")!;
    const upstream = reverseReachability(g, leaf.id, { maxDepth: 3 });
    const names = upstream.map((h) => h.node.name);
    expect(names).toContain("PaymentService_charge");
    // transitive
    expect(
      names.includes("PaymentService_checkout") || names.includes("handleCheckout"),
    ).toBe(true);
  });

  it("impactSubgraph returns seeds + upstream + wrappers", () => {
    const root = writeFixture();
    const g = buildCallGraph(root);
    const leaf = nodeByFileName(g, "src/acme.ts", "chargeCustomer")!;
    const sub = impactSubgraph(g, [leaf.id], { maxDepth: 3 });
    expect(sub.seedNodeIds).toEqual([leaf.id]);
    expect(sub.upstream.length).toBeGreaterThan(0);
    expect(sub.nodes.length).toBeGreaterThan(1);
    const wrappers = findWrappers(g, [leaf.id]);
    expect(wrappers.some((w) => w.name.includes("PaymentService"))).toBe(true);
  });

  it("directCallers is depth-1 reverse", () => {
    const root = writeFixture();
    const g = buildCallGraph(root);
    const leaf = nodeByFileName(g, "src/acme.ts", "chargeCustomer")!;
    const callers = directCallers(g, leaf.id);
    expect(callers.some((c) => c.name === "PaymentService_charge")).toBe(true);
  });

  it("indexes symbols whose names collide with object prototype properties", () => {
    const root = writeFixture();
    writeFileSync(
      join(root, "src", "prototype-names.ts"),
      `
export function constructor() { return 1; }
export function toString() { return constructor(); }
export function hasOwnProperty() { return toString(); }
export function __proto__() { return hasOwnProperty(); }
`,
      "utf8",
    );

    const graph = buildCallGraph(root);
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(nodeByFileName(graph, "src/prototype-names.ts", name)).toBeTruthy();
      expect(graph.byName[name]).toHaveLength(1);
    }
  });
});
