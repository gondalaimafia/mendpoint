/**
 * The public-identity projections that keep a tenant id and the `~` namespace out of every
 * customer-facing string (#704 / #713 / #716).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  publicProviderSlug,
  stripTenantScopeForDisplay,
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

  it("is safe on a surface canonical id that begins with the stored slug", () => {
    const canonical = `${tenantId}~acme-payments./v1/charges/{id}/receipt.path_removed`;
    expect(publicProviderSlug(canonical)).toBe("acme-payments./v1/charges/{id}/receipt.path_removed");
    // A shared canonical id (no namespace) is unchanged.
    expect(publicProviderSlug("stripe./v1/charges.path_removed")).toBe("stripe./v1/charges.path_removed");
  });
});

describe("stripTenantScopeForDisplay", () => {
  it("removes the tenant scope from graph node ids (shared provider, #716)", () => {
    const text = "- (Provider) tenant_default:stripe `provider:tenant_default:stripe`";
    expect(stripTenantScopeForDisplay(text, "tenant_default")).toBe(
      "- (Provider) stripe `provider:stripe`",
    );
  });

  it("removes both the tenant scope and the namespace for a private provider (#713)", () => {
    const text = `provider:${tenantId}:${tenantId}~acme-payments and surface:${tenantId}~acme-payments.x`;
    const out = stripTenantScopeForDisplay(text, tenantId);
    expect(out).toBe("provider:acme-payments and surface:acme-payments.x");
    expect(out).not.toContain(tenantId);
    expect(out).not.toContain("~");
  });

  it("is a no-op when the tenant id is absent from the text", () => {
    expect(stripTenantScopeForDisplay("no tenant here", tenantId)).toBe("no tenant here");
  });
});
