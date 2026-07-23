import { describe, expect, it } from "vitest";
import { applyBrandPack, getBrandPackForProvider, listBrandPacks } from "./packs.js";

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
});
