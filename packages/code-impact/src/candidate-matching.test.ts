import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildIndex } from "@mendpoint/codebase-index";
import type { ApiUsageRecord, CodebaseIndex } from "@mendpoint/codebase-index";
import type { ImpactableSurface } from "@mendpoint/shared";
import { discoverCandidates, sdkContextFromSurfaces } from "./index.js";

const tmpDirs: string[] = [];
function makeRepo(rel: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cand-match-"));
  tmpDirs.push(dir);
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer" }), "utf8");
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/** Additive-only new capability: GET /v1/balance, whose token is "balance". */
function balanceSurfaces(): ImpactableSurface[] {
  return [
    {
      id: "b0",
      canonicalId: "acme.GET./v1/balance.path_added",
      kind: "http_path",
      op: "path_added",
      path: "/v1/balance",
      method: "get",
      severity: "new_capability",
      migrationStrategy: "Optional adoption: new capability at /v1/balance",
      explanation: "New balance endpoint",
      searchTokens: ["/v1/balance", "balance", "get"],
    },
  ];
}

/** Build an index but replace its apiUsages with a controlled set. */
function indexWithUsages(dir: string, usages: ApiUsageRecord[]): CodebaseIndex {
  const index = buildIndex(dir, { sdkContext: sdkContextFromSurfaces(balanceSurfaces()) });
  return { ...index, apiUsages: usages };
}

describe("identifier-boundary token matching (no confidently-wrong findings)", () => {
  const surfaces = balanceSurfaces();
  const dir = makeRepo("src/x.ts", "export const noop = 1;\n");

  const usage = (value: string, detection: ApiUsageRecord["detection"]): ApiUsageRecord => ({
    filePath: "src/jobs/reconciliationJob.ts",
    line: 34,
    kind: "sdk_call",
    value,
    detection,
  });

  it("token `balance` does NOT match unbalanced / rebalance / balanceSheet", () => {
    for (const noise of ["report.unbalanced.push", "ledger.rebalance.run", "balanceSheet"]) {
      const index = indexWithUsages(dir, [usage(noise, "provider_surface")]);
      const candidates = discoverCandidates(index, surfaces);
      expect(candidates.some((c) => c.symbol === noise)).toBe(false);
    }
  });

  it("token `balance` DOES match client.balance.retrieve() and a bare balance identifier", () => {
    for (const real of ["client.balance.retrieve", "balance"]) {
      const index = indexWithUsages(dir, [usage(real, "provider_surface")]);
      const candidates = discoverCandidates(index, surfaces);
      expect(candidates.some((c) => c.symbol === real && c.sources.includes("sdk_graph"))).toBe(
        true,
      );
    }
  });

  it("a short usage value does not match a longer token (reversed-includes bug)", () => {
    // Surface token is the longer "balance.retrieve"; a usage of bare "bal" must not match.
    const longTokenSurface: ImpactableSurface[] = [
      { ...surfaces[0]!, searchTokens: ["balance.retrieve"] },
    ];
    const index = indexWithUsages(dir, [usage("bal", "provider_surface")]);
    const candidates = discoverCandidates(index, longTokenSurface);
    expect(candidates.length).toBe(0);
  });
});

describe("confidence promotion is tied to the provider surface, not generic keywords", () => {
  const surfaces: ImpactableSurface[] = [
    {
      id: "f0",
      canonicalId: "acme.POST./v1/charges.request_field_renamed.amount_cents.amount",
      kind: "request_field",
      op: "request_field_renamed",
      path: "/v1/charges",
      method: "post",
      field: "amount_cents",
      fromField: "amount_cents",
      toField: "amount",
      severity: "breaking",
      migrationStrategy: "Rename amount_cents → amount",
      explanation: "field rename",
      searchTokens: ["/v1/charges", "charges", "amount_cents", "amount"],
    },
  ];

  it("a line mentioning `api`/`http` alone is not promoted to syntactic confidence", () => {
    // A non-API file whose field-bearing line merely contains the word "api" —
    // no provider path, no API imports. Must stay string_heuristic (low), not
    // become a medium/high syntactic finding.
    const dir = makeRepo(
      "src/config.ts",
      ["// generic api settings, not the provider", "export const amount_cents = readApiEnv();"].join(
        "\n",
      ),
    );
    const index = buildIndex(dir, { sdkContext: sdkContextFromSurfaces(surfaces) });
    const candidates = discoverCandidates(index, surfaces);
    const hit = candidates.find((c) => c.symbol === "amount_cents");
    expect(hit).toBeDefined();
    // Old behavior: the `/amount/i` line-regex promoted this to `syntactic` (high
    // on a breaking change). It must now stay an unpromoted string_heuristic.
    expect(hit!.sources).toContain("string_heuristic");
    expect(hit!.sources).not.toContain("syntactic");
    expect(hit!.initialConfidence).not.toBe("high");
  });

  it("a line referencing the actual provider path IS promoted to syntactic", () => {
    const dir = makeRepo(
      "src/pay.ts",
      ['const res = await fetch("/v1/charges", { body: { amount_cents } });'].join("\n"),
    );
    const index = buildIndex(dir, { sdkContext: sdkContextFromSurfaces(surfaces) });
    const candidates = discoverCandidates(index, surfaces);
    const hit = candidates.find((c) => c.symbol === "amount_cents");
    expect(hit).toBeDefined();
    expect(hit!.sources).toContain("syntactic");
  });
});

describe("path matching respects segment boundaries", () => {
  const surfaces = balanceSurfaces();
  const dir = makeRepo("src/x.ts", "export const noop = 1;\n");

  it("path /v1/balance does not match a usage of /v1/balances", () => {
    const index = indexWithUsages(dir, [
      { filePath: "src/api.ts", line: 3, kind: "http_path", value: "/v1/balances" },
    ]);
    const candidates = discoverCandidates(index, surfaces);
    expect(candidates.some((c) => c.evidence === "/v1/balances")).toBe(false);
  });

  it("path /v1/balance matches /v1/balance/{id}", () => {
    const index = indexWithUsages(dir, [
      { filePath: "src/api.ts", line: 3, kind: "http_path", value: "/v1/balance/{id}" },
    ]);
    const candidates = discoverCandidates(index, surfaces);
    expect(candidates.some((c) => c.sources.includes("syntactic"))).toBe(true);
  });
});
