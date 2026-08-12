import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { diffOpenApi, detectNewCapabilities } from "@mendpoint/change-intel";
import { buildIndex } from "@mendpoint/codebase-index";
import {
  analyzeCapabilityAdoption,
  assessConsumerAdoption,
  consumerUsesCapability,
} from "./index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const providerDir = join(root, "fixtures/providers/acme-payments");
const shopApp = join(root, "fixtures/consumers/shop-app");

function acmeDiff() {
  const v1 = JSON.parse(readFileSync(join(providerDir, "openapi-v1.json"), "utf8"));
  const v2 = JSON.parse(readFileSync(join(providerDir, "openapi-v2.json"), "utf8"));
  return diffOpenApi(v1, v2);
}

const tmpDirs: string[] = [];
function makeAdoptedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cap-adopt-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "balance.ts"),
    [
      "export async function fetchBalance(client: any) {",
      '  return client.get("/v1/balance");',
      "}",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "adopter" }), "utf8");
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("consumerUsesCapability", () => {
  const balance = detectNewCapabilities(acmeDiff(), { provider: "acme-payments" }).find(
    (c) => c.path === "/v1/balance",
  )!;

  it("finds no adoption in a consumer that does not reference the endpoint", () => {
    const index = buildIndex(shopApp);
    const { adopted, evidence } = consumerUsesCapability(index, balance);
    expect(adopted).toBe(false);
    expect(evidence).toEqual([]);
  });

  it("detects static presence when the consumer references the endpoint path", () => {
    const index = buildIndex(makeAdoptedRepo());
    const result = consumerUsesCapability(index, balance);
    expect(result.adopted).toBe(true);
    expect(result.evidence.join(" ")).toContain("/v1/balance");
  });

  it("labels the adoption basis as static code presence", () => {
    const index = buildIndex(shopApp);
    const record = assessConsumerAdoption(index, { consumerId: "c1", consumerName: "shop-app" }, balance);
    expect(record.basis).toBe("static_code_presence");
    expect(record.adopted).toBe(false);
  });
});

describe("analyzeCapabilityAdoption", () => {
  it("produces a prioritized alert when no linked consumer has adopted", () => {
    const opportunities = analyzeCapabilityAdoption(acmeDiff(), [
      { consumerId: "c1", consumerName: "shop-app", repoRoot: shopApp },
    ], { provider: "acme-payments" });
    const balance = opportunities.find((o) => o.capability.path === "/v1/balance");
    expect(balance).toBeDefined();
    expect(balance!.isOpportunity).toBe(true);
    expect(balance!.nonAdoptingCount).toBe(1);
    expect(balance!.adoptingCount).toBe(0);
  });

  it("emits no opportunity when every linked consumer already adopted", () => {
    const opportunities = analyzeCapabilityAdoption(acmeDiff(), [
      { consumerId: "c1", consumerName: "adopter", repoRoot: makeAdoptedRepo() },
    ], { provider: "acme-payments" });
    expect(opportunities.some((o) => o.capability.path === "/v1/balance")).toBe(false);
  });

  it("returns nothing when the change introduces no new capabilities", () => {
    const opportunities = analyzeCapabilityAdoption(
      { entries: [{ op: "path_removed", path: "/v1/old", breaking: true }], risk: "breaking", summary: "x" },
      [{ consumerId: "c1", consumerName: "shop-app", repoRoot: shopApp }],
      { provider: "acme-payments" },
    );
    expect(opportunities).toEqual([]);
  });
});
