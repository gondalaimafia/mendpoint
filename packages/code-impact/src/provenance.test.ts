import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildIndex } from "@mendpoint/codebase-index";
import type { FileRecord } from "@mendpoint/codebase-index";
import type { ImpactableSurface } from "@mendpoint/shared";
import {
  buildImporterGraph,
  reachableFromAnchors,
  traverseFromAnchors,
  anchorPathTo,
  resolveRelativeImport,
} from "./provenance.js";
import { HARD_MAX_HOPS } from "@mendpoint/shared";
import { discoverCandidates, sdkContextFromSurfaces } from "./index.js";

const tmpDirs: string[] = [];
function makeRepo(fileMap: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "provenance-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(fileMap)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer" }), "utf8");
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function renameSourceSurface(): ImpactableSurface[] {
  return [
    {
      id: "s0",
      canonicalId: "meridian.POST./v1/charges.request_field_renamed.source.payment_method",
      kind: "request_field",
      op: "request_field_renamed",
      path: "/v1/charges",
      method: "post",
      fromField: "source",
      toField: "payment_method",
      severity: "breaking",
      migrationStrategy: "Rename field usages source -> payment_method",
      explanation: "rename",
      searchTokens: ["/v1/charges", "charges", "source", "payment_method"],
    },
  ];
}

function file(path: string, imports: string[]): Pick<FileRecord, "path" | "imports"> {
  return { path, imports };
}

describe("resolveRelativeImport", () => {
  const files = new Set([
    "src/infra/providers/meridian/client.ts",
    "src/services/checkoutService.ts",
    "src/shared/http-client.js",
    "src/app/index.ts",
  ]);

  it("resolves an extensionless TypeScript specifier", () => {
    expect(
      resolveRelativeImport(
        "src/services/checkoutService.ts",
        "../infra/providers/meridian/client",
        files,
      ),
    ).toBe("src/infra/providers/meridian/client.ts");
  });

  it("resolves a .js specifier that points at a .ts source", () => {
    expect(resolveRelativeImport("src/app/order.ts", "../app/index.js", files)).toBe(
      "src/app/index.ts",
    );
  });

  it("resolves an ESM .js specifier to a real .js file", () => {
    expect(
      resolveRelativeImport("src/shared/facade.js", "./http-client.js", new Set(["src/shared/http-client.js"])),
    ).toBe("src/shared/http-client.js");
  });

  it("returns undefined for a bare package specifier", () => {
    expect(resolveRelativeImport("src/a.ts", "stripe", files)).toBeUndefined();
  });
});

describe("provider reachability", () => {
  // client.ts is the provider surface anchor; the chain
  // settlementJob -> tasks -> client threads the field through the task queue,
  // exactly like the synthetic payments service.
  const files = [
    file("src/infra/providers/meridian/client.ts", ["../../../lib/logger"]),
    file("src/jobs/tasks.ts", ["../infra/providers/meridian/client"]),
    file("src/jobs/settlementJob.ts", ["./tasks"]),
    file("src/services/checkoutService.ts", ["../infra/providers/meridian/client"]),
    // Distractors: never import their way to the provider client.
    file("src/analytics/tracker.ts", ["../lib/logger"]),
    file("src/domain/events.ts", []),
    file("src/infra/db/repositories/paymentRepository.ts", ["../store", "../../../domain/payment"]),
  ];

  it("marks transitive importers of the anchor reachable and leaves distractors out", () => {
    const importers = buildImporterGraph(files);
    const reachable = reachableFromAnchors(
      ["src/infra/providers/meridian/client.ts"],
      importers,
    );
    expect(reachable.has("src/infra/providers/meridian/client.ts")).toBe(true);
    expect(reachable.has("src/jobs/tasks.ts")).toBe(true);
    expect(reachable.has("src/jobs/settlementJob.ts")).toBe(true); // 1-hop through tasks
    expect(reachable.has("src/services/checkoutService.ts")).toBe(true);

    expect(reachable.has("src/analytics/tracker.ts")).toBe(false);
    expect(reachable.has("src/domain/events.ts")).toBe(false);
    expect(reachable.has("src/infra/db/repositories/paymentRepository.ts")).toBe(false);
  });

  it("returns only the anchors themselves when nothing imports them", () => {
    const importers = buildImporterGraph([file("a.ts", []), file("b.ts", [])]);
    const reachable = reachableFromAnchors(["a.ts"], importers);
    expect([...reachable]).toEqual(["a.ts"]);
  });
});

