/**
 * The public-identity projections that keep a tenant id and the `~` namespace out of every
 * customer-facing string (#704 / #713 / #716). Every customer-rendered section is BUILT from these
 * projections at the source; there is no post-render text stripping.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  publicProviderSlug,
  publicSurfaceId,
  publicGraphToken,
  TENANT_PRIVATE_SLUG_SEPARATOR,
} from "./provider-slug.js";

const tenantId = createHash("sha256").update("issuer|user@example.com").digest("hex");

describe("publicProviderSlug", () => {
  it("returns a shared/bare slug unchanged (byte-identical rendering)", () => {
    expect(publicProviderSlug("stripe")).toBe("stripe");
    expect(publicProviderSlug("aws-sdk")).toBe("aws-sdk");
    expect(publicProviderSlug("Stripe_Legacy")).toBe("Stripe_Legacy");
  });

  it("strips the tenant namespace from a private slug", () => {
    expect(publicProviderSlug(`${tenantId}~acme-payments`)).toBe("acme-payments");
    expect(publicProviderSlug(`${tenantId}~acme-payments`)).not.toContain(tenantId);
    expect(publicProviderSlug(`${tenantId}~acme-payments`)).not.toContain(TENANT_PRIVATE_SLUG_SEPARATOR);
  });

  it("splits on the FIRST separator, never the last (kills a lastIndexOf regression)", () => {
    // A stored slug has exactly one separator, but the contract is first-separator removal so the
    // requested part is preserved intact. lastIndexOf would return only the final segment.
    expect(publicProviderSlug("tenant~one~two")).toBe("one~two");
    expect(publicProviderSlug(`${tenantId}~a~b`)).toBe("a~b");
  });
});

describe("publicSurfaceId", () => {
  it("projects a private surface canonical id by known-prefix removal", () => {
    const stored = `${tenantId}~acme-payments`;
    const canonical = `${stored}./v1/charges/{id}/receipt.path_removed`;
    const out = publicSurfaceId(canonical, stored);
    expect(out).toBe("acme-payments./v1/charges/{id}/receipt.path_removed");
    expect(out).not.toContain(tenantId);
    expect(out).not.toContain(`${TENANT_PRIVATE_SLUG_SEPARATOR}acme-payments`);
  });

  it("preserves a `~` inside an OpenAPI path (kills a lastIndexOf surface projection)", () => {
    // Shared: the display id is byte-identical, and the `~me` path segment survives in full.
    expect(publicSurfaceId("acme-payments./v1/users/~me.path_removed", "acme-payments")).toBe(
      "acme-payments./v1/users/~me.path_removed",
    );
    // Private: only the stored-slug prefix collapses; the `~me` in the path is untouched.
    const stored = `${tenantId}~acme-payments`;
    expect(publicSurfaceId(`${stored}./v1/users/~me.path_removed`, stored)).toBe(
      "acme-payments./v1/users/~me.path_removed",
    );
  });

  it("returns a canonical id that does not begin with the stored slug unchanged", () => {
    expect(publicSurfaceId("stripe./v1/charges.path_removed", "stripe")).toBe(
      "stripe./v1/charges.path_removed",
    );
  });
});

describe("publicGraphToken", () => {
  it("drops the tenant scope from a shared provider's node ids (#716)", () => {
    expect(publicGraphToken("provider:tenant_default:stripe", "tenant_default", "stripe")).toBe(
      "provider:stripe",
    );
    expect(
      publicGraphToken("endpoint:tenant_default:stripe:POST:/v1/charges", "tenant_default", "stripe"),
    ).toBe("endpoint:stripe:POST:/v1/charges");
  });

  it("drops the scope and collapses the namespace for a private provider (#713)", () => {
    const stored = `${tenantId}~acme-payments`;
    const providerId = `provider:${tenantId}:${stored}`;
    const surfaceId = `surface:${stored}./v1/users/~me.path_removed`;
    const providerOut = publicGraphToken(providerId, tenantId, stored);
    const surfaceOut = publicGraphToken(surfaceId, tenantId, stored);
    expect(providerOut).toBe("provider:acme-payments");
    // The stored-slug prefix collapses but a `~` inside the API path is preserved.
    expect(surfaceOut).toBe("surface:acme-payments./v1/users/~me.path_removed");
    for (const out of [providerOut, surfaceOut]) {
      expect(out).not.toContain(tenantId);
      expect(out).not.toContain(`${TENANT_PRIVATE_SLUG_SEPARATOR}acme-payments`);
    }
  });

  it("leaves the provider label byte-identical apart from the tenant scope", () => {
    // Provider node label is `<tenantId>:<storedSlug>` in the graph.
    expect(publicGraphToken("tenant_default:stripe", "tenant_default", "stripe")).toBe("stripe");
  });
});
