export type UsageFinanceEntryType = "adjustment" | "credit";

export function parseUsageFinanceEntryType(value: unknown): UsageFinanceEntryType {
  if (value === undefined) return "adjustment";
  if (value === "adjustment" || value === "credit") return value;
  throw new Error("usage_finance_entry_type_invalid");
}