describe("traverseFromAnchors / anchorPathTo (FET-016 graph_path)", () => {
  // Reference implementation of the ORIGINAL Set-only reachability, inlined so a
  // test proves the predecessor-carrying walk keeps identical reachability
  // semantics — the finding gate reads this set unchanged.
  function referenceReachable(
    anchors: Iterable<string>,
    importerGraph: Map<string, Set<string>>,
  ): Set<string> {
    const reachable = new Set<string>(anchors);
    const queue = [...reachable];
    while (queue.length) {
      const node = queue.pop()!;
      const importers = importerGraph.get(node);
      if (!importers) continue;
      for (const importer of importers) {
        if (!reachable.has(importer)) {
          reachable.add(importer);
          queue.push(importer);
        }
      }
    }
    return reachable;
  }

  const sorted = (s: Iterable<string>) => [...s].sort();

  it("reachable set is byte-identical to the original algorithm (plain, wrapper, cyclic, deep)", () => {
    const graphs: Array<[Array<Pick<FileRecord, "path" | "imports">>, string[]]> = [
      [
        [
          file("client.ts", []),
          file("wrapper.ts", ["./client"]),
          file("app.ts", ["./wrapper"]),
          file("unrelated.ts", ["./util"]),
        ],
        ["client.ts"],
      ],
      // Cyclic import graph: a <-> b, and b imports the anchor.
      [
        [
          file("anchor.ts", []),
          file("b.ts", ["./anchor", "./a"]),
          file("a.ts", ["./b"]),
        ],
        ["anchor.ts"],
      ],
      // Deep chain.
      [
        Array.from({ length: 40 }, (_, i) =>
          file(`n${i}.ts`, i === 0 ? [] : [`./n${i - 1}`]),
        ),
        ["n0.ts"],
      ],
    ];
    for (const [files, anchors] of graphs) {
      const importers = buildImporterGraph(files);
      const walk = traverseFromAnchors(anchors, importers);
      expect(sorted(walk.reachable)).toEqual(sorted(referenceReachable(anchors, importers)));
    }
  });

  it("a finding reached through a two-hop wrapper carries both hops in order", () => {
    // app -> wrapper -> client(anchor). Path is anchor-first, each node imported
    // by the next.
    const files = [
      file("client.ts", []),
      file("wrapper.ts", ["./client"]),
      file("app.ts", ["./wrapper"]),
    ];
    const walk = traverseFromAnchors(["client.ts"], buildImporterGraph(files));
    const path = anchorPathTo("app.ts", walk);
    expect(path).toBeDefined();
    expect(path!.nodes).toEqual(["client.ts", "wrapper.ts", "app.ts"]);
    expect(path!.hops).toBe(2);
    expect(path!.terminal).toBe("anchor");
    expect(path!.truncated).toBe(false);
    expect(path!.coverage).toBe("complete");
  });

  it("a cyclic import graph terminates and yields a simple anchor-terminated path", () => {
    // a <-> b cycle; b imports the anchor. The reachable node still gets a
    // finite, simple path to the anchor rather than looping.
    const files = [
      file("anchor.ts", []),
      file("b.ts", ["./anchor", "./a"]),
      file("a.ts", ["./b"]),
    ];
    const walk = traverseFromAnchors(["anchor.ts"], buildImporterGraph(files));
    const path = anchorPathTo("a.ts", walk);
    expect(path).toBeDefined();
    expect(path!.nodes[0]).toBe("anchor.ts");
    expect(path!.nodes[path!.nodes.length - 1]).toBe("a.ts");
    // Simple path: no node repeats.
    expect(new Set(path!.nodes).size).toBe(path!.nodes.length);
    expect(path!.terminal).toBe("anchor");
  });

  it("marks a cycle (not silent truncation, not an infinite loop) when the predecessor chain cycles", () => {
    // Defensive guarantee: a malformed/cyclic predecessor map still terminates
    // and is reported as a cycle. BFS never produces this, so it is exercised
    // directly.
    const walk = {
      reachable: new Set(["x", "y", "z"]),
      anchors: new Set(["anchor"]),
      predecessors: new Map([
        ["x", "y"],
        ["y", "z"],
        ["z", "x"],
      ]),
    };
    const path = anchorPathTo("x", walk);
    expect(path).toBeDefined();
    expect(path!.terminal).toBe("cycle");
    expect(path!.truncated).toBe(true);
    expect(path!.coverage).toBe("partial");
  });

  it("marks a path exceeding the hop bound as truncated (max_hops), not silently cut", () => {
    // A chain longer than HARD_MAX_HOPS: n0 (anchor) <- n1 <- ... <- n{HARD+5}.
    const len = HARD_MAX_HOPS + 5;
    const files = Array.from({ length: len + 1 }, (_, i) =>
      file(`n${i}.ts`, i === 0 ? [] : [`./n${i - 1}`]),
    );
    const walk = traverseFromAnchors(["n0.ts"], buildImporterGraph(files));
    const deepest = `n${len}.ts`;
    expect(walk.reachable.has(deepest)).toBe(true);
    const path = anchorPathTo(deepest, walk);
    expect(path).toBeDefined();
    expect(path!.terminal).toBe("max_hops");
    expect(path!.truncated).toBe(true);
    expect(path!.coverage).toBe("partial");
    expect(path!.hops).toBe(HARD_MAX_HOPS);
    expect(path!.nodes.length).toBe(HARD_MAX_HOPS + 1);
  });

  it("returns undefined for an unreachable file (not computed, not an empty path)", () => {
    const files = [file("anchor.ts", []), file("island.ts", ["./other"])];
    const walk = traverseFromAnchors(["anchor.ts"], buildImporterGraph(files));
    expect(anchorPathTo("island.ts", walk)).toBeUndefined();
  });

  it("a finding on the anchor file itself is a zero-hop direct usage path", () => {
    const files = [file("anchor.ts", [])];
    const walk = traverseFromAnchors(["anchor.ts"], buildImporterGraph(files));
    const path = anchorPathTo("anchor.ts", walk);
    expect(path).toBeDefined();
    expect(path!.nodes).toEqual(["anchor.ts"]);
    expect(path!.hops).toBe(0);
    expect(path!.terminal).toBe("anchor");
  });
});

