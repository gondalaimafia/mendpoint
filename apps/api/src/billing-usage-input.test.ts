import { describe, expect, it } from "vitest";
import { parseUsageFinanceEntryType } from "./billing-usage-input.js";

describe("billing usage finance input", () => {
  it("defaults an omitted entry type and accepts only the two domain values", () => {
    expect(parseUsageFinanceEntryType(undefined)).toBe("adjustment");
    expect(parseUsageFinanceEntryType("adjustment")).toBe("adjustment");
    expect(parseUsageFinanceEntryType("credit")).toBe("credit");
  });

  it.each(["refund", null, [], {}, 1, true])(
    "rejects hostile finance entry type input %j before database access",
    (entryType) => {
      expect(() => parseUsageFinanceEntryType(entryType))
        .toThrow("usage_finance_entry_type_invalid");
    },
  );
});
