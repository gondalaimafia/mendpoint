import { describe, expect, it } from "vitest";
import { formatCiCheckComment } from "@mendpoint/github";
import { resolveCiHarnessEvidence } from "./ci-check.js";

describe("CI verifier evidence", () => {
  it("fails closed when verifier evidence is omitted", () => {
    expect(resolveCiHarnessEvidence(undefined)).toEqual([
      {
        name: "Verifier evidence",
        passed: false,
        detail: "No verifier evidence supplied",
      },
    ]);
  });

  it("fails closed when verifier evidence is empty", () => {
    expect(resolveCiHarnessEvidence([])).toEqual([
      {
        name: "Verifier evidence",
        passed: false,
        detail: "No verifier evidence supplied",
      },
    ]);
  });

  it("renders absent verifier evidence as a failed CI check", () => {
    const body = formatCiCheckComment({
      owner: "acme",
      repo: "payments",
      prNumber: 42,
      title: "Migrate payments API",
      harness: resolveCiHarnessEvidence(undefined),
    });

    expect(body).toContain("❌ **Verifier evidence**");
    expect(body).toContain("No verifier evidence supplied");
    expect(body).not.toContain("✅");
  });

  it("preserves supplied verifier evidence", () => {
    const supplied = [
      {
        name: "TypeScript",
        passed: true,
        recall: 0.93,
        threshold: 0.7,
        detail: "Verified at commit abc123",
      },
    ];

    expect(resolveCiHarnessEvidence(supplied)).toEqual(supplied);
  });
});