describe("discoverCandidates provenance gating", () => {
  const surfaces = renameSourceSurface();

  function confidencesFor(dir: string, filePath: string): string[] {
    const index = buildIndex(dir, { sdkContext: sdkContextFromSurfaces(surfaces) });
    return discoverCandidates(index, surfaces)
      .filter((c) => c.filePath === filePath)
      .map((c) => c.initialConfidence);
  }

  it("keeps the provider-reachable field site confident and demotes the unrelated one", () => {
    const dir = makeRepo({
      "src/client.ts": [
        "export interface MeridianChargeRequest { source: string; }",
        "export async function createCharge(req: MeridianChargeRequest) {",
        '  return fetch("/v1/charges", { method: "POST", body: JSON.stringify({ source: req.source }) });',
        "}",
      ].join("\n"),
      "src/checkout.ts": [
        'import type { MeridianChargeRequest } from "./client";',
        "export function build(token: string): MeridianChargeRequest {",
        "  return { source: token };",
        "}",
      ].join("\n"),
      // Distractor: same field name, never imports the provider client.
      "src/analytics.ts": [
        "export interface AnalyticsEvent { source: string; }",
        'export function track(source: string) { return { source }; }',
      ].join("\n"),
    });

    const checkout = confidencesFor(dir, "src/checkout.ts");
    const analytics = confidencesFor(dir, "src/analytics.ts");

    // The provider-reachable consumer keeps at least one confident (medium+) site.
    expect(checkout.some((c) => c === "high" || c === "medium")).toBe(true);
    // The unrelated `source` never reaches a confident tier.
    expect(analytics.length).toBeGreaterThan(0);
    expect(analytics.every((c) => c === "low")).toBe(true);
  });

  it("does not gate when no provider surface is detectable (recall over precision)", () => {
    // No HTTP path and no vendor package anywhere: the field is threaded only by
    // name through a wrapper chain. Gating must stay off so the site survives.
    const dir = makeRepo({
      "src/vendor.ts": ["export function charge(body: { source: string }) { return body; }"].join(
        "\n",
      ),
      "src/wrapper.ts": [
        'import { charge } from "./vendor";',
        "export function post(source: string) { return charge({ source }); }",
      ].join("\n"),
    });
    const wrapper = confidencesFor(dir, "src/wrapper.ts");
    expect(wrapper.some((c) => c === "high" || c === "medium")).toBe(true);
  });
});
