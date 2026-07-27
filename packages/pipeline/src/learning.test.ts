import { describe, expect, it } from "vitest";
import {
  extractPatternsFromPrBody,
  resolveExperimentArm,
  resolvePlanIdFromPr,
} from "./index.js";

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

  it("resolves experiment and plan tags from PR body", () => {
    expect(
      resolveExperimentArm("fix [experiment:treatment] [plan:plan-abc]", undefined),
    ).toBe("treatment");
    expect(resolveExperimentArm("plain", "control")).toBe("control");
    expect(resolveExperimentArm("x [experiment:b]", undefined)).toBe("treatment");
    expect(resolvePlanIdFromPr("body [plan:p99]", undefined)).toBe("p99");
    expect(resolvePlanIdFromPr("body", "explicit")).toBe("explicit");
  });
});
