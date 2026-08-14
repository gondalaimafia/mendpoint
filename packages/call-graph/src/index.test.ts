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

function mkRoot(tag: string): string {
  const root = join(
    tmpdir(),
    `cg-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  dirs.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

describe("call-graph traversal pruning", () => {
  it("skips .venv/site-packages/__pycache__ and indexes only first-party sources", () => {
    const root = mkRoot("venv");
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(
      join(root, "app", "main.py"),
      `def handler():\n    return compute()\n\ndef compute():\n    return 1\n`,
      "utf8",
    );
    // Dependency tree that must NOT be ingested.
    mkdirSync(join(root, ".venv", "lib", "site-packages", "thirdparty"), {
      recursive: true,
    });
    writeFileSync(
      join(root, ".venv", "lib", "site-packages", "thirdparty", "vendored.py"),
      `def vendored_a():\n    return vendored_b()\n\ndef vendored_b():\n    return 2\n`,
      "utf8",
    );
    // Cache dir under first-party source.
    mkdirSync(join(root, "app", "__pycache__"), { recursive: true });
    writeFileSync(
      join(root, "app", "__pycache__", "main.cpython-311.py"),
      `def cached():\n    return 3\n`,
      "utf8",
    );

    const g = buildCallGraph(root);
    const files = [...new Set(Object.values(g.nodes).map((n) => n.filePath))];
    // Node count matches the real first-party file: exactly handler + compute.
    expect(files).toEqual(["app/main.py"]);
    expect(g.stats.nodeCount).toBe(2);
    expect(
      Object.values(g.nodes).some(
        (n) => n.filePath.includes(".venv") || n.filePath.includes("site-packages"),
      ),
    ).toBe(false);
    // Pruning is auditable.
    const skips = g.diagnostics?.skippedDirectories ?? [];
    expect(
      skips.some((s) => s.path === ".venv" && s.reason === "dependency-directory"),
    ).toBe(true);
    expect(skips.some((s) => s.path === "app/__pycache__")).toBe(true);
  });

  it("keeps tracked vendor/ and build/ directories in the call graph", () => {
    const root = mkRoot("vendor");
    mkdirSync(join(root, "vendor", "github.com", "pkg"), { recursive: true });
    writeFileSync(
      join(root, "vendor", "github.com", "pkg", "lib.py"),
      `def vendored_helper():\n    return 7\n`,
      "utf8",
    );
    mkdirSync(join(root, "build"), { recursive: true });
    writeFileSync(
      join(root, "build", "generated.py"),
      `def generated_fn():\n    return 8\n`,
      "utf8",
    );

    const g = buildCallGraph(root);
    const files = new Set(Object.values(g.nodes).map((n) => n.filePath));
    expect(files.has("vendor/github.com/pkg/lib.py")).toBe(true);
    expect(files.has("build/generated.py")).toBe(true);
    const skips = g.diagnostics?.skippedDirectories ?? [];
    expect(
      skips.some((s) => s.path.startsWith("vendor") || s.path.startsWith("build")),
    ).toBe(false);
  });

  it("skips a custom-named venv only when a pyvenv.cfg marker is present", () => {
    const root = mkRoot("custom-venv");
    // venv WITH marker -> pruned.
    mkdirSync(join(root, "venv"), { recursive: true });
    writeFileSync(join(root, "venv", "pyvenv.cfg"), "home = /usr\n", "utf8");
    writeFileSync(
      join(root, "venv", "installed.py"),
      `def installed_pkg_fn():\n    return 1\n`,
      "utf8",
    );
    // env WITHOUT marker -> kept (legitimate source dir that happens to be named env).
    mkdirSync(join(root, "env"), { recursive: true });
    writeFileSync(
      join(root, "env", "config.py"),
      `def env_config():\n    return 2\n`,
      "utf8",
    );

    const g = buildCallGraph(root);
    const files = new Set(Object.values(g.nodes).map((n) => n.filePath));
    expect(files.has("venv/installed.py")).toBe(false);
    expect(files.has("env/config.py")).toBe(true);
    const skips = g.diagnostics?.skippedDirectories ?? [];
    expect(
      skips.some((s) => s.path === "venv" && s.reason === "virtualenv-marker"),
    ).toBe(true);
    expect(skips.some((s) => s.path === "env")).toBe(false);
  });

  it("records unsupported-language files instead of silently indexing them", () => {
    const root = mkRoot("langs");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "app.ts"),
      `export function main() { return 1; }\n`,
      "utf8",
    );
    writeFileSync(
      join(root, "src", "service.go"),
      `package main\nfunc Handler() int { return 1 }\n`,
      "utf8",
    );
    writeFileSync(
      join(root, "src", "Api.java"),
      `class Api { int run() { return 1; } }\n`,
      "utf8",
    );

    const g = buildCallGraph(root);
    expect(
      Object.values(g.nodes).some(
        (n) => n.filePath.endsWith(".go") || n.filePath.endsWith(".java"),
      ),
    ).toBe(false);
    const unsupported = g.diagnostics?.unsupportedLanguageFiles ?? [];
    expect(unsupported).toContainEqual({ path: "src/service.go", language: "go" });
    expect(unsupported).toContainEqual({ path: "src/Api.java", language: "java" });
    expect(g.diagnostics?.supportedLanguages).toEqual([
      "typescript",
      "javascript",
      "python",
    ]);
  });
});
