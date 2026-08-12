import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCapabilityOpportunity,
  detectNewCapabilities,
  diffOpenApi,
  prioritizeCapabilityOpportunities,
  type ConsumerCapabilityAdoption,
  type NewCapability,
} from "./index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureDir = join(root, "fixtures/providers/acme-payments");

function loadDiff() {
  const v1 = JSON.parse(readFileSync(join(fixtureDir, "openapi-v1.json"), "utf8"));
  const v2 = JSON.parse(readFileSync(join(fixtureDir, "openapi-v2.json"), "utf8"));
  return diffOpenApi(v1, v2);
}

function adoption(
  consumerId: string,
  consumerName: string,
  adopted: boolean,
): ConsumerCapabilityAdoption {
  return {
    consumerId,
    consumerName,
    adopted,
    evidence: adopted ? [`${consumerName}/src/x.ts:1 usage`] : [],
    basis: "static_code_presence",
  };
}

describe("detectNewCapabilities", () => {
  it("extracts additive capabilities even when the diff is breaking overall", () => {
    const diff = loadDiff();
    expect(diff.risk).toBe("breaking");
    const caps = detectNewCapabilities(diff, { provider: "acme-payments" });
    // /v1/balance was added; the removed receipt path must not appear.
    expect(caps.some((c) => c.path === "/v1/balance" && c.op === "path_added")).toBe(true);
    expect(caps.every((c) => c.op !== "path_removed")).toBe(true);
    const balance = caps.find((c) => c.path === "/v1/balance")!;
    expect(balance.provider).toBe("acme-payments");
    expect(balance.searchTokens).toContain("/v1/balance");
    expect(balance.endpoint.toLowerCase()).toContain("/v1/balance");
  });

  it("returns nothing for a diff with no additive surfaces", () => {
    const caps = detectNewCapabilities({
      entries: [{ op: "path_removed", path: "/v1/old", breaking: true }],
      risk: "breaking",
      summary: "removed",
    });
    expect(caps).toEqual([]);
  });
});

const capability: NewCapability = {
  capabilityId: "acme.POST./v1/payment_links.path_added",
  provider: "acme-payments",
  op: "path_added",
  path: "/v1/payment_links",
  method: "post",
  endpoint: "POST /v1/payment_links",
  searchTokens: ["/v1/payment_links", "payment_links"],
  explanation: "Path /v1/payment_links added",
};

describe("buildCapabilityOpportunity", () => {
  it("flags a capability with no adopting consumers as a prioritized opportunity", () => {
    const opp = buildCapabilityOpportunity(capability, [
      adoption("c1", "shop-app", false),
      adoption("c2", "billing-app", false),
    ]);
    expect(opp.isOpportunity).toBe(true);
    expect(opp.adoptingCount).toBe(0);
    expect(opp.nonAdoptingCount).toBe(2);
    expect(opp.adoptionRate).toBe(0);
    expect(opp.priority).toBe(2);
    expect(opp.suggestedAction).toContain("adopt-PR");
    expect(opp.suggestedAction).toContain("shop-app");
    expect(opp.valueBasis).toContain("static code presence");
  });

  it("does not flag a fully-adopted capability", () => {
    const opp = buildCapabilityOpportunity(capability, [
      adoption("c1", "shop-app", true),
      adoption("c2", "billing-app", true),
    ]);
    expect(opp.isOpportunity).toBe(false);
    expect(opp.adoptionRate).toBe(1);
    expect(opp.nonAdoptingCount).toBe(0);
  });

  it("does not flag a capability with no linked consumers", () => {
    const opp = buildCapabilityOpportunity(capability, []);
    expect(opp.isOpportunity).toBe(false);
    expect(opp.linkedConsumerCount).toBe(0);
  });

  it("honors the maxAdoptionRate threshold", () => {
    const adoptions = [
      adoption("c1", "a", true),
      adoption("c2", "b", true),
      adoption("c3", "c", false),
    ];
    // 2/3 adopted (0.667) is above the default 0.5 threshold -> not an opportunity.
    expect(buildCapabilityOpportunity(capability, adoptions).isOpportunity).toBe(false);
    // Relaxing the threshold to 1.0 makes any non-adoption an opportunity.
    expect(
      buildCapabilityOpportunity(capability, adoptions, { maxAdoptionRate: 1 }).isOpportunity,
    ).toBe(true);
  });
});

describe("prioritizeCapabilityOpportunities", () => {
  it("keeps only opportunities and orders them by adoption gap", () => {
    const wide = buildCapabilityOpportunity(
      { ...capability, capabilityId: "cap-wide" },
      [adoption("c1", "a", false), adoption("c2", "b", false), adoption("c3", "c", false)],
    );
    const narrow = buildCapabilityOpportunity(
      { ...capability, capabilityId: "cap-narrow" },
      [adoption("c1", "a", true), adoption("c2", "b", false)],
    );
    const adopted = buildCapabilityOpportunity(
      { ...capability, capabilityId: "cap-adopted" },
      [adoption("c1", "a", true)],
    );
    const ordered = prioritizeCapabilityOpportunities([narrow, adopted, wide]);
    expect(ordered.map((o) => o.capability.capabilityId)).toEqual(["cap-wide", "cap-narrow"]);
    expect(ordered.some((o) => o.capability.capabilityId === "cap-adopted")).toBe(false);
  });
});
