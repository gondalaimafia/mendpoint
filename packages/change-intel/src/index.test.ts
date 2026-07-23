import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyRisk, diffOpenApi, normalizeChange } from "./index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureDir = join(root, "fixtures/providers/acme-payments");

describe("change-intel", () => {
  it("detects breaking renames, removals, and new paths", () => {
    const v1 = JSON.parse(readFileSync(join(fixtureDir, "openapi-v1.json"), "utf8"));
    const v2 = JSON.parse(readFileSync(join(fixtureDir, "openapi-v2.json"), "utf8"));
    const diff = diffOpenApi(v1, v2);

    expect(diff.risk).toBe("breaking");
    expect(diff.entries.some((e) => e.op === "request_field_renamed")).toBe(true);
    expect(
      diff.entries.some(
        (e) =>
          e.op === "request_field_renamed" &&
          e.fromField === "amount_cents" &&
          e.toField === "amount",
      ),
    ).toBe(true);
    expect(
      diff.entries.some(
        (e) => e.op === "path_removed" && e.path === "/v1/charges/{id}/receipt",
      ),
    ).toBe(true);
    expect(
      diff.entries.some((e) => e.op === "path_added" && e.path === "/v1/balance"),
    ).toBe(true);
    expect(diff.summary.toLowerCase()).toContain("amount");
  });

  it("classifies pure additions as new_capability", () => {
    const entries = [
      {
        op: "path_added" as const,
        path: "/v1/balance",
        breaking: false,
      },
    ];
    expect(classifyRisk(entries)).toBe("new_capability");
  });

  it("normalizes to impactable surfaces with search tokens", () => {
    const v1 = JSON.parse(readFileSync(join(fixtureDir, "openapi-v1.json"), "utf8"));
    const v2 = JSON.parse(readFileSync(join(fixtureDir, "openapi-v2.json"), "utf8"));
    const { surfaces } = normalizeChange(v1, v2, { providerSlug: "acme-payments" });
    expect(surfaces.length).toBeGreaterThan(0);
    expect(surfaces.some((s) => s.op === "request_field_renamed")).toBe(true);
    expect(
      surfaces.some(
        (s) =>
          s.searchTokens.includes("amount_cents") || s.fromField === "amount_cents",
      ),
    ).toBe(true);
    expect(surfaces.every((s) => s.canonicalId && s.migrationStrategy)).toBe(true);
  });
});

