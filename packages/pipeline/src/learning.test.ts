import { describe, expect, it } from "vitest";
import { extractPatternsFromPrBody } from "./index.js";

describe("feedback learning", () => {
  it("extracts symbols from PR evidence markdown", () => {
    const body = `
### Evidence
- \`src/a.ts:1\` **amount_cents** (high) — \`amount_cents: 10\`
- \`src/b.ts:2\` **/v1/charges** (high)
`;
    const patterns = extractPatternsFromPrBody(body);
    expect(patterns.some((p) => p.includes("amount_cents"))).toBe(true);
    expect(patterns.some((p) => p.includes("/v1/charges") || p.includes("charges"))).toBe(true);
  });
});
