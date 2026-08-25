import { describe, expect, it } from "vitest";
import { parseAuditExportLimit } from "./audit-export.js";

describe("audit export hardening", () => {
  it("accepts only positive bounded integer limits", () => {
    expect(parseAuditExportLimit(undefined)).toBe(2_000);
    expect(parseAuditExportLimit("")).toBe(2_000);
    expect(parseAuditExportLimit("1")).toBe(1);
    expect(parseAuditExportLimit("20000")).toBe(20_000);
    for (const value of ["0", "-1", "1.5", "20001", "NaN", "Infinity", "1e3"]) {
      expect(() => parseAuditExportLimit(value), value).toThrow("audit_export_limit_invalid");
    }
  });
});
