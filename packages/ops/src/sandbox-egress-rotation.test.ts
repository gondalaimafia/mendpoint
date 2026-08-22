import { describe, expect, it } from "vitest";
import {
  parseFlyAppListing,
  resolveSandboxEgressRotationTargets,
  type FlyAppListing,
} from "./sandbox-egress-rotation.js";

const CONFIG = {
  verifyingApp: "mendpoint-sandbox-verifier",
  includePrefixes: ["mendpoint-customer-"],
  excludeApps: ["mendpoint-sandbox"],
} as const;

describe("resolveSandboxEgressRotationTargets", () => {
  it("covers every consuming app matched by configuration, not just the verifying app", () => {
    const apps: FlyAppListing[] = [
      { name: "mendpoint-customer-acme" },
      { name: "mendpoint-customer-globex" },
      { name: "mendpoint-sandbox" },
      { name: "mendpoint-marketing-site" },
    ];
    const targets = resolveSandboxEgressRotationTargets(apps, CONFIG);
    expect(targets).toEqual([
      "mendpoint-customer-acme",
      "mendpoint-customer-globex",
      "mendpoint-sandbox-verifier",
    ]);
  });

  it("covers a newly provisioned app without editing any list — the drift guard", () => {
    const before: FlyAppListing[] = [{ name: "mendpoint-customer-acme" }];
    const after: FlyAppListing[] = [
      ...before,
      { name: "mendpoint-customer-initech" }, // provisioned later, same config
    ];
    // Same CONFIG object, no code change: the new app is picked up from the live
    // inventory. This is the property whose loss reintroduced the bug.
    const targetsBefore = resolveSandboxEgressRotationTargets(before, CONFIG);
    const targetsAfter = resolveSandboxEgressRotationTargets(after, CONFIG);
    expect(targetsBefore).not.toContain("mendpoint-customer-initech");
    expect(targetsAfter).toContain("mendpoint-customer-initech");
  });

  it("always includes the verifying app even when the live listing has not caught up", () => {
    const targets = resolveSandboxEgressRotationTargets([], CONFIG);
    expect(targets).toEqual(["mendpoint-sandbox-verifier"]);
  });

  it("never rotates the receipt onto the sandbox image app (the isolation boundary)", () => {
    const apps: FlyAppListing[] = [
      { name: "mendpoint-sandbox" },
      { name: "mendpoint-customer-acme" },
    ];
    // Even with a broad prefix that would match it, the exclusion wins.
    const targets = resolveSandboxEgressRotationTargets(apps, {
      verifyingApp: "mendpoint-sandbox-verifier",
      includePrefixes: ["mendpoint-"],
      excludeApps: ["mendpoint-sandbox"],
    });
    expect(targets).not.toContain("mendpoint-sandbox");
    expect(targets).toContain("mendpoint-customer-acme");
  });

  it("filters by org slug in either the string or nested object shape", () => {
    const apps: FlyAppListing[] = [
      { name: "mendpoint-customer-acme", organization: { slug: "mendpoint" } },
      { name: "mendpoint-customer-other", org: "someone-else" },
      { name: "mendpoint-customer-nested", organization: { slug: "someone-else" } },
    ];
    const targets = resolveSandboxEgressRotationTargets(apps, {
      verifyingApp: "mendpoint-sandbox-verifier",
      includePrefixes: ["mendpoint-customer-"],
      org: "mendpoint",
    });
    expect(targets).toContain("mendpoint-customer-acme");
    expect(targets).not.toContain("mendpoint-customer-other");
    expect(targets).not.toContain("mendpoint-customer-nested");
  });

  it("refuses an empty or malformed verifying app", () => {
    expect(() => resolveSandboxEgressRotationTargets([], { verifyingApp: "" })).toThrow(
      "sandbox_egress_rotation_verifying_app_invalid",
    );
    expect(() =>
      resolveSandboxEgressRotationTargets([], { verifyingApp: "Not A Valid App" }),
    ).toThrow("sandbox_egress_rotation_verifying_app_invalid");
  });

  it("refuses a configuration that excludes its own verifying app", () => {
    expect(() =>
      resolveSandboxEgressRotationTargets([], {
        verifyingApp: "mendpoint-sandbox-verifier",
        excludeApps: ["mendpoint-sandbox-verifier"],
      }),
    ).toThrow("sandbox_egress_rotation_verifying_app_excluded");
  });

  it("skips inventory entries with malformed or missing names rather than rotating to them", () => {
    const apps: FlyAppListing[] = [
      { name: "mendpoint-customer-acme" },
      { name: "UPPER_CASE_INVALID" },
      { name: 42 as unknown as string },
      {},
    ];
    const targets = resolveSandboxEgressRotationTargets(apps, CONFIG);
    expect(targets).toEqual(["mendpoint-customer-acme", "mendpoint-sandbox-verifier"]);
  });
});

describe("parseFlyAppListing", () => {
  it("parses a JSON array of app listings", () => {
    expect(parseFlyAppListing('[{"name":"a"},{"name":"b"}]')).toEqual([
      { name: "a" },
      { name: "b" },
    ]);
  });

  it("treats an empty string as no apps", () => {
    expect(parseFlyAppListing("   ")).toEqual([]);
  });

  it("fails closed on non-array or malformed JSON", () => {
    expect(() => parseFlyAppListing("{}")).toThrow("sandbox_egress_rotation_inventory_invalid");
    expect(() => parseFlyAppListing("not json")).toThrow(
      "sandbox_egress_rotation_inventory_invalid",
    );
  });
});
