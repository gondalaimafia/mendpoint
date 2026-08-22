import { describe, expect, it } from "vitest";
import {
  findAttestationLiterals,
  findExternalFallbacks,
  findMetricZeroDenominator,
  scanSource,
  scanThirdState,
  type ThirdStateShape,
} from "./third-state-check.js";

const shapesOf = (source: string, path = "fixture.ts"): ThirdStateShape[] =>
  scanSource(path, source).map((violation) => violation.shape);

describe("third-state check — Shape 1: external value defaulted to a positive claim", () => {
  it("flags a status enum backfilled onto a parsed JSON field", () => {
    // Historical defect: `?? \"EXTRACTED\"` promoted an unlabelled indirect call
    // to direct/high confidence (docs/reviews/2026-08-19-claude-review-response.md).
    const source = `
      export function classify(raw: string): string {
        return JSON.parse(raw).confidence ?? "EXTRACTED";
      }
    `;
    const violations = findExternalFallbacks(source, "fixture.ts");
    expect(violations).toHaveLength(1);
    expect(violations[0]!.shape).toBe("external-fallback");
    expect(violations[0]!.detail).toContain("EXTRACTED");
  });

  it("flags a missing subprocess exit code read as success", () => {
    // Historical defect: `exit_code ?? 0` under a security gate — a missing exit
    // code read as success (fly-sandbox.ts).
    const source = `
      import { spawnSync } from "node:child_process";
      export function gate(cmd: string): boolean {
        const result = spawnSync(cmd);
        return (result.status ?? 0) === 0;
      }
    `;
    expect(shapesOf(source)).toEqual(["external-fallback"]);
  });

  it("flags the inline subprocess form too", () => {
    const source = `
      import { execFileSync } from "node:child_process";
      export const code = execFileSync("probe").status ?? 0;
    `;
    expect(shapesOf(source)).toEqual(["external-fallback"]);
  });

  it("ignores an ordinary config default from a parsed request body", () => {
    // A missing optional parameter legitimately falls back to a default; this is
    // not a manufactured success and must not be flagged.
    const source = `
      export async function handler(request: Request): Promise<number> {
        const body = await request.json();
        return body.maxFiles ?? 100;
      }
    `;
    expect(findExternalFallbacks(source, "fixture.ts")).toEqual([]);
  });

  it("ignores a fallback that does not come from an external source", () => {
    const source = `
      export function label(input: { confidence?: string }): string {
        return input.confidence ?? "EXTRACTED";
      }
    `;
    expect(findExternalFallbacks(source, "fixture.ts")).toEqual([]);
  });
});

describe("third-state check — Shape 2: metric scores absence as perfection", () => {
  it("flags a precision metric returning 1 on a zero denominator", () => {
    // Historical defect: `d === 0 ? 1` scored an extractor that produced nothing
    // as perfect precision (docs/reviews/2026-08-19-claude-review-response.md).
    const source = `
      export function precision(truePositives: number, predicted: number): number {
        return predicted === 0 ? 1 : truePositives / predicted;
      }
    `;
    const violations = findMetricZeroDenominator(source, "fixture.ts");
    expect(violations).toHaveLength(1);
    expect(violations[0]!.shape).toBe("metric-zero-denominator");
  });

  it("flags an early-return perfect score guard", () => {
    const source = `
      export function recall(hits: number, total: number): number {
        if (total === 0) return 1;
        return hits / total;
      }
    `;
    expect(shapesOf(source)).toEqual(["metric-zero-denominator"]);
  });

  it("does not flag returning 0 on an empty denominator", () => {
    // Returning 0 does not manufacture success; the current tree relies on this.
    const source = `
      export function rate(accepted: number, total: number): number {
        return total === 0 ? 0 : accepted / total;
      }
    `;
    expect(findMetricZeroDenominator(source, "fixture.ts")).toEqual([]);
  });

  it("does not flag a perfect-score guard outside a metric function", () => {
    const source = `
      export function scale(count: number): number {
        return count === 0 ? 1 : count * 2;
      }
    `;
    expect(findMetricZeroDenominator(source, "fixture.ts")).toEqual([]);
  });
});

describe("third-state check — Shape 3: attestation record cannot represent a negative", () => {
  it("flags a receipt whose outcome fields are typed as unconditional literals", () => {
    // Historical defect: `blocked`/`passed` typed as the literal `true`, so a
    // negative egress receipt was unrepresentable (#231/#235/#236).
    const source = `
      export type EgressReceipt = {
        blocked: true;
        passed: true;
        checkedAt: string;
      };
    `;
    const violations = findAttestationLiterals(source, "fixture.ts");
    expect(violations).toHaveLength(1);
    expect(violations[0]!.shape).toBe("attestation-literal");
  });

  it("leaves a proper discriminated union alone", () => {
    const source = `
      export type Outcome =
        | { passed: true; value: string }
        | { passed: false; error: string };
    `;
    expect(findAttestationLiterals(source, "fixture.ts")).toEqual([]);
  });

  it("does not flag a single monovalued outcome field", () => {
    const source = `
      export type Review = { verification: { passed: true; summary: string } };
    `;
    expect(findAttestationLiterals(source, "fixture.ts")).toEqual([]);
  });

  it("does not flag policy-constant boolean literals", () => {
    const source = `
      export type Policy = { autoMerge: false; requiresHumanApproval: true };
    `;
    expect(findAttestationLiterals(source, "fixture.ts")).toEqual([]);
  });
});

describe("third-state check — inline exemption", () => {
  const offending = `        return JSON.parse(raw).confidence ?? "EXTRACTED";`;

  it("suppresses a finding annotated on the same line", () => {
    const source = `
      export function classify(raw: string): string {
${offending} // third-state-check-allow: fixture only
      }
    `;
    expect(scanSource("fixture.ts", source)).toEqual([]);
  });

  it("suppresses a finding annotated on the line above", () => {
    const source = `
      export function classify(raw: string): string {
        // third-state-check-allow: fixture only
${offending}
      }
    `;
    expect(scanSource("fixture.ts", source)).toEqual([]);
  });

  it("does not suppress when the directive carries no reason", () => {
    const source = `
      export function classify(raw: string): string {
${offending} // third-state-check-allow:
      }
    `;
    expect(scanSource("fixture.ts", source)).toHaveLength(1);
  });
});

describe("third-state check — current tree", () => {
  it("passes cleanly on the repository with no suppression list", () => {
    expect(scanThirdState()).toEqual([]);
  }, 120_000);
});
