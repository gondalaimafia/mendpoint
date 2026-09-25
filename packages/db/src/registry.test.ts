/**
 * Consumer-registry rendering must identify a consumer by its public GitHub full name, never by
 * the on-disk checkout path. In production a checkout lives at
 * `MENDPOINT_REPOS_DIR/<tenantId>/<repoKey>` (apps/api/src/repo-path.ts), so rendering `localPath`
 * would disclose the tenant id and the server's filesystem layout into a customer PR body
 * (#716 / FAILURE_MODES §19). This test uses a PRODUCTION-SHAPED path so the "render the checkout
 * path" mutation is killed: re-adding the path makes the rendered line contain the tenant id.
 */
import { describe, expect, it } from "vitest";
import { registrySummaryMarkdown, type RegistryHit } from "./registry.js";

const tenantId = "a3f5".repeat(16); // a 64-hex tenant id

function hit(localPath: string): RegistryHit {
  return {
    consumerId: "consumer-1",
    consumerName: "Shop",
    githubOwner: "org",
    githubRepo: "shop",
    providerId: "provider-1",
    providerSlug: "acme-payments",
    providerName: "Acme Payments",
    localPath,
  };
}

describe("registrySummaryMarkdown", () => {
  it("renders the public repo full name and never the production checkout path", () => {
    // Production-shaped: <reposDir>/<tenantId>/<repoKey>.
    const localPath = `/srv/mendpoint/repos/${tenantId}/shop-app`;
    const md = registrySummaryMarkdown([hit(localPath)], "acme-payments");
    expect(md).toContain("- **Shop** (`org/shop`)");
    // The tenant id and the on-disk path must not reach the customer body.
    expect(md.includes(tenantId)).toBe(false);
    expect(md.includes(localPath)).toBe(false);
    expect(md.includes("/srv/mendpoint/repos")).toBe(false);
  });

  it("renders the empty-registry line without any path", () => {
    const md = registrySummaryMarkdown([], "acme-payments");
    expect(md).toContain("No consumers monitor **acme-payments**.");
    expect(md.includes(tenantId)).toBe(false);
  });
});
