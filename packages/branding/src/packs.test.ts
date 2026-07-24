import { describe, expect, it } from "vitest";
import {
  applyBrandPack,
  ensureWardenFooter,
  getBrandPackForProvider,
  listBrandPacks,
  WARDEN_PR_FOOTER,
} from "./packs.js";

describe("brand packs", () => {
  it("lists first-party packs", () => {
    const packs = listBrandPacks();
    expect(packs.length).toBeGreaterThanOrEqual(3);
    expect(packs.some((p) => p.providerSlug === "stripe")).toBe(true);
  });

  it("applies title prefix and footer", () => {
    const pack = getBrandPackForProvider("acme-payments")!;
    const out = applyBrandPack(pack, {
      title: "Rename amount_cents",
      body: "## Migration\n\nDo the thing.",
    });
    expect(out.title).toContain("[Acme Payments Agent]");
    expect(out.body).toContain("Acme Payments Agent");
    expect(out.labels).toContain("mendpoint");
  });

  it("includes Warden or Mendpoint in applied footer", () => {
    const pack = getBrandPackForProvider("acme-payments")!;
    const out = applyBrandPack(pack, {
      title: "Rename amount_cents",
      body: "## Migration\n\nDo the thing.",
    });
    expect(out.body).toMatch(/Warden|Mendpoint/);
    expect(out.body).toMatch(/Warden/);
  });

  it("exports neutral WARDEN_PR_FOOTER", () => {
    expect(WARDEN_PR_FOOTER).toContain("Warden");
    expect(WARDEN_PR_FOOTER).toContain("Mendpoint");
    expect(WARDEN_PR_FOOTER).toMatch(/never auto-merged/i);
  });

  it("ensureWardenFooter adds full footer when missing", () => {
    const out = ensureWardenFooter("## Migration\n\nPlain body.");
    expect(out).toContain("Warden");
    expect(out).toContain("Mendpoint");
  });

  it("ensureWardenFooter is idempotent when Warden present", () => {
    const once = ensureWardenFooter("## Body\n\n" + WARDEN_PR_FOOTER);
    const twice = ensureWardenFooter(once);
    expect(twice).toBe(once);
  });
});
