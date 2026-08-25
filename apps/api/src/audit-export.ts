const DEFAULT_AUDIT_EXPORT_LIMIT = 2_000;
const MAXIMUM_AUDIT_EXPORT_LIMIT = 20_000;

export function parseAuditExportLimit(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_AUDIT_EXPORT_LIMIT;
  if (!/^[1-9]\d*$/.test(value)) throw new Error("audit_export_limit_invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAXIMUM_AUDIT_EXPORT_LIMIT) {
    throw new Error("audit_export_limit_invalid");
  }
  return parsed;
}
