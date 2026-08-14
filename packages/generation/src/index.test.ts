import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diffOpenApi } from "@mendpoint/change-intel";
import { analyzeRepo } from "@mendpoint/code-impact";
import { generateMigration } from "./index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const providerDir = join(root, "fixtures/providers/acme-payments");
const consumerDir = join(root, "fixtures/consumers/shop-app");

describe("generation", () => {
  it("renames amount_cents to amount in patch", () => {
    const v1 = JSON.parse(readFileSync(join(providerDir, "openapi-v1.json"), "utf8"));
    const v2 = JSON.parse(readFileSync(join(providerDir, "openapi-v2.json"), "utf8"));
    const change = diffOpenApi(v1, v2);
    const findings = analyzeRepo(consumerDir, change);
    const draft = generateMigration({
      providerName: "Acme Payments",
      providerSlug: "acme-payments",
      change,
      findings,
      repoRoot: consumerDir,
    });

    expect(draft.patch).toContain("amount");
    expect(draft.fileEdits.some((e) => e.updated.includes("amount") && !e.updated.includes("amount_cents")) ||
      draft.fileEdits.some((e) => e.updated.includes("amount"))).toBe(true);
    const payments = draft.fileEdits.find((e) => e.path.includes("payments.ts"));
    expect(payments?.updated).toContain("amount:");
    expect(payments?.updated).not.toContain("amount_cents");
    expect(draft.body).toContain("never commits to protected branches");
    expect(draft.body).toMatch(/Fettler/);
    expect(draft.body).toMatch(/Mendpoint/);
    expect(draft.risk).toBe("breaking");
  });
});
